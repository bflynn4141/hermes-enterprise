// Authentication, behind one interface.
//
// M1 ships the fake adapter only: `AUTH_MODE=fake` reads an `x-dev-user` header
// and maps it to a seeded user. M2 replaces it with the WorkOS adapter — sealed
// cookie, local JWT verification against cached JWKS, refresh on expiry —
// without any route changing, because every route asks the same question:
//
//     getSession(c) -> { userId, sid, authenticatedAt }
//
// `authenticatedAt` is here from the start because step-up needs it: the WorkOS
// access token carries no `auth_time`, and `iat` moves on every refresh, so
// freshness has to come from a row we write at callback time. Fake mode returns
// "now", which is honest: in development every session is fresh.
import type { Context } from 'hono';
import type { Env } from './env.js';
import { connect } from './db/client.js';

export interface Session {
  readonly userId: string;
  /** The authenticated session id; the unit step-up is measured against. */
  readonly sid: string;
  /** When this `sid` actually authenticated, not when its token was refreshed. */
  readonly authenticatedAt: Date;
}

export class AuthError extends Error {
  constructor(
    message: string,
    readonly reason: 'no_session' | 'unknown_user' | 'not_configured' | 'upstream_unavailable',
    readonly status: 401 | 503 = 401,
  ) {
    super(message);
    this.name = 'AuthError';
  }
}

export interface AuthAdapter {
  readonly mode: string;
  getSession(c: Context<{ Bindings: Env }>): Promise<Session>;
}

/**
 * Development adapter. The header names a seeded user by email or id; the row
 * must already exist, so a typo is a 401 rather than an invented identity.
 */
export const fakeAuth: AuthAdapter = {
  mode: 'fake',
  async getSession(c) {
    const header = c.req.header('x-dev-user');
    if (!header) throw new AuthError('x-dev-user is required in fake auth mode', 'no_session');

    const client = await connect(c.env, 'app');
    try {
      const { rows } = await client.query<{ id: string }>(
        `SELECT id FROM users WHERE id::text = $1 OR email = lower($1) LIMIT 1`,
        [header],
      );
      const user = rows[0];
      if (!user) throw new AuthError(`no seeded user matches ${header}`, 'unknown_user');
      return { userId: user.id, sid: `dev-${user.id}`, authenticatedAt: new Date() };
    } finally {
      await client.end();
    }
  },
};

/**
 * Placeholder for M2. It exists so that a misconfigured deploy fails loudly at
 * the first request instead of falling back to the development adapter, which
 * would be the worst possible failure mode: a production Worker trusting a
 * header.
 */
export const workosAuth: AuthAdapter = {
  mode: 'workos',
  getSession() {
    return Promise.reject(
      new AuthError('WorkOS authentication is not implemented until M2', 'not_configured', 503),
    );
  },
};

export function authAdapter(env: Env): AuthAdapter {
  switch (env.AUTH_MODE) {
    case 'fake':
      return fakeAuth;
    case 'workos':
      return workosAuth;
    default:
      throw new AuthError(`unknown AUTH_MODE: ${env.AUTH_MODE ?? '(unset)'}`, 'not_configured', 503);
  }
}

export const getSession = (c: Context<{ Bindings: Env }>): Promise<Session> => authAdapter(c.env).getSession(c);
