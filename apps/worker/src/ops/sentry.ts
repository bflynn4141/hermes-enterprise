// Sentry, trimmed to what an enterprise pilot can defend.
//
// Plan section 5, Observability: "`@sentry/cloudflare` with user info, cookies
// and bodies off". Three switches, and each one is a decision rather than a
// default:
//
//   sendDefaultPii: false   The SDK's own flag for "attach IP, headers,
//                           cookies and request bodies". A request body here is
//                           an applicant's application; a cookie here is a
//                           sealed session that would let whoever reads it sign
//                           in as that person. Neither belongs in a third-party
//                           error tracker, and the erasure inventory in plan
//                           section 6 lists Sentry as "ids only".
//
//   beforeSend              The belt to that braces. `sendDefaultPii: false`
//                           is the SDK's promise; this hook is ours, and it
//                           strips the request's headers, cookies, body and
//                           query string whatever the SDK decided, then runs
//                           every string through the same redactor the logs
//                           use. An SDK upgrade that changed the default would
//                           otherwise be a data leak discovered in a changelog.
//
//   user                    The user *id* and nothing else. No email, no name,
//                           no IP. That is enough to answer "is this one person
//                           or everyone" during an incident, which is the only
//                           question the field is there for.
//
// The whole thing is off when `SENTRY_DSN` is unset: `withSentry`'s options
// callback may return `undefined`, which is the documented way to disable the
// SDK, and that is what local development, the test suite and any deployment
// that has not been given a DSN get. No conditional import, no second code
// path — the wrapper is always applied and does nothing.
import type { CloudflareOptions } from '@sentry/cloudflare';
import type { Env } from '../env.js';
import { redact, redactString } from '../keys/redact.js';

/** Fields Sentry may carry on an event. Structurally typed so the SDK's own
 *  types are not a compile-time dependency of this module's tests. */
export interface SentryEventLike {
  request?: {
    url?: string;
    method?: string;
    headers?: Record<string, string>;
    cookies?: Record<string, string> | string;
    data?: unknown;
    query_string?: unknown;
  };
  user?: { id?: string | number; email?: string; username?: string; ip_address?: string; [k: string]: unknown };
  contexts?: Record<string, unknown>;
  extra?: Record<string, unknown>;
  tags?: Record<string, unknown>;
  breadcrumbs?: { message?: string; data?: unknown; [k: string]: unknown }[];
  message?: string;
  [k: string]: unknown;
}

/**
 * Strip an event down to what the inventory allows.
 *
 * Exported and pure so a unit test can hand it a worst-case event — a cookie, a
 * bearer token in a breadcrumb, an applicant's name in the body, a presigned
 * URL in the request URL — and assert that none of it survives.
 */
export function scrubEvent(event: SentryEventLike): SentryEventLike {
  const out: SentryEventLike = { ...event };

  if (out.request) {
    // The URL is kept because a path is how an incident is located, but its
    // query string is dropped: a presigned URL's signature lives there, and so
    // does every `?token=` anyone ever adds to a route.
    let url = out.request.url;
    if (typeof url === 'string') {
      const cut = url.indexOf('?');
      url = redactString(cut === -1 ? url : url.slice(0, cut));
    }
    out.request = {
      ...(url === undefined ? {} : { url }),
      ...(out.request.method === undefined ? {} : { method: out.request.method }),
      // headers, cookies, data and query_string are dropped entirely rather
      // than redacted: there is no header on this Worker whose value is worth
      // an argument about whether the redactor caught it.
    };
  }

  if (out.user) {
    // The id only. `ip_address: '{{auto}}'` is what the SDK fills in when PII
    // is on; dropping the key is how it stays off.
    out.user = out.user.id === undefined ? {} : { id: String(out.user.id) };
  }

  // Everything else that can carry free text goes through the log redactor, so
  // Sentry and the logs cannot disagree about what a secret looks like.
  if (out.extra) out.extra = redact(out.extra) as Record<string, unknown>;
  if (out.contexts) out.contexts = redact(out.contexts) as Record<string, unknown>;
  if (out.tags) out.tags = redact(out.tags) as Record<string, unknown>;
  if (out.breadcrumbs) out.breadcrumbs = redact(out.breadcrumbs) as SentryEventLike['breadcrumbs'];
  if (typeof out.message === 'string') out.message = redactString(out.message);

  return out;
}

/**
 * The options callback `withSentry` is given.
 *
 * Returns `undefined` when there is no DSN, which disables the SDK — the
 * no-op path, taken by `wrangler dev --local`, every test and any environment
 * that has not been handed a DSN.
 *
 * `release` is `ENGINE_VERSION`, not a build hash: the engine version is the
 * number the runbook's rollback procedure moves and the number a `runs` row
 * carries, so an error grouped by it can be lined up against the rows it
 * affected. A build hash would group errors by something nothing else records.
 */
export function sentryOptions(env: Env): CloudflareOptions | undefined {
  const dsn = (env.SENTRY_DSN ?? '').trim();
  if (!dsn) return undefined;
  return {
    dsn,
    environment: env.ENVIRONMENT ?? 'unknown',
    release: `hermes@${env.ENGINE_VERSION ?? '0'}`,
    sendDefaultPii: false,
    // Errors, not a tracing product. Correlation is the app's own `trace_id`,
    // which is on every log line, every `model_calls` row and every
    // `stream_events` row — and unlike a Sentry trace it survives into the
    // database, where an incident is actually reconstructed. Workflows support
    // in the SDK is unverified (plan section 14), which is the other reason not
    // to lean on it.
    tracesSampleRate: 0,
    maxBreadcrumbs: 20,
    // The hooks are declared over `SentryEventLike` — this module's own
    // structural view of an event — and handed to the SDK through one cast.
    // The alternative is importing the SDK's `ErrorEvent` and `Breadcrumb`
    // types into a pure module whose whole point is that its redaction can be
    // unit-tested without the SDK present; the cast is narrower than that
    // coupling, and `scrubEvent` only ever reads and deletes fields.
    beforeSend: scrubEvent as unknown as CloudflareOptions['beforeSend'],
    beforeBreadcrumb: ((crumb: { message?: string; data?: unknown }) =>
      redact(crumb) as { message?: string; data?: unknown }) as unknown as CloudflareOptions['beforeBreadcrumb'],
  };
}
