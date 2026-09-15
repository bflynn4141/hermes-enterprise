// `AgentDb` over Postgres, on the `agent` Hyperdrive config.
//
// One connection for the life of the Workflow invocation, one transaction per
// operation, and `SET LOCAL app.workspace_id` / `app.user_id` set inside each
// one — the same shape `withTenantTransaction` uses for a request, minus the
// membership check, because the caller is the engine and there is no member to
// check. Row-level security still applies to every statement.
//
// Every write a tool makes is idempotent on `(run_id, tool_call_id)`, which is
// what makes a step that ran twice produce one row. The `ON CONFLICT` targets
// name the partial indexes from migration 0002 explicitly, because an untargeted
// `DO NOTHING` would also swallow a genuine primary-key collision.
import type { RequestKind } from '@hermes/shared';
import type { Client } from 'pg';
import type { Env } from '../env.js';
import { connect } from '../db/client.js';
import { SYSTEM_USER_ID } from '../jobs.js';
import { resolveKey } from '../keys/store.js';
import type { Credential, ProviderMessage, Usage } from '../model/types.js';
import { estimateCostUsd, loadModel } from '../model/catalog.js';
import { MODE_TOOL_KINDS, TOOLS } from './tools.js';
import type {
  AgentDb,
  AppendTurnInput,
  AssistantMessageInput,
  EmitInput,
  EmittedEvent,
  EngineRunRow,
  GuidanceRow,
  HistoryTurn,
  ProposeInstructionInput,
  ProposeRequestInput,
  QueueRow,
  RunErrorInput,
  SaveReviewNoteInput,
  SetContextFieldInput,
  StepProgress,
} from './agent-db.js';

/**
 * The tool names a workspace with no configured capability rows still gets.
 *
 * Not "everything": the read tools plus the proposal tools, which is what the
 * seeded Work-mode agent is given. It exists so that `wrangler dev --local`
 * against a freshly seeded database does something rather than refusing every
 * tool call, and it is a fallback, never a widening — `allowedTools` still
 * filters by mode.
 */
export const DEFAULT_TOOL_NAMES: readonly string[] = TOOLS.filter((tool) =>
  (MODE_TOOL_KINDS.work ?? []).includes(tool.kind),
).map((tool) => tool.name);

interface QueryResultLike<T> {
  rows: T[];
}

export class PgAgentDb implements AgentDb {
  private client: Client | null = null;

  constructor(
    private readonly env: Env,
    private readonly workspaceId: string,
    private readonly traceId: string,
  ) {}

  private async connection(): Promise<Client> {
    if (!this.client) this.client = await connect(this.env, 'agent');
    return this.client;
  }

  /** Release the connection at the end of the invocation, never mid-step. */
  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (client) await client.end();
  }

  private async tx<T>(fn: (q: <R>(text: string, values?: readonly unknown[]) => Promise<QueryResultLike<R>>) => Promise<T>): Promise<T> {
    const client = await this.connection();
    await client.query('BEGIN');
    try {
      await client.query('SELECT set_config($1, $2, true)', ['app.workspace_id', this.workspaceId]);
      await client.query('SELECT set_config($1, $2, true)', ['app.user_id', SYSTEM_USER_ID]);
      const result = await fn(
        <R,>(text: string, values?: readonly unknown[]) =>
          client.query(text, values ? [...values] : undefined) as unknown as Promise<QueryResultLike<R>>,
      );
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }

  // -------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------

  async loadRun(runId: string): Promise<EngineRunRow | null> {
    return this.tx(async (q) => {
      const { rows } = await q<{
        id: string;
        workspace_id: string;
        session_id: string;
        status: string;
        stop_requested: boolean;
        attempt: number;
        engine_version: number;
        max_turns: number;
        model_id: string;
        effort: string | null;
        trace_id: string | null;
        active_ms: number;
        waiting_for: string | null;
        mode: string;
        agent_id: string | null;
        client_turn_id: string;
      }>(
        `SELECT r.id, r.workspace_id, r.session_id, r.status, r.stop_requested, r.attempt,
                r.engine_version, r.max_turns, r.model_id, r.effort, r.trace_id, r.active_ms,
                r.waiting_for, r.client_turn_id, coalesce(r.mode, s.mode) AS mode,
                COALESCE(r.agent_id, s.agent_id) AS agent_id
           FROM runs r JOIN sessions s ON s.id = r.session_id
          WHERE r.id = $1`,
        [runId],
      );
      const row = rows[0];
      if (!row) return null;
      return {
        id: row.id,
        workspaceId: row.workspace_id,
        sessionId: row.session_id,
        status: row.status,
        stopRequested: row.stop_requested,
        attempt: row.attempt,
        engineVersion: row.engine_version,
        maxTurns: row.max_turns,
        modelId: row.model_id,
        effort: row.effort,
        traceId: row.trace_id ?? this.traceId,
        activeMs: row.active_ms,
        waitingFor: row.waiting_for,
        mode: row.mode,
        agentId: row.agent_id,
        clientTurnId: row.client_turn_id,
      };
    });
  }

  async stopRequested(runId: string): Promise<boolean> {
    return this.tx(async (q) => {
      const { rows } = await q<{ stop_requested: boolean }>(`SELECT stop_requested FROM runs WHERE id = $1`, [runId]);
      return rows[0]?.stop_requested ?? false;
    });
  }

  async resumeTurn(runId: string): Promise<number> {
    return this.tx(async (q) => {
      const { rows } = await q<{ incomplete: number | null; complete: number | null }>(
        `SELECT min(turn) FILTER (WHERE status <> 'complete') AS incomplete,
                max(turn) FILTER (WHERE status = 'complete')  AS complete
           FROM messages WHERE run_id = $1 AND role = 'iris' AND turn IS NOT NULL`,
        [runId],
      );
      const row = rows[0];
      if (row?.incomplete !== null && row?.incomplete !== undefined) return Number(row.incomplete);
      if (row?.complete !== null && row?.complete !== undefined) return Number(row.complete) + 1;
      return 0;
    });
  }

  async loadHistory(runId: string, limit: number): Promise<{ recent: HistoryTurn[]; olderSummary: string | null }> {
    return this.tx(async (q) => {
      const { rows } = await q<{ turn: number; seq: number; role: string; provider_message: ProviderMessage; tool_call_id: string | null }>(
        `SELECT turn, seq, role, provider_message, tool_call_id
           FROM run_turns WHERE run_id = $1 ORDER BY turn, seq`,
        [runId],
      );
      const all = rows.map((row) => ({
        turn: row.turn,
        seq: row.seq,
        role: row.role as HistoryTurn['role'],
        providerMessage: row.provider_message,
        toolCallId: row.tool_call_id,
      }));
      if (all.length <= limit) return { recent: all, olderSummary: null };
      const older = all.slice(0, all.length - limit);
      const recent = all.slice(all.length - limit);
      // Ids and counts, not text: Workflow state and prompts both fall under
      // the erasure inventory, and a summary made of applicant prose would be a
      // second copy nobody remembered to redact.
      const summary = `${older.length} earlier turn(s) in this run (turns ${older[0]?.turn ?? 0} to ${
        older[older.length - 1]?.turn ?? 0
      }), including ${older.filter((t) => t.role === 'tool').length} tool result(s).`;
      return { recent, olderSummary: summary };
    });
  }

  /**
   * Guidance this run must read: its own, plus anything left over.
   *
   * The second half is the "Applied to your next message" case. Guidance typed
   * during the run's final step arrives after the last provider step has read
   * its guidance, so there is no next step to apply it — the Guide route parks
   * it on the session with `run_id IS NULL` and tells the person it will reach
   * the next message. This query is the other end of that promise: the next run
   * in the session picks it up before its first provider step, which is what
   * makes the copy true rather than reassuring.
   */
  async loadGuidance(runId: string): Promise<GuidanceRow[]> {
    return this.tx(async (q) => {
      const { rows } = await q<{ id: string; text: string; status: string }>(
        `SELECT m.id, m.text, m.status
           FROM messages m
           JOIN runs r ON r.id = $1
          WHERE m.kind = 'guidance'
            AND m.status = 'streaming'
            AND (m.run_id = r.id OR (m.run_id IS NULL AND m.session_id = r.session_id AND m.created_at <= r.created_at))
          ORDER BY m.seq`,
        [runId],
      );
      return rows;
    });
  }

  async markGuidanceApplied(runId: string, guidanceId: string, turn: number): Promise<void> {
    await this.tx(async (q) => {
      // `run_id` is set here as well as the status, so a carried-over row
      // records which run finally read it.
      await q(`UPDATE messages SET status = 'complete', turn = $3, run_id = $1 WHERE id = $2 AND (run_id = $1 OR run_id IS NULL)`, [
        runId,
        guidanceId,
        turn,
      ]);
    });
  }

  async loadQueue(runId: string): Promise<QueueRow[]> {
    return this.tx(async (q) => {
      const { rows } = await q<QueueRow>(
        `SELECT id, text, status, position FROM run_queue WHERE run_id = $1 ORDER BY position`,
        [runId],
      );
      return rows;
    });
  }

  async loadToolNames(agentId: string | null): Promise<string[]> {
    if (!agentId) return [];
    return this.tx(async (q) => {
      const { rows } = await q<{ tool_names: string[] }>(
        `SELECT tool_names FROM agent_capabilities WHERE agent_id = $1 ORDER BY position`,
        [agentId],
      );
      const configured = [...new Set(rows.flatMap((row) => row.tool_names ?? []))];
      if (configured.length > 0) return configured;
      // No capability rows at all means nobody configured this agent. In a
      // deployed environment that is the answer — an unconfigured agent gets no
      // tools, which fails closed. In development it would mean a freshly
      // seeded database could not run a turn, so the seeded agent gets the
      // Work-mode set. `allowedTools` still filters by session mode either way.
      return this.env.ENVIRONMENT === 'development' ? [...DEFAULT_TOOL_NAMES] : [];
    });
  }

  async loadSystemPrompt(runId: string): Promise<string> {
    return this.tx(async (q) => {
      const { rows } = await q<{ body: string | null }>(
        `SELECT COALESCE(iv.body, a.instructions_active) AS body
           FROM runs r
           JOIN sessions s ON s.id = r.session_id
           JOIN agents a ON a.id = COALESCE(r.agent_id, s.agent_id)
           LEFT JOIN instruction_versions iv ON iv.id = r.instruction_version_id
          WHERE r.id = $1
          LIMIT 1`,
        [runId],
      );
      return rows[0]?.body ?? '';
    });
  }

  async loadWorkspaceContext(
    agentId: string | null,
  ): Promise<{ key: string; value: string | null; scope: string; run_id: string | null }[]> {
    if (!agentId) return [];
    return this.tx(async (q) => {
      // `run_id` is the provenance the prompt builder needs: a field written by
      // `set_context_field` carries the run that wrote it, a field answered by
      // a person does not. See the interface for why it was not read before.
      const { rows } = await q<{ key: string; value: string | null; scope: string; run_id: string | null }>(
        `SELECT key, value, scope, run_id FROM agent_context_fields WHERE agent_id = $1 ORDER BY key`,
        [agentId],
      );
      return rows;
    });
  }

  async resolveCredential(provider: string): Promise<Credential> {
    return this.tx(async (q) => {
      const resolved = await resolveKey({ query: q as never }, this.env, this.workspaceId, provider);
      return { provider: resolved.provider, apiKey: resolved.apiKey, keyId: resolved.keyId };
    });
  }

  async stopOtherRunsOnProvider(provider: string, exceptRunId: string): Promise<number> {
    return this.tx(async (q) => {
      const { rows } = await q<{ id: string }>(
        `UPDATE runs SET stop_requested = true
          WHERE workspace_id = $1 AND id <> $2 AND status IN ('working', 'waiting') AND stop_requested = false
            AND model_id IN (SELECT model_id FROM catalog WHERE provider = $3)
          RETURNING id`,
        [this.workspaceId, exceptRunId, provider],
      );
      return rows.length;
    });
  }

  async loadModel(modelId: string): Promise<{ model_id: string; provider: string; transport: string; effort_map: Record<string, string> | null } | null> {
    return this.tx(async (q) => {
      const model = await loadModel({ query: q as never }, modelId);
      return model
        ? { model_id: model.model_id, provider: model.provider, transport: model.transport, effort_map: model.effort_map }
        : null;
    });
  }

  // -------------------------------------------------------------------------
  // Run bookkeeping
  // -------------------------------------------------------------------------

  async enterStep(input: StepProgress): Promise<{ stepAttempt: number }> {
    return this.tx(async (q) => {
      const { rows } = await q<{ step_attempt: number }>(
        `INSERT INTO run_steps (workspace_id, run_id, turn, step_id, label, state, tool_call_id, started_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, now())
         ON CONFLICT (run_id, turn, step_id)
         DO UPDATE SET state = EXCLUDED.state,
                       started_at = now(),
                       ended_at = NULL,
                       step_attempt = run_steps.step_attempt + 1
         RETURNING step_attempt`,
        [this.workspaceId, input.runId, input.turn, input.stepId, input.label, input.state, input.toolCallId ?? null],
      );
      return { stepAttempt: rows[0]?.step_attempt ?? 1 };
    });
  }

  async finishStep(input: StepProgress): Promise<void> {
    await this.tx(async (q) => {
      await q(
        `UPDATE run_steps SET state = $5, ended_at = now()
          WHERE run_id = $2 AND turn = $3 AND step_id = $4 AND workspace_id = $1`,
        [this.workspaceId, input.runId, input.turn, input.stepId, input.state],
      );
    });
  }

  async setRunStatus(
    runId: string,
    status: string,
    detail: { waitingFor?: string | null; waitingLabel?: string | null; error?: RunErrorInput | null } = {},
  ): Promise<void> {
    await this.tx(async (q) => {
      await q(
        `UPDATE runs
            SET status = $2,
                waiting_for = CASE WHEN $3::boolean THEN $4 ELSE waiting_for END,
                waiting_label = CASE WHEN $3::boolean THEN $5 ELSE waiting_label END,
                error = CASE WHEN $6::boolean THEN $7::jsonb ELSE error END,
                ended_at = CASE WHEN $2 IN ('completed','stopped','error') THEN now() ELSE ended_at END
          WHERE id = $1
            -- A terminal run stays terminal. Without this guard the sweep's
            -- verdict was advisory: it marked an orphan as errored, the
            -- instance it could not see kept going, and its final
            -- setRunStatus(run.id, 'completed') resurrected a run a human had
            -- already been told was dead (security review O2). The sweep now
            -- terminates the instance as well, but the guard is the half that
            -- does not depend on terminate() doing anything.
            AND status NOT IN ('completed', 'stopped', 'error')`,
        [
          runId,
          status,
          'waitingFor' in detail,
          detail.waitingFor ?? null,
          detail.waitingLabel ?? null,
          'error' in detail,
          detail.error ? JSON.stringify(detail.error) : null,
        ],
      );
    });
  }

  async addActiveMs(runId: string, ms: number): Promise<number> {
    return this.tx(async (q) => {
      const { rows } = await q<{ active_ms: number }>(
        `UPDATE runs SET active_ms = active_ms + $2 WHERE id = $1 RETURNING active_ms`,
        [runId, Math.max(0, Math.round(ms))],
      );
      return rows[0]?.active_ms ?? 0;
    });
  }

  async upsertAssistantMessage(input: AssistantMessageInput): Promise<{ messageId: string; seq: number }> {
    return this.tx(async (q) => {
      const existing = await q<{ id: string; seq: number }>(
        `SELECT id, seq FROM messages WHERE run_id = $1 AND turn = $2 AND role = 'iris'`,
        [input.runId, input.turn],
      );
      const found = existing.rows[0];
      if (found) {
        await q(
          `UPDATE messages SET text = $2, blocks = $3::jsonb, status = $4, worked_ms = $5 WHERE id = $1`,
          [found.id, input.text, JSON.stringify(input.blocks), input.status, input.workedMs],
        );
        return { messageId: found.id, seq: found.seq };
      }
      const seqRow = await q<{ next_seq: number }>(
        `UPDATE sessions SET next_seq = next_seq + 1, last_activity_at = now()
          WHERE id = $1 RETURNING next_seq - 1 AS next_seq`,
        [input.sessionId],
      );
      const seq = seqRow.rows[0]?.next_seq ?? 0;
      const inserted = await q<{ id: string }>(
        `INSERT INTO messages (workspace_id, session_id, seq, role, text, blocks, status, run_id, turn, worked_ms)
         VALUES ($1, $2, $3, 'iris', $4, $5::jsonb, $6, $7, $8, $9)
         RETURNING id`,
        [
          this.workspaceId,
          input.sessionId,
          seq,
          input.text,
          JSON.stringify(input.blocks),
          input.status,
          input.runId,
          input.turn,
          input.workedMs,
        ],
      );
      return { messageId: inserted.rows[0]?.id ?? '', seq };
    });
  }

  async recordModelCall(input: {
    runId: string;
    turn: number;
    modelId: string;
    provider: string;
    keyId: string | null;
    usage: Usage;
    latencyMs: number | null;
    status: 'ok' | 'error' | 'stopped';
  }): Promise<void> {
    await this.tx(async (q) => {
      const model = await loadModel({ query: q as never }, input.modelId);
      const cost = model
        ? estimateCostUsd(model.pricing, {
            input_tokens: input.usage.input_tokens,
            output_tokens: input.usage.output_tokens,
            cached_input_tokens: input.usage.cached_input_tokens,
          })
        : 0;
      await q(
        `INSERT INTO model_calls
           (workspace_id, run_id, turn, model_id, provider, key_id, input_tokens, output_tokens,
            cached_input_tokens, reasoning_tokens, cost_usd_estimate, latency_ms, status, trace_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
        [
          this.workspaceId,
          input.runId,
          input.turn,
          input.modelId,
          input.provider,
          input.keyId,
          input.usage.input_tokens,
          input.usage.output_tokens,
          input.usage.cached_input_tokens,
          input.usage.reasoning_tokens,
          cost,
          input.latencyMs,
          input.status,
          this.traceId,
        ],
      );
    });
  }

  // -------------------------------------------------------------------------
  // AgentWrites
  // -------------------------------------------------------------------------

  /**
   * One outbox row, inside a transaction the caller already opened.
   *
   * Factored out of `emit` so that `proposeRequest` and `saveReviewNote` can
   * write the event in the *same* transaction as the row it is about. The
   * alternative — emit afterwards — has a window in which the request exists
   * and no event says so, and a crash inside that window leaves a request
   * nobody is told about until they reload. See decision F3.
   *
   * No RETURNING, for the reason `emit` gives: the `agent` role has INSERT on
   * `stream_events` and no SELECT, and holds `USAGE, SELECT` on the sequence.
   */
  private async insertEvent(
    q: <R>(text: string, values?: readonly unknown[]) => Promise<QueryResultLike<R>>,
    event: EmitInput,
  ): Promise<EmittedEvent | null> {
    await q(
      `INSERT INTO stream_events (workspace_id, session_id, kind, payload, trace_id)
       VALUES ($1, $2, $3, $4::jsonb, $5)`,
      [this.workspaceId, event.sessionId ?? null, event.kind, JSON.stringify(event.payload), this.traceId],
    );
    const { rows } = await q<{ id: string; created_at: Date }>(
      `SELECT currval('stream_events_id_seq')::text AS id, now() AS created_at`,
    );
    const row = rows[0];
    if (!row) return null;
    return {
      id: row.id,
      kind: event.kind,
      sessionId: event.sessionId ?? null,
      payload: event.payload,
      traceId: this.traceId,
      at: row.created_at.toISOString(),
    };
  }

  async proposeRequest(
    input: ProposeRequestInput,
  ): Promise<{ requestId: string; created: boolean; events?: readonly EmittedEvent[] }> {
    return this.tx(async (q) => {
      const inserted = await q<{ id: string }>(
        `INSERT INTO requests (workspace_id, kind, subject_key, label, payload, status, run_id, session_id, tool_call_id)
         VALUES ($1, $2, $3, $4, $5::jsonb, 'pending', $6, $7, $8)
         ON CONFLICT (run_id, tool_call_id) WHERE run_id IS NOT NULL AND tool_call_id IS NOT NULL
         DO NOTHING
         RETURNING id`,
        [
          this.workspaceId,
          input.kind as RequestKind,
          input.subjectKey,
          input.label,
          JSON.stringify(input.payload),
          input.runId,
          input.sessionId,
          input.toolCallId,
        ],
      );
      const created = inserted.rows[0]?.id;
      if (created) {
        // The event, in the transaction that made the row. The trigger in
        // migration 0013 lets the `agent` role publish this one because the
        // payload names a `requests` row with a `run_id` — a row only
        // `proposeRequest` writes. It is a workspace event (`sessionId: null`)
        // because every member's Inbox is what needs it, not the session's
        // socket.
        const event = await this.insertEvent(q, {
          kind: 'request.created',
          sessionId: null,
          payload: {
            request_id: created,
            kind: input.kind,
            status: 'pending',
            label: input.label,
            run_id: input.runId,
            session_id: input.sessionId,
          },
        });
        return { requestId: created, created: true, events: event ? [event] : [] };
      }
      const existing = await q<{ id: string }>(
        `SELECT id FROM requests WHERE run_id = $1 AND tool_call_id = $2`,
        [input.runId, input.toolCallId],
      );
      // A replayed step wrote nothing, so it publishes nothing: a second
      // `request.created` for the same id would put the row in the Inbox twice
      // on a client that had not seen the first.
      return { requestId: existing.rows[0]?.id ?? '', created: false };
    });
  }

  async saveReviewNote(
    input: SaveReviewNoteInput,
  ): Promise<{ noteId: string; created: boolean; events?: readonly EmittedEvent[] }> {
    return this.tx(async (q) => {
      const inserted = await q<{ id: string }>(
        `INSERT INTO request_notes (workspace_id, request_id, body, author_type, run_id, tool_call_id)
         VALUES ($1, $2, $3, 'agent', $4, $5)
         ON CONFLICT (run_id, tool_call_id) WHERE run_id IS NOT NULL AND tool_call_id IS NOT NULL
         DO NOTHING
         RETURNING id`,
        [this.workspaceId, input.requestId, input.body, input.runId, input.toolCallId],
      );
      const created = inserted.rows[0]?.id;
      if (created) {
        // A note changes what the review pane shows without changing the
        // request's status, which is exactly what `entity.updated` is for. It
        // names the request rather than the note, because the request is the
        // thing a member has open.
        const event = await this.insertEvent(q, {
          kind: 'entity.updated',
          sessionId: null,
          payload: {
            entity_type: 'request',
            entity_id: input.requestId,
            ref: { section: 'inbox', view: 'request', id: input.requestId },
            version: null,
          },
        });
        return { noteId: created, created: true, events: event ? [event] : [] };
      }
      const existing = await q<{ id: string }>(
        `SELECT id FROM request_notes WHERE run_id = $1 AND tool_call_id = $2`,
        [input.runId, input.toolCallId],
      );
      return { noteId: existing.rows[0]?.id ?? '', created: false };
    });
  }

  async setContextField(input: SetContextFieldInput): Promise<{ fieldId: string }> {
    return this.tx(async (q) => {
      const { rows } = await q<{ id: string }>(
        `INSERT INTO agent_context_fields (workspace_id, agent_id, key, value, scope, run_id, tool_call_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (agent_id, key)
         DO UPDATE SET value = EXCLUDED.value, scope = EXCLUDED.scope, updated_at = now()
         RETURNING id`,
        [this.workspaceId, input.agentId, input.key, input.value, input.scope, input.runId, input.toolCallId],
      );
      return { fieldId: rows[0]?.id ?? '' };
    });
  }

  async ensureContextField(input: {
    runId: string;
    toolCallId: string;
    agentId: string;
    key: string;
  }): Promise<void> {
    await this.tx(async (q) => {
      // `DO NOTHING`, not `DO UPDATE`: a field with an answer in it keeps the
      // answer. The row is a placeholder for the question, not a write of it.
      await q(
        `INSERT INTO agent_context_fields (workspace_id, agent_id, key, value, scope, run_id, tool_call_id)
         VALUES ($1, $2, $3, NULL, 'reply', $4, $5)
         ON CONFLICT (agent_id, key) DO NOTHING`,
        [this.workspaceId, input.agentId, input.key, input.runId, input.toolCallId],
      );
    });
  }

  async proposeInstruction(input: ProposeInstructionInput): Promise<{ versionId: string; created: boolean }> {
    return this.tx(async (q) => {
      const inserted = await q<{ id: string }>(
        `INSERT INTO instruction_versions (workspace_id, agent_id, body, status, run_id, tool_call_id, sources)
         VALUES ($1, $2, $3, 'proposed', $4, $5, $6::jsonb)
         ON CONFLICT (run_id, tool_call_id) WHERE run_id IS NOT NULL AND tool_call_id IS NOT NULL
         DO NOTHING
         RETURNING id`,
        [this.workspaceId, input.agentId, input.body, input.runId, input.toolCallId, JSON.stringify(input.sources)],
      );
      const created = inserted.rows[0]?.id;
      if (created) return { versionId: created, created: true };
      const existing = await q<{ id: string }>(
        `SELECT id FROM instruction_versions WHERE run_id = $1 AND tool_call_id = $2`,
        [input.runId, input.toolCallId],
      );
      return { versionId: existing.rows[0]?.id ?? '', created: false };
    });
  }

  async appendTurn(input: AppendTurnInput): Promise<{ turnId: string; created: boolean }> {
    return this.tx(async (q) => {
      const inserted = await q<{ id: string }>(
        `INSERT INTO run_turns (workspace_id, run_id, turn, seq, role, provider_message, tool_call_id, subject_id)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
         ON CONFLICT DO NOTHING
         RETURNING id`,
        [
          this.workspaceId,
          input.runId,
          input.turn,
          input.seq,
          input.role,
          JSON.stringify(input.providerMessage),
          input.toolCallId ?? null,
          input.subjectId ?? null,
        ],
      );
      const created = inserted.rows[0]?.id;
      if (created) return { turnId: created, created: true };
      const existing = await q<{ id: string }>(
        `SELECT id FROM run_turns WHERE run_id = $1 AND turn = $2 AND seq = $3`,
        [input.runId, input.turn, input.seq],
      );
      return { turnId: existing.rows[0]?.id ?? '', created: false };
    });
  }

  async emit(events: readonly EmitInput[]): Promise<EmittedEvent[]> {
    if (events.length === 0) return [];
    return this.tx(async (q) => {
      const written: EmittedEvent[] = [];
      for (const event of events) {
        const row = await this.insertEvent(q, event);
        if (row) written.push(row);
      }
      return written;
    });
  }

  // -------------------------------------------------------------------------
  // Tool reads
  // -------------------------------------------------------------------------

  async listRequests(status: string | null, limit: number): Promise<unknown[]> {
    return this.tx(async (q) => {
      const { rows } = await q<Record<string, unknown>>(
        `SELECT id, kind, status, label, created_at FROM requests
          WHERE workspace_id = $1 AND ($2::text IS NULL OR status = $2)
          ORDER BY created_at DESC LIMIT $3`,
        [this.workspaceId, status, Math.min(50, Math.max(1, limit))],
      );
      return rows;
    });
  }

  async getRequest(requestId: string): Promise<unknown | null> {
    return this.tx(async (q) => {
      const { rows } = await q<Record<string, unknown>>(
        `SELECT id, kind, status, label, payload, created_at FROM requests WHERE id = $1`,
        [requestId],
      );
      const row = rows[0];
      if (!row) return null;
      const notes = await q<Record<string, unknown>>(
        `SELECT id, body, author_type, created_at FROM request_notes WHERE request_id = $1 ORDER BY created_at`,
        [requestId],
      );
      return { ...row, notes: notes.rows };
    });
  }

  async getDocumentText(
    documentId: string,
    offset: number,
    maxChars: number,
  ): Promise<{ text: string; next_offset: number | null; total_chars: number } | null> {
    return this.tx(async (q) => {
      const { rows } = await q<{ body: string | null }>(
        `SELECT payload->>'text' AS body FROM documents WHERE id = $1`,
        [documentId],
      );
      const body = rows[0]?.body;
      if (body === undefined) return null;
      const text = body ?? '';
      const slice = text.slice(offset, offset + maxChars);
      const next = offset + slice.length;
      return { text: slice, next_offset: next < text.length ? next : null, total_chars: text.length };
    });
  }

  async getHistory(sessionId: string, limit: number): Promise<unknown[]> {
    return this.tx(async (q) => {
      const { rows } = await q<Record<string, unknown>>(
        `SELECT seq, role, kind, text, created_at FROM messages
          WHERE session_id = $1 ORDER BY seq DESC LIMIT $2`,
        [sessionId, Math.min(100, Math.max(1, limit))],
      );
      return rows.reverse();
    });
  }

  async listMembers(): Promise<unknown[]> {
    return this.tx(async (q) => {
      const { rows } = await q<Record<string, unknown>>(
        `SELECT m.user_id, m.role, m.reviewer_roles, u.name
           FROM members m JOIN users u ON u.id = m.user_id
          WHERE m.workspace_id = $1 AND m.status = 'active' ORDER BY u.name`,
        [this.workspaceId],
      );
      return rows;
    });
  }

  async isAwaitingContext(key: string): Promise<boolean> {
    return this.tx(async (q) => {
      const { rows } = await q<{ count: string }>(
        `SELECT count(*)::text AS count FROM runs
          WHERE workspace_id = $1 AND status = 'waiting' AND waiting_for = $2`,
        [this.workspaceId, key],
      );
      return Number(rows[0]?.count ?? '0') > 0;
    });
  }

  /**
   * The workspace's `fetch_url` allowlist.
   *
   * It lives in `workspace_settings.flags` rather than in a table of its own
   * because it is one list per workspace that an Admin edits in Settings, and
   * a table with one row per workspace and one column that matters is a table
   * that has to be joined everywhere to answer the same question. The shape is
   * `{"fetch_url_allowlist": ["example.com", "docs.example.org"]}`; anything
   * that is not an array of strings reads as empty, which refuses everything.
   */
  async loadFetchAllowlist(): Promise<string[]> {
    return this.tx(async (q) => {
      const { rows } = await q<{ flags: Record<string, unknown> | null }>(
        `SELECT flags FROM workspace_settings WHERE workspace_id = $1`,
        [this.workspaceId],
      );
      const raw = (rows[0]?.flags ?? {})['fetch_url_allowlist'];
      if (!Array.isArray(raw)) return [];
      return raw
        .filter((entry): entry is string => typeof entry === 'string')
        .map((entry) => entry.trim().toLowerCase())
        .filter((entry) => entry.length > 0 && entry.length <= 253)
        .slice(0, 200);
    });
  }

  async readContextField(agentId: string | null, key: string): Promise<string | null> {
    if (!agentId) return null;
    return this.tx(async (q) => {
      const { rows } = await q<{ value: string | null }>(
        `SELECT value FROM agent_context_fields WHERE agent_id = $1 AND key = $2`,
        [agentId, key],
      );
      return rows[0]?.value ?? null;
    });
  }
}
