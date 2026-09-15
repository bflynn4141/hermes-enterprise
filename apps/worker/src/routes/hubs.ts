// The two WebSocket upgrade routes.
//
// Everything expensive happens here, before the socket exists: the cookie is
// unsealed, the `Origin` is checked, the membership is read under row-level
// security, and — for a session socket — ownership or an unrevoked share is
// confirmed. What crosses into the Durable Object is the *result*: a small
// attachment saying who this is, which workspace, which session, and until
// when. The hub never repeats any of this and never could, because it has no
// database connection.
//
// The `Origin` check is the one that is easy to skip and expensive to skip.
// Cross-site WebSocket hijacking is the CSRF of sockets: a page on another
// origin can open a WebSocket to us and the browser will attach the cookie,
// because sockets are not subject to the same-origin policy the way `fetch` is.
// SameSite=Strict covers the ordinary case; the explicit check covers the rest,
// and a test opens a socket with a foreign `Origin` and asserts a 403.
import type { Context } from 'hono';
import type { Env } from '../env.js';
import { requireOrigin } from '../auth.js';
import { TICKET_TTL_SECONDS } from '../auth/tickets.js';
import { ATTACHMENT_HEADER, type SocketAttachment } from '../hubs.js';
import { inWorkspace, pathUuid, RouteError } from './tenant.js';

function upgradeRequest(request: Request, attachment: SocketAttachment): Request {
  const headers = new Headers(request.headers);
  headers.set(ATTACHMENT_HEADER, JSON.stringify(attachment));
  // A Durable Object's `fetch` needs a URL; the object is already chosen by id,
  // so the path is only there to be readable in a trace.
  return new Request('https://hub.hermes.internal/socket', { headers, method: 'GET' });
}

function requireUpgrade(c: Context<{ Bindings: Env }>): void {
  if (c.req.header('upgrade')?.toLowerCase() !== 'websocket') {
    throw new RouteError('this route is a WebSocket upgrade', 'expected_websocket', 400);
  }
}

/** GET /w/:ws/hub/workspace */
export async function workspaceSocket(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireUpgrade(c);
  requireOrigin(c, { required: true });

  const attachment = await inWorkspace(c, async (work) => ({
    userId: work.userId,
    workspaceId: work.workspaceId,
    sessionId: null,
    authorizedUntil: Date.now() + TICKET_TTL_SECONDS * 1000,
  }));

  const stub = c.env.WORKSPACE_HUB.get(c.env.WORKSPACE_HUB.idFromName(attachment.workspaceId));
  return stub.fetch(upgradeRequest(c.req.raw, attachment));
}

/** GET /w/:ws/hub/session/:id */
export async function sessionSocket(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireUpgrade(c);
  requireOrigin(c, { required: true });
  const sessionId = pathUuid(c, 'id');

  const attachment = await inWorkspace(c, async (work) => {
    // The same rule the replay route applies: the owner, or the holder of an
    // unrevoked share. Membership alone is not enough to listen to someone
    // else's conversation.
    const { rows } = await work.tx.query<{ id: string }>(
      `SELECT s.id FROM sessions s
        WHERE s.workspace_id = $1 AND s.id = $3
          AND (s.owner_id = $2 OR EXISTS (
            SELECT 1 FROM session_shares sh WHERE sh.session_id = s.id AND sh.revoked_at IS NULL
          ))`,
      [work.workspaceId, work.userId, sessionId],
    );
    if (!rows[0]) throw new RouteError('no such session', 'unknown_session', 404);
    return {
      userId: work.userId,
      workspaceId: work.workspaceId,
      sessionId,
      authorizedUntil: Date.now() + TICKET_TTL_SECONDS * 1000,
    };
  });

  const stub = c.env.SESSION_HUB.get(c.env.SESSION_HUB.idFromName(sessionId));
  return stub.fetch(upgradeRequest(c.req.raw, attachment));
}
