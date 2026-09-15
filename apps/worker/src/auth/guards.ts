// The guards a state-changing request passes before it reaches a transaction.
//
// Origin and CSRF are separate checks because they fail differently. A foreign
// `Origin` means the request came from a page we do not serve — a socket
// upgrade from another site, a form on someone else's domain — and the answer
// is no, whatever the cookie says. A missing double-submit token means the
// request may well be ours but cannot prove it, and the answer is also no. Both
// carry their own `reason`, so the client can tell "you are signed out" from
// "reload the page".
import type { Context } from 'hono';
import type { Env } from '../env.js';
import { AuthError } from './types.js';
import { CSRF_COOKIE, CSRF_HEADER, readCookie } from './cookies.js';

export function allowedOrigins(env: Env): string[] {
  return (env.ALLOWED_ORIGINS ?? '')
    .split(',')
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
}

/**
 * Refuse a request whose `Origin` is not one we serve.
 *
 * A same-origin `fetch` sends `Origin` on every state-changing method, and a
 * WebSocket upgrade always sends it, so an absent header on a socket upgrade is
 * treated as foreign: cross-site WebSocket hijacking is the CSRF of sockets,
 * and a socket that skipped the check would stream one workspace's events to
 * any page that could open it. For ordinary HTTP a missing header is allowed,
 * because `curl` and the tests are not browsers and the cookie rules already
 * cover the browser case.
 */
export function requireOrigin(c: Context<{ Bindings: Env }>, options: { required: boolean }): void {
  const origin = c.req.header('origin');
  if (!origin) {
    if (options.required) {
      throw new AuthError('a WebSocket upgrade must carry an Origin', 'forbidden_origin', 403);
    }
    return;
  }
  if (!allowedOrigins(c.env).includes(origin)) {
    throw new AuthError(`origin ${origin} is not allowed`, 'forbidden_origin', 403);
  }
}

/**
 * Double-submit: the cookie and the header must agree.
 *
 * Only enforced when the request actually authenticated with a cookie. In
 * `AUTH_MODE=fake` the caller authenticates with a header, which a foreign page
 * cannot set in the first place, so there is nothing for a token to add.
 */
export function requireCsrf(c: Context<{ Bindings: Env }>): void {
  if (c.env.AUTH_MODE !== 'workos') return;
  const cookie = readCookie(c, CSRF_COOKIE);
  const header = c.req.header(CSRF_HEADER);
  if (!cookie || !header || cookie !== header) {
    throw new AuthError('the CSRF token is missing or does not match', 'csrf_failed', 403);
  }
}
