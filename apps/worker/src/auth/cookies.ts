// Cookies, written in one place so that every flag is decided once.
//
// The API and the client bundle are served from one origin, which is what lets
// the session cookie be SameSite=Strict: a cross-site request carries no
// cookie at all, so the classic CSRF shape cannot reach an authenticated route.
// The double-submit token below is the second layer, for the cases SameSite
// does not cover (an older browser, a same-site subdomain).
import type { Context } from 'hono';
import type { Env } from '../env.js';

/** The sealed WorkOS session. httpOnly: no script ever reads it. */
export const SESSION_COOKIE = 'hermes_session';
/** The double-submit CSRF token. Readable by script on purpose. */
export const CSRF_COOKIE = 'hermes_csrf';
export const CSRF_HEADER = 'x-csrf-token';

const isSecure = (env: Env): boolean => env.ENVIRONMENT === 'staging' || env.ENVIRONMENT === 'production';

export function readCookie(c: Context<{ Bindings: Env }>, name: string): string | null {
  const header = c.req.header('cookie');
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() !== name) continue;
    return decodeURIComponent(part.slice(index + 1).trim());
  }
  return null;
}

export function sessionCookie(env: Env, sealed: string, maxAgeSeconds = 60 * 60 * 24 * 14): string {
  const flags = ['Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSeconds}`];
  if (isSecure(env)) flags.push('Secure');
  return `${SESSION_COOKIE}=${encodeURIComponent(sealed)}; ${flags.join('; ')}`;
}

export function clearedSessionCookie(env: Env): string {
  const flags = ['Path=/', 'HttpOnly', 'SameSite=Strict', 'Max-Age=0'];
  if (isSecure(env)) flags.push('Secure');
  return `${SESSION_COOKIE}=; ${flags.join('; ')}`;
}

/** Not httpOnly: the client has to read it to echo it back in the header. */
export function csrfCookie(env: Env, token: string): string {
  const flags = ['Path=/', 'SameSite=Strict', `Max-Age=${60 * 60 * 24 * 14}`];
  if (isSecure(env)) flags.push('Secure');
  return `${CSRF_COOKIE}=${token}; ${flags.join('; ')}`;
}

export function clearedCsrfCookie(env: Env): string {
  const flags = ['Path=/', 'SameSite=Strict', 'Max-Age=0'];
  if (isSecure(env)) flags.push('Secure');
  return `${CSRF_COOKIE}=; ${flags.join('; ')}`;
}

export const newCsrfToken = (): string => crypto.randomUUID().replace(/-/g, '');
