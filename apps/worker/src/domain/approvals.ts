import {
  approvalPayloadSchema,
  approvalPolicySchema,
  approvalProposalSchema,
  approvalViewSchema,
  decideApprovalInputSchema,
  proposeApprovalInputSchema,
  reviseApprovalInputSchema,
  routeApprovalInputSchema,
  type ApprovalFinalizedHook,
  type ApprovalListProjection,
  type ApprovalPayload,
  type ApprovalPolicy,
  type ApprovalProposal,
  type ApprovalResourceBinding,
  type ApprovalView,
  type DecideApprovalInput,
  type ProposeApprovalInput,
  type ReviseApprovalInput,
  type RouteApprovalInput,
} from '@hermes/shared';
import type { Tx } from '../db/client.js';
import { enqueueJob, publishEvents } from '../jobs.js';
import { queueApprovedEmail } from '../outbound-email/outbox.js';
import { RouteError } from '../routes/tenant.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NO_EXECUTOR = 'No supported executor is configured for this approved consequence.';

export interface ApprovalWork {
  readonly tx: Tx;
  readonly workspaceId: string;
  readonly jobs: string[];
}

export interface ApprovalProposerContext extends ApprovalWork {
  readonly agentId: string;
  readonly userId?: string | null;
  readonly sessionId?: string | null;
  readonly runId?: string | null;
  readonly sourceTrigger?: {
    readonly kind: 'member_agent_joined';
    readonly invitation_id: string;
    readonly member_id: string;
    readonly agent_id: string;
  } | null;
}

export interface ApprovalHumanContext extends ApprovalWork {
  readonly userId: string;
  readonly memberRole: string;
}

interface MemberRow {
  id: string;
  user_id: string;
  name: string;
  email: string;
  role: string;
  reviewer_roles: string[];
}

interface PolicyRow {
  id: string;
  key: string;
  version: number;
  approval_type: ApprovalProposal['approval_type'];
  requester_agent_id: string | null;
  target_resource_ids: string[];
  max_budget_minor: number | null;
  priority: number;
  mode: 'sequential' | 'parallel';
  prevent_self_review: boolean;
  require_distinct_reviewers: true;
  max_duration_seconds: number;
  steps: unknown;
}

interface ApprovalRow {
  request_id: string;
  workspace_id: string;
  status: ApprovalView['status'];
  authorization_revision: number;
  authorization_hash: string;
  expires_at: Date;
  requester_agent_id: string;
  requester_member_id: string | null;
  requester_user_id: string | null;
  source_session_id: string | null;
  source_run_id: string | null;
  effect_kind: ApprovalView['effect']['kind'];
  effect_status: ApprovalView['effect']['status'];
  effect_reason: string | null;
  work_status: ApprovalView['work']['status'];
  work_reason: string | null;
  continuation_id: string | null;
  finalized_at: Date | null;
  payload: unknown;
}

interface VoteRow {
  id: string;
  step_id: string;
  decision: 'approve' | 'decline' | 'request_changes';
  authorization_revision: number;
  authorization_hash: string;
  reviewer_member_id: string;
  reviewer_user_id: string;
  reviewer_name: string;
  note: string | null;
  idempotency_key: string;
  recorded_at: Date;
}

const asTime = (value: Date | string): Date => (value instanceof Date ? value : new Date(value));
const sortedUnique = (values: readonly string[]): string[] => [...new Set(values)].sort();

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(',')}}`;
}

async function sha256(value: unknown): Promise<string> {
  const bytes = new TextEncoder().encode(canonical(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

async function authorizationHash(material: unknown): Promise<string> {
  return `sha256:${await sha256(material)}`;
}

async function commandHash(operation: string, input: { idempotency_key: string } & Record<string, unknown>): Promise<string> {
  const { idempotency_key: _key, ...material } = input;
  return sha256({ operation, input: material });
}

async function idempotencyLock(tx: Tx, workspaceId: string, key: string): Promise<void> {
  await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`${workspaceId}:${key}`]);
}

async function activeMembers(tx: Tx, workspaceId: string): Promise<MemberRow[]> {
  const { rows } = await tx.query<MemberRow>(
    `SELECT m.id, m.user_id, COALESCE(u.name, u.email, 'Member') AS name, u.email, m.role, m.reviewer_roles
       FROM members m
       JOIN users u ON u.id = m.user_id
      WHERE m.workspace_id = $1 AND m.status = 'active'`,
    [workspaceId],
  );
  return rows;
}

function selectorMatches(member: MemberRow, selector: ApprovalPolicy['steps'][number]['reviewers'][number]): boolean {
  if (selector.kind === 'member') return selector.member_id === member.id;
  return selector.role === member.role || member.reviewer_roles.includes(selector.role);
}

function eligibleForStep(
  step: ApprovalPolicy['steps'][number],
  members: readonly MemberRow[],
  requesterMemberId: string | null,
  preventSelfReview: boolean,
): MemberRow[] {
  return members.filter(
    (member) =>
      (!preventSelfReview || member.id !== requesterMemberId) &&
      step.reviewers.some((selector) => selectorMatches(member, selector)),
  );
}

function memberIsRequired(
  memberId: string,
  policy: ApprovalPolicy,
  members: readonly MemberRow[],
  requesterMemberId: string | null,
): boolean {
  return policy.steps.some((step) => {
    const eligible = eligibleForStep(step, members, requesterMemberId, policy.prevent_self_review);
    const without = eligible.filter((member) => member.id !== memberId);
    return eligible.some((member) => member.id === memberId) && without.length < step.quorum;
  });
}

function canSatisfyDistinctReviewers(
  policy: ApprovalPolicy,
  members: readonly MemberRow[],
  requesterMemberId: string | null,
  excludedMemberId: string | null = null,
): boolean {
  const slots = policy.steps.flatMap((step) => {
    const eligible = eligibleForStep(step, members, requesterMemberId, policy.prevent_self_review)
      .map((member) => member.id)
      .filter((memberId) => memberId !== excludedMemberId);
    return Array.from({ length: step.quorum }, () => eligible);
  });
  const memberToSlot = new Map<string, number>();
  const assign = (slotIndex: number, seen: Set<string>): boolean => {
    for (const memberId of slots[slotIndex] ?? []) {
      if (seen.has(memberId)) continue;
      seen.add(memberId);
      const priorSlot = memberToSlot.get(memberId);
      if (priorSlot === undefined || assign(priorSlot, seen)) {
        memberToSlot.set(memberId, slotIndex);
        return true;
      }
    }
    return false;
  };
  return slots.every((_slot, slotIndex) => assign(slotIndex, new Set()));
}

function validatePolicyFeasibility(
  policy: ApprovalPolicy,
  members: readonly MemberRow[],
  requesterMemberId: string | null,
  requiredOwnerIds: readonly string[],
): void {
  for (const step of policy.steps) {
    const eligible = eligibleForStep(step, members, requesterMemberId, policy.prevent_self_review);
    if (eligible.length < step.quorum) {
      throw new RouteError(`approval policy step ${step.id} does not have enough eligible reviewers`, 'policy_unfulfillable', 422);
    }
    for (const selector of step.reviewers) {
      if (selector.kind !== 'role') continue;
      const roleCount = eligible.filter((member) => selectorMatches(member, selector)).length;
      if (roleCount < selector.minimum_distinct_members) {
        throw new RouteError(`approval role ${selector.role} does not have enough active members`, 'policy_unfulfillable', 422);
      }
    }
  }
  if (policy.require_distinct_reviewers && !canSatisfyDistinctReviewers(policy, members, requesterMemberId)) {
    throw new RouteError('approval policy does not have enough distinct eligible reviewers across its steps', 'policy_unfulfillable', 422);
  }
  for (const ownerId of requiredOwnerIds) {
    const required = policy.require_distinct_reviewers
      ? !canSatisfyDistinctReviewers(policy, members, requesterMemberId, ownerId)
      : memberIsRequired(ownerId, policy, members, requesterMemberId);
    if (!required) {
      throw new RouteError('the authoritative owner is not required by the selected policy', 'owner_review_required', 422);
    }
  }
}

function policyFromRow(row: PolicyRow): ApprovalPolicy {
  return approvalPolicySchema.parse({
    id: row.id,
    key: row.key,
    version: row.version,
    mode: row.mode,
    prevent_self_review: row.prevent_self_review,
    require_distinct_reviewers: row.require_distinct_reviewers,
    steps: row.steps,
  });
}

async function selectPolicy(
  tx: Tx,
  workspaceId: string,
  proposal: ApprovalProposal,
  requesterAgentId: string,
  targetResourceIds: readonly string[],
  requestedKey: string,
): Promise<{ row: PolicyRow; policy: ApprovalPolicy }> {
  const { rows } = await tx.query<PolicyRow>(
    `SELECT id, key, version, approval_type, requester_agent_id, target_resource_ids,
            max_budget_minor::int, priority, mode, prevent_self_review,
            require_distinct_reviewers, max_duration_seconds, steps
       FROM approval_policies
      WHERE workspace_id = $1 AND approval_type = $2 AND active
        AND (requester_agent_id IS NULL OR requester_agent_id = $3)`,
    [workspaceId, proposal.approval_type, requesterAgentId],
  );
  const requestedTargets = new Set(targetResourceIds);
  const cap = proposal.approval_type === 'run_plan' ? proposal.details.budget.cap_minor : null;
  const candidates = rows.filter((row) => {
    if (!row.target_resource_ids.every((resourceId) => requestedTargets.has(resourceId))) return false;
    return cap === null || row.max_budget_minor === null || cap <= row.max_budget_minor;
  });
  candidates.sort((a, b) => {
    const requester = Number(b.requester_agent_id === requesterAgentId) - Number(a.requester_agent_id === requesterAgentId);
    if (requester !== 0) return requester;
    if (b.target_resource_ids.length !== a.target_resource_ids.length) return b.target_resource_ids.length - a.target_resource_ids.length;
    const aBudget = a.max_budget_minor ?? Number.MAX_SAFE_INTEGER;
    const bBudget = b.max_budget_minor ?? Number.MAX_SAFE_INTEGER;
    if (aBudget !== bBudget) return aBudget - bBudget;
    if (a.priority !== b.priority) return b.priority - a.priority;
    return a.key.localeCompare(b.key);
  });
  const selected = candidates[0];
  if (!selected) throw new RouteError('no server policy authorizes this proposal', 'no_applicable_policy', 422);
  if (selected.key !== requestedKey) {
    throw new RouteError('the requested policy is not the server-selected policy for these limits and targets', 'policy_key_mismatch', 403);
  }
  return { row: selected, policy: policyFromRow(selected) };
}

function proposalResourceIds(proposal: ApprovalProposal): string[] {
  switch (proposal.approval_type) {
    case 'access': return [proposal.details.resource_id];
    case 'shared_learning': return [proposal.details.skill_id];
    case 'deliverable': return [proposal.details.artifact_id];
    case 'data_disclosure': return proposal.details.items.map((item) => item.resource_id);
    case 'record_change': return [proposal.details.system_id];
    case 'exception': return [proposal.details.rule_id];
    default: return [];
  }
}

async function resourceRows(
  tx: Tx,
  workspaceId: string,
  resourceIds: readonly string[],
): Promise<Map<string, { owner_member_id: string; version: string | null; sha256: string | null; executor_available: boolean }>> {
  if (resourceIds.length === 0) return new Map();
  const { rows } = await tx.query<{
    resource_key: string;
    owner_member_id: string;
    version: string | null;
    sha256: string | null;
    executor_available: boolean;
  }>(
    `SELECT resource_key, owner_member_id, version, sha256, executor_available
       FROM approval_resources
      WHERE workspace_id = $1 AND active AND resource_key = ANY ($2::text[])`,
    [workspaceId, resourceIds],
  );
  return new Map(rows.map((row) => [row.resource_key, row]));
}

async function validateIds(tx: Tx, table: 'agents' | 'members' | 'requests', workspaceId: string, ids: readonly string[]): Promise<void> {
  const unique = sortedUnique(ids);
  if (unique.length === 0) return;
  const status = table === 'members' ? ` AND status = 'active'` : table === 'agents' ? ` AND status IN ('draft', 'started')` : '';
  const { rows } = await tx.query<{ id: string }>(
    `SELECT id FROM ${table} WHERE workspace_id = $1 AND id = ANY ($2::uuid[])${status}`,
    [workspaceId, unique],
  );
  if (rows.length !== unique.length) throw new RouteError(`${table} include an unknown or inactive tenant id`, 'invalid_target', 422);
}

async function resolveResourceBindings(
  tx: Tx,
  workspaceId: string,
  proposal: ApprovalProposal,
  resources: Map<string, { owner_member_id: string; version: string | null; sha256: string | null; executor_available: boolean }>,
  requester: { userId: string | null; runId: string | null; agentId: string },
): Promise<ApprovalResourceBinding[]> {
  const bindings: ApprovalResourceBinding[] = [];
  for (const resourceId of sortedUnique(proposalResourceIds(proposal))) {
    const row = resources.get(resourceId);
    bindings.push({
      kind: 'resource',
      id: resourceId,
      version: row?.version ?? null,
      sha256: row?.sha256 ?? null,
      immutable: Boolean(row?.version && row.sha256),
      executor_available: row?.executor_available ?? false,
      reason: row ? (row.version && row.sha256 ? null : 'The resource has no immutable version and digest.') : 'The resource is not registered in this workspace.',
    });
  }

  if (proposal.approval_type === 'communication') {
    bindings.push({
      kind: 'artifact', id: 'communication-body', version: null,
      sha256: await sha256({ draft_only: proposal.details.draft_only, sender: proposal.details.sender, recipients: proposal.details.recipients, subject: proposal.details.subject, body: proposal.details.body }),
      immutable: true, executor_available: false, reason: NO_EXECUTOR,
    });
    for (const attachment of proposal.details.attachments) {
      let row: { kind: 'attachment' | 'agent_file'; version: string | null; sha256: string | null } | undefined;
      if (UUID.test(attachment.id)) {
        const found = await tx.query<{ kind: 'attachment' | 'agent_file'; version: string | null; sha256: string | null }>(
          `SELECT 'attachment'::text AS kind, completed_at::text AS version, sha256
             FROM attachments WHERE workspace_id = $1 AND id = $2 AND status = 'ready'
           UNION ALL
           SELECT 'agent_file'::text AS kind, updated_at::text AS version, sha256
             FROM agent_files WHERE workspace_id = $1 AND id = $2 AND sha256 IS NOT NULL
           LIMIT 1`,
          [workspaceId, attachment.id],
        );
        row = found.rows[0];
      }
      bindings.push({
        kind: row?.kind ?? 'attachment', id: attachment.id, version: row?.version ?? null,
        sha256: row?.sha256 ?? null, immutable: Boolean(row?.version && row.sha256), executor_available: false,
        reason: row?.sha256 ? NO_EXECUTOR : 'The attachment is not ready with an immutable content digest.',
      });
    }
  }

  if (proposal.approval_type === 'deliverable') {
    bindings.push({
      kind: 'artifact', id: proposal.details.artifact_id, version: proposal.details.version,
      sha256: await sha256(proposal.details.content), immutable: true, executor_available: false, reason: NO_EXECUTOR,
    });
  }

  for (const evidence of proposal.evidence) {
    if (!UUID.test(evidence.id)) continue;
    if (evidence.kind === 'source') {
      const found = await tx.query<{ version: string | null; sha256: string | null }>(
        `SELECT completed_at::text AS version,sha256 FROM attachments
          WHERE workspace_id=$1 AND id=$2 AND status='ready' AND deleted_at IS NULL`,
        [workspaceId, evidence.id],
      );
      const source = found.rows[0];
      bindings.push({
        kind: 'attachment', id: evidence.id, version: source?.version ?? null,
        sha256: source?.sha256 ?? null, immutable: Boolean(source?.version && source.sha256),
        executor_available: false,
        reason: source?.sha256 ? null : 'The source attachment is not ready with an immutable digest.',
      });
    } else if (evidence.kind === 'artifact') {
      // Artifact ids are shared by several evidence systems. Add a binding
      // only when this id is a mailbox snapshot granted to the requester's
      // explicit Enterprise team; partner artifacts keep their existing
      // validation path and are not reclassified as missing mailbox data.
      const found = await tx.query<{ version_id: string; sha256: string }>(
        `SELECT snapshot.library_version_id AS version_id,snapshot.normalized_sha256 AS sha256
           FROM mailbox_thread_snapshots snapshot
           JOIN enterprise_team_agents team_agent
             ON team_agent.workspace_id=snapshot.workspace_id AND team_agent.team_id=snapshot.team_id
           JOIN library_source_team_grants source_grant
             ON source_grant.workspace_id=snapshot.workspace_id
            AND source_grant.source_id=snapshot.library_source_id
            AND source_grant.team_id=snapshot.team_id
          WHERE snapshot.workspace_id=$1 AND snapshot.id=$2 AND team_agent.agent_id=$3
            AND ($4::uuid IS NULL OR team_agent.principal_user_id=$4)`,
        [workspaceId, evidence.id, requester.agentId, requester.userId],
      );
      const snapshot = found.rows[0];
      if (snapshot) {
        bindings.push({
          kind: 'artifact', id: evidence.id, version: snapshot.version_id,
          sha256: snapshot.sha256, immutable: true, executor_available: false, reason: null,
        });
      }
    } else if (evidence.kind === 'document') {
      const found = await tx.query<{ version: number; payload: unknown }>(
        `SELECT document.version,document.payload
           FROM documents document
          WHERE document.workspace_id=$1 AND document.id=$2
            AND (
              NOT EXISTS (
                SELECT 1 FROM request_audiences audience
                 WHERE audience.workspace_id=document.workspace_id
                   AND audience.request_id=document.request_id
              )
              OR (
                $3::uuid IS NOT NULL
                AND EXISTS (
                  SELECT 1 FROM request_audiences audience
                   WHERE audience.workspace_id=document.workspace_id
                     AND audience.request_id=document.request_id AND audience.user_id=$3
                )
                AND (
                  $4::uuid IS NULL OR EXISTS (
                    SELECT 1 FROM partner_workflow_executions execution
                    JOIN enterprise_run_grants grant
                      ON grant.workspace_id=execution.workspace_id
                     AND grant.resource_kind='handoff' AND grant.resource_id=execution.handoff_id
                    JOIN enterprise_skill_assignments assignment ON assignment.id=grant.assignment_id
                    JOIN enterprise_connection_bindings binding ON binding.id=grant.connection_binding_id
                    WHERE execution.workspace_id=document.workspace_id
                      AND execution.request_id=document.request_id
                      AND grant.run_id=$4 AND grant.capability='partner.shared.read'
                      AND grant.effect='allow' AND grant.revoked_at IS NULL
                      AND 'read_shared'=ANY(grant.allowed_actions)
                      AND assignment.state='active' AND assignment.revision=grant.assignment_revision
                      AND binding.state='active' AND NOT (grant.capability=ANY(binding.capability_denies))
                  )
                )
              )
            )`,
        [workspaceId, evidence.id, requester.userId, requester.runId],
      );
      const row = found.rows[0];
      bindings.push({ kind: 'document', id: evidence.id, version: row ? String(row.version) : null, sha256: row ? await sha256(row.payload) : null, immutable: Boolean(row), executor_available: false, reason: row ? null : 'The evidence document was not found.' });
    } else if (evidence.kind === 'request') {
      const found = await tx.query<{ updated_at: Date; payload: unknown }>(
        `SELECT request.updated_at,request.payload
           FROM requests request
          WHERE request.workspace_id=$1 AND request.id=$2
            AND (
              NOT EXISTS (
                SELECT 1 FROM request_audiences audience
                 WHERE audience.workspace_id=request.workspace_id AND audience.request_id=request.id
              )
              OR (
                $3::uuid IS NOT NULL
                AND EXISTS (
                  SELECT 1 FROM request_audiences audience
                   WHERE audience.workspace_id=request.workspace_id
                     AND audience.request_id=request.id AND audience.user_id=$3
                )
                AND (
                  $4::uuid IS NULL OR EXISTS (
                    SELECT 1 FROM partner_workflow_executions execution
                    JOIN enterprise_run_grants grant
                      ON grant.workspace_id=execution.workspace_id
                     AND grant.resource_kind='handoff' AND grant.resource_id=execution.handoff_id
                    JOIN enterprise_skill_assignments assignment ON assignment.id=grant.assignment_id
                    JOIN enterprise_connection_bindings binding ON binding.id=grant.connection_binding_id
                    WHERE execution.workspace_id=request.workspace_id
                      AND execution.request_id=request.id
                      AND grant.run_id=$4 AND grant.capability='partner.shared.read'
                      AND grant.effect='allow' AND grant.revoked_at IS NULL
                      AND 'read_shared'=ANY(grant.allowed_actions)
                      AND assignment.state='active' AND assignment.revision=grant.assignment_revision
                      AND binding.state='active' AND NOT (grant.capability=ANY(binding.capability_denies))
                  )
                )
              )
            )`,
        [workspaceId, evidence.id, requester.userId, requester.runId],
      );
      const row = found.rows[0];
      bindings.push({ kind: 'request', id: evidence.id, version: row?.updated_at.toISOString() ?? null, sha256: row ? await sha256(row.payload) : null, immutable: Boolean(row), executor_available: false, reason: row ? null : 'The evidence request was not found.' });
    } else if (evidence.kind === 'run') {
      const found = await tx.query<{ status: string; ended_at: Date | null; runtime_request: unknown }>(
        `SELECT status, ended_at, runtime_request FROM runs WHERE workspace_id = $1 AND id = $2`, [workspaceId, evidence.id],
      );
      const row = found.rows[0];
      const immutable = Boolean(row?.ended_at && ['completed', 'stopped', 'error'].includes(row.status));
      bindings.push({ kind: 'run', id: evidence.id, version: row?.ended_at?.toISOString() ?? null, sha256: immutable ? await sha256(row?.runtime_request ?? {}) : null, immutable, executor_available: false, reason: immutable ? null : 'The evidence run is absent or not terminal.' });
    }
  }
  return bindings;
}

function effectFor(proposal: ApprovalProposal, bindings: readonly ApprovalResourceBinding[]): {
  kind: ApprovalView['effect']['kind']; status: ApprovalView['effect']['status']; reason: string | null;
} {
  const kind: ApprovalView['effect']['kind'] =
    proposal.approval_type === 'access' ? 'access' :
    proposal.approval_type === 'communication' ? 'communication' :
    proposal.approval_type === 'shared_learning' ? 'shared_learning_publish' :
    proposal.approval_type === 'data_disclosure' ? 'data_disclosure' :
    proposal.approval_type === 'record_change' ? 'record_change' :
    proposal.approval_type === 'agent_governance' ? 'agent_governance_change' : 'none';
  if (kind === 'none') return { kind, status: 'not_required', reason: null };
  if (proposal.approval_type === 'communication' && proposal.details.draft_only) {
    return { kind, status: 'not_required', reason: 'Draft only. Approval records the reviewed copy and does not send it.' };
  }
  if (proposal.approval_type === 'communication' && proposal.details.channel === 'email') {
    return { kind, status: 'waiting', reason: 'Approval queues this exact revision for the configured sender; it waits safely if that mailbox is not connected.' };
  }
  const unbound = bindings.find((binding) => !binding.immutable);
  return { kind, status: 'unavailable', reason: unbound?.reason ?? NO_EXECUTOR };
}

async function requesterContext(
  context: ApprovalProposerContext,
): Promise<{ userId: string | null; memberId: string | null; sessionId: string | null; runId: string | null }> {
  const allowedAgentStatuses = context.sourceTrigger ? ['draft', 'started'] : ['started'];
  const agent = await context.tx.query(
    `SELECT 1 FROM agents WHERE workspace_id = $1 AND id = $2 AND status = ANY ($3::text[])`,
    [context.workspaceId, context.agentId, allowedAgentStatuses],
  );
  if (agent.rowCount !== 1) throw new RouteError('the proposing agent is not active in this workspace', 'invalid_requester_agent', 422);

  let userId = context.userId ?? null;
  if (context.sessionId) {
    const session = await context.tx.query<{ owner_id: string; agent_id: string | null }>(
      `SELECT owner_id, agent_id FROM sessions WHERE workspace_id = $1 AND id = $2`, [context.workspaceId, context.sessionId],
    );
    const row = session.rows[0];
    if (!row || row.agent_id !== context.agentId) throw new RouteError('the source session is not bound to the proposing agent', 'invalid_source_session', 422);
    if (userId && userId !== row.owner_id) throw new RouteError('the supplied requester does not own the source session', 'invalid_requester', 422);
    userId = row.owner_id;
  }
  if (context.runId) {
    if (!context.sessionId) throw new RouteError('a source run requires its source session', 'invalid_source_run', 422);
    const run = await context.tx.query(
      `SELECT 1 FROM runs
        WHERE workspace_id = $1 AND id = $2 AND session_id = $3 AND agent_id = $4
          AND status IN ('working', 'waiting') AND NOT stop_requested`,
      [context.workspaceId, context.runId, context.sessionId, context.agentId],
    );
    if (run.rowCount !== 1) throw new RouteError('the source run is not bound to the source session and agent', 'invalid_source_run', 422);
  }
  let memberId: string | null = null;
  if (userId) {
    const member = await context.tx.query<{ id: string }>(
      `SELECT id FROM members WHERE workspace_id = $1 AND user_id = $2 AND status = 'active'`, [context.workspaceId, userId],
    );
    memberId = member.rows[0]?.id ?? null;
    if (!memberId) throw new RouteError('the requester is not an active workspace member', 'invalid_requester', 422);
  }
  return { userId, memberId, sessionId: context.sessionId ?? null, runId: context.runId ?? null };
}

async function validateJoinSource(context: ApprovalProposerContext, proposal: ApprovalProposal): Promise<void> {
  const trigger = context.sourceTrigger;
  if (!trigger) return;
  if (!context.userId || !context.sessionId || context.runId) {
    throw new RouteError('a member join proposal requires a human-owned source session and no source run', 'invalid_join_source', 422);
  }
  const { rows } = await context.tx.query<{ invited_by: string | null; accepted_by: string | null; proposer_role: string | null }>(
    `SELECT i.invited_by, i.accepted_by,
            (SELECT role FROM members
              WHERE workspace_id = $1 AND user_id = $6 AND status = 'active') AS proposer_role
       FROM invitations i
       JOIN members m ON m.workspace_id = i.workspace_id AND m.id = $3
       JOIN agent_owners ao ON ao.workspace_id = i.workspace_id
                           AND ao.member_id = m.id AND ao.agent_id = $4
      WHERE i.workspace_id = $1 AND i.id = $2 AND i.status = 'accepted'
        AND i.accepted_by = m.user_id AND $5 = 'member_agent_joined'`,
    [context.workspaceId, trigger.invitation_id, trigger.member_id, trigger.agent_id, trigger.kind, context.userId],
  );
  const row = rows[0];
  if (!row) throw new RouteError('the member join source is not backed by an accepted invitation and agent owner', 'invalid_join_source', 422);
  if (proposal.approval_type === 'run_plan') {
    const agents = proposal.details.participating_agents.map((agent) => agent.agent_id);
    if (row.accepted_by !== context.userId || agents.length !== 1 || agents[0] !== trigger.agent_id) {
      throw new RouteError('the member join plan must be requested by the joining member for their assigned agent', 'invalid_join_target', 422);
    }
    return;
  }
  if (row.invited_by ? row.invited_by !== context.userId : row.proposer_role !== 'admin') {
    throw new RouteError('only the inviter or an active admin can sponsor join coordination', 'invalid_join_sponsor', 403);
  }
}

async function ownerForAgent(tx: Tx, workspaceId: string, agentId: string): Promise<string> {
  const { rows } = await tx.query<{ member_id: string }>(
    `SELECT ao.member_id FROM agent_owners ao JOIN members m ON m.id = ao.member_id
      WHERE ao.workspace_id = $1 AND ao.agent_id = $2 AND m.status = 'active'`, [workspaceId, agentId],
  );
  const owner = rows[0]?.member_id;
  if (!owner) throw new RouteError('the target agent has no active responsible human', 'missing_agent_owner', 422);
  return owner;
}

async function validatedTargetContext(
  tx: Tx,
  workspaceId: string,
  proposal: ApprovalProposal,
  input: Pick<ProposeApprovalInput, 'target_agent_ids' | 'target_member_ids' | 'target_resource_ids' | 'dependent_request_ids'>,
): Promise<{ targetAgentIds: string[]; targetMemberIds: string[]; targetResourceIds: string[]; dependentRequestIds: string[]; requiredOwnerIds: string[]; resources: Awaited<ReturnType<typeof resourceRows>> }> {
  const derivedAgents: string[] = [];
  const derivedMembers: string[] = [];
  if (proposal.approval_type === 'team_commitment') {
    derivedAgents.push(proposal.details.recipient_agent_id);
    derivedMembers.push(proposal.details.receiving_owner_member_id);
  }
  if (proposal.approval_type === 'access') derivedAgents.push(proposal.details.requested_agent_id);
  if (proposal.approval_type === 'agent_governance') derivedAgents.push(proposal.details.agent_id);
  if (proposal.approval_type === 'run_plan') derivedAgents.push(...proposal.details.participating_agents.map((agent) => agent.agent_id));
  if (proposal.approval_type === 'communication') derivedMembers.push(proposal.details.sender.member_id);

  const derivedResourceIds = sortedUnique(proposalResourceIds(proposal));
  if (input.target_agent_ids.some((id) => !derivedAgents.includes(id))) throw new RouteError('target agents must be derived from the typed proposal', 'invalid_target', 422);
  if (input.target_resource_ids.some((id) => !derivedResourceIds.includes(id))) throw new RouteError('target resources must be derived from the typed proposal', 'invalid_target', 422);

  const targetAgentIds = sortedUnique([...input.target_agent_ids, ...derivedAgents]);
  const targetMemberIds = sortedUnique([...input.target_member_ids, ...derivedMembers]);
  const targetResourceIds = sortedUnique([...input.target_resource_ids, ...derivedResourceIds]);
  const dependentRequestIds = sortedUnique(input.dependent_request_ids);
  await validateIds(tx, 'agents', workspaceId, targetAgentIds);
  await validateIds(tx, 'members', workspaceId, targetMemberIds);
  await validateIds(tx, 'requests', workspaceId, dependentRequestIds);

  const resources = await resourceRows(tx, workspaceId, targetResourceIds);
  const requiredOwnerIds = new Set<string>();
  for (const resourceId of proposalResourceIds(proposal)) {
    const resource = resources.get(resourceId);
    if (!resource) throw new RouteError(`resource ${resourceId} is not registered in this workspace`, 'invalid_resource', 422);
    requiredOwnerIds.add(resource.owner_member_id);
  }
  if (proposal.approval_type === 'team_commitment') {
    const owner = await ownerForAgent(tx, workspaceId, proposal.details.recipient_agent_id);
    if (owner !== proposal.details.receiving_owner_member_id) throw new RouteError('the receiving owner does not own the recipient agent', 'receiving_owner_mismatch', 422);
    requiredOwnerIds.add(owner);
  }
  if (proposal.approval_type === 'agent_governance') requiredOwnerIds.add(await ownerForAgent(tx, workspaceId, proposal.details.agent_id));
  if (proposal.approval_type === 'communication') requiredOwnerIds.add(proposal.details.sender.member_id);
  const allowedTargetMembers = new Set([...derivedMembers, ...requiredOwnerIds]);
  if (input.target_member_ids.some((id) => !allowedTargetMembers.has(id))) throw new RouteError('target members must be derived from verified proposal authority', 'invalid_target', 422);
  return { targetAgentIds, targetMemberIds: sortedUnique([...targetMemberIds, ...requiredOwnerIds]), targetResourceIds, dependentRequestIds, requiredOwnerIds: [...requiredOwnerIds], resources };
}

async function loadApprovalRow(tx: Tx, requestId: string, lock = false): Promise<ApprovalRow | null> {
  const { rows } = await tx.query<ApprovalRow>(
    `SELECT ar.request_id, ar.workspace_id, ar.status, ar.authorization_revision, ar.authorization_hash,
            ar.expires_at, ar.requester_agent_id, ar.requester_member_id, ar.requester_user_id,
            ar.source_session_id, ar.source_run_id, ar.effect_kind, ar.effect_status, ar.effect_reason,
            ar.work_status, ar.work_reason, ar.continuation_id, ar.finalized_at, r.payload
       FROM approval_requests ar JOIN requests r ON r.id = ar.request_id
      WHERE ar.request_id = $1${lock ? ' FOR UPDATE OF ar, r' : ''}`,
    [requestId],
  );
  return rows[0] ?? null;
}

async function votesFor(tx: Tx, row: ApprovalRow): Promise<VoteRow[]> {
  const { rows } = await tx.query<VoteRow>(
    `SELECT v.id, v.step_id, v.decision, v.revision AS authorization_revision,
            v.authorization_hash, v.reviewer_member_id, v.reviewer_user_id,
            COALESCE(u.name, u.email, 'Member') AS reviewer_name, v.note, v.idempotency_key, v.recorded_at
       FROM approval_votes v JOIN users u ON u.id = v.reviewer_user_id
      WHERE v.request_id = $1 AND v.revision = $2 AND v.authorization_hash = $3
      ORDER BY v.recorded_at, v.id`,
    [row.request_id, row.authorization_revision, row.authorization_hash],
  );
  return rows;
}

async function routeAssignments(tx: Tx, row: ApprovalRow): Promise<Map<string, string>> {
  const { rows } = await tx.query<{ step_id: string; reviewer_member_id: string }>(
    `SELECT DISTINCT ON (step_id) step_id, reviewer_member_id
       FROM approval_routes WHERE request_id = $1 AND revision = $2
      ORDER BY step_id, created_at DESC, id DESC`, [row.request_id, row.authorization_revision],
  );
  return new Map(rows.map((route) => [route.step_id, route.reviewer_member_id]));
}

function progress(
  row: ApprovalRow,
  payload: ApprovalPayload,
  members: readonly MemberRow[],
  votes: readonly VoteRow[],
  assignments: ReadonlyMap<string, string>,
): { steps: ApprovalView['steps']; current: Set<string>; validApprovals: Map<string, Set<string>> } {
  const ordered = [...payload.policy.steps].sort((a, b) => a.order - b.order);
  const validApprovals = new Map(ordered.map((step) => [step.id, new Set<string>()]));
  const usedReviewerIds = new Set<string>();
  for (const vote of votes) {
    if (vote.decision !== 'approve') continue;
    const step = ordered.find((candidate) => candidate.id === vote.step_id);
    if (!step) continue;
    const eligible = eligibleForStep(step, members, row.requester_member_id, payload.policy.prevent_self_review)
      .some((member) => member.id === vote.reviewer_member_id);
    if (!eligible || (payload.policy.require_distinct_reviewers && usedReviewerIds.has(vote.reviewer_member_id))) continue;
    validApprovals.get(step.id)?.add(vote.reviewer_member_id);
    if (payload.policy.require_distinct_reviewers) usedReviewerIds.add(vote.reviewer_member_id);
  }
  const completed = (step: ApprovalPolicy['steps'][number]): boolean => (validApprovals.get(step.id)?.size ?? 0) >= step.quorum;
  const current = new Set<string>();
  if (row.status === 'pending') {
    if (payload.policy.mode === 'parallel') {
      for (const step of ordered) if (!completed(step)) current.add(step.id);
    } else {
      const first = ordered.find((step) => !completed(step));
      if (first) current.add(first.id);
    }
  }
  const terminalVote = votes.find((vote) => vote.decision !== 'approve');
  const steps = ordered.map((step): ApprovalView['steps'][number] => {
    const eligible = eligibleForStep(step, members, row.requester_member_id, payload.policy.prevent_self_review);
    const assigned = assignments.get(step.id);
    const currentReviewerIds = assigned && eligible.some((member) => member.id === assigned) ? [assigned] : eligible.map((member) => member.id);
    const status = terminalVote?.step_id === step.id
      ? terminalVote.decision === 'decline' ? 'declined' as const : 'changes_requested' as const
      : completed(step) ? 'approved' as const
      : current.has(step.id) ? 'current' as const : 'blocked' as const;
    return { step_id: step.id, label: step.label, order: step.order, status, approvals_recorded: validApprovals.get(step.id)?.size ?? 0, quorum: step.quorum, current_reviewer_member_ids: currentReviewerIds };
  });
  return { steps, current, validApprovals };
}

export async function loadApprovalView(tx: Tx, requestId: string, viewerUserId: string | null): Promise<ApprovalView> {
  const row = await loadApprovalRow(tx, requestId);
  if (!row) throw new RouteError('no such approval request', 'unknown_approval', 404);
  const payload = approvalPayloadSchema.parse(row.payload);
  const members = await activeMembers(tx, row.workspace_id);
  const votes = await votesFor(tx, row);
  const assignments = await routeAssignments(tx, row);
  const state = progress(row, payload, members, votes, assignments);
  const viewer = viewerUserId ? members.find((member) => member.user_id === viewerUserId) : undefined;
  const eligibleStepIds = viewer
    ? [...state.current].filter((stepId) => {
        const step = payload.policy.steps.find((candidate) => candidate.id === stepId);
        if (!step || !step.reviewers.some((selector) => selectorMatches(viewer, selector))) return false;
        if (payload.policy.prevent_self_review && viewer.id === row.requester_member_id) return false;
        const assigned = assignments.get(stepId);
        return !assigned || assigned === viewer.id;
      })
    : [];
  const alreadyVoted = new Set(votes.filter((vote) => vote.reviewer_member_id === viewer?.id).map((vote) => vote.step_id));
  const participated = payload.policy.require_distinct_reviewers && votes.some((vote) => vote.reviewer_member_id === viewer?.id);
  const actionable = participated ? [] : eligibleStepIds.filter((stepId) => !alreadyVoted.has(stepId));
  const pending = row.status === 'pending' && asTime(row.expires_at).getTime() > Date.now();
  const allowed = pending && actionable.length > 0 ? ['approve', 'decline', 'request_changes'] as const : [];

  const reviewerIds = new Set<string>();
  for (const step of payload.policy.steps) {
    for (const member of eligibleForStep(step, members, row.requester_member_id, payload.policy.prevent_self_review)) reviewerIds.add(member.id);
  }
  const targetAgents = payload.context.target_agent_ids.length === 0 ? [] : (await tx.query<{
    id: string; name: string; member_id: string | null; member_name: string | null;
  }>(
    `SELECT a.id, a.name, ao.member_id, u.name AS member_name
       FROM agents a LEFT JOIN agent_owners ao ON ao.agent_id = a.id
       LEFT JOIN members m ON m.id = ao.member_id LEFT JOIN users u ON u.id = m.user_id
      WHERE a.workspace_id = $1 AND a.id = ANY ($2::uuid[])`, [row.workspace_id, payload.context.target_agent_ids],
  )).rows;
  const requesterAgent = (await tx.query<{ id: string; name: string }>(
    `SELECT id, name FROM agents WHERE workspace_id = $1 AND id = $2`, [row.workspace_id, row.requester_agent_id],
  )).rows[0];
  if (!requesterAgent) throw new RouteError('the requester agent no longer exists', 'invalid_requester_agent', 409);

  return approvalViewSchema.parse({
    request_id: row.request_id,
    workspace_id: row.workspace_id,
    status: row.status,
    payload,
    identities: {
      requester_agent: { id: requesterAgent.id, name: requesterAgent.name, email: null },
      target_agents: targetAgents.map((agent) => ({ id: agent.id, name: agent.name, email: null, responsible_member_id: agent.member_id, responsible_member_name: agent.member_name })),
      reviewers: members.filter((member) => reviewerIds.has(member.id)).map((member) => ({ member_id: member.id, user_id: member.user_id, name: member.name, authority_roles: sortedUnique([member.role, ...member.reviewer_roles]) })),
    },
    votes: votes.map((vote) => ({ ...vote, recorded_at: vote.recorded_at.toISOString() })),
    steps: state.steps,
    capabilities: {
      allowed_decisions: [...allowed], eligible_step_ids: actionable,
      can_route: pending && viewer?.role === 'admin',
      can_submit_revision: ['pending', 'changes_requested'].includes(row.status) && Boolean(viewer && (viewer.role === 'admin' || viewer.id === row.requester_member_id)),
      reason: pending ? (actionable.length ? null : 'This request is waiting on another reviewer.') : `This authorization is ${row.status}.`,
    },
    effect: { kind: row.effect_kind, status: row.effect_status, effect_id: null, reason: row.effect_reason },
    work: { status: row.work_status, continuation_id: row.continuation_id, reason: row.work_reason },
    finalized_at: row.finalized_at?.toISOString() ?? null,
  });
}

export async function loadApprovalListProjection(
  tx: Tx,
  requestId: string,
  viewerUserId: string,
): Promise<ApprovalListProjection> {
  const view = await loadApprovalView(tx, requestId, viewerUserId);
  const expired = view.status === 'pending' && Date.parse(view.payload.authorization.expires_at) <= Date.now();
  const status = expired ? 'expired' as const : view.status;
  const currentIds = new Set(view.steps.filter((step) => step.status === 'current').flatMap((step) => step.current_reviewer_member_ids));
  const reviewerNames = view.identities.reviewers.filter((reviewer) => currentIds.has(reviewer.member_id)).map((reviewer) => reviewer.name);
  const pendingForViewer = status === 'pending' && view.capabilities.allowed_decisions.length > 0;
  const currentSteps = view.steps.filter((step) => step.status === 'current');
  return {
    approval_type: view.payload.approval_type,
    authorization_status: status,
    authorization_revision: view.payload.authorization.revision,
    expires_at: view.payload.authorization.expires_at,
    pending_for_viewer: pendingForViewer,
    waiting_on_others: status === 'pending' && !pendingForViewer,
    current_reviewer_names: reviewerNames,
    mode: view.payload.policy.mode,
    completed_steps: view.steps.filter((step) => step.status === 'approved').length,
    total_steps: view.steps.length,
    remaining_approvals: view.steps
      .filter((step) => !['approved', 'declined', 'changes_requested'].includes(step.status))
      .reduce((sum, step) => sum + Math.max(0, step.quorum - step.approvals_recorded), 0),
    current_steps: currentSteps.map((step) => ({
      label: step.label,
      approvals_recorded: step.approvals_recorded,
      quorum: step.quorum,
    })),
    effect_status: view.effect.status,
    work_status: expired ? 'cancelled' : view.work.status,
  };
}

async function audit(tx: Tx, workspaceId: string, actorType: 'user' | 'agent' | 'system', actorUserId: string | null, kind: string, requestId: string, sessionId: string | null): Promise<void> {
  await tx.query(
    `INSERT INTO events (workspace_id, actor_type, actor_user_id, kind, request_id, session_id)
     VALUES ($1, $2, $3, $4, $5, $6)`, [workspaceId, actorType, actorUserId, kind, requestId, sessionId],
  );
}

async function publishRequestChanged(
  work: ApprovalWork,
  requestId: string,
  created?: { label: string; runId: string | null; sessionId: string | null },
): Promise<void> {
  const events = created
    ? [
        { kind: 'request.created', payload: { request_id: requestId, kind: 'approval', status: 'pending', label: created.label, run_id: created.runId, session_id: created.sessionId } },
        { kind: 'entity.updated', payload: { entity_type: 'request', entity_id: requestId, ref: { section: 'inbox', view: 'request', id: requestId }, version: null } },
      ]
    : [{ kind: 'entity.updated', payload: { entity_type: 'request', entity_id: requestId, ref: { section: 'inbox', view: 'request', id: requestId }, version: null } }];
  work.jobs.push(...await publishEvents(work.tx, work.workspaceId, events));
}

async function validatePartnerOutreachContact(
  tx: Tx,
  workspaceId: string,
  agentId: string,
  policyKey: string,
  proposal: ApprovalProposal,
  existingRequestId: string | null = null,
): Promise<{ candidateId: string; stage: 'draft_pending' | 'send_pending' } | null> {
  const canonicalJson = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
    }
    return JSON.stringify(value);
  };
  const draftPolicy = policyKey === `partner-outreach-draft-${agentId}`;
  const sendPolicy = policyKey === `partner-outreach-send-${agentId}`;
  if (!draftPolicy && !sendPolicy) return null;
  if (proposal.approval_type !== 'communication'
      || proposal.details.draft_only !== draftPolicy
      || proposal.details.recipients.length !== 1) {
    throw new RouteError('partner outreach must match its configured draft or approved-send policy', 'invalid_partner_outreach', 422);
  }
  const recipient = proposal.details.recipients[0]!;
  if (!recipient.candidate_id) {
    throw new RouteError('partner outreach must name the stored candidate', 'invalid_partner_outreach_contact', 422);
  }
  const result = await tx.query<{
    enrichment_id: string; display_name: string; contact_data: {
      phones?: { number: string; type?: string | null }[];
      social_profiles?: { network: string; url: string }[];
    }; preferred_email: string | null; draft_eligible: boolean;
  }>(
    `SELECT e.id AS enrichment_id, c.display_name, e.contact_data,
            e.preferred_email, e.draft_eligible
       FROM partner_candidates c
       JOIN LATERAL (
         SELECT id, contact_data, preferred_email, draft_eligible
           FROM partner_contact_enrichments
          WHERE workspace_id=c.workspace_id AND agent_id=c.agent_id AND candidate_id=c.id
          ORDER BY updated_at DESC LIMIT 1
       ) e ON true
      WHERE c.workspace_id=$1 AND c.agent_id=$2 AND c.id=$3`,
    [workspaceId, agentId, recipient.candidate_id],
  );
  const stored = result.rows[0];
  const expectedAddress = stored?.draft_eligible ? stored.preferred_email : null;
  const expectedPhones = stored?.contact_data.phones ?? [];
  const expectedProfiles = stored?.contact_data.social_profiles ?? [];
  if (!stored || recipient.name !== stored.display_name || recipient.address !== expectedAddress
      || canonicalJson(recipient.phone_numbers ?? []) !== canonicalJson(expectedPhones)
      || canonicalJson(recipient.social_profiles ?? []) !== canonicalJson(expectedProfiles)
      || !proposal.evidence.some((item) => item.id === stored.enrichment_id && item.kind === 'artifact')) {
    throw new RouteError('partner outreach contact fields must match stored verified evidence', 'invalid_partner_outreach_contact', 422);
  }
  if (sendPolicy && !recipient.address) {
    throw new RouteError('approved partner email requires a verified professional address', 'invalid_partner_outreach_contact', 422);
  }
  await idempotencyLock(tx, workspaceId, `partner-engagement:${agentId}:${recipient.candidate_id}`);
  const prior = await tx.query<{ request_id: string }>(
    `SELECT request_id FROM partner_engagements WHERE workspace_id=$1 AND agent_id=$2 AND candidate_id=$3`,
    [workspaceId, agentId, recipient.candidate_id],
  );
  if (prior.rows[0] && prior.rows[0].request_id !== existingRequestId) {
    throw new RouteError('this candidate already has an outreach engagement', 'partner_candidate_already_engaged', 409);
  }
  return { candidateId: recipient.candidate_id, stage: draftPolicy ? 'draft_pending' : 'send_pending' };
}

export async function proposeApproval(context: ApprovalProposerContext, rawInput: unknown): Promise<ApprovalView> {
  const input = proposeApprovalInputSchema.parse(rawInput);
  await validateJoinSource(context, input.proposal);
  if (context.sourceTrigger) {
    const validTeamCommitment = input.proposal.approval_type === 'team_commitment'
      && input.proposal.details.recipient_agent_id === context.sourceTrigger.agent_id
      && input.proposal.details.receiving_owner_member_id === context.sourceTrigger.member_id;
    const validPartnerPlan = input.proposal.approval_type === 'run_plan'
      && input.proposal.details.participating_agents.length === 1
      && input.proposal.details.participating_agents[0]?.agent_id === context.sourceTrigger.agent_id;
    if (!validTeamCommitment && !validPartnerPlan) {
      throw new RouteError('the join trigger must propose coordination with the newly owned agent', 'invalid_join_target', 422);
    }
  }
  const { idempotency_key: _key, ...proposalMaterial } = input;
  const proposalIdempotencyHash = await sha256({
    requester_agent_id: context.agentId,
    requester_user_id: context.userId ?? null,
    source_session_id: context.sessionId ?? null,
    source_run_id: context.runId ?? null,
    source_trigger: context.sourceTrigger ?? null,
    input: proposalMaterial,
  });
  await idempotencyLock(context.tx, context.workspaceId, input.idempotency_key);
  const existing = await context.tx.query<{ request_id: string; proposal_idempotency_hash: string }>(
    `SELECT request_id, proposal_idempotency_hash FROM approval_requests WHERE workspace_id = $1 AND proposal_idempotency_key = $2`,
    [context.workspaceId, input.idempotency_key],
  );
  if (existing.rows[0]) {
    if (existing.rows[0].proposal_idempotency_hash !== proposalIdempotencyHash) {
      throw new RouteError('idempotency key was already used for a different approval proposal', 'idempotency_conflict', 409);
    }
    return loadApprovalView(context.tx, existing.rows[0].request_id, context.userId ?? null);
  }

  const requester = await requesterContext(context);
  if (input.proposal.approval_type === 'team_commitment' && input.proposal.details.requester_agent_id !== context.agentId) {
    throw new RouteError('the team commitment requester must be the authenticated agent', 'requester_agent_mismatch', 422);
  }
  const targets = await validatedTargetContext(context.tx, context.workspaceId, input.proposal, input);
  const selected = await selectPolicy(context.tx, context.workspaceId, input.proposal, context.agentId, targets.targetResourceIds, input.policy_key);
  const partnerEngagement = await validatePartnerOutreachContact(
    context.tx, context.workspaceId, context.agentId, selected.row.key, input.proposal,
  );
  const members = await activeMembers(context.tx, context.workspaceId);
  validatePolicyFeasibility(selected.policy, members, requester.memberId, targets.requiredOwnerIds);

  const now = Date.now();
  const maximumExpiry = now + selected.row.max_duration_seconds * 1000;
  const requestedExpiry = input.requested_expires_at ? Date.parse(input.requested_expires_at) : maximumExpiry;
  if (!Number.isFinite(requestedExpiry) || requestedExpiry <= now || requestedExpiry > maximumExpiry) {
    throw new RouteError('the requested expiry is outside the selected policy limit', 'invalid_expiry', 422);
  }
  const expiresAt = new Date(requestedExpiry).toISOString();
  const bindings = await resolveResourceBindings(
    context.tx, context.workspaceId, input.proposal, targets.resources,
    { userId: requester.userId, runId: requester.runId, agentId: context.agentId },
  );
  const serverContext = {
    requester: { agent_id: context.agentId, member_id: requester.memberId, user_id: requester.userId },
    target_agent_ids: targets.targetAgentIds,
    target_member_ids: targets.targetMemberIds,
    target_resource_ids: targets.targetResourceIds,
    source: {
      session_id: requester.sessionId,
      run_id: requester.runId,
      dependent_request_ids: targets.dependentRequestIds,
      trigger: context.sourceTrigger ?? null,
    },
  };
  const hash = await authorizationHash({ proposal: input.proposal, context: serverContext, policy: selected.policy, resource_bindings: bindings, expires_at: expiresAt });
  const payload = approvalPayloadSchema.parse({ ...input.proposal, context: serverContext, authorization: { revision: 1, hash, expires_at: expiresAt }, policy: selected.policy, resource_bindings: bindings });
  const effect = effectFor(input.proposal, bindings);

  const inserted = await context.tx.query<{ id: string; version: number }>(
    `INSERT INTO requests (workspace_id, kind, label, payload, status, run_id, session_id, tool_call_id)
     VALUES ($1, 'approval', $2, $3::jsonb, 'pending', $4, $5, $6)
     RETURNING id, EXTRACT(EPOCH FROM updated_at)::int AS version`,
    [context.workspaceId, input.label, JSON.stringify(payload), requester.runId, requester.sessionId, input.idempotency_key],
  );
  const requestId = inserted.rows[0]?.id;
  if (!requestId) throw new RouteError('approval request was not created', 'approval_create_failed', 409);
  await context.tx.query(
    `INSERT INTO approval_requests
       (request_id, workspace_id, policy_id, policy_version, authorization_revision, authorization_hash,
        expires_at, requester_agent_id, requester_member_id, requester_user_id, source_session_id,
        source_run_id, proposal_idempotency_key, proposal_idempotency_hash,
        effect_kind, effect_status, effect_reason)
     VALUES ($1,$2,$3,$4,1,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [requestId, context.workspaceId, selected.row.id, selected.row.version, hash, expiresAt, context.agentId, requester.memberId, requester.userId, requester.sessionId, requester.runId, input.idempotency_key, proposalIdempotencyHash, effect.kind, effect.status, effect.reason],
  );
  if (partnerEngagement) {
    await context.tx.query(
      `INSERT INTO partner_engagements (workspace_id,agent_id,candidate_id,request_id,stage)
       VALUES ($1,$2,$3,$4,$5)`,
      [context.workspaceId, context.agentId, partnerEngagement.candidateId, requestId, partnerEngagement.stage],
    );
  }
  await context.tx.query(
    `INSERT INTO approval_revisions
       (workspace_id, request_id, revision, authorization_hash, payload, status,
        created_by_type, created_by_user_id, created_by_agent_id)
     VALUES ($1,$2,1,$3,$4::jsonb,'pending','agent',$5,$6)`,
    [context.workspaceId, requestId, hash, JSON.stringify(payload), requester.userId, context.agentId],
  );
  await audit(context.tx, context.workspaceId, 'agent', requester.userId, 'approval.proposed', requestId, requester.sessionId);
  await publishRequestChanged(context, requestId, { label: input.label, runId: requester.runId, sessionId: requester.sessionId });
  return loadApprovalView(context.tx, requestId, requester.userId);
}

async function commandReplay(tx: Tx, workspaceId: string, requestId: string, operation: string, key: string, hash: string): Promise<boolean> {
  await idempotencyLock(tx, workspaceId, key);
  const { rows } = await tx.query<{ request_id: string; operation: string; command_hash: string }>(
    `SELECT request_id, operation, command_hash FROM approval_commands WHERE workspace_id = $1 AND idempotency_key = $2`, [workspaceId, key],
  );
  const prior = rows[0];
  if (!prior) return false;
  if (prior.request_id !== requestId || prior.operation !== operation || prior.command_hash !== hash) {
    throw new RouteError('idempotency key was already used for another approval command', 'idempotency_conflict', 409);
  }
  return true;
}

function assertBinding(row: ApprovalRow, revision: number, hash: string): void {
  if (row.authorization_revision !== revision || row.authorization_hash !== hash) {
    throw new RouteError('the approval revision changed; refresh before acting', 'stale_authorization', 409);
  }
}

async function recordCommand(tx: Tx, row: ApprovalRow, operation: 'decision' | 'revision' | 'route', key: string, hash: string): Promise<void> {
  await tx.query(
    `INSERT INTO approval_commands (workspace_id, request_id, operation, idempotency_key, command_hash) VALUES ($1,$2,$3,$4,$5)`,
    [row.workspace_id, row.request_id, operation, key, hash],
  );
}

async function markExpired(work: ApprovalWork, row: ApprovalRow): Promise<void> {
  await work.tx.query(`UPDATE approval_requests SET status = 'expired', work_status = 'cancelled', work_reason = 'The authorization expired.' WHERE request_id = $1`, [row.request_id]);
  await work.tx.query(`UPDATE approval_revisions SET status = 'expired' WHERE request_id = $1 AND revision = $2`, [row.request_id, row.authorization_revision]);
  await work.tx.query(`UPDATE requests SET status = 'expired' WHERE id = $1`, [row.request_id]);
  await work.tx.query(
    `UPDATE partner_engagement_authorizations SET status='expired'
      WHERE workspace_id=$1 AND approval_request_id=$2 AND status='pending'`,
    [row.workspace_id, row.request_id],
  );
  await audit(work.tx, row.workspace_id, 'system', null, 'approval.expired', row.request_id, row.source_session_id);
  await publishRequestChanged(work, row.request_id);
}

export async function getApproval(work: ApprovalWork, requestId: string, viewerUserId: string): Promise<ApprovalView> {
  const row = await loadApprovalRow(work.tx, requestId, true);
  if (!row) throw new RouteError('no such approval request', 'unknown_approval', 404);
  if (row.status === 'pending' && asTime(row.expires_at).getTime() <= Date.now()) await markExpired(work, row);
  return loadApprovalView(work.tx, requestId, viewerUserId);
}

async function finalizeApproval(work: ApprovalWork, row: ApprovalRow, payload: ApprovalPayload): Promise<void> {
  const finalizedAt = new Date().toISOString();
  await work.tx.query(
    `UPDATE approval_requests SET status = 'approved', work_status = 'ready', finalized_at = $2 WHERE request_id = $1 AND status = 'pending'`,
    [row.request_id, finalizedAt],
  );
  await work.tx.query(`UPDATE approval_revisions SET status = 'approved' WHERE request_id = $1 AND revision = $2`, [row.request_id, row.authorization_revision]);
  await work.tx.query(`UPDATE requests SET status = 'approved' WHERE id = $1 AND status = 'pending'`, [row.request_id]);
  await audit(work.tx, row.workspace_id, 'system', null, 'approval.finalized', row.request_id, row.source_session_id);
  // This one record_change has an allowlisted internal materializer. It
  // rechecks the exact approval/source bindings and commits the engagement in
  // this same human-finalization transaction. Returning here is deliberate:
  // approval_continue would admit an unrelated model run for a change the
  // server has already applied atomically.
  if (payload.approval_type === 'record_change'
      && payload.details.system_id === 'enterprise-partner-records') {
    const materialized = await (await import('../partner-workflow/v2.js')).materializePartnerEngagementAuthorization(
      work.tx,
      {
        workspaceId: row.workspace_id,
        requestId: row.request_id,
        authorizationRevision: row.authorization_revision,
        authorizationHash: row.authorization_hash,
        payload,
      },
    );
    if (materialized) return;
  }
  const queuedEmail = await queueApprovedEmail(work.tx, {
    workspaceId: row.workspace_id,
    requestId: row.request_id,
    authorizationRevision: row.authorization_revision,
    authorizationHash: row.authorization_hash,
    payload,
  });
  if (queuedEmail?.state === 'queued') {
    for (const outboxId of queuedEmail.ids) {
      const emailJob = await enqueueJob(
        work.tx,
        row.workspace_id,
        'outbound_email_send',
        `outbound-email:${outboxId}`,
        { outbox_id: outboxId },
      );
      if (emailJob) work.jobs.push(emailJob);
    }
  }
  if (payload.approval_type === 'communication' && payload.details.recipients[0]?.candidate_id) {
    const nextStage = payload.details.draft_only
      ? 'draft_approved'
      : queuedEmail?.state === 'queued' ? 'queued' : 'pending_connection';
    await work.tx.query(
      `UPDATE partner_engagements SET stage=$3
        WHERE workspace_id=$1 AND request_id=$2`,
      [row.workspace_id, row.request_id, nextStage],
    );
  }
  const hook: ApprovalFinalizedHook = {
    event: 'approval.finalized', request_id: row.request_id, workspace_id: row.workspace_id,
    approval_type: payload.approval_type, authorization_revision: row.authorization_revision,
    authorization_hash: row.authorization_hash, expires_at: payload.authorization.expires_at,
    requester_agent_id: row.requester_agent_id, requester_member_id: row.requester_member_id,
    source_session_id: row.source_session_id, source_run_id: row.source_run_id,
    dependent_request_ids: payload.context.source.dependent_request_ids,
    run_plan_budget: payload.approval_type === 'run_plan' ? payload.details.budget : null,
    resource_bindings: payload.resource_bindings, finalized_at: finalizedAt,
  };
  const starter = await work.tx.query<{ tool_call_id: string | null }>(
    `SELECT tool_call_id FROM requests WHERE workspace_id=$1 AND id=$2`,
    [row.workspace_id, row.request_id],
  );
  if (starter.rows[0]?.tool_call_id?.startsWith('partner-first-search:') && row.requester_user_id) {
    const searchJob = await enqueueJob(
      work.tx,
      row.workspace_id,
      'partner_screening',
      `partner-screening:approved:${row.request_id}`,
      {
        agent_id: row.requester_agent_id,
        owner_user_id: row.requester_user_id,
        bucket: `approved:${row.request_id}`,
      },
    );
    if (searchJob) {
      await work.tx.query(`UPDATE approval_requests SET finalization_job_id=$2 WHERE request_id=$1`, [row.request_id, searchJob]);
      work.jobs.push(searchJob);
    }
    return;
  }
  const jobId = await enqueueJob(
    work.tx, row.workspace_id, 'approval_continue',
    `approval-finalized:${row.request_id}:${row.authorization_revision}:${row.authorization_hash}`, hook,
  );
  if (jobId) {
    await work.tx.query(`UPDATE approval_requests SET finalization_job_id = $2 WHERE request_id = $1`, [row.request_id, jobId]);
    // The handler now exists. Try immediately after commit; the durable row and
    // minute drain still cover an interrupted request or temporary blocker.
    work.jobs.push(jobId);
  }
}

export async function decideApproval(context: ApprovalHumanContext, requestId: string, rawInput: unknown): Promise<{ view: ApprovalView; duplicate: boolean }> {
  const input: DecideApprovalInput = decideApprovalInputSchema.parse(rawInput);
  const inputHash = await commandHash('decision', input);
  if (await commandReplay(context.tx, context.workspaceId, requestId, 'decision', input.idempotency_key, inputHash)) {
    return { view: await loadApprovalView(context.tx, requestId, context.userId), duplicate: true };
  }
  const row = await loadApprovalRow(context.tx, requestId, true);
  if (!row) throw new RouteError('no such approval request', 'unknown_approval', 404);
  assertBinding(row, input.expected_authorization_revision, input.expected_authorization_hash);
  if (row.status === 'pending' && asTime(row.expires_at).getTime() <= Date.now()) {
    await markExpired(context, row);
    return { view: await loadApprovalView(context.tx, requestId, context.userId), duplicate: false };
  }
  if (row.status !== 'pending') throw new RouteError(`this approval is ${row.status}`, 'approval_not_pending', 409);

  const payload = approvalPayloadSchema.parse(row.payload);
  const partnerEngagementChange = payload.approval_type === 'record_change'
    && payload.details.system_id === 'enterprise-partner-records';
  if (partnerEngagementChange && input.decision === 'request_changes') {
    throw new RouteError('Submit changed engagement terms as a fresh exact-source proposal.', 'approval_revision_forbidden', 409);
  }
  const members = await activeMembers(context.tx, context.workspaceId);
  const reviewer = members.find((member) => member.user_id === context.userId);
  if (!reviewer) throw new RouteError('the reviewer is not an active workspace member', 'reviewer_not_active', 403);
  if (payload.policy.prevent_self_review && reviewer.id === row.requester_member_id) throw new RouteError('self-review is not allowed by this policy', 'self_review_forbidden', 403);
  const votes = await votesFor(context.tx, row);
  if (payload.policy.require_distinct_reviewers && votes.some((vote) => vote.reviewer_member_id === reviewer.id)) {
    throw new RouteError('this reviewer already voted on the current revision', 'duplicate_reviewer', 409);
  }
  const assignments = await routeAssignments(context.tx, row);
  const state = progress(row, payload, members, votes, assignments);
  const eligibleSteps = payload.policy.steps.filter((step) => state.current.has(step.id) && step.reviewers.some((selector) => selectorMatches(reviewer, selector)));
  const step = eligibleSteps.find((candidate) => !assignments.has(candidate.id) || assignments.get(candidate.id) === reviewer.id);
  if (!step) throw new RouteError('this member is not a current eligible reviewer', 'reviewer_not_eligible', 403);
  if (votes.some((vote) => vote.step_id === step.id && vote.reviewer_member_id === reviewer.id)) throw new RouteError('this reviewer already voted on the current revision', 'duplicate_reviewer', 409);

  await context.tx.query(
    `INSERT INTO approval_votes
       (workspace_id, request_id, revision, authorization_hash, step_id, decision,
        reviewer_member_id, reviewer_user_id, note, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [context.workspaceId, requestId, row.authorization_revision, row.authorization_hash, step.id, input.decision, reviewer.id, reviewer.user_id, input.note, input.idempotency_key],
  );
  await recordCommand(context.tx, row, 'decision', input.idempotency_key, inputHash);
  await audit(context.tx, context.workspaceId, 'user', context.userId, 'approval.vote_recorded', requestId, row.source_session_id);

  if (input.decision !== 'approve') {
    const status = input.decision === 'decline' ? 'declined' : 'changes_requested';
    await context.tx.query(`UPDATE approval_requests SET status = $2, work_status = 'cancelled', work_reason = $3 WHERE request_id = $1`, [requestId, status, status === 'declined' ? 'The proposal was declined.' : 'A material revision is required.']);
    await context.tx.query(`UPDATE approval_revisions SET status = $3 WHERE request_id = $1 AND revision = $2`, [requestId, row.authorization_revision, status]);
    await context.tx.query(`UPDATE requests SET status = $2 WHERE id = $1`, [requestId, status]);
    await context.tx.query(
      `UPDATE partner_engagements SET stage=$3 WHERE workspace_id=$1 AND request_id=$2`,
      [context.workspaceId, requestId, input.decision === 'decline' ? 'declined' : 'changes_requested'],
    );
    if (partnerEngagementChange) {
      await context.tx.query(
        `UPDATE partner_engagement_authorizations SET status='declined'
          WHERE workspace_id=$1 AND approval_request_id=$2 AND authorization_revision=$3
            AND authorization_hash=$4 AND status='pending'`,
        [context.workspaceId, requestId, row.authorization_revision, row.authorization_hash],
      );
    }
  } else {
    const refreshedVotes = await votesFor(context.tx, row);
    const refreshed = progress(row, payload, members, refreshedVotes, assignments);
    const allApproved = payload.policy.steps.every((policyStep) => (refreshed.validApprovals.get(policyStep.id)?.size ?? 0) >= policyStep.quorum);
    if (allApproved) await finalizeApproval(context, row, payload);
  }
  await publishRequestChanged(context, requestId);
  return { view: await loadApprovalView(context.tx, requestId, context.userId), duplicate: false };
}

export async function reviseApproval(context: ApprovalHumanContext, requestId: string, rawInput: unknown): Promise<{ view: ApprovalView; duplicate: boolean }> {
  const input: ReviseApprovalInput = reviseApprovalInputSchema.parse(rawInput);
  const inputHash = await commandHash('revision', input);
  if (await commandReplay(context.tx, context.workspaceId, requestId, 'revision', input.idempotency_key, inputHash)) return { view: await loadApprovalView(context.tx, requestId, context.userId), duplicate: true };
  const row = await loadApprovalRow(context.tx, requestId, true);
  if (!row) throw new RouteError('no such approval request', 'unknown_approval', 404);
  assertBinding(row, input.expected_authorization_revision, input.expected_authorization_hash);
  if (!['pending', 'changes_requested'].includes(row.status)) throw new RouteError(`this approval is ${row.status}`, 'approval_not_revisable', 409);
  const oldPayload = approvalPayloadSchema.parse(row.payload);
  if (oldPayload.approval_type === 'record_change'
      && oldPayload.details.system_id === 'enterprise-partner-records') {
    throw new RouteError('Submit changed engagement terms as a fresh exact-source proposal.', 'approval_revision_forbidden', 409);
  }
  if (oldPayload.approval_type !== input.proposal.approval_type) throw new RouteError('a revision cannot change approval type', 'approval_type_changed', 422);
  const members = await activeMembers(context.tx, context.workspaceId);
  const actor = members.find((member) => member.user_id === context.userId);
  if (!actor || (actor.role !== 'admin' && actor.id !== row.requester_member_id)) throw new RouteError('only the requester or an Admin may submit a revision', 'revision_forbidden', 403);

  const targetInput = {
    target_agent_ids: oldPayload.context.target_agent_ids,
    target_member_ids: oldPayload.context.target_member_ids,
    target_resource_ids: oldPayload.context.target_resource_ids,
    dependent_request_ids: oldPayload.context.source.dependent_request_ids,
  };
  const targets = await validatedTargetContext(context.tx, context.workspaceId, input.proposal, targetInput);
  const selected = await selectPolicy(context.tx, context.workspaceId, input.proposal, row.requester_agent_id, targets.targetResourceIds, oldPayload.policy.key);
  await validatePartnerOutreachContact(
    context.tx, context.workspaceId, row.requester_agent_id, selected.row.key, input.proposal, requestId,
  );
  validatePolicyFeasibility(selected.policy, members, row.requester_member_id, targets.requiredOwnerIds);
  const maximumExpiry = Date.now() + selected.row.max_duration_seconds * 1000;
  const expiry = input.requested_expires_at ? Date.parse(input.requested_expires_at) : maximumExpiry;
  if (!Number.isFinite(expiry) || expiry <= Date.now() || expiry > maximumExpiry) throw new RouteError('the requested expiry is outside the selected policy limit', 'invalid_expiry', 422);
  const expiresAt = new Date(expiry).toISOString();
  const bindings = await resolveResourceBindings(
    context.tx, context.workspaceId, input.proposal, targets.resources,
    {
      userId: oldPayload.context.requester.user_id,
      runId: oldPayload.context.source.run_id,
      agentId: oldPayload.context.requester.agent_id,
    },
  );
  const serverContext = { ...oldPayload.context, target_agent_ids: targets.targetAgentIds, target_member_ids: targets.targetMemberIds, target_resource_ids: targets.targetResourceIds, source: { ...oldPayload.context.source, dependent_request_ids: targets.dependentRequestIds } };
  const nextRevision = row.authorization_revision + 1;
  const hash = await authorizationHash({ proposal: input.proposal, context: serverContext, policy: selected.policy, resource_bindings: bindings, expires_at: expiresAt });
  if (hash === row.authorization_hash) throw new RouteError('the revision does not materially change the authorization', 'unchanged_revision', 422);
  const payload = approvalPayloadSchema.parse({ ...input.proposal, context: serverContext, authorization: { revision: nextRevision, hash, expires_at: expiresAt }, policy: selected.policy, resource_bindings: bindings });
  const effect = effectFor(input.proposal, bindings);

  await context.tx.query(`UPDATE approval_revisions SET status = 'superseded', superseded_at = now() WHERE request_id = $1 AND revision = $2`, [requestId, row.authorization_revision]);
  await context.tx.query(
    `INSERT INTO approval_revisions (workspace_id, request_id, revision, authorization_hash, payload, status, created_by_type, created_by_user_id)
     VALUES ($1,$2,$3,$4,$5::jsonb,'pending','user',$6)`, [context.workspaceId, requestId, nextRevision, hash, JSON.stringify(payload), context.userId],
  );
  await context.tx.query(
    `UPDATE approval_requests SET policy_id=$2, policy_version=$3, authorization_revision=$4,
       authorization_hash=$5, status='pending', expires_at=$6, effect_kind=$7, effect_status=$8,
       effect_reason=$9, work_status='waiting', work_reason=NULL, finalized_at=NULL
     WHERE request_id=$1`, [requestId, selected.row.id, selected.row.version, nextRevision, hash, expiresAt, effect.kind, effect.status, effect.reason],
  );
  await context.tx.query(
    `UPDATE requests SET payload = $2::jsonb, status = 'pending' WHERE id = $1
     RETURNING EXTRACT(EPOCH FROM updated_at)::int AS version`, [requestId, JSON.stringify(payload)],
  );
  await recordCommand(context.tx, row, 'revision', input.idempotency_key, inputHash);
  await audit(context.tx, context.workspaceId, 'user', context.userId, 'approval.revised', requestId, row.source_session_id);
  await publishRequestChanged(context, requestId);
  return { view: await loadApprovalView(context.tx, requestId, context.userId), duplicate: false };
}

export async function routeApproval(context: ApprovalHumanContext, requestId: string, rawInput: unknown): Promise<{ view: ApprovalView; duplicate: boolean }> {
  const input: RouteApprovalInput = routeApprovalInputSchema.parse(rawInput);
  const inputHash = await commandHash('route', input);
  if (await commandReplay(context.tx, context.workspaceId, requestId, 'route', input.idempotency_key, inputHash)) return { view: await loadApprovalView(context.tx, requestId, context.userId), duplicate: true };
  const row = await loadApprovalRow(context.tx, requestId, true);
  if (!row) throw new RouteError('no such approval request', 'unknown_approval', 404);
  assertBinding(row, input.expected_authorization_revision, input.expected_authorization_hash);
  if (row.status !== 'pending' || asTime(row.expires_at).getTime() <= Date.now()) throw new RouteError('only a current pending approval can be routed', 'approval_not_pending', 409);
  const members = await activeMembers(context.tx, context.workspaceId);
  const actor = members.find((member) => member.user_id === context.userId);
  if (!actor || actor.role !== 'admin') throw new RouteError('routing an approval needs an Admin', 'admin_required', 403);
  const target = members.find((member) => member.id === input.reviewer_member_id);
  if (!target) throw new RouteError('the routed reviewer is not active in this workspace', 'invalid_reviewer', 422);
  const payload = approvalPayloadSchema.parse(row.payload);
  const step = payload.policy.steps.find((candidate) => candidate.id === input.step_id);
  if (!step || !step.reviewers.some((selector) => selectorMatches(target, selector))) throw new RouteError('the routed member is not eligible under the immutable policy', 'reviewer_not_eligible', 422);
  if (payload.policy.prevent_self_review && target.id === row.requester_member_id) throw new RouteError('self-review is not allowed by this policy', 'self_review_forbidden', 422);
  if (payload.policy.require_distinct_reviewers) {
    const votes = await votesFor(context.tx, row);
    const assignments = await routeAssignments(context.tx, row);
    if (votes.some((vote) => vote.reviewer_member_id === target.id && vote.step_id !== input.step_id)
      || [...assignments].some(([stepId, memberId]) => stepId !== input.step_id && memberId === target.id)) {
      throw new RouteError('a routed member cannot satisfy more than one step', 'distinct_reviewer_required', 422);
    }
  }
  await context.tx.query(
    `INSERT INTO approval_routes (workspace_id, request_id, revision, step_id, reviewer_member_id, routed_by_member_id, reason, idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`, [context.workspaceId, requestId, row.authorization_revision, input.step_id, target.id, actor.id, input.reason, input.idempotency_key],
  );
  await recordCommand(context.tx, row, 'route', input.idempotency_key, inputHash);
  await audit(context.tx, context.workspaceId, 'user', context.userId, 'approval.routed', requestId, row.source_session_id);
  await publishRequestChanged(context, requestId);
  return { view: await loadApprovalView(context.tx, requestId, context.userId), duplicate: false };
}
