// The two adapters behind `getSession`.
//
// `fake` maps an `x-dev-user` header to a seeded user. `workos` unseals the
// session cookie, verifies the access token locally, and refreshes it when it
// has expired. Both return the same three values, and every route is written
// against those three and nothing else.
import type { Context } from 'hono';
import type { Client } from 'pg';
import type { Env } from '../env.js';
import { connect } from '../db/client.js';
import { AuthError, type AuthAdapter, type Session } from './types.js';
import { SESSION_COOKIE, readCookie, sessionCookie } from './cookies.js';
import { TokenError, verifyAccessToken } from './jwks.js';
import { classifyWorkOSError, workosPort, type WorkOSUser } from './workos.js';

/**
 * A re-sealed cookie, parked until the response exists.
 *
 * `getSession` is called from inside route handlers, which have no way to add a
 * header to a response they have not built yet. Keying on the `Request` object
 * rather than on anything global means two requests in flight in one isolate
 * cannot collect each other's cookies.
 */
const refreshedCookies = new WeakMap<Request, string>();

export function takeRefreshedCookie(request: Request): string | null {
  const cookie = refreshedCookies.get(request);
  if (cookie) refreshedCookies.delete(request);
  return cookie ?? null;
}

/**
 * Freshness, from a row rather than from the token.
 *
 * The WorkOS access token carries no `auth_time` and its `iat` moves on every
 * refresh, so a token cannot answer "when did this person last actually type
 * their password?". `/auth/callback` writes the answer down, keyed by `sid`,
 * and this reads it back. A `sid` we have never seen is recorded as
 * authenticating now, which is true: we are seeing it for the first time.
 */
async function touchAuthSession(client: Client, sid: string, userId: string): Promise<Date> {
  const { rows } = await client.query<{ authenticated_at: Date }>(
    `INSERT INTO auth_sessions (sid, user_id, authenticated_at)
     VALUES ($1, $2, now())
     ON CONFLICT (sid) DO UPDATE SET last_seen_at = now()
     RETURNING authenticated_at`,
    [sid, userId],
  );
  return rows[0]?.authenticated_at ?? new Date();
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

      // The same `auth_sessions` row the WorkOS adapter writes, so step-up is
      // exercised in development and in tests rather than only in production.
      const sid = `dev-${user.id}`;
      const authenticatedAt = await touchAuthSession(client, sid, user.id);
      return { userId: user.id, sid, authenticatedAt };
    } finally {
      await client.end();
    }
  },
};

/**
 * The local mirror of a WorkOS user.
 *
 * Two unique keys exist on `users`, and they mean different things: a WorkOS id
 * says "this is the same account", an email says "this is the same person". So
 * the lookup is by id first and by email second, and the email path *claims*
 * the existing row rather than inserting beside it — a second row for one
 * person would split their sessions, their drafts and their audit trail in a
 * way nothing downstream could reunite.
 */
export async function upsertUser(client: Client, user: WorkOSUser): Promise<string> {
  const name = [user.firstName, user.lastName].filter(Boolean).join(' ').trim() || null;

  const byWorkosId = await client.query<{ id: string }>(
    `UPDATE users
        SET email = lower($2),
            email_verified = $3,
            name = COALESCE($4, name),
            avatar_url = COALESCE($5, avatar_url)
      WHERE workos_user_id = $1
      RETURNING id`,
    [user.id, user.email, user.emailVerified, name, user.profilePictureUrl ?? null],
  );
  if (byWorkosId.rows[0]) return byWorkosId.rows[0].id;

  const byEmail = await client.query<{ id: string }>(
    `UPDATE users
        SET workos_user_id = $1,
            email_verified = $3,
            name = COALESCE($4, name),
            avatar_url = COALESCE($5, avatar_url)
      WHERE email = lower($2) AND workos_user_id IS NULL
      RETURNING id`,
    [user.id, user.email, user.emailVerified, name, user.profilePictureUrl ?? null],
  );
  if (byEmail.rows[0]) return byEmail.rows[0].id;

  const inserted = await client.query<{ id: string }>(
    `INSERT INTO users (workos_user_id, email, email_verified, name, avatar_url)
     VALUES ($1, lower($2), $3, $4, $5)
     ON CONFLICT (email) DO UPDATE SET email_verified = EXCLUDED.email_verified
     RETURNING id`,
    [user.id, user.email, user.emailVerified, name, user.profilePictureUrl ?? null],
  );
  const row = inserted.rows[0];
  if (!row) throw new AuthError('no local user for this WorkOS user', 'unknown_user');
  return row.id;
}

export const workosAuth: AuthAdapter = {
  mode: 'workos',
  async getSession(c: Context<{ Bindings: Env }>): Promise<Session> {
    const sealed = readCookie(c, SESSION_COOKIE);
    if (!sealed) throw new AuthError('no session cookie', 'no_session');

    const port = workosPort(c.env);
    const unsealed = await port.unseal(sealed);
    if (!unsealed) throw new AuthError('the session cookie did not unseal', 'invalid_session');

    let accessToken = unsealed.accessToken;
    let user = unsealed.user;
    let refreshed: string | null = null;

    let claims;
    try {
      claims = await verifyAccessToken(c.env, accessToken);
    } catch (error) {
      if (!(error instanceof TokenError) || error.kind !== 'expired') {
        throw new AuthError('the access token did not verify', 'invalid_session');
      }
      // Expired is the ordinary case: access tokens last 5 to 10 minutes and a
      // person's session lasts all day.
      try {
        const result = await port.refresh(sealed);
        refreshed = result.sealedSession;
        accessToken = result.accessToken;
      } catch (refreshError) {
        const { terminal, retryAfter } = classifyWorkOSError(refreshError);
        if (terminal) throw new AuthError('the session can no longer be refreshed', 'invalid_session');
        // Transient. The cookie is deliberately left alone: clearing it would
        // turn a WorkOS blip into a sign-out across every open tab, and the
        // session is very probably still good.
        throw new AuthError('WorkOS is unavailable', 'upstream_unavailable', 503, retryAfter);
      }
      claims = await verifyAccessToken(c.env, accessToken);
      const reunsealed = await port.unseal(refreshed);
      if (reunsealed) user = reunsealed.user;
    }

    const client = await connect(c.env, 'app');
    try {
      const userId = await upsertUser(client, user);
      const authenticatedAt = await touchAuthSession(client, claims.sid, userId);
      if (refreshed) {
        refreshedCookies.set(c.req.raw, sessionCookie(c.env, refreshed));
        return { userId, sid: claims.sid, authenticatedAt, refreshedCookie: refreshed };
      }
      return { userId, sid: claims.sid, authenticatedAt };
    } finally {
      await client.end();
    }
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
