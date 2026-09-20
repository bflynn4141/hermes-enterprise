// Sessions: the chat's unit of work, and everything attached to one.
//
// Visibility is the part worth reading carefully. A session is private to its
// owner — not to the workspace — and the only other way in is a share, which
// is a hashed token with a cutoff sequence redeemed at `GET /shared/:token`
// (`routes/shares.ts`) by whoever holds the link. Membership gets you the
// workspace stream (requests, decisions, documents); it does not get you
// someone else's conversation, and it does not get you a session somebody has
// link-shared either. Every query below therefore filters on `owner_id = $me`,
// and the socket upgrade and the replay route apply the same rule, so replay
// and live delivery cannot disagree about who may see what.
//
// The response shapes come from `@hermes/shared/entities`, which is also what
// the client parses. One schema per payload: a second one on the server would
// drift, and the drift would show up as an empty pane rather than an error.
import { resolveRuntimeBinding, runtimeLocation } from '../runtime/config.js';
import type { Context } from 'hono';
import {
  draftSchema,
  messageSchema,
  paginatedSchema,
  SHARE_AUDIENCE,
  sessionSchema,
  shareResponseSchema,
  uuidSchema,
} from '@hermes/shared';
import type { Env } from '../env.js';
import { consumeRate, LIMITS } from '../auth/rate-limit.js';
import { requireCsrf, requireOrigin } from '../auth.js';
import { requireAllowedProvider } from '../model/allowed.js';
import { loadSessionSnapshot, projectSessionMessage } from '../domain/session-snapshot.js';
import { parseExpectedSettings, requireExpectedSettings, validateSessionEffort } from '../domain/session-settings.js';
import { VISIBLE } from '../domain/session-visibility.js';
import { requireAgentContextAccess } from '../domain/agent-context-access.js';
import { inWorkspace, jsonBody, pathUuid, RouteError, type TenantWork } from './tenant.js';

const MAX_PAGE = 100;

/**
 * `owner_id = me`. The one visibility rule, and now the whole of it.
 *
 * It used to read `owner_id = me OR EXISTS (an unrevoked share on this
 * session)`, which correlated the share with neither the caller nor any
 * presented token: creating a link share silently handed the session to every
 * member of the workspace, while the person actually holding the link got
 * nothing, because no route consumed the token (security review O1). The token
 * is consumed now — `routes/shares.ts` — so this predicate no longer has to
 * stand in for it, and a share grants exactly one read-only session to exactly
 * the link holder.
 *
 * Exported because it is the *one* rule and there were already two verbatim
 * copies of it (here and `routes/turns.ts`) while a third surface —
 * `routes/traces.ts` — had no copy at all and so showed every member every
 * session's runs. A rule that has to be remembered at each new read path is a
 * rule that will be missed at the next one; importing it is how a reviewer can
 * see who obeys it by grepping for the name.
 *
 * It binds `$2` to the caller's user id and expects the sessions table aliased
 * `s`.
 */
export { VISIBLE };

const SESSION_COLUMNS = `s.id, s.owner_id, s.agent_id, s.title, s.mode, s.model_id, s.effort, s.runtime,
       s.pinned, s.archived, s.read_only, s.focus_ref, s.last_activity_at`;

async function loadSession(
  work: TenantWork,
  sessionId: string,
  lock = false,
): Promise<{ id: string; owner_id: string; read_only: boolean; model_id: string; effort: string | null }> {
  const { rows } = await work.tx.query<{ id: string; owner_id: string; read_only: boolean; model_id: string; effort: string | null }>(
    `SELECT s.id, s.owner_id, s.read_only, s.model_id, s.effort FROM sessions s
      WHERE s.workspace_id = $1 AND s.id = $3 AND ${VISIBLE} ${lock ? 'FOR UPDATE OF s' : ''}`,
    [work.workspaceId, work.userId, sessionId],
  );
  const session = rows[0];
  if (!session) throw new RouteError('no such session', 'unknown_session', 404);
  return session;
}

/**
 * The second half of the visibility rule, kept even though `VISIBLE` now makes
 * the first branch unreachable: `loadSession` returning a row the caller does
 * not own would be a bug, and a bug that silently allowed a write is worse than
 * one that answers 403.
 */
function requireOwner(work: TenantWork, session: { owner_id: string; read_only: boolean }, action: string): void {
  if (session.owner_id !== work.userId) {
    throw new RouteError(`${action} is the owner's to do`, 'not_owner', 403);
  }
  // A removed member's sessions are read-only rather than deleted: the history
  // has to keep rendering, and nothing new may be written into it.
  if (session.read_only) throw new RouteError('this session is read-only', 'read_only', 409);
}

const toSession = (row: Record<string, unknown>, env: Env, workspaceId: string): unknown => ({
  id: row.id,
  agent_id: row.agent_id,
  title: row.title,
  mode: row.mode,
  model_id: row.model_id,
  effort: row.effort ?? null,
  runtime: runtimeLocation(env, workspaceId, String(row.agent_id), row.runtime === 'local' ? 'local' : 'cloud'),
  pinned: row.pinned,
  archived: row.archived,
  focus_ref: row.focus_ref ?? null,
  status: row.status ?? 'idle',
  last_activity_at: row.last_activity_at instanceof Date ? row.last_activity_at.toISOString() : null,
});

/** GET /w/:ws/sessions?archived=1 */
export async function listSessions(c: Context<{ Bindings: Env }>): Promise<Response> {
  const archived = c.req.query('archived') === '1';
  const body = await inWorkspace(c, async (work) => {
    const { rows } = await work.tx.query(
      `SELECT ${SESSION_COLUMNS}, v.status
         FROM sessions s
         JOIN v_session_status v ON v.session_id = s.id
        WHERE s.workspace_id = $1 AND s.archived = $3 AND ${VISIBLE}
        ORDER BY s.pinned DESC, s.last_activity_at DESC
        LIMIT 200`,
      [work.workspaceId, work.userId, archived],
    );
    return paginatedSchema(sessionSchema).parse({
      items: rows.map((row) => toSession(row, c.env, work.workspaceId)),
      cursor: null,
      total: rows.length,
    });
  });
  return c.json(body);
}

/**
 * POST /w/:ws/sessions
 *
 * The workspace's defaults decide the model, the effort and the runtime. The
 * request does not get to name a model: a session is what a run is created
 * from, and a session pointing at a model the workspace holds no key for is an
 * error that would only surface when someone finally typed a message.
 */
export async function createSession(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: false });
  requireCsrf(c);
  const input: { title?: string; mode?: string; agent_id?: string } = await jsonBody<{ title?: string; mode?: string; agent_id?: string }>(c).catch(
    () => ({}),
  );
  const requestedAgent = input.agent_id === undefined ? null : uuidSchema.safeParse(input.agent_id);
  if (requestedAgent && !requestedAgent.success) {
    throw new RouteError('agent_id must be a UUID', 'bad_agent_id', 422);
  }

  const body = await inWorkspace(c, async (work) => {
    const settings = await work.tx.query<{
      default_model_id: string;
      default_effort: string | null;
      default_runtime: string;
    }>(
      `SELECT default_model_id, default_effort, default_runtime
         FROM workspace_settings WHERE workspace_id = $1`,
      [work.workspaceId],
    );
    const defaults = settings.rows[0] ?? {
      default_model_id: 'deepseek-flash',
      default_effort: null,
      default_runtime: 'cloud',
    };
    const mode = input.mode === 'ask' || input.mode === 'plan' ? input.mode : 'work';

    // A session belongs to an agent for its whole life. An omitted id resolves
    // only among agents whose private context the caller can access; it must
    // never fall back to the workspace's first unrelated private agent.
    let agentId: string | null = requestedAgent?.success ? requestedAgent.data : null;
    if (agentId) {
      try {
        await requireAgentContextAccess(work, agentId);
      } catch (error) {
        if (error instanceof RouteError && error.status === 404) {
          throw new RouteError('no such agent in this workspace', 'unknown_agent', 422);
        }
        throw error;
      }
    } else {
      const candidates = await work.tx.query<{ id: string }>(
        `SELECT a.id FROM agents a
          WHERE a.workspace_id=$1
            AND EXISTS (
              SELECT 1 FROM members viewer_member
               WHERE viewer_member.workspace_id=$1 AND viewer_member.user_id=$2
                 AND viewer_member.status='active'
            )
            AND (a.context_scope='workspace'
              OR EXISTS (SELECT 1 FROM agent_owners ao WHERE ao.workspace_id=a.workspace_id AND ao.agent_id=a.id)
              OR EXISTS (SELECT 1 FROM enterprise_team_agents ta WHERE ta.workspace_id=a.workspace_id AND ta.agent_id=a.id))
            AND NOT EXISTS (
              SELECT 1 FROM agent_owners ao JOIN members owner_member
                ON owner_member.workspace_id=ao.workspace_id AND owner_member.id=ao.member_id
               WHERE ao.workspace_id=a.workspace_id AND ao.agent_id=a.id
                 AND (owner_member.user_id<>$2 OR owner_member.status<>'active'))
            AND NOT EXISTS (
              SELECT 1 FROM enterprise_team_agents ta
               WHERE ta.workspace_id=a.workspace_id AND ta.agent_id=a.id AND ta.principal_user_id<>$2)
          ORDER BY
            CASE
              WHEN EXISTS (
                SELECT 1 FROM agent_owners ao JOIN members m
                  ON m.workspace_id=ao.workspace_id AND m.id=ao.member_id
                 WHERE ao.workspace_id=$1 AND ao.agent_id=a.id
                   AND m.user_id=$2 AND m.status='active'
              ) THEN 0
              WHEN EXISTS (
                SELECT 1 FROM enterprise_team_agents ta
                 WHERE ta.workspace_id=$1 AND ta.agent_id=a.id AND ta.principal_user_id=$2
              ) THEN 1
              WHEN a.context_scope='workspace' THEN 2
              ELSE 3
            END,
            a.created_at
          LIMIT 1`,
        [work.workspaceId, work.userId],
      );
      agentId = candidates.rows[0]?.id ?? null;
      if (!agentId) throw new RouteError('no accessible agent in this workspace', 'unknown_agent', 422);
      // Keep one canonical final check at the write boundary so predicate drift
      // can fail closed rather than creating a session on private context.
      await requireAgentContextAccess(work, agentId);
    }

    const resolvedRuntime = c.env.AGENT_RUNTIME === 'hermes'
      ? await resolveRuntimeBinding(c.env, work.tx, work.workspaceId, agentId)
      : null;

    const { rows } = await work.tx.query(
      `INSERT INTO sessions (workspace_id, owner_id, agent_id, title, mode, model_id, effort, runtime)
       VALUES ($1, $2, $3, COALESCE(NULLIF($4, ''), 'New session'), $5, $6, $7, $8)
       RETURNING id, owner_id, agent_id, title, mode, model_id, effort, runtime, pinned, archived,
                 read_only, focus_ref, last_activity_at`,
      [
        work.workspaceId,
        work.userId,
        agentId,
        (input.title ?? '').slice(0, 120),
        mode,
        defaults.default_model_id,
        defaults.default_effort,
        resolvedRuntime ? (/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(?=[:/])/.test(resolvedRuntime.baseUrl) ? 'local' : 'cloud') : defaults.default_runtime,
      ],
    );
    const row = rows[0];
    if (!row) throw new RouteError('the session was not created', 'create_failed', 409);
    return sessionSchema.parse(toSession({ ...row, status: 'idle' }, c.env, work.workspaceId));
  });
  return c.json(body, 201);
}

/** GET /w/:ws/sessions/:id */
export async function getSessionRoute(c: Context<{ Bindings: Env }>): Promise<Response> {
  const sessionId = pathUuid(c, 'id');
  const body = await inWorkspace(c, async (work) => {
    const { rows } = await work.tx.query(
      `SELECT ${SESSION_COLUMNS}, v.status
         FROM sessions s
         JOIN v_session_status v ON v.session_id = s.id
        WHERE s.workspace_id = $1 AND s.id = $3 AND ${VISIBLE}`,
      [work.workspaceId, work.userId, sessionId],
    );
    const row = rows[0];
    if (!row) throw new RouteError('no such session', 'unknown_session', 404);
    return sessionSchema.parse(toSession(row, c.env, work.workspaceId));
  });
  return c.json(body);
}

/** GET /w/:ws/sessions/:id/snapshot — history and replay share one boundary. */
export async function getSessionSnapshot(c: Context<{ Bindings: Env }>): Promise<Response> {
  const sessionId = pathUuid(c, 'id');
  c.header('Cache-Control', 'private, no-store');
  return c.json(await inWorkspace(c, (work) => loadSessionSnapshot(
    work.tx, c.env, work.workspaceId, work.userId, sessionId,
  )));
}

/** PATCH /w/:ws/sessions/:id — rename, pin, archive, mode, focus. */
export async function patchSession(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: false });
  requireCsrf(c);
  const sessionId = pathUuid(c, 'id');
  const input = await jsonBody<{
    title?: string;
    pinned?: boolean;
    archived?: boolean;
    mode?: string;
    effort?: string | null;
    model_id?: string;
    expected_settings?: unknown;
    focus_ref?: unknown;
  }>(c);
  const expectedSettings = parseExpectedSettings(input.expected_settings);

  const body = await inWorkspace(c, async (work) => {
    const session = await loadSession(work, sessionId, true);
    requireOwner(work, session, 'changing a session');
    requireExpectedSettings(session, expectedSettings);

    const sets: string[] = [];
    const values: unknown[] = [work.workspaceId, sessionId];
    const push = (column: string, value: unknown): void => {
      values.push(value);
      sets.push(`${column} = $${values.length}`);
    };
    if (typeof input.title === 'string') push('title', input.title.trim().slice(0, 120) || 'New session');
    if (typeof input.pinned === 'boolean') push('pinned', input.pinned);
    if (typeof input.archived === 'boolean') push('archived', input.archived);
    if (input.mode === 'ask' || input.mode === 'plan' || input.mode === 'work') push('mode', input.mode);
    // The model the *next* turn uses.
    //
    // This was missing, which nobody noticed because the client sends it with
    // `.catch(() => undefined)` and the turns route carries a `model_id` of its
    // own: picking a model in the composer changed the local state, answered
    // 422 `empty_patch`, and was silently correct only because the next turn
    // re-sent it. Reloading the page before sending anything put the old model
    // back. With OpenRouter that is a user-visible lie — you pick a model out
    // of three hundred, the menu shows it, and the session did not keep it.
    //
    // Validated against what this workspace may actually run, rather than
    // against the catalog's existence: a row that is disabled by policy, has no
    // tool calling, or has no verified key would be a session that cannot take
    // a turn, and the turns route would refuse it later with a worse message.
    if ('model_id' in input || 'effort' in input) {
      if ('model_id' in input && (typeof input.model_id !== 'string' || !input.model_id || input.model_id.length > 64)) {
        throw new RouteError('A valid model is required.', 'unknown_model', 422);
      }
      const modelId = input.model_id ?? session.model_id;
      const { rows: candidates } = await work.tx.query<{
        offered: boolean; enabled: boolean; provider: string; effort_map: Record<string, unknown> | null; default_effort: string | null;
      }>(
        `SELECT c.provider,c.effort_map,c.default_effort,
                (c.disabled_reason IS NULL AND c.supports_tools) AS enabled,
                EXISTS (
                   SELECT 1 FROM workspace_provider_keys k
                    WHERE k.workspace_id = $1 AND k.provider = c.provider
                      AND k.status IN ('verified', 'verified_scoped') AND k.revoked_at IS NULL
                 ) AS offered
           FROM catalog c WHERE c.model_id = $2`,
        [work.workspaceId, modelId],
      );
      const candidate = candidates[0];
      // A model the catalog does not have is a 422 in every environment: the
      // column is a foreign key, and a 23503 would surface as a 500.
      if (!candidate) throw new RouteError('the catalog does not have that model', 'unknown_model', 422);
      // A provider this deployment does not offer is its own answer, and it is
      // given even under `MODEL_SCRIPTED`: the catalog route never listed the
      // row, so a client that asked for it by id is asking for something the
      // product does not have (decision R12).
      requireAllowedProvider(c.env, candidate.provider);
      // Scripted development has no provider key at all, and refusing there
      // would make a working local stack look broken — the same exception
      // `selectors.ts` makes on the client.
      if (!candidate.enabled || (!candidate.offered && c.env.MODEL_SCRIPTED !== '1')) {
        throw new RouteError('that model is not available to this workspace', 'unknown_model', 422);
      }
      const effort = validateSessionEffort('effort' in input ? input.effort
        : modelId === session.model_id ? session.effort : candidate.default_effort, candidate.effort_map);
      push('model_id', modelId);
      push('effort', effort);
    }
    if ('focus_ref' in input) {
      values.push(input.focus_ref === null ? null : JSON.stringify(input.focus_ref));
      sets.push(`focus_ref = $${values.length}::jsonb`);
    }
    if (sets.length === 0) throw new RouteError('nothing to change', 'empty_patch', 422);

    const { rows } = await work.tx.query(
      `UPDATE sessions SET ${sets.join(', ')} WHERE workspace_id = $1 AND id = $2
       RETURNING id, owner_id, agent_id, title, mode, model_id, effort, runtime, pinned, archived,
                 read_only, focus_ref, last_activity_at`,
      values,
    );
    const row = rows[0];
    if (!row) throw new RouteError('no such session', 'unknown_session', 404);
    const status = await work.tx.query<{ status: string }>(
      `SELECT status FROM v_session_status WHERE session_id = $1`,
      [sessionId],
    );
    return sessionSchema.parse(toSession({ ...row, status: status.rows[0]?.status ?? 'idle' }, c.env, work.workspaceId));
  });
  return c.json(body);
}

/**
 * DELETE /w/:ws/sessions/:id
 *
 * Archives. Nothing in this product deletes a session row: the transcript is
 * the evidence for every request the agent proposed from it, and a deleted row
 * takes that evidence with it.
 */
export async function archiveSession(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: false });
  requireCsrf(c);
  const sessionId = pathUuid(c, 'id');
  await inWorkspace(c, async (work) => {
    const session = await loadSession(work, sessionId);
    requireOwner(work, session, 'archiving a session');
    await work.tx.query(`UPDATE sessions SET archived = true WHERE workspace_id = $1 AND id = $2`, [
      work.workspaceId,
      sessionId,
    ]);
  });
  return new Response(null, { status: 204 });
}

/**
 * GET/PUT /w/:ws/sessions/:id/draft
 *
 * The composer's unsent text, stored so that it survives a refresh, a
 * reconnect and a change of machine. Per user as well as per session: two
 * people looking at a shared session are not typing in each other's box.
 */
export async function getDraft(c: Context<{ Bindings: Env }>): Promise<Response> {
  const sessionId = pathUuid(c, 'id');
  const body = await inWorkspace(c, async (work) => {
    await loadSession(work, sessionId);
    const { rows } = await work.tx.query<{ text: string; updated_at: Date }>(
      `SELECT text, updated_at FROM session_drafts WHERE session_id = $1 AND user_id = $2`,
      [sessionId, work.userId],
    );
    const row = rows[0];
    return draftSchema.parse({
      session_id: sessionId,
      text: row?.text ?? '',
      updated_at: row ? row.updated_at.toISOString() : null,
    });
  });
  return c.json(body);
}

export async function putDraft(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: false });
  requireCsrf(c);
  const sessionId = pathUuid(c, 'id');
  const input = await jsonBody<{ text?: string }>(c);
  const text = (input.text ?? '').slice(0, 20_000);

  const body = await inWorkspace(c, async (work) => {
    await loadSession(work, sessionId);
    const { rows } = await work.tx.query<{ updated_at: Date }>(
      `INSERT INTO session_drafts (workspace_id, session_id, user_id, text)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (session_id, user_id) DO UPDATE SET text = EXCLUDED.text, updated_at = now()
       RETURNING updated_at`,
      [work.workspaceId, sessionId, work.userId, text],
    );
    return draftSchema.parse({
      session_id: sessionId,
      text,
      updated_at: rows[0] ? rows[0].updated_at.toISOString() : null,
    });
  });
  return c.json(body);
}

/**
 * GET /w/:ws/sessions/:id/messages?before=&limit=
 *
 * Backwards from the newest, because that is the direction a transcript is
 * read. Only the owner reaches this route at all: a share holder reads the
 * snapshot at `GET /shared/:token`, capped at the share's cutoff, because a
 * share is a snapshot of a conversation and not a subscription to one.
 */
export async function listMessages(c: Context<{ Bindings: Env }>): Promise<Response> {
  const sessionId = pathUuid(c, 'id');
  const beforeRaw = c.req.query('before');
  const limitRaw = Number(c.req.query('limit') ?? '50');
  const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(Math.trunc(limitRaw), 1), MAX_PAGE) : 50;
  if (beforeRaw !== undefined && beforeRaw !== '' && !/^\d{1,9}$/.test(beforeRaw)) {
    throw new RouteError('before must be a sequence number', 'bad_cursor', 400);
  }
  const before = beforeRaw === undefined || beforeRaw === '' ? null : Number(beforeRaw);

  const body = await inWorkspace(c, async (work) => {
    await loadSession(work, sessionId);

    const { rows } = await work.tx.query(
      `SELECT id, session_id, seq, role, kind, text, blocks, status, run_id, worked_ms, created_at,
              (SELECT jsonb_agg(jsonb_build_object('id',source->>'id','name',source->>'name','sha256',source->>'sha256','kind',source->>'kind'))
                 FROM runs bound, jsonb_array_elements(bound.context_snapshot->'sources') source
                WHERE bound.id=messages.run_id AND bound.workspace_id=messages.workspace_id) AS context_sources
         FROM messages
        WHERE workspace_id = $1 AND session_id = $2
          AND ($3::int IS NULL OR seq < $3::int)
        ORDER BY seq DESC
        LIMIT $4`,
      [work.workspaceId, sessionId, before, limit + 1],
    );
    const page = rows.slice(0, limit).reverse();
    return paginatedSchema(messageSchema).parse({
      items: page.map(projectSessionMessage),
      // The cursor is the oldest sequence on this page: ask for anything before
      // it to get the previous page, and null when there is nothing older.
      cursor: rows.length > limit && page[0] ? String(page[0].seq) : null,
      total: null,
    });
  });
  return c.json(body);
}

const sha256Hex = async (value: string): Promise<string> => {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

/**
 * POST /w/:ws/sessions/:id/shares
 *
 * The token is returned once and stored only as a hash, for the same reason a
 * password is: a database dump should not be a set of working links. The cutoff
 * is taken now, so a share cannot quietly grow to include messages written
 * after the person decided what they were sharing.
 */
export async function createShare(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: false });
  requireCsrf(c);
  const sessionId = pathUuid(c, 'id');
  const token = `${crypto.randomUUID()}${crypto.randomUUID()}`.replace(/-/g, '');
  const tokenHash = await sha256Hex(token);
  const origin = new URL(c.req.url).origin;

  const body = await inWorkspace(c, async (work) => {
    const session = await loadSession(work, sessionId);
    requireOwner(work, session, 'sharing a session');
    await consumeRate(work.tx, work.userId, work.workspaceId, LIMITS.share);

    const cutoff = await work.tx.query<{ seq: number }>(
      `SELECT COALESCE(max(seq), 0) AS seq FROM messages WHERE session_id = $1`,
      [sessionId],
    );
    const cutoffSeq = cutoff.rows[0]?.seq ?? 0;
    const { rows } = await work.tx.query<{ id: string; created_at: Date }>(
      `INSERT INTO session_shares (workspace_id, session_id, created_by, token_hash, audience, message_cutoff_seq)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, created_at`,
      [work.workspaceId, sessionId, work.userId, tokenHash, SHARE_AUDIENCE, cutoffSeq],
    );
    const row = rows[0];
    if (!row) throw new RouteError('the share was not created', 'create_failed', 409);

    await work.tx.query(
      `INSERT INTO events (workspace_id, actor_type, actor_user_id, kind, session_id)
       VALUES ($1, 'user', $2, 'session.shared', $3)`,
      [work.workspaceId, work.userId, sessionId],
    );

    return shareResponseSchema.parse({
      id: row.id,
      url: `${origin}/shared/${token}`,
      audience: SHARE_AUDIENCE,
      message_cutoff_seq: cutoffSeq,
      created_at: row.created_at.toISOString(),
    });
  });
  return c.json(body, 201);
}

/** DELETE /w/:ws/sessions/:id/shares/:shareId */
export async function revokeShare(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: false });
  requireCsrf(c);
  const sessionId = pathUuid(c, 'id');
  const shareId = pathUuid(c, 'shareId');

  await inWorkspace(c, async (work) => {
    const session = await loadSession(work, sessionId);
    requireOwner(work, session, 'revoking a share');
    const { rowCount } = await work.tx.query(
      `UPDATE session_shares SET revoked_at = now()
        WHERE workspace_id = $1 AND session_id = $2 AND id = $3 AND revoked_at IS NULL`,
      [work.workspaceId, sessionId, shareId],
    );
    if (rowCount === 0) throw new RouteError('no such share', 'unknown_share', 404);
    await work.tx.query(
      `INSERT INTO events (workspace_id, actor_type, actor_user_id, kind, session_id)
       VALUES ($1, 'user', $2, 'session.unshared', $3)`,
      [work.workspaceId, work.userId, sessionId],
    );
  });
  return new Response(null, { status: 204 });
}

/** PUT and DELETE /w/:ws/messages/:id/feedback */
export async function setMessageFeedback(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: false });
  requireCsrf(c);
  const messageId = pathUuid(c, 'id');
  const input = await jsonBody<{ value?: string; rating?: string }>(c);
  // The client sends 'not-helpful'; the column stores 'not_helpful'. One of the
  // two spellings has to give, and the database's is the one with a CHECK.
  const raw = input.value ?? input.rating ?? '';
  const rating = raw === 'helpful' ? 'helpful' : raw === 'not-helpful' || raw === 'not_helpful' ? 'not_helpful' : null;
  if (!rating) throw new RouteError('feedback must be helpful or not-helpful', 'bad_rating', 422);

  await inWorkspace(c, async (work) => {
    await visibleMessage(work, messageId);
    await work.tx.query(
      `INSERT INTO message_feedback (workspace_id, message_id, user_id, rating)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (message_id, user_id) DO UPDATE SET rating = EXCLUDED.rating`,
      [work.workspaceId, messageId, work.userId, rating],
    );
  });
  return new Response(null, { status: 204 });
}

export async function clearMessageFeedback(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: false });
  requireCsrf(c);
  const messageId = pathUuid(c, 'id');
  await inWorkspace(c, async (work) => {
    await visibleMessage(work, messageId);
    await work.tx.query(`DELETE FROM message_feedback WHERE message_id = $1 AND user_id = $2`, [
      messageId,
      work.userId,
    ]);
  });
  return new Response(null, { status: 204 });
}

async function visibleMessage(work: TenantWork, messageId: string): Promise<void> {
  const { rows } = await work.tx.query<{ id: string }>(
    `SELECT m.id FROM messages m JOIN sessions s ON s.id = m.session_id
      WHERE m.workspace_id = $1 AND m.id = $3 AND ${VISIBLE}`,
    [work.workspaceId, work.userId, messageId],
  );
  if (!rows[0]) throw new RouteError('no such message', 'unknown_message', 404);
}
