import type { Env } from '../env.js';
import type { Tx } from '../db/client.js';
import { publishEvents } from '../jobs.js';
import {
  consumeReservedCapacity,
  capacityRoleForInvitation,
  reservedCapacityAgentId,
  type CapacityAcceptanceProof,
} from '../hermes-cloud/capacity.js';
import { PARTNER_PROGRAM_TOOLS } from '../runtime/skills.js';
import { materializeLegacyPartnerAssignment } from '../enterprise-skills/service.js';
import { PARTNER_PROGRAM_BOOTSTRAP_INSTRUCTIONS } from '../enterprise-skills/role-instructions.js';
import { PARTNER_INVOICE_REVIEW_DEFINITION, toolsForSkillVersion } from '../enterprise-skills/registry.js';
import { configureAcceptedFinanceMember } from '../partner-workflow/service.js';
import type { CapacityRoleTemplate } from '../runtime/discovery-grants.js';
import { proposeApproval } from './approvals.js';
import { enqueueRequestTriage } from '../inbox-triage/service.js';

interface JoinCoordinationInput {
  readonly env: Env;
  readonly tx: Tx;
  readonly workspaceId: string;
  readonly joiningUserId: string;
  readonly joiningMemberId: string;
  readonly invitationId: string;
  readonly capacityProof?: CapacityAcceptanceProof | null;
  readonly jobs: string[];
}

export interface JoinCoordinationResult {
  readonly agentId: string;
  readonly coordinationRequestId: string | null;
}

async function installFirstSearchPolicy(
  tx: Tx,
  workspaceId: string,
  agentId: string,
  memberId: string,
): Promise<string> {
  const key = `partner-first-search-${agentId}`;
  await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`${workspaceId}:${key}`]);
  await tx.query(
    `INSERT INTO approval_policies
       (workspace_id, key, version, approval_type, requester_agent_id, priority, mode,
        prevent_self_review, require_distinct_reviewers, max_duration_seconds, steps, active)
     VALUES ($1,$2,1,'run_plan',$3,1000000,'sequential',false,true,604800,$4::jsonb,true)
     ON CONFLICT (workspace_id, key, version) DO NOTHING`,
    [workspaceId, key, agentId, JSON.stringify([{
      id: 'member-authorization', label: 'Authorize the first capped search', order: 0,
      reviewers: [{ kind: 'member', member_id: memberId }], quorum: 1,
    }])],
  );
  return key;
}

async function createStarterItems(
  input: JoinCoordinationInput,
  agentId: string,
  sessionId: string,
): Promise<string> {
  const task = await input.tx.query<{ id: string; version: number }>(
    `INSERT INTO requests (workspace_id, kind, label, payload, status, session_id, tool_call_id)
     VALUES ($1,'task','Complete Partner Program criteria',$2::jsonb,'pending',$3,$4)
     RETURNING id, EXTRACT(EPOCH FROM updated_at)::int AS version`,
    [input.workspaceId, JSON.stringify({
      kind: 'task',
      task_type: 'partner_criteria_setup',
      description: 'Give Iris the target industries, company stages, geographies, signals, and exclusions that should shape partner research. The initial working agreement is saved during onboarding; this task is where you add real source material and sharpen it.',
      action_label: 'Work with Iris',
      agent_id: agentId,
      session_id: sessionId,
    }), sessionId, `partner-criteria:${input.invitationId}`],
  );
  const taskId = task.rows[0]?.id;
  if (!taskId) throw new Error('partner criteria starter task was not created');
  await input.tx.query(
    `INSERT INTO events (workspace_id, actor_type, kind, request_id, session_id)
     VALUES ($1,'system','request.created',$2,$3)`,
    [input.workspaceId, taskId, sessionId],
  );
  input.jobs.push(...await publishEvents(input.tx, input.workspaceId, [
    { kind: 'request.created', payload: { request_id: taskId, kind: 'task', status: 'pending', label: 'Complete Partner Program criteria', run_id: null, session_id: sessionId } },
    { kind: 'entity.updated', payload: { entity_type: 'request', entity_id: taskId, ref: { section: 'inbox', view: 'request', id: taskId }, version: null } },
  ]));
  const triageJob = await enqueueRequestTriage(
    input.tx,
    input.workspaceId,
    taskId,
    task.rows[0]?.version ?? 0,
    input.env.INBOX_TRIAGE_RUBRIC_VERSION ?? '1',
  );
  if (triageJob) input.jobs.push(triageJob);

  const policyKey = await installFirstSearchPolicy(input.tx, input.workspaceId, agentId, input.joiningMemberId);
  const approval = await proposeApproval({
    tx: input.tx,
    workspaceId: input.workspaceId,
    jobs: input.jobs,
    agentId,
    userId: input.joiningUserId,
    sessionId,
    sourceTrigger: {
      kind: 'member_agent_joined',
      invitation_id: input.invitationId,
      member_id: input.joiningMemberId,
      agent_id: agentId,
    },
  }, {
    label: 'Approve the first capped partner search',
    policy_key: policyKey,
    proposal: {
      kind: 'approval',
      approval_type: 'run_plan',
      summary: 'Allow Iris to run one filtered AgentCash People Search for the Partner Program.',
      consequence: 'Approval starts one search with a hard $0.15 ceiling. Iris may store and screen the returned professional evidence, but may not contact anyone or make a partner decision.',
      evidence: [{
        id: `invitation-${input.invitationId}`,
        kind: 'source',
        label: 'Assigned Partner Program Iris',
        ref: `invitation:${input.invitationId}`,
        note: 'The organization assigned a dedicated, AgentCash-enabled Iris to this member.',
      }],
      illustrative: false,
      details: {
        goal: 'Find evidence-backed Partner Program prospects using the saved criteria.',
        steps: [
          { id: 'search', label: 'Run one capped AgentCash People Search', agent_id: agentId, output: 'Stored professional evidence for matching prospects' },
          { id: 'screen', label: 'Screen the stored evidence', agent_id: agentId, output: 'Pending, cited applications for human review' },
        ],
        participating_agents: [{ agent_id: agentId, role: 'Partner Program research and screening' }],
        deliverables: ['Cited partner prospect briefs in Inbox'],
        schedule: 'Start once after this approval; no recurring schedule.',
        budget: {
          currency: 'USD', estimated_min_minor: 15, estimated_max_minor: 15, cap_minor: 15,
          estimated_input_tokens: 0, estimated_output_tokens: 4000, total_token_cap: 20000,
          call_cap: 1, max_output_tokens_per_call: 4000, max_parallel_calls: 1,
          model_ids: ['z-ai/glm-5.2'], metered_tools: ['agentcash_people'], retries_included: 0,
          illustrative: false,
        },
      },
    },
    // Typed run-plan details derive the participating agent server-side. The
    // joining member's review authority comes from the installed policy.
    target_agent_ids: [],
    target_member_ids: [],
    target_resource_ids: [],
    // The criteria task is useful follow-up work, not an authorization gate.
    // Making it a dependency would strand the paid-search approval because a
    // task deliberately has no generic approve/decline transition.
    dependent_request_ids: [],
    idempotency_key: `partner-first-search:${input.invitationId}`,
  });
  return approval.request_id;
}

async function createOwnedIris(input: JoinCoordinationInput, role: CapacityRoleTemplate): Promise<{
  agentId: string;
  sessionId: string;
  created: boolean;
}> {
  const owned = await input.tx.query<{ agent_id: string; session_id: string | null }>(
    `SELECT ao.agent_id,
            (SELECT s.id FROM sessions s WHERE s.workspace_id=ao.workspace_id
              AND s.agent_id=ao.agent_id AND s.owner_id=$3 ORDER BY s.created_at LIMIT 1) AS session_id
       FROM agent_owners ao
      WHERE ao.workspace_id=$1 AND ao.member_id=$2 LIMIT 1`,
    [input.workspaceId, input.joiningMemberId, input.joiningUserId],
  );
  if (owned.rows[0]) {
    const sessionId = owned.rows[0].session_id;
    if (!sessionId) throw new Error('owned Partner Program Iris has no session');
    return { agentId: owned.rows[0].agent_id, sessionId, created: false };
  }

  // Warm capacity already carries its permanent runtime identity. Reusing it
  // here makes invitation acceptance an atomic ownership assignment instead
  // of a Cloud mutation/restart that could strand the new member.
  const agentId = input.env.AGENT_RUNTIME === 'hermes'
    ? await reservedCapacityAgentId(input.tx, input.workspaceId, input.invitationId, role)
    : crypto.randomUUID();
  if (role.roleTemplateKey === 'finance-agent') {
    await input.tx.query(
      `INSERT INTO agents (id, workspace_id, name, responsibility, instructions_active, status, setup_step)
       VALUES ($1,$2,'Iris',NULL,NULL,'draft',NULL)`,
      [agentId, input.workspaceId],
    );
    await input.tx.query(
      `INSERT INTO agent_owners (workspace_id, agent_id, member_id) VALUES ($1,$2,$3)`,
      [input.workspaceId, agentId, input.joiningMemberId],
    );
    await configureAcceptedFinanceMember(
      input.tx, input.workspaceId, input.joiningUserId,
      { agentId, principalUserId: input.joiningUserId },
    );
    const financeTools = toolsForSkillVersion(
      PARTNER_INVOICE_REVIEW_DEFINITION.key,
      PARTNER_INVOICE_REVIEW_DEFINITION.version,
      PARTNER_INVOICE_REVIEW_DEFINITION.defaultCapabilityGrants,
    );
    await input.tx.query(
      `INSERT INTO agent_capabilities (workspace_id, agent_id, kind, title, scope, tool_names, position)
       VALUES ($1,$2,'can','Review governed partner invoices','Finance',$3,0)`,
      [input.workspaceId, agentId, financeTools],
    );
    if (input.env.AGENT_RUNTIME === 'hermes') {
      await consumeReservedCapacity(
        input.env, input.tx, input.workspaceId, input.invitationId, agentId, role,
        input.capacityProof ?? null,
      );
    }
    const sessionId = crypto.randomUUID();
    await input.tx.query(
      `INSERT INTO sessions
         (id, workspace_id, owner_id, agent_id, title, mode, model_id, effort, runtime, next_seq, focus_ref)
       SELECT $1,$2,$3,$4,'Finance Iris','work',default_model_id,default_effort,default_runtime,1,
              '{"section":"agents","view":"overview"}'::jsonb
         FROM workspace_settings WHERE workspace_id=$2`,
      [sessionId, input.workspaceId, input.joiningUserId, agentId],
    );
    await input.tx.query(
      `INSERT INTO messages (workspace_id, session_id, seq, role, kind, text, blocks, status)
       VALUES ($1,$2,0,'iris','welcome',$3,'[]'::jsonb,'complete')`,
      [input.workspaceId, sessionId,
       'Your organization has assigned you Finance Iris. I can review governed partner invoice handoffs and explain missing or conflicting evidence, then stop for your decision. I cannot approve, decline, pay, send, sign, or change the source records.'],
    );
    return { agentId, sessionId, created: true };
  }
  await input.tx.query(
    `INSERT INTO agents (id, workspace_id, name, responsibility, instructions_active, status, setup_step)
     VALUES ($1,$2,'Iris','Partner Program',$3,'draft','identity')`,
    [agentId, input.workspaceId, PARTNER_PROGRAM_BOOTSTRAP_INSTRUCTIONS],
  );
  await input.tx.query(
    `INSERT INTO agent_owners (workspace_id, agent_id, member_id) VALUES ($1,$2,$3)`,
    [input.workspaceId, agentId, input.joiningMemberId],
  );
  await input.tx.query(
    `INSERT INTO agent_capabilities (workspace_id, agent_id, kind, title, scope, tool_names, position)
     VALUES ($1,$2,'can','Discover and screen partners','Partner Program',$3,0)`,
    [input.workspaceId, agentId, [...PARTNER_PROGRAM_TOOLS]],
  );
  await input.tx.query(
    `INSERT INTO instruction_versions (workspace_id, agent_id, body, status, proposed_by, sources, saved_at)
     VALUES ($1,$2,$3,'saved',$4,$5::jsonb,now())`,
    [input.workspaceId, agentId, PARTNER_PROGRAM_BOOTSTRAP_INSTRUCTIONS, input.joiningUserId,
      JSON.stringify([{ kind: 'invitation_bootstrap', invitation_id: input.invitationId,
        role_template_key: 'partner-program-compatibility', role_template_version: '1.0.0' }])],
  );
  await materializeLegacyPartnerAssignment(
    input.env,
    input.tx,
    input.workspaceId,
    agentId,
    input.joiningUserId,
    // An invitation has not established this employee's Enterprise role yet.
    // Keep the compatibility skill available for onboarding, but never let a
    // newly accepted profile enter scheduled paid discovery before an Admin
    // deliberately assigns its role.
    { scheduleEnabled: false },
  );

  if (input.env.AGENT_RUNTIME === 'hermes') {
    await consumeReservedCapacity(
      input.env,
      input.tx,
      input.workspaceId,
      input.invitationId,
      agentId,
      role,
      input.capacityProof ?? null,
    );
  }

  const sessionId = crypto.randomUUID();
  await input.tx.query(
    `INSERT INTO sessions
       (id, workspace_id, owner_id, agent_id, title, mode, model_id, effort, runtime, next_seq, focus_ref)
     SELECT $1,$2,$3,$4,'Partner Program Iris','work',default_model_id,default_effort,default_runtime,1,
            '{"section":"agents","view":"setup","step":"identity"}'::jsonb
       FROM workspace_settings WHERE workspace_id=$2`,
    [sessionId, input.workspaceId, input.joiningUserId, agentId],
  );
  await input.tx.query(
    `INSERT INTO messages (workspace_id, session_id, seq, role, kind, text, blocks, status)
     VALUES ($1,$2,0,'iris','welcome',$3,'[]'::jsonb,'complete')`,
    [input.workspaceId, sessionId,
     'Your organization has assigned you Iris. Let’s configure your first Partner Program workflow. I’ll help research and screen evidence, then stop for your review before any decision, outreach, access change, signature, commitment, or payment.'],
  );
  return { agentId, sessionId, created: true };
}

/** Consume the invitation's exact pool reservation and create real starter work. */
export async function coordinateAcceptedMember(input: JoinCoordinationInput): Promise<JoinCoordinationResult> {
  const role = await capacityRoleForInvitation(
    input.tx, input.workspaceId, input.invitationId, { requireReadyOperation: true },
  );
  const iris = await createOwnedIris(input, role);
  const firstSearchRequestId = iris.created && role.roleTemplateKey === 'partnerships-agent'
    ? await createStarterItems(input, iris.agentId, iris.sessionId)
    : null;

  await input.tx.query(
    `INSERT INTO events (workspace_id, actor_type, actor_user_id, kind, member_id, invitation_id)
     VALUES ($1,'user',$2,'member.joined',$3,$4)`,
    [input.workspaceId, input.joiningUserId, input.joiningMemberId, input.invitationId],
  );
  await input.tx.query(
    `INSERT INTO events (workspace_id, actor_type, kind, member_id, invitation_id, agent_id)
     VALUES ($1,'system','agent.joined',$2,$3,$4)`,
    [input.workspaceId, input.joiningMemberId, input.invitationId, iris.agentId],
  );
  input.jobs.push(...await publishEvents(input.tx, input.workspaceId, [{
    kind: 'member.agent_joined',
    payload: {
      source: 'invitation.accepted', invitation_id: input.invitationId,
      member_id: input.joiningMemberId, agent_id: iris.agentId,
      role_template_key: role.roleTemplateKey,
      role_template_version: role.roleTemplateVersion,
      coordination_request_id: firstSearchRequestId,
    },
  }]));
  return { agentId: iris.agentId, coordinationRequestId: firstSearchRequestId };
}
