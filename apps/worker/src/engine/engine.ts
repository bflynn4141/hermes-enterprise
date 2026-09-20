// The tool loop, written so that it can run outside workerd.
import { redactMessage } from '../keys/redact.js';
//
// `runAttempt` takes an abstract `EngineStep` rather than Cloudflare's
// `WorkflowStep`. In production the Workflow hands it the real one; in
// `test/unit/engine/*` a fake one checkpoints results by name and replays them
// on retry, which is what lets the failure taxonomy, Stop, the controls and the
// crash-mid-tool case be tested with no network and no workerd. The Workflow
// class itself is then thin enough that the workerd test only has to prove it
// registers and is created.
//
// Three properties are load-bearing and each has a test named after it:
//
//   * Step names are deterministic (`turn-N-provider`, `turn-N-tool-{id}`),
//     because a step name is the checkpoint key.
//   * Every provider step attempt emits `message.reset` first, and every delta
//     carries `step_attempt`, so a retried step shows its text once.
//   * A tool step is idempotent on `(run_id, tool_call_id)`, so a crash
//     mid-tool resumes to exactly one request.
import { NonRetryableError } from 'cloudflare:workflows';
import type { ModelProvider, ProviderMessage, ToolCall, Usage } from '../model/types.js';
import { ProviderError, ZERO_USAGE } from '../model/types.js';
import type { AgentDb, EmitInput, EmittedEvent, EngineRunRow, RunErrorInput } from './agent-db.js';
import {
  CONTEXT_ANSWERED_EVENT,
  CONTEXT_WAIT_TIMEOUT,
  DELTA_BATCH_MS,
  MALFORMED_TOOL_JSON_CORRECTIONS,
  PROVIDER_STEP_RETRY_DELAY_MS,
  PROVIDER_STEP_RETRY_LIMIT,
  PROVIDER_STEP_TIMEOUT,
  TOOL_EXECUTION_TIMEOUT_MS,
  TOOL_STEP_RETRY_DELAY_MS,
  TOOL_STEP_RETRY_LIMIT,
  TOOL_STEP_TIMEOUT,
  TURN_HISTORY_LIMIT,
} from './constants.js';
import { extractBlocks } from './blocks.js';
import {
  allowedTools,
  executeTool,
  toolByName,
  toolResultEnvelope,
  FOCUS_TOOLS,
  TOOL_SOURCE,
  type FetchUrlRunner,
  type ToolContext,
} from './tools.js';
import { buildSystemPrompt, historyToMessages } from './prompt.js';

// ---------------------------------------------------------------------------
// The step abstraction
// ---------------------------------------------------------------------------

export interface StepConfig {
  readonly retries: { readonly limit: number; readonly delay: number; readonly backoff: 'exponential' | 'linear' | 'constant' };
  readonly timeout: string;
}

export interface EngineStep {
  do<T>(name: string, config: StepConfig, fn: () => Promise<T>): Promise<T>;
  /**
   * `options.type` is the event *kind* and `name` is only the step's
   * checkpoint key. They are not interchangeable and the runtime uses the
   * former to match a `sendEvent`: with `type` omitted the waiter is
   * registered under `undefined`, `sendEvent` queues under the real kind, and
   * the two never meet — so the run sits in `waiting` until the 30-day timeout
   * whatever anybody answers. Passing both is the fix (decision G8); the
   * signature requires `type` so it cannot be forgotten at the next call site.
   */
  waitForEvent<T>(name: string, options: { type: string; timeout: string }): Promise<{ payload: T }>;
}

export const stepNames = {
  provider: (turn: number) => `turn-${turn}-provider`,
  tool: (turn: number, toolCallId: string) => `turn-${turn}-tool-${toolCallId}`,
  answer: (turn: number, toolCallId: string) => `turn-${turn}-answer-${toolCallId}`,
  started: 'run-started',
  finish: 'run-finish',
} as const;

/** Where the assistant's own message sits within a turn's sequence numbers. */
export const ASSISTANT_SEQ = 100;
/** Where a human's answer to `ask_for_context` sits. Above any tool result. */
export const ANSWER_SEQ = 90;

export const PROVIDER_STEP_CONFIG: StepConfig = {
  retries: { limit: PROVIDER_STEP_RETRY_LIMIT, delay: PROVIDER_STEP_RETRY_DELAY_MS, backoff: 'exponential' },
  timeout: PROVIDER_STEP_TIMEOUT,
};
export const TOOL_STEP_CONFIG: StepConfig = {
  retries: { limit: TOOL_STEP_RETRY_LIMIT, delay: TOOL_STEP_RETRY_DELAY_MS, backoff: 'exponential' },
  timeout: TOOL_STEP_TIMEOUT,
};

// ---------------------------------------------------------------------------
// Dependencies
// ---------------------------------------------------------------------------

/** The hub reply carries Stop, so polling costs no extra subrequest. */
export interface DeltaForwardResult {
  readonly stop_requested: boolean;
}

export interface EngineDeps {
  readonly db: AgentDb;
  /** Which adapter serves this model. Tests pass a `ScriptedProvider` factory. */
  providerFor(transport: string): ModelProvider;
  /** Hand committed rows to the SessionHub; the reply carries Stop. */
  forward(sessionId: string, runId: string, events: readonly EmittedEvent[]): Promise<DeltaForwardResult>;
  /**
   * Hand committed *workspace*-scoped rows to the WorkspaceHub.
   *
   * `request.created` and `entity.updated` are read by every member, not by
   * the session's owner, so they go to the other hub — and they carry
   * `session_id: null`, which is what the hub's `maySee` and the replay
   * route's `session_id IS NULL` filter both key on. Optional because the Node
   * harness supplies neither hub; an absent forwarder means the rows are
   * committed and picked up by the next replay, which is the same guarantee
   * decision 40 already relies on.
   */
  forwardWorkspace?(events: readonly EmittedEvent[]): Promise<void>;
  readonly now: () => Date;
  readonly engineVersion: number;
  /** Set when the environment forces the scripted provider (MODEL_SCRIPTED=1). */
  readonly scripted?: boolean;
  /**
   * How `fetch_url` reaches the network. The Workflow builds one carrying this
   * deployment's own hostnames as deny entries; a test passes a scripted one.
   * Absent, `fetch_url` falls back to the module default, which still applies
   * every rule but knows nothing about this deployment's hostnames.
   */
  readonly fetchUrl?: FetchUrlRunner;
}

export interface RunAttemptInput {
  readonly runId: string;
  readonly attempt: number;
  readonly traceId: string;
}

// ---------------------------------------------------------------------------
// Step return values: ids only (1 MiB cap on a step return)
// ---------------------------------------------------------------------------

export type ProviderStepResult =
  | {
      readonly kind: 'answered';
      readonly messageId: string;
      readonly turn: number;
      readonly stepAttempt: number;
      readonly toolCallIds: readonly string[];
      readonly workedMs: number;
    }
  | { readonly kind: 'stopped'; readonly turn: number; readonly messageId: string | null }
  | { readonly kind: 'malformed'; readonly turn: number; readonly detail: string };

export interface ToolStepResult {
  readonly toolCallId: string;
  readonly ok: boolean;
  readonly waitingKey: string | null;
  readonly waitingLabel: string | null;
}

// ---------------------------------------------------------------------------
// Errors the loop raises
// ---------------------------------------------------------------------------

export class RunFailure extends Error {
  constructor(readonly detail: RunErrorInput) {
    super(detail.message);
    this.name = 'RunFailure';
  }
}

/**
 * Map a provider failure onto the run's error taxonomy.
 *
 * `auth` is its own class because a 401 is permanent for the key that produced
 * it and is not an error of the run's making: the run stops, the key is marked
 * invalid, and every other working run on that provider is asked to stop.
 */
export function classifyProviderError(error: unknown, stepId: string): RunErrorInput {
  if (error instanceof ProviderError) {
    switch (error.failure) {
      case 'auth':
        return { class: 'auth', retryable: false, reason: 'key_invalid', message: error.message, step_id: stepId };
      case 'permanent':
        return { class: 'permanent', retryable: false, reason: 'provider_rejected', message: error.message, step_id: stepId };
      case 'malformed':
        return { class: 'permanent', retryable: false, reason: 'malformed_tool_json', message: error.message, step_id: stepId };
      case 'rate_limit':
        return { class: 'transient', retryable: true, reason: 'rate_limited', message: error.message, step_id: stepId };
      default:
        return { class: 'transient', retryable: true, reason: 'provider_unavailable', message: error.message, step_id: stepId };
    }
  }
  if (error instanceof RunFailure) return error.detail;
  // Redacted, because this is the catch-all: the error it is handed came from
  // an unknown throw site somewhere inside a step that had the workspace's
  // provider key in scope, and `message` is written to `runs.error` and shown
  // to the client. Every *known* error shape above is already credential-free;
  // this branch is the one that cannot promise that about its input.
  const message = redactMessage(error);
  return { class: 'transient', retryable: true, reason: 'step_failed', message, step_id: stepId };
}

// ---------------------------------------------------------------------------
// The loop
// ---------------------------------------------------------------------------

export async function runAttempt(deps: EngineDeps, step: EngineStep, input: RunAttemptInput): Promise<void> {
  const { db } = deps;
  const run = await db.loadRun(input.runId);
  if (!run) {
    // The row is the idempotency record. No row means the instance outlived it
    // (or was created against a rolled-back transaction); there is nothing to
    // resume and retrying cannot make one appear.
    throw new NonRetryableError(`run ${input.runId} has no row`);
  }

  // Every resume path reads Stop first (plan section 4, Controls).
  if (run.stopRequested || run.status === 'stopping' || run.status === 'stopped') {
    await finish(deps, step, run, input, 'stopped', null);
    return;
  }

  const emitter = new Emitter(deps, run, input);
  await step.do(stepNames.started, TOOL_STEP_CONFIG, async () => {
    await db.setRunStatus(run.id, 'working');
    await emitter.emit([
      {
        kind: 'run.started',
        payload: {
          run_id: run.id,
          session_id: run.sessionId,
          attempt: input.attempt,
          engine_version: run.engineVersion,
          client_turn_id: run.clientTurnId,
          mode: run.mode,
          model_id: run.modelId,
          effort: run.effort,
          title: null,
          steps: [],
        },
      },
    ]);
    return { ok: true };
  });

  let turn = await db.resumeTurn(run.id);
  let malformedCorrections = 0;

  try {
    while (turn < run.maxTurns) {
      const result = await step.do(stepNames.provider(turn), PROVIDER_STEP_CONFIG, () =>
        providerStep(deps, emitter, run, input, turn),
      );

      if (result.kind === 'stopped') {
        await finish(deps, step, run, input, 'stopped', null);
        return;
      }

      if (result.kind === 'malformed') {
        // Plan section 4: one corrective tool_result, then permanent. The
        // correction is appended as the next turn's input so the retry is a
        // fresh, deterministically named step rather than a reused one.
        malformedCorrections += 1;
        if (malformedCorrections > MALFORMED_TOOL_JSON_CORRECTIONS) {
          throw new RunFailure({
            class: 'permanent',
            retryable: false,
            reason: 'malformed_tool_json',
            message: result.detail,
            step_id: stepNames.provider(turn),
          });
        }
        const next = turn + 1;
        await step.do(stepNames.answer(turn, 'malformed'), TOOL_STEP_CONFIG, async () => {
          await deps.db.appendTurn({
            runId: run.id,
            turn: next,
            seq: 0,
            role: 'tool',
            toolCallId: `malformed-${turn}`,
            providerMessage: {
              role: 'tool',
              tool_call_id: `malformed-${turn}`,
              content: toolResultEnvelope(
                'tool_arguments',
                'engine',
                { error: result.detail, hint: 'Re-emit the tool call with valid JSON arguments.' },
                deps.now(),
              ),
            },
          });
          return { ok: true };
        });
        turn = next;
        continue;
      }

      if (result.toolCallIds.length === 0) {
        await finish(deps, step, run, input, 'completed', null);
        return;
      }

      for (const toolCallId of result.toolCallIds) {
        // Stop is checked before every tool, not only between turns: a run that
        // was stopped during a five-minute turn must not then run four tools.
        if (await db.stopRequested(run.id)) {
          await finish(deps, step, run, input, 'stopped', null);
          return;
        }
        const outcome = await step.do(stepNames.tool(turn, toolCallId), TOOL_STEP_CONFIG, () =>
          toolStep(deps, emitter, run, input, turn, toolCallId, result.toolCallIds.indexOf(toolCallId)),
        );
        if (outcome.waitingKey) {
          await waitForAnswer(deps, emitter, step, run, input, turn, outcome);
        }
      }

      turn += 1;
      await drainControls(deps, emitter, run, turn);
    }

    await finish(deps, step, run, input, 'completed', null);
  } catch (error) {
    if (error instanceof NonRetryableError) throw error;
    const detail = classifyProviderError(error, stepNames.provider(turn));
    await finish(deps, step, run, input, 'error', detail);
    // Permanent classes are not the Workflow's to retry: a second attempt with
    // the same rejected key or the same 400 body cannot succeed.
    if (!detail.retryable) throw new NonRetryableError(`${detail.reason}: ${detail.message}`);
  }
}

// ---------------------------------------------------------------------------
// The provider step
// ---------------------------------------------------------------------------

async function providerStep(
  deps: EngineDeps,
  emitter: Emitter,
  run: EngineRunRow,
  input: RunAttemptInput,
  turn: number,
): Promise<ProviderStepResult> {
  const { db } = deps;
  const startedAt = Date.now();
  const stepId = 'provider';

  // The step's own retry counter, persisted so that `message.reset` and every
  // delta can carry it. A superseded attempt's deltas stay in the outbox; the
  // reducer discards them by comparing `step_attempt`.
  const { stepAttempt } = await db.enterStep({
    runId: run.id,
    turn,
    stepId,
    label: 'Thinking',
    state: 'active',
    toolCallId: null,
  });

  // The row exists before the first delta so that every delta can name a real
  // message id. It is keyed (run_id, turn), so this attempt and every later one
  // write the same row: a step retry replaces the text rather than appending a
  // second bubble the reducer then has to reconcile.
  const { messageId: streamingMessageId } = await db.upsertAssistantMessage({
    runId: run.id,
    sessionId: run.sessionId,
    turn,
    text: '',
    blocks: [],
    status: 'streaming',
    workedMs: null,
  });

  await emitter.emit([
    { kind: 'run.step', payload: { run_id: run.id, attempt: input.attempt, turn, step_id: stepId, label: 'Thinking', state: 'active', tool_call_id: null } },
    { kind: 'message.reset', payload: { run_id: run.id, turn, attempt: input.attempt, step_attempt: stepAttempt, message_id: streamingMessageId } },
  ]);

  const guidance = await db.loadGuidance(run.id);
  const history = await db.loadHistory(run.id, TURN_HISTORY_LIMIT);
  const capabilityNames = await db.loadToolNames(run.agentId);
  const tools = allowedTools(run.mode, capabilityNames);
  const model = await db.loadModel(run.modelId);
  if (!model) {
    throw new RunFailure({
      class: 'permanent',
      retryable: false,
      reason: 'unknown_model',
      message: `the catalog has no model ${run.modelId}`,
      step_id: stepId,
    });
  }

  // resolveKey runs inside the step, so the plaintext exists only for this
  // request and a rotation is picked up at the next step (plan section 4). The
  // scripted provider has no key to resolve, which is the whole point of
  // MODEL_SCRIPTED: a fresh checkout can run a turn end to end offline.
  const credential = deps.scripted
    ? { provider: model.provider, apiKey: '', keyId: 'scripted' }
    : await db.resolveCredential(model.provider);
  // `model_calls.key_id` is a uuid, and a scripted run was paid for by nobody.
  const keyId = deps.scripted ? null : credential.keyId;
  const provider = deps.providerFor(model.transport);

  const controller = new AbortController();
  const decoderState = { text: '', usage: ZERO_USAGE as Usage, toolCalls: [] as ToolCall[], reasoning: undefined as ProviderMessage['reasoning'] };
  let deltaSeq = 0;
  let pending = '';
  let lastFlush = Date.now();
  let stopped = false;

  const flush = async (force: boolean): Promise<void> => {
    if (pending.length === 0) return;
    if (!force && Date.now() - lastFlush < DELTA_BATCH_MS) return;
    const chunk = pending;
    pending = '';
    lastFlush = Date.now();
    const reply = await emitter.forward([
      {
        kind: 'message.delta',
        payload: {
          message_id: streamingMessageId,
          run_id: run.id,
          turn,
          attempt: input.attempt,
          step_attempt: stepAttempt,
          seq: deltaSeq++,
          delta: chunk,
        },
      },
    ]);
    if (reply.stop_requested) {
      stopped = true;
      controller.abort();
    }
  };

  let failure: unknown = null;
  try {
    for await (const event of provider.stream({
      model: run.modelId,
      system: await buildSystemPrompt(db, run, guidance),
      messages: historyToMessages(history),
      tools: tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.input_schema })),
      effort: run.effort,
      effortMap: model.effort_map,
      credential,
      signal: controller.signal,
    })) {
      switch (event.type) {
        case 'text_delta':
          decoderState.text += event.text;
          pending += event.text;
          await flush(false);
          break;
        case 'reasoning':
          decoderState.reasoning = event.carry;
          break;
        case 'tool_call':
          decoderState.toolCalls.push(event.call);
          break;
        case 'usage':
          decoderState.usage = event.usage;
          break;
        case 'stop':
          if (event.reason === 'stopped') stopped = true;
          break;
        default:
          break;
      }
      if (stopped) break;
    }
  } catch (error) {
    failure = error;
  }
  await flush(true);

  const workedMs = Date.now() - startedAt;
  await db.addActiveMs(run.id, workedMs);

  if (failure) {
    // Persist whatever streamed before the tear, keyed (run_id, turn) so the
    // step retry or a user Retry replaces it rather than appending a second
    // partial. Then rethrow: classification is the caller's.
    const partial = extractBlocks(decoderState.text);
    const { messageId } = await db.upsertAssistantMessage({
      runId: run.id,
      sessionId: run.sessionId,
      turn,
      text: partial.text,
      blocks: partial.blocks,
      status: 'incomplete',
      workedMs,
    });
    await db.recordModelCall({
      runId: run.id,
      turn,
      modelId: run.modelId,
      provider: model.provider,
      keyId,
      usage: decoderState.usage,
      latencyMs: workedMs,
      status: 'error',
    });
    if (failure instanceof ProviderError && failure.failure === 'auth') {
      // What the agent role can do: stop the other runs paying with this key.
      // What it cannot: mark the key row invalid. The Cron does that from the
      // run's recorded error (decision 41).
      await db.stopOtherRunsOnProvider(model.provider, run.id);
    }
    if (failure instanceof ProviderError && failure.failure === 'malformed') {
      await db.finishStep({ runId: run.id, turn, stepId, label: 'Thinking', state: 'failed', toolCallId: null });
      await emitter.emit([
        { kind: 'run.step', payload: { run_id: run.id, attempt: input.attempt, turn, step_id: stepId, label: 'Thinking', state: 'failed', tool_call_id: null } },
      ]);
      void messageId;
      return { kind: 'malformed', turn, detail: failure.message };
    }
    throw failure;
  }

  if (stopped) {
    const partial = extractBlocks(decoderState.text);
    const { messageId } = await db.upsertAssistantMessage({
      runId: run.id,
      sessionId: run.sessionId,
      turn,
      text: partial.text,
      blocks: partial.blocks,
      status: 'incomplete',
      workedMs,
    });
    await db.recordModelCall({
      runId: run.id,
      turn,
      modelId: run.modelId,
      provider: model.provider,
      keyId,
      usage: decoderState.usage,
      latencyMs: workedMs,
      status: 'stopped',
    });
    await db.finishStep({ runId: run.id, turn, stepId, label: 'Thinking', state: 'done', toolCallId: null });
    await emitter.emit([
      {
        kind: 'message.final',
        payload: {
          message_id: messageId,
          session_id: run.sessionId,
          run_id: run.id,
          turn,
          attempt: input.attempt,
          text: partial.text,
          blocks: partial.blocks,
          incomplete: true,
          worked_ms: workedMs,
        },
      },
    ]);
    return { kind: 'stopped', turn, messageId };
  }

  const parsed = extractBlocks(decoderState.text);
  if (parsed.rejections.length > 0) {
    // Layer three of invariant 2. The block never reaches a renderer, and the
    // rejection is a log line with the command name so that a red-team test
    // can assert on it.
    console.log(
      JSON.stringify({
        at: 'engine.blocks_rejected',
        run_id: run.id,
        turn,
        rejections: parsed.rejections.map((r) => ({ type: r.blockType, command: r.command, reason: r.reason })),
      }),
    );
  }

  const { messageId } = await db.upsertAssistantMessage({
    runId: run.id,
    sessionId: run.sessionId,
    turn,
    text: parsed.text,
    blocks: parsed.blocks,
    status: 'complete',
    workedMs,
  });

  await db.appendTurn({
    runId: run.id,
    turn,
    seq: ASSISTANT_SEQ,
    role: 'assistant',
    providerMessage: {
      role: 'assistant',
      content: parsed.text,
      tool_calls: decoderState.toolCalls,
      reasoning: decoderState.reasoning,
    },
  });

  await db.recordModelCall({
    runId: run.id,
    turn,
    modelId: run.modelId,
    provider: model.provider,
    keyId,
    usage: decoderState.usage,
    latencyMs: workedMs,
    status: 'ok',
  });

  for (const guidanceRow of guidance) {
    if (guidanceRow.status !== 'queued') continue;
    await db.markGuidanceApplied(run.id, guidanceRow.id, turn);
    await emitter.emit([
      { kind: 'run.guidance.applied', payload: { run_id: run.id, guidance_id: guidanceRow.id, turn } },
    ]);
  }

  await db.finishStep({ runId: run.id, turn, stepId, label: 'Thinking', state: 'done', toolCallId: null });
  await emitter.emit([
    { kind: 'run.step', payload: { run_id: run.id, attempt: input.attempt, turn, step_id: stepId, label: 'Thinking', state: 'done', tool_call_id: null } },
    {
      kind: 'message.final',
      payload: {
        message_id: messageId,
        session_id: run.sessionId,
        run_id: run.id,
        turn,
        attempt: input.attempt,
        text: parsed.text,
        blocks: parsed.blocks,
        worked_ms: workedMs,
      },
    },
  ]);

  return {
    kind: 'answered',
    messageId,
    turn,
    stepAttempt,
    toolCallIds: decoderState.toolCalls.map((c) => c.id),
    workedMs,
  };
}

// ---------------------------------------------------------------------------
// The tool step
// ---------------------------------------------------------------------------

async function toolStep(
  deps: EngineDeps,
  emitter: Emitter,
  run: EngineRunRow,
  input: RunAttemptInput,
  turn: number,
  toolCallId: string,
  index: number,
): Promise<ToolStepResult> {
  const { db } = deps;
  const startedAt = Date.now();

  // The call itself is read back from `run_turns`, not carried in the step
  // return: step returns are ids only, and the assistant turn that asked for
  // the tool is already durable.
  const history = await db.loadHistory(run.id, TURN_HISTORY_LIMIT);
  const call = history.recent
    .flatMap((t) => t.providerMessage.tool_calls ?? [])
    .find((c) => c.id === toolCallId);
  if (!call) {
    throw new NonRetryableError(`tool call ${toolCallId} is not in this run's turns`);
  }

  // `run.step.step_id` is capped at 64 characters by the event contract, and a
  // provider is free to hand us a 128-character tool call id.
  const stepId = `tool-${toolCallId}`.slice(0, 64);
  await db.enterStep({ runId: run.id, turn, stepId, label: call.name, state: 'active', toolCallId });
  await emitter.emit([
    { kind: 'run.step', payload: { run_id: run.id, attempt: input.attempt, turn, step_id: stepId, label: call.name, state: 'active', tool_call_id: toolCallId } },
  ]);

  const capabilityNames = await db.loadToolNames(run.agentId);
  const allowed = new Set(allowedTools(run.mode, capabilityNames).map((t) => t.name));
  const tool = toolByName(call.name);

  let outcomeText: string;
  let waitingKey: string | null = null;
  let waitingLabel: string | null = null;
  let ok = false;
  let focusRef: import('./tools.js').ToolFocus | null = null;
  const published: EmittedEvent[] = [];

  if (!tool || !allowed.has(call.name)) {
    outcomeText = toolResultEnvelope(
      call.name,
      'engine',
      { error: `the tool ${call.name} is not available in this session`, available: [...allowed] },
      deps.now(),
    );
  } else {
    let args: Record<string, unknown> = {};
    try {
      args = JSON.parse(call.arguments || '{}') as Record<string, unknown>;
    } catch (error) {
      throw new ProviderError(
        `tool arguments for ${call.name} are not JSON: ${(error as Error).message}`,
        'malformed',
        undefined,
        'engine',
      );
    }
    const ctx: ToolContext = {
      writes: db,
      reads: db,
      run,
      toolCallId,
      now: deps.now,
      // The run's mode, not the session's: a person flipping the selector from
      // Plan to Work while a run is in flight changes the next run, never this
      // one. `runs.mode` is written at turn creation for exactly that reason.
      mode: run.mode,
      fetchUrl: deps.fetchUrl,
    };
    const outcome = await withTimeout(
      executeTool(tool, args, ctx),
      // `fetch_url` carries its own 10 s budget (plan section 4, Tools); the
      // 30 s here is the outer stop for a tool that hangs some other way.
      TOOL_EXECUTION_TIMEOUT_MS,
      call.name,
    );
    if (outcome.ok) {
      ok = true;
      outcomeText = toolResultEnvelope(call.name, TOOL_SOURCE[call.name] ?? 'engine', outcome.data, deps.now());
      if (outcome.waiting) {
        waitingKey = outcome.waiting.key;
        waitingLabel = outcome.waiting.label;
      }
      if (outcome.focus && FOCUS_TOOLS.has(call.name)) focusRef = outcome.focus;
      // Rows the tool's own transaction already committed. They are published,
      // never re-emitted: the outbox has them, and a second INSERT would be a
      // second `request.created` for one request.
      if (outcome.published && outcome.published.length > 0) published.push(...outcome.published);
    } else {
      outcomeText = toolResultEnvelope(call.name, 'engine', { error: outcome.error }, deps.now());
      if (outcome.permanent) {
        await db.finishStep({ runId: run.id, turn, stepId, label: call.name, state: 'failed', toolCallId });
        throw new RunFailure({
          class: 'permanent',
          retryable: false,
          reason: 'tool_rejected',
          message: outcome.error,
          step_id: stepId,
        });
      }
    }
  }

  // ON CONFLICT (run_id, tool_call_id) DO NOTHING: a step that ran twice
  // because the instance crashed between the tool and the checkpoint writes
  // one row, so a resumed run proposes exactly one request.
  await db.appendTurn({
    runId: run.id,
    turn: turn + 1,
    // `run_turns` is keyed (run_id, turn, seq). A turn's inputs occupy the low
    // sequence numbers in the order the model asked for them; the assistant's
    // own message for that turn sits at ASSISTANT_SEQ, above every input.
    seq: index,
    role: 'tool',
    toolCallId,
    providerMessage: { role: 'tool', tool_call_id: toolCallId, content: outcomeText },
  });

  const workedMs = Date.now() - startedAt;
  await db.addActiveMs(run.id, workedMs);
  await db.finishStep({ runId: run.id, turn, stepId, label: call.name, state: ok ? 'done' : 'failed', toolCallId });

  const events: EmitInput[] = [
    { kind: 'run.step', payload: { run_id: run.id, attempt: input.attempt, turn, step_id: stepId, label: call.name, state: ok ? 'done' : 'failed', tool_call_id: toolCallId } },
  ];
  if (focusRef) {
    events.push({
      kind: 'run.focus',
      payload: {
        run_id: run.id,
        session_id: run.sessionId,
        ref: focusRef.ref,
        entity_type: focusRef.entityType,
        entity_id: focusRef.entityId,
      },
    });
  }
  await emitter.emit(events);
  // The workspace-scoped rows the tool committed, handed to the WorkspaceHub
  // after the session-scoped ones so a member's Inbox and the proposer's own
  // pane do not disagree about the order. A lost publish costs a reconnect,
  // not the event: the row is committed and `GET /w/:ws/events?after=` replays
  // it (decision 40).
  await emitter.publishCommitted(published);

  return { toolCallId, ok, waitingKey, waitingLabel };
}

async function withTimeout<T>(work: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms} ms`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Waiting on a human
// ---------------------------------------------------------------------------

async function waitForAnswer(
  deps: EngineDeps,
  emitter: Emitter,
  step: EngineStep,
  run: EngineRunRow,
  input: RunAttemptInput,
  turn: number,
  outcome: ToolStepResult,
): Promise<void> {
  const { db } = deps;
  // The empty row the question needs, before the status moves. `runs.waiting_for`
  // is the engine's own bookkeeping; the Context tab lists
  // `agent_context_fields`, and a parked run that wrote no row there left the
  // one screen built for this state with nothing to show (client finding 14).
  // Existing answers are untouched — see `ensureContextField`.
  const operationApprovalId = outcome.waitingKey?.startsWith('operation_approval:') ? outcome.waitingKey.slice('operation_approval:'.length) : null;
  if (outcome.waitingKey && run.agentId && !operationApprovalId) {
    await db.ensureContextField({
      runId: run.id,
      toolCallId: outcome.toolCallId,
      agentId: run.agentId,
      key: outcome.waitingKey,
    });
  }
  const park = async () => {
    await db.setRunStatus(run.id, 'waiting', { waitingFor: outcome.waitingKey, waitingLabel: outcome.waitingLabel });
    await emitter.emit([
    {
      kind: 'run.status',
      payload: {
        run_id: run.id,
        attempt: input.attempt,
        status: 'waiting',
        waiting_for: outcome.waitingKey,
        waiting_label: outcome.waitingLabel,
      },
    },
    ]);
    return { ok: true };
  };
  // Replaying a completed answer must not put the run back into waiting while
  // its already-checkpointed answer/finish steps skip their writes.
  if (operationApprovalId) await step.do(`operation-approval-park-${outcome.toolCallId}`, TOOL_STEP_CONFIG, park);
  else await park();

  // Ids only in the payload: Workflow instance state is retained 30 days and
  // the erasure inventory asserts it carries no free text. The answer itself
  // is read back from Postgres.
  if (operationApprovalId) {
    // Workflow events can be buffered from an earlier question. They are a
    // wake-up hint, never authority; keep waiting under one durable deadline.
    const deadline = await step.do(`operation-approval-deadline-${outcome.toolCallId}`, TOOL_STEP_CONFIG,
      async () => deps.now().getTime() + 30 * 24 * 60 * 60 * 1000);
    for (let wake = 0; ; wake += 1) {
      // Journal each observation so replay traverses the same prior wait
      // steps even if the database has since changed to approved/denied.
      const observed = await step.do(`operation-approval-observe-${outcome.toolCallId}-${wake}`, TOOL_STEP_CONFIG,
        async () => ({
          status: (await db.loadOperationApproval?.(operationApprovalId, run.id))?.status ?? 'pending',
          remainingMs: deadline - deps.now().getTime(),
        }));
      if (observed.status !== 'pending') break;
      const remaining = observed.remainingMs;
      if (remaining <= 0) throw new Error('operation_approval_wait_expired');
      await step.waitForEvent<{ run_id: string; key: string }>(`operation-approval-${outcome.toolCallId}-${wake}`, {
        type: CONTEXT_ANSWERED_EVENT,
        timeout: `${Math.max(1, Math.ceil(remaining / 1000))} seconds`,
      });
    }
  } else {
    await step.waitForEvent<{ run_id: string; key: string }>(CONTEXT_ANSWERED_EVENT, {
      type: CONTEXT_ANSWERED_EVENT,
      timeout: CONTEXT_WAIT_TIMEOUT,
    });
  }

  await step.do(stepNames.answer(turn, outcome.toolCallId), TOOL_STEP_CONFIG, async () => {
    if (operationApprovalId) {
      const approval = await db.loadOperationApproval?.(operationApprovalId, run.id);
      if (!approval || approval.status === 'pending') throw new Error('operation_approval_not_decided');
      if (await db.stopRequested(run.id)) throw new Error('operation_approval_run_stopped');
      const tool = allowedTools(run.mode, await db.loadToolNames(run.agentId)).find(entry => entry.name === approval.toolName);
      const result = approval.status === 'denied'
        ? { ok: false as const, error: 'The human declined this operation.' }
        : tool ? await executeTool(tool, approval.arguments, { writes: db, reads: db, run, toolCallId: approval.toolCallId, now: deps.now, mode: run.mode, fetchUrl: deps.fetchUrl })
        : { ok: false as const, error: 'The operation is no longer available.' };
      await db.appendTurn({ runId: run.id, turn: turn + 1, seq: ANSWER_SEQ, role: 'tool', toolCallId: `${outcome.toolCallId}-answer`, providerMessage: { role: 'tool', tool_call_id: outcome.toolCallId, content: toolResultEnvelope(approval.toolName, TOOL_SOURCE[approval.toolName] ?? 'engine', result.ok ? result.data : { error: result.error }, deps.now()) } });
      if (result.ok && result.published) await emitter.publishCommitted(result.published);
      await db.setRunStatus(run.id, 'working', { waitingFor: null, waitingLabel: null });
      return { ok: true };
    }
    const value = await db.readContextField(run.agentId, outcome.waitingKey ?? '');
    await db.appendTurn({
      runId: run.id,
      turn: turn + 1,
      seq: ANSWER_SEQ,
      role: 'tool',
      toolCallId: `${outcome.toolCallId}-answer`,
      providerMessage: {
        role: 'tool',
        tool_call_id: outcome.toolCallId,
        content: toolResultEnvelope(
          'ask_for_context',
          'workspace.agent_context_fields',
          { key: outcome.waitingKey, value },
          deps.now(),
        ),
      },
    });
    await db.setRunStatus(run.id, 'working', { waitingFor: null, waitingLabel: null });
    return { ok: true };
  });

  await emitter.emit([
    { kind: 'run.status', payload: { run_id: run.id, attempt: input.attempt, status: 'working' } },
  ]);
}

// ---------------------------------------------------------------------------
// Controls read between steps
// ---------------------------------------------------------------------------

/**
 * Guide and Queue are rows read between steps (plan section 4, Controls).
 *
 * Guidance is applied by the next provider step, which reads it as part of the
 * prompt; the queue is drained serially only once the run has nothing else to
 * do, and a Stop pauses it rather than dropping it.
 */
async function drainControls(deps: EngineDeps, emitter: Emitter, run: EngineRunRow, turn: number): Promise<void> {
  const { db } = deps;
  if (await db.stopRequested(run.id)) {
    // The Stop route already paused the rows; this only tells the client.
    const items = await db.loadQueue(run.id);
    await emitter.emit([
      { kind: 'run.queue.updated', payload: { run_id: run.id, items: items.map(queueItem) } },
    ]);
    return;
  }
  void turn;
}

const queueItem = (row: { id: string; text: string; status: string; position: number }): Record<string, unknown> => ({
  id: row.id,
  text: row.text,
  status: row.status,
  position: row.position,
});

// ---------------------------------------------------------------------------
// Finishing
// ---------------------------------------------------------------------------

async function finish(
  deps: EngineDeps,
  step: EngineStep,
  run: EngineRunRow,
  input: RunAttemptInput,
  status: 'completed' | 'stopped' | 'error',
  error: RunErrorInput | null,
): Promise<void> {
  const emitter = new Emitter(deps, run, input);
  await step.do(stepNames.finish, TOOL_STEP_CONFIG, async () => {
    const activeMs = await deps.db.addActiveMs(run.id, 0);
    await deps.db.setRunStatus(run.id, status, { error });
    // A completed run names its session after what it produced. Written here,
    // by the engine, so it does not depend on whether anybody's app pane was
    // following the run at the time; a stopped or failed run keeps the
    // provisional name, because it produced nothing to be named after.
    const named = status === 'completed' ? await deps.db.nameSessionFromRun(run.id) : null;
    // The rename goes out before the terminal status: a client that treats
    // `completed` as the end of the session's stream must already have it.
    if (named) await emitter.publishCommitted(named.events);
    await emitter.emit([
      {
        kind: 'run.status',
        payload: {
          run_id: run.id,
          attempt: input.attempt,
          status,
          active_ms: activeMs,
          error: error ?? null,
        },
      },
    ]);
    return { ok: true };
  });
}

// ---------------------------------------------------------------------------
// The outbox, then the hub
// ---------------------------------------------------------------------------

/**
 * Write to `stream_events` in the same transaction as the change, then publish
 * after the commit.
 *
 * The agent role has no INSERT on `jobs` (migration 0004 revokes it outright),
 * so the engine cannot enqueue the `publish` job a route would. It hands the
 * committed rows to the SessionHub itself; if that RPC is lost, the rows are
 * still committed and the client's `GET /w/:ws/events?after=` replay picks them
 * up on reconnect. See decision 40.
 */
class Emitter {
  constructor(
    private readonly deps: EngineDeps,
    private readonly run: EngineRunRow,
    private readonly input: RunAttemptInput,
  ) {}

  async emit(events: readonly EmitInput[]): Promise<EmittedEvent[]> {
    if (events.length === 0) return [];
    // `'sessionId' in event` rather than `??`: an event that set `sessionId`
    // to null meant it, and coalescing would quietly turn a workspace event
    // into a session one — delivered to the wrong hub, and invisible to the
    // `session_id IS NULL` half of the replay route.
    const written = await this.deps.db.emit(
      events.map((event) => ({
        ...event,
        sessionId: 'sessionId' in event ? (event.sessionId ?? null) : this.run.sessionId,
      })),
    );
    const workspaceEvents = written.filter((event) => event.sessionId === null);
    const sessionEvents = written.filter((event) => event.sessionId !== null);
    try {
      if (sessionEvents.length > 0) await this.deps.forward(this.run.sessionId, this.run.id, sessionEvents);
      if (workspaceEvents.length > 0) await this.deps.forwardWorkspace?.(workspaceEvents);
    } catch (error) {
      console.log(
        JSON.stringify({ at: 'engine.publish_failed', run_id: this.run.id, trace_id: this.input.traceId, error: String(error) }),
      );
    }
    return written;
  }

  /**
   * Publish rows that are already in the outbox.
   *
   * Used for the events a tool wrote in its own transaction: there is nothing
   * to emit, only something to deliver. Workspace-scoped rows go to the
   * WorkspaceHub, session-scoped ones to the SessionHub, by the same
   * `session_id === null` rule the replay route uses.
   */
  async publishCommitted(events: readonly EmittedEvent[]): Promise<void> {
    if (events.length === 0) return;
    const workspaceEvents = events.filter((event) => event.sessionId === null);
    const sessionEvents = events.filter((event) => event.sessionId !== null);
    try {
      if (sessionEvents.length > 0) await this.deps.forward(this.run.sessionId, this.run.id, sessionEvents);
      if (workspaceEvents.length > 0) await this.deps.forwardWorkspace?.(workspaceEvents);
    } catch (error) {
      console.log(
        JSON.stringify({ at: 'engine.publish_failed', run_id: this.run.id, trace_id: this.input.traceId, error: String(error) }),
      );
    }
  }

  /** Like `emit`, but the reply matters: it carries Stop. */
  async forward(events: readonly EmitInput[]): Promise<DeltaForwardResult> {
    const written = await this.deps.db.emit(
      events.map((event) => ({ ...event, sessionId: event.sessionId ?? this.run.sessionId })),
    );
    try {
      return await this.deps.forward(this.run.sessionId, this.run.id, written);
    } catch (error) {
      console.log(
        JSON.stringify({ at: 'engine.forward_failed', run_id: this.run.id, trace_id: this.input.traceId, error: String(error) }),
      );
      // A lost forward must not lose Stop: fall back to the row, which is the
      // truth the hub's copy is only a cache of.
      return { stop_requested: await this.deps.db.stopRequested(this.run.id) };
    }
  }
}
