// Local verification of the WorkOS access token.
//
// Verifying locally is what keeps an authenticated request to one round trip:
// the token is an RS256 JWT, the signing keys are published at a JWKS endpoint,
// and nothing about checking a signature needs WorkOS to be reachable. That
// also means a WorkOS outage degrades to "nobody can sign in" rather than
// "nobody can do anything".
//
// Three details are the whole of it:
//
//   * the key set is cached for ten minutes, because fetching it per request
//     would put a third-party host in the path of every call;
//   * an unknown `kid` refetches immediately, because that is what a key
//     rotation looks like from here and waiting ten minutes for it would be an
//     outage we chose;
//   * 60 seconds of clock skew is allowed on `exp` and `nbf`, because two
//     machines' clocks disagree and a five-minute token that expires 400 ms
//     early would sign people out for no reason.
import type { Env } from '../env.js';

export interface AccessTokenClaims {
  readonly sub: string;
  readonly sid: string;
  readonly iss: string;
  readonly exp: number;
  readonly iat: number;
  readonly nbf?: number;
  readonly org_id?: string;
  readonly role?: string;
  readonly permissions?: string[];
}

export const JWKS_TTL_MS = 10 * 60 * 1000;
export const CLOCK_SKEW_SECONDS = 60;

interface JwkSet {
  keys: (JsonWebKey & { kid?: string; alg?: string })[];
}

interface CacheEntry {
  readonly url: string;
  readonly fetchedAt: number;
  readonly keys: Map<string, CryptoKey>;
}

let cache: CacheEntry | null = null;
/** Test seam: a JWKS document served from memory rather than over the network. */
let fetchJwks: ((url: string) => Promise<JwkSet>) | null = null;

export function setJwksFetcherForTests(fetcher: ((url: string) => Promise<JwkSet>) | null): void {
  fetchJwks = fetcher;
  cache = null;
}

export function jwksUrl(env: Env): string {
  const clientId = env.WORKOS_CLIENT_ID;
  if (!clientId) throw new Error('WORKOS_CLIENT_ID is required to verify an access token');
  return `https://api.workos.com/sso/jwks/${clientId}`;
}

async function loadKeys(url: string): Promise<Map<string, CryptoKey>> {
  const document = fetchJwks
    ? await fetchJwks(url)
    : ((await (await fetch(url)).json()) as JwkSet);
  const keys = new Map<string, CryptoKey>();
  for (const jwk of document.keys ?? []) {
    if (!jwk.kid) continue;
    const key = await crypto.subtle.importKey(
      'jwk',
      jwk,
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
      false,
      ['verify'],
    );
    keys.set(jwk.kid, key);
  }
  return keys;
}

/**
 * Can we still verify a WorkOS token? Read by `/health` in `AUTH_MODE=workos`.
 *
 * It goes through the same cache and the same test seam as verification does,
 * so a healthy answer means the path a real request takes is healthy — not that
 * a second, differently-configured fetch succeeded. It costs a subrequest at
 * most once per ten-minute cache window however often health is polled.
 */
export async function jwksKeyCount(env: Env): Promise<number> {
  const url = jwksUrl(env);
  const fresh = cache && cache.url === url && Date.now() - cache.fetchedAt < JWKS_TTL_MS;
  if (!fresh) cache = { url, fetchedAt: Date.now(), keys: await loadKeys(url) };
  return cache?.keys.size ?? 0;
}

async function keyFor(url: string, kid: string): Promise<CryptoKey | null> {
  const fresh = cache && cache.url === url && Date.now() - cache.fetchedAt < JWKS_TTL_MS;
  if (!fresh) {
    cache = { url, fetchedAt: Date.now(), keys: await loadKeys(url) };
  }
  const hit = cache?.keys.get(kid);
  if (hit) return hit;
  // An unknown kid is a rotation, not an attack: refetch once, now.
  cache = { url, fetchedAt: Date.now(), keys: await loadKeys(url) };
  return cache.keys.get(kid) ?? null;
}

const decode = (segment: string): unknown => {
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(segment.length / 4) * 4, '=');
  return JSON.parse(atob(padded)) as unknown;
};

const rawBytes = (segment: string): Uint8Array => {
  const padded = segment.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(segment.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

export class TokenError extends Error {
  constructor(message: string, readonly kind: 'expired' | 'invalid') {
    super(message);
    this.name = 'TokenError';
  }
}

/**
 * Verify signature, then time. The order matters: an expired token whose
 * signature does not check out is not "expired", it is forged, and the caller
 * refreshes on the first and refuses on the second.
 */
export async function verifyAccessToken(env: Env, token: string): Promise<AccessTokenClaims> {
  const [headerPart, payloadPart, signaturePart] = token.split('.');
  if (!headerPart || !payloadPart || !signaturePart) throw new TokenError('not a JWT', 'invalid');

  const header = decode(headerPart) as { kid?: string; alg?: string };
  if (header.alg !== 'RS256') throw new TokenError(`unsupported alg ${header.alg}`, 'invalid');
  if (!header.kid) throw new TokenError('no kid', 'invalid');

  const key = await keyFor(jwksUrl(env), header.kid);
  if (!key) throw new TokenError(`unknown kid ${header.kid}`, 'invalid');

  const ok = await crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    rawBytes(signaturePart),
    new TextEncoder().encode(`${headerPart}.${payloadPart}`),
  );
  if (!ok) throw new TokenError('signature does not verify', 'invalid');

  const claims = decode(payloadPart) as AccessTokenClaims;
  const now = Math.floor(Date.now() / 1000);
  if (typeof claims.exp !== 'number') throw new TokenError('no exp', 'invalid');
  if (claims.exp + CLOCK_SKEW_SECONDS < now) throw new TokenError('token expired', 'expired');
  if (typeof claims.nbf === 'number' && claims.nbf - CLOCK_SKEW_SECONDS > now) {
    throw new TokenError('token not yet valid', 'invalid');
  }
  if (!claims.sub || !claims.sid) throw new TokenError('token carries no sub or sid', 'invalid');
  return claims;
}

/**
 * The claims, without verifying anything.
 *
 * Only for a token we just received from WorkOS over TLS in exchange for a
 * code: at that moment the transport is the proof, and all we want is the `sid`
 * to write down. Every other read of a token goes through `verifyAccessToken`.
 */
export function unverifiedClaims(token: string): Partial<AccessTokenClaims> {
  const payload = token.split('.')[1];
  if (!payload) return {};
  try {
    return decode(payload) as Partial<AccessTokenClaims>;
  } catch {
    return {};
  }
}
