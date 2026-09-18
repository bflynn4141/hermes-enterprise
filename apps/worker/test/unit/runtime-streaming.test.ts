// Exercise the native byte stream independently of status, database and hub
// latency. These are real adapter/SSE-parser tests with no network or provider.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { assertRunLog, type MessagePreviewFrame } from '@hermes/shared';
import type { EmitInput, EmittedEvent } from '../../src/engine/agent-db.js';
import { runHermesAttempt, type RuntimeDeps, type RuntimePersistence } from '../../src/runtime/adapter.js';
import { HermesClient, type HermesEvent, type HermesStatus } from '../../src/runtime/client.js';
import { FakeAgentDb } from './engine/fake-db.js';
import { FakeStep } from './engine/fake-step.js';

const NATIVE_ID = 'run_stream-regression';
const MODEL = 'openrouter:anthropic/claude-sonnet-4';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

class StreamingDb extends FakeAgentDb implements RuntimePersistence {
  finalizations = 0;
  constructor() { super({ modelId: MODEL }); }
  override loadModel() {
    return Promise.resolve({ model_id: MODEL, provider: 'openrouter', transport: 'openrouter', effort_map: null });
  }
  binding() { return Promise.resolve(null); }
  bindRun() { return Promise.resolve(true); }
  snapshotRequest(_id: string, _attempt: number, body: Record<string, unknown>) { return Promise.resolve(body); }
  loadBootstrapHistory() { return Promise.resolve([]); }
  nextRuntimeSequence() { return Promise.resolve(0); }
  finalizeRuntime<T>(_id: string, _attempt: number, work: () => Promise<T>) {
    this.finalizations += 1;
    return work();
  }
  carryGuidance() { return Promise.resolve(); }
}

class StreamingClient extends HermesClient {
  statusReads = 0;
  subscriptions = 0;
  signal: AbortSignal | null = null;
  current: HermesStatus = { run_id: NATIVE_ID, status: 'running' };
  readonly controlStarted = deferred();
  readonly controlRelease = deferred();
  readonly consumed: HermesEvent[] = [];
  holdControl = false;

  constructor(stream: ReadableStream<Uint8Array>) {
    super('https://runtime.invalid', 'test-only', async () => new Response(stream, {
      headers: { 'Content-Type': 'text/event-stream' },
    }));
  }
  override capabilities() { return Promise.resolve({ durableIdempotency: true as const, retentionSeconds: 86400 }); }
  override submit() { return Promise.resolve(NATIVE_ID); }
  override async status(): Promise<HermesStatus> {
    this.statusReads += 1;
    if (this.statusReads === 1) {
      this.controlStarted.resolve();
      if (this.holdControl) await this.controlRelease.promise;
    }
    return { ...this.current };
  }
  override stop() { this.current = { run_id: NATIVE_ID, status: 'cancelled' }; return Promise.resolve(); }
  override async *events(id: string, signal: AbortSignal): AsyncGenerator<HermesEvent> {
    this.subscriptions += 1;
    this.signal = signal;
    for await (const event of super.events(id, signal)) {
      this.consumed.push(event);
      yield event;
    }
  }
}

function harness(options: { holdControl?: boolean; db?: StreamingDb; drainMs?: number; pollMs?: number } = {}) {
  let streamController!: ReadableStreamDefaultController<Uint8Array>;
  let closed = false;
  const stream = new ReadableStream<Uint8Array>({ start(controller) { streamController = controller; } });
  const client = new StreamingClient(stream);
  client.holdControl = options.holdControl ?? false;
  const db = options.db ?? new StreamingDb();
  const previews: MessagePreviewFrame[] = [];
  const forwarded: EmittedEvent[] = [];
  const previewRelease = deferred();
  const previewStarted = deferred();
  let holdPreview = false;
  let finished = false;
  const encoder = new TextEncoder();
  const send = (event: Omit<HermesEvent, 'run_id'>) => {
    streamController.enqueue(encoder.encode(`data: ${JSON.stringify({ ...event, run_id: NATIVE_ID })}\n\n`));
  };
  const deps: RuntimeDeps = {
    db, client, profile: 'stream-regression', pollMs: options.pollMs ?? 1000, batchMs: 5,
    ...(options.drainMs === undefined ? {} : { drainMs: options.drainMs }),
    forward: async (_sessionId, _runId, events) => { forwarded.push(...events); return { stop_requested: false }; },
    preview: async (frame) => {
      previews.push(frame);
      previewStarted.resolve();
      if (holdPreview) await previewRelease.promise;
    },
  };
  let task: Promise<void> | null = null;
  return {
    db, client, deps, previews, forwarded, send, previewStarted, previewRelease,
    holdPreview() { holdPreview = true; },
    start() {
      task = (async () => {
        const run = (await db.loadRun())!;
        await runHermesAttempt(deps, new FakeStep(), { runId: run.id, attempt: run.attempt, traceId: 'stream-regression' });
        finished = true;
      })();
      return task;
    },
    isFinished() { return finished; },
    complete(output = 'First. Second.', close = true) {
      client.current = { run_id: NATIVE_ID, status: 'completed', output };
      if (close && !closed) {
        send({ event: 'run.completed' });
        streamController.close();
        closed = true;
      }
    },
    async cleanup() {
      client.controlRelease.resolve();
      previewRelease.resolve();
      this.complete();
      await vi.advanceTimersByTimeAsync(2000);
      await task;
    },
  };
}

const deltaText = (events: readonly EmittedEvent[]) => events.filter((event) => event.kind === 'message.delta')
  .map((event) => (event.payload as { delta: string }).delta).join('');
const previewText = (frames: readonly MessagePreviewFrame[]) => frames.map((frame) => frame.delta).join('');

describe('native streaming independent of control and delivery latency', () => {
  beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date('2026-09-17T20:00:00Z')); });
  afterEach(() => { vi.useRealTimers(); });

  it('delivers arriving text while a nonterminal status request is held', async () => {
    const h = harness({ holdControl: true });
    h.start();
    h.send({ event: 'tool.started', tool: 'list_partner_candidates' });
    try {
      await h.client.controlStarted.promise;
      h.send({ event: 'message.delta', delta: 'First. ' });
      h.send({ event: 'message.delta', delta: 'Second.' });
      await vi.advanceTimersByTimeAsync(20);
      expect(previewText(h.previews)).toBe('First. Second.');
      expect(deltaText(h.forwarded)).toBe('First. Second.');
      expect(h.isFinished()).toBe(false);
    } finally { await h.cleanup(); }
  });

  it('preserves deltas already available when a held status request discovers completion', async () => {
    const h = harness({ holdControl: true });
    const task = h.start();
    h.send({ event: 'tool.started', tool: 'list_partner_candidates' });
    try {
      await h.client.controlStarted.promise;
      h.send({ event: 'message.delta', delta: 'First. ' });
      h.send({ event: 'message.delta', delta: 'Second.' });
      h.complete();
      h.client.controlRelease.resolve();
      await vi.advanceTimersByTimeAsync(50);
      await task;
      expect(previewText(h.previews)).toBe('First. Second.');
      expect(deltaText(h.forwarded)).toBe('First. Second.');
      expect(h.forwarded.filter((event) => event.kind === 'message.final')).toHaveLength(1);
      expect(h.forwarded.at(-1)?.kind).toBe('run.status');
      expect(h.db.finalizations).toBe(1);
    } finally { await h.cleanup(); }
  });

  it('keeps reading and checkpointing native text while a preview RPC is held', async () => {
    const h = harness();
    h.holdPreview();
    h.start();
    h.send({ event: 'message.delta', delta: 'First. ' });
    try {
      await h.previewStarted.promise;
      h.send({ event: 'message.delta', delta: 'Second.' });
      await vi.advanceTimersByTimeAsync(20);
      expect(h.client.consumed.filter((event) => event.event === 'message.delta')).toHaveLength(2);
      expect(deltaText(h.forwarded)).toBe('First. Second.');
    } finally { await h.cleanup(); }
  });

  it('drains late text after status completion and finishes within a bound when native EOF never arrives', async () => {
    const h = harness({ holdControl: true, drainMs: 40 });
    const task = h.start();
    h.send({ event: 'tool.started', tool: 'list_partner_candidates' });
    try {
      await h.client.controlStarted.promise;
      h.send({ event: 'message.delta', delta: 'First. ' });
      h.complete('First. Second.', false);
      h.client.controlRelease.resolve();
      await vi.advanceTimersByTimeAsync(10);
      expect(h.isFinished()).toBe(false);
      h.send({ event: 'message.delta', delta: 'Second.' });
      await vi.advanceTimersByTimeAsync(100);
      expect(h.isFinished()).toBe(true);
      await task;
      expect(previewText(h.previews)).toBe('First. Second.');
      expect(deltaText(h.forwarded)).toBe('First. Second.');
      expect(h.client.signal?.aborted).toBe(true);
      expect(h.client.subscriptions).toBe(1);
      expect(h.forwarded.filter((event) => event.kind === 'message.final')).toHaveLength(1);
    } finally { await h.cleanup(); }
  });

  it('publishes final state only after every pending durable delta write has finished', async () => {
    const h = harness();
    const checkpointStarted = deferred();
    const checkpointRelease = deferred();
    let writesInFlight = 0;
    let maxWritesInFlight = 0;
    h.deps.checkpoint = async (events) => {
      writesInFlight += 1;
      maxWritesInFlight = Math.max(maxWritesInFlight, writesInFlight);
      try {
        checkpointStarted.resolve();
        await checkpointRelease.promise;
        return await h.db.emit(events);
      } finally { writesInFlight -= 1; }
    };
    const task = h.start();
    h.send({ event: 'message.delta', delta: 'First. ' });
    try {
      await checkpointStarted.promise;
      h.send({ event: 'message.delta', delta: 'Second.' });
      h.complete();
      await vi.advanceTimersByTimeAsync(20);
      expect(previewText(h.previews)).toBe('First. Second.');
      expect(h.forwarded.some((event) => event.kind === 'message.final')).toBe(false);
      expect(h.db.finalizations).toBe(0);
      checkpointRelease.resolve();
      await vi.advanceTimersByTimeAsync(100);
      await task;
      expect(writesInFlight).toBe(0);
      expect(maxWritesInFlight).toBe(1);
      expect(deltaText(h.forwarded)).toBe('First. Second.');
      const finalIndex = h.forwarded.findIndex((event) => event.kind === 'message.final');
      expect(h.forwarded.slice(finalIndex + 1).some((event) => event.kind === 'message.delta')).toBe(false);
      expect(h.forwarded.filter((event) => event.kind === 'message.final')).toHaveLength(1);
      expect(h.db.finalizations).toBe(1);
      assertRunLog(h.db.streamEvents(), { requireFinalPerTurn: true });
    } finally { checkpointRelease.resolve(); await h.cleanup(); }
  });

  it('serializes control and activity on their shared database connection while the separate checkpoint lane advances', async () => {
    class HeldControlDb extends StreamingDb {
      readonly queryHeld = deferred();
      readonly queryRelease = deferred();
      readonly overlaps: string[] = [];
      readonly enteredTools: string[] = [];
      private activeQuery: string | null = null;
      private stopReads = 0;

      private async query<T>(name: string, work: () => Promise<T>): Promise<T> {
        if (this.activeQuery) this.overlaps.push(`${this.activeQuery}/${name}`);
        this.activeQuery = name;
        try { return await work(); }
        finally { this.activeQuery = null; }
      }
      override stopRequested() {
        return this.query('stopRequested', async () => {
          this.stopReads += 1;
          if (this.stopReads === 2) {
            this.queryHeld.resolve();
            await this.queryRelease.promise;
          }
          return super.stopRequested();
        });
      }
      override loadGuidance() { return this.query('loadGuidance', () => super.loadGuidance()); }
      override enterStep(input: Parameters<FakeAgentDb['enterStep']>[0]) {
        return this.query('enterStep', () => {
          if (input.toolCallId) this.enteredTools.push(input.stepId);
          return super.enterStep(input);
        });
      }
      override finishStep(input: Parameters<FakeAgentDb['finishStep']>[0]) {
        return this.query('finishStep', () => super.finishStep(input));
      }
      override emit(events: readonly EmitInput[]) { return this.query('emit', () => super.emit(events)); }
    }
    const db = new HeldControlDb();
    const checkpointDb = new StreamingDb();
    const h = harness({ db });
    h.deps.checkpoint = (events) => checkpointDb.emit(events);
    const task = h.start();
    h.send({ event: 'tool.started', tool: 'skill_view' });
    try {
      await db.queryHeld.promise;
      h.send({ event: 'tool.started', tool: 'mcp__fixture__read' });
      h.send({ event: 'message.delta', delta: 'First. Second.' });
      await vi.advanceTimersByTimeAsync(20);
      expect(db.overlaps).toEqual([]);
      expect(previewText(h.previews)).toBe('First. Second.');
      expect(deltaText(h.forwarded)).toBe('First. Second.');
      db.queryRelease.resolve();
      h.send({ event: 'tool.completed', tool: 'mcp__fixture__read' });
      h.send({ event: 'tool.completed', tool: 'skill_view' });
      h.complete();
      await vi.advanceTimersByTimeAsync(100);
      await task;
      expect(db.overlaps).toEqual([]);
      expect(db.enteredTools).toEqual(['hermes-tool-1', 'hermes-tool-2']);
      expect(h.forwarded.filter((event) => event.kind === 'message.final')).toHaveLength(1);
    } finally { db.queryRelease.resolve(); await h.cleanup(); }
  });

  it('finalizes despite a hung preview and never sends its queued tail after final state', async () => {
    const h = harness();
    h.holdPreview();
    const task = h.start();
    h.send({ event: 'message.delta', delta: 'First. ' });
    try {
      await h.previewStarted.promise;
      h.send({ event: 'message.delta', delta: 'Second.' });
      h.complete();
      await vi.advanceTimersByTimeAsync(500);
      expect(h.isFinished()).toBe(true);
      await task;
      expect(deltaText(h.forwarded)).toBe('First. Second.');
      expect(h.forwarded.filter((event) => event.kind === 'message.final')).toHaveLength(1);
      expect(h.db.statusChanges.at(-1)?.status).toBe('completed');
      expect(h.previews).toHaveLength(1);
      h.previewRelease.resolve();
      await vi.advanceTimersByTimeAsync(100);
      expect(h.previews).toHaveLength(1);
      expect(h.forwarded.filter((event) => event.kind === 'message.final')).toHaveLength(1);
    } finally { await h.cleanup(); }
  });

  it('splits text accumulated behind slow delivery into valid frames with exact text and offsets', async () => {
    const h = harness();
    h.holdPreview();
    const checkpointStarted = deferred();
    const checkpointRelease = deferred();
    h.deps.checkpoint = async (events) => {
      checkpointStarted.resolve();
      await checkpointRelease.promise;
      return h.db.emit(events);
    };
    const task = h.start();
    const chunk = 'b'.repeat(1000);
    const completeText = 'a' + chunk.repeat(70);
    h.send({ event: 'message.delta', delta: 'a' });
    try {
      await Promise.all([h.previewStarted.promise, checkpointStarted.promise]);
      for (let index = 0; index < 70; index += 1) h.send({ event: 'message.delta', delta: chunk });
      h.complete(completeText);
      await vi.advanceTimersByTimeAsync(20);
      h.previewRelease.resolve();
      checkpointRelease.resolve();
      await vi.advanceTimersByTimeAsync(100);
      await task;
      expect(previewText(h.previews)).toBe(completeText);
      expect(deltaText(h.forwarded)).toBe(completeText);
      let offset = 0;
      for (const frame of h.previews) {
        expect(frame.delta.length).toBeLessThanOrEqual(32768);
        expect(frame.offset).toBe(offset);
        offset += frame.delta.length;
      }
      expect(offset).toBe(completeText.length);
      const deltas = h.forwarded.filter((event) => event.kind === 'message.delta');
      for (const [index, event] of deltas.entries()) {
        const payload = event.payload as { delta: string; seq: number };
        expect(payload.delta.length).toBeLessThanOrEqual(32768);
        expect(payload.seq).toBe(index);
      }
      expect(deltas.length).toBeGreaterThan(2);
      expect(h.previews.length).toBeGreaterThan(2);
      expect(h.forwarded.filter((event) => event.kind === 'message.final')).toHaveLength(1);
      assertRunLog(h.db.streamEvents(), { requireFinalPerTurn: true });
    } finally { checkpointRelease.resolve(); await h.cleanup(); }
  });

  it('keeps successful execution successful when its content-free metrics callback throws', async () => {
    const h = harness();
    const observed: Parameters<NonNullable<RuntimeDeps['onStreamMetrics']>>[0][] = [];
    h.deps.onStreamMetrics = (metrics) => {
      observed.push(structuredClone(metrics));
      throw new Error('test metrics sink unavailable');
    };
    const task = h.start();
    h.send({ event: 'message.delta', delta: 'First. ' });
    h.send({ event: 'message.delta', delta: 'Second.' });
    h.complete();
    try {
      await vi.advanceTimersByTimeAsync(100);
      await task;
      expect(observed).toHaveLength(1);
      expect(observed[0]).toMatchObject({ delta_count: 2, delta_characters: 14, stream_end: 'terminal' });
      expect(Object.keys(observed[0]!).sort()).toEqual([
        'delta_characters', 'delta_count', 'first_checkpoint_ms', 'first_delta_ms', 'first_preview_ms', 'preview_count', 'stream_end',
      ]);
      expect(JSON.stringify(observed)).not.toContain('First.');
      expect(h.db.statusChanges.at(-1)?.status).toBe('completed');
      expect(h.forwarded.filter((event) => event.kind === 'message.final')).toHaveLength(1);
      expect(h.db.finalizations).toBe(1);
    } finally { await h.cleanup(); }
  });
});
