// Durable first-run setup for the agent owned by the signed-in member.
//
// The guided setup used to stop at localStorage: the UI looked complete, but
// the newly-created agent stayed `draft` forever and turn admission refused it.
// This route stores the agreed repeatable loop, installs a narrow tool surface,
// and marks the agent runnable in one tenant transaction.
import type { Context } from 'hono';
import { z } from 'zod';
import type { Env } from '../env.js';
import { requireCsrf, requireOrigin } from '../auth.js';
import { ensureAgentOwner } from '../domain/agent-ownership.js';
import { inWorkspace, jsonBody, pathUuid, RouteError } from './tenant.js';
import { resolveProvisioningRuntimeBinding } from '../runtime/config.js';
import { HermesClient } from '../runtime/client.js';
import { matchesEnterpriseReadiness, resolveEnterpriseReadinessAssignment } from '../runtime/readiness.js';

const roleId = z.literal('partner-program');
const loopId = z.literal('screen-partners');
const reviewer = z.enum(['You', 'Workspace admin', 'Admin + Finance']);
const boundaryId = z.enum(['admission', 'role-benefits', 'external-message', 'agreement-money']);

const firstRun = z.object({
  role_id: roleId,
  role_label: z.string().trim().min(1).max(120),
  loop_id: loopId,
  partner_criteria: z.string().trim().min(10).max(4000),
  reviewers: z.record(boundaryId, reviewer),
}).strict();

const patchAgentInput = z.object({
  setup_step: z.enum(['identity', 'context', 'permissions', 'ready']).nullable().optional(),
  first_run: firstRun.optional(),
}).strict().refine((value) => value.setup_step !== undefined || value.first_run !== undefined, {
  message: 'one agent setup change is required',
});

const LOOP_LABEL = 'Discover and screen partners';

const GENERAL_TOOLS = [
  'list_requests', 'get_request', 'get_approval_status', 'get_document_text',
  'propose_request', 'propose_approval', 'save_review_note',
  'set_context_field', 'propose_instruction', 'ask_for_context', 'set_focus',
] as const;

const BOUNDARY_LABELS: Readonly<Record<z.infer<typeof boundaryId>, string>> = {
  admission: 'Approve an outcome or commitment',
  'role-benefits': 'Change access, roles, or benefits',
  'external-message': 'Send an external message',
  'agreement-money': 'Sign an agreement or pay an invoice',
};

function instructions(input: z.infer<typeof firstRun>): string {
  const reviews = Object.entries(input.reviewers)
    .map(([key, owner]) => `${BOUNDARY_LABELS[key as keyof typeof BOUNDARY_LABELS]}: ${owner}`)
    .join('; ');
  return [
    `Support ${input.role_label} through the repeatable loop “${LOOP_LABEL}”.`,
    `Partner criteria: ${input.partner_criteria}`,
    'Use available workspace context and cited evidence. Name missing information instead of inventing it.',
    'Prepare reviewable work and stop before commitments, external messages, access changes, signatures, or money movement.',
    `Human review boundaries: ${reviews}.`,
  ].join(' ');
}

/** PATCH /w/:ws/agents/:agentId */
export async function patchAgent(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: false });
  requireCsrf(c);
  const agentId = pathUuid(c, 'agentId');
  const parsed = patchAgentInput.safeParse(await jsonBody<unknown>(c));
  if (!parsed.success) throw new RouteError('the agent setup change is invalid', 'bad_agent_setup', 422);

  const outcome = await inWorkspace(c, async (work) => {
    if (!await ensureAgentOwner(work.tx, work.workspaceId, work.userId, agentId)) {
      throw new RouteError('this agent is not bound to your profile', 'agent_not_bound', 403);
    }

    if (parsed.data.setup_step !== undefined && !parsed.data.first_run) {
      await work.tx.query(
        `UPDATE agents SET setup_step = $3 WHERE workspace_id = $1 AND id = $2`,
        [work.workspaceId, agentId, parsed.data.setup_step],
      );
      return { kind: 'updated' as const };
    }

    const setup = parsed.data.first_run!;
    const body = instructions(setup);
    await work.tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`agent-setup:${agentId}`]);
    const provisioning = await work.tx.query<{ status: string }>(
      `SELECT status FROM agent_provisioning WHERE workspace_id=$1 AND agent_id=$2 FOR UPDATE`,
      [work.workspaceId, agentId],
    );
    const provisioningStatus = provisioning.rows[0]?.status ?? null;
    const requiresCloud = provisioningStatus !== null && provisioningStatus !== 'ready';
    await work.tx.query(
      `UPDATE agents
          SET responsibility = $3, instructions_active = $4,
              status = CASE WHEN $5::boolean THEN 'provisioning' ELSE 'started' END,
              setup_step = NULL,
              started_at = CASE WHEN $5::boolean THEN NULL ELSE COALESCE(started_at, now()) END
        WHERE workspace_id = $1 AND id = $2`,
      [work.workspaceId, agentId, setup.role_label, body, requiresCloud],
    );
    await work.tx.query(`DELETE FROM agent_capabilities WHERE workspace_id = $1 AND agent_id = $2`, [work.workspaceId, agentId]);
    await work.tx.query(
      `INSERT INTO agent_capabilities (workspace_id, agent_id, kind, title, scope, tool_names, position)
       VALUES ($1, $2, 'can', $3, $4, $5, 0)`,
      [work.workspaceId, agentId, LOOP_LABEL, setup.role_label, [...GENERAL_TOOLS]],
    );
    const latest = await work.tx.query<{ body: string }>(
      `SELECT body FROM instruction_versions
        WHERE workspace_id = $1 AND agent_id = $2 AND status = 'saved'
        ORDER BY created_at DESC LIMIT 1`,
      [work.workspaceId, agentId],
    );
    if (latest.rows[0]?.body !== body) {
      await work.tx.query(
        `INSERT INTO instruction_versions
           (workspace_id, agent_id, body, status, proposed_by, sources, saved_at)
         VALUES ($1, $2, $3, 'saved', $4, $5::jsonb, now())`,
        [work.workspaceId, agentId, body, work.userId, JSON.stringify([{ kind: 'first_run_setup', role_id: setup.role_id, loop_id: setup.loop_id }])],
      );
    }
    await work.tx.query(
      `INSERT INTO agent_context_fields (workspace_id, agent_id, key, value, scope, set_by)
       VALUES ($1,$2,'partner_criteria',$3,'future',$4)
       ON CONFLICT (agent_id, key) DO UPDATE
         SET value=EXCLUDED.value, scope=EXCLUDED.scope, set_by=EXCLUDED.set_by, updated_at=now()`,
      [work.workspaceId, agentId, setup.partner_criteria, work.userId],
    );
    if (requiresCloud) return { kind: 'waiting' as const };
    return { kind: 'updated' as const };
  });
  return outcome.kind === 'waiting' ? c.json({ status: 'getting_ready' }, 202) : c.body(null, 204);
}

/** GET /w/:ws/agents/:agentId/provisioning */
export async function getAgentProvisioning(c: Context<{ Bindings: Env }>): Promise<Response> {
  const agentId = pathUuid(c, 'agentId');
  const body = await inWorkspace(c, async (work) => {
    if (!await ensureAgentOwner(work.tx, work.workspaceId, work.userId, agentId) && work.role !== 'admin') {
      throw new RouteError('this agent is not bound to your profile', 'agent_not_bound', 403);
    }
    const result = await work.tx.query<{ status: string; ready_at: Date | null }>(
      `SELECT status, ready_at
         FROM agent_provisioning WHERE workspace_id=$1 AND agent_id=$2`,
      [work.workspaceId, agentId],
    );
    const row = result.rows[0];
    return row ? {
      status: row.status === 'ready' ? 'ready' : row.status === 'failed' ? 'retrying' : 'getting_ready',
      message: row.status === 'ready'
        ? 'Iris is ready.'
        : row.status === 'failed'
          ? 'Iris is taking longer than expected. Your answers are saved and setup will retry safely.'
          : 'Getting Iris ready.',
      ready_at: row.ready_at?.toISOString() ?? null,
    } : null;
  });
  return c.json({ provisioning: body });
}

/** POST /w/:ws/agents/:agentId/provisioning/verify */
export async function verifyAgentProvisioning(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: false });
  requireCsrf(c);
  const agentId = pathUuid(c, 'agentId');
  try {
    const binding = await inWorkspace(c, async (work) => {
      work.requireAdmin('Verifying a Hermes Cloud profile');
      const resolved = await resolveProvisioningRuntimeBinding(c.env, work.tx, work.workspaceId, agentId);
      const readinessAssignment = await resolveEnterpriseReadinessAssignment(work.tx, work.workspaceId, agentId);
      await work.tx.query(
        `UPDATE agent_provisioning SET status='verifying', error_code=NULL, error_detail=NULL
          WHERE workspace_id=$1 AND agent_id=$2 AND status IN ('awaiting_bootstrap','failed','verifying')`,
        [work.workspaceId, agentId],
      );
      return { ...resolved, readinessAssignment };
    });
    const client = new HermesClient(binding.baseUrl, binding.apiKey, undefined, binding.transport);
    const [capabilities, readiness] = await Promise.all([client.capabilities(), client.enterpriseReadiness()]);
    if (!capabilities.durableIdempotency || readiness.workspaceId !== binding.workspaceId || readiness.agentId !== agentId ||
        !matchesEnterpriseReadiness(readiness, binding.readinessAssignment)) {
      throw new Error('enterprise_profile_readiness_incomplete');
    }
    await inWorkspace(c, async (work) => {
      work.requireAdmin('Verifying a Hermes Cloud profile');
      await work.tx.query(
        `UPDATE agent_runtime_bindings SET ready_at=COALESCE(ready_at, now()) WHERE workspace_id=$1 AND agent_id=$2`,
        [work.workspaceId, agentId],
      );
      await work.tx.query(
        `UPDATE agent_provisioning SET status='ready', ready_at=COALESCE(ready_at, now()), error_code=NULL, error_detail=NULL
          WHERE workspace_id=$1 AND agent_id=$2`,
        [work.workspaceId, agentId],
      );
      await work.tx.query(
        `UPDATE hermes_cloud_capacity
            SET state='assigned', plugin_version=$3, readiness_checked_at=now(),
                last_health_checked_at=now(), assigned_at=COALESCE(assigned_at, now()),
                quarantined_at=NULL, quarantine_reason=NULL
          WHERE workspace_id=$1 AND assigned_agent_id=$2 AND state IN ('assigning','quarantined')`,
        [work.workspaceId, agentId, readiness.version],
      );
      await work.tx.query(
        `UPDATE agents SET status='started', started_at=COALESCE(started_at, now())
          WHERE workspace_id=$1 AND id=$2 AND setup_step IS NULL`,
        [work.workspaceId, agentId],
      );
    });
    return c.json({ status: 'ready' });
  } catch (error) {
    await inWorkspace(c, async (work) => {
      work.requireAdmin('Verifying a Hermes Cloud profile');
      const detail = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      await work.tx.query(
        `UPDATE agent_provisioning SET status='failed', error_code='profile_readiness_incomplete', error_detail=$3
          WHERE workspace_id=$1 AND agent_id=$2 AND status IN ('awaiting_bootstrap','failed','verifying')`,
        [work.workspaceId, agentId, detail],
      );
      await work.tx.query(
        `UPDATE hermes_cloud_capacity
            SET state='quarantined', quarantined_at=now(), quarantine_reason=$3, last_health_checked_at=now()
          WHERE workspace_id=$1 AND assigned_agent_id=$2 AND state IN ('assigning','quarantined')`,
        [work.workspaceId, agentId, detail],
      );
    });
    throw new RouteError('The Cloud profile has not passed its role-specific Enterprise readiness checks.', 'profile_readiness_incomplete', 409);
  }
}
