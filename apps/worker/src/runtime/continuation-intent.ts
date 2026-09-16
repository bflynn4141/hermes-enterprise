// The proposal-side half of approval continuation.
//
// This file deliberately has no Workflow/runtime-store imports. PgAgentDb uses
// it while implementing the typed proposal tool, and keeping that dependency
// leaf-shaped avoids a PgAgentDb -> Workflow -> RuntimeDb -> PgAgentDb module
// cycle.
import { approvalViewSchema, type ApprovalView } from '@hermes/shared';
import type { Tx } from '../db/client.js';

export interface ApprovalContinuationIntent {
  readonly target_agent_id: string;
  readonly target_session_id: string;
}

export interface PersistContinuationInput {
  readonly workspaceId: string;
  readonly runId: string;
  readonly toolCallId: string;
  readonly requesterAgentId: string;
  readonly sourceSessionId: string;
  readonly targetAgentId: string;
  readonly targetSessionId: string;
  readonly approval: ApprovalView;
}

/** Persist a revision-bound intent in the proposal's app-role transaction. */
export async function persistApprovalContinuation(
  tx: Tx,
  input: PersistContinuationInput,
): Promise<{ continuationId: string; created: boolean }> {
  const view = approvalViewSchema.parse(input.approval);
  const replay = await tx.query<{
    id: string;
    request_id: string;
    authorization_revision: number;
    agent_id: string;
    session_id: string;
  }>(
    `SELECT id, request_id, authorization_revision, agent_id, session_id
       FROM approval_continuations
      WHERE source_run_id = $1 AND source_tool_call_id = $2`,
    [input.runId, input.toolCallId],
  );
  const prior = replay.rows[0];
  if (prior) {
    if (prior.request_id !== view.request_id ||
        prior.authorization_revision !== view.payload.authorization.revision ||
        prior.agent_id !== input.targetAgentId || prior.session_id !== input.targetSessionId) {
      throw new Error('approval_continuation_replay_conflict');
    }
    return { continuationId: prior.id, created: false };
  }
  if (view.workspace_id !== input.workspaceId || view.status !== 'pending' ||
      view.payload.context.requester.agent_id !== input.requesterAgentId ||
      view.payload.context.source.run_id !== input.runId ||
      view.payload.context.source.session_id !== input.sourceSessionId) {
    throw new Error('approval_continuation_source_mismatch');
  }
  const allowedTarget = input.targetAgentId === input.requesterAgentId ||
    view.payload.context.target_agent_ids.includes(input.targetAgentId);
  if (!allowedTarget) throw new Error('approval_continuation_target_not_authorized');
  const targetSession = await tx.query<{ agent_id: string; read_only: boolean }>(
    `SELECT agent_id, read_only FROM sessions
      WHERE workspace_id = $1 AND id = $2`,
    [input.workspaceId, input.targetSessionId],
  );
  if (!targetSession.rows[0] || targetSession.rows[0].agent_id !== input.targetAgentId || targetSession.rows[0].read_only) {
    throw new Error('approval_continuation_target_session_invalid');
  }
  const authorization = view.payload.authorization;
  const inserted = await tx.query<{ id: string }>(
    `INSERT INTO approval_continuations (
       workspace_id, request_id, authorization_revision, authorization_hash,
       agent_id, runtime_profile, session_id, source_run_id, source_tool_call_id,
       continuation_payload, dependency_request_ids, expires_at
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10::jsonb,$11,$12)
     ON CONFLICT (source_run_id, source_tool_call_id)
       WHERE source_run_id IS NOT NULL AND source_tool_call_id IS NOT NULL
     DO NOTHING
     RETURNING id`,
    [
      input.workspaceId,
      view.request_id,
      authorization.revision,
      authorization.hash,
      input.targetAgentId,
      `agent-${input.targetAgentId}`,
      input.targetSessionId,
      input.runId,
      input.toolCallId,
      JSON.stringify({ target_agent_id: input.targetAgentId, target_session_id: input.targetSessionId }),
      view.payload.context.source.dependent_request_ids,
      authorization.expires_at,
    ],
  );
  if (inserted.rows[0]) return { continuationId: inserted.rows[0].id, created: true };
  const existing = await tx.query<{
    id: string;
    request_id: string;
    authorization_revision: number;
    agent_id: string;
    session_id: string;
  }>(
    `SELECT id, request_id, authorization_revision, agent_id, session_id FROM approval_continuations
      WHERE source_run_id = $1 AND source_tool_call_id = $2`,
    [input.runId, input.toolCallId],
  );
  const row = existing.rows[0];
  if (!row || row.request_id !== view.request_id || row.authorization_revision !== authorization.revision ||
      row.agent_id !== input.targetAgentId || row.session_id !== input.targetSessionId) {
    throw new Error('approval_continuation_replay_conflict');
  }
  return { continuationId: row.id, created: false };
}
