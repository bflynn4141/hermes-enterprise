// `/auth/*`: the four routes the browser talks to about identity.
//
//   GET /auth/login     redirect to the AuthKit hosted UI. `?step_up=1` asks
//                       for `max_age: 0`, which forces a real re-authentication
//                       and yields a new `sid`.
//   GET /auth/callback  exchange the code, seal the session, mirror the user
//                       and the membership, record `(sid, authenticated_at)`.
//   GET /auth/session   re-seal, and hand back both stream heads and a hub
//                       ticket. The client calls this every four minutes,
//                       because a WebSocket cannot refresh a cookie.
//   POST /auth/logout   clear the cookie and send the browser to WorkOS.
//
// The callback is the interesting one. A person who accepts an invitation
// reaches the shell before the events poller has run, so if membership only
// arrived through the poller they would see "workspace not found" for up to a
// minute after being told they had joined. So the callback mirrors the
// membership itself, from the authentication response, and falls back to
// `listOrganizationMemberships` when that response carries no organization.
import type { Context } from 'hono';
import { authSessionSchema } from '@hermes/shared';
import type { Env } from '../env.js';
import { getSession } from '../auth.js';
import { AuthError } from '../auth/types.js';
import { upsertUser, takeRefreshedCookie } from '../auth/adapters.js';
import {
  CSRF_COOKIE,
  SESSION_COOKIE,
  clearedSessionCookie,
  csrfCookie,
  newCsrfToken,
  readCookie,
  sessionCookie,
} from '../auth/cookies.js';
import { mintHubTicket } from '../auth/tickets.js';
import { unverifiedClaims } from '../auth/jwks.js';
import { optionalWorkosPort, workosPort } from '../auth/workos.js';
import { connect, withTenantTransaction } from '../db/client.js';
import { withWorkspaceTransaction } from '../jobs.js';
import { RouteError } from './tenant.js';
import { mirrorMembership } from './members.js';

const redirectUri = (c: Context<{ Bindings: Env }>): string =>
  c.env.WORKOS_REDIRECT_URI ?? `${new URL(c.req.url).origin}/auth/callback`;

/** GET /auth/login */
export function login(c: Context<{ Bindings: Env }>): Response {
  const port = workosPort(c.env);
  const stepUp = c.req.query('step_up') === '1';
  const returnTo = c.req.query('return_to') ?? '/';
  const url = port.authorizationUrl({
    redirectUri: redirectUri(c),
    state: returnTo,
    // `max_age: 0` is documented as forcing the user to re-authenticate. The
    // new session arrives with a new `sid`, and `auth_sessions` records when
    // that `sid` authenticated, which is what the step-up check compares.
    ...(stepUp ? { maxAge: 0 } : {}),
    ...(c.req.query('invitation_token') ? { invitationToken: c.req.query('invitation_token') as string } : {}),
    screenHint: 'sign-in',
  });
  return c.redirect(url, 302);
}

/** GET /auth/callback */
export async function callback(c: Context<{ Bindings: Env }>): Promise<Response> {
  const code = c.req.query('code');
  if (!code) throw new RouteError('the callback needs a code', 'no_code', 400);
  const port = workosPort(c.env);

  const invitationToken = c.req.query('invitation_token');
  const authentication = await port.authenticateWithCode({
    code,
    ...(invitationToken ? { invitationToken } : {}),
  });

  // The membership WorkOS just told us about, or — when the response carries
  // no organization, which happens for a person who belongs to several — the
  // list, asked for once.
  let organizationId = authentication.organizationId;
  if (!organizationId) {
    const memberships = await port.listOrganizationMemberships({ userId: authentication.user.id });
    organizationId = memberships.find((m) => m.status === 'active')?.organizationId ?? null;
  }

  const client = await connect(c.env, 'app');
  let userId: string;
  let workspaceId: string | null = null;
  try {
    userId = await upsertUser(client, authentication.user);

    if (organizationId) {
      const { rows } = await client.query<{ workspace_id: string }>(
        `SELECT workspace_id FROM workspace_directory WHERE workos_organization_id = $1`,
        [organizationId],
      );
      workspaceId = rows[0]?.workspace_id ?? null;
    }

    // `sid` and when it authenticated. The access token carries no
    // `auth_time`, and its `iat` moves on every refresh, so freshness has to
    // come from a row we write here, once, at the moment of authentication.
    const sid = unverifiedClaims(authentication.accessToken).sid;
    if (sid) {
      await client.query(
        `INSERT INTO auth_sessions (sid, user_id, authenticated_at)
         VALUES ($1, $2, now())
         ON CONFLICT (sid) DO UPDATE SET authenticated_at = now(), last_seen_at = now(), revoked_at = NULL`,
        [sid, userId],
      );
    }
  } finally {
    await client.end();
  }

  if (workspaceId && organizationId) {
    const memberships = await port.listOrganizationMemberships({
      userId: authentication.user.id,
      organizationId,
    });
    const membership = memberships[0];
    if (membership) {
      // The same mirror the poller writes, so a membership that arrives by
      // either route produces one shape of row.
      // A system transaction rather than a tenant one: `withTenantTransaction`
      // proves the caller is already a member, and this is the code path that
      // makes them one. The tenant key is still set, so row-level security
      // still applies to every statement inside.
      await withWorkspaceTransaction(c.env, workspaceId, async (tx) => {
        await mirrorMembership(tx, {
          workspaceId,
          userId,
          role: membership.role === 'admin' ? 'admin' : 'member',
          workosMembershipId: membership.id,
          status: membership.status === 'active' ? 'active' : 'inactive',
          email: authentication.user.email,
        });
      }).catch((error: unknown) => {
        // A person whose membership cannot be mirrored still gets a session;
        // they simply see no workspace until the poller catches up. Failing the
        // sign-in instead would make a mirror bug look like an auth outage.
        console.log(JSON.stringify({ at: 'auth.callback', mirror: false, error: String(error) }));
      });
    }
  }

  const csrf = newCsrfToken();
  const headers = new Headers({ Location: c.req.query('state') || '/' });
  headers.append('Set-Cookie', sessionCookie(c.env, authentication.sealedSession));
  headers.append('Set-Cookie', csrfCookie(c.env, csrf));
  return new Response(null, { status: 302, headers });
}

/** POST /auth/logout, and GET for the link case. */
export async function logout(c: Context<{ Bindings: Env }>): Promise<Response> {
  const sealed = readCookie(c, SESSION_COOKIE);
  let location = '/';
  const port = optionalWorkosPort(c.env);
  if (sealed && port) {
    try {
      location = await port.logoutUrl(sealed, `${new URL(c.req.url).origin}/`);
    } catch {
      // A WorkOS that cannot produce a logout URL must not keep someone signed
      // in here: the cookie goes either way.
      location = '/';
    }
  }
  if (sealed && port) {
    // Mark the session revoked so a step-up check cannot be satisfied by a
    // session the person has signed out of. Best effort: the cookie is what
    // actually signs the browser out, and a database that is down must not
    // leave someone unable to leave.
    try {
      const unsealed = await port.unseal(sealed);
      const sid = unsealed ? unverifiedClaims(unsealed.accessToken).sid : undefined;
      if (sid) {
        const client = await connect(c.env, 'app');
        try {
          await client.query('UPDATE auth_sessions SET revoked_at = now() WHERE sid = $1', [sid]);
        } finally {
          await client.end();
        }
      }
    } catch (error) {
      console.log(JSON.stringify({ at: 'auth.logout', revoked: false, error: String(error) }));
    }
  }

  const headers = new Headers({ Location: location });
  headers.append('Set-Cookie', clearedSessionCookie(c.env));
  headers.append('Set-Cookie', `${CSRF_COOKIE}=; Path=/; Max-Age=0; SameSite=Strict`);
  return new Response(null, { status: 302, headers });
}

/**
 * GET /auth/session[?ws=<workspace id>]
 *
 * Three things in one round trip, because the client needs all three on the
 * same clock: a re-sealed cookie (attached by the middleware in `index.ts`),
 * both stream heads — so a client behind the head replays over HTTP rather than
 * waiting for an event that already happened — and a hub ticket, because a
 * WebSocket cannot refresh a cookie and so cannot renew its own authorisation.
 *
 * Without `?ws` the route answers for the caller's own workspace. A person
 * belongs to one in the pilot; if they belong to several, the most recently
 * joined is the one the shell opens, and the client asks again by id when the
 * person switches.
 */
export async function authSession(c: Context<{ Bindings: Env }>): Promise<Response> {
  const session = await getSession(c);
  const requested = c.req.query('ws') ?? null;

  const client = await connect(c.env, 'app');
  let user: { id: string; email: string; name: string | null };
  let workspaceId: string | null;
  try {
    const { rows } = await client.query<{ id: string; email: string; name: string | null }>(
      `SELECT id, email, name FROM users WHERE id = $1`,
      [session.userId],
    );
    const row = rows[0];
    if (!row) throw new AuthError('the session names a user that no longer exists', 'unknown_user');
    user = row;

    if (requested) {
      workspaceId = requested;
    } else {
      // `members` is a tenant table, so "which workspaces am I in?" cannot be
      // asked without a tenant key. The platform-side directory answers it, one
      // workspace at a time, under each workspace's own key.
      const directory = await client.query<{ workspace_id: string }>(
        `SELECT workspace_id FROM workspace_directory ORDER BY created_at DESC LIMIT 200`,
      );
      workspaceId = null;
      for (const candidate of directory.rows) {
        const found = await memberOf(c.env, candidate.workspace_id, session.userId);
        if (found) {
          workspaceId = candidate.workspace_id;
          break;
        }
      }
    }
  } finally {
    await client.end();
  }

  if (!workspaceId) {
    throw new RouteError('this account belongs to no workspace yet', 'no_workspace', 404);
  }

  const details = await withTenantTransaction(
    c.env,
    'app',
    { workspaceId, userId: session.userId },
    async (tx) => {
      const member = await tx.query<{ role: string }>(
        `SELECT role FROM members WHERE workspace_id = $1 AND user_id = $2 AND status = 'active'`,
        [workspaceId, session.userId],
      );
      const workspace = await tx.query<{ name: string }>(`SELECT name FROM workspaces WHERE id = $1`, [
        workspaceId,
      ]);
      const head = await tx.query<{ session_head: string; workspace_head: string }>(
        `SELECT COALESCE(max(id) FILTER (WHERE session_id IS NOT NULL), 0)::text AS session_head,
                COALESCE(max(id) FILTER (WHERE session_id IS NULL), 0)::text     AS workspace_head
           FROM stream_events WHERE workspace_id = $1`,
        [workspaceId],
      );
      return {
        role: member.rows[0]?.role ?? 'member',
        name: workspace.rows[0]?.name ?? '',
        heads: head.rows[0] ?? { session_head: '0', workspace_head: '0' },
      };
    },
  );

  const ticket = await mintHubTicket(c.env, { userId: session.userId, workspaceId });
  const body = authSessionSchema.parse({
    user: { id: user.id, name: user.name ?? user.email, email: user.email, role: details.role },
    workspace: { id: workspaceId, name: details.name },
    stream_heads: { workspace: details.heads.workspace_head, session: details.heads.session_head },
    hub_ticket: ticket.ticket,
    expires_at: ticket.expiresAt.toISOString(),
    authenticated_at: session.authenticatedAt.toISOString(),
  });

  const response = c.json(body);
  const refreshed = takeRefreshedCookie(c.req.raw);
  if (refreshed) response.headers.append('Set-Cookie', refreshed);
  return response;
}

/** Membership, asked under the workspace's own key. Null when not a member. */
async function memberOf(env: Env, workspaceId: string, userId: string): Promise<boolean> {
  try {
    return await withTenantTransaction(env, 'app', { workspaceId, userId }, async () => true);
  } catch {
    return false;
  }
}
