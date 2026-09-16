// Browser-bound AuthKit authorization transactions.
//
// OAuth `state` is useful only when the browser that started the authorization
// can prove which value it issued. A return path placed directly in `state`
// proves neither that nor that the callback belongs to a current login. This
// module keeps the return path and invitation token in a short-lived, signed,
// httpOnly cookie and sends only a random nonce through WorkOS.
//
// The cookie is SameSite=Lax rather than Strict because AuthKit returns through
// a cross-site top-level navigation. It is scoped to the callback path, cleared
// after one successful exchange, and never contains the authorization code.
import type { Context } from 'hono';
import type { Env } from '../env.js';
import { AuthError } from './types.js';
import { readCookie } from './cookies.js';

export const AUTH_TRANSACTION_COOKIE = 'hermes_auth_transaction';
export const AUTH_TRANSACTION_TTL_SECONDS = 10 * 60;

export interface AuthTransaction {
  readonly state: string;
  readonly returnTo: string;
  readonly invitationToken?: string;
  readonly issuedAt: number;
}

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const base64Url = (bytes: Uint8Array): string => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};

const decodeBase64Url = (value: string): Uint8Array => {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

async function signingKey(env: Env): Promise<CryptoKey> {
  if (!env.WORKOS_COOKIE_PASSWORD) {
    throw new AuthError('WORKOS_COOKIE_PASSWORD is required for an auth transaction', 'not_configured', 503);
  }
  return crypto.subtle.importKey(
    'raw',
    encoder.encode(`hermes-auth-transaction-v1\0${env.WORKOS_COOKIE_PASSWORD}`),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

const secure = (env: Env): boolean => env.ENVIRONMENT === 'staging' || env.ENVIRONMENT === 'production';

function transactionCookie(env: Env, value: string, maxAge: number): string {
  const flags = ['Path=/auth/callback', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`];
  if (secure(env)) flags.push('Secure');
  return `${AUTH_TRANSACTION_COOKIE}=${value}; ${flags.join('; ')}`;
}

export function clearedAuthTransactionCookie(env: Env): string {
  return transactionCookie(env, '', 0);
}

export async function beginAuthTransaction(
  env: Env,
  input: { returnTo: string; invitationToken?: string },
): Promise<{ state: string; cookie: string }> {
  const nonce = new Uint8Array(32);
  crypto.getRandomValues(nonce);
  const transaction: AuthTransaction = {
    state: base64Url(nonce),
    returnTo: input.returnTo,
    ...(input.invitationToken ? { invitationToken: input.invitationToken } : {}),
    issuedAt: Math.floor(Date.now() / 1000),
  };
  const payload = base64Url(encoder.encode(JSON.stringify(transaction)));
  const signature = new Uint8Array(
    await crypto.subtle.sign('HMAC', await signingKey(env), encoder.encode(payload)),
  );
  return {
    state: transaction.state,
    cookie: transactionCookie(env, `${payload}.${base64Url(signature)}`, AUTH_TRANSACTION_TTL_SECONDS),
  };
}

/**
 * Verify the cookie before parsing any values from it. Null is one public
 * answer for a missing, stale, malformed, tampered or different-browser state.
 */
export async function readAuthTransaction(
  c: Context<{ Bindings: Env }>,
  returnedState: string | undefined,
): Promise<AuthTransaction | null> {
  const value = readCookie(c, AUTH_TRANSACTION_COOKIE);
  if (!returnedState || !value) return null;
  const [payload, signature, extra] = value.split('.');
  if (!payload || !signature || extra) return null;

  try {
    const valid = await crypto.subtle.verify(
      'HMAC',
      await signingKey(c.env),
      decodeBase64Url(signature),
      encoder.encode(payload),
    );
    if (!valid) return null;

    const parsed = JSON.parse(decoder.decode(decodeBase64Url(payload))) as Partial<AuthTransaction>;
    if (
      typeof parsed.state !== 'string' ||
      parsed.state !== returnedState ||
      typeof parsed.returnTo !== 'string' ||
      typeof parsed.issuedAt !== 'number' ||
      (parsed.invitationToken !== undefined && typeof parsed.invitationToken !== 'string')
    ) {
      return null;
    }
    const now = Math.floor(Date.now() / 1000);
    if (parsed.issuedAt > now + 60 || now - parsed.issuedAt > AUTH_TRANSACTION_TTL_SECONDS) return null;
    return parsed as AuthTransaction;
  } catch {
    return null;
  }
}
