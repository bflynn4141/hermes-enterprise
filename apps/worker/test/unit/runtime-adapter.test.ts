// Native Hermes owns execution; these tests prove the enterprise projection
// survives retries, reconciles status, and keeps Stop honest.
import { assertRunLog } from '@hermes/shared';
import { describe, expect, it, vi } from 'vitest';
import type { EngineRunRow } from '../../src/engine/agent-db.js';
import type { ProviderMessage } from '../../src/model/types.js';
import { runHermesAttempt, type RuntimeDeps, type RuntimePersistence, type RuntimeTerminalFailure } from '../../src/runtime/adapter.js';
import { HermesClient, HermesCapabilitiesError, terminalHermesStatus, type HermesEvent, type HermesStatus } from '../../src/runtime/client.js';
import { FakeAgentDb } from './engine/fake-db.js';
import { FakeStep } from './engine/fake-step.js';

const NATIVE_ID = 'run_native-123';
const MODEL = 'openrouter:anthropic/claude-sonnet-4';
const PROFILE = 'enterprise-agent-1';

class FakeRuntimeDb extends FakeAgentDb implements RuntimePersistence {
  nativeBinding: { runtimeRunId: string | null; runtimeAttempt: number | null } | null = null;
  readonly bindings: { runId: string; attempt: number; remoteId: string; sessionId: string; profile: string }[] = [];
  readonly snapshots = new Map<number, Record<string, unknown>>();
  readonly carriedGuidance: string[] = [];
  finalizations = 0;
  finalizing = false;
  bootstrap: ProviderMessage[] = [];
  acceptBinding = true;
  resumeInput: string | null = null;
  recoveryInput() { return Promise.resolve(this.resumeInput); }

  constructor(overrides: Partial<EngineRunRow> = {}) {
    super({ modelId: MODEL, ...overrides });
  }

  override loadModel() {
    return Promise.resolve({ model_id: MODEL, provider: 'openrouter', transport: 'openrouter', effort_map: null });
  }

  binding() { return Promise.resolve(this.nativeBinding); }

  bindRun(runId: string, attempt: number, remoteId: string, sessionId: string, profile: string) {
    if (this.acceptBinding) {
      this.bindings.push({ runId, attempt, remoteId, sessionId, profile });
      this.nativeBinding = { runtimeRunId: remoteId, runtimeAttempt: attempt };
    }
    return Promise.resolve(this.acceptBinding);
  }

  snapshotRequest(_runId: string, attempt: number, body: Record<string, unknown>) {
    if (!this.snapshots.has(attempt)) this.snapshots.set(attempt, structuredClone(body));
    return Promise.resolve(structuredClone(this.snapshots.get(attempt)!));
  }

  loadBootstrapHistory() { return Promise.resolve(this.bootstrap); }

  nextRuntimeSequence() {
    return Promise.resolve(Math.max(-1, ...this.turns.filter((turn) => turn.turn === 0).map((turn) => turn.seq)) + 1);
  }

  async finalizeRuntime<T>(_runId: string, attempt: number, work: () => Promise<T>): Promise<T | null> {
    const run = (await this.loadRun())!;
    if (run.attempt !== attempt || ['completed', 'stopped', 'error'].includes(run.status)) return null;
    this.finalizations += 1;
    this.finalizing = true;
    try { return await work(); }
    finally { this.finalizing = false; }
  }

  carryGuidance(_runId: string, ids: string[]) {
    this.carriedGuidance.push(...this.guidance.filter((row) => row.status === 'queued' && ids.includes(row.id)).map((row) => row.id));
    return Promise.resolve();
  }
}

class FakeHermesClient extends HermesClient {
  readonly submissions: { body: Record<string, unknown>; key: string }[] = [];
  readonly stops: string[] = [];
  readonly steers: { id: string; text: string }[] = [];
  statusReads = 0;
  eventSubscriptions = 0;
  streamSignal: AbortSignal | null = null;
  current: HermesStatus = { run_id: NATIVE_ID, status: 'running' };
  final: HermesStatus = { run_id: NATIVE_ID, status: 'completed', output: 'The review is ready.' };
  deltas = ['Reading the application. ', 'Checking references.'];
  disconnect = false;
  acceptSteer = true;
  onSubmit: (() => void) | null = null;
  onStatus: (() => void) | null = null;
  onStop: (() => void) | null = null;
  streamFailure: Error | null = null;
  capabilityReads = 0;
  capabilityFailure: Error | null = null;

  constructor() { super('https://runtime.invalid', 'test-runtime-key'); }

  override capabilities() {
    this.capabilityReads += 1;
    return this.capabilityFailure
      ? Promise.reject(this.capabilityFailure)
      : Promise.resolve({ durableIdempotency: true as const, retentionSeconds: 86_400 });
  }

  override submit(body: Record<string, unknown>, key: string) {
    this.onSubmit?.();
    this.submissions.push({ body: structuredClone(body), key });
    return Promise.resolve(NATIVE_ID);
  }

  override status() {
    this.statusReads += 1;
    if (this.statusReads > 30) return Promise.reject(new Error('test runtime never reached terminal status'));
    this.onStatus?.();
    return Promise.resolve({ ...this.current });
  }

  override stop(id: string) {
    this.stops.push(id);
    if (this.onStop) this.onStop();
    else this.current = { run_id: NATIVE_ID, status: 'cancelled' };
    return Promise.resolve();
  }

  override steer(id: string, text: string) {
    this.steers.push({ id, text });
    return Promise.resolve(this.acceptSteer);
  }

  override async *events(_id: string, signal: AbortSignal): AsyncGenerator<HermesEvent> {
    this.eventSubscriptions += 1;
    this.streamSignal = signal;
    for (const delta of this.deltas) yield { event: 'message.delta', run_id: NATIVE_ID, delta };
    this.current = this.final;
    if (this.disconnect) throw this.streamFailure ?? new Error('stream disconnected');
    yield { event: `run.${this.final.status}`, ...this.final };
  }
}

async function execute(
  db = new FakeRuntimeDb(),
  client = new FakeHermesClient(),
  step = new FakeStep(),
  forward?: RuntimeDeps['forward'],
  timing: { pollMs?: number; batchMs?: number; preview?: RuntimeDeps['preview']; onTerminalFailure?: RuntimeDeps['onTerminalFailure']; onLatency?: RuntimeDeps['onLatency'] } = {},
) {
  const run = (await db.loadRun())!;
  await runHermesAttempt({
    db, client, profile: PROFILE, pollMs: timing.pollMs ?? 0, batchMs: timing.batchMs,
    forward: forward ?? (async () => ({ stop_requested: db.stopFlag })),
    ...(timing.preview ? { preview: timing.preview } : {}),
    ...(timing.onTerminalFailure ? { onTerminalFailure: timing.onTerminalFailure } : {}),
    ...(timing.onLatency ? { onLatency: timing.onLatency } : {}),
  }, step, { runId: run.id, attempt: run.attempt, traceId: run.traceId ?? 'runtime-test' });
  return { db, client, step };
}

describe('official Hermes enterprise projection', () => {
  it('submits saved recovery instructions instead of replaying original discovery input', async () => {
    const db = new FakeRuntimeDb({ attempt: 2 });
    db.resumeInput = 'Resume stored screening evidence. Do not repeat the paid search.';
    const { client } = await execute(db);
    expect(client.submissions).toHaveLength(1);
    expect(client.submissions[0]?.body.input).toBe(db.resumeInput);
    expect(client.submissions[0]?.key).toContain('-a2');
    expect(db.snapshots.get(2)?.input).toBe(db.resumeInput);
  });

  it('starts fresh streaming without a second remote readiness round trip', async () => {
    const client = new FakeHermesClient();
    await execute(new FakeRuntimeDb(), client);
    expect(client.capabilityReads).toBe(1);
    expect(client.eventSubscriptions).toBe(1);
  });

  it('rechecks readiness when a fresh submission takes longer than the reuse window', async () => {
    let now = 10_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const client = new FakeHermesClient();
      client.onSubmit = () => { now += 5_001; };
      await execute(new FakeRuntimeDb(), client);
      expect(client.capabilityReads).toBe(2);
      expect(client.eventSubscriptions).toBe(1);
    } finally { clock.mockRestore(); }
  });

  it('does not treat a persisted submit checkpoint as a fresh readiness check', async () => {
    const db = new FakeRuntimeDb();
    db.nativeBinding = { runtimeRunId: NATIVE_ID, runtimeAttempt: 1 };
    const client = new FakeHermesClient();
    client.capabilityFailure = new HermesCapabilitiesError();
    const step = new FakeStep();
    step.results.set('hermes-submit', { id: NATIVE_ID });
    await execute(db, client, step);
    expect(client.submissions).toHaveLength(0);
    expect(client.capabilityReads).toBe(1);
    expect(client.eventSubscriptions).toBe(0);
    expect(db.statusChanges.at(-1)?.status).toBe('error');
  });

  it('consumes a fresh check before an execution retry and refuses the changed runtime', async () => {
    const db = new FakeRuntimeDb();
    const client = new FakeHermesClient();
    vi.spyOn(db, 'enterStep').mockImplementationOnce(async () => {
      client.capabilityFailure = new HermesCapabilitiesError();
      throw new Error('transient persistence failure before subscribing');
    });
    class RetryingStep extends FakeStep {
      override do<T>(name: string, config: Parameters<FakeStep['do']>[1], fn: () => Promise<T>) {
        return super.do(name, name === 'hermes-execute' ? { ...config, retries: { ...config.retries, limit: 2 } } : config, fn);
      }
    }
    await execute(db, client, new RetryingStep());
    expect(client.submissions).toHaveLength(1);
    expect(client.capabilityReads).toBe(2);
    expect(client.eventSubscriptions).toBe(0);
    expect(db.statusChanges.at(-1)?.status).toBe('error');
  });

  it.each([5_001, -1])('refuses changed readiness after a %i ms clock difference', async (difference) => {
    let now = 10_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      const client = new FakeHermesClient();
      client.onSubmit = () => {
        now += difference;
        client.capabilityFailure = new HermesCapabilitiesError();
      };
      const { db } = await execute(new FakeRuntimeDb(), client);
      expect(client.capabilityReads).toBe(2);
      expect(client.eventSubscriptions).toBe(0);
      expect(db.statusChanges.at(-1)?.status).toBe('error');
    } finally { clock.mockRestore(); }
  });

  it('reports first text from attempt entry including capability and submission time', async () => {
    let now = 10_000;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    const measurements: Array<Parameters<NonNullable<RuntimeDeps['onLatency']>>[0]> = [];
    class TimedClient extends FakeHermesClient {
      override capabilities() {
        now += 600;
        return super.capabilities();
      }
    }
    try {
      const client = new TimedClient();
      client.onSubmit = () => { now += 800; };
      const { db } = await execute(new FakeRuntimeDb(), client, new FakeStep(), undefined, {
        onLatency: (measurement) => {
          measurements.push(measurement);
          // A broken telemetry sink must not interrupt the native stream.
          throw new Error('metric sink unavailable');
        },
      });
      expect(measurements).toContainEqual(expect.objectContaining({ phase: 'submit_capabilities', duration_ms: 600 }));
      expect(measurements).toContainEqual(expect.objectContaining({ phase: 'native_submit', duration_ms: 800 }));
      expect(measurements).toContainEqual(expect.objectContaining({ phase: 'first_delta', elapsed_ms: 1400 }));
      expect(JSON.stringify(measurements)).not.toContain(client.deltas[0]);
      expect(db.statusChanges.at(-1)?.status).toBe('completed');
    } finally { clock.mockRestore(); }
  });

  it('streams into a single assistant message and replaces interim prose with authoritative final output', async () => {
    const client = new FakeHermesClient();
    client.final.usage = { input_tokens: 37, output_tokens: 9 };
    const { db } = await execute(new FakeRuntimeDb(), client);
    expect(db.messages.size).toBe(1);
    expect(db.messages.get(0)).toMatchObject({ text: 'The review is ready.', status: 'complete' });
    const deltas = db.events.filter((event) => event.kind === 'message.delta');
    expect(deltas.map((event) => (event.payload as { delta: string }).delta).join('')).toBe(client.deltas.join(''));
    expect(db.events.filter((event) => event.kind === 'message.final')).toHaveLength(1);
    expect(db.statusChanges.at(-1)?.status).toBe('completed');
    // Provider calls are accounted at the model proxy with the key actually
    // used. The terminal native aggregate must not create a duplicate row.
    expect(db.modelCalls).toEqual([]);
    expect(client.streamSignal?.aborted).toBe(true);
    assertRunLog(db.streamEvents(), { requireFinalPerTurn: true });
  });

  it('does not duplicate governed bridge tools from name-only native lifecycle frames', async () => {
    class ToolActivityClient extends FakeHermesClient {
      override async *events(_id: string, signal: AbortSignal): AsyncGenerator<HermesEvent> {
        this.eventSubscriptions += 1;
        this.streamSignal = signal;
        yield { event: 'tool.started', run_id: NATIVE_ID, tool: 'list_partner_candidates' };
        yield { event: 'tool.completed', run_id: NATIVE_ID, tool: 'list_partner_candidates' };
        yield { event: 'message.delta', run_id: NATIVE_ID, delta: 'I found one candidate.' };
        this.current = this.final;
        yield { event: `run.${this.final.status}`, ...this.final };
      }
    }

    const db = new FakeRuntimeDb();
    const enteredSteps = vi.spyOn(db, 'enterStep');
    await execute(db, new ToolActivityClient());
    const activity = db.events
      .filter((event) => event.kind === 'run.step' && Boolean((event.payload as { tool_call_id?: string | null }).tool_call_id))
      .map((event) => event.payload as { step_id: string; label: string; state: string; tool_call_id: string });

    expect(activity).toEqual([]);
    expect(enteredSteps).not.toHaveBeenCalledWith(expect.objectContaining({ label: 'list_partner_candidates' }));
    expect(db.steps.has('0:hermes-tool-1')).toBe(false);
  });

  it('preserves native lifecycle activity for local and MCP tools without a bridge record', async () => {
    class ToolActivityClient extends FakeHermesClient {
      override async *events(_id: string, signal: AbortSignal): AsyncGenerator<HermesEvent> {
        this.eventSubscriptions += 1;
        this.streamSignal = signal;
        yield { event: 'tool.started', run_id: NATIVE_ID, tool: 'skill_view' };
        yield { event: 'tool.completed', run_id: NATIVE_ID, tool: 'skill_view' };
        yield { event: 'tool.started', run_id: NATIVE_ID, tool: 'mcp__fixture__read' };
        yield { event: 'message.delta', run_id: NATIVE_ID, delta: 'I found one candidate.' };
        yield { event: 'tool.completed', run_id: NATIVE_ID, tool: 'mcp__fixture__read', error: false };
        this.current = this.final;
        yield { event: `run.${this.final.status}`, ...this.final };
      }
    }

    const db = new FakeRuntimeDb();
    const enteredSteps = vi.spyOn(db, 'enterStep');
    await execute(db, new ToolActivityClient());
    const activity = db.events
      .filter((event) => event.kind === 'run.step' && Boolean((event.payload as { tool_call_id?: string | null }).tool_call_id))
      .map((event) => event.payload as { step_id: string; label: string; state: string; tool_call_id: string });

    expect(activity).toEqual([
      expect.objectContaining({ step_id: 'hermes-tool-1', label: 'skill_view', state: 'active', tool_call_id: 'hermes-tool-1' }),
      expect.objectContaining({ step_id: 'hermes-tool-1', label: 'skill_view', state: 'done', tool_call_id: 'hermes-tool-1' }),
      expect.objectContaining({ step_id: 'hermes-tool-2', label: 'mcp__fixture__read', state: 'active', tool_call_id: 'hermes-tool-2' }),
      expect.objectContaining({ step_id: 'hermes-tool-2', label: 'mcp__fixture__read', state: 'done', tool_call_id: 'hermes-tool-2' }),
    ]);
    expect(enteredSteps).toHaveBeenCalledWith(expect.objectContaining({ label: 'skill_view', toolCallId: 'hermes-tool-1' }));
    expect(enteredSteps).toHaveBeenCalledWith(expect.objectContaining({ label: 'mcp__fixture__read', toolCallId: 'hermes-tool-2' }));
    expect(db.steps.get('0:hermes-tool-1')?.state).toBe('done');
    expect(db.steps.get('0:hermes-tool-2')?.state).toBe('done');
  });

  it('records a reasoning phase boundary without exposing preview text', async () => {
    class ReasoningClient extends FakeHermesClient {
      override async *events(_id: string, signal: AbortSignal): AsyncGenerator<HermesEvent> {
        this.eventSubscriptions += 1;
        this.streamSignal = signal;
        yield { event: 'reasoning.available', run_id: NATIVE_ID, text: 'private intermediate reasoning' };
        yield { event: 'message.delta', run_id: NATIVE_ID, delta: 'A user-facing answer.' };
        this.current = this.final;
        yield { event: `run.${this.final.status}`, ...this.final };
      }
    }

    const { db } = await execute(new FakeRuntimeDb(), new ReasoningClient());
    const reasoning = db.events
      .filter((event) => event.kind === 'run.step')
      .map((event) => event.payload as { step_id: string; label: string; state: string })
      .find((event) => event.step_id === 'hermes-reasoning');
    expect(reasoning).toEqual(expect.objectContaining({ label: 'Reasoning', state: 'done' }));
    expect(db.steps.get('0:hermes-reasoning')?.state).toBe('done');
    expect(JSON.stringify(db.events)).not.toContain('private intermediate reasoning');
  });

  it('flushes a trailing delta during a native pause instead of waiting for the status poll', async () => {
    class PausingClient extends FakeHermesClient {
      beforeTerminal: (() => void) | null = null;

      override async *events(_id: string, signal: AbortSignal): AsyncGenerator<HermesEvent> {
        this.eventSubscriptions += 1;
        this.streamSignal = signal;
        yield { event: 'message.delta', run_id: NATIVE_ID, delta: 'First. ' };
        yield { event: 'message.delta', run_id: NATIVE_ID, delta: 'Second.' };
        await new Promise((resolve) => setTimeout(resolve, 30));
        this.beforeTerminal?.();
        this.current = this.final;
        yield { event: `run.${this.final.status}`, ...this.final };
      }
    }

    const client = new PausingClient();
    let forwardedDeltas = 0;
    client.beforeTerminal = () => expect(forwardedDeltas).toBe(2);
    await execute(
      new FakeRuntimeDb(),
      client,
      new FakeStep(),
      async (_session, _run, events) => {
        forwardedDeltas += events.filter((event) => event.kind === 'message.delta').length;
        return { stop_requested: false };
      },
      { pollMs: 100, batchMs: 5 },
    );
    expect(forwardedDeltas).toBe(2);
  });

  it('coalesces an already-buffered burst after a slow durable delta write', async () => {
    class SlowDeltaDb extends FakeRuntimeDb {
      override async emit(events: Parameters<FakeRuntimeDb['emit']>[0]) {
        const saved = await super.emit(events);
        if (events.some((event) => event.kind === 'message.delta')) {
          await new Promise((resolve) => setTimeout(resolve, 20));
        }
        return saved;
      }
    }

    const client = new FakeHermesClient();
    client.deltas = ['One. ', 'Two. ', 'Three.'];
    const { db } = await execute(
      new SlowDeltaDb(),
      client,
      new FakeStep(),
      undefined,
      { pollMs: 100, batchMs: 5 },
    );
    const deltas = db.events.filter((event) => event.kind === 'message.delta');
    expect(deltas).toHaveLength(2);
    expect(deltas.map((event) => (event.payload as { delta: string }).delta).join('')).toBe(client.deltas.join(''));
  });

  it('previews native text before a slow durable checkpoint completes', async () => {
    class SlowDeltaDb extends FakeRuntimeDb {
      durableDeltaFinished = false;
      override async emit(events: Parameters<FakeRuntimeDb['emit']>[0]) {
        const saved = await super.emit(events);
        if (events.some((event) => event.kind === 'message.delta')) {
          await new Promise((resolve) => setTimeout(resolve, 60));
          this.durableDeltaFinished = true;
        }
        return saved;
      }
    }

    const db = new SlowDeltaDb();
    const client = new FakeHermesClient();
    client.deltas = ['Fast ', 'lane'];
    const previews: { offset: number; delta: string; beforeDurable: boolean }[] = [];
    await execute(db, client, new FakeStep(), undefined, {
      pollMs: 100,
      batchMs: 5,
      preview: async (frame) => {
        previews.push({ offset: frame.offset, delta: frame.delta, beforeDurable: !db.durableDeltaFinished });
      },
    });

    expect(previews.map(({ offset, delta }) => ({ offset, delta }))).toEqual([
      { offset: 0, delta: 'Fast ' },
      { offset: 5, delta: 'lane' },
    ]);
    expect(previews.every((frame) => frame.beforeDurable)).toBe(true);
    expect(db.events.filter((event) => event.kind === 'message.delta').map((event) => (event.payload as { delta: string }).delta).join('')).toBe('Fast lane');
  });

  it.each(['eof', 'error'] as const)('flushes a suppressed delta immediately when the native stream ends by %s', async (ending) => {
    class EndingClient extends FakeHermesClient {
      override async *events(_id: string, signal: AbortSignal): AsyncGenerator<HermesEvent> {
        this.eventSubscriptions += 1;
        this.streamSignal = signal;
        yield { event: 'message.delta', run_id: NATIVE_ID, delta: 'First. ' };
        yield { event: 'message.delta', run_id: NATIVE_ID, delta: 'Last.' };
        this.current = this.final;
        if (ending === 'error') throw new Error('native stream disconnected');
      }
    }

    const client = new EndingClient();
    const started = Date.now();
    let secondDeltaAt = Number.POSITIVE_INFINITY;
    await execute(
      new FakeRuntimeDb(),
      client,
      new FakeStep(),
      async (_session, _run, events) => {
        if (events.some((event) => event.kind === 'message.delta' && (event.payload as { delta?: string }).delta === 'Last.')) {
          secondDeltaAt = Date.now() - started;
        }
        return { stop_requested: false };
      },
      { pollMs: 200, batchMs: 1000 },
    );
    expect(secondDeltaAt).toBeLessThan(150);
  });

  it('forwards the last delta before a slow terminal status reconciliation', async () => {
    class SlowTerminalClient extends FakeHermesClient {
      terminalStatusResolved = false;

      override status() {
        this.statusReads += 1;
        if (!terminalHermesStatus(this.current.status)) return Promise.resolve({ ...this.current });
        return new Promise<HermesStatus>((resolve) => {
          setTimeout(() => {
            this.terminalStatusResolved = true;
            resolve({ ...this.current });
          }, 80);
        });
      }

      override async *events(_id: string, signal: AbortSignal): AsyncGenerator<HermesEvent> {
        this.eventSubscriptions += 1;
        this.streamSignal = signal;
        yield { event: 'message.delta', run_id: NATIVE_ID, delta: 'First. ' };
        yield { event: 'message.delta', run_id: NATIVE_ID, delta: 'Last.' };
        this.current = this.final;
        yield { event: `run.${this.final.status}`, ...this.final };
      }
    }

    const client = new SlowTerminalClient();
    let lastDeltaBeforeStatus = false;
    await execute(
      new FakeRuntimeDb(),
      client,
      new FakeStep(),
      async (_session, _run, events) => {
        if (events.some((event) => event.kind === 'message.delta' && (event.payload as { delta?: string }).delta === 'Last.')) {
          lastDeltaBeforeStatus = !client.terminalStatusResolved;
        }
        return { stop_requested: false };
      },
      { pollMs: 200, batchMs: 75 },
    );
    expect(lastDeltaBeforeStatus).toBe(true);
    expect(client.terminalStatusResolved).toBe(true);
  });

  it('snapshots request metadata before submission and persists the binding before consuming native execution', async () => {
    const db = new FakeRuntimeDb({ effort: 'high' });
    db.bootstrap = [{ role: 'user', content: 'Earlier question.' }, { role: 'assistant', content: 'Earlier answer.' }];
    const client = new FakeHermesClient();
    client.onSubmit = () => expect(db.snapshots.has(1)).toBe(true);
    client.onStatus = () => expect(db.nativeBinding?.runtimeRunId).toBe(NATIVE_ID);
    await execute(db, client);
    const run = (await db.loadRun())!;
    expect(client.submissions).toHaveLength(1);
    expect(client.submissions[0]).toMatchObject({
      key: `enterprise-${run.id}-a1`,
      body: {
        input: 'Here is the programme and the application.', session_id: run.sessionId,
        provider: 'custom', model: 'anthropic/claude-sonnet-4',
        model_options: { reasoning_effort: 'high' }, conversation_history: db.bootstrap,
      },
    });
    expect(client.submissions[0]?.body.instructions).toContain('Admit applicants who meet the published bar.');
    expect(db.bindings).toEqual([{ runId: run.id, attempt: 1, remoteId: NATIVE_ID, sessionId: run.sessionId, profile: PROFILE }]);
    expect(JSON.stringify(client.submissions)).not.toContain('sk-test');
  });

  it.each([
    ['nous:stepfun/step-3.7-flash', 'stepfun/step-3.7-flash'],
    ['nous:stepfun/step-3.7-flash:free', 'stepfun/step-3.7-flash:free'],
  ])('submits the exact effective Portal route for %s', async (catalogId, wireId) => {
    class NousRuntimeDb extends FakeRuntimeDb {
      constructor() { super({ modelId: catalogId }); }
      override loadModel() {
        return Promise.resolve({ model_id: catalogId, provider: 'nous_portal', transport: 'nous_chat', effort_map: null });
      }
    }
    const client = new FakeHermesClient();
    await execute(new NousRuntimeDb(), client);
    expect(client.submissions[0]?.body.model).toBe(wireId);
    expect(client.submissions[0]?.body.provider).toBe('custom');
  });

  it('reuses a persisted native run when submission checkpoints are lost', async () => {
    const db = new FakeRuntimeDb();
    db.nativeBinding = { runtimeRunId: NATIVE_ID, runtimeAttempt: 1 };
    const client = new FakeHermesClient();
    client.current = client.final;
    await execute(db, client, new FakeStep());
    expect(client.submissions).toEqual([]);
    expect(client.eventSubscriptions).toBe(0);
    expect(client.capabilityReads).toBe(2);
    expect(db.messages.get(0)?.text).toBe(client.final.output);
    expect(db.statusChanges.at(-1)?.status).toBe('completed');
  });

  it('checks submission readiness and the persisted binding concurrently', async () => {
    let releaseReadiness: (() => void) | null = null;
    class ConcurrentSubmitClient extends FakeHermesClient {
      override capabilities() {
        this.capabilityReads += 1;
        if (this.capabilityReads !== 1) {
          return Promise.resolve({ durableIdempotency: true as const, retentionSeconds: 86_400 });
        }
        return new Promise<{ durableIdempotency: true; retentionSeconds: number }>((resolve) => {
          releaseReadiness = () => resolve({ durableIdempotency: true, retentionSeconds: 86_400 });
        });
      }
    }

    class ConcurrentBindingDb extends FakeRuntimeDb {
      override binding() {
        releaseReadiness?.();
        releaseReadiness = null;
        return super.binding();
      }
    }

    const client = new ConcurrentSubmitClient();
    await execute(new ConcurrentBindingDb(), client);
    expect(client.capabilityReads).toBe(1);
    expect(client.statusReads).toBeGreaterThan(0);
  });

  it('fails closed on replay when the restarted runtime loses durable idempotency', async () => {
    const db = new FakeRuntimeDb();
    db.nativeBinding = { runtimeRunId: NATIVE_ID, runtimeAttempt: 1 };
    const client = new FakeHermesClient();
    client.capabilityFailure = new Error('native durability unavailable');
    await execute(db, client);
    expect(client.capabilityReads).toBeGreaterThan(0);
    expect(client.submissions).toEqual([]);
    expect(client.statusReads).toBe(0);
    expect(db.statusChanges.at(-1)?.status).toBe('error');
  });

  it('uses the snapshotted request on a submit retry even if current context has changed', async () => {
    const db = new FakeRuntimeDb();
    const original = { input: 'Original question.', session_id: FakeAgentDb.SESSION_ID, instructions: 'Original instructions.', model: 'original/model', provider: 'custom' };
    db.snapshots.set(1, original);
    db.contextFields.set('new-context', 'Changed since admission.');
    const { client } = await execute(db);
    expect(client.submissions[0]?.body).toEqual(original);
  });

  it('recovers terminal output after the non-replayable native stream disconnects', async () => {
    const client = new FakeHermesClient();
    client.disconnect = true;
    client.final.usage = { input_tokens: 15, output_tokens: 5 };
    const { db } = await execute(new FakeRuntimeDb(), client);
    expect(client.submissions).toHaveLength(1);
    expect(client.eventSubscriptions).toBe(1);
    expect(client.stops).toEqual([]);
    expect(db.messages.get(0)?.text).toBe(client.final.output);
    expect(db.modelCalls).toEqual([]);
    expect(db.statusChanges.at(-1)?.status).toBe('completed');
  });

  it('sends Stop once and waits for the native cancelled status before reporting stopped', async () => {
    const db = new FakeRuntimeDb();
    let nativeStopped!: () => void;
    const stopReceived = new Promise<void>((resolve) => { nativeStopped = resolve; });
    class StoppableClient extends FakeHermesClient {
      override async *events(_id: string, signal: AbortSignal): AsyncGenerator<HermesEvent> {
        this.eventSubscriptions += 1;
        this.streamSignal = signal;
        for (const delta of this.deltas) yield { event: 'message.delta', run_id: NATIVE_ID, delta };
        // Keep native execution alive until Stop arrives; an already-complete
        // in-memory fixture is no longer held back by control polling.
        await stopReceived;
      }
    }
    const client = new StoppableClient();
    let readsAfterStop = 0;
    client.onStop = () => { client.current = { run_id: NATIVE_ID, status: 'stopping' }; nativeStopped(); };
    client.onStatus = () => {
      if (!client.stops.length) return;
      readsAfterStop += 1;
      expect(db.statusChanges.at(-1)?.status).toBe('working');
      if (readsAfterStop >= 2) client.current = { run_id: NATIVE_ID, status: 'cancelled' };
    };
    await execute(db, client, new FakeStep(), async (_session, _run, events) => {
      if (events.some((event) => event.kind === 'message.delta')) db.stopFlag = true;
      return { stop_requested: db.stopFlag };
    });
    expect(client.stops).toEqual([NATIVE_ID]);
    expect(readsAfterStop).toBeGreaterThanOrEqual(2);
    expect(db.statusChanges.at(-1)?.status).toBe('stopped');
    expect(db.messages.get(0)).toMatchObject({ status: 'incomplete', text: client.deltas.join('') });
    expect(db.modelCalls).toEqual([]);
  });

  it('stops a bound native run when Stop was requested before a Workflow replay begins', async () => {
    const db = new FakeRuntimeDb();
    db.nativeBinding = { runtimeRunId: NATIVE_ID, runtimeAttempt: 1 };
    db.stopFlag = true;
    const { client } = await execute(db);
    expect(client.stops).toEqual([NATIVE_ID]);
    expect(client.statusReads).toBeGreaterThan(0);
    expect(client.submissions).toEqual([]);
    expect(db.statusChanges.at(-1)?.status).toBe('stopped');
  });

  it('does not submit a new native run when stopped before admission', async () => {
    const db = new FakeRuntimeDb();
    db.stopFlag = true;
    const { client } = await execute(db);
    expect(client.submissions).toEqual([]);
    expect(client.stops).toEqual([]);
    expect(db.statusChanges.at(-1)?.status).toBe('stopped');
  });

  it.each([true, false])('marks queued guidance applied only when native steering accepts it (%s)', async (accepted) => {
    const db = new FakeRuntimeDb();
    const guidanceId = crypto.randomUUID();
    db.guidance.push({ id: guidanceId, text: 'Check the references first.', status: 'queued' });
    const client = new FakeHermesClient();
    client.acceptSteer = accepted;
    await execute(db, client);
    expect(client.steers.length).toBeGreaterThan(0);
    expect(client.steers.every((steer) => steer.id === NATIVE_ID && steer.text === 'Check the references first.')).toBe(true);
    expect(db.guidance[0]?.status).toBe(accepted ? 'applied' : 'queued');
    expect(db.events.filter((event) => event.kind === 'run.guidance.applied')).toHaveLength(accepted ? 1 : 0);
    expect(db.carriedGuidance).toEqual(accepted ? [] : [guidanceId]);
  });

  it('leaves accepted guidance queued when the terminal native status says it was never delivered', async () => {
    const db = new FakeRuntimeDb();
    const text = 'Check the references first.';
    db.guidance.push({ id: crypto.randomUUID(), text, status: 'queued' });
    const client = new FakeHermesClient();
    client.final.pending_steer = text;
    await execute(db, client);
    expect(client.steers).toEqual([{ id: NATIVE_ID, text }]);
    expect(db.guidance[0]?.status).toBe('queued');
    expect(db.events.filter((event) => event.kind === 'run.guidance.applied')).toEqual([]);
    expect(db.carriedGuidance).toEqual([db.guidance[0]!.id]);
  });

  it('does not claim guidance was applied when the native run failed', async () => {
    const db = new FakeRuntimeDb();
    db.guidance.push({ id: crypto.randomUUID(), text: 'Check the references first.', status: 'queued' });
    const client = new FakeHermesClient();
    client.final = { run_id: NATIVE_ID, status: 'failed' };
    await execute(db, client);
    expect(client.steers).toHaveLength(1);
    expect(db.guidance[0]?.status).toBe('queued');
    expect(db.events.filter((event) => event.kind === 'run.guidance.applied')).toEqual([]);
    expect(db.carriedGuidance).toEqual([db.guidance[0]!.id]);
  });

  it('classifies failed native execution, logs only safe fields and does not duplicate proxy accounting', async () => {
    const client = new FakeHermesClient();
    client.final = { run_id: NATIVE_ID, status: 'failed', error: 'HTTP 429: provider-key-and-private-request-must-not-leak' };
    const terminalFailures: RuntimeTerminalFailure[] = [];
    const { db } = await execute(new FakeRuntimeDb(), client, new FakeStep(), undefined, {
      onTerminalFailure: (failure) => terminalFailures.push(failure),
    });
    expect(db.statusChanges.at(-1)).toMatchObject({
      status: 'error',
      error: { class: 'transient', retryable: true, reason: 'hermes_provider_rate_limited', step_id: 'hermes' },
    });
    expect(terminalFailures).toEqual([expect.objectContaining({
      native_status: 'failed', failure_code: 'rate_limit', reason: 'hermes_provider_rate_limited',
      retryable: true, native_error_present: true,
    })]);
    expect(db.messages.get(0)?.status).toBe('incomplete');
    expect(db.modelCalls).toEqual([]);
    expect(JSON.stringify({ events: db.events, messages: [...db.messages], status: db.statusChanges, terminalFailures })).not.toContain(client.final.error);
  });

  it('reports stopped after native authority revocation beats the stop poll to a terminal failure', async () => {
    const db = new FakeRuntimeDb();
    const client = new FakeHermesClient();
    client.final = { run_id: NATIVE_ID, status: 'failed', error: 'HTTP 409: runtime_run_inactive' };
    client.onStatus = () => { if (client.current.status === 'failed') db.stopFlag = true; };
    await execute(db, client);
    expect(db.statusChanges.at(-1)?.status).toBe('stopped');
    expect(db.modelCalls).toEqual([]);
    expect(db.messages.get(0)?.status).toBe('incomplete');
  });

  it('closes activity and preserves partial output when runtime status becomes unreachable', async () => {
    const client = new FakeHermesClient();
    client.onStatus = () => { if (terminalHermesStatus(client.current.status)) throw new Error('private upstream failure'); };
    const { db } = await execute(new FakeRuntimeDb(), client);
    expect(db.statusChanges.at(-1)).toMatchObject({ status: 'error', error: { reason: 'hermes_unavailable' } });
    expect(db.messages.get(0)).toMatchObject({ status: 'incomplete' });
    expect(db.events.filter((event) => event.kind === 'run.step').at(-1)?.payload).toMatchObject({ state: 'failed' });
    expect(db.events.filter((event) => event.kind === 'message.final')).toHaveLength(1);
    expect(client.stops).toEqual([NATIVE_ID]);
    expect(JSON.stringify(db.events)).not.toContain('private upstream failure');
  });

  it('keeps an explicitly empty final output instead of promoting intermediate prose to the answer', async () => {
    const client = new FakeHermesClient();
    client.final.output = '';
    const { db } = await execute(new FakeRuntimeDb(), client);
    expect(db.messages.get(0)).toMatchObject({ text: '', status: 'complete' });
    expect(db.modelCalls).toEqual([]);
  });

  it('stops the native execution if its attempt was superseded before the binding could be saved', async () => {
    const db = new FakeRuntimeDb();
    db.acceptBinding = false;
    const { client } = await execute(db);
    expect(client.stops.length).toBeGreaterThan(0);
    expect(client.eventSubscriptions).toBe(0);
    expect(db.messages.size).toBe(0);
  });

  it('does not duplicate final assistant history when the execute checkpoint is replayed after persistence', async () => {
    const { db, client, step } = await execute();
    const firstMessageId = db.messages.get(0)?.id;
    // Simulate process loss after durable writes, before the step checkpoint.
    step.results.delete('hermes-execute');
    await execute(db, client, new FakeStep(step));
    expect(client.submissions).toHaveLength(1);
    expect(db.messages.size).toBe(1);
    expect(db.messages.get(0)?.id).toBe(firstMessageId);
    expect(db.turns.filter((turn) => turn.role === 'assistant' && !turn.providerMessage.tool_calls?.length)).toHaveLength(1);
  });

  it('does not meter or emit a completed native run again after losing the execute checkpoint', async () => {
    const { db, client, step } = await execute();
    const originalEvents = [...db.events];
    const originalActiveMs = (await db.loadRun())!.activeMs;
    step.results.delete('hermes-execute');
    await execute(db, client, new FakeStep(step));
    expect(db.modelCalls).toHaveLength(0);
    expect((await db.loadRun())!.activeMs).toBe(originalActiveMs);
    expect(db.events).toEqual(originalEvents);
    expect(db.finalizations).toBe(1);
    assertRunLog(db.streamEvents(), { requireFinalPerTurn: true });
  });

  it('publishes terminal events only after the finalization transaction has completed', async () => {
    const db = new FakeRuntimeDb();
    let finalPublished = false;
    await execute(db, new FakeHermesClient(), new FakeStep(), async (_session, _run, events) => {
      if (events.some((event) => event.kind === 'message.final')) {
        finalPublished = true;
        expect(db.finalizing).toBe(false);
        expect(db.messages.get(0)?.status).toBe('complete');
        expect(db.statusChanges.at(-1)?.status).toBe('completed');
        expect(db.modelCalls).toHaveLength(1);
      }
      return { stop_requested: false };
    });
    expect(finalPublished).toBe(true);
    expect(db.finalizations).toBe(1);
  });

  it('preserves the completed run and durable final events when their live delivery fails', async () => {
    const db = new FakeRuntimeDb();
    await execute(db, new FakeHermesClient(), new FakeStep(), async (_session, _run, events) => {
      if (events.some((event) => event.kind === 'message.final')) throw new Error('hub disconnected with sensitive upstream detail');
      return { stop_requested: false };
    });
    expect(db.statusChanges.at(-1)?.status).toBe('completed');
    expect(db.messages.get(0)?.status).toBe('complete');
    expect(db.events.filter((event) => event.kind === 'message.final')).toHaveLength(1);
    expect(db.events.filter((event) => event.kind === 'run.status')).toHaveLength(1);
    expect(JSON.stringify(db.events)).not.toContain('sensitive upstream detail');
    assertRunLog(db.streamEvents(), { requireFinalPerTurn: true });
  });
});
