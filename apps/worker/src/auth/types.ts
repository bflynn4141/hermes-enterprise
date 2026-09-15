// The one question every route asks about the caller.
//
// `getSession(c) -> { userId, sid, authenticatedAt }` is the whole interface.
// M1 answered it from a header; M2 answers it from a sealed WorkOS cookie. No
// route changed, which is the point of putting it behind an interface in the
// first place.
import type { Context } from 'hono';
import type { Env } from '../env.js';

export interface Session {
  readonly userId: string;
  /** The authenticated session id; the unit step-up is measured against. */
  readonly sid: string;
  /** When this `sid` actually authenticated, not when its token was refreshed. */
  readonly authenticatedAt: Date;
  /** A re-sealed cookie the response must set, when the session was refreshed. */
  readonly refreshedCookie?: string;
}

export type AuthReason =
  | 'no_session'
  | 'unknown_user'
  | 'not_configured'
  | 'upstream_unavailable'
  | 'invalid_session'
  | 'reauth_required'
  | 'forbidden_origin'
  | 'csrf_failed';

export class AuthError extends Error {
  constructor(
    message: string,
    readonly reason: AuthReason,
    readonly status: 401 | 403 | 503 = 401,
    /** Seconds; sent as Retry-After so a client backs off rather than spins. */
    readonly retryAfter?: number,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export interface AuthAdapter {
  readonly mode: string;
  getSession(c: Context<{ Bindings: Env }>): Promise<Session>;
}
