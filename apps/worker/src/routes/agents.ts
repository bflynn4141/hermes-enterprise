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
import { inWorkspace, jsonBody, pathUuid, RouteError } from './tenant.js';

const roleId = z.enum(['partner-program', 'customer-success', 'customer-onboarding', 'procurement', 'custom']);
const loopId = z.enum([
  'screen-partners', 'onboard-partners', 'support-partners',
  'triage-accounts', 'prepare-success-reviews',
  'onboard-customers', 'coordinate-launches',
  'review-vendors', 'prepare-renewals', 'custom-loop',
]);
const reviewer = z.enum(['You', 'Workspace admin', 'Admin + Finance']);
const boundaryId = z.enum(['admission', 'role-benefits', 'external-message', 'agreement-money']);

const firstRun = z.object({
  role_id: roleId,
  role_label: z.string().trim().min(1).max(120),
  loop_id: loopId,
  reviewers: z.record(boundaryId, reviewer),
}).strict();

const patchAgentInput = z.object({
  setup_step: z.enum(['identity', 'context', 'permissions', 'ready']).nullable().optional(),
  first_run: firstRun.optional(),
}).strict().refine((value) => value.setup_step !== undefined || value.first_run !== undefined, {
  message: 'one agent setup change is required',
});

const LOOP_LABELS: Readonly<Record<z.infer<typeof loopId>, string>> = {
  'screen-partners': 'Screen partner applications',
  'onboard-partners': 'Onboard accepted partners',
  'support-partners': 'Support active partners',
  'triage-accounts': 'Triage account risks',
  'prepare-success-reviews': 'Prepare success reviews',
  'onboard-customers': 'Prepare customer onboarding',
  'coordinate-launches': 'Coordinate customer launches',
  'review-vendors': 'Review new vendors',
  'prepare-renewals': 'Prepare vendor renewals',
  'custom-loop': 'Run the agreed repeatable loop',
};

const ROLE_LOOPS: Readonly<Record<z.infer<typeof roleId>, readonly z.infer<typeof loopId>[]>> = {
  'partner-program': ['screen-partners', 'onboard-partners', 'support-partners'],
  'customer-success': ['triage-accounts', 'prepare-success-reviews'],
  'customer-onboarding': ['onboard-customers', 'coordinate-launches'],
  procurement: ['review-vendors', 'prepare-renewals'],
  custom: ['custom-loop'],
};

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
    `Support ${input.role_label} through the repeatable loop “${LOOP_LABELS[input.loop_id]}”.`,
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

  await inWorkspace(c, async (work) => {
    const owned = await work.tx.query(
      `SELECT 1
         FROM agent_owners ao
         JOIN members m ON m.workspace_id = ao.workspace_id AND m.id = ao.member_id
        WHERE ao.workspace_id = $1 AND ao.agent_id = $2
          AND m.user_id = $3 AND m.status = 'active'`,
      [work.workspaceId, agentId, work.userId],
    );
    if (!owned.rowCount) throw new RouteError('this agent is not bound to your profile', 'agent_not_bound', 403);

    if (parsed.data.setup_step !== undefined && !parsed.data.first_run) {
      await work.tx.query(
        `UPDATE agents SET setup_step = $3 WHERE workspace_id = $1 AND id = $2`,
        [work.workspaceId, agentId, parsed.data.setup_step],
      );
      return;
    }

    const setup = parsed.data.first_run!;
    if (!ROLE_LOOPS[setup.role_id].includes(setup.loop_id)) {
      throw new RouteError('the selected loop does not belong to this role', 'bad_agent_setup', 422);
    }
    const body = instructions(setup);
    await work.tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`agent-setup:${agentId}`]);
    await work.tx.query(
      `UPDATE agents
          SET responsibility = $3, instructions_active = $4, status = 'started',
              setup_step = NULL, started_at = COALESCE(started_at, now())
        WHERE workspace_id = $1 AND id = $2`,
      [work.workspaceId, agentId, setup.role_label, body],
    );
    await work.tx.query(`DELETE FROM agent_capabilities WHERE workspace_id = $1 AND agent_id = $2`, [work.workspaceId, agentId]);
    await work.tx.query(
      `INSERT INTO agent_capabilities (workspace_id, agent_id, kind, title, scope, tool_names, position)
       VALUES ($1, $2, 'can', $3, $4, $5, 0)`,
      [work.workspaceId, agentId, LOOP_LABELS[setup.loop_id], setup.role_label, [...GENERAL_TOOLS]],
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
  });
  return c.body(null, 204);
}
