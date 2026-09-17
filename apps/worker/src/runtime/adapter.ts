// An official Hermes run projected into the existing enterprise event contract.
// Hermes owns tool iteration and session history. The Worker owns authorization,
// durable trace rows, human controls, and delivery to the app.
import type { AgentDb, EmitInput, EmittedEvent, EngineRunRow, RunErrorInput } from '../engine/agent-db.js';
import type { EngineStep, RunAttemptInput, StepConfig } from '../engine/engine.js';
import { buildSystemPrompt } from '../engine/prompt.js';
import { allowedTools } from '../engine/tools.js';
import { extractBlocks } from '../engine/blocks.js';
import type { ProviderMessage } from '../model/types.js';
import { HermesClient, HermesApiError, terminalHermesStatus } from './client.js';
import type { RuntimeSkillManifest } from './skills.js';
import type { MessagePreviewFrame } from '@hermes/shared';

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
}
const CHECKPOINT: StepConfig = { retries: { limit: 3, delay: 1000, backoff: 'exponential' }, timeout: '1 minute' };
// A failed stream is reconciled with native status, never replayed as a new run.
const EXECUTION: StepConfig = { retries: { limit: 1, delay: 1000, backoff: 'constant' }, timeout: '60 minutes' };
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function runHermesAttempt(deps: RuntimeDeps, step: EngineStep, input: RunAttemptInput): Promise<void> {
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
      await client.capabilities();
      const existing = await db.binding(run.id);
      if (existing?.runtimeAttempt === run.attempt && existing.runtimeRunId) return { id: existing.runtimeRunId };
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
      const id = await client.submit(body, `enterprise-${run.id}-a${run.attempt}`);
      if (!await db.bindRun(run.id, run.attempt, id, run.sessionId, deps.profile)) {
        await client.stop(id);
        throw new Error('Hermes run attempt was superseded');
      }
      return { id };
    });
    remoteId = submitted.id;
    const id = submitted.id;
    await step.do('hermes-execute', EXECUTION, async () => {
      // This step is independently retried. Do not let an API server that
      // restarted into its in-memory fallback look healthy on reconciliation.
      await client.capabilities();
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
      let pending = '';
      let previewPending = '';
      let previewOffset = 0;
      let sequence = 0;
      let flushedAt = 0;
      let previewFlushedAt = 0;
      let durableInFlight: Promise<void> | null = null;
      let durableFailure: unknown = null;
      let stopFromForward = false;
      let nativeToolOrdinal = 0;
      const nativeTools: Array<{ tool: string; stepId: string; toolCallId: string; label: string }> = [];
      const pollMs = deps.pollMs ?? 1000;
      const batchMs = deps.batchMs ?? 75;
      const previewMs = Math.min(batchMs, 75);
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
      const flushPreview = async (force = false) => {
        if (!previewPending || (!force && Date.now() - previewFlushedAt < previewMs)) return;
        const delta = previewPending;
        previewPending = '';
        const offset = previewOffset;
        previewOffset += delta.length;
        previewFlushedAt = Date.now();
        await deps.preview?.({
          type: 'message.preview', session_id: run.sessionId, run_id: run.id,
          turn: 0, attempt: run.attempt, step_attempt: stepAttempt, offset, delta,
        }).catch(() => undefined);
      };
      const flush = (force = false) => {
        if (durableInFlight || !pending || (!force && Date.now() - flushedAt < batchMs)) return;
        const delta = pending; pending = '';
        flushedAt = Date.now();
        const task = (async () => {
          try {
            const saved = await (deps.checkpoint ?? ((events: EmitInput[]) => db.emit(events)))([{ kind: 'message.delta', sessionId: run.sessionId, payload: {
              message_id: messageId, run_id: run.id, turn: 0, attempt: run.attempt, step_attempt: stepAttempt, seq: sequence++, delta,
            } }]);
            const reply = await deps.forward(run.sessionId, run.id, saved);
            stopFromForward ||= reply.stop_requested;
          } catch (error) {
            durableFailure ??= error;
          } finally {
            durableInFlight = null;
          }
        })();
        durableInFlight = task;
      };
      const drainDurable = async () => {
        while (durableInFlight || pending) {
          if (durableFailure) throw durableFailure;
          if (!durableInFlight) flush(true);
          if (durableInFlight) await durableInFlight;
        }
        if (durableFailure) throw durableFailure;
      };
      let status = await client.status(id);
      const controller = new AbortController();
      const events = client.events(id, controller.signal)[Symbol.asyncIterator]();
      let next = terminalHermesStatus(status.status) ? null : events.next().catch(() => null);
      let stopped = stopAtStart;
      const sentGuidance = new Map<string, string>();
      let lastControlCheck = 0;
      const deadline = Date.now() + 55 * 60_000;
      try {
        while (!terminalHermesStatus(status.status)) {
          if (Date.now() >= deadline) throw new Error('Hermes run exceeded its execution time limit');
          // A short delta that arrives inside the coalescing window still gets
          // a trailing deadline. Waiting only for the next native frame left
          // that text parked until the one-second status poll when the model
          // paused after a token burst.
          const untilBatch = pending && !durableInFlight ? Math.max(0, batchMs - (Date.now() - flushedAt)) : pollMs;
          const untilPreview = previewPending ? Math.max(0, previewMs - (Date.now() - previewFlushedAt)) : pollMs;
          const waitMs = Math.min(pollMs, untilBatch, untilPreview);
          const wake: Array<Promise<Awaited<NonNullable<typeof next>> | undefined>> = [delay(waitMs).then(() => undefined)];
          if (next) wake.push(next);
          const activeWrite = durableInFlight as Promise<void> | null;
          if (activeWrite) wake.push(activeWrite.then(() => undefined));
          const event = await Promise.race(wake);
          if (event === null || event?.done) {
            // `read1` can surface the last native bytes immediately before EOF
            // or a disconnect. Publish them now; the status poll is recovery,
            // not part of the person's text latency budget.
            await flushPreview(true);
            flush(true);
            next = null;
          }
          else if (event?.value) {
            const payload = event.value;
            if (payload.event === 'tool.started' && typeof payload.tool === 'string') {
              await startNativeTool(payload.tool);
            }
            if (payload.event === 'tool.completed' && typeof payload.tool === 'string') {
              await finishNativeTool(payload.tool, payload.error === true);
            }
            if (payload.event === 'message.delta' && typeof payload.delta === 'string') {
              text += payload.delta; pending += payload.delta; previewPending += payload.delta;
              visibleText = text;
              await flushPreview();
              flush();
            }
            if (payload.event.startsWith('run.') && ['run.completed','run.failed','run.cancelled'].includes(payload.event)) {
              // A terminal frame often follows the last token in the same TCP
              // read. Do not hold that token behind a potentially slow status
              // reconciliation request.
              await flushPreview(true);
              flush(true);
              status = await client.status(id);
            }
            next = terminalHermesStatus(status.status) ? null : events.next().catch(() => null);
          }
          if (previewPending && Date.now() - previewFlushedAt >= previewMs) await flushPreview(true);
          if (durableFailure) throw durableFailure;
          if (!stopped && stopFromForward) {
            await client.stop(id);
            stopped = true;
          }
          if (pending && Date.now() - flushedAt >= batchMs) flush(true);
          if (Date.now() - lastControlCheck >= pollMs) {
            lastControlCheck = Date.now();
            if (!stopped && await db.stopRequested(run.id)) {
              await client.stop(id); stopped = true;
            }
            if (!stopped) {
              for (const row of await db.loadGuidance(run.id)) {
                if (row.status !== 'queued' || sentGuidance.has(row.id)) continue;
                if (await client.steer(id, row.text)) sentGuidance.set(row.id, row.text);
              }
            }
            await flushPreview(true);
            flush(true);
            status = await client.status(id);
          }
          if (!next && !terminalHermesStatus(status.status)) await delay(pollMs);
        }
      } finally {
        controller.abort();
        // No execution path may let finalization overtake a checkpoint that is
        // still using the dedicated persistence lane.
        await flushPreview(true);
        await drainDurable();
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
      const error: RunErrorInput | null = finalStatus === 'error' ? {
        class: 'transient', retryable: true, reason: 'hermes_run_failed', message: 'Hermes could not finish this run. Retry to continue.',
      } : null;
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
    const detail: RunErrorInput = { class: 'transient', retryable: true, reason: 'hermes_unavailable', message: error instanceof HermesApiError ? error.message : 'The Hermes runtime is unavailable. Retry to reconnect.' };
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
