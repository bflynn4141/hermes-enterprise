// `fetch_url`: the one tool that reaches outside this system, and every rule
// that makes that survivable.
//
// The plan (revision 2, prompt-injection defenses; revision 4, "Two defenses
// change because of Workers") fixes the list, and each line here is one of
// them:
//
//   * GET and HEAD only. A tool that could POST is a tool that can act.
//   * The app's own hostnames, Neon, R2 and the provider APIs are denied
//     outright. The first is server-side request forgery against ourselves —
//     our own routes trust a same-origin caller far more than they should have
//     to — and the last three are where the keys and the tenant data live.
//   * An Admin-managed domain allowlist, read from
//     `workspace_settings.flags.fetch_url_allowlist`. Empty means the tool
//     refuses every host, which is the right default: a workspace that has not
//     decided where its agent may read is a workspace whose agent reads
//     nowhere.
//   * DNS pre-resolution over DNS-over-HTTPS, refusing private, loopback,
//     link-local, carrier-grade-NAT and multicast answers, **re-resolved on
//     every redirect hop**, at most 3 hops.
//   * 2 MB and 10 s.
//   * Every URL fetched and every hop is in the result, which is what makes it
//     into `run_turns` and the trace.
//
// The honest limit, recorded here because it is a residual risk and not a bug:
// a Worker cannot pin a DNS answer to a socket. We resolve, we check what we
// got, and then `fetch()` resolves again on its own. A record that flips
// between our check and the runtime's lookup still wins that race. Re-resolving
// each hop narrows the window and the fixture in
// `test/unit/fetch-url.test.ts` documents it; the decision gate, as always, is
// the line that actually holds.
import { checkAddress, isIpLiteral } from './ip.js';
import { htmlTitle, htmlToText, textKindOf } from './html-text.js';

/** Plan section 4, Tools: "2 MB, 10 s" for `fetch_url`, at most 3 redirects. */
export const FETCH_URL_MAX_BYTES = 2 * 1024 * 1024;
export const FETCH_URL_TIMEOUT_MS = 10_000;
export const FETCH_URL_MAX_REDIRECTS = 3;
/** The reduced text handed to the model, before the envelope's own 8 KB cap. */
export const FETCH_URL_TEXT_MAX_CHARS = 8 * 1024;
export const FETCH_URL_TRUNCATION_MARKER = '\n[truncated: the page exceeded 8 KB of text]';

export const FETCH_URL_METHODS = ['GET', 'HEAD'] as const;
export type FetchUrlMethod = (typeof FETCH_URL_METHODS)[number];

/**
 * Hosts no workspace may allowlist its way into.
 *
 * Suffix-matched, so `neon.tech` covers every project host. The app's own
 * hostnames are added per environment by `denyHostsFor`, because they are
 * configuration rather than a constant.
 */
export const ALWAYS_DENIED_HOSTS: readonly string[] = [
  // Our own data plane.
  'neon.tech',
  'neon.build',
  'r2.cloudflarestorage.com',
  'r2.dev',
  // The provider APIs: a key lives in the request, never in a tool.
  'api.anthropic.com',
  'api.openai.com',
  'api.deepseek.com',
  'portal.nousresearch.com',
  'gateway.ai.cloudflare.com',
  // Cloud metadata, by name as well as by address.
  'metadata.google.internal',
  'metadata.goog',
  'instance-data',
  // The loopback names, for completeness; the address check catches the rest.
  'localhost',
  'localhost.localdomain',
];

export type FetchRefusal =
  | 'bad_url'
  | 'method_not_allowed'
  | 'scheme_not_allowed'
  | 'port_not_allowed'
  | 'credentials_in_url'
  | 'denied_host'
  | 'not_allowlisted'
  | 'dns_failed'
  | 'private_address'
  | 'too_many_redirects'
  | 'unsupported_content_type'
  | 'http_error'
  | 'timeout'
  | 'fetch_failed';

/** One hop, recorded whether it succeeded or not. */
export interface FetchHop {
  readonly url: string;
  readonly host: string;
  readonly addresses: readonly string[];
  readonly status: number | null;
}

export interface FetchUrlOk {
  readonly ok: true;
  readonly url: string;
  readonly final_url: string;
  readonly status: number;
  readonly content_type: string | null;
  readonly title: string | null;
  readonly text: string;
  readonly truncated: boolean;
  readonly bytes: number;
  readonly hops: readonly FetchHop[];
  readonly retrieved_at: string;
}

export interface FetchUrlRefused {
  readonly ok: false;
  readonly reason: FetchRefusal;
  readonly error: string;
  readonly url: string;
  readonly hops: readonly FetchHop[];
}

export type FetchUrlResult = FetchUrlOk | FetchUrlRefused;

/** Resolve a hostname to addresses. Injected, so tests need no network. */
export type Resolver = (hostname: string, signal: AbortSignal) => Promise<string[]>;

export interface FetchUrlOptions {
  /** Hostnames an Admin allowed, as bare domains. Empty refuses everything. */
  readonly allowlist: readonly string[];
  /** Added to `ALWAYS_DENIED_HOSTS`; the app's own hostnames go here. */
  readonly denyHosts?: readonly string[];
  readonly fetchImpl?: typeof fetch;
  readonly resolve?: Resolver;
  readonly now?: () => Date;
  readonly maxBytes?: number;
  readonly timeoutMs?: number;
  readonly maxRedirects?: number;
}

const refuse = (reason: FetchRefusal, error: string, url: string, hops: readonly FetchHop[]): FetchUrlRefused => ({
  ok: false,
  reason,
  error,
  url,
  hops,
});

/** Suffix match: `docs.example.com` matches an entry of `example.com`. */
export function hostMatches(hostname: string, entries: readonly string[]): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');
  return entries.some((raw) => {
    const entry = raw.trim().toLowerCase().replace(/^\*\./, '').replace(/\.$/, '');
    if (!entry) return false;
    return host === entry || host.endsWith(`.${entry}`);
  });
}

/**
 * The hostnames this deployment answers on.
 *
 * `ALLOWED_ORIGINS` is already the list of origins the product trusts, which
 * makes it exactly the list the agent must not be able to call back into.
 */
export function denyHostsFor(env: { ALLOWED_ORIGINS?: string; R2_ACCOUNT_ID?: string }): string[] {
  const hosts: string[] = [];
  for (const origin of (env.ALLOWED_ORIGINS ?? '').split(',')) {
    const trimmed = origin.trim();
    if (!trimmed) continue;
    try {
      hosts.push(new URL(trimmed).hostname);
    } catch {
      hosts.push(trimmed.replace(/^https?:\/\//, '').split('/')[0] ?? trimmed);
    }
  }
  if (env.R2_ACCOUNT_ID) hosts.push(`${env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`);
  return hosts;
}

/**
 * The default resolver: Cloudflare's DNS-over-HTTPS JSON endpoint.
 *
 * DoH rather than a DNS library because a Worker has no UDP socket, and
 * Cloudflare's endpoint because it is the one a Worker reaches without leaving
 * the network it is already on. Both families are asked for: a host with a
 * public A record and a loopback AAAA record would otherwise be waved through
 * on the strength of the answer we happened to look at.
 */
export async function resolveOverDoh(hostname: string, signal: AbortSignal, fetchImpl: typeof fetch = fetch): Promise<string[]> {
  const ask = async (type: 'A' | 'AAAA'): Promise<string[]> => {
    const url = `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`;
    const response = await fetchImpl(url, { headers: { accept: 'application/dns-json' }, signal });
    if (!response.ok) return [];
    const body = (await response.json()) as { Answer?: { type?: number; data?: string }[] };
    return (body.Answer ?? [])
      .filter((answer) => answer.type === (type === 'A' ? 1 : 28) && typeof answer.data === 'string')
      .map((answer) => String(answer.data));
  };
  const [a, aaaa] = await Promise.all([ask('A'), ask('AAAA')]);
  return [...a, ...aaaa];
}

/** Parse and apply every rule that needs no network. */
function vet(raw: string, allowlist: readonly string[], denied: readonly string[]): { url: URL } | FetchUrlRefused {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return refuse('bad_url', `"${raw.slice(0, 200)}" is not a URL`, raw, []);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return refuse('scheme_not_allowed', `only http and https are fetchable, not ${url.protocol}`, url.toString(), []);
  }
  if (url.username || url.password) {
    return refuse('credentials_in_url', 'a URL carrying credentials is never fetched', `${url.origin}${url.pathname}`, []);
  }
  if (url.port && url.port !== '80' && url.port !== '443') {
    return refuse('port_not_allowed', `only ports 80 and 443 are fetchable, not ${url.port}`, url.toString(), []);
  }
  if (hostMatches(url.hostname, denied)) {
    return refuse('denied_host', `${url.hostname} is on the permanent deny list and cannot be allowlisted`, url.toString(), []);
  }
  if (allowlist.length === 0) {
    return refuse(
      'not_allowlisted',
      'this workspace has no fetch allowlist; an Admin adds domains in Settings before the agent can read the web',
      url.toString(),
      [],
    );
  }
  if (!hostMatches(url.hostname, allowlist)) {
    return refuse('not_allowlisted', `${url.hostname} is not on this workspace's fetch allowlist`, url.toString(), []);
  }
  return { url };
}

/** Resolve and check one hop's host. Returns the addresses, or the refusal. */
async function vetHost(url: URL, resolve: Resolver, signal: AbortSignal, hops: FetchHop[]): Promise<string[] | FetchUrlRefused> {
  if (isIpLiteral(url.hostname)) {
    const verdict = checkAddress(url.hostname.replace(/^\[|\]$/g, ''));
    if (!verdict.allowed) {
      return refuse('private_address', `${url.hostname} is in ${verdict.range ?? 'a refused range'}`, url.toString(), hops);
    }
    return [url.hostname];
  }
  let addresses: string[];
  try {
    addresses = await resolve(url.hostname, signal);
  } catch (error) {
    return refuse('dns_failed', `could not resolve ${url.hostname}: ${(error as Error).message}`, url.toString(), hops);
  }
  if (addresses.length === 0) {
    return refuse('dns_failed', `${url.hostname} resolved to no addresses`, url.toString(), hops);
  }
  for (const address of addresses) {
    const verdict = checkAddress(address);
    if (!verdict.allowed) {
      return refuse(
        'private_address',
        `${url.hostname} resolves to ${address}, which is in ${verdict.range ?? 'a refused range'}`,
        url.toString(),
        hops,
      );
    }
  }
  return addresses;
}

/** Read at most `maxBytes` of a body, then stop pulling. */
async function readCapped(response: Response, maxBytes: number): Promise<{ text: string; bytes: number; capped: boolean }> {
  const body = response.body;
  if (!body) return { text: '', bytes: 0, capped: false };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let capped = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    const remaining = maxBytes - bytes;
    if (value.byteLength >= remaining) {
      chunks.push(value.subarray(0, Math.max(0, remaining)));
      bytes = maxBytes;
      capped = true;
      await reader.cancel().catch(() => undefined);
      break;
    }
    chunks.push(value);
    bytes += value.byteLength;
  }
  const joined = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    joined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return { text: new TextDecoder().decode(joined), bytes, capped };
}

/**
 * Fetch one URL under every rule above.
 *
 * Never throws for a refusal: a refusal is a tool result the model reads and
 * can react to ("that domain is not allowlisted; ask an Admin"), not a run
 * failure. It throws only if the caller hands it something impossible.
 */
export async function fetchUrl(rawUrl: string, method: string, options: FetchUrlOptions): Promise<FetchUrlResult> {
  const upper = method.toUpperCase();
  if (!(FETCH_URL_METHODS as readonly string[]).includes(upper)) {
    return refuse('method_not_allowed', `only ${FETCH_URL_METHODS.join(' and ')} are allowed, not ${method}`, rawUrl, []);
  }
  const fetchImpl = options.fetchImpl ?? fetch;
  const resolve: Resolver = options.resolve ?? ((host, signal) => resolveOverDoh(host, signal, fetchImpl));
  const maxBytes = options.maxBytes ?? FETCH_URL_MAX_BYTES;
  const timeoutMs = options.timeoutMs ?? FETCH_URL_TIMEOUT_MS;
  const maxRedirects = options.maxRedirects ?? FETCH_URL_MAX_REDIRECTS;
  const now = options.now ?? (() => new Date());
  const denied = [...ALWAYS_DENIED_HOSTS, ...(options.denyHosts ?? [])];

  const hops: FetchHop[] = [];
  const vetted = vet(rawUrl, options.allowlist, denied);
  if ('ok' in vetted) return vetted;

  const controller = new AbortController();
  // One deadline for the whole thing — DNS included. A 9-second resolution
  // followed by a 10-second fetch is a 19-second tool, and the tool step's own
  // timeout would then be what stopped it, from the wrong layer.
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    let current = vetted.url;
    for (let hop = 0; hop <= maxRedirects; hop += 1) {
      const addresses = await vetHost(current, resolve, controller.signal, hops);
      if (!Array.isArray(addresses)) return addresses;

      let response: Response;
      try {
        response = await fetchImpl(current.toString(), {
          method: upper,
          // Manual, because following redirects ourselves is the only way each
          // hop gets its own allowlist check and its own resolution.
          redirect: 'manual',
          signal: controller.signal,
          headers: { accept: 'text/html, text/plain;q=0.9, */*;q=0.1', 'user-agent': 'HermesAgent/1.0 (+read-only)' },
        });
      } catch (error) {
        const aborted = controller.signal.aborted;
        hops.push({ url: current.toString(), host: current.hostname, addresses, status: null });
        return refuse(
          aborted ? 'timeout' : 'fetch_failed',
          aborted ? `fetching ${current.hostname} took longer than ${timeoutMs} ms` : `fetching ${current.hostname} failed: ${(error as Error).message}`,
          current.toString(),
          hops,
        );
      }

      hops.push({ url: current.toString(), host: current.hostname, addresses, status: response.status });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) {
          return refuse('http_error', `${current.hostname} answered ${response.status} with no Location`, current.toString(), hops);
        }
        if (hop === maxRedirects) {
          return refuse('too_many_redirects', `more than ${maxRedirects} redirects starting at ${rawUrl}`, current.toString(), hops);
        }
        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          return refuse('bad_url', `${current.hostname} redirected to something that is not a URL`, current.toString(), hops);
        }
        // Every rule again, from the top. A redirect is a new request to a new
        // host chosen by somebody else; treating it as a continuation of the
        // first one is precisely how a fetch of a public status page ends at
        // 169.254.169.254.
        const revetted = vet(next.toString(), options.allowlist, denied);
        if ('ok' in revetted) return { ...revetted, hops };
        current = revetted.url;
        continue;
      }

      if (response.status >= 400) {
        return refuse('http_error', `${current.hostname} answered ${response.status}`, current.toString(), hops);
      }

      const contentType = response.headers.get('content-type');
      const kind = textKindOf(contentType);
      if (kind === 'unsupported') {
        await response.body?.cancel().catch(() => undefined);
        return refuse(
          'unsupported_content_type',
          `${current.hostname} answered ${contentType ?? 'an unknown type'}; this tool reads text and HTML. Upload the file instead, so it is extracted and attributed.`,
          current.toString(),
          hops,
        );
      }

      if (upper === 'HEAD') {
        return {
          ok: true,
          url: rawUrl,
          final_url: current.toString(),
          status: response.status,
          content_type: contentType,
          title: null,
          text: '',
          truncated: false,
          bytes: 0,
          hops,
          retrieved_at: now().toISOString(),
        };
      }

      const { text: body, bytes, capped } = await readCapped(response, maxBytes);
      const reduced = kind === 'html' ? htmlToText(body) : body.trim();
      const truncated = capped || reduced.length > FETCH_URL_TEXT_MAX_CHARS;
      const text =
        reduced.length > FETCH_URL_TEXT_MAX_CHARS
          ? reduced.slice(0, FETCH_URL_TEXT_MAX_CHARS - FETCH_URL_TRUNCATION_MARKER.length) + FETCH_URL_TRUNCATION_MARKER
          : reduced;
      return {
        ok: true,
        url: rawUrl,
        final_url: current.toString(),
        status: response.status,
        content_type: contentType,
        title: kind === 'html' ? htmlTitle(body) : null,
        text,
        truncated,
        bytes,
        hops,
        retrieved_at: now().toISOString(),
      };
    }
    return refuse('too_many_redirects', `more than ${maxRedirects} redirects starting at ${rawUrl}`, rawUrl, hops);
  } finally {
    clearTimeout(timer);
  }
}
