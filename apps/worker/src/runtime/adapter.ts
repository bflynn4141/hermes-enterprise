// An official Hermes run projected into the existing enterprise event contract.
// Hermes owns tool iteration and session history. The Worker owns authorization,
// durable trace rows, human controls, and delivery to the app.
import type { AgentDb, EmitInput, EmittedEvent, EngineRunRow, RunErrorInput } from '../engine/agent-db.js';
import type { EngineStep, RunAttemptInput, StepConfig } from '../engine/engine.js';
import { buildSystemPrompt } from '../engine/prompt.js';
import { allowedTools } from '../engine/tools.js';
import { extractBlocks } from '../engine/blocks.js';
import type { ProviderMessage } from '../model/types.js';
import {
  HermesCapabilitiesError,
  HermesClient,
  HermesApiError,
  HermesContractError,
  terminalHermesStatus,
  type HermesStatus,
} from './client.js';
import { StreamBuffer } from './stream-buffer.js';
import type { RuntimeSkillManifest } from './skills.js';
import { classifyHermesFailure } from './errors.js';
import type { MessagePreviewFrame } from '@hermes/shared';
import { runtimeLatency, type RuntimeLatency } from './latency.js';

export interface RuntimePersistence extends AgentDb {
  binding(runId: string): Promise<{runtimeRunId:string|null;runtimeAttempt:number|null}|null>;
  bindRun(runId: string, attempt: number, remoteId: string, sessionId: string, profile: string): Promise<boolean>;
  snapshotRequest(runId: string, attempt: number, body: Record<string, unknown>): Promise<Record<string, unknown>>;
  loadBootstrapHistory(run: EngineRunRow): Promise<ProviderMessage[]>;
  nextRuntimeSequence(runId: string): Promise<number>;
  activeRuntimeMs?(runId: string, attempt: number, start: number, end: number): Promise<number>;
  finalizeRuntime<T>(runId: string, attempt: number, work: () => Promise<T>): Promise<T | null>;
  carryGuidance(runId: string, ids: string[]): Promise<void>;
}
export interface RuntimeDeps {
  db: RuntimePersistence;
  client: HermesClient;
  profile: string;
  forward(sessionId: string, runId: string, events: readonly EmittedEvent[]): Promise<{stop_requested:boolean}>;
  /** Dedicated persistence lane so streaming checkpoints never overlap control queries on one pg client. */
  checkpoint?(events: EmitInput[]): Promise<EmittedEvent[]>;
  /** Best-effort WebSocket fast lane; durable checkpoints remain authoritative. */
  preview?(frame: MessagePreviewFrame): Promise<unknown>;
  /** Exact non-secret managed skill/config versions persisted with the run. */
  skillSnapshot?: readonly RuntimeSkillManifest[];
  pollMs?: number;
  /** Test seam for the durable stream coalescing window. */
  batchMs?: number;
  /** Maximum tail-drain wait after authoritative completion without a native terminal frame. */
  drainMs?: number;
  /** Counts and relative timings only; never prompt, response, or tool contents. */
  onStreamMetrics?(metrics: RuntimeStreamMetrics): void;
  /** Current Workflow invocation entry, not a replayed checkpoint timestamp. */
  startedAt?: number;
  /** Server-received turn timestamp, when available. Never supplied by a client. */
  receivedAt?: number;
  onLatency?(measurement: RuntimeLatency): void;
  /** Safe terminal classification only; the native provider error never crosses this seam. */
  onTerminalFailure?(failure: RuntimeTerminalFailure): void;
}
export interface RuntimeStreamMetrics {
  first_delta_ms: number | null;
  first_preview_ms: number | null;
  first_checkpoint_ms: number | null;
  delta_count: number;
  delta_characters: number;
  preview_count: number;
  stream_end: 'terminal' | 'eof' | 'disconnected' | 'drain_timeout' | 'not_opened';
}
export interface RuntimeTerminalFailure {
  native_status: string;
  failure_code: string;
  error_class: string;
  reason: string;
  retryable: boolean;
  native_error_present: boolean;
  structured_error: boolean;
  terminal_error_schema_version: number | null;
  terminal_error_source: string;
  native_error_code: string | null;
  worked_ms: number;
  partial_characters: number;
}
const CHECKPOINT: StepConfig = { retries: { limit: 3, delay: 1000, backoff: 'exponential' }, timeout: '1 minute' };
// A failed stream is reconciled with native status, never replayed as a new run.
const EXECUTION: StepConfig = { retries: { limit: 1, delay: 1000, backoff: 'constant' }, timeout: '60 minutes' };
const FRESH_CAPABILITIES_MS = 5_000;

export async function runHermesAttempt(deps: RuntimeDeps, step: EngineStep, input: RunAttemptInput): Promise<void> {
  const latency = runtimeLatency(deps.startedAt ?? Date.now(), deps.receivedAt, deps.onLatency);
  const { db, client } = deps;
  const run = await db.loadRun(input.runId);
  if (!run || run.attempt !== input.attempt || !run.agentId) throw new Error('Hermes run has no current agent binding');
  const emit = async (events: EmitInput[]): Promise<void> => {
    const saved = await db.emit(events.map((event) => ({ ...event, sessionId: run.sessionId })));
    await deps.forward(run.sessionId, run.id, saved);
  };
  let remoteId: string | null = null;
  let terminal = false;
  let currentMessageId: string | null = null;
  let visibleText = '';
  const nativeToolControl: { close: ((failed: boolean) => Promise<void>) | null } = { close: null };
  // A one-use in-memory handoff only. Checkpoint replay cannot recreate it;
  // resumed/retried execution and a slow submission still reattest live.
  let freshSubmissionCheckedAt: number | null = null;
  try {
    const existingBinding = await db.binding(run.id);
    if (existingBinding?.runtimeAttempt === run.attempt && ['completed', 'error', 'stopped'].includes(run.status)) return;
    const stopAtStart = await db.stopRequested(run.id);
    if (stopAtStart && existingBinding?.runtimeRunId && existingBinding.runtimeAttempt === run.attempt) {
      remoteId = existingBinding.runtimeRunId;
      await client.stop(remoteId);
    }
    if (stopAtStart && !remoteId) {
      await db.setRunStatus(run.id, 'stopped');
      await emit([{ kind: 'run.status', payload: { run_id: run.id, attempt: run.attempt, status: 'stopped' } }]);
      return;
    }
    await step.do('hermes-started', CHECKPOINT, async () => {
      if (!stopAtStart) await db.setRunStatus(run.id, 'working');
      await emit([{ kind: 'run.started', payload: {
        run_id: run.id, session_id: run.sessionId, attempt: run.attempt,
        engine_version: run.engineVersion, client_turn_id: run.clientTurnId,
        mode: run.mode, model_id: run.modelId, effort: run.effort, title: null, steps: [],
      } }]);
      return { ok: true };
    });
    const submitted = await step.do('hermes-submit', CHECKPOINT, async () => {
      // A Workflow callback may be replaying after either process restarted.
      // Re-read the live contract before trusting a persisted binding or
      // replaying the stable idempotency key.
      const [checkedAt, existing] = await Promise.all([
        latency.measure('submit_capabilities', async () => {
          await client.capabilities();
          return Date.now();
        }),
        db.binding(run.id),
      ]);
      if (existing?.runtimeAttempt === run.attempt && existing.runtimeRunId) return { id: existing.runtimeRunId };
      const preparationStartedAt = Date.now();
      const history = await db.loadHistory(run.id, 100);
      const userInput = history.recent.filter((row) => row.role === 'user').map((row) => row.providerMessage.content ?? '').join('\n\n');
      const previous = await db.loadBootstrapHistory(run);
      const model = await db.loadModel(run.modelId);
      if (!model || !['openrouter', 'nous_portal'].includes(model.provider)) {
        throw new Error('Hermes requires a runtime-supported model');
      }
      const wireModel = model.model_id.replace(/^(?:openrouter|nous):/, '');
      const proposed: Record<string, unknown> = {
        input: userInput,
        session_id: run.sessionId,
        model: wireModel,
        provider: 'custom',
        instructions: await buildSystemPrompt(db, run, []),
        _enterprise_tool_names: allowedTools(run.mode, await db.loadToolNames(run.agentId)).map((tool) => tool.name),
        _enterprise_skills: deps.skillSnapshot ?? [],
      };
      if (previous.length) proposed.conversation_history = previous;
      if (run.effort) proposed.model_options = { reasoning_effort: run.effort };
      const body = await db.snapshotRequest(run.id, run.attempt, proposed);
      latency.mark('submit_preparation', preparationStartedAt);
      const id = await latency.measure('native_submit', () => client.submit(body, `enterprise-${run.id}-a${run.attempt}`));
      if (!await latency.measure('native_binding', () => db.bindRun(run.id, run.attempt, id, run.sessionId, deps.profile))) {
        await client.stop(id);
        throw new Error('Hermes run attempt was superseded');
      }
      freshSubmissionCheckedAt = checkedAt;
      return { id };
    });
    remoteId = submitted.id;
    const id = submitted.id;
    await step.do('hermes-execute', EXECUTION, async () => {
      const checkedAt = freshSubmissionCheckedAt;
      freshSubmissionCheckedAt = null;
      const age = checkedAt === null ? null : Date.now() - checkedAt;
      if (age === null || age < 0 || age > FRESH_CAPABILITIES_MS) {
        // Independent retry/reconciliation must not trust a pre-restart check.
        await latency.measure('execute_capabilities', () => client.capabilities());
      }
      const startedAt = Date.now();
      const progress = { runId: run.id, turn: 0, stepId: 'hermes', label: 'Thinking', state: 'active' as const };
      const { stepAttempt } = await db.enterStep(progress);
      const { messageId } = await db.upsertAssistantMessage({ runId: run.id, sessionId: run.sessionId, turn: 0, text: '', blocks: [], status: 'streaming', workedMs: null });
      currentMessageId = messageId;
      visibleText = '';
      await emit([
        { kind: 'run.step', payload: { run_id: run.id, attempt: run.attempt, turn: 0, step_id: 'hermes', label: 'Thinking', state: 'active', tool_call_id: null } },
        { kind: 'message.reset', payload: { run_id: run.id, turn: 0, attempt: run.attempt, step_attempt: stepAttempt, message_id: messageId } },
      ]);
      let text = '';
      let sequence = 0;
      let stopFromForward = false;
      let nativeToolOrdinal = 0;
      let reasoningRecorded = false;
      const nativeTools: Array<{ tool: string; stepId: string; toolCallId: string; label: string }> = [];
      const pollMs = deps.pollMs ?? 1000;
      const batchMs = deps.batchMs ?? 75;
      const drainMs = deps.drainMs ?? 1000;
      const metrics: RuntimeStreamMetrics = {
        first_delta_ms: null, first_preview_ms: null, first_checkpoint_ms: null,
        delta_count: 0, delta_characters: 0, preview_count: 0, stream_end: 'not_opened',
      };
      // Tool activity and human controls share one pg client. Queue whole
      // operations, including multi-query steps, rather than interleave their
      // transactions. Production delta checkpoints have their own connection.
      let dbTail = Promise.resolve();
      let dbPending = 0;
      let dbFailure: unknown = null;
      const serialDb = <T>(work: () => Promise<T>): Promise<T> => {
        if (++dbPending > 256) {
          dbPending -= 1;
          dbFailure ??= new Error('Hermes activity exceeded its pending event limit');
          return Promise.reject(dbFailure);
        }
        const task = dbTail.then(() => {
          if (dbFailure) throw dbFailure;
          return work();
        });
        dbTail = task.then(() => undefined, (error: unknown) => { dbFailure ??= error; })
          .finally(() => { dbPending -= 1; });
        return task;
      };
      const startNativeTool = async (tool: string) => {
        const ordinal = ++nativeToolOrdinal;
        const stepId = `hermes-tool-${ordinal}`;
        const toolCallId = stepId;
        // Keep the same exact tool identity as bridge-backed steps. The client
        // pairs it with human wording without changing the trace's identifier.
        const label = tool;
        nativeTools.push({ tool, stepId, toolCallId, label });
        await db.enterStep({ runId: run.id, turn: 0, stepId, label, state: 'active', toolCallId });
        await emit([{ kind: 'run.step', payload: {
          run_id: run.id, attempt: run.attempt, turn: 0, step_id: stepId,
          label, state: 'active', tool_call_id: toolCallId,
        } }]);
      };
      const finishNativeTool = async (tool: string, failed = false) => {
        let index = -1;
        for (let candidate = nativeTools.length - 1; candidate >= 0; candidate -= 1) {
          if (nativeTools[candidate]?.tool === tool) { index = candidate; break; }
        }
        if (index < 0) {
          await startNativeTool(tool);
          index = nativeTools.length - 1;
        }
        const activity = nativeTools[index]!;
        nativeTools.splice(index, 1);
        const state = failed ? 'failed' as const : 'done' as const;
        await db.finishStep({ runId: run.id, turn: 0, stepId: activity.stepId, label: activity.label, state, toolCallId: activity.toolCallId });
        await emit([{ kind: 'run.step', payload: {
          run_id: run.id, attempt: run.attempt, turn: 0, step_id: activity.stepId,
          label: activity.label, state, tool_call_id: activity.toolCallId,
        } }]);
      };
      nativeToolControl.close = async (failed: boolean) => {
        while (nativeTools.length > 0) {
          await finishNativeTool(nativeTools[nativeTools.length - 1]!.tool, failed);
        }
      };
      const recordReasoningBoundary = async () => {
        if (reasoningRecorded) return;
        reasoningRecorded = true;
        const reasoning = { runId: run.id, turn: 0, stepId: 'hermes-reasoning', label: 'Reasoning', state: 'active' as const };
        await db.enterStep(reasoning);
        await db.finishStep({ ...reasoning, state: 'done' });
        // Hermes calls the accompanying field a preview. Treat the event as a
        // truthful phase boundary, but never forward its text as hidden model
        // reasoning. The transcript exposes observable work and tool calls.
        await emit([{ kind: 'run.step', payload: {
          run_id: run.id, attempt: run.attempt, turn: 0, step_id: reasoning.stepId,
          label: reasoning.label, state: 'done', tool_call_id: null,
        } }]);
      };
      const previews = new StreamBuffer(Math.min(batchMs, 75), async (delta, offset) => {
        if (!deps.preview) return;
        try {
          await deps.preview({
            type: 'message.preview', session_id: run.sessionId, run_id: run.id,
            turn: 0, attempt: run.attempt, step_attempt: stepAttempt, offset, delta,
          });
          if (metrics.first_preview_ms === null) latency.mark('first_preview');
          metrics.first_preview_ms ??= Date.now() - startedAt;
          metrics.preview_count += 1;
        } catch { /* Durable checkpoints repair a missed best-effort preview. */ }
      });
      const checkpoints = new StreamBuffer(batchMs, async (delta) => {
        const events: EmitInput[] = [{ kind: 'message.delta', sessionId: run.sessionId, payload: {
          message_id: messageId, run_id: run.id, turn: 0, attempt: run.attempt, step_attempt: stepAttempt, seq: sequence++, delta,
        } }];
        const saved = await (deps.checkpoint ? deps.checkpoint(events) : serialDb(() => db.emit(events)));
        if (metrics.first_checkpoint_ms === null) latency.mark('first_checkpoint');
        metrics.first_checkpoint_ms ??= Date.now() - startedAt;
        const reply = await deps.forward(run.sessionId, run.id, saved);
        stopFromForward ||= reply.stop_requested;
      });
      // A replay of a bound, completed run needs no second native subscriber.
      // Fresh runs subscribe immediately, without waiting for a status RPC.
      let status: HermesStatus = existingBinding?.runtimeRunId === id
        ? await client.status(id)
        : { run_id: id, status: 'running' };
      const controller = new AbortController();
      let reading = !terminalHermesStatus(status.status);
      let readerFailure: unknown = null;
      const controlWake: { current: (() => void) | null } = { current: null };
      const reader = (async () => {
        if (!reading) return;
        latency.mark('stream_subscribe_started');
        try {
          for await (const payload of client.events(id, controller.signal)) {
            if (controller.signal.aborted) break;
            // No network or database work is awaited by this sole native
            // consumer. Its bounded lanes preserve order independently.
            if (payload.event === 'message.delta' && typeof payload.delta === 'string' && payload.delta.length > 0) {
              if (text.length + payload.delta.length > 4 * 1024 * 1024) {
                readerFailure = new Error('Hermes response exceeded its streaming limit');
                break;
              }
              text += payload.delta;
              visibleText = text;
              if (metrics.first_delta_ms === null) latency.mark('first_delta');
              metrics.first_delta_ms ??= Date.now() - startedAt;
              metrics.delta_count += 1;
              metrics.delta_characters += payload.delta.length;
              previews.append(payload.delta);
              checkpoints.append(payload.delta);
            }
            if (payload.event === 'tool.started' && typeof payload.tool === 'string') {
              const tool = payload.tool;
              void serialDb(() => startNativeTool(tool)).catch(() => undefined);
            }
            if (payload.event === 'tool.completed' && typeof payload.tool === 'string') {
              const tool = payload.tool;
              void serialDb(() => finishNativeTool(tool, payload.error === true)).catch(() => undefined);
            }
            if (payload.event === 'reasoning.available') {
              void serialDb(recordReasoningBoundary).catch(() => undefined);
            }
            if (['run.completed', 'run.failed', 'run.cancelled'].includes(payload.event)) {
              metrics.stream_end = 'terminal';
              break;
            }
          }
          if (metrics.stream_end === 'not_opened') metrics.stream_end = 'eof';
        } catch {
          // The pinned native queue cannot replay. Preserve received text and
          // recover the authoritative result through status, never resubmit.
          if (!controller.signal.aborted) metrics.stream_end = 'disconnected';
        } finally {
          reading = false;
          previews.flush(true);
          checkpoints.flush(true);
          controlWake.current?.();
        }
      })();
      let stopped = stopAtStart;
      const sentGuidance = new Map<string, string>();
      const deadline = Date.now() + 55 * 60_000;
      try {
        while (!terminalHermesStatus(status.status)) {
          if (Date.now() >= deadline) throw new Error('Hermes run exceeded its execution time limit');
          if (readerFailure || dbFailure || checkpoints.failure) throw readerFailure ?? dbFailure ?? checkpoints.failure;
          if (!stopped && (stopFromForward || await serialDb(() => db.stopRequested(run.id)))) {
            await client.stop(id);
            stopped = true;
          }
          if (!stopped) {
            for (const row of await serialDb(() => db.loadGuidance(run.id))) {
              if (row.status !== 'queued' || sentGuidance.has(row.id)) continue;
              if (await client.steer(id, row.text)) sentGuidance.set(row.id, row.text);
            }
          }
          status = await client.status(id);
          if (terminalHermesStatus(status.status)) break;
          // EOF wakes an in-progress wait once. A disconnected stream keeps
          // the bounded status polling cadence rather than spinning on EOF.
          await new Promise<void>((resolve) => {
            const timer = setTimeout(() => { controlWake.current = null; resolve(); }, pollMs);
            controlWake.current = () => { clearTimeout(timer); controlWake.current = null; resolve(); };
          });
        }
        // Status may outrun the last SSE frame. Give the independent reader a
        // bounded tail window; completion must not discard already-sent text.
        if (reading) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          await Promise.race([reader, new Promise<void>((resolve) => { timer = setTimeout(resolve, drainMs); })]);
          clearTimeout(timer);
          if (reading) metrics.stream_end = 'drain_timeout';
        }
      } finally {
        controller.abort();
        // Reader callbacks check abort before touching state. Drain every
        // already-enqueued operation even on failure before error/final writes
        // reuse the database. A rejected lane must not short-circuit the others.
        const previewDrain = (async () => {
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            await Promise.race([previews.drain(), new Promise<void>((resolve) => { timer = setTimeout(resolve, 250); })]);
          } finally {
            clearTimeout(timer);
            previews.discard();
          }
        })();
        const drained = await Promise.allSettled([previewDrain, checkpoints.drain(), dbTail]);
        try { deps.onStreamMetrics?.({ ...metrics }); } catch { /* Telemetry cannot change run outcome. */ }
        const rejected = drained.find((result) => result.status === 'rejected');
        if (rejected?.status === 'rejected') throw rejected.reason;
        if (readerFailure || dbFailure) throw readerFailure ?? dbFailure;
      }
      terminal = true;
      visibleText = status.output ?? text;
      const workedMs = db.activeRuntimeMs ? await db.activeRuntimeMs(run.id, run.attempt, startedAt, Date.now()) : Math.max(0, Date.now() - startedAt);
      const finalText = status.output ?? text;
      const parsed = extractBlocks(finalText);
      const completed = status.status === 'completed';
      // Revoking enterprise tool/model authority can terminate the native run
      // before its polling loop receives /stop. A confirmed terminal failure
      // after the person's Stop is still stopped work, not a retry prompt.
      const stoppedStatus = status.status === 'cancelled' || (!completed && (stopped || await db.stopRequested(run.id)));
      const finalStatus = completed ? 'completed' : stoppedStatus ? 'stopped' : 'error';
      await nativeToolControl.close(finalStatus !== 'completed');
      const classified = finalStatus === 'error' ? classifyHermesFailure(status) : null;
      const error: RunErrorInput | null = classified?.error ?? null;
      if (classified) {
        try {
          deps.onTerminalFailure?.({
            native_status: status.status,
            failure_code: classified.code,
            error_class: classified.error.class,
            reason: classified.error.reason,
            retryable: classified.error.retryable,
            native_error_present: classified.nativeErrorPresent,
            structured_error: classified.structured,
            terminal_error_schema_version: classified.contractVersion,
            terminal_error_source: classified.source,
            native_error_code: classified.nativeCode,
            worked_ms: workedMs,
            partial_characters: parsed.text.length,
          });
        } catch { /* Telemetry cannot change run outcome. */ }
      }
      const finalEvents = await db.finalizeRuntime(run.id, run.attempt, async () => {
      const guidanceEvents: EmitInput[] = [];
      for (const [guidanceId, guidanceText] of sentGuidance) {
        if (status.status !== 'completed' || status.pending_steer?.includes(guidanceText)) continue;
        await db.markGuidanceApplied(run.id, guidanceId, 0);
        guidanceEvents.push({ kind: 'run.guidance.applied', payload: { run_id: run.id, guidance_id: guidanceId, turn: 0 } });
      }
      await db.carryGuidance(run.id, (await db.loadGuidance(run.id)).map((row) => row.id));
      await db.upsertAssistantMessage({ runId: run.id, sessionId: run.sessionId, turn: 0, text: parsed.text, blocks: parsed.blocks, status: completed ? 'complete' : 'incomplete', workedMs });
      await db.appendTurn({ runId: run.id, turn: run.maxTurns + run.attempt, seq: 0, toolCallId: `hermes-final-${run.attempt}`, role: 'assistant', providerMessage: { role: 'assistant', content: parsed.text } });
      const activeMs = await db.addActiveMs(run.id, workedMs);
      await db.finishStep({ ...progress, state: finalStatus === 'error' ? 'failed' : 'done' });
      await db.setRunStatus(run.id, finalStatus, { error, waitingFor: null, waitingLabel: null });
      return db.emit([
        ...guidanceEvents,
        { kind: 'run.step', payload: { run_id: run.id, attempt: run.attempt, turn: 0, step_id: 'hermes', label: 'Thinking', state: finalStatus === 'error' ? 'failed' : 'done', tool_call_id: null } },
        { kind: 'message.final', payload: { message_id: messageId, session_id: run.sessionId, run_id: run.id, turn: 0, attempt: run.attempt, text: parsed.text, blocks: parsed.blocks, incomplete: !completed, worked_ms: workedMs } },
        { kind: 'run.status', payload: { run_id: run.id, attempt: run.attempt, status: finalStatus, active_ms: activeMs, error } },
      ].map((event) => ({ ...event, sessionId: run.sessionId })));
      });
      if (finalEvents?.length) await deps.forward(run.sessionId, run.id, finalEvents).catch(() => undefined);
      return { status: finalStatus };
    });
  } catch (error) {
    if (remoteId && !terminal) await client.stop(remoteId).catch(() => undefined);
    await nativeToolControl.close?.(true).catch(() => undefined);
    const contractViolation = error instanceof HermesContractError || error instanceof HermesCapabilitiesError;
    const detail: RunErrorInput = contractViolation
      ? {
          class: 'permanent', retryable: false, reason: 'hermes_contract_violation',
          message: 'This Hermes runtime needs an Enterprise compatibility update before it can continue.',
        }
      : {
          class: 'transient', retryable: true, reason: 'hermes_unavailable',
          message: error instanceof HermesApiError ? error.message : 'The Hermes runtime is unavailable. Retry to reconnect.',
        };
    if (contractViolation) {
      try {
        deps.onTerminalFailure?.({
          native_status: 'contract_violation',
          failure_code: 'contract_violation',
          error_class: detail.class,
          reason: detail.reason,
          retryable: detail.retryable,
          native_error_present: false,
          structured_error: false,
          terminal_error_schema_version: null,
          terminal_error_source: 'contract',
          native_error_code: null,
          worked_ms: 0,
          partial_characters: visibleText.length,
        });
      } catch { /* Telemetry cannot change run outcome. */ }
    }
    // Close the visible activity and preserve partial output even when the
    // runtime disappears. A stale attempt may not overwrite its successor.
    const failedEvents = await db.finalizeRuntime(run.id, run.attempt, async () => {
      const events: EmitInput[] = [];
      if (currentMessageId) {
        const parsed = extractBlocks(visibleText);
        await db.upsertAssistantMessage({ runId: run.id, sessionId: run.sessionId, turn: 0, text: parsed.text, blocks: parsed.blocks, status: 'incomplete', workedMs: null });
        await db.finishStep({ runId: run.id, turn: 0, stepId: 'hermes', label: 'Thinking', state: 'failed' });
        events.push(
          { kind: 'run.step', payload: { run_id: run.id, attempt: run.attempt, turn: 0, step_id: 'hermes', label: 'Thinking', state: 'failed', tool_call_id: null } },
          { kind: 'message.final', payload: { message_id: currentMessageId, session_id: run.sessionId, run_id: run.id, turn: 0, attempt: run.attempt, text: parsed.text, blocks: parsed.blocks, incomplete: true, worked_ms: null } },
        );
      }
      await db.carryGuidance(run.id, (await db.loadGuidance(run.id)).map((row) => row.id));
      await db.setRunStatus(run.id, 'error', { error: detail, waitingFor: null, waitingLabel: null });
      events.push({ kind: 'run.status', payload: { run_id: run.id, attempt: run.attempt, status: 'error', error: detail } });
      return db.emit(events.map((event) => ({ ...event, sessionId: run.sessionId })));
    });
    if (failedEvents?.length) await deps.forward(run.sessionId, run.id, failedEvents).catch(() => undefined);
  }
}
