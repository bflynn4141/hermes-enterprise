// The two tenant routes M1 serves: bootstrap and event replay.
//
// Both run inside one transaction with `SET LOCAL app.workspace_id` and
// `app.user_id`, derived from the URL path plus a members lookup. Neither reads
// a workspace id from a header or a query parameter, and a test forges both to
// prove it.
import type { Context } from 'hono';
import {
  bootstrapSchema,
  eventsPageSchema,
  safeParseStreamEvent,
  type Bootstrap,
  type EventsPage,
  type Ref,
  type StreamEvent,
} from '@hermes/shared';
import type { Env } from '../env.js';
import { withTenantTransaction, type Tx } from '../db/client.js';
import { allowedProviders } from '../model/allowed.js';
import { runtimeLocation } from '../runtime/config.js';
import { getSession } from '../auth.js';
import { requestAudiencePredicate, streamEventAudiencePredicate } from '../domain/audience.js';
import {
  loadVisiblePendingRequests,
} from '../domain/requests.js';
import { executableMemberSetupRoles } from '../member-provisioning/service.js';

/** The replay window. Older cursors get `resync` instead of a partial page. */
const MAX_REPLAY_PAGE = 500;

interface WorkspaceRow {
  id: string;
  name: string;
  jurisdiction: string;
  default_model_id: string;
  default_effort: string | null;
  default_runtime: string;
  daily_token_cap: string | null;
  max_concurrent_runs: number;
  flags: Record<string, unknown>;
  timezone: string;
}

interface AgentRow {
  id: string;
  name: string;
  responsibility: string | null;
  setup_step: string | null;
  provisioning_status: string | null;
}

export async function loadBootstrap(
  tx: Tx,
  workspaceId: string,
  userId: string,
  /** This deployment's providers; rows of any other are not sent (R12). */
  allowed: readonly string[],
  automatedTriggers = false,
  memberProvisioning = false,
): Promise<Bootstrap> {
  const workspace = await tx.query<WorkspaceRow>(
    `SELECT w.id, w.name, w.jurisdiction,
            COALESCE(s.default_model_id, 'deepseek-flash') AS default_model_id,
            s.default_effort,
            COALESCE(s.default_runtime, 'cloud') AS default_runtime,
            s.daily_token_cap,
            COALESCE(s.max_concurrent_runs, 3) AS max_concurrent_runs,
            COALESCE(s.flags, '{}'::jsonb) AS flags,
            COALESCE(s.timezone, 'UTC') AS timezone
       FROM workspaces w
       LEFT JOIN workspace_settings s ON s.workspace_id = w.id
      WHERE w.id = $1`,
    [workspaceId],
  );
  const ws = workspace.rows[0];
  if (!ws) throw new Error('workspace row is not visible inside its own tenant transaction');

  const viewer = await tx.query<{ role: string; reviewer_roles: string[] }>(
    `SELECT role, reviewer_roles FROM members WHERE workspace_id = $1 AND user_id = $2`,
    [workspaceId, userId],
  );
  const viewerRole = viewer.rows[0]?.role ?? 'member';
  const reviewerRoles = viewer.rows[0]?.reviewer_roles ?? [];

  const agents = await tx.query<AgentRow>(
    `SELECT a.id, a.name, a.responsibility, a.setup_step,
            CASE WHEN p.status='ready' THEN 'ready'
                 WHEN p.status='failed' THEN 'retrying'
                 WHEN p.status IS NULL THEN NULL
                 ELSE 'getting_ready' END AS provisioning_status
       FROM agents a
       LEFT JOIN agent_provisioning p ON p.workspace_id=a.workspace_id AND p.agent_id=a.id
      WHERE a.workspace_id = $1
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
            SELECT 1 FROM agent_owners ao JOIN members m ON m.id = ao.member_id
             WHERE ao.workspace_id = $1 AND ao.agent_id = a.id
               AND m.user_id = $2 AND m.status = 'active'
          ) THEN 0
          WHEN EXISTS (
            SELECT 1 FROM sessions s
             WHERE s.workspace_id = $1 AND s.agent_id = a.id AND s.owner_id = $2
          ) THEN 1
          ELSE 2
        END,
        a.created_at
      LIMIT 1`,
    [workspaceId, userId],
  );
  const agent = agents.rows[0] ?? null;

  // Counts are derived from current rows and the document view, never stored.
  // Audience filtering happens before aggregation so a private request does
  // not change another member's badges.
  const counts = await tx.query<{ grants: number; documents: number; decisions: number }>(
    `SELECT (SELECT count(*)::int FROM effects effect_row
              JOIN requests r ON r.id = effect_row.request_id
             WHERE effect_row.workspace_id = $1 AND effect_row.kind = 'access_grant'
               AND effect_row.status IN ('pending', 'assigned')
               AND ${requestAudiencePredicate('r.id', '$2')}) AS grants,
            (SELECT count(*)::int FROM v_created_documents document_view
              JOIN requests r ON r.id = document_view.request_id
             WHERE document_view.workspace_id = $1
               AND ${requestAudiencePredicate('r.id', '$2')}) AS documents,
            (SELECT count(*)::int FROM decisions decision_row
              JOIN requests r ON r.id = decision_row.request_id
             WHERE decision_row.workspace_id = $1
               AND ${requestAudiencePredicate('r.id', '$2')}) AS decisions`,
    [workspaceId, userId],
  );

  const sessions = await tx.query<{
    id: string;
    agent_id: string;
    runtime: 'local' | 'cloud';
    title: string;
    title_source: 'default' | 'turn' | 'run' | 'manual';
    mode: string;
    model_id: string;
    effort: string | null;
    pinned: boolean;
    archived: boolean;
    focus_ref: Ref | null;
    status: string;
    last_activity_at: Date | null;
  }>(
    `SELECT s.id, COALESCE(s.agent_id, $2::uuid) AS agent_id,
            s.title, s.title_source, s.mode, s.model_id, s.effort, s.runtime, s.pinned, s.archived, s.focus_ref,
            v.status, s.last_activity_at
       FROM sessions s
       JOIN v_session_status v ON v.session_id = s.id
      WHERE s.owner_id = $1 AND NOT s.archived
      ORDER BY s.pinned DESC, s.last_activity_at DESC
      LIMIT 50`,
    [userId, agent?.id ?? null],
  );

  const requests = await loadVisiblePendingRequests(tx, workspaceId, userId, viewerRole, reviewerRoles);

  // A catalog row is offered only when this workspace holds a verified key for
  // the row's provider. "Add a provider key in Settings to start" is an empty
  // state, not an error.
  const catalog = await tx.query<{
    model_id: string;
    label: string;
    provider: string;
    effort: string[] | null;
    default_effort: string | null;
    enabled: boolean;
    disabled_reason: string | null;
  }>(
    `SELECT c.model_id, c.label, c.provider,
            CASE WHEN c.effort_map IS NULL THEN NULL
                 ELSE ARRAY(SELECT jsonb_object_keys(c.effort_map)) END AS effort,
            c.default_effort,
            (c.disabled_reason IS NULL AND c.supports_tools AND EXISTS (
               SELECT 1 FROM workspace_provider_keys k
                WHERE k.workspace_id = $1 AND k.provider = c.provider
                  AND k.status IN ('verified', 'verified_scoped') AND k.revoked_at IS NULL
             )) AS enabled,
            c.disabled_reason
       FROM catalog c
      -- Not every row: a workspace with a synced OpenRouter key has hundreds,
      -- and bootstrap is the payload every page load pays for. The workspace's
      -- default plus whatever this workspace's sessions actually name is enough
      -- to render every model *label* on screen; the model menu pages the rest
      -- from GET /w/:ws/catalog when it opens (decision R8).
      --
      -- The seeded rows used to be here unconditionally. They are now behind
      -- the provider filter, which is what keeps the Settings > Agents picker
      -- and the model menu showing the same list: a DeepSeek row nobody can
      -- select is a row that makes the screen look broken (decision R12).
      WHERE c.provider = ANY($2::text[])
        AND (c.source = 'seed'
         OR c.model_id = (SELECT default_model_id FROM workspace_settings WHERE workspace_id = $1)
         OR c.model_id IN (SELECT model_id FROM sessions WHERE workspace_id = $1 AND archived = false))
      ORDER BY c.model_id`,
    [workspaceId, [...allowed]],
  );

  const heads = await tx.query<{ session_head: string; workspace_head: string }>(
    `SELECT COALESCE(max(stream_row.id) FILTER (
              WHERE stream_row.session_id IS NOT NULL
                AND EXISTS (SELECT 1 FROM sessions owned_session
                             WHERE owned_session.id = stream_row.session_id
                               AND owned_session.owner_id = $2)), 0)::text AS session_head,
            COALESCE(max(stream_row.id) FILTER (
              WHERE stream_row.session_id IS NULL
                AND ${streamEventAudiencePredicate('stream_row', '$2')}), 0)::text AS workspace_head
       FROM stream_events stream_row WHERE stream_row.workspace_id = $1`,
    [workspaceId, userId],
  );
  const head = heads.rows[0] ?? { session_head: '0', workspace_head: '0' };
  const count = counts.rows[0] ?? { grants: 0, documents: 0, decisions: 0 };
  // Bootstrap hydrates runtime-facing boolean feature flags. Other settings
  // stored in the same JSON column, such as the fetch URL allowlist, belong to
  // the Admin settings endpoint and are not part of this client contract.
  const featureFlags = Object.fromEntries(
    Object.entries(ws.flags).filter((entry): entry is [string, boolean] => typeof entry[1] === 'boolean'),
  );

  return bootstrapSchema.parse({
    workspace: {
      id: ws.id,
      name: ws.name,
      jurisdiction: ws.jurisdiction,
      settings: {
        default_model_id: ws.default_model_id,
        default_effort: ws.default_effort,
        default_runtime: ws.default_runtime,
        daily_token_cap: ws.daily_token_cap === null ? null : Number(ws.daily_token_cap),
        max_concurrent_runs: ws.max_concurrent_runs,
        timezone: ws.timezone,
        flags: viewerRole === 'admin' ? featureFlags : {},
      },
    },
    viewer: {
      user_id: userId,
      role: viewer.rows[0]?.role ?? 'member',
      reviewer_roles: viewer.rows[0]?.reviewer_roles ?? [],
    },
    agent: agent ? {
      id: agent.id,
      name: agent.name,
      email: null,
      responsibility: agent.responsibility,
      setup_step: agent.setup_step,
      provisioning_status: agent.provisioning_status,
    } : null,
    capabilities: {
      email_ingress: false,
      // Only explicitly selected, hash-bound agent sources are accepted.
      turn_attachments: true,
      automated_triggers: automatedTriggers,
      member_invitations: memberProvisioning
        ? { mode: 'setup_only', role_templates: await executableMemberSetupRoles(tx, workspaceId) }
        : { mode: 'legacy_delivery', role_templates: [] },
    },
    heads: { session: head.session_head, workspace: head.workspace_head },
    counts: {
      inbox: requests.rows.length,
      pending_grants: count.grants,
      created_documents: count.documents,
      decisions: count.decisions,
      pending_for_me: requests.pendingForMe,
      pending_for_others: requests.pendingForOthers,
    },
    // node-postgres returns a Date for timestamptz; the contract carries an
    // ISO string, because the client compares and sorts cursors as text.
    sessions: sessions.rows.map((row) => ({
      ...row,
      last_activity_at: row.last_activity_at === null ? null : row.last_activity_at.toISOString(),
    })),
    requests: requests.rows.slice(0, 100).map(({ payload: _payload, presentation_hidden_at: _hiddenAt, ...request }) => request),
    catalog: catalog.rows,
  });
}

export async function bootstrap(c: Context<{ Bindings: Env }>): Promise<Response> {
  const session = await getSession(c);
  const workspaceId = c.req.param('ws') ?? '';
  const body = await withTenantTransaction(
    c.env,
    'app',
    { workspaceId, userId: session.userId },
    (tx) => loadBootstrap(
      tx, workspaceId, session.userId, allowedProviders(c.env), c.env.AUTOMATED_TRIGGERS_ENABLED === '1',
      c.env.HERMES_MEMBER_PROVISIONING_ENABLED === '1',
    ),
  );
  return c.json({ ...body, sessions: body.sessions.map((row) => ({ ...row,
    runtime: runtimeLocation(c.env, workspaceId, row.agent_id, row.runtime ?? 'cloud'),
  })) });
}

/**
 * GET /w/:ws/events?stream=session|workspace&after=<id>
 *
 * Replay runs in the API under the caller's own authorization, not the hub's:
 * the session stream is filtered to the sessions the caller owns, which is the
 * same rule the hub applies to live delivery.
 *
 * A share is deliberately not a subscription (security review O5): it used to
 * widen this query to "an unrevoked share exists on this session", which both
 * handed the session to every member and ignored `message_cutoff_seq`, so a
 * non-owner replayed everything written after the share point. A share holder
 * now reads the capped snapshot at `GET /shared/:token` and has no stream at
 * all, which is the property the column was added for.
 */
export async function events(c: Context<{ Bindings: Env }>): Promise<Response> {
  const session = await getSession(c);
  const workspaceId = c.req.param('ws') ?? '';
  const stream = c.req.query('stream') === 'session' ? 'session' : 'workspace';
  const afterRaw = c.req.query('after') ?? '0';
  if (!/^\d{1,19}$/.test(afterRaw)) {
    return c.json({ error: 'after must be a stream id', reason: 'bad_cursor' }, 400);
  }

  const page = await withTenantTransaction(
    c.env,
    'app',
    { workspaceId, userId: session.userId },
    async (tx): Promise<EventsPage> => {
      const headRow = stream === 'session'
        ? await tx.query<{ head: string }>(
            `SELECT COALESCE(max(e.id), 0)::text AS head FROM stream_events e
              JOIN sessions s ON s.id = e.session_id
             WHERE e.workspace_id = $1 AND s.owner_id = $2`,
            [workspaceId, session.userId],
          )
        : await tx.query<{ head: string }>(
            `SELECT COALESCE(max(e.id), 0)::text AS head FROM stream_events e
             WHERE e.workspace_id = $1 AND e.session_id IS NULL
               AND ${streamEventAudiencePredicate('e', '$2')}`,
            [workspaceId, session.userId],
          );
      const head = headRow.rows[0]?.head ?? '0';

      const rows =
        stream === 'session'
          ? await tx.query(
              `SELECT e.id::text AS id, e.workspace_id, e.session_id, e.kind, e.payload,
                      e.schema_version, e.trace_id, e.created_at
                 FROM stream_events e
                 JOIN sessions s ON s.id = e.session_id
                WHERE e.workspace_id = $1
                  AND e.id > $2::bigint
                  AND s.owner_id = $3
                ORDER BY e.id
                LIMIT ${MAX_REPLAY_PAGE}`,
              [workspaceId, afterRaw, session.userId],
            )
          : await tx.query(
              `SELECT id::text AS id, workspace_id, session_id, kind, payload,
                      schema_version, trace_id, created_at
                 FROM stream_events e
                WHERE e.workspace_id = $1 AND e.session_id IS NULL AND e.id > $2::bigint
                  AND ${streamEventAudiencePredicate('e', '$3')}
                ORDER BY e.id
                LIMIT ${MAX_REPLAY_PAGE}`,
              [workspaceId, afterRaw, session.userId],
            );

      // A row that no longer parses (a migrated schema, a pruned payload) is
      // not silently dropped: the client is told to resync instead of being
      // handed a transcript with a hole in it.
      const parsed: StreamEvent[] = [];
      let resync = false;
      for (const row of rows.rows) {
        const candidate = {
          id: row.id,
          workspace_id: row.workspace_id,
          session_id: row.session_id,
          kind: row.kind,
          schema_version: row.schema_version,
          trace_id: row.trace_id ?? 'unknown',
          at: new Date(row.created_at as string).toISOString(),
          payload: row.payload,
        };
        const result = safeParseStreamEvent(candidate);
        if (result.success) parsed.push(result.data);
        else resync = true;
      }

      return eventsPageSchema.parse({ stream, after: afterRaw, head, resync, events: parsed });
    },
  );

  return c.json(page);
}
