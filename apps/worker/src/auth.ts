// Authentication, behind one interface.
//
// Every route asks the same question and gets the same three values:
//
//     getSession(c) -> { userId, sid, authenticatedAt }
//
// M1 answered it from an `x-dev-user` header. M2 answers it from a sealed
// WorkOS cookie, with local JWT verification against a cached JWKS and a
// refresh on expiry. No route changed, which is what the interface was for.
// `AUTH_MODE=fake` still works exactly as it did, and a deployed environment
// that is misconfigured fails at the first request rather than falling back to
// trusting a header.
//
// The pieces live in `src/auth/`: the adapters, the sealed-cookie handling, the
// JWKS verifier, the WorkOS boundary, the hub tickets and the guards.
import type { Context } from 'hono';
import type { Env } from './env.js';
import { authAdapter } from './auth/adapters.js';
import { AuthError, type Session } from './auth/types.js';

export { AuthError, type AuthAdapter, type Session } from './auth/types.js';
export { fakeAuth, workosAuth, authAdapter, takeRefreshedCookie, upsertUser } from './auth/adapters.js';
export { SESSION_COOKIE, CSRF_COOKIE, CSRF_HEADER, readCookie } from './auth/cookies.js';
export { requireCsrf, requireOrigin, allowedOrigins } from './auth/guards.js';
export { mintHubTicket, verifyHubTicket, TICKET_TTL_SECONDS } from './auth/tickets.js';

export const getSession = (c: Context<{ Bindings: Env }>): Promise<Session> => authAdapter(c.env).getSession(c);

/**
 * How recently a decision-grade action requires the caller to have actually
 * authenticated. Five minutes, from the plan: long enough that an Admin working
 * through the Inbox is not re-challenged between two decisions, short enough
 * that an unattended laptop is not a way to approve an admission.
 */
export const STEP_UP_MAX_AGE_SECONDS = 5 * 60;

export const isStepUpFresh = (session: Session, maxAgeSeconds = STEP_UP_MAX_AGE_SECONDS): boolean =>
  Date.now() - session.authenticatedAt.getTime() <= maxAgeSeconds * 1000;

/**
 * Refuse an action whose session is not fresh enough.
 *
 * The client's answer to `reauth_required` is to send the person back through
 * `/auth/login?step_up=1`, which asks WorkOS for `max_age: 0` and comes back
 * with the same `sid` and a newer `auth_time` persisted as `authenticated_at`.
 */
export function requireStepUp(session: Session, maxAgeSeconds = STEP_UP_MAX_AGE_SECONDS): void {
  if (!isStepUpFresh(session, maxAgeSeconds)) {
    throw new AuthError('this action needs a recent sign-in', 'reauth_required', 401);
  }
}
