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
  pollMs?: number;
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
      let sequence = 0;
      let flushedAt = 0;
      const flush = async (force = false) => {
        if (!pending || (!force && Date.now() - flushedAt < 100)) return;
        const delta = pending; pending = ''; flushedAt = Date.now();
        const saved = await db.emit([{ kind: 'message.delta', sessionId: run.sessionId, payload: {
          message_id: messageId, run_id: run.id, turn: 0, attempt: run.attempt, step_attempt: stepAttempt, seq: sequence++, delta,
        } }]);
        await deps.forward(run.sessionId, run.id, saved);
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
          const event = next ? await Promise.race([next, delay(deps.pollMs ?? 1000).then(() => undefined)]) : undefined;
          if (event === null || event?.done) next = null;
          else if (event?.value) {
            const payload = event.value;
            if (payload.event === 'message.delta' && typeof payload.delta === 'string') {
              text += payload.delta; pending += payload.delta;
              visibleText = text;
              await flush();
            }
            if (payload.event.startsWith('run.') && ['run.completed','run.failed','run.cancelled'].includes(payload.event)) {
              status = await client.status(id);
            }
            next = terminalHermesStatus(status.status) ? null : events.next().catch(() => null);
          }
          if (Date.now() - lastControlCheck >= (deps.pollMs ?? 1000)) {
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
            status = await client.status(id);
            await flush(true);
          }
          if (!next && !terminalHermesStatus(status.status)) await delay(deps.pollMs ?? 1000);
        }
      } finally { controller.abort(); }
      terminal = true;
      await flush(true);
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
