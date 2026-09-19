// Durable approval continuation admission.
//
// A final human approval does not revive a native Python stack. It authorizes
// one fresh linked enterprise run. This module re-reads the current ApprovalView,
// locks the persisted intent, rechecks identity/profile/session/dependencies,
// binds an enforceable run-plan budget and inserts at most one run. Creating the
// Workflow instance is deliberately post-commit and replay-safe.
import {
  approvalFinalizedHookSchema,
  approvalViewSchema,
  type ApprovalFinalizedHook,
  type ApprovalView,
} from '@hermes/shared';
import type { Tx } from '../db/client.js';
import type { Env } from '../env.js';
import { isEnginePaused } from '../env.js';
import { DEFAULT_MAX_TURNS } from '../engine/constants.js';
import { isProviderAllowed } from '../model/allowed.js';
import { checkCaps } from '../model/usage.js';
import { consumeInstanceCap } from '../ops/instance-cap.js';
import { runAttemptInstanceId } from '../runs/instance-id.js';
import { resolveRuntimeBinding } from './config.js';
import type { ApprovalContinuationIntent } from './continuation-intent.js';

export {
  persistApprovalContinuation,
  type PersistContinuationInput,
} from './continuation-intent.js';

export const CONTINUATION_CAPABLE_APPROVAL_TYPES = ['run_plan'] as const;

export interface ApprovalContinuationRow {
  readonly id: string;
  readonly request_id: string;
  readonly authorization_revision: number;
  readonly authorization_hash: string;
  readonly agent_id: string;
  readonly runtime_profile: string;
  readonly session_id: string;
  readonly source_run_id: string | null;
  readonly continuation_payload: ApprovalContinuationIntent;
  readonly dependency_request_ids: string[];
  readonly state: string;
  readonly expires_at: Date;
  readonly admitted_run_id: string | null;
}

/**
 * A normal run may be retried whenever the existing route permits it. An
 * approved continuation additionally stays inside the reviewed retry count,
 * expiry, current authorization, and remaining hard budget.
 */
export async function approvalContinuationRetryBlock(
  tx: Tx,
  runId: string,
  nextAttempt: number,
  now: Date = new Date(),
): Promise<string | null> {
  const { rows } = await tx.query<{
    continuation_id: string;
    continuation_state: string;
    expires_at: Date;
    approval_status: string;
    work_status: string;
    budget_state: string | null;
    retry_cap: number | null;
  }>(
    `SELECT c.id AS continuation_id, c.state AS continuation_state, c.expires_at,
            ar.status AS approval_status, ar.work_status,
            b.state AS budget_state, b.retry_cap
       FROM approval_continuations c
       JOIN approval_requests ar
         ON ar.request_id = c.request_id
        AND ar.authorization_revision = c.authorization_revision
        AND ar.authorization_hash = c.authorization_hash
       LEFT JOIN approval_runtime_budgets b ON b.continuation_id = c.id
      WHERE c.admitted_run_id = $1
      FOR UPDATE OF c, ar`,
    [runId],
  );
  const linked = rows[0];
  if (!linked) return null;
  if (linked.continuation_state !== 'admitted' || linked.approval_status !== 'approved' || linked.work_status !== 'admitted') {
    return 'approval_retry_authorization_stale';
  }
  if (linked.expires_at.getTime() <= now.getTime()) return 'approval_retry_authorization_expired';
  if (linked.budget_state !== 'active') return 'approval_retry_budget_exhausted';
  if (linked.retry_cap === null || nextAttempt > linked.retry_cap + 1) return 'approval_retry_limit';
  await tx.query(
    `UPDATE approval_requests
        SET work_reason = NULL
      WHERE request_id = (SELECT request_id FROM approval_continuations WHERE id = $1)`,
    [linked.continuation_id],
  );
  return null;
}

export type ContinuationAdmission =
  | { readonly status: 'no_intent'; readonly reason: string }
  | { readonly status: 'blocked' | 'refused'; readonly continuationId: string; readonly reason: string }
  | {
      readonly status: 'admitted' | 'already_admitted';
      readonly continuationId: string;
      readonly runId: string;
      readonly instance: {
        readonly runId: string;
        readonly workspaceId: string;
        readonly sessionId: string;
        readonly attempt: number;
        readonly engineVersion: number;
        readonly traceId: string;
      };
      readonly message: {
        readonly id: string;
        readonly seq: number;
        readonly text: string;
      } | null;
    };

const ACCEPTED_DEPENDENCY_STATUSES = new Set(['approved', 'admitted', 'created', 'drafted']);

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

async function sha256(value: unknown): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

const version = (value: Date | string | null): string | null =>
  value instanceof Date ? value.toISOString() : value;

async function resourceBindingDrift(tx: Tx, view: ApprovalView): Promise<string | null> {
  for (const binding of view.payload.resource_bindings) {
    if (!binding.immutable || !binding.sha256) return `resource_binding_unverifiable:${binding.kind}:${binding.id}`;
    let currentVersion: string | null = null;
    let currentHash: string | null = null;
    switch (binding.kind) {
      case 'resource': {
        const row = (await tx.query<{ version: string | null; sha256: string | null }>(
          `SELECT version, sha256 FROM approval_resources
            WHERE workspace_id = $1 AND resource_key = $2 AND active`,
          [view.workspace_id, binding.id],
        )).rows[0];
        currentVersion = row?.version ?? null;
        currentHash = row?.sha256 ?? null;
        break;
      }
      case 'attachment': {
        const row = (await tx.query<{ completed_at: string | null; sha256: string | null }>(
          `SELECT completed_at::text, sha256 FROM attachments
            WHERE workspace_id = $1 AND id = $2 AND status = 'ready'`,
          [view.workspace_id, binding.id],
        )).rows[0];
        currentVersion = row?.completed_at ?? null;
        currentHash = row?.sha256 ?? null;
        break;
      }
      case 'agent_file': {
        const row = (await tx.query<{ updated_at: string | null; sha256: string | null }>(
          `SELECT updated_at::text, sha256 FROM agent_files
            WHERE workspace_id = $1 AND id = $2 AND sha256 IS NOT NULL`,
          [view.workspace_id, binding.id],
        )).rows[0];
        currentVersion = row?.updated_at ?? null;
        currentHash = row?.sha256 ?? null;
        break;
      }
      case 'document': {
        const row = (await tx.query<{ version: number; payload: unknown }>(
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
                      JOIN enterprise_connection_bindings connector ON connector.id=grant.connection_binding_id
                      WHERE execution.workspace_id=document.workspace_id
                        AND execution.request_id=document.request_id
                        AND grant.run_id=$4 AND grant.capability='partner.shared.read'
                        AND grant.effect='allow' AND grant.revoked_at IS NULL
                        AND 'read_shared'=ANY(grant.allowed_actions)
                        AND assignment.state='active' AND assignment.revision=grant.assignment_revision
                        AND connector.state='active' AND NOT (grant.capability=ANY(connector.capability_denies))
                    )
                  )
                )
              )`,
          [view.workspace_id, binding.id, view.payload.context.requester.user_id, view.payload.context.source.run_id],
        )).rows[0];
        currentVersion = row ? String(row.version) : null;
        currentHash = row ? await sha256(row.payload) : null;
        break;
      }
      case 'request': {
        const row = (await tx.query<{ updated_at: Date | string; payload: unknown }>(
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
                      JOIN enterprise_connection_bindings connector ON connector.id=grant.connection_binding_id
                      WHERE execution.workspace_id=request.workspace_id
                        AND execution.request_id=request.id
                        AND grant.run_id=$4 AND grant.capability='partner.shared.read'
                        AND grant.effect='allow' AND grant.revoked_at IS NULL
                        AND 'read_shared'=ANY(grant.allowed_actions)
                        AND assignment.state='active' AND assignment.revision=grant.assignment_revision
                        AND connector.state='active' AND NOT (grant.capability=ANY(connector.capability_denies))
                    )
                  )
                )
              )`,
          [view.workspace_id, binding.id, view.payload.context.requester.user_id, view.payload.context.source.run_id],
        )).rows[0];
        currentVersion = row ? version(row.updated_at) : null;
        currentHash = row ? await sha256(row.payload) : null;
        break;
      }
      case 'run': {
        const row = (await tx.query<{ status: string; ended_at: Date | string | null; runtime_request: unknown }>(
          `SELECT status, ended_at, runtime_request FROM runs WHERE workspace_id = $1 AND id = $2`,
          [view.workspace_id, binding.id],
        )).rows[0];
        const terminal = Boolean(row?.ended_at && ['completed', 'stopped', 'error'].includes(row.status));
        currentVersion = terminal && row ? version(row.ended_at) : null;
        currentHash = terminal && row ? await sha256(row.runtime_request ?? {}) : null;
        break;
      }
      case 'artifact': {
        if (view.payload.approval_type === 'communication' && binding.id === 'communication-body') {
          currentVersion = null;
          currentHash = await sha256({
            sender: view.payload.details.sender,
            recipients: view.payload.details.recipients,
            subject: view.payload.details.subject,
            body: view.payload.details.body,
          });
        } else if (view.payload.approval_type === 'deliverable' && binding.id === view.payload.details.artifact_id) {
          currentVersion = view.payload.details.version;
          currentHash = await sha256(view.payload.details.content);
        }
        break;
      }
      default:
        return `resource_binding_unsupported:${binding.kind}:${binding.id}`;
    }
    if (currentVersion !== binding.version || currentHash !== binding.sha256) {
      return `resource_binding_changed:${binding.kind}:${binding.id}`;
    }
  }
  return null;
}

function terminalState(status: ApprovalView['status']): string {
  switch (status) {
    case 'declined': return 'declined';
    case 'changes_requested': return 'changes_requested';
    case 'expired': return 'expired';
    case 'superseded': return 'superseded';
    case 'withdrawn': return 'cancelled';
    default: return 'superseded';
  }
}

async function move(
  tx: Tx,
  continuationId: string,
  state: string,
  reason: string,
): Promise<void> {
  await tx.query(
    `UPDATE approval_continuations
        SET state = $2, blocked_reason = $3
      WHERE id = $1 AND state <> 'admitted'`,
    [continuationId, state, reason.slice(0, 1000)],
  );
  await tx.query(
    `UPDATE approval_requests ar
        SET work_status = CASE WHEN $2 IN ('blocked_profile','blocked_dependencies','ready') THEN 'waiting' ELSE 'cancelled' END,
            work_reason = $3,
            continuation_id = c.id
       FROM approval_continuations c
      WHERE c.id = $1 AND ar.request_id = c.request_id
        AND ar.authorization_revision = c.authorization_revision`,
    [continuationId, state, reason.slice(0, 1000)],
  );
}

function currentHookBinding(hook: ApprovalFinalizedHook, view: ApprovalView): string | null {
  if (view.request_id !== hook.request_id || view.workspace_id !== hook.workspace_id) return 'approval_identity_changed';
  if (view.status !== 'approved') return `authorization_${view.status}`;
  if (view.payload.approval_type !== hook.approval_type) return 'approval_type_changed';
  if (view.payload.authorization.revision !== hook.authorization_revision ||
      view.payload.authorization.hash !== hook.authorization_hash ||
      view.payload.authorization.expires_at !== hook.expires_at) return 'authorization_revision_changed';
  if (view.payload.context.requester.agent_id !== hook.requester_agent_id ||
      view.payload.context.requester.member_id !== hook.requester_member_id ||
      view.payload.context.source.session_id !== hook.source_session_id ||
      view.payload.context.source.run_id !== hook.source_run_id) return 'approval_source_changed';
  if (view.finalized_at !== hook.finalized_at) return 'approval_finalization_changed';
  const hookDependencies = [...hook.dependent_request_ids].sort();
  const viewDependencies = [...view.payload.context.source.dependent_request_ids].sort();
  if (JSON.stringify(hookDependencies) !== JSON.stringify(viewDependencies)) return 'approval_dependencies_changed';
  return null;
}

function exactBinding(hook: ApprovalFinalizedHook, view: ApprovalView, intent: ApprovalContinuationRow): string | null {
  const current = currentHookBinding(hook, view);
  if (current) return current;
  if (intent.authorization_revision !== hook.authorization_revision ||
      intent.authorization_hash !== hook.authorization_hash ||
      intent.expires_at.toISOString() !== new Date(hook.expires_at).toISOString()) return 'continuation_revision_changed';
  if (intent.source_run_id !== hook.source_run_id) return 'continuation_source_changed';
  const targetAllowed = intent.agent_id === hook.requester_agent_id ||
    view.payload.context.target_agent_ids.includes(intent.agent_id);
  if (!targetAllowed) return 'continuation_target_not_authorized';
  const hookDependencies = [...hook.dependent_request_ids].sort();
  const intentDependencies = [...intent.dependency_request_ids].sort();
  if (JSON.stringify(hookDependencies) !== JSON.stringify(intentDependencies)) return 'continuation_dependencies_changed';
  return null;
}

/** The reviewed payload, not model-authored hidden instructions, seeds the new run. */
export function reviewedContinuationMessage(view: ApprovalView): string {
  const payload = view.payload;
  return JSON.stringify({
    kind: 'approved_continuation',
    request_id: view.request_id,
    authorization: payload.authorization,
    approval_type: payload.approval_type,
    summary: payload.summary,
    consequence: payload.consequence,
    details: payload.details,
    evidence: payload.evidence,
    resource_bindings: payload.resource_bindings,
    guardrails: [
      'Continue only the reviewed authorization above.',
      'Current enterprise permissions and tool gates still apply.',
      'Approval does not execute an external provider effect.',
    ],
  });
}

/**
 * Called inside the app-role transaction that consumes `approval_continue`.
 * `currentApproval` must be loaded from the server approval domain in this same
 * transaction; the hook payload alone is never authorization.
 */
export async function admitApprovalContinuation(
  tx: Tx,
  env: Env,
  rawHook: unknown,
  rawCurrentApproval: unknown,
  now: Date = new Date(),
): Promise<ContinuationAdmission> {
  const hook = approvalFinalizedHookSchema.parse(rawHook);
  const currentApproval = approvalViewSchema.parse(rawCurrentApproval);
  const { rows } = await tx.query<ApprovalContinuationRow>(
    `SELECT id, request_id, authorization_revision, authorization_hash, agent_id, runtime_profile,
            session_id, source_run_id, continuation_payload, dependency_request_ids,
            state, expires_at, admitted_run_id
       FROM approval_continuations
      WHERE workspace_id = $1 AND request_id = $2 AND authorization_revision = $3
      FOR UPDATE`,
    [hook.workspace_id, hook.request_id, hook.authorization_revision],
  );
  const intent = rows[0];
  if (!intent) {
    const mismatch = currentHookBinding(hook, currentApproval);
    if (mismatch) return { status: 'no_intent', reason: mismatch };
    await tx.query(
      `UPDATE approval_requests
          SET work_status = 'completed', work_reason = 'no_runtime_continuation_requested'
        WHERE workspace_id = $1 AND request_id = $2
          AND authorization_revision = $3 AND authorization_hash = $4
          AND status = 'approved'`,
      [hook.workspace_id, hook.request_id, hook.authorization_revision, hook.authorization_hash],
    );
    return { status: 'no_intent', reason: 'approval has no continuation intent' };
  }

  if (intent.state === 'admitted' && intent.admitted_run_id) {
    const run = await tx.query<{ id: string; session_id: string; attempt: number; engine_version: number; trace_id: string }>(
      `SELECT id, session_id, attempt, engine_version, trace_id FROM runs WHERE id = $1`,
      [intent.admitted_run_id],
    );
    const existing = run.rows[0];
    if (!existing) {
      await move(tx, intent.id, 'failed', 'admitted_run_missing');
      return { status: 'refused', continuationId: intent.id, reason: 'admitted_run_missing' };
    }
    return {
      status: 'already_admitted', continuationId: intent.id, runId: existing.id,
      instance: {
        runId: existing.id, workspaceId: hook.workspace_id, sessionId: existing.session_id,
        attempt: existing.attempt, engineVersion: existing.engine_version, traceId: existing.trace_id,
      },
      message: null,
    };
  }
  if (['completed', 'declined', 'changes_requested', 'expired', 'superseded', 'cancelled', 'failed'].includes(intent.state)) {
    return { status: 'refused', continuationId: intent.id, reason: `continuation_${intent.state}` };
  }

  const mismatch = exactBinding(hook, currentApproval, intent);
  if (mismatch) {
    const next = currentApproval.status === 'approved' ? 'superseded' : terminalState(currentApproval.status);
    await move(tx, intent.id, next, mismatch);
    return { status: 'refused', continuationId: intent.id, reason: mismatch };
  }
  if (now.getTime() >= new Date(hook.expires_at).getTime()) {
    await move(tx, intent.id, 'expired', 'authorization_expired');
    return { status: 'refused', continuationId: intent.id, reason: 'authorization_expired' };
  }
  if (!(CONTINUATION_CAPABLE_APPROVAL_TYPES as readonly string[]).includes(hook.approval_type)) {
    await move(tx, intent.id, 'failed', 'approval_type_has_no_runtime_executor');
    return { status: 'refused', continuationId: intent.id, reason: 'approval_type_has_no_runtime_executor' };
  }
  const mutable = currentApproval.payload.resource_bindings.find((resource) => !resource.immutable);
  if (mutable) {
    await move(tx, intent.id, 'failed', 'reviewed_resource_is_mutable');
    return { status: 'refused', continuationId: intent.id, reason: 'reviewed_resource_is_mutable' };
  }
  const hookBindings = canonical([...hook.resource_bindings].sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`)));
  const viewBindings = canonical([...currentApproval.payload.resource_bindings].sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`)));
  if (hookBindings !== viewBindings) {
    await move(tx, intent.id, 'superseded', 'resource_binding_hook_changed');
    return { status: 'refused', continuationId: intent.id, reason: 'resource_binding_hook_changed' };
  }
  const drift = await resourceBindingDrift(tx, currentApproval);
  if (drift) {
    await move(tx, intent.id, 'failed', drift);
    return { status: 'refused', continuationId: intent.id, reason: drift };
  }

  // Approval narrows what a run may do; it never widens the ordinary engine
  // envelope. These are intentionally checked again at admission rather than
  // trusting the conditions that existed when a human cast the final vote.
  if (isEnginePaused(env)) {
    await move(tx, intent.id, 'blocked_profile', 'engine_paused');
    return { status: 'blocked', continuationId: intent.id, reason: 'engine_paused' };
  }
  const caps = await checkCaps(tx, hook.workspace_id);
  if (!caps.allowed) {
    const reason = `workspace_${caps.reason ?? 'cap_exceeded'}`;
    await move(tx, intent.id, 'blocked_dependencies', reason);
    return { status: 'blocked', continuationId: intent.id, reason };
  }

  if (intent.source_run_id) {
    const source = await tx.query<{ stop_requested: boolean; status: string }>(
      `SELECT stop_requested, status FROM runs WHERE id = $1`, [intent.source_run_id],
    );
    if (!source.rows[0] || source.rows[0].stop_requested || source.rows[0].status === 'stopped') {
      await move(tx, intent.id, 'cancelled', 'source_run_stopped');
      return { status: 'refused', continuationId: intent.id, reason: 'source_run_stopped' };
    }
  }

  if (hook.dependent_request_ids.length > 0) {
    const dependencies = await tx.query<{ id: string; status: string }>(
      `SELECT id, status FROM requests WHERE id = ANY($1::uuid[])`, [hook.dependent_request_ids],
    );
    const byId = new Map(dependencies.rows.map((row) => [row.id, row.status]));
    const blocked = hook.dependent_request_ids.find((id) => !ACCEPTED_DEPENDENCY_STATUSES.has(byId.get(id) ?? 'missing'));
    if (blocked) {
      await move(tx, intent.id, 'blocked_dependencies', `dependency_not_ready:${blocked}`);
      return { status: 'blocked', continuationId: intent.id, reason: `dependency_not_ready:${blocked}` };
    }
  }

  const sessionResult = await tx.query<{
    session_id: string;
    agent_id: string;
    owner_id: string;
    read_only: boolean;
    model_id: string;
    effort: string | null;
    agent_status: string;
    model_provider: string;
    model_transport: string;
    model_disabled_reason: string | null;
    model_supports_tools: boolean;
    responsible_member_id: string | null;
    responsible_member_status: string | null;
  }>(
    `SELECT s.id AS session_id, s.agent_id, s.owner_id, s.read_only, s.model_id, s.effort,
            a.status AS agent_status, m.provider AS model_provider, m.transport AS model_transport,
            m.disabled_reason AS model_disabled_reason, m.supports_tools AS model_supports_tools,
            ao.member_id AS responsible_member_id, owner.status AS responsible_member_status
       FROM sessions s JOIN agents a ON a.id = s.agent_id AND a.workspace_id = s.workspace_id
       JOIN catalog m ON m.model_id = s.model_id
       LEFT JOIN agent_owners ao ON ao.agent_id = a.id AND ao.workspace_id = a.workspace_id
       LEFT JOIN members owner ON owner.id = ao.member_id AND owner.workspace_id = a.workspace_id
      WHERE s.id = $1 AND s.workspace_id = $2 AND s.agent_id = $3`,
    [intent.session_id, hook.workspace_id, intent.agent_id],
  );
  const session = sessionResult.rows[0];
  if (!session || session.read_only || session.agent_status !== 'started' ||
      !session.responsible_member_id || session.responsible_member_status !== 'active') {
    await move(tx, intent.id, 'failed', 'agent_or_session_not_available');
    return { status: 'refused', continuationId: intent.id, reason: 'agent_or_session_not_available' };
  }
  const runtimeModel =
    (session.model_provider === 'openrouter' && session.model_transport === 'openrouter_chat') ||
    (session.model_provider === 'nous_portal' && session.model_transport === 'nous_chat');
  if (!runtimeModel ||
      session.model_disabled_reason !== null || !session.model_supports_tools ||
      !isProviderAllowed(env, session.model_provider)) {
    await move(tx, intent.id, 'failed', 'approved_model_not_runtime_supported');
    return { status: 'refused', continuationId: intent.id, reason: 'approved_model_not_runtime_supported' };
  }
  if (env.MODEL_SCRIPTED !== '1') {
    const key = await tx.query<{ status: string }>(
      `SELECT status FROM workspace_provider_keys
        WHERE workspace_id = $1 AND provider = $2 AND revoked_at IS NULL LIMIT 1`,
      [hook.workspace_id, session.model_provider],
    );
    if (!['verified', 'verified_scoped'].includes(key.rows[0]?.status ?? '')) {
      await move(tx, intent.id, 'blocked_profile', 'provider_key_not_verified');
      return { status: 'blocked', continuationId: intent.id, reason: 'provider_key_not_verified' };
    }
  }
  let profile: string;
  try {
    profile = (await resolveRuntimeBinding(env, tx, hook.workspace_id, intent.agent_id)).profile;
  } catch {
    await move(tx, intent.id, 'blocked_profile', 'runtime_profile_not_configured');
    return { status: 'blocked', continuationId: intent.id, reason: 'runtime_profile_not_configured' };
  }
  if (profile !== intent.runtime_profile) {
    await move(tx, intent.id, 'failed', 'runtime_profile_binding_changed');
    return { status: 'refused', continuationId: intent.id, reason: 'runtime_profile_binding_changed' };
  }
  await tx.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`approval-continuation:${intent.agent_id}`]);
  const busy = await tx.query<{ id: string }>(
    `SELECT id FROM runs
      WHERE workspace_id = $1 AND agent_id = $2 AND status IN ('working','waiting','stopping')
      LIMIT 1`,
    [hook.workspace_id, intent.agent_id],
  );
  if (busy.rows[0]) {
    await move(tx, intent.id, 'blocked_dependencies', 'runtime_profile_busy');
    return { status: 'blocked', continuationId: intent.id, reason: 'runtime_profile_busy' };
  }

  const reviewedBudget = currentApproval.payload.approval_type === 'run_plan'
    ? currentApproval.payload.details.budget
    : null;
  if (canonical(hook.run_plan_budget) !== canonical(reviewedBudget)) {
    await move(tx, intent.id, 'superseded', 'run_plan_budget_hook_changed');
    return { status: 'refused', continuationId: intent.id, reason: 'run_plan_budget_hook_changed' };
  }
  const budget = reviewedBudget;
  if (!budget || currentApproval.payload.illustrative || budget.illustrative || budget.currency !== 'USD' ||
      budget.retries_included >= budget.call_cap ||
      !budget.model_ids.includes(session.model_id)) {
    await move(tx, intent.id, 'failed', 'approved_budget_not_enforceable');
    return { status: 'refused', continuationId: intent.id, reason: 'approved_budget_not_enforceable' };
  }

  const platformCapacity = await consumeInstanceCap(tx, env);
  if (!platformCapacity.allowed) {
    await move(tx, intent.id, 'blocked_dependencies', 'platform_capacity');
    return { status: 'blocked', continuationId: intent.id, reason: 'platform_capacity' };
  }

  const existingBudget = await tx.query<{
    id: string;
    model_id: string;
    authorization_hash: string;
    authorization_revision: number;
  }>(`SELECT id, model_id, authorization_hash, authorization_revision
        FROM approval_runtime_budgets WHERE continuation_id = $1`, [intent.id]);
  if (existingBudget.rows[0] && (
    existingBudget.rows[0].model_id !== session.model_id ||
    existingBudget.rows[0].authorization_hash !== hook.authorization_hash ||
    existingBudget.rows[0].authorization_revision !== hook.authorization_revision
  )) {
    await move(tx, intent.id, 'failed', 'budget_binding_conflict');
    return { status: 'refused', continuationId: intent.id, reason: 'budget_binding_conflict' };
  }
  await tx.query(
    `INSERT INTO approval_runtime_budgets (
       workspace_id, continuation_id, request_id, authorization_revision, authorization_hash,
       model_id, currency, cost_cap_usd, total_token_cap, call_cap,
       max_output_tokens_per_call, max_parallel_calls, retry_cap
     ) VALUES ($1,$2,$3,$4,$5,$6,'USD',$7,$8,$9,$10,$11,$12)
     ON CONFLICT (continuation_id) DO NOTHING`,
    [
      hook.workspace_id, intent.id, hook.request_id, hook.authorization_revision, hook.authorization_hash,
      session.model_id, budget.cap_minor / 100, budget.total_token_cap, budget.call_cap,
      budget.max_output_tokens_per_call, Math.min(1, budget.max_parallel_calls), budget.retries_included,
    ],
  );

  const runId = crypto.randomUUID();
  const traceId = crypto.randomUUID();
  const engineVersion = Number(env.ENGINE_VERSION ?? '1') || 1;
  const instanceId = runAttemptInstanceId(runId, 1);
  const clientTurnId = `approval-continuation:${intent.id}:${hook.authorization_revision}`;
  const messageText = reviewedContinuationMessage(currentApproval);
  let insertedRunId: string | undefined;
  await tx.query('SAVEPOINT approval_continuation_run');
  try {
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO runs (
         id, workspace_id, session_id, agent_id, status, model_id, effort, max_turns,
         trace_id, workflow_instance_id, attempt, engine_version, client_turn_id, mode,
         runtime_kind, runtime_profile
       ) VALUES ($1,$2,$3,$4,'working',$5,$6,$7,$8,$9,1,$10,$11,'work','hermes',$12)
       ON CONFLICT (session_id, client_turn_id) DO NOTHING
       RETURNING id`,
      [
        runId, hook.workspace_id, intent.session_id, intent.agent_id, session.model_id, session.effort,
        Math.min(DEFAULT_MAX_TURNS, budget.call_cap), traceId, instanceId, engineVersion, clientTurnId, profile,
      ],
    );
    insertedRunId = inserted.rows[0]?.id;
    await tx.query('RELEASE SAVEPOINT approval_continuation_run');
  } catch (error) {
    await tx.query('ROLLBACK TO SAVEPOINT approval_continuation_run');
    if ((error as { code?: string }).code !== '23505') throw error;
  }
  let admittedRunId = insertedRunId;
  if (!admittedRunId) {
    const prior = await tx.query<{ id: string }>(
      `SELECT id FROM runs WHERE session_id = $1 AND client_turn_id = $2`, [intent.session_id, clientTurnId],
    );
    admittedRunId = prior.rows[0]?.id;
  }
  if (!admittedRunId) {
    await move(tx, intent.id, 'blocked_dependencies', 'session_run_in_flight');
    return { status: 'blocked', continuationId: intent.id, reason: 'session_run_in_flight' };
  }
  let continuationMessage: { id: string; seq: number; text: string } | null = null;
  if (insertedRunId) {
    const sequence = await tx.query<{ seq: number }>(
      `UPDATE sessions SET next_seq = next_seq + 1, last_activity_at = now()
        WHERE id = $1 RETURNING next_seq - 1 AS seq`,
      [intent.session_id],
    );
    const message = await tx.query<{ id: string }>(
      `INSERT INTO messages (workspace_id, session_id, seq, role, kind, text, status, run_id, turn)
       VALUES ($1,$2,$3,'system','approval_continuation',$4,'complete',$5,0)
       RETURNING id`,
      [hook.workspace_id, intent.session_id, sequence.rows[0]?.seq ?? 0, messageText, admittedRunId],
    );
    continuationMessage = {
      id: message.rows[0]?.id ?? '',
      seq: sequence.rows[0]?.seq ?? 0,
      text: messageText,
    };
    await tx.query(
      `INSERT INTO run_turns (workspace_id, run_id, turn, seq, role, provider_message)
       VALUES ($1,$2,0,0,'user',$3::jsonb)`,
      [hook.workspace_id, admittedRunId, JSON.stringify({ role: 'user', content: messageText })],
    );
  }
  await tx.query(
    `UPDATE approval_continuations
        SET state = 'admitted', admitted_run_id = $2, admitted_at = now(), blocked_reason = NULL
      WHERE id = $1 AND state <> 'admitted'`,
    [intent.id, admittedRunId],
  );
  const projected = await tx.query(
    `UPDATE approval_requests
        SET work_status = 'admitted', work_reason = NULL, continuation_id = $2
      WHERE request_id = $1 AND authorization_revision = $3
        AND authorization_hash = $4 AND status = 'approved'`,
    [hook.request_id, intent.id, hook.authorization_revision, hook.authorization_hash],
  );
  if (projected.rowCount !== 1) throw new Error('approval_continuation_projection_stale');
  return {
    status: insertedRunId ? 'admitted' : 'already_admitted',
    continuationId: intent.id,
    runId: admittedRunId,
    instance: {
      runId: admittedRunId, workspaceId: hook.workspace_id, sessionId: intent.session_id,
      attempt: 1, engineVersion, traceId,
    },
    message: continuationMessage,
  };
}
