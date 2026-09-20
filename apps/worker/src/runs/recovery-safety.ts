import type { Tx } from '../db/client.js';

export interface RecoverySafety {
  readonly blockedReason: string | null;
  readonly message: string | null;
  readonly resumeInput: string | null;
}

// Native attempts get new tool-call identities. Only reads (and ephemeral
// focus) are safe to repeat without a durable business-level replay contract.
const REPLAY_SAFE_TOOLS = new Set([
  'list_requests', 'get_request', 'get_approval_status', 'get_document_text',
  'get_workspace_context', 'get_history', 'list_members', 'list_partner_candidates',
  'get_partner_candidate', 'fetch_url', 'set_focus', 'skill_view',
]);

const block = (blockedReason: string, message: string): RecoverySafety => ({
  blockedReason, message, resumeInput: null,
});

const READ_ONLY_CONTINUATION = [
  'Continue the interrupted task using the completed tool results already stored in this session.',
  'Do not repeat completed tool calls or ask for the same approval again.',
  'Finish only the remaining response. If a required result is missing, explain the gap instead of repeating a tool call.',
].join(' ');

/**
 * Inspect before incrementing attempt or changing a native runtime mapping.
 * The caller owns admission/authorization and must serialize with tool writes.
 * Pending wallet receipts keep their original mapping so startup spill import
 * can settle them; this function never grants a replacement payment allowance.
 */
export async function inspectRecoverySafety(
  tx: Tx,
  workspaceId: string,
  runId: string,
): Promise<RecoverySafety> {
  const runResult = await tx.query<{
    agent_id: string | null; client_turn_id: string; runtime_run_id: string | null;
  }>(
    `SELECT agent_id, client_turn_id, runtime_run_id FROM runs
      WHERE workspace_id=$1 AND id=$2`,
    [workspaceId, runId],
  );
  const run = runResult.rows[0];
  if (!run) return block('run_missing', 'This task is no longer available.');

  // Include all pending receipts in this profile: older interrupted attempts
  // may already have lost their run mapping, and must not be hidden by a retry.
  const pendingPayments = await tx.query<{ source: string }>(
    `SELECT source FROM partner_screening_runs
      WHERE workspace_id=$1 AND agent_id=$2
        AND source IN ('agentcash_people','agentcash_creators')
        AND status <> 'completed' AND (api_requests_used > 0 OR agentcash_tool_call_id IS NOT NULL)
     UNION ALL
     SELECT 'agentcash_contact' AS source FROM partner_contact_enrichments
      WHERE workspace_id=$1 AND agent_id=$2
        AND (pending_kind IS NOT NULL OR pending_tool_call_id IS NOT NULL)
     LIMIT 1`,
    [workspaceId, run.agent_id],
  );
  if (pendingPayments.rows.length) {
    return block('payment_result_pending',
      'A paid search or contact result still needs recovery. Retry is paused to prevent another charge.');
  }

  const requests = await tx.query<{ status: string }>(
    `SELECT status FROM requests WHERE workspace_id=$1 AND run_id=$2
      ORDER BY CASE WHEN status='pending' THEN 0 ELSE 1 END LIMIT 1`,
    [workspaceId, runId],
  );
  if (requests.rows[0]?.status === 'pending') {
    return block('review_pending', 'This task already created a request. Review it in Inbox before continuing.');
  }
  if (requests.rows.length) {
    return block('side_effects_present', 'This task already created reviewed work. Open its trace to continue without duplicating it.');
  }

  const screeningId = /^partner-screening:([0-9a-f-]{36})$/i.exec(run.client_turn_id)?.[1];
  let screening: { id: string; status: string; source: string; config_snapshot: Record<string, unknown> } | undefined;
  if (screeningId) {
    const result = await tx.query<{
      id: string; status: string; source: string; config_snapshot: Record<string, unknown>;
    }>(
      `SELECT id, status, source, config_snapshot FROM partner_screening_runs
        WHERE workspace_id=$1 AND agent_id=$2 AND id=$3`,
      [workspaceId, run.agent_id, screeningId],
    );
    screening = result.rows[0];
    if (!screening) return block('screening_missing', 'The stored screening evidence is no longer available.');
    if (screening.status !== 'completed' && screening.source !== 'agentcash_people') {
      return block('screening_incomplete', 'Source discovery needs to finish before Iris can retry its assessment.');
    }
    if (screening.status === 'failed') {
      return block('screening_incomplete', 'Source discovery needs attention before Iris can retry its assessment.');
    }
  }

  const otherPaidWork = await tx.query<{ source: string }>(
    `SELECT source FROM partner_screening_runs
      WHERE workspace_id=$1 AND agent_id=$2 AND source='agentcash_creators'
        AND config_snapshot->>'runtime_run_id'=$3
     UNION ALL
     SELECT 'agentcash_contact' AS source FROM partner_contact_enrichments
      WHERE workspace_id=$1 AND agent_id=$2 AND run_id=$4`,
    [workspaceId, run.agent_id, run.runtime_run_id, runId],
  );
  if (otherPaidWork.rows.some(({ source }) => source === 'agentcash_creators')
      || (!screening && otherPaidWork.rows.length)) {
    return block('side_effects_present',
      'This task already performed paid work. Review its stored results before starting another attempt.');
  }

  // Both streams matter: bridge tools persist run_turns; native MCP tools are
  // observable in run_steps only. Unknown tools fail closed, including tools
  // added to the runtime after this allowlist was reviewed.
  const calls = await tx.query<{ name: string }>(
    `SELECT DISTINCT call->>'name' AS name
       FROM run_turns t CROSS JOIN LATERAL jsonb_array_elements(
         CASE WHEN jsonb_typeof(t.provider_message->'tool_calls')='array'
           THEN t.provider_message->'tool_calls' ELSE '[]'::jsonb END
       ) AS call
      WHERE t.workspace_id=$1 AND t.run_id=$2 AND t.role='assistant'
     UNION
     SELECT label AS name FROM run_steps
      WHERE workspace_id=$1 AND run_id=$2 AND tool_call_id IS NOT NULL`,
    [workspaceId, runId],
  );
  const completedPaidScreening = screening?.source === 'agentcash_people' && screening.status === 'completed';
  if (calls.rows.some(({ name }) => !REPLAY_SAFE_TOOLS.has(name)
      && !(name === 'mcp__agentcash__fetch' && completedPaidScreening))) {
    return block('side_effects_uncertain',
      'This task reached a tool that may have changed something. Review its trace before starting another attempt.');
  }

  if (screening?.status !== 'completed') {
    // A normal chat retry must be a continuation, not another copy of the
    // original user turn. The native session already holds these read-only
    // results; a fixed server instruction keeps provider content out of the
    // prompt and tells the model not to ask for the same approval again.
    return {
      blockedReason: null,
      message: null,
      resumeInput: screening || calls.rows.length === 0 ? null : READ_ONLY_CONTINUATION,
    };
  }

  const candidates = await tx.query<{ candidate_id: string }>(
    `SELECT candidate_id FROM partner_screening_run_candidates
      WHERE workspace_id=$1 AND run_id=$2 AND deterministic_priority >= $3
      ORDER BY deterministic_priority DESC, candidate_id`,
    [workspaceId, screening.id,
      typeof screening.config_snapshot.minimum_priority === 'number' ? screening.config_snapshot.minimum_priority : 0],
  );
  const candidateIds = candidates.rows.map(({ candidate_id }) => candidate_id);
  // Only server-owned identifiers enter this instruction. External source
  // content remains behind evidence tools rather than becoming instructions.
  const resumeInput = [
    `Resume the existing authorized partner-screening task ${screening.id}. Source discovery is already completed and its evidence is stored.`,
    'Do not repeat source discovery, completed contact enrichment, creator search, or any other paid call. Do not reset payment allowances.',
    candidateIds.length
      ? `Use list_partner_candidates and get_partner_candidate to review only these stored candidates: ${candidateIds.join(', ')}.`
      : 'No stored candidate meets the original discovery-priority threshold. Report that result and the evidence gaps; do not start another search.',
    'Apply the configured Partner Program criteria and finish only the remaining authorized assessment using stored evidence and contact results. Cite stored artifact ids and state evidence gaps. Check existing requests before proposing work; reuse existing drafts rather than creating duplicates.',
    'Do not contact anyone, claim a prospect applied, or create an application request for a discovered prospect. Any authorized outreach remains a draft for human review.',
  ].join('\n\n');
  return { blockedReason: null, message: null, resumeInput };
}
