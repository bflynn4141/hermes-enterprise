// Hub tickets.
//
// A socket cannot refresh a cookie, so a hub cannot ask the database whether
// the person on the other end is still a member — and it must not, because a
// hub that opens a connection is a hub that can be slow, and the whole design
// says hubs hold nothing and query nothing. Instead the Worker, which has just
// done the membership lookup under row-level security, hands the client a
// short-lived signed statement of what it found. The client presents it on the
// socket every four minutes; the hub verifies the signature, extends the
// window, and closes the socket if the ticket ever stops arriving.
//
// So the ticket is not a credential the client earns. It is a receipt for an
// authorisation decision the Worker already made, and it expires quickly enough
// that a removal takes effect within one window even if the evict fan-out is
// lost entirely.
import type { Env } from '../env.js';

export const TICKET_TTL_SECONDS = 10 * 60;

export interface HubTicket {
  readonly user_id: string;
  readonly workspace_id: string;
  readonly session_id: string | null;
  /** Epoch seconds. */
  readonly exp: number;
}

/**
 * Development has no secret, and that is on purpose: `.dev.vars` is empty in a
 * fresh checkout and `wrangler dev` has to work anyway. A deployed environment
 * that reached this line without a secret is a bug worth failing on, because a
 * predictable ticket key would let anyone mint an authorisation receipt.
 */
function ticketSecret(env: Env): string {
  const secret = env.HUB_TICKET_SECRET ?? env.WORKOS_COOKIE_PASSWORD;
  if (secret) return secret;
  if (env.ENVIRONMENT === 'staging' || env.ENVIRONMENT === 'production') {
    throw new Error('HUB_TICKET_SECRET (or WORKOS_COOKIE_PASSWORD) must be set outside development');
  }
  return 'hermes-development-hub-ticket-secret';
}

const encoder = new TextEncoder();

async function key(env: Env): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(ticketSecret(env)),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

const b64url = (bytes: ArrayBuffer | Uint8Array): string => {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (const byte of view) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const fromB64url = (value: string): Uint8Array => {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

export async function mintHubTicket(
  env: Env,
  claims: { userId: string; workspaceId: string; sessionId?: string | null },
  ttlSeconds = TICKET_TTL_SECONDS,
): Promise<{ ticket: string; expiresAt: Date }> {
  const exp = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload: HubTicket = {
    user_id: claims.userId,
    workspace_id: claims.workspaceId,
    session_id: claims.sessionId ?? null,
    exp,
  };
  const body = b64url(encoder.encode(JSON.stringify(payload)));
  const signature = await crypto.subtle.sign('HMAC', await key(env), encoder.encode(body));
  return { ticket: `${body}.${b64url(signature)}`, expiresAt: new Date(exp * 1000) };
}

/** Null on any failure. A caller must not learn which part of a ticket was wrong. */
export async function verifyHubTicket(env: Env, ticket: string): Promise<HubTicket | null> {
  const [body, signature] = ticket.split('.');
  if (!body || !signature) return null;
  let ok: boolean;
  try {
    ok = await crypto.subtle.verify('HMAC', await key(env), fromB64url(signature), encoder.encode(body));
  } catch {
    return null;
  }
  if (!ok) return null;
  try {
    const payload = JSON.parse(new TextDecoder().decode(fromB64url(body))) as HubTicket;
    if (typeof payload.exp !== 'number' || payload.exp * 1000 <= Date.now()) return null;
    return payload;
  } catch {
    return null;
  }
}
