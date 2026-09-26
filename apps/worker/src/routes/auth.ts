// `/auth/*`: the four routes the browser talks to about identity.
//
//   GET /auth/login     redirect to the AuthKit hosted UI. `?step_up=1` asks
//                       for `max_age: 0`, which forces a real re-authentication
//                       and advances the token's `auth_time`.
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
// membership itself, but only when AuthKit selected an organization. A callback
// with no organization lands on the explicit workspace picker.
import type { Context } from 'hono';
import { authSessionSchema, authWorkspacesSchema, pendingInvitationSchema, type PendingInvitation } from '@hermes/shared';
import type { Env } from '../env.js';
import { isDevelopment } from '../env.js';
import { getSession } from '../auth.js';
import { AuthError } from '../auth/types.js';
import { upsertUser, takeRefreshedCookie } from '../auth/adapters.js';
import {
  SESSION_COOKIE,
  clearedCsrfCookie,
  clearedSessionCookie,
  csrfCookie,
  newCsrfToken,
  readCookie,
  sessionCookie,
} from '../auth/cookies.js';
import { mintHubTicket } from '../auth/tickets.js';
import { unverifiedClaims, verifyAccessToken } from '../auth/jwks.js';
import {
  beginAuthTransaction,
  clearedAuthTransactionCookie,
  readAuthTransaction,
} from '../auth/transactions.js';
import { optionalWorkosPort, workosPort } from '../auth/workos.js';
import { connect, withTenantTransaction, type Tx } from '../db/client.js';
import { RouteError } from './errors.js';
import { mirrorMembership } from './members.js';
import { runJobsAfterCommit, withWorkspaceTransaction } from '../jobs.js';
import { coordinateAcceptedMember } from '../domain/member-agent-coordination.js';
import {
  persistCapacityGrantDrift,
  verifyPendingInvitationCapacityForEmail,
} from '../hermes-cloud/capacity.js';
import { streamEventAudiencePredicate } from '../domain/audience.js';

/**
 * Only same-origin paths may be used as a post-login destination. Anything
 * else (absolute URLs, protocol-relative `//host`, backslash tricks, `javascript:`)
 * collapses to `/`, so the login and callback routes cannot be used as an open
 * redirect (`/auth/login?return_to=https://evil.example`).
 */
export function safeReturnPath(raw: string | undefined | null): string {
  if (!raw) return '/';
  if (raw.length > 2048) return '/';
  if (!raw.startsWith('/') || raw.startsWith('//') || raw.startsWith('/\\')) return '/';
  if (/[\u0000-\u001f]/.test(raw)) return '/';
  try {
    const url = new URL(raw, 'https://placeholder.invalid');
    if (url.origin !== 'https://placeholder.invalid') return '/';
    return url.pathname + url.search + url.hash;
  } catch {
    return '/';
  }
}

const redirectUri = (c: Context<{ Bindings: Env }>): string =>
  c.env.WORKOS_REDIRECT_URI ?? `${new URL(c.req.url).origin}/auth/callback`;

/**
 * A callback can outlive its ten-minute browser transaction while the person
 * completes MFA. The authorization code must still be refused, but a browser
 * should get a useful recovery path rather than the API error envelope.
 *
 * The page is deliberately static: the failed transaction is not trusted for
 * a return path, and an automatic redirect could loop between AuthKit and an
 * expired callback. `no-referrer` also keeps the callback's code and state out
 * of the fresh sign-in request.
 */
function expiredSignInResponse(c: Context<{ Bindings: Env }>): Response {
  const headers = new Headers({
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
    'Content-Type': 'text/html; charset=UTF-8',
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff',
    'X-Hermes-Error-Reason': 'invalid_state',
  });
  headers.append('Set-Cookie', clearedAuthTransactionCookie(c.env));
  return new Response(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Sign-in expired · Hermes</title>
    <style>
      :root {
        color-scheme: dark;
        font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
        --app: #000030;
        --ink: #080416;
        --indigo: #1a135d;
        --body: #f2f2f2;
        --muted: #c6c3da;
        --action: #0000f2;
        --action-hover: #1a1aff;
        --context: #151047;
        --line: rgba(223, 223, 255, 0.18);
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        min-height: 100vh;
        min-height: 100dvh;
        display: grid;
        place-items: center;
        padding: 1rem;
        background:
          radial-gradient(circle at 82% 8%, rgba(84, 88, 172, 0.56), transparent 42%),
          linear-gradient(160deg, var(--indigo) 0%, #110734 55%, var(--ink) 100%);
        color: var(--body);
      }
      main {
        width: min(100%, 30rem);
        padding: clamp(1.75rem, 6vw, 2.5rem);
        border: 1px solid var(--line);
        border-radius: 0.875rem;
        background:
          linear-gradient(115deg, rgba(92, 103, 191, 0.24), rgba(45, 34, 116, 0.38) 48%, rgba(17, 10, 52, 0.72)),
          var(--context);
        box-shadow: 0 1.5rem 4rem rgba(0, 0, 25, 0.35);
      }
      .brand { display: flex; align-items: center; gap: 0.75rem; color: var(--body); font-size: 1.05rem; font-weight: 500; }
      .brand svg { width: 2.5rem; height: 2.5rem; flex: 0 0 auto; filter: drop-shadow(0 0.5rem 1rem rgba(0, 0, 25, 0.35)); }
      h1 { margin: 1.75rem 0 0.75rem; font-size: clamp(2rem, 7vw, 2.5rem); font-weight: 500; line-height: 1.08; letter-spacing: -0.025em; }
      p { margin: 0; color: var(--muted); font-size: 1rem; line-height: 1.6; }
      a { display: inline-flex; margin-top: 1.75rem; min-height: 2.75rem; align-items: center; justify-content: center; padding: 0.7rem 1.125rem; border-radius: 0.5rem; background: var(--action); color: var(--body); font-size: 0.875rem; font-weight: 500; text-decoration: none; transition: background-color 120ms ease-out; }
      a:hover { background: var(--action-hover); }
      a:focus-visible { outline: 2px solid #c6c6ff; outline-offset: 3px; }
      @media (max-width: 30rem) {
        main { padding: 1.5rem; }
        a { width: 100%; }
      }
    </style>
  </head>
  <body>
    <main>
      <div class="brand">
        <svg viewBox="0 0 64 64" aria-hidden="true">
          <defs><linearGradient id="iris" x1="10" y1="7" x2="49" y2="60" gradientUnits="userSpaceOnUse"><stop stop-color="#fff"/><stop offset=".45" stop-color="#e9e6f6"/><stop offset=".72" stop-color="#bdb7d8"/><stop offset="1" stop-color="#716b96"/></linearGradient></defs>
          <path d="M32 9c6 0 10 8 6 15 7-4 15 0 15 7s-8 11-15 7c4 7 0 15-7 15s-11-8-7-15c-7 4-15 0-15-7s8-11 15-7c-4-7 0-15 8-15Z" fill="url(#iris)"/>
          <path d="M32 10c4 0 8 5 7 11l-7 9-7-7c-3-6 0-13 7-13Z" fill="#fff" opacity=".72"/><circle cx="31" cy="31" r="6" fill="#26214c"/><circle cx="31" cy="30" r="5" fill="#181333"/>
        </svg>
        <span>Hermes</span>
      </div>
      <h1>Your sign-in expired</h1>
      <p>This sign-in attempt took too long or is no longer valid. Start a fresh sign-in to continue.</p>
      <a href="/auth/login">Start a new sign-in</a>
    </main>
  </body>
</html>`, { status: 400, headers });
}

/**
 * The development step-up.
 *
 * In `AUTH_MODE=fake` there is no AuthKit to send anyone to, and
 * `auth_sessions.authenticated_at` is written once on the INSERT for
 * `sid = dev-<user id>` and never moved — so five minutes after a dev
 * workspace is first opened, every decision and every provider-key route
 * answers `reauth_required` for ever (decision C24). `?step_up=1` re-stamps
 * the row instead, which is exactly what `/auth/callback` does in the real
 * flow, and then sends the browser back where it came from.
 *
 * Dev-only twice over: the branch is behind `AUTH_MODE === 'fake'`, which is
 * refused outside development by `authAdapter`, and behind a second check that
 * `ENVIRONMENT` is a development one. The five-minute rule is untouched — this
 * moves the clock the rule reads, it does not widen the window. See decision F4.
 */
async function fakeStepUp(c: Context<{ Bindings: Env }>): Promise<Response> {
  if (!isDevelopment(c.env)) {
    throw new RouteError('the development step-up is not available here', 'not_configured', 503);
  }
  // The same adapter every route uses, so a missing or unknown `x-dev-user` is
  // a 401 here exactly as it is everywhere else.
  const session = await getSession(c);
  const client = await connect(c.env, 'app');
  try {
    await client.query(
      `UPDATE auth_sessions SET authenticated_at = now(), last_seen_at = now(), revoked_at = NULL
        WHERE sid = $1 AND user_id = $2`,
      [session.sid, session.userId],
    );
  } finally {
    await client.end();
  }
  return c.redirect(safeReturnPath(c.req.query('return_to')), 302);
}

/** GET /auth/login */
export async function login(c: Context<{ Bindings: Env }>): Promise<Response> {
  const stepUp = c.req.query('step_up') === '1';
  if (stepUp && c.env.AUTH_MODE === 'fake') return fakeStepUp(c);
  const port = workosPort(c.env);
  const returnTo = safeReturnPath(c.req.query('return_to'));
  const invitationToken = c.req.query('invitation_token');
  if (invitationToken && invitationToken.length > 200) {
    throw new RouteError('the invitation token is too long', 'bad_token', 400);
  }
  const transaction = await beginAuthTransaction(c.env, {
    returnTo,
    ...(invitationToken ? { invitationToken } : {}),
  });
  const url = port.authorizationUrl({
    redirectUri: redirectUri(c),
    state: transaction.state,
    // `max_age: 0` is documented as forcing the user to re-authenticate. WorkOS
    // keeps the same session id and advances `auth_time`; the callback records
    // that claim, which is what the step-up check compares.
    ...(stepUp ? { maxAge: 0 } : {}),
    ...(invitationToken ? { invitationToken } : {}),
    screenHint: 'sign-in',
  });
  const headers = new Headers({ Location: url });
  headers.append('Set-Cookie', transaction.cookie);
  return new Response(null, { status: 302, headers });
}

/** GET /auth/callback */
export async function callback(c: Context<{ Bindings: Env }>): Promise<Response> {
  const transaction = await readAuthTransaction(c, c.req.query('state'));
  if (!transaction) return expiredSignInResponse(c);
  const code = c.req.query('code');
  if (!code) throw new RouteError('the callback needs a code', 'no_code', 400);
  const port = workosPort(c.env);

  const authentication = await port.authenticateWithCode({
    code,
    ...(transaction.invitationToken ? { invitationToken: transaction.invitationToken } : {}),
  });
  const claims = await verifyAccessToken(c.env, authentication.accessToken);
  if (claims.sub !== authentication.user.id) {
    throw new AuthError('the access token belongs to a different user', 'invalid_session');
  }
  if ((authentication.organizationId ?? null) !== (claims.org_id ?? null)) {
    throw new AuthError('the access token names a different organization', 'invalid_session');
  }

  // No selected organization means exactly that. Choosing the first membership
  // here made WorkOS's pagination/order decide which tenant a multi-workspace
  // person opened. The root route already exposes an explicit workspace picker,
  // so the callback mirrors only the organization AuthKit actually selected.
  const organizationId = authentication.organizationId ?? claims.org_id ?? null;
  const selectedMembership = organizationId
    ? (
        await port.listOrganizationMemberships({
          userId: authentication.user.id,
          organizationId,
        })
      ).find(
        (membership) =>
          membership.userId === authentication.user.id &&
          membership.organizationId === organizationId &&
          membership.status === 'active',
      ) ?? null
    : null;
  if (organizationId && !selectedMembership) {
    throw new AuthError('the selected organization membership is not active', 'invalid_session');
  }

  const client = await connect(c.env, 'app');
  let userId: string;
  let workspaceId: string | null = null;
  const jobs: string[] = [];
  try {
    if (organizationId) {
      const { rows } = await client.query<{ workspace_id: string }>(
        `SELECT workspace_id FROM workspace_directory WHERE workos_organization_id = $1`,
        [organizationId],
      );
      workspaceId = rows[0]?.workspace_id ?? null;
    }
    const capacityProof = workspaceId
      ? await verifyPendingInvitationCapacityForEmail(
        c.env, workspaceId, authentication.user.email,
      )
      : null;

    await client.query('BEGIN');
    userId = await upsertUser(client, authentication.user);

    // WorkOS keeps `sid` stable across reauthentication and advances
    // `auth_time`. Persist that claim rather than token `iat`, which also moves
    // during ordinary refreshes and therefore cannot prove a fresh challenge.
    await client.query(
      `INSERT INTO auth_sessions (sid, user_id, authenticated_at)
       VALUES ($1, $2, $3)
       ON CONFLICT (sid) DO UPDATE
         SET authenticated_at = EXCLUDED.authenticated_at, last_seen_at = now(), revoked_at = NULL`,
      [claims.sid, userId, new Date(claims.auth_time * 1000)],
    );

    if (workspaceId && organizationId && selectedMembership) {
      // The same mirror the poller writes, so a membership that arrives by
      // either route produces one shape of row.
      // This cannot use `withTenantTransaction`, because that helper proves the
      // caller is already a member and this is the code path that makes them
      // one. The tenant key still keeps every statement behind row-level
      // security. User, auth session, invitation acceptance and membership all
      // commit together, so a failed mirror cannot leave half of a callback.
      await client.query('SELECT set_config($1, $2, true)', ['app.workspace_id', workspaceId]);
      await client.query('SELECT set_config($1, $2, true)', ['app.user_id', userId]);
      const mirrored = await mirrorMembership(client, {
        workspaceId,
        userId,
        role: selectedMembership.role === 'admin' ? 'admin' : 'member',
        workosMembershipId: selectedMembership.id,
        status: 'active',
        email: authentication.user.email,
      });
      if (mirrored.acceptedInvitation) {
        await coordinateAcceptedMember({
          env: c.env,
          tx: client,
          workspaceId,
          joiningUserId: userId,
          joiningMemberId: mirrored.memberId,
          invitationId: mirrored.acceptedInvitation.id,
          capacityProof,
          jobs,
        });
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    await persistCapacityGrantDrift(c.env, error);
    throw error;
  } finally {
    await client.end();
  }

  if (workspaceId && jobs.length > 0) await runJobsAfterCommit(c.env, workspaceId, jobs);

  const csrf = newCsrfToken();
  const headers = new Headers({ Location: safeReturnPath(transaction.returnTo) });
  headers.append('Set-Cookie', sessionCookie(c.env, authentication.sealedSession));
  headers.append('Set-Cookie', csrfCookie(c.env, csrf));
  headers.append('Set-Cookie', clearedAuthTransactionCookie(c.env));
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
  headers.append('Set-Cookie', clearedCsrfCookie(c.env));
  headers.append('Set-Cookie', clearedAuthTransactionCookie(c.env));
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
 * belongs to one in the pilot. With no `ws`, the route always returns the
 * caller's workspace list; the client explicitly chooses one and asks again
 * by id, even when the list currently contains one entry.
 */
export async function authSession(c: Context<{ Bindings: Env }>): Promise<Response> {
  const session = await getSession(c);
  const requested = c.req.query('ws') ?? null;

  const client = await connect(c.env, 'app');
  let user: { id: string; email: string; name: string | null; email_verified: boolean };
  let workspaceId: string | null;
  try {
    const { rows } = await client.query<{ id: string; email: string; name: string | null; email_verified: boolean }>(
      `SELECT id, email, name, email_verified FROM users WHERE id = $1`,
      [session.userId],
    );
    const row = rows[0];
    if (!row) throw new AuthError('the session names a user that no longer exists', 'unknown_user');
    user = row;

    if (requested) {
      workspaceId = requested;
    } else {
      // `members` is a tenant table under forced row-level security, so "which
      // workspaces am I in?" cannot be asked without already knowing the
      // answer. It used to be approximated by walking `workspace_directory`,
      // which only the WorkOS mirror writes — so a seeded or locally created
      // workspace was invisible and the route answered 404 `no_workspace` to
      // someone who was plainly a member of one (decision F7).
      //
      // `hermes_user_workspaces` (migration 0013) answers it directly: a
      // SECURITY DEFINER function filtered by `user_id`, returning ids, names
      // and roles and nothing else.
      const mine = await client.query<{ workspace_id: string; name: string; role: string }>(
        `SELECT workspace_id, name, role FROM hermes_user_workspaces($1)`,
        [session.userId],
      );
      // Invitations addressed to this person, so the picker can offer them
      // without the emailed link. Only a *verified* address is an identity
      // (see `acceptInvitation`), so an unverified session sees none.
      const invitations = user.email_verified
        ? await pendingInvitationsFor(c.env, client, user.email, new Set(mine.rows.map((row) => row.workspace_id)))
        : [];
      if (mine.rows.length === 0 && invitations.length === 0) {
        throw new RouteError('this account belongs to no workspace yet', 'no_workspace', 404);
      }
      // No workspace was named, so there are no stream heads and no hub ticket
      // to mint: both are per-workspace, and inventing them for a workspace the
      // caller has not chosen would hand out an authorisation nobody asked for.
      // The client picks one and asks again by id.
      //
      // The picker also gets four presentation-only member previews. These are
      // selected strictly from the workspace ids `hermes_user_workspaces`
      // authorised above; no caller-supplied workspace id participates. The
      // full member record, email and reviewer authority stay on `/members`.
      const previews = await client.query<{
        workspace_id: string;
        user_id: string;
        name: string;
        avatar_url: string | null;
        member_count: number;
      }>(
        `WITH ranked AS (
           SELECT d.workspace_id, d.user_id, COALESCE(u.name, u.email) AS name, u.avatar_url,
                  row_number() OVER (
                    PARTITION BY d.workspace_id
                    ORDER BY CASE WHEN d.user_id = $2 THEN 0 ELSE 1 END, d.joined_at, d.user_id
                  ) AS member_rank,
                  (count(*) OVER (PARTITION BY d.workspace_id))::int AS member_count
             FROM member_directory d
             JOIN users u ON u.id = d.user_id AND u.deleted_at IS NULL
            WHERE d.workspace_id = ANY($1::uuid[])
         )
         SELECT workspace_id, user_id, name, avatar_url, member_count
           FROM ranked
          WHERE member_rank <= 4
          ORDER BY workspace_id, member_rank`,
        [mine.rows.map((row) => row.workspace_id), session.userId],
      );
      const previewsByWorkspace = new Map<string, typeof previews.rows>();
      for (const preview of previews.rows) {
        const current = previewsByWorkspace.get(preview.workspace_id) ?? [];
        current.push(preview);
        previewsByWorkspace.set(preview.workspace_id, current);
      }
      return c.json(
        authWorkspacesSchema.parse({
          user: { id: user.id, name: user.name ?? user.email, email: user.email },
          workspaces: mine.rows.map((row) => {
            const members = previewsByWorkspace.get(row.workspace_id) ?? [];
            return {
              id: row.workspace_id,
              name: row.name,
              role: row.role === 'admin' ? 'admin' : 'member',
              members: members.map((member) => ({
                id: member.user_id,
                name: member.name,
                avatar_url: member.avatar_url,
              })),
              member_count: members[0]?.member_count ?? 0,
            };
          }),
          invitations,
          authenticated_at: session.authenticatedAt.toISOString(),
        }),
      );
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
        `SELECT COALESCE(max(stream_row.id) FILTER (
                  WHERE stream_row.session_id IS NOT NULL
                    AND EXISTS (SELECT 1 FROM sessions owned_session
                                 WHERE owned_session.id = stream_row.session_id
                                   AND owned_session.owner_id = $2)), 0)::text AS session_head,
                COALESCE(max(stream_row.id) FILTER (
                  WHERE stream_row.session_id IS NULL
                    AND ${streamEventAudiencePredicate('stream_row', '$2')}), 0)::text AS workspace_head
           FROM stream_events stream_row WHERE stream_row.workspace_id = $1`,
        [workspaceId, session.userId],
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

/**
 * The pending invitations addressed to `email`, for the picker.
 *
 * Two steps, for the same reason `acceptInvitation` has two: the platform-side
 * directory can only say *which* invitations carry this address (by digest,
 * migration 0066), and everything worth showing — the workspace's name, the
 * role, who sent it — lives under that workspace's own row-level security. So
 * each id is read under its workspace key, and the row is matched against the
 * session's email a second time there. Workspaces the person already belongs
 * to are skipped: the membership mirror will mark those accepted, and offering
 * "Accept" for a seat they hold would be a button that does nothing.
 */
async function pendingInvitationsFor(
  env: Env,
  client: Pick<Tx, 'query'>,
  email: string,
  memberOf: ReadonlySet<string>,
): Promise<PendingInvitation[]> {
  const found = await client.query<{ invitation_id: string; workspace_id: string }>(
    `SELECT invitation_id, workspace_id FROM hermes_user_invitations($1)`,
    [email],
  );
  const invitations: PendingInvitation[] = [];
  for (const pointer of found.rows) {
    if (memberOf.has(pointer.workspace_id)) continue;
    const row = await withWorkspaceTransaction(env, pointer.workspace_id, async (tx) => {
      const { rows } = await tx.query<{
        id: string; role: string; expires_at: Date; workspace_name: string;
        invited_by: string | null; role_template_key: string | null;
      }>(
        `SELECT i.id, i.role, i.expires_at, w.name AS workspace_name,
                COALESCE(u.name, u.email) AS invited_by, op.role_template_key
           FROM invitations i
           JOIN workspaces w ON w.id = i.workspace_id
           LEFT JOIN users u ON u.id = i.invited_by AND u.deleted_at IS NULL
           LEFT JOIN member_provisioning_operations op
             ON op.workspace_id = i.workspace_id AND op.invitation_id = i.id AND op.cancellation <> 'complete'
          WHERE i.workspace_id = $1 AND i.id = $2 AND i.email = lower($3)
            AND i.status = 'pending' AND i.expires_at > now()`,
        [pointer.workspace_id, pointer.invitation_id, email],
      );
      return rows[0] ?? null;
    });
    if (!row) continue;
    invitations.push(pendingInvitationSchema.parse({
      token: row.id,
      workspace: { id: pointer.workspace_id, name: row.workspace_name },
      role: row.role === 'admin' ? 'admin' : 'member',
      role_template_key: row.role_template_key,
      invited_by: row.invited_by,
      expires_at: row.expires_at.toISOString(),
    }));
  }
  invitations.sort((a, b) => a.expires_at.localeCompare(b.expires_at));
  return invitations;
}
