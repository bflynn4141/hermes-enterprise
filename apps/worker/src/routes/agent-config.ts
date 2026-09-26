// The three Agent-tab surfaces the client reads and writes: skills,
// instructions, and context fields.
//
//   GET    /w/:ws/skills                    skill_versions, with adoption
//   POST   /w/:ws/skills                    adopt one (body: { id })
//   POST   /w/:ws/skills/:id/adopt          the same, the way the client spells it
//   GET    /w/:ws/instructions              instruction_versions, newest first
//   POST   /w/:ws/instructions/:id/accept   proposed -> saved (Admin, X-Requested-From: skills)
//   POST   /w/:ws/instructions/:id/save     the same, the way the client spells it
//   POST   /w/:ws/instructions/:id/discard  proposed -> discarded (Admin)
//   DELETE /w/:ws/instructions/:id          the same
//   GET    /w/:ws/context-fields            agent_context_fields
//   PATCH  /w/:ws/context-fields/:field     a human's answer
//
// Two decisions are visible in that table.
//
// Accepting an instruction version is Admin-only and discarding is not-quite:
// a proposal is the agent's, saving one changes what every future run is told
// to do, and that is the same class of change as a provider key. Discarding is
// Admin-only too, for the duller reason that a Member silently dropping a
// proposal an Admin has not read is a change nobody can see afterwards.
//
// The context PATCH is the human half of `ask_for_context`. It writes the same
// row `POST .../runs/:runId/context` writes and then wakes the same Workflow,
// because a person answering the agent's question from the Context tab and a
// person answering it from the composer are answering the same question. See
// decision F8.
import type { Context } from 'hono';
import { contextFieldSchema, instructionVersionSchema, paginatedSchema, skillVersionSchema, saveAgentInstructionSchema } from '@hermes/shared';
import type { Env } from '../env.js';
import { requireCsrf, requireOrigin } from '../auth.js';
import { CONTEXT_ANSWERED_EVENT } from '../engine/constants.js';
import { inWorkspace, jsonBody, pathUuid, type TenantWork } from './tenant.js';
import { RouteError } from './errors.js';
import { requireRequestedFrom, SKILLS_SURFACE } from '../domain/guards.js';
import { runtimeSkillCard } from '../runtime/skills.js';
import { listEnterpriseSkillAssignments } from '../enterprise-skills/service.js';
import { requireAgentConfigAccess } from '../domain/agent-config-access.js';

const skillPage = paginatedSchema(skillVersionSchema);
const instructionPage = paginatedSchema(instructionVersionSchema);
const contextPage = paginatedSchema(contextFieldSchema);
const LIST_LIMIT = 100;

/** Resolve the caller's own/principal agent first. Workspace-scoped legacy
 * agents remain a compatibility fallback; a private agent owned by somebody
 * else is never selected merely because it was created first. */
async function agentId(work: TenantWork): Promise<string> {
  const { rows } = await work.tx.query<{ id: string }>(
    `SELECT a.id FROM agents a
      WHERE a.workspace_id = $1
      ORDER BY
        CASE
          WHEN EXISTS (
            SELECT 1 FROM agent_owners ao JOIN members m
              ON m.workspace_id=ao.workspace_id AND m.id=ao.member_id
             WHERE ao.workspace_id=$1 AND ao.agent_id=a.id
               AND m.user_id=$2 AND m.status='active'
          ) THEN 0
          WHEN EXISTS (
            SELECT 1 FROM enterprise_team_agents eta
             WHERE eta.workspace_id=$1 AND eta.agent_id=a.id AND eta.principal_user_id=$2
          ) THEN 1
          WHEN EXISTS (
            SELECT 1 FROM sessions s
             WHERE s.workspace_id=$1 AND s.agent_id=a.id AND s.owner_id=$2
          ) THEN 2
          WHEN a.context_scope='workspace' THEN 3
          ELSE 4
        END,
        a.created_at
      LIMIT 1`,
    [work.workspaceId, work.userId],
  );
  const id = rows[0]?.id;
  if (!id) throw new RouteError('this workspace has no agent', 'no_agent', 409);
  return id;
}

async function selectedAgentId(c: Context<{ Bindings: Env }>, work: TenantWork): Promise<string> {
  const requested = c.req.query('agent_id')?.trim();
  if (!requested) return agentId(work);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(requested)) {
    throw new RouteError('agent_id is not a uuid', 'bad_id', 400);
  }
  return requested;
}

// ---------------------------------------------------------------------------
// Skills
// ---------------------------------------------------------------------------

interface SkillRow {
  id: string;
  skill_key: string;
  version: number;
  name: string;
  description: string | null;
  body: string | null;
  shared_by_name: string | null;
  adopted: boolean;
}

const toSkill = (row: SkillRow): unknown =>
  skillVersionSchema.parse({
    id: row.id,
    name: row.name.slice(0, 120),
    version: `v${row.version}`,
    shared_by: (row.shared_by_name ?? 'Workspace').slice(0, 120),
    description: (row.description ?? '').slice(0, 2000),
    detail: row.body ? row.body.slice(0, 2000) : null,
    adopted: row.adopted,
  });

const SKILL_SELECT = `
  SELECT sv.id, sv.skill_key, sv.version, sv.name, sv.description, sv.body,
         u.name AS shared_by_name,
         EXISTS (SELECT 1 FROM agent_skills a
                  WHERE a.skill_version_id = sv.id AND a.agent_id = $2) AS adopted
    FROM skill_versions sv
    LEFT JOIN users u ON u.id = sv.shared_by
   WHERE sv.workspace_id = $1`;

export async function listSkills(c: Context<{ Bindings: Env }>): Promise<Response> {
  const items = await inWorkspace(c, async (work) => {
    const agent = await selectedAgentId(c, work);
    await requireAgentConfigAccess(work, agent);
    const { rows } = await work.tx.query<SkillRow>(
      `${SKILL_SELECT} ORDER BY sv.name, sv.version DESC LIMIT $3`,
      [work.workspaceId, agent, LIST_LIMIT],
    );
    const stored = rows.map(toSkill);
    const assignments = await listEnterpriseSkillAssignments(
      c.env, work.tx, work.workspaceId, agent, work.role === 'admin' ? work.userId : null,
    );
    const managed = assignments.map(runtimeSkillCard);
    return [...managed, ...stored.filter((item) => {
      const named = item as { name?: unknown };
      return !managed.some((skill) => skill.name === named.name);
    })];
  });
  return c.json(skillPage.parse({ items, cursor: null, total: items.length }));
}

/** Adopting is idempotent: the primary key is (agent_id, skill_version_id). */
export async function adoptSkill(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: false });
  requireCsrf(c);
  const fromPath = c.req.param('id');
  const id = fromPath ?? (await jsonBody<{ id?: string }>(c)).id ?? '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new RouteError('a skill version id is required', 'bad_id', 400);
  }

  const entity = await inWorkspace(c, async (work) => {
    work.requireAdmin('adopting a skill');
    const agent = await selectedAgentId(c, work);
    await requireAgentConfigAccess(work, agent);
    const exists = await work.tx.query<{ id: string }>(
      `SELECT id FROM skill_versions WHERE workspace_id = $1 AND id = $2`,
      [work.workspaceId, id],
    );
    if (!exists.rows[0]) throw new RouteError('no such skill version', 'not_found', 404);
    await work.tx.query(
      `INSERT INTO agent_skills (workspace_id, agent_id, skill_version_id, adopted_by)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (agent_id, skill_version_id) DO NOTHING`,
      [work.workspaceId, agent, id, work.userId],
    );
    const { rows } = await work.tx.query<SkillRow>(`${SKILL_SELECT} AND sv.id = $3`, [
      work.workspaceId,
      agent,
      id,
    ]);
    const row = rows[0];
    if (!row) throw new RouteError('no such skill version', 'not_found', 404);
    return toSkill(row);
  });
  return c.json(entity);
}

// ---------------------------------------------------------------------------
// Instructions
// ---------------------------------------------------------------------------

interface InstructionRow {
  id: string;
  body: string;
  status: string;
  created_at: Date;
  run_id: string | null;
  proposed_by_name: string | null;
  previous: string | null;
}

/**
 * `state` is the contract's word, and it is not quite `status`.
 *
 * The newest `saved` row is what the agent is running under, so it is
 * `current`; every older saved row is `saved`; a `proposed` row is `proposed`.
 * Three words for three different things a reader does about them: nothing,
 * nothing, and decide.
 */
const toInstruction = (row: InstructionRow, currentId: string | null): unknown =>
  instructionVersionSchema.parse({
    id: row.id,
    state: row.status === 'proposed' ? 'proposed' : row.id === currentId ? 'current' : 'saved',
    text: row.body.slice(0, 8000),
    before: row.previous ? row.previous.slice(0, 8000) : null,
    provenance: (row.run_id
      ? `proposed by a run${row.proposed_by_name ? ` · ${row.proposed_by_name}` : ''}`
      : row.proposed_by_name
        ? `written by ${row.proposed_by_name}`
        : null
    )?.slice(0, 200) ?? null,
    created_at: row.created_at.toISOString(),
    version: 0,
  });

const INSTRUCTION_SELECT = `
  SELECT iv.id, iv.body, iv.status, iv.created_at, iv.run_id, u.name AS proposed_by_name,
         (SELECT prev.body FROM instruction_versions prev
           WHERE prev.workspace_id = iv.workspace_id AND prev.agent_id = iv.agent_id AND prev.status = 'saved'
             AND prev.saved_at IS NOT NULL AND prev.created_at < iv.created_at
           ORDER BY prev.saved_at DESC LIMIT 1) AS previous
    FROM instruction_versions iv
    LEFT JOIN users u ON u.id = iv.proposed_by
   WHERE iv.workspace_id = $1`;

/** The newest saved row: what the agent is actually running under. */
async function currentInstructionId(work: TenantWork, agent: string): Promise<string | null> {
  const { rows } = await work.tx.query<{ id: string }>(
    `SELECT id FROM instruction_versions
      WHERE workspace_id = $1 AND agent_id = $2 AND status = 'saved'
      ORDER BY saved_at DESC NULLS LAST, created_at DESC, id DESC LIMIT 1`,
    [work.workspaceId, agent],
  );
  return rows[0]?.id ?? null;
}

export async function listInstructions(c: Context<{ Bindings: Env }>): Promise<Response> {
  const items = await inWorkspace(c, async (work) => {
    const agent = await selectedAgentId(c, work);
    await requireAgentConfigAccess(work, agent);
    const current = await currentInstructionId(work, agent);
    const { rows } = await work.tx.query<InstructionRow>(
      `${INSTRUCTION_SELECT} AND iv.agent_id = $2 ORDER BY iv.created_at DESC LIMIT $3`,
      [work.workspaceId, agent, LIST_LIMIT],
    );
    return rows.map((row) => toInstruction(row, current));
  });
  return c.json(instructionPage.parse({ items, cursor: null, total: items.length }));
}

/** A direct human edit is a new saved version, never an in-place rewrite. */
export async function saveInstruction(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: true });
  requireRequestedFrom(c, SKILLS_SURFACE);
  requireCsrf(c);
  const parsed = saveAgentInstructionSchema.safeParse(await jsonBody<unknown>(c));
  if (!parsed.success) throw new RouteError('instructions are invalid', 'bad_body', 400);
  const entity = await inWorkspace(c, async (work) => {
    work.requireAdmin('saving agent instructions');
    const agent = await selectedAgentId(c, work);
    await requireAgentConfigAccess(work, agent);
    await work.tx.query('SELECT id FROM agents WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [work.workspaceId, agent]);
    const current = await currentInstructionId(work, agent);
    if (current !== parsed.data.expected_current_id) throw new RouteError('instructions changed; review the current version before saving', 'stale_revision', 409);
    const inserted = await work.tx.query<{ id: string }>(
      `INSERT INTO instruction_versions (workspace_id,agent_id,body,status,proposed_by,saved_at)
       VALUES ($1,$2,$3,'saved',$4,now()) RETURNING id`,
      [work.workspaceId, agent, parsed.data.text, work.userId],
    );
    const id = inserted.rows[0]!.id;
    await work.tx.query(`UPDATE agents SET instructions_active=$3 WHERE workspace_id=$1 AND id=$2`, [work.workspaceId, agent, parsed.data.text]);
    await work.tx.query(`INSERT INTO events (workspace_id,actor_type,actor_user_id,kind,agent_id) VALUES ($1,'user',$2,'instruction.saved',$3)`, [work.workspaceId, work.userId, agent]);
    const { rows } = await work.tx.query<InstructionRow>(`${INSTRUCTION_SELECT} AND iv.id=$2`, [work.workspaceId, id]);
    return toInstruction(rows[0]!, id);
  });
  return c.json(entity, 201);
}

/** `accept` and `discard` are one transaction with two verbs. */
async function decideInstruction(
  c: Context<{ Bindings: Env }>,
  verdict: 'saved' | 'discarded',
): Promise<Response> {
  requireOrigin(c, { required: true });
  // Which surface issued it. Saving a proposal is the second-highest-value
  // write in the product — it changes what every later run is told to do — and
  // it was reachable from a model-authored button until `apply_prepared_proposal`
  // left MODEL_COMMANDS (security review O3). The header is not a security
  // boundary on its own; it is the check that says the *code path* was the
  // Skills review pane, and a custom header also forces a preflight, so no form
  // post or link can reach this route at all. Discard carries it too: a Member
  // — or a stray helper — quietly dropping a proposal an Admin has not read is
  // the same class of change in the other direction.
  requireRequestedFrom(c, SKILLS_SURFACE);
  requireCsrf(c);
  const id = pathUuid(c, 'id');

  const entity = await inWorkspace(c, async (work) => {
    work.requireAdmin(verdict === 'saved' ? 'saving agent instructions' : 'discarding a proposal');
    const agent = await selectedAgentId(c, work);
    await requireAgentConfigAccess(work, agent);
    await work.tx.query('SELECT id FROM agents WHERE workspace_id=$1 AND id=$2 FOR UPDATE', [work.workspaceId, agent]);
    const existing = await work.tx.query<{ status: string }>(
      `SELECT status FROM instruction_versions WHERE workspace_id = $1 AND id = $2 AND agent_id = $3`,
      [work.workspaceId, id, agent],
    );
    const status = existing.rows[0]?.status;
    if (!status) throw new RouteError('no such instruction version', 'not_found', 404);
    if (status !== 'proposed') {
      // Not an error the client has to recover from — the row is already in a
      // final state — but not a silent success either: a second click must not
      // read as having moved something.
      throw new RouteError(`this version is already ${status}`, `already_${status}`, 409);
    }

    await work.tx.query(
      `UPDATE instruction_versions
          SET status = $3,
              saved_at = CASE WHEN $3 = 'saved' THEN now() ELSE saved_at END,
              proposed_by = COALESCE(proposed_by, $4)
        WHERE workspace_id = $1 AND id = $2`,
      [work.workspaceId, id, verdict, work.userId],
    );
    // Only the save is an audit event. `events.kind` is a CHECK-constrained
    // enum and there is no `instruction.discarded` in it: a discard leaves the
    // row itself saying `discarded`, which is the record, and inventing a kind
    // here would mean a migration for an event nothing reads.
    if (verdict === 'saved') {
      await work.tx.query(`UPDATE agents SET instructions_active=(SELECT body FROM instruction_versions WHERE id=$3 AND workspace_id=$1 AND agent_id=$2) WHERE workspace_id=$1 AND id=$2`, [work.workspaceId, agent, id]);
      await work.tx.query(
        `INSERT INTO events (workspace_id, actor_type, actor_user_id, kind)
         VALUES ($1, 'user', $2, 'instruction.saved')`,
        [work.workspaceId, work.userId],
      );
    }

    const current = await currentInstructionId(work, agent);
    const { rows } = await work.tx.query<InstructionRow>(`${INSTRUCTION_SELECT} AND iv.id = $2`, [
      work.workspaceId,
      id,
    ]);
    const row = rows[0];
    if (!row) throw new RouteError('no such instruction version', 'not_found', 404);
    return toInstruction(row, current);
  });
  return c.json(entity);
}

export const acceptInstruction = (c: Context<{ Bindings: Env }>): Promise<Response> =>
  decideInstruction(c, 'saved');
export const discardInstruction = (c: Context<{ Bindings: Env }>): Promise<Response> =>
  decideInstruction(c, 'discarded');

// ---------------------------------------------------------------------------
// Context fields
// ---------------------------------------------------------------------------

interface ContextRow {
  id: string;
  key: string;
  value: string | null;
  scope: string;
  updated_at: Date;
}

/** The key is the label; there is no separate display name in the table. */
const toContextField = (row: ContextRow): unknown =>
  contextFieldSchema.parse({
    id: row.key.slice(0, 64),
    field: row.key.slice(0, 64),
    label: row.key.replace(/[_-]+/g, ' ').slice(0, 120),
    value: row.value ? row.value.slice(0, 400) : null,
    scope: row.scope === 'future' ? 'future' : 'reply',
    version: 0,
  });

export async function listContextFields(c: Context<{ Bindings: Env }>): Promise<Response> {
  const items = await inWorkspace(c, async (work) => {
    const agent = await selectedAgentId(c, work);
    await requireAgentConfigAccess(work, agent);
    const { rows } = await work.tx.query<ContextRow>(
      `SELECT id, key, value, scope, updated_at FROM agent_context_fields
        WHERE workspace_id = $1 AND agent_id = $2 ORDER BY key LIMIT $3`,
      [work.workspaceId, agent, LIST_LIMIT],
    );
    return rows.map(toContextField);
  });
  return c.json(contextPage.parse({ items, cursor: null, total: items.length }));
}

/**
 * A human's answer, from the Context tab.
 *
 * The write and the wake-up are deliberately not one step: the row commits
 * inside the tenant transaction, and only then is the Workflow told. A run
 * woken before the commit would read the old value, which is the one failure
 * this ordering exists to prevent — the same ordering
 * `POST .../runs/:runId/context` uses.
 */
export async function patchContextField(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: false });
  requireCsrf(c);
  const field = (c.req.param('field') ?? '').trim().slice(0, 64);
  if (!field) throw new RouteError('a field key is required', 'bad_key', 400);
  const input = await jsonBody<{ value?: string | null; scope?: string }>(c);
  const value = input.value === null ? null : String(input.value ?? '').slice(0, 2000);
  const scope = input.scope === 'future' ? 'future' : 'reply';

  const outcome = await inWorkspace(c, async (work) => {
    const agent = await selectedAgentId(c, work);
    await requireAgentConfigAccess(work, agent);
    const { rows } = await work.tx.query<ContextRow>(
      `INSERT INTO agent_context_fields (workspace_id, agent_id, key, value, scope, set_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (agent_id, key)
       DO UPDATE SET value = EXCLUDED.value, scope = EXCLUDED.scope, set_by = EXCLUDED.set_by, updated_at = now()
       RETURNING id, key, value, scope, updated_at`,
      [work.workspaceId, agent, field, value, scope, work.userId],
    );
    const row = rows[0];
    if (!row) throw new RouteError('the context field did not write', 'write_failed', 409);
    await work.tx.query(
      `INSERT INTO events (workspace_id, actor_type, actor_user_id, kind) VALUES ($1, 'user', $2, 'context.set')`,
      [work.workspaceId, work.userId],
    );

    // Any run parked on exactly this key. There is at most one live run per
    // session, but several sessions can be waiting on the same answer.
    const waiting = await work.tx.query<{ id: string; workflow_instance_id: string | null }>(
      `SELECT id, workflow_instance_id FROM runs
        WHERE workspace_id = $1 AND status = 'waiting' AND waiting_for = $2 AND agent_id = $3`,
      [work.workspaceId, field, agent],
    );
    return { entity: toContextField(row), waiting: waiting.rows };
  });

  for (const run of outcome.waiting) {
    if (!run.workflow_instance_id) continue;
    try {
      const instance = await c.env.RUN_ATTEMPT.get(run.workflow_instance_id);
      await instance.sendEvent({ type: CONTEXT_ANSWERED_EVENT, payload: { run_id: run.id, key: field } });
    } catch (error) {
      // The answer is committed either way, and the engine's wait has its own
      // timeout: a lost wake-up costs latency, never the answer.
      console.log(JSON.stringify({ at: 'context.wake', run_id: run.id, ok: false, error: String(error) }));
    }
  }
  return c.json(outcome.entity);
}
