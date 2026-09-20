// Official Hermes run mappings and replay records on the existing restricted
// agent role. Tool effects and traces share one transaction; no grants expand.
import { PgAgentDb } from '../engine/pg-agent-db.js';
import type { EngineRunRow } from '../engine/agent-db.js';
import type { RunErrorInput } from '../engine/agent-db.js';
import type { ProviderMessage, ToolCall } from '../model/types.js';
import { RouteError } from '../routes/tenant.js';
import type { ProviderRetryAfter } from './retry-after.js';
import {
  RuntimeBudgetError,
  type RuntimeBudgetContext,
  type RuntimeBudgetDb,
  type RuntimeBudgetReservation,
  type RuntimeUsage,
} from './budget.js';

export interface RunBinding {
  readonly runtimeKind: string;
  readonly runtimeProfile: string | null;
  readonly runtimeRunId: string | null;
  readonly runtimeSessionId: string | null;
  readonly runtimeAttempt: number | null;
}
export interface RuntimeCallRecord {
  readonly turn: number;
  readonly seq: number;
  readonly call: ToolCall;
  readonly result: string | null;
  readonly ok: boolean | null;
}
export class RuntimeDb extends PgAgentDb implements RuntimeBudgetDb {
  /**
   * Group runtime-only reads and bookkeeping that already use this request-local
   * database instance. This removes repeated BEGIN / tenant-context / COMMIT
   * round trips while preserving the single-client, serial-query invariant.
   */
  async withRuntimeTransaction<T>(work: () => Promise<T>): Promise<T> {
    return this.runtimeTx(work);
  }

  override async setRunStatus(
    runId: string,
    status: string,
    detail: { waitingFor?: string | null; waitingLabel?: string | null; error?: RunErrorInput | null } = {},
  ): Promise<void> {
    await super.setRunStatus(runId, status, detail);
    if (!['completed', 'stopped', 'error'].includes(status)) return;
    // Read the status that actually won. `PgAgentDb.setRunStatus` refuses to
    // resurrect a terminal run, so projecting the requested value here could
    // otherwise turn a run swept as errored into completed work.
    const { rows } = await this.runtimeQuery<{ status: string }>(
      `SELECT status FROM runs WHERE id = $1`, [runId],
    );
    const actual = rows[0]?.status;
    if (!actual || !['completed', 'stopped', 'error'].includes(actual)) return;
    await this.runtimeQuery('SELECT project_approval_continuation_outcome($1)', [runId]);
    await this.runtimeQuery('SELECT project_partner_handoff_run_outcome($1)', [runId]);
  }
  async recoveryInput(runId: string, attempt: number): Promise<string | null> {
    const { rows } = await this.runtimeQuery<{ recovery_input: string | null }>(
      'SELECT recovery_input FROM runs WHERE id=$1 AND attempt=$2', [runId, attempt]);
    return rows[0]?.recovery_input ?? null;
  }
  /**
   * Fail only the exact automatic attempt whose runtime contract drifted.
   * The expected-attempt predicate is the write fence: a delayed Workflow may
   * never mark its successor errored after binding resolution yields.
   */
  async failAutomaticRecoveryExecution(runId: string, attempt: number, error: RunErrorInput): Promise<boolean> {
    return this.runtimeTx(async (query) => {
      const { rows } = await query<{ id: string }>(
        `UPDATE runs
            SET status='error', error=$3::jsonb, ended_at=now(),
                recovery_cancelled=true, recovery_next_at=NULL, recovery_blocked_reason=$4
          WHERE id=$1 AND attempt=$2 AND automatic_recovery
            AND status='working' AND NOT stop_requested
          RETURNING id`,
        [runId, attempt, JSON.stringify(error), error.reason],
      );
      if (rows.length !== 1) return false;
      // Terminal projections must commit with the fenced state transition. A
      // stale no-op may not close approval budget or handoff state belonging
      // to the successor attempt.
      await query('SELECT project_approval_continuation_outcome($1)', [runId]);
      await query('SELECT project_partner_handoff_run_outcome($1)', [runId]);
      return true;
    });
  }
  async lockAutomaticRecoveryExecution(runId: string, attempt: number): Promise<boolean> {
    const { rows } = await this.runtimeQuery<{ id: string }>(
      `SELECT id FROM runs
        WHERE id=$1 AND attempt=$2 AND automatic_recovery
          AND status='working' AND NOT stop_requested
        FOR UPDATE`,
      [runId, attempt],
    );
    return rows.length === 1;
  }
  async recoveryAuthority(runId: string, attempt: number): Promise<Record<string, unknown> | null> {
    const { rows } = await this.runtimeQuery<{ runtime_request: Record<string, unknown> }>(
      `SELECT runtime_request FROM runs WHERE id=$1 AND attempt=$2
        AND runtime_request_attempt=($2::integer-1) AND runtime_request IS NOT NULL`,
      [runId, attempt],
    );
    return rows[0]?.runtime_request ?? null;
  }
  async runtimeRequest(runId: string, attempt: number): Promise<Record<string, unknown> | null> {
    const { rows } = await this.runtimeQuery<{ runtime_request: Record<string, unknown> }>(
      `SELECT runtime_request FROM runs WHERE id=$1 AND attempt=$2
        AND runtime_request_attempt=$2 AND runtime_request IS NOT NULL`,
      [runId, attempt],
    );
    return rows[0]?.runtime_request ?? null;
  }
  async recordProviderRetryAfter(runId: string, attempt: number, delay: ProviderRetryAfter): Promise<void> {
    // A delayed provider response from the old attempt cannot postpone its
    // successor. Concurrent failures keep the longest valid provider deadline.
    await this.runtimeQuery(
      `UPDATE runs SET recovery_not_before=GREATEST(recovery_not_before,$3::timestamptz),
              recovery_blocked_reason=COALESCE(recovery_blocked_reason,$4)
        WHERE workspace_id=app_workspace_id() AND id=$1 AND attempt=$2`,
      [runId, attempt, delay.notBefore, delay.blockedReason],
    );
  }
  async binding(runId: string): Promise<RunBinding | null> {
    const { rows } = await this.runtimeQuery<RunBinding>(
      `SELECT runtime_kind AS "runtimeKind", runtime_profile AS "runtimeProfile", runtime_run_id AS "runtimeRunId",
              runtime_session_id AS "runtimeSessionId", runtime_attempt AS "runtimeAttempt" FROM runs WHERE id = $1`, [runId]);
    return rows[0] ?? null;
  }
  async bindRun(runId: string, attempt: number, remoteRunId: string, sessionId: string, profile: string): Promise<boolean> {
    const { rows } = await this.runtimeQuery<{ id: string }>(
      `UPDATE runs SET runtime_kind = 'hermes', runtime_run_id = $3, runtime_session_id = $4,
              runtime_profile = $5, runtime_attempt = $2
        WHERE id = $1 AND attempt = $2 AND NOT stop_requested AND status = 'working'
          AND (runtime_attempt IS DISTINCT FROM $2 OR runtime_run_id IS NULL OR runtime_run_id = $3)
        RETURNING id`, [runId, attempt, remoteRunId, sessionId, profile]);
    return rows.length === 1;
  }
  async resolveRuntimeSessionId(run: EngineRunRow): Promise<string> {
    if (!run.agentId) throw new RouteError('The run has no runtime agent.', 'runtime_run_inactive', 409);
    const { rows } = await this.runtimeQuery<{ runtime_session_id: string }>(
      `SELECT COALESCE((
          SELECT prior.runtime_session_id
            FROM runs prior
           WHERE prior.workspace_id = $1
             AND prior.session_id = $2
             AND prior.agent_id = $4
             AND prior.id <> $3
             AND prior.created_at < (SELECT created_at FROM runs WHERE id = $3)
             AND prior.runtime_kind = 'hermes'
             AND prior.runtime_session_id IS NOT NULL
           ORDER BY prior.created_at DESC, prior.id DESC
           LIMIT 1
        ), $3::text) AS runtime_session_id`,
      [run.workspaceId, run.sessionId, run.id, run.agentId],
    );
    // The run id is globally fresh even when a deterministic staging seed
    // recreates the same Enterprise session id. This prevents the native
    // SessionDB from attaching an old transcript to a new conversation.
    return rows[0]?.runtime_session_id ?? run.id;
  }
  async snapshotRequest(runId: string, attempt: number, proposed: Record<string, unknown>): Promise<Record<string, unknown>> {
    const run = await this.loadRun(runId);
    if (!run?.agentId) throw new RouteError('The run has no runtime agent.', 'runtime_run_inactive', 409);
    return this.withCallLock(run.agentId, async () => {
      const busy = await this.runtimeQuery<{ id: string }>(
        `SELECT id FROM runs WHERE agent_id = $1 AND id <> $2 AND runtime_kind = 'hermes'
           AND status IN ('working','waiting','stopping')
           AND (runtime_attempt = attempt OR runtime_request_attempt = attempt) LIMIT 1`, [run.agentId, runId]);
      if (busy.rows.length) throw new RouteError('This Hermes agent already has an active run.', 'runtime_profile_busy', 409);
      const { rows } = await this.runtimeQuery<{ runtime_request: Record<string, unknown> }>(
        `UPDATE runs SET runtime_kind = 'hermes', runtime_profile = 'agent-' || agent_id::text,
                runtime_request = CASE WHEN runtime_request_attempt = $2 AND runtime_request IS NOT NULL THEN runtime_request ELSE $3::jsonb END,
                runtime_request_attempt = $2,
                runtime_started_at = CASE WHEN runtime_request_attempt = $2 THEN COALESCE(runtime_started_at, clock_timestamp()) ELSE clock_timestamp() END,
                runtime_wait_started_at = CASE WHEN runtime_request_attempt = $2 THEN runtime_wait_started_at ELSE NULL END,
                runtime_wait_ms = CASE WHEN runtime_request_attempt = $2 THEN runtime_wait_ms ELSE 0 END
          WHERE id = $1 AND attempt = $2 AND NOT stop_requested AND status = 'working'
          RETURNING runtime_request`, [runId, attempt, JSON.stringify(proposed)]);
      if (!rows[0]) throw new RouteError('The run is no longer active.', 'runtime_run_inactive', 409);
      return rows[0].runtime_request;
    });
  }
  async findRuntimeRun(remoteRunId: string, agentId: string): Promise<EngineRunRow | null> {
    const { rows } = await this.runtimeQuery<{ id: string }>(
      `SELECT id FROM runs WHERE runtime_kind = 'hermes' AND runtime_run_id = $1 AND agent_id = $2
         AND runtime_attempt = attempt`, [remoteRunId, agentId]);
    return rows[0] ? this.loadRun(rows[0].id) : null;
  }
  async activeProfileRun(agentId: string): Promise<EngineRunRow | null> {
    const { rows } = await this.runtimeQuery<{ id: string }>(
      `SELECT id FROM runs WHERE agent_id = $1 AND runtime_kind = 'hermes'
         AND runtime_profile = 'agent-' || $1::text AND status = 'working' AND NOT stop_requested
         AND (runtime_attempt = attempt OR runtime_request_attempt = attempt)
       ORDER BY created_at DESC LIMIT 2`, [agentId]);
    return rows.length === 1 && rows[0] ? this.loadRun(rows[0].id) : null;
  }
  async mappingPending(agentId: string): Promise<boolean> {
    const run = await this.activeProfileRun(agentId);
    if (!run) return false;
    const binding = await this.binding(run.id);
    return !binding?.runtimeRunId || binding.runtimeAttempt !== run.attempt;
  }
  async withCallLock<T>(agentId: string, fn: () => Promise<T>): Promise<T> {
    return this.runtimeTx(async (query) => {
      // Transaction locks work with Hyperdrive pooling; session locks do not.
      await query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`hermes-bridge:${agentId}`]);
      return fn();
    });
  }
  async lockRun(runId: string): Promise<void> {
    await this.runtimeQuery('SELECT id FROM runs WHERE id = $1 FOR UPDATE', [runId]);
  }
  async runtimeCall(runId: string, callId: string): Promise<RuntimeCallRecord | null> {
    const { rows } = await this.runtimeQuery<{ turn: number; seq: number; provider_message: ProviderMessage; result: string | null; ok: boolean | null }>(
      `SELECT a.turn, a.seq, a.provider_message, t.provider_message->>'content' AS result, (t.provider_message->>'runtime_ok')::boolean AS ok
         FROM run_turns a LEFT JOIN run_turns t ON t.run_id = a.run_id AND t.tool_call_id = $2 AND t.role = 'tool'
        WHERE a.run_id = $1 AND a.role = 'assistant'
          AND a.provider_message->'tool_calls' @> jsonb_build_array(jsonb_build_object('id', $2::text))
        ORDER BY a.turn, a.seq LIMIT 1`, [runId, callId]);
    const row = rows[0];
    const call = row?.provider_message.tool_calls?.find((item) => item.id === callId);
    return row && call ? { turn: row.turn, seq: row.seq, call, result: row.result, ok: row.ok } : null;
  }
  async nextRuntimeSequence(runId: string): Promise<number> {
    const { rows } = await this.runtimeQuery<{ seq: number }>(
      `SELECT coalesce(max(seq + CASE WHEN role = 'assistant' AND provider_message ? 'runtime_run_id' THEN 1 ELSE 0 END), -1) + 1 AS seq FROM run_turns WHERE run_id = $1 AND turn = 0`, [runId]);
    return Number(rows[0]?.seq ?? 0);
  }
  async startRuntimeWait(runId: string, attempt: number): Promise<void> {
    await this.runtimeQuery(
      `UPDATE runs SET runtime_wait_started_at = clock_timestamp()
        WHERE id = $1 AND attempt = $2 AND runtime_wait_started_at IS NULL
          AND (runtime_request_attempt = $2 OR runtime_attempt = $2)`, [runId, attempt]);
  }
  async endRuntimeWait(runId: string, attempt: number): Promise<void> {
    await this.runtimeQuery(
      `UPDATE runs SET runtime_wait_ms = runtime_wait_ms +
          greatest(0, floor(extract(epoch FROM (clock_timestamp() - runtime_wait_started_at)) * 1000))::bigint,
          runtime_wait_started_at = NULL
        WHERE id = $1 AND attempt = $2 AND runtime_wait_started_at IS NOT NULL
          AND (runtime_request_attempt = $2 OR runtime_attempt = $2)`, [runId, attempt]);
  }
  async activeRuntimeMs(runId: string, attempt: number, start: number, end: number): Promise<number> {
    const { rows } = await this.runtimeQuery<{
      runtime_started_at: Date | null;
      runtime_wait_started_at: Date | null;
      runtime_wait_ms: string;
    }>(`SELECT runtime_started_at, runtime_wait_started_at, runtime_wait_ms FROM runs
         WHERE id = $1 AND attempt = $2 AND (runtime_request_attempt = $2 OR runtime_attempt = $2)`, [runId, attempt]);
    const clock = rows[0];
    if (!clock) return 0;
    // The persisted submit boundary survives Workflow execution retries. The
    // caller's start is only for a mapped run that predates this migration.
    const begun = clock.runtime_started_at?.getTime() ?? start;
    const pendingWait = clock.runtime_wait_started_at === null ? 0 :
      Math.max(0, end - Math.max(begun, clock.runtime_wait_started_at.getTime()));
    return Math.max(0, end - begun - Number(clock.runtime_wait_ms) - pendingWait);
  }
  async allowedRuntimeModels(): Promise<{ model_id: string; provider: string; context_length: number | null }[]> {
    const { rows } = await this.runtimeQuery<{ model_id: string; provider: string; context_length: number | null }>(
      `SELECT model_id, provider, context_length FROM catalog
         WHERE (provider, transport) IN (('openrouter', 'openrouter_chat'), ('nous_portal', 'nous_chat'))
         AND disabled_reason IS NULL AND supports_tools ORDER BY model_id`);
    return rows;
  }
  async runtimeBudgetForRun(runId: string): Promise<RuntimeBudgetContext | null> {
    const { rows } = await this.runtimeQuery<{
      authorization_state: string;
      expires_at: Date;
      budget_id: string | null;
      budget_state: string | null;
      model_id: string | null;
      max_output_tokens_per_call: number | null;
      context_length: number | null;
      pricing_verified_on: Date | string | null;
      input_price: string | null;
      output_price: string | null;
      cached_input_price: string | null;
    }>(
      `SELECT c.state AS authorization_state, c.expires_at,
              b.id AS budget_id, b.state AS budget_state, b.model_id,
              b.max_output_tokens_per_call,
              m.context_length, m.pricing_verified_on,
              m.pricing_per_million->>'input' AS input_price,
              m.pricing_per_million->>'output' AS output_price,
              m.pricing_per_million->>'cached_input' AS cached_input_price
         FROM approval_continuations c
         LEFT JOIN approval_runtime_budgets b
           ON b.continuation_id = c.id AND b.workspace_id = c.workspace_id
         LEFT JOIN catalog m ON m.model_id = b.model_id
        WHERE c.admitted_run_id = $1
        LIMIT 1`,
      [runId],
    );
    const row = rows[0];
    if (!row) return null;
    const numberOrNull = (value: string | null): number | null => {
      if (value === null || value.trim() === '') return null;
      const parsed = Number(value);
      return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
    };
    const expired = row.expires_at.getTime() <= Date.now();
    return {
      budgetId: row.budget_id,
      authorizationState: expired ? 'expired' : row.authorization_state,
      state: row.budget_state,
      modelId: row.model_id,
      maxOutputTokensPerCall: row.max_output_tokens_per_call,
      contextLength: row.context_length,
      pricingVerifiedOn:
        row.pricing_verified_on instanceof Date
          ? row.pricing_verified_on.toISOString().slice(0, 10)
          : row.pricing_verified_on?.slice(0, 10) ?? null,
      pricing: row.model_id
        ? {
            input: numberOrNull(row.input_price),
            output: numberOrNull(row.output_price),
            cachedInput: numberOrNull(row.cached_input_price),
          }
        : null,
    };
  }
  async reserveRuntimeBudget(input: {
    runId: string;
    modelId: string;
    inputTokenBound: number;
    outputTokenBound: number;
    reservedCostUsd: number;
  }): Promise<RuntimeBudgetReservation> {
    try {
      const { rows } = await this.runtimeQuery<{ reservation_id: string; budget_id: string }>(
        `SELECT reservation_id, budget_id
           FROM reserve_approval_model_budget($1, $2, $3, $4, $5)`,
        [input.runId, input.modelId, input.inputTokenBound, input.outputTokenBound, input.reservedCostUsd],
      );
      const row = rows[0];
      if (!row) throw new RuntimeBudgetError('approval_budget_reservation_failed');
      return { reservationId: row.reservation_id, budgetId: row.budget_id };
    } catch (error) {
      if (error instanceof RuntimeBudgetError) throw error;
      const reason = /approval_budget_[a-z_]+/.exec(error instanceof Error ? error.message : String(error))?.[0];
      throw new RuntimeBudgetError(reason ?? 'approval_budget_reservation_failed');
    }
  }
  async reconcileRuntimeBudget(input: {
    reservationId: string;
    resolution: 'completed' | 'rejected' | 'unresolved' | 'cancelled';
    usage?: RuntimeUsage;
    actualCostUsd?: number;
  }): Promise<void> {
    const usage = input.usage;
    try {
      await this.runtimeQuery(
        `SELECT reconcile_approval_model_budget($1, $2, $3, $4, $5, $6)`,
        [
          input.reservationId,
          input.resolution,
          usage?.inputTokens ?? null,
          usage?.outputTokens ?? null,
          usage?.cachedInputTokens ?? null,
          input.actualCostUsd ?? null,
        ],
      );
    } catch (error) {
      const reason = /approval_budget_[a-z_]+/.exec(error instanceof Error ? error.message : String(error))?.[0];
      throw new RuntimeBudgetError(reason ?? 'approval_budget_reconciliation_failed');
    }
  }
  /**
   * Keep the hard-budget settlement and its provider-call audit row atomic.
   * `runtimeTx` makes the nested PgAgentDb methods reuse this transaction, so
   * either both facts commit or the conservative reservation remains held.
   */
  async settleRuntimeModelCall(input: {
    reservation: {
      reservationId: string;
      resolution: 'completed' | 'rejected' | 'unresolved' | 'cancelled';
      usage?: RuntimeUsage;
      actualCostUsd?: number;
    } | null;
    modelCall: Parameters<PgAgentDb['recordModelCall']>[0];
  }): Promise<void> {
    await this.runtimeTx(async () => {
      if (input.reservation) await this.reconcileRuntimeBudget(input.reservation);
      await this.recordModelCall(input.modelCall);
    });
  }
  async finalizeRuntime<T>(runId: string, attempt: number, work: () => Promise<T>): Promise<T | null> {
    return this.runtimeTx(async (query) => {
      const { rows } = await query<{ attempt: number; status: string }>('SELECT attempt,status FROM runs WHERE id=$1 FOR UPDATE', [runId]);
      const run = rows[0];
      if (!run || run.attempt !== attempt || ['completed','stopped','error'].includes(run.status)) return null;
      return work();
    });
  }
  async carryGuidance(runId: string, ids: string[]): Promise<void> {
    if (!ids.length) return;
    await this.runtimeQuery(
      `UPDATE messages SET run_id = NULL WHERE run_id = $1 AND id = ANY($2::uuid[])
         AND kind = 'guidance' AND status = 'streaming'`, [runId, ids]);
  }
  async loadBootstrapHistory(run: EngineRunRow): Promise<ProviderMessage[]> {
    const { rows } = await this.runtimeQuery<{ role: string; text: string }>(
      `SELECT m.role, m.text FROM messages m
        WHERE m.session_id = $1 AND m.run_id IS DISTINCT FROM $2 AND m.status = 'complete'
          AND m.role IN ('user','iris') AND m.kind IS NULL
          AND m.created_at < (SELECT created_at FROM runs WHERE id = $2)
          AND NOT EXISTS (SELECT 1 FROM runs r WHERE r.session_id = $1 AND r.id <> $2
                            AND r.runtime_kind = 'hermes' AND r.runtime_run_id IS NOT NULL
                            AND r.created_at < (SELECT created_at FROM runs WHERE id = $2))
        ORDER BY m.seq`, [run.sessionId, run.id]);
    return rows.map((row) => ({ role: row.role === 'iris' ? 'assistant' : 'user', content: row.text }));
  }
}
