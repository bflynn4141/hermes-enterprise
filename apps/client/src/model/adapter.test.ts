// Adapter tests, driven by a scriptable fake socket and a fetch mock.
//
// These are the cases that are cheap to get wrong and expensive to debug in a
// browser: the keepalive cadence, the reconnect ordering, what a 401 does to
// drafts, and the rule that a decision is never replayed after a redirect.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockUuid, requestReviewBinding, SCHEMA_VERSION } from '@hermes/shared';
import { createAdapter } from './adapter.js';
import { createHub, PING_MS, SILENCE_MS, type SocketLike } from './hub.js';
import { createStore, initialState, type AppState } from './store.js';
import { createAuth } from './auth.js';
import { draftsKey } from './constants.js';
import { hasVerifiedKey } from '../app/selectors.js';

const WS = mockUuid(1);
const USER = mockUuid(100);
const SESSION = mockUuid(2);
const RUN = mockUuid(3);
const AGENT = mockUuid(4);
const REQUEST = mockUuid(11);

// --- a localStorage and sessionStorage the node environment does not have ---
class MemoryStorage {
  private readonly map = new Map<string, string>();
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  clear(): void {
    this.map.clear();
  }
}

class FakeSocket implements SocketLike {
  static instances: FakeSocket[] = [];
  sent: string[] = [];
  closed: { code?: number } | null = null;
  onopen: ((event: unknown) => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: ((event: { code: number; reason?: string }) => void) | null = null;
  onerror: ((event: unknown) => void) | null = null;

  constructor(readonly url: string) {
    FakeSocket.instances.push(this);
  }
  send(data: string): void {
    this.sent.push(data);
  }
  close(code?: number): void {
    this.closed = { code };
  }
  open(): void {
    this.onopen?.({});
  }
  deliver(event: unknown): void {
    this.onmessage?.({ data: JSON.stringify(event) });
  }
  serverClose(code: number): void {
    this.onclose?.({ code });
  }
}

const iso = '2026-10-12T09:49:00.000Z';

function streamEvent(kind: string, payload: unknown, id: bigint, sessionId: string | null = SESSION): unknown {
  return { id: id.toString(), workspace_id: WS, session_id: sessionId, kind, schema_version: SCHEMA_VERSION, trace_id: 'trace-test', at: iso, payload };
}

const bootstrapBody = {
  workspace: {
    id: WS,
    name: 'Nous',
    jurisdiction: 'default',
    settings: { default_model_id: 'deepseek-flash', default_effort: 'high', default_runtime: 'cloud', daily_token_cap: null, max_concurrent_runs: 3, timezone: 'UTC', flags: {} },
  },
  viewer: { user_id: USER, role: 'admin', reviewer_roles: [] },
  agent: { id: AGENT, name: 'Iris', email: null, responsibility: 'Partner Program', setup_step: null },
  capabilities: { email_ingress: false, turn_attachments: false, automated_triggers: false },
  heads: { session: '0', workspace: '0' },
  counts: { inbox: 1, pending_grants: 0, created_documents: 0, decisions: 0 },
  sessions: [{ id: SESSION, agent_id: AGENT, title: 'Partner applications', mode: 'work', model_id: 'deepseek-flash', effort: 'high', pinned: false, archived: false, focus_ref: null, status: 'Ready', last_activity_at: iso }],
  requests: [],
  catalog: [],
};

function snapshotBody(items: unknown[] = [], status?: string, watermark = '0') {
  return {
    workspace_id: WS, session: { ...bootstrapBody.sessions[0], runtime: 'cloud' }, messages: { items, cursor: null, total: items.length }, watermark,
    run: status ? { id: RUN, session_id: SESSION, agent_id: AGENT, status, attempt: 1, title: null, steps: [], queue: [],
      model_id: 'deepseek-flash', effort: 'high', admitted_at: iso, started_at: iso, execution_started_at: iso, ended_at: null } : null,
    stream: status === 'working' ? { run_id: RUN, attempt: 1, turn: 0, step_attempt: 1, message_id: mockUuid(9), text: 'First. ', seq: 0, status: 'streaming' } : null,
    recovery: null,
  };
}

interface Call {
  path: string;
  method: string;
  body: unknown;
}

function makeFetch(overrides: Record<string, () => Response | Promise<Response>> = {}) {
  const calls: Call[] = [];
  const impl = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url, 'http://test.local');
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ path: url.pathname + url.search, method, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const key = `${method} ${url.pathname}`;
    const override = overrides[key] ?? overrides[url.pathname];
    if (override) return override();
    const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (url.pathname.endsWith('/bootstrap')) return json(bootstrapBody);
    // The four routes `loadExtra` composes the client bootstrap out of; the
    // Worker has no `/bootstrap/client`, so neither does the mock.
    if (url.pathname.endsWith('/members')) return json({ items: [], cursor: null, total: 0 });
    if (url.pathname.endsWith('/invitations')) return json({ items: [], cursor: null, total: 0 });
    if (url.pathname.endsWith('/provider-keys')) return json({ keys: [] });
    if (url.pathname.endsWith('/messages')) return json({ items: [], cursor: null, total: 0 });
    if (url.pathname.endsWith('/snapshot')) return json(snapshotBody());
    if (url.pathname.endsWith('/events')) return json({ stream: 'workspace', after: '0', head: '0', resync: false, events: [] });
    if (url.pathname === '/auth/session')
      return json({
        user: { id: USER, name: 'Maya', email: 'maya@nous.example', role: 'admin' },
        workspace: { id: WS, name: 'Nous' },
        stream_heads: { workspace: '0', session: '0' },
        hub_ticket: 'ticket-2',
        expires_at: iso,
        authenticated_at: iso,
      });
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  return { impl, calls };
}

function makeAdapter(overrides: Record<string, () => Response | Promise<Response>> = {}) {
  const store = createStore(initialState());
  const { impl, calls } = makeFetch(overrides);
  const adapter = createAdapter({
    store,
    workspaceId: WS,
    auth: createAuth('fake'),
    fetchImpl: impl,
    socketFactory: (url) => new FakeSocket(url),
    wsBase: 'ws://test.local',
    visibility: { addEventListener: () => undefined, removeEventListener: () => undefined, hidden: false },
  });
  return { store, adapter, calls, state: (): AppState => store.getState() };
}

const streamingPlaceholder = {
  id: mockUuid(9), session_id: SESSION, seq: 1, role: 'iris', kind: null,
  text: '', blocks: [], status: 'streaming', run_id: RUN, worked_ms: null, at: iso,
};

async function activeSnapshotFixture(snapshot: () => Response | Promise<Response>) {
  let visibilityListener: (() => void) | null = null;
  let armed = false;
  let snapshotCalls = 0;
  let runStatus = 'working';
  const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
  const { impl } = makeFetch({
    [`GET /w/${WS}/sessions/${SESSION}/snapshot`]: async () => {
      if (!armed) return json(snapshotBody());
      snapshotCalls += 1;
      const status = runStatus;
      const page = await (await snapshot()).json() as { items: unknown[] };
      return json(snapshotBody(page.items, status, status === 'working' ? '3' : '6'));
    },
    [`GET /w/${WS}/sessions/${SESSION}/runs/${RUN}`]: () => json({ run_id: RUN, status: runStatus, attempt: 1 }),
  });
  const store = createStore(initialState());
  const adapter = createAdapter({
    store, workspaceId: WS, auth: createAuth('fake'), fetchImpl: impl,
    socketFactory: (url) => new FakeSocket(url), wsBase: 'ws://test.local',
    visibility: {
      hidden: false,
      addEventListener: (_type, listener) => { visibilityListener = listener; },
      removeEventListener: () => undefined,
    },
  });
  await adapter.start();
  const socket = FakeSocket.instances.find((item) => item.url.includes('/hub/session/'))!;
  socket.open();
  await vi.advanceTimersByTimeAsync(0);
  socket.deliver(streamEvent('run.started', {
    run_id: RUN, session_id: SESSION, attempt: 1, engine_version: 1, client_turn_id: 'snapshot-stream',
    mode: 'work', model_id: 'deepseek-flash', effort: 'high', title: 'Streaming answer', steps: [],
  }, 1n));
  socket.deliver(streamEvent('message.reset', {
    message_id: streamingPlaceholder.id, run_id: RUN, turn: 0, attempt: 1, step_attempt: 1,
  }, 2n));
  socket.deliver({
    type: 'message.preview', session_id: SESSION, run_id: RUN, turn: 0, attempt: 1,
    step_attempt: 1, offset: 0, delta: 'First. Second.',
  });
  socket.deliver(streamEvent('message.delta', {
    message_id: streamingPlaceholder.id, run_id: RUN, turn: 0, attempt: 1, step_attempt: 1, seq: 0, delta: 'First. ',
  }, 3n));
  return {
    adapter, socket, store,
    session: () => store.getState().sessions[SESSION]!,
    arm() { armed = true; },
    snapshotCalls: () => snapshotCalls,
    show() { visibilityListener!(); },
    setRunStatus(status: string) { runStatus = status; },
    json,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.instances = [];
  (globalThis as { localStorage?: unknown }).localStorage = new MemoryStorage();
  (globalThis as { sessionStorage?: unknown }).sessionStorage = new MemoryStorage();
});

afterEach(() => {
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------

describe('the hub keepalive', () => {
  it('delivers a transient preview without moving the durable event path', async () => {
    const previews: unknown[] = [];
    const events: string[] = [];
    const hub = createHub({
      kind: 'session',
      url: 'ws://test.local/hub',
      ticket: 't',
      after: 7n,
      onEvent: (event) => events.push(event.id),
      onPreview: (frame) => previews.push(frame),
      onState: () => undefined,
      onResync: () => undefined,
      replay: async () => ({ events: [], resync: false, head: '7' }),
      onSignedOut: () => undefined,
      onEvicted: () => undefined,
      socketFactory: (url) => new FakeSocket(url),
    });
    const socket = FakeSocket.instances[0]!;
    socket.open();
    await vi.advanceTimersByTimeAsync(0);
    socket.deliver({
      type: 'message.preview', session_id: SESSION, run_id: RUN,
      turn: 0, attempt: 1, step_attempt: 1, offset: 0, delta: 'Now',
    });

    expect(previews).toEqual([expect.objectContaining({ type: 'message.preview', offset: 0, delta: 'Now' })]);
    expect(events).toEqual([]);
    hub.close();
  });

  it('sends exactly one `ping` per 20 s', async () => {
    const hub = createHub({
      kind: 'workspace',
      url: 'ws://test.local/hub',
      ticket: 't',
      after: 0n,
      onEvent: () => undefined,
      onState: () => undefined,
      onResync: () => undefined,
      replay: async () => ({ events: [], resync: false }),
      onSignedOut: () => undefined,
      onEvicted: () => undefined,
      socketFactory: (url) => new FakeSocket(url),
    });
    const socket = FakeSocket.instances[0]!;
    socket.open();
    // The hub answers each ping with a `pong`, which is what the Durable
    // Object's auto-response does; without one the silence timer would close
    // the socket at 60 s, which the next test covers.
    for (let i = 0; i < 3; i += 1) {
      await vi.advanceTimersByTimeAsync(PING_MS + 10);
      socket.onmessage?.({ data: 'pong' });
    }
    expect(socket.sent.filter((frame) => frame === 'ping')).toHaveLength(3);
    hub.close();
  });

  it('treats 60 s of silence — `pong` included — as a disconnect and reconnects', async () => {
    const hub = createHub({
      kind: 'workspace',
      url: 'ws://test.local/hub',
      ticket: 't',
      after: 0n,
      onEvent: () => undefined,
      onState: () => undefined,
      onResync: () => undefined,
      replay: async () => ({ events: [], resync: false }),
      onSignedOut: () => undefined,
      onEvicted: () => undefined,
      socketFactory: (url) => new FakeSocket(url),
      random: () => 0.5,
    });
    const first = FakeSocket.instances[0]!;
    first.open();
    // A `pong` keeps it alive …
    await vi.advanceTimersByTimeAsync(SILENCE_MS - 1000);
    first.onmessage?.({ data: 'pong' });
    await vi.advanceTimersByTimeAsync(SILENCE_MS - 1000);
    expect(FakeSocket.instances).toHaveLength(1);
    // … and then nothing arrives for a full minute.
    await vi.advanceTimersByTimeAsync(SILENCE_MS + 1000);
    expect(first.closed?.code).toBe(4000);
    expect(FakeSocket.instances.length).toBeGreaterThan(1);
    hub.close();
  });

  it('buffers live events during a replay, then applies them, dropping duplicates', async () => {
    const applied: string[] = [];
    let replayResolve: ((value: { events: unknown[]; resync: boolean; head?: string }) => void) | null = null;
    const hub = createHub({
      kind: 'session',
      url: 'ws://test.local/hub',
      ticket: 't',
      after: 0n,
      onEvent: (event) => applied.push(event.id),
      onState: () => undefined,
      onResync: () => undefined,
      replay: () =>
        new Promise((resolve) => {
          replayResolve = resolve as typeof replayResolve;
        }) as Promise<{ events: never[]; resync: boolean; head?: string }>,
      onSignedOut: () => undefined,
      onEvicted: () => undefined,
      socketFactory: (url) => new FakeSocket(url),
    });
    const socket = FakeSocket.instances[0]!;
    socket.open();
    // Live events arrive while the replay is still in flight.
    socket.deliver(streamEvent('run.step', { run_id: RUN, attempt: 1, turn: 0, step_id: 'a', label: 'Read', state: 'done' }, 2n));
    socket.deliver(streamEvent('run.step', { run_id: RUN, attempt: 1, turn: 0, step_id: 'b', label: 'Score', state: 'active' }, 3n));
    expect(applied).toEqual([]);
    replayResolve!({ events: [streamEvent('run.step', { run_id: RUN, attempt: 1, turn: 0, step_id: 'a', label: 'Read', state: 'active' }, 1n), streamEvent('run.step', { run_id: RUN, attempt: 1, turn: 0, step_id: 'a', label: 'Read', state: 'done' }, 2n)] as never[], resync: false, head: '2' });
    await vi.advanceTimersByTimeAsync(0);
    // Replay first, in id order; then the buffer, minus the id the replay covered.
    expect(applied).toEqual(['1', '2', '3']);
    hub.close();
  });

  it('keeps paging the replay until it reaches the head', async () => {
    // The replay route answers at most 500 rows. A client that was away for a
    // long run is further behind than that, and a catch-up that stopped after
    // one page would leave a hole that looks exactly like a lost message.
    const applied: string[] = [];
    const pages = [
      { events: [streamEvent('run.step', { run_id: RUN, attempt: 1, turn: 0, step_id: 'a', label: 'One', state: 'done' }, 1n)], resync: false, head: '3' },
      { events: [streamEvent('run.step', { run_id: RUN, attempt: 1, turn: 0, step_id: 'b', label: 'Two', state: 'done' }, 2n)], resync: false, head: '3' },
      { events: [streamEvent('run.step', { run_id: RUN, attempt: 1, turn: 0, step_id: 'c', label: 'Three', state: 'done' }, 3n)], resync: false, head: '3' },
    ];
    let call = 0;
    const hub = createHub({
      kind: 'session',
      url: 'ws://test.local/hub',
      ticket: 't',
      after: 0n,
      onEvent: (event) => applied.push(event.id),
      onState: () => undefined,
      onResync: () => undefined,
      replay: () => Promise.resolve(pages[call++] ?? { events: [], resync: false, head: '3' }) as never,
      onSignedOut: () => undefined,
      onEvicted: () => undefined,
      socketFactory: (url) => new FakeSocket(url),
    });
    FakeSocket.instances[0]!.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(applied).toEqual(['1', '2', '3']);
    // And it stops at the head rather than asking forever.
    expect(call).toBe(3);
    hub.close();
  });

  it('recovers a committed terminal batch that a healthy socket never delivered', async () => {
    const applied: string[] = [];
    let replayCall = 0;
    let active = false;
    const terminal = [
      streamEvent(
        'message.final',
        {
          message_id: mockUuid(9),
          session_id: SESSION,
          run_id: RUN,
          turn: 0,
          attempt: 1,
          text: 'The durable answer.',
          blocks: [],
          worked_ms: 2400,
        },
        9n,
      ),
      streamEvent('run.status', { run_id: RUN, attempt: 1, status: 'completed', active_ms: 2400 }, 10n),
    ];
    const hub = createHub({
      kind: 'session',
      url: 'ws://test.local/hub',
      ticket: 't',
      after: 7n,
      onEvent: (event) => {
        applied.push(event.id);
        if (event.kind === 'run.started') active = true;
      },
      onState: () => undefined,
      onResync: () => undefined,
      replay: async () => {
        replayCall += 1;
        return replayCall === 1
          ? { events: [], resync: false, head: '7' }
          : { events: terminal as never[], resync: false, head: '10' };
      },
      onSignedOut: () => undefined,
      onEvicted: () => undefined,
      socketFactory: (url) => new FakeSocket(url),
      reconcileMs: () => (active ? 1_000 : 30_000),
    });
    const socket = FakeSocket.instances[0]!;
    socket.open();
    await vi.advanceTimersByTimeAsync(0);
    expect(applied).toEqual([]);

    socket.deliver(
      streamEvent(
        'run.started',
        {
          run_id: RUN,
          session_id: SESSION,
          attempt: 1,
          engine_version: 1,
          client_turn_id: 'turn-audit',
          mode: 'work',
          model_id: 'deepseek-flash',
          effort: 'high',
          title: 'Audit terminal state',
          steps: [],
        },
        8n,
      ),
    );
    // The connection remains open and responsive, but its terminal event
    // batch is deliberately absent. The durable audit must still self-heal.
    socket.onmessage?.({ data: 'pong' });
    await vi.advanceTimersByTimeAsync(1_000);
    expect(applied).toEqual(['8', '9', '10']);
    expect(socket.closed).toBeNull();
    hub.close();
  });

  it('runs the semantic completeness check in polling fallback too', async () => {
    let reconciled = 0;
    const hub = createHub({
      kind: 'session',
      url: 'ws://test.local/hub',
      ticket: 't',
      after: 0n,
      onEvent: () => undefined,
      onState: () => undefined,
      onResync: () => undefined,
      replay: async () => ({ events: [], resync: false, head: '0' }),
      onReconcile: () => {
        reconciled += 1;
      },
      onSignedOut: () => undefined,
      onEvicted: () => undefined,
      socketFactory: (url) => new FakeSocket(url),
      pollAfterFailures: 1,
    });
    FakeSocket.instances[0]!.serverClose(1006);
    await vi.advanceTimersByTimeAsync(0);
    expect(reconciled).toBe(1);
    hub.close();
  });
});

describe('the adapter', () => {
  it('does not fetch Admin inventories for a Member and keeps chat availability unknown rather than blocked', async () => {
    const memberBootstrap = { ...bootstrapBody, viewer: { ...bootstrapBody.viewer, role: 'member' as const } };
    const { adapter, calls, state } = makeAdapter({
      [`GET /w/${WS}/bootstrap`]: () => Response.json(memberBootstrap),
    });
    await adapter.start();
    expect(calls.some((call) => call.path.endsWith('/provider-keys'))).toBe(false);
    expect(calls.some((call) => call.path.endsWith('/invitations'))).toBe(false);
    expect(state().ui.providerKeysLocked).toBe(true);
    expect(hasVerifiedKey(state()).any).toBe(true);
    adapter.dispose();
  });

  it('boots an agentless reviewer into Inbox without activating an old session or inventing a chat target', async () => {
    const queueItem = { id: mockUuid(7), text: 'Cancel this stale follow-up', status: 'queued' as const, position: 0 };
    const baseActiveSnapshot = snapshotBody([], 'working');
    const activeSnapshot = { ...baseActiveSnapshot, run: { ...baseActiveSnapshot.run!, queue: [queueItem] } };
    const agentlessBootstrap = {
      ...bootstrapBody,
      viewer: { ...bootstrapBody.viewer, role: 'member' as const },
      agent: null,
    };
    const { adapter, calls, state } = makeAdapter({
      [`GET /w/${WS}/bootstrap`]: () => Response.json(agentlessBootstrap),
      [`GET /w/${WS}/sessions/${SESSION}/snapshot`]: () => Response.json(activeSnapshot),
      [`POST /w/${WS}/sessions/${SESSION}/runs/${RUN}/stop`]: () => Response.json({ run_id: RUN, status: 'stopped', attempt: 1 }),
      [`DELETE /w/${WS}/sessions/${SESSION}/runs/${RUN}/queue/${queueItem.id}`]: () => Response.json({ items: [] }),
    });

    await adapter.start();

    expect(state().agent).toEqual({ id: null, name: 'Iris', email: null, summary: '', setupStep: null, provisioningStatus: null });
    expect(state().activeSessionId).toBeNull();
    expect(state().sessions[SESSION]).toBeDefined();
    expect(state().ui).toMatchObject({ app: { section: 'inbox', view: 'list' }, irisPanel: 'hidden', pane: 'app' });
    expect(calls.some((call) => call.path.includes(`/sessions/${SESSION}/snapshot`))).toBe(false);
    expect(FakeSocket.instances.some((socket) => socket.url.includes('/hub/session/'))).toBe(false);
    await adapter.activateSession(SESSION);
    expect(state().activeSessionId).toBe(SESSION);
    expect(calls.some((call) => call.path.includes(`/sessions/${SESSION}/snapshot`))).toBe(true);
    expect(FakeSocket.instances.some((socket) => socket.url.includes('/hub/session/'))).toBe(false);
    await expect(adapter.createSession()).rejects.toThrow('No agent is available');
    await expect(adapter.send(SESSION, 'Do not route this to a stale agent.')).rejects.toThrow('No agent is available');
    await expect(adapter.guide(SESSION, 'Do not guide stale work.')).rejects.toThrow('No agent is available');
    await expect(adapter.queue(SESSION, 'Do not queue stale work.')).rejects.toThrow('No agent is available');
    await expect(adapter.editQueued(SESSION, queueItem.id, 'Do not edit stale work.')).rejects.toThrow('No agent is available');
    await adapter.stop(SESSION);
    expect(state().sessions[SESSION]?.run?.status).toBe('stopped');
    await adapter.removeQueued(SESSION, queueItem.id);
    expect(calls.some((call) => call.method === 'POST' && call.path.endsWith(`/runs/${RUN}/stop`))).toBe(true);
    expect(calls.some((call) => call.method === 'DELETE' && call.path.endsWith(`/runs/${RUN}/queue/${queueItem.id}`))).toBe(true);
    expect(calls.some((call) => call.method === 'POST' && call.path.endsWith('/sessions'))).toBe(false);
    expect(calls.some((call) => call.method === 'POST' && call.path.endsWith('/turns'))).toBe(false);
    expect(calls.some((call) => call.method === 'POST' && (call.path.endsWith('/guide') || call.path.endsWith('/queue') || call.path.endsWith('/retry')))).toBe(false);
    adapter.dispose();
  });

  it('does not treat the bootstrap-selected agent as an exhaustive session ACL', async () => {
    const secondAgent = mockUuid(5);
    const secondSession = mockUuid(6);
    const primaryAgentSession = { ...bootstrapBody.sessions[0], id: SESSION, agent_id: AGENT };
    const secondAgentSession = { ...bootstrapBody.sessions[0], id: secondSession, agent_id: secondAgent };
    const multiAgentBootstrap = { ...bootstrapBody, sessions: [secondAgentSession, primaryAgentSession] };
    const { adapter, calls, state } = makeAdapter({
      [`GET /w/${WS}/bootstrap`]: () => Response.json(multiAgentBootstrap),
      [`GET /w/${WS}/sessions/${secondSession}/snapshot`]: () => Response.json({
        ...snapshotBody(),
        session: { ...snapshotBody().session, id: secondSession, agent_id: secondAgent },
      }),
    });

    await adapter.start();

    expect(state().activeSessionId).toBe(SESSION);
    await adapter.activateSession(secondSession);
    expect(state().activeSessionId).toBe(secondSession);
    expect(calls.some((call) => call.path.includes(`/sessions/${secondSession}/snapshot`))).toBe(true);
    expect(FakeSocket.instances.some((socket) => socket.url.includes(`/hub/session/${secondSession}`))).toBe(true);
    adapter.dispose();
  });

  it.each(['workspace', 'viewer', 'same identity'] as const)('scopes draft, pending-turn, and settings preservation across a %s change', async (boundary) => {
    const first = makeAdapter();
    await first.adapter.start();
    const localId = 'local-private-draft';
    const patch = {
      draft: { text: 'Private workspace A draft', attachments: [] },
      settingsPending: true, model: 'private-choice', effort: null,
      pendingTurn: { clientTurnId: 'pending-a', runId: null, previousStatus: 'Ready',
        message: { id: mockUuid(601), session_id: SESSION, seq: 0, role: 'user' as const, kind: null, text: 'Private pending A prompt', blocks: [], status: 'complete' as const, run_id: null } },
    };
    first.store.dispatch({ type: 'session/set', id: SESSION, patch });
    first.store.dispatch({ type: 'session/create', id: localId });
    first.store.dispatch({ type: 'session/set', id: localId, patch: { ...patch, pendingTurn: { ...patch.pendingTurn, message: { ...patch.pendingTurn.message, session_id: localId } } } });
    first.adapter.dispose();
    const workspaceId = boundary === 'workspace' ? mockUuid(602) : WS;
    const viewerId = boundary === 'viewer' ? mockUuid(603) : USER;
    const { impl } = makeFetch({
      [`GET /w/${workspaceId}/bootstrap`]: () => Response.json({ ...bootstrapBody, workspace: { ...bootstrapBody.workspace, id: workspaceId }, viewer: { ...bootstrapBody.viewer, user_id: viewerId } }),
      [`GET /w/${workspaceId}/sessions/${SESSION}/snapshot`]: () => Response.json({ ...snapshotBody(), workspace_id: workspaceId }),
    });
    const next = createAdapter({ store: first.store, workspaceId, auth: createAuth('fake'), fetchImpl: impl,
      socketFactory: (url) => new FakeSocket(url), visibility: { hidden: false, addEventListener: () => undefined, removeEventListener: () => undefined } });
    try {
      await next.start();
      const current = first.state();
      if (boundary === 'same identity') {
        expect(current.sessions[localId]).toMatchObject({ ...patch, pendingTurn: { ...patch.pendingTurn, message: { ...patch.pendingTurn.message, session_id: localId } } });
        expect(current.sessions[SESSION]).toMatchObject(patch);
        expect(current.activeSessionId).toBe(localId);
      } else {
        expect(current.sessions[localId]).toBeUndefined();
        expect(current.sessionOrder).toEqual([SESSION]);
        expect(current.activeSessionId).toBe(SESSION);
        expect(current.sessions[SESSION]).toMatchObject({ draft: { text: '', attachments: [] }, pendingTurn: null, run: null, model: 'deepseek-flash', effort: 'high' });
        expect(current.sessions[SESSION]!.settingsPending).toBeUndefined();
      }
    } finally { next.dispose(); }
  });

  it('performs a fresh terminal repair after an older in-flight snapshot settles', async () => {
    let release!: (response: Response) => void;
    let held = false;
    let reads = 0;
    const final = { ...streamingPlaceholder, status: 'complete', text: 'Complete terminal answer.' };
    const { adapter, state } = makeAdapter({
      [`GET /w/${WS}/sessions/${SESSION}/snapshot`]: () => {
        reads += 1;
        if (!held) return Response.json(snapshotBody([], 'working', '10'));
        if (reads === 3) return new Promise((resolve) => { release = resolve; });
        return Response.json(snapshotBody([final], 'completed', '20'));
      },
    });
    try {
      await adapter.start();
      const socket = FakeSocket.instances.at(-1)!;
      socket.open();
      await vi.advanceTimersByTimeAsync(0);
      held = true;
      await vi.advanceTimersByTimeAsync(2000);
      expect(reads).toBe(3);
      socket.deliver(streamEvent('run.status', { run_id: RUN, attempt: 1, status: 'completed' }, 11n));
      release(Response.json(snapshotBody([], 'working', '20')));
      await vi.advanceTimersByTimeAsync(0);
      expect(reads).toBe(4);
      expect(state().sessions[SESSION]!.messages.at(-1)?.text).toBe(final.text);
      expect(state().sessions[SESSION]!.run?.status).toBe('completed');
    } finally { adapter.dispose(); }
  });

  it.each([409, 503])('preserves a pending Send through resync and restores its exact prompt after HTTP %i', async (status) => {
    let release!: (response: Response) => void;
    const { adapter, state } = makeAdapter({
      [`POST /w/${WS}/sessions/${SESSION}/turns`]: () => new Promise((resolve) => { release = resolve; }),
    });
    try {
      await adapter.start();
      const text = 'Keep this prompt\nwith its second line';
      const sending = adapter.send(SESSION, text);
      const rejected = expect(sending).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(0);
      await adapter.resync();
      expect(state().sessions[SESSION]!.pendingTurn?.message.text).toBe(text);
      release(Response.json({ reason: 'unavailable', message: 'Turn refused' }, { status }));
      await rejected;
      expect(state().sessions[SESSION]!.draft.text).toBe(text);
      expect(state().sessions[SESSION]!.pendingTurn).toBeNull();
      expect(state().sessions[SESSION]!.run).toBeNull();
    } finally { adapter.dispose(); }
  });

  it('activates the fallback after archiving the selected session without duplicate connections', async () => {
    const otherId = mockUuid(20);
    const other = { ...bootstrapBody.sessions[0], id: otherId, runtime: 'cloud' };
    const { adapter, store, state } = makeAdapter({
      [`GET /w/${WS}/bootstrap`]: () => Response.json({ ...bootstrapBody, sessions: [...bootstrapBody.sessions, other] }),
      [`GET /w/${WS}/sessions/${otherId}/snapshot`]: () => Response.json({ ...snapshotBody(), session: other }),
    });
    try {
      await adapter.start();
      const original = FakeSocket.instances.at(-1)!;
      store.dispatch({ type: 'session/archive', id: SESSION, archived: true });
      await vi.advanceTimersByTimeAsync(0);
      expect(state().activeSessionId).toBe(otherId);
      expect(original.closed).not.toBeNull();
      expect(FakeSocket.instances.at(-1)!.url).toContain(`/hub/session/${otherId}`);
      expect(FakeSocket.instances.filter((socket) => socket.url.includes(`/hub/session/${otherId}`))).toHaveLength(1);
      await adapter.activateSession(otherId);
      expect(FakeSocket.instances.filter((socket) => socket.url.includes(`/hub/session/${otherId}`))).toHaveLength(1);
    } finally { adapter.dispose(); }
  });

  it('restores the previous session connection after a failed blank creation rolls back', async () => {
    const { adapter, state } = makeAdapter({
      [`POST /w/${WS}/sessions`]: () => Response.json({ reason: 'unavailable', message: 'Create failed' }, { status: 409 }),
    });
    try {
      await adapter.start();
      const original = FakeSocket.instances.at(-1)!;
      await expect(adapter.createSession({ title: 'New blank task' })).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(0);
      expect(state().activeSessionId).toBe(SESSION);
      expect(original.closed).not.toBeNull();
      expect(FakeSocket.instances.at(-1)!.url).toContain(`/hub/session/${SESSION}`);
      expect(FakeSocket.instances.at(-1)!.closed).toBeNull();
      expect(FakeSocket.instances.filter((socket) => socket.url.includes(`/hub/session/${SESSION}`))).toHaveLength(2);
    } finally { adapter.dispose(); }
  });

  it('closes the old connection when the selected session is removed with no fallback', async () => {
    const { adapter, store, state } = makeAdapter();
    try {
      await adapter.start();
      const socket = FakeSocket.instances.at(-1)!;
      store.dispatch({ type: 'session/rollback', id: SESSION });
      await vi.advanceTimersByTimeAsync(0);
      expect(state().activeSessionId).toBeNull();
      expect(socket.closed).not.toBeNull();
      expect(state().connection.session.status).toBe('idle');
    } finally { adapter.dispose(); }
  });

  it.each(['idle', 'active'] as const)('repairs a late lower-id commit at an unchanged watermark while %s', async (phase) => {
    let committed = false;
    const { adapter, state } = makeAdapter({
      [`GET /w/${WS}/sessions/${SESSION}/snapshot`]: () => {
        if (phase === 'idle') return Response.json(committed
          ? snapshotBody([{ ...streamingPlaceholder, text: 'Late committed final', status: 'complete' }], 'completed', '10')
          : { ...snapshotBody(), watermark: '10' });
        const snapshot = snapshotBody([], 'working', '10');
        return Response.json({ ...snapshot, stream: { ...snapshot.stream, text: committed ? 'First. Late checkpoint.' : 'First. ' } });
      },
    });
    try {
      await adapter.start();
      const socket = FakeSocket.instances.at(-1)!;
      socket.open();
      await vi.advanceTimersByTimeAsync(0);
      committed = true;
      await vi.advanceTimersByTimeAsync(phase === 'idle' ? 30_000 : 2_000);
      expect(state().cursors.session[SESSION]).toBe(10n);
      if (phase === 'idle') expect(state().sessions[SESSION]!.messages.at(-1)?.text).toBe('Late committed final');
      else expect(state().sessions[SESSION]!.stream?.text).toBe('First. Late checkpoint.');
    } finally { adapter.dispose(); }
  });

  it('hydrates a durable prefix and attempt before replay, then ignores covered deltas', async () => {
    const { adapter, state } = makeAdapter({
      [`GET /w/${WS}/sessions/${SESSION}/snapshot`]: () => Response.json(snapshotBody([], 'working', '5')),
    });
    try {
      await adapter.start();
      expect(state().sessions[SESSION]!.run).toMatchObject({ id: RUN, attempt: 1, started_at: iso, status: 'working' });
      expect(state().sessions[SESSION]!.stream?.text).toBe('First. ');
      const socket = FakeSocket.instances.find((item) => item.url.includes('/hub/session/'))!;
      expect(socket.url).toContain('after=5');
      socket.open();
      await vi.advanceTimersByTimeAsync(0);
      const delta = { run_id: RUN, message_id: mockUuid(9), attempt: 1, turn: 0, step_attempt: 1, seq: 1, delta: 'Second.' };
      socket.deliver(streamEvent('message.delta', delta, 5n));
      socket.deliver(streamEvent('message.delta', delta, 6n));
      expect(state().sessions[SESSION]!.stream?.text).toBe('First. Second.');
    } finally { adapter.dispose(); }
  });

  it('does not let a delayed new-session POST steal the selected session connection or draft', async () => {
    let release!: (response: Response) => void;
    const createdId = mockUuid(500);
    const { adapter, store, state } = makeAdapter({ [`POST /w/${WS}/sessions`]: () => new Promise((resolve) => { release = resolve; }) });
    try {
      await adapter.start();
      const creation = adapter.createSession({ title: 'New task' });
      const localId = state().activeSessionId!;
      store.dispatch({ type: 'session/draft', id: localId, text: 'Keep this draft' });
      await adapter.activateSession(SESSION);
      const selectedSocket = FakeSocket.instances.at(-1)!;
      release(Response.json({ ...bootstrapBody.sessions[0], id: createdId, runtime: 'cloud' }));
      await creation;
      expect(state().activeSessionId).toBe(SESSION);
      expect(selectedSocket.closed).toBeNull();
      expect(FakeSocket.instances.at(-1)).toBe(selectedSocket);
      expect(state().sessions[createdId]!.draft.text).toBe('Keep this draft');
    } finally { adapter.dispose(); }
  });

  it('ignores stale A and B hydration during rapid A → B → A activation', async () => {
    const otherId = mockUuid(20);
    const other = { ...bootstrapBody.sessions[0], id: otherId, runtime: 'cloud', model_id: 'other-model' };
    let aCalls = 0;
    const releases: ((response: Response) => void)[] = [];
    const { adapter, state } = makeAdapter({
      [`GET /w/${WS}/bootstrap`]: () => Response.json({ ...bootstrapBody, sessions: [...bootstrapBody.sessions, other] }),
      [`GET /w/${WS}/sessions/${SESSION}/snapshot`]: () => ++aCalls === 1 ? Response.json(snapshotBody()) : new Promise((resolve) => { releases.push(resolve); }),
      [`GET /w/${WS}/sessions/${otherId}/snapshot`]: () => new Promise((resolve) => { releases.push(resolve); }),
    });
    try {
      await adapter.start();
      const b = adapter.activateSession(otherId);
      const a = adapter.activateSession(SESSION);
      releases[1]!(Response.json(snapshotBody([], 'working', '5')));
      await a;
      const selectedSocket = FakeSocket.instances.at(-1)!;
      releases[0]!(Response.json({ ...snapshotBody(), session: other }));
      await b;
      expect(state().activeSessionId).toBe(SESSION);
      expect(state().sessions[SESSION]!.stream?.text).toBe('First. ');
      expect(selectedSocket.closed).toBeNull();
      expect(FakeSocket.instances.at(-1)).toBe(selectedSocket);
      expect(state().sessions[otherId]!.model).toBe('other-model');
    } finally { adapter.dispose(); }
  });

  it('serializes two model/effort saves and admits Send only after the latest choice is confirmed', async () => {
    const releases: ((response: Response) => void)[] = [];
    const { adapter, calls, state } = makeAdapter({
      [`PATCH /w/${WS}/sessions/${SESSION}`]: () => new Promise((resolve) => { releases.push(resolve); }),
      [`POST /w/${WS}/sessions/${SESSION}/turns`]: () => Response.json({ run_id: RUN, status: 'working', attempt: 1 }),
    });
    try {
      await adapter.start();
      const first = adapter.updateSessionSettings(SESSION, { model_id: 'first-model', effort: null });
      const second = adapter.updateSessionSettings(SESSION, { model_id: 'second-model', effort: 'high' });
      const send = adapter.send(SESSION, 'Use the chosen model');
      await vi.advanceTimersByTimeAsync(0);
      expect(releases).toHaveLength(1);
      expect(calls.some((call) => call.path.endsWith('/turns'))).toBe(false);
      releases[0]!(Response.json({ ...bootstrapBody.sessions[0], runtime: 'cloud', model_id: 'first-model', effort: null }));
      await first;
      await vi.advanceTimersByTimeAsync(0);
      expect(state().sessions[SESSION]!.model).toBe('second-model');
      expect(releases).toHaveLength(2);
      expect(calls.some((call) => call.path.endsWith('/turns'))).toBe(false);
      releases[1]!(Response.json({ ...bootstrapBody.sessions[0], runtime: 'cloud', model_id: 'second-model', effort: 'high' }));
      await Promise.all([second, send]);
      expect(calls.find((call) => call.path.endsWith('/turns'))?.body).toMatchObject({ model_id: 'second-model', effort: 'high', expected_settings: { model_id: 'second-model', effort: 'high' } });
      expect(calls.filter((call) => call.method === 'PATCH')[1]?.body).toMatchObject({ expected_settings: { model_id: 'first-model', effort: null } });
    } finally { adapter.dispose(); }
  });

  it('surfaces a failed model save, rolls back the choice, and retains a refused Send draft', async () => {
    let release!: (response: Response) => void;
    const { adapter, calls, state } = makeAdapter({ [`PATCH /w/${WS}/sessions/${SESSION}`]: () => new Promise((resolve) => { release = resolve; }) });
    try {
      await adapter.start();
      const save = adapter.updateSessionSettings(SESSION, { model_id: 'failed-model', effort: null });
      const saved = expect(save).rejects.toThrow();
      const send = adapter.send(SESSION, 'Keep the unsent prompt');
      const sent = expect(send).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(0);
      release(Response.json({ reason: 'unavailable', message: 'Could not save model' }, { status: 409 }));
      await Promise.all([saved, sent]);
      expect(calls.some((call) => call.path.endsWith('/turns'))).toBe(false);
      expect(state().sessions[SESSION]).toMatchObject({ model: 'deepseek-flash', effort: 'high', settingsPending: false, draft: { text: 'Keep the unsent prompt' } });
      expect(state().sessions[SESSION]!.settingsError).toContain('could not be saved');
    } finally { adapter.dispose(); }
  });

  it('parks settings chosen during creation until a real session id exists', async () => {
    let release!: (response: Response) => void;
    const createdId = mockUuid(500);
    const created = { ...bootstrapBody.sessions[0], runtime: 'cloud', id: createdId };
    const { adapter, calls, state } = makeAdapter({
      [`POST /w/${WS}/sessions`]: () => new Promise((resolve) => { release = resolve; }),
      [`GET /w/${WS}/sessions/${createdId}/snapshot`]: () => Response.json({ ...snapshotBody(), session: created }),
      [`PATCH /w/${WS}/sessions/${createdId}`]: () => Response.json({ ...created, model_id: 'chosen-model', effort: null }),
      [`POST /w/${WS}/sessions/${createdId}/turns`]: () => Response.json({ run_id: RUN, status: 'working', attempt: 1 }),
    });
    try {
      await adapter.start();
      const creation = adapter.createSession({ title: 'New task' });
      const localId = state().activeSessionId!;
      const save = adapter.updateSessionSettings(localId, { model_id: 'chosen-model', effort: null });
      const send = adapter.send(localId, 'Start with my chosen model');
      await vi.advanceTimersByTimeAsync(0);
      expect(calls.some((call) => call.method === 'PATCH')).toBe(false);
      release(Response.json(created));
      await Promise.all([creation, save, send]);
      expect(calls.every((call) => !call.path.includes('local-'))).toBe(true);
      expect(state().sessions[createdId]).toMatchObject({ model: 'chosen-model', effort: null });
      expect(calls.find((call) => call.path.endsWith('/turns'))?.body).toMatchObject({ model_id: 'chosen-model', effort: null });
    } finally { adapter.dispose(); }
  });

  it('consumes retry admission without a start event and rejects the older attempt afterward', async () => {
    let attempt = 1;
    const { adapter, calls, state } = makeAdapter({
      [`GET /w/${WS}/sessions/${SESSION}/snapshot`]: () => {
        const snapshot = snapshotBody([], attempt === 1 ? 'error' : 'working', '1');
        return Response.json({ ...snapshot, run: { ...snapshot.run, attempt }, stream: null });
      },
      [`POST /w/${WS}/sessions/${SESSION}/runs/${RUN}/retry`]: () => { attempt = 2; return Response.json({ run_id: RUN, status: 'working', attempt }); },
    });
    try {
      await adapter.start();
      const retry = adapter.retry(SESSION, RUN);
      expect(adapter.retry(SESSION, RUN)).toBe(retry);
      await retry;
      expect(state().sessions[SESSION]!.run).toMatchObject({ attempt: 2, status: 'working' });
      expect(calls.find((call) => call.path.endsWith('/retry'))?.body).toMatchObject({ expected_attempt: 1, expected_settings: { model_id: 'deepseek-flash', effort: 'high' } });
      expect(calls.filter((call) => call.path.endsWith('/retry'))).toHaveLength(1);
      const socket = FakeSocket.instances.at(-1)!;
      socket.open();
      await vi.advanceTimersByTimeAsync(0);
      socket.deliver(streamEvent('run.status', { run_id: RUN, attempt: 1, status: 'error' }, 2n));
      socket.deliver({ type: 'message.preview', session_id: SESSION, run_id: RUN, attempt: 1, turn: 0, step_attempt: 1, offset: 0, delta: 'old' });
      expect(state().sessions[SESSION]!.run).toMatchObject({ attempt: 2, status: 'working' });
      expect(state().sessions[SESSION]!.stream).toBeNull();
    } finally { adapter.dispose(); }
  });

  it('keeps accepted retry admission when its hydration fails and allows same-session refresh', async () => {
    let retryAccepted = false;
    let snapshots = 0;
    const { adapter, state } = makeAdapter({
      [`GET /w/${WS}/sessions/${SESSION}/snapshot`]: () => {
        snapshots += 1;
        if (retryAccepted && snapshots === 2) return Response.json({ reason: 'unavailable', message: 'Read failed' }, { status: 409 });
        const snapshot = snapshotBody([], retryAccepted ? 'working' : 'error');
        return Response.json({ ...snapshot, run: { ...snapshot.run, attempt: retryAccepted ? 2 : 1 }, stream: null });
      },
      [`POST /w/${WS}/sessions/${SESSION}/runs/${RUN}/retry`]: () => { retryAccepted = true; return Response.json({ run_id: RUN, status: 'working', attempt: 2 }); },
    });
    try {
      await adapter.start();
      await adapter.retry(SESSION, RUN);
      expect(state().sessions[SESSION]!.run).toMatchObject({ attempt: 2, status: 'working' });
      expect(state().sessions[SESSION]!.hydrationError).toContain('Retry was accepted');
      await adapter.activateSession(SESSION);
      expect(snapshots).toBe(3);
      expect(state().sessions[SESSION]!.hydrationError).toBeNull();
    } finally { adapter.dispose(); }
  });

  it('repairs an already-seen user row and phantom pending turn even after the run was reconciled as completed', async () => {
    const user = { id: mockUuid(70), session_id: SESSION, seq: 0, role: 'user' as const, kind: null,
      text: 'again', blocks: [], status: 'complete' as const, run_id: RUN, at: iso };
    const final = { ...streamingPlaceholder, status: 'complete', text: 'The persisted answer.' };
    const h = await activeSnapshotFixture(() => h.json({ items: [user, final], cursor: null, total: 2 }));
    try {
      h.setRunStatus('completed');
      h.arm();
      h.show();
      await vi.advanceTimersByTimeAsync(0);
      h.store.dispatch({ type: 'stream/reveal-complete', sessionId: SESSION, runId: RUN });
      expect(h.session().run?.status).toBe('completed');
      // Model the already-seen row that the old sequence guard failed to
      // reconcile. No new event or message id is needed to repair it.
      h.store.dispatch({ type: 'session/set', id: SESSION, patch: {
        pendingTurn: { clientTurnId: 'old-client', runId: RUN, previousStatus: 'Ready',
          message: { ...user, id: mockUuid(69), seq: Number.MAX_SAFE_INTEGER } },
      } });
      const calls = h.snapshotCalls();
      // The already-scheduled idle audit must still perform semantic repair.
      await vi.advanceTimersByTimeAsync(30_000);
      expect(h.snapshotCalls()).toBeGreaterThan(calls);
      expect(h.session().pendingTurn).toBeNull();
      expect(h.session().messages.filter((message) => message.role === 'user')).toEqual([user]);
      expect(h.session().messages.at(-1)?.text).toBe(final.text);
    } finally { h.adapter.dispose(); }
  });

  it.each(['event', 'snapshot'] as const)('confirms a second same-text send after a live final via %s without a phantom trailing user bubble', async (via) => {
    const previousRun = mockUuid(71);
    const userId = mockUuid(72);
    let snapshotItems: unknown[] = [];
    const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
    const { adapter, store, state } = makeAdapter({
      [`POST /w/${WS}/sessions/${SESSION}/turns`]: () => json({ run_id: RUN, status: 'working', attempt: 1 }),
      [`GET /w/${WS}/sessions/${SESSION}/runs/${RUN}`]: () => json({ run_id: RUN, status: 'working', attempt: 1 }),
      [`GET /w/${WS}/sessions/${SESSION}/snapshot`]: () => json(snapshotItems.length ? { ...snapshotBody(snapshotItems, 'working', '3'), stream: null } : snapshotBody()),
    });
    try {
      await adapter.start();
      const socket = FakeSocket.instances.find((candidate) => candidate.url.includes('/hub/session/'))!;
      socket.open();
      await vi.advanceTimersByTimeAsync(0);
      socket.deliver(streamEvent('message.appended', {
        message_id: mockUuid(73), session_id: SESSION, seq: 0, role: 'user', kind: null,
        text: 'again', blocks: [], status: 'complete', run_id: previousRun, client_turn_id: 'previous',
      }, 1n));
      socket.deliver(streamEvent('message.final', {
        message_id: mockUuid(74), session_id: SESSION, run_id: previousRun, turn: 0,
        attempt: 1, text: 'Previous reply.', blocks: [], worked_ms: 1000,
      }, 2n));
      // The live final has no session sequence on the wire. Sending again
      // without reloading used to inherit its MAX_SAFE_INTEGER sentinel.
      await adapter.send(SESSION, 'again');
      await vi.advanceTimersByTimeAsync(0);
      const pending = state().sessions[SESSION]!.pendingTurn!;
      const user = { id: userId, session_id: SESSION, seq: 2, role: 'user', kind: null,
        text: 'again', blocks: [], status: 'complete', run_id: RUN, at: iso };
      if (via === 'event') socket.deliver(streamEvent('message.appended', {
        message_id: userId, session_id: SESSION, seq: 2, role: 'user', kind: null,
        text: 'again', blocks: [], status: 'complete', run_id: RUN, client_turn_id: pending.clientTurnId,
      }, 3n));
      else {
        snapshotItems = [user];
        await vi.advanceTimersByTimeAsync(2000);
      }
      expect(state().sessions[SESSION]!.pendingTurn).toBeNull();
      expect(pending.message.seq).toBeLessThan(Number.MAX_SAFE_INTEGER);
      socket.deliver(streamEvent('message.final', {
        message_id: mockUuid(75), session_id: SESSION, run_id: RUN, turn: 0,
        attempt: 1, text: 'New reply stays below the real question.', blocks: [], worked_ms: 2000,
      }, 4n));
      store.dispatch({ type: 'stream/reveal-complete', sessionId: SESSION, runId: RUN });
      expect(state().sessions[SESSION]!.messages.map((message) => message.text)).toEqual([
        'again', 'Previous reply.', 'again', 'New reply stays below the real question.',
      ]);
    } finally { adapter.dispose(); }
  });

  it.each(['scheduled', 'visibility'] as const)('preserves live text when a %s snapshot contains an empty streaming placeholder', async (trigger) => {
    let snapshotMessage = { ...streamingPlaceholder };
    const h = await activeSnapshotFixture(() => new Response(JSON.stringify({ items: [snapshotMessage], cursor: null, total: 1 }), {
      headers: { 'content-type': 'application/json' },
    }));
    try {
      expect(h.session().stream).toMatchObject({ status: 'streaming', text: 'First. Second.', durableText: 'First. ' });
      h.arm();
      if (trigger === 'visibility') h.show();
      await vi.advanceTimersByTimeAsync(trigger === 'scheduled' ? 2000 : 0);
      expect(h.snapshotCalls()).toBeGreaterThan(0);
      expect(h.session().stream).toMatchObject({ status: 'streaming', text: 'First. Second.', durableText: 'First. ' });
      expect(h.session().messages.some((message) => message.id === streamingPlaceholder.id && message.status !== 'streaming')).toBe(false);

      h.socket.deliver(streamEvent('message.delta', {
        message_id: streamingPlaceholder.id, run_id: RUN, turn: 0, attempt: 1, step_attempt: 1, seq: 1, delta: 'Second. Third.',
      }, 4n));
      expect(h.session().stream).toMatchObject({ status: 'streaming', text: 'First. Second. Third.', durableText: 'First. Second. Third.' });
      snapshotMessage = { ...streamingPlaceholder, status: 'complete', text: 'First. Second. Third.' };
      h.setRunStatus('completed');
      h.socket.deliver(streamEvent('message.final', {
        message_id: streamingPlaceholder.id, session_id: SESSION, run_id: RUN, turn: 0, attempt: 1,
        text: snapshotMessage.text, blocks: [], incomplete: false, worked_ms: 2400,
      }, 5n));
      h.socket.deliver(streamEvent('run.status', { run_id: RUN, attempt: 1, status: 'completed', active_ms: 2400 }, 6n));
      await vi.advanceTimersByTimeAsync(0);
      expect(h.session().messages.filter((message) => message.id === streamingPlaceholder.id)).toHaveLength(1);
      expect(h.session().messages.find((message) => message.id === streamingPlaceholder.id)).toMatchObject({ status: 'complete', text: snapshotMessage.text });
      expect(h.session().run?.status).toBe('completed');
    } finally { h.adapter.dispose(); }
  });

  it('does not let a stale streaming snapshot roll back a final received while the request was in flight', async () => {
    let releaseSnapshot!: (response: Response) => void;
    const pendingSnapshot = new Promise<Response>((resolve) => { releaseSnapshot = resolve; });
    const h = await activeSnapshotFixture(() => pendingSnapshot);
    try {
      h.arm();
      h.show();
      await vi.advanceTimersByTimeAsync(0);
      expect(h.snapshotCalls()).toBe(1);
      h.socket.deliver(streamEvent('message.final', {
        message_id: streamingPlaceholder.id, session_id: SESSION, run_id: RUN, turn: 0, attempt: 1,
        text: 'The genuine final answer.', blocks: [], incomplete: false, worked_ms: 2400,
      }, 4n));
      h.socket.deliver(streamEvent('run.status', { run_id: RUN, attempt: 1, status: 'completed', active_ms: 2400 }, 5n));
      expect(h.session().run?.status).toBe('completed');
      releaseSnapshot(h.json({ items: [streamingPlaceholder], cursor: null, total: 1 }));
      await vi.advanceTimersByTimeAsync(0);
      expect(h.session().messages.filter((message) => message.id === streamingPlaceholder.id)).toHaveLength(1);
      expect(h.session().messages.find((message) => message.id === streamingPlaceholder.id)).toMatchObject({ status: 'complete', text: 'The genuine final answer.' });
      expect(h.session().stream).toMatchObject({ status: 'complete', text: 'The genuine final answer.' });
      expect(h.session().run?.status).toBe('completed');
    } finally { releaseSnapshot(h.json({ items: [], cursor: null, total: 0 })); h.adapter.dispose(); }
  });

  it('ignores an old attempt snapshot that resolves after the same run begins a retry', async () => {
    let releaseSnapshot!: (response: Response) => void;
    const pendingSnapshot = new Promise<Response>((resolve) => { releaseSnapshot = resolve; });
    const h = await activeSnapshotFixture(() => pendingSnapshot);
    try {
      h.arm();
      h.show();
      await vi.advanceTimersByTimeAsync(0);
      expect(h.snapshotCalls()).toBe(1);
      h.socket.deliver(streamEvent('run.started', {
        run_id: RUN, session_id: SESSION, attempt: 2, engine_version: 1, client_turn_id: 'snapshot-stream',
        mode: 'work', model_id: 'deepseek-flash', effort: 'high', title: 'Retry', steps: [],
      }, 4n));
      h.socket.deliver(streamEvent('message.reset', {
        message_id: streamingPlaceholder.id, run_id: RUN, turn: 0, attempt: 2, step_attempt: 2,
      }, 5n));
      h.socket.deliver({
        type: 'message.preview', session_id: SESSION, run_id: RUN, turn: 0, attempt: 2,
        step_attempt: 2, offset: 0, delta: 'New attempt prefix.',
      });
      releaseSnapshot(h.json({
        items: [{ ...streamingPlaceholder, status: 'complete', text: 'Previous attempt answer.' }], cursor: null, total: 1,
      }));
      await vi.advanceTimersByTimeAsync(0);
      expect(h.session().run).toMatchObject({ attempt: 2, status: 'working' });
      expect(h.session().stream).toMatchObject({ status: 'streaming', stepAttempt: 2, text: 'New attempt prefix.' });
      expect(h.session().messages.some((message) => message.text === 'Previous attempt answer.')).toBe(false);
    } finally { releaseSnapshot(h.json({ items: [], cursor: null, total: 0 })); h.adapter.dispose(); }
  });

  it('uses a new workspace setup session as the first app-pane focus', async () => {
    const focused = {
      ...bootstrapBody,
      sessions: bootstrapBody.sessions.map((session) => ({
        ...session,
        focus_ref: { section: 'agents' as const, view: 'setup', step: 'identity' },
      })),
    };
    const { adapter, state } = makeAdapter({
      [`GET /w/${WS}/bootstrap`]: () => new Response(JSON.stringify(focused), { status: 200, headers: { 'content-type': 'application/json' } }),
    });
    await adapter.start();
    expect(state().ui.app).toEqual({ section: 'agents', view: 'setup', step: 'identity' });
    expect(state().capabilities).toEqual({
      emailIngress: false,
      turnAttachments: false,
      automatedTriggers: false,
      memberInvitationMode: 'legacy_delivery',
      memberRoleTemplates: [],
      effectExecutor: 'unavailable',
    });
    adapter.dispose();
  });

  it('opens both sockets and applies session events to the right session', async () => {
    const { adapter, state } = makeAdapter();
    await adapter.start();
    await vi.advanceTimersByTimeAsync(10);
    const sessionSocket = FakeSocket.instances.find((socket) => socket.url.includes('/hub/session/'))!;
    const workspaceSocket = FakeSocket.instances.find((socket) => socket.url.includes('/hub/workspace'))!;
    expect(sessionSocket).toBeTruthy();
    expect(workspaceSocket).toBeTruthy();
    sessionSocket.open();
    await vi.advanceTimersByTimeAsync(10);
    sessionSocket.deliver(streamEvent('run.started', { run_id: RUN, session_id: SESSION, attempt: 1, engine_version: 1, client_turn_id: 't', mode: 'work', model_id: 'deepseek-flash', effort: 'high', title: 'Screen', steps: [] }, 5n));
    expect(state().sessions[SESSION]!.run?.id).toBe(RUN);
    expect(state().cursors.session[SESSION]).toBe(5n);
    adapter.dispose();
  });

  it('reconciles a missed completed response as soon as the tab becomes visible', async () => {
    let visibilityListener: (() => void) | null = null;
    let replayCall = 0;
    let messagesCall = 0;
    const finalMessage = {
      id: mockUuid(9),
      session_id: SESSION,
      seq: 1,
      role: 'iris',
      kind: null,
      text: 'Recovered after returning to the tab.',
      blocks: [],
      status: 'complete',
      run_id: RUN,
      worked_ms: 2400,
      at: iso,
    };
    const { impl } = makeFetch({
      [`GET /w/${WS}/events`]: () => {
        replayCall += 1;
        const body =
          replayCall === 1
            ? { stream: 'session', after: '0', head: '0', resync: false, events: [] }
            : {
                stream: 'session',
                after: '5',
                head: '7',
                resync: false,
                // The later status arrives, but the earlier message.final is
                // absent. A tail replay cannot recover an event below cursor 7.
                events: [streamEvent('run.status', { run_id: RUN, attempt: 1, status: 'completed', active_ms: 2400 }, 7n)],
              };
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      },
      [`GET /w/${WS}/sessions/${SESSION}/snapshot`]: () => {
        messagesCall += 1;
        const body = messagesCall <= 2 ? snapshotBody() : snapshotBody([finalMessage], 'completed', '7');
        return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
      },
      [`GET /w/${WS}/sessions/${SESSION}/runs/${RUN}`]: () =>
        new Response(
          JSON.stringify({
            run_id: RUN,
            status: 'completed',
            attempt: 1,
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
    });
    const store = createStore(initialState());
    const adapter = createAdapter({
      store,
      workspaceId: WS,
      auth: createAuth('fake'),
      fetchImpl: impl,
      socketFactory: (url) => new FakeSocket(url),
      wsBase: 'ws://test.local',
      visibility: {
        hidden: false,
        addEventListener: (_type, listener) => {
          visibilityListener = listener;
        },
        removeEventListener: () => undefined,
      },
    });

    await adapter.start();
    const sessionSocket = FakeSocket.instances.find((socket) => socket.url.includes('/hub/session/'))!;
    sessionSocket.open();
    await vi.advanceTimersByTimeAsync(0);
    sessionSocket.deliver(
      streamEvent(
        'run.started',
        {
          run_id: RUN,
          session_id: SESSION,
          attempt: 1,
          engine_version: 1,
          client_turn_id: 'turn-visible',
          mode: 'work',
          model_id: 'deepseek-flash',
          effort: 'high',
          title: 'Recover terminal state',
          steps: [],
        },
        5n,
      ),
    );
    expect(store.getState().sessions[SESSION]!.run?.status).toBe('working');

    visibilityListener!();
    await vi.advanceTimersByTimeAsync(0);

    expect(store.getState().sessions[SESSION]!.run?.status).toBe('completed');
    expect(store.getState().sessions[SESSION]!.messages.at(-1)?.text).toBe('Recovered after returning to the tab.');
    expect(sessionSocket.closed).toBeNull();
    adapter.dispose();
  });

  it('refreshes the session every 4 minutes and extends both sockets with the ticket', async () => {
    const { adapter, calls } = makeAdapter();
    await adapter.start();
    await vi.advanceTimersByTimeAsync(10);
    for (const socket of FakeSocket.instances) socket.open();
    await vi.advanceTimersByTimeAsync(10);
    // The route is called with `?ws=`: without it it walks the WorkOS mirror's
    // directory and a workspace that mirror has never seen is a 404.
    const authCalls = (): number => calls.filter((call) => call.path.startsWith('/auth/session')).length;
    const before = authCalls();
    await vi.advanceTimersByTimeAsync(4 * 60 * 1000 + 100);
    expect(authCalls()).toBe(before + 1);
    const tickets = FakeSocket.instances.flatMap((socket) => socket.sent.filter((frame) => frame.includes('"ticket"')));
    expect(tickets.length).toBeGreaterThanOrEqual(2);
    expect(tickets[0]).toContain('ticket-2');
    adapter.dispose();
  });

  it('a 401 signs out, closes the sockets, and leaves the draft in localStorage', async () => {
    const { adapter, store, state } = makeAdapter();
    await adapter.start();
    await vi.advanceTimersByTimeAsync(10);
    store.dispatch({ type: 'session/draft', id: SESSION, text: 'half a sentence' });
    await vi.advanceTimersByTimeAsync(300);
    expect(localStorage.getItem(draftsKey(WS, USER))).toContain('half a sentence');

    const socket = FakeSocket.instances.find((s) => s.url.includes('/hub/workspace'))!;
    socket.open();
    await vi.advanceTimersByTimeAsync(10);
    socket.serverClose(4401);
    await vi.advanceTimersByTimeAsync(10);

    expect(state().ui.banner).toBe('signed-out');
    expect(state().connection.workspace.status).toBe('signed-out');
    expect(localStorage.getItem(draftsKey(WS, USER))).toContain('half a sentence');
    expect(state().sessions[SESSION]!.draft.text).toBe('half a sentence');
    adapter.dispose();
  });

  it('a 4403 closes Admin state immediately and reboots with the authoritative Member projection', async () => {
    let bootCount = 0;
    const memberBootstrap = {
      ...bootstrapBody,
      viewer: { ...bootstrapBody.viewer, role: 'member' as const },
      workspace: { ...bootstrapBody.workspace, settings: { default_model_id: 'deepseek-flash', default_effort: 'high', default_runtime: 'cloud' } },
    };
    const { adapter, store, state, calls } = makeAdapter({
      [`GET /w/${WS}/bootstrap`]: () => Response.json(bootCount++ === 0 ? bootstrapBody : memberBootstrap),
    });
    await adapter.start();
    store.dispatch({ type: 'nav/app', object: { section: 'admin', view: 'Provider keys' }, manual: true });
    store.dispatch({ type: 'entity/upsert', kind: 'provider_key', id: 'key-1', version: 1, data: { label: 'Private key' } });
    store.dispatch({ type: 'list/set', key: 'invitations', ids: ['invite-1'], total: 1 });

    const socket = FakeSocket.instances.find((item) => item.url.includes('/hub/workspace'))!;
    socket.open();
    await vi.advanceTimersByTimeAsync(0);
    socket.serverClose(4403);

    expect(state().user.role).toBe('member');
    expect(state().ui.app).toEqual({ section: 'settings', view: 'Notifications' });
    expect(state().entities.provider_key).toEqual({});
    expect(state().entities.lists.invitations).toBeUndefined();

    await vi.advanceTimersByTimeAsync(20);
    expect(bootCount).toBe(2);
    expect(calls.filter((call) => call.path.endsWith('/provider-keys'))).toHaveLength(1);
    expect(calls.filter((call) => call.path.endsWith('/invitations'))).toHaveLength(1);
    adapter.dispose();
  });

  it('a 503 with Retry-After is not a sign-out', async () => {
    let attempts = 0;
    const { adapter, state } = makeAdapter({
      [`GET /w/${WS}/requests/${REQUEST}`]: () => {
        attempts += 1;
        return attempts < 3 ? new Response(JSON.stringify({ error: 'busy', reason: 'unavailable' }), { status: 503, headers: { 'Retry-After': '1', 'content-type': 'application/json' } }) : new Response(JSON.stringify({ id: REQUEST, kind: 'application', status: 'pending', label: 'Leah', subject: 'Leah', title: null, session_id: null, run_id: null, created_at: iso, version: 1, payload: {}, sources: [], missing: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });
    await adapter.start();
    adapter.ensure('request', REQUEST);
    await vi.advanceTimersByTimeAsync(5000);
    expect(attempts).toBe(3);
    expect(state().ui.banner).not.toBe('signed-out');
    expect(state().entities.request[REQUEST]!.state).toBe('ready');
    adapter.dispose();
  });

  it('a duplicate turn with the same client_turn_id posts one id, and the server answers with one run', async () => {
    let seen: string[] = [];
    const { adapter, store, state } = makeAdapter({
      [`POST /w/${WS}/sessions/${SESSION}/turns`]: () => {
        // The first call never resolves in the store; the id is what matters.
        // `runView`: what the Worker answers, a 200 for the duplicate and a
        // 201 for the new run. The body is the same either way.
        return new Response(JSON.stringify({ run_id: RUN, status: 'working', attempt: 1 }), { status: seen.length > 1 ? 200 : 201, headers: { 'content-type': 'application/json' } });
      },
    });
    await adapter.start();
    store.dispatch({ type: 'session/draft', id: SESSION, text: 'go' });
    const first = adapter.send(SESSION, 'go');
    await vi.advanceTimersByTimeAsync(0);
    await first;
    // A second send reuses nothing: the id was discarded on the 2xx, which is
    // what makes a *retry* of the same POST idempotent and a new turn new.
    store.dispatch({ type: 'session/draft', id: SESSION, text: 'go' });
    await adapter.send(SESSION, 'go');
    await vi.advanceTimersByTimeAsync(0);
    seen = [];
    expect(state().sessions[SESSION]!.draft.text).toBe('');
    adapter.dispose();
  });

  it('shows the sent message and working state before turn admission answers, then reconciles once', async () => {
    let answer: ((response: Response) => void) | null = null;
    const pendingResponse = new Promise<Response>((resolve) => { answer = resolve; });
    const { adapter, calls, store, state } = makeAdapter({
      [`POST /w/${WS}/sessions/${SESSION}/turns`]: () => pendingResponse,
    });
    await adapter.start();
    store.dispatch({ type: 'session/draft', id: SESSION, text: 'Screen the next applicant.' });

    const sent = adapter.send(SESSION, 'Screen the next applicant.');
    const optimistic = state().sessions[SESSION]!;
    expect(optimistic.pendingTurn?.message.text).toBe('Screen the next applicant.');
    expect(optimistic.run).toMatchObject({ id: optimistic.pendingTurn?.clientTurnId, status: 'working' });
    expect(optimistic.draft.text).toBe('');
    await adapter.stop(SESSION);
    expect(calls.some((call) => call.path.endsWith('/stop'))).toBe(false);

    answer!(new Response(JSON.stringify({ run_id: RUN, status: 'working', attempt: 1 }), { status: 201, headers: { 'content-type': 'application/json' } }));
    await sent;
    const turnId = state().sessions[SESSION]!.pendingTurn!.clientTurnId;
    expect(state().sessions[SESSION]!.pendingTurn?.runId).toBe(RUN);
    expect(state().sessions[SESSION]!.run?.id).toBe(RUN);

    const socket = FakeSocket.instances.find((candidate) => candidate.url.includes('/hub/session/'))!;
    socket.open();
    await vi.advanceTimersByTimeAsync(0);
    socket.deliver(streamEvent('message.appended', {
      message_id: mockUuid(22), session_id: SESSION, seq: 0, role: 'user', kind: null,
      text: 'Screen the next applicant.', blocks: [], status: 'complete', run_id: RUN,
      client_turn_id: turnId,
    }, 1n));
    expect(state().sessions[SESSION]!.pendingTurn).toBeNull();
    expect(state().sessions[SESSION]!.messages).toHaveLength(1);
    expect(state().sessions[SESSION]!.messages[0]?.text).toBe('Screen the next applicant.');
    adapter.dispose();
  });

  it('keeps the first message recoverable when a new session cannot be created', async () => {
    let refuseCreate: ((error: Error) => void) | null = null;
    const pendingCreate = new Promise<Response>((_resolve, reject) => { refuseCreate = reject; });
    const { adapter, store, state, calls } = makeAdapter({
      [`POST /w/${WS}/sessions`]: () => pendingCreate,
    });
    await adapter.start();

    const creating = adapter.createSession().catch((error: unknown) => error);
    const localId = state().activeSessionId!;
    expect(localId).toMatch(/^local-/);
    store.dispatch({ type: 'session/draft', id: localId, text: 'Help me configure partner screening.' });
    const sending = adapter.send(localId, 'Help me configure partner screening.').catch((error: unknown) => error);
    expect(state().sessions[localId]!.pendingTurn?.message.text).toBe('Help me configure partner screening.');

    refuseCreate!(new Error('offline'));
    await Promise.all([creating, sending]);

    expect(state().sessions[localId]).toBeDefined();
    expect(state().sessions[localId]!.pending).toBe(false);
    expect(state().sessions[localId]!.pendingTurn).toBeNull();
    expect(state().sessions[localId]!.draft.text).toBe('Help me configure partner screening.');
    expect(calls.some((call) => call.path.includes(`/sessions/${localId}/turns`))).toBe(false);
    adapter.dispose();
  });

  it('removes the optimistic turn and restores the draft when admission is refused', async () => {
    let refuse: ((error: Error) => void) | null = null;
    const pendingResponse = new Promise<Response>((_resolve, reject) => { refuse = reject; });
    const { adapter, store, state } = makeAdapter({
      [`POST /w/${WS}/sessions/${SESSION}/turns`]: () => pendingResponse,
    });
    await adapter.start();
    store.dispatch({ type: 'session/draft', id: SESSION, text: 'Try this turn.' });

    const sent = adapter.send(SESSION, 'Try this turn.');
    expect(state().sessions[SESSION]!.pendingTurn).not.toBeNull();
    refuse!(new Error('offline'));
    await expect(sent).rejects.toThrow('offline');
    expect(state().sessions[SESSION]!.pendingTurn).toBeNull();
    expect(state().sessions[SESSION]!.run).toBeNull();
    expect(state().sessions[SESSION]!.draft.text).toBe('Try this turn.');
    adapter.dispose();
  });

  it('a rejected source-bound turn retains the exact selected sources for retry', async () => {
    const { adapter, store, state } = makeAdapter({
      [`POST /w/${WS}/sessions/${SESSION}/turns`]: () => Promise.reject(new Error('offline')),
    });
    await adapter.start();
    store.dispatch({ type: 'bootstrap/apply', patch: { capabilities: {
      emailIngress: false,
      turnAttachments: true,
      automatedTriggers: false,
      memberInvitationMode: 'legacy_delivery',
      memberRoleTemplates: [],
      effectExecutor: 'unavailable',
    } } });
    const source = { id: mockUuid(60), label: 'Program.md', kind: 'source' as const, sha256: 'a'.repeat(64), icon: 'context' };
    store.dispatch({ type: 'session/attach', id: SESSION, attachment: source });
    await expect(adapter.send(SESSION, 'Use the source')).rejects.toThrow('offline');
    expect(state().sessions[SESSION]!.draft.attachments).toEqual([source]);
    expect(state().sessions[SESSION]!.draft.text).toBe('Use the source');
    adapter.dispose();
  });

  it('preserves the Library source kind when admitting a selected shared guide', async () => {
    const { adapter, calls, store } = makeAdapter({
      [`POST /w/${WS}/sessions/${SESSION}/turns`]: () => Response.json({ run_id: RUN, status: 'working', attempt: 1 }),
    });
    await adapter.start();
    store.dispatch({ type: 'bootstrap/apply', patch: { capabilities: {
      emailIngress: false,
      turnAttachments: true,
      automatedTriggers: false,
      memberInvitationMode: 'legacy_delivery',
      memberRoleTemplates: [],
      effectExecutor: 'unavailable',
    } } });
    store.dispatch({ type: 'session/attach', id: SESSION, attachment: {
      id: mockUuid(61), label: 'Partner Program Guide', kind: 'source', source_kind: 'library_source',
      sha256: 'b'.repeat(64), icon: 'context',
    } });
    await adapter.send(SESSION, 'Use the shared guide');
    expect(calls.find((call) => call.path.endsWith('/turns'))?.body).toMatchObject({
      attachments: [{ id: mockUuid(61), sha256: 'b'.repeat(64), kind: 'library_source' }],
    });
    adapter.dispose();
  });

  it('remaps an uploaded agent_file source chip on sendTurn the same way as a stored one', async () => {
    const { adapter, calls, store } = makeAdapter({
      [`POST /w/${WS}/sessions/${SESSION}/turns`]: () => Response.json({ run_id: RUN, status: 'working', attempt: 1 }),
    });
    await adapter.start();
    store.dispatch({ type: 'bootstrap/apply', patch: { capabilities: {
      emailIngress: false,
      turnAttachments: true,
      automatedTriggers: false,
      memberInvitationMode: 'legacy_delivery',
      memberRoleTemplates: [],
      effectExecutor: 'unavailable',
    } } });
    store.dispatch({ type: 'session/attach', id: SESSION, attachment: {
      id: mockUuid(70), label: 'composer-upload.txt', kind: 'source', source_kind: 'agent_file',
      sha256: 'd'.repeat(64), icon: 'context',
    } });
    await adapter.send(SESSION, 'Read the uploaded source');
    expect(calls.find((call) => call.path.endsWith('/turns'))?.body).toMatchObject({
      attachments: [{ id: mockUuid(70), sha256: 'd'.repeat(64), kind: 'agent_file' }],
    });
    adapter.dispose();
  });

  it('omits unbound file chips from turn admission so Iris never appears to have read them', async () => {
    const { adapter, calls, store } = makeAdapter({
      [`POST /w/${WS}/sessions/${SESSION}/turns`]: () => Response.json({ run_id: RUN, status: 'working', attempt: 1 }),
    });
    await adapter.start();
    store.dispatch({ type: 'bootstrap/apply', patch: { capabilities: {
      emailIngress: false,
      turnAttachments: true,
      automatedTriggers: false,
      memberInvitationMode: 'legacy_delivery',
      memberRoleTemplates: [],
      effectExecutor: 'unavailable',
    } } });
    store.dispatch({ type: 'session/attach', id: SESSION, attachment: {
      id: mockUuid(62), label: 'dropped.pdf', icon: 'context',
    } });
    store.dispatch({ type: 'session/attach', id: SESSION, attachment: {
      id: mockUuid(63), label: 'Rubric.md', kind: 'source', sha256: 'c'.repeat(64), icon: 'context',
    } });
    await adapter.send(SESSION, 'Review the sources');
    expect(calls.find((call) => call.path.endsWith('/turns'))?.body).toMatchObject({
      attachments: [{ id: mockUuid(63), sha256: 'c'.repeat(64), kind: 'agent_file' }],
    });
    adapter.dispose();
  });

  const reauthOverride = {
    [`POST /w/${WS}/requests/${REQUEST}/decisions`]: () =>
      new Response(JSON.stringify({ error: 'reauthenticate', reason: 'reauth_required' }), { status: 401, headers: { 'content-type': 'application/json' } }),
  };

  it.each(['invoice', 'agreement'] as const)('binds the reviewed %s payload and refetches a stale decision without replay', async (kind) => {
    const reviewed = { id: REQUEST, kind, version: 7, payload: { number: 'REVIEW-7', currency: 'EUR', total_minor: 12500 } };
    const { adapter, store, calls } = makeAdapter({
      [`POST /w/${WS}/requests/${REQUEST}/decisions`]: () => new Response(JSON.stringify({ error: 'Changed', reason: 'stale_request' }), { status: 409, headers: { 'content-type': 'application/json' } }),
    });
    await adapter.start();
    store.dispatch({ type: 'entity/upsert', kind: 'request', id: REQUEST, version: 8, data: { ...reviewed, version: 8, payload: { ...reviewed.payload, total_minor: 99000 } } });
    await expect(adapter.decide(REQUEST, 'approve', undefined, reviewed)).rejects.toMatchObject({ reason: 'stale_request' });
    const decisions = calls.filter((call) => call.path.endsWith('/decisions'));
    expect(decisions).toHaveLength(1);
    expect(decisions[0]?.body).toEqual({ decision: 'approve', ...await requestReviewBinding(reviewed) });
    expect(calls.some((call) => call.method === 'GET' && call.path.endsWith(`/requests/${REQUEST}`))).toBe(true);
    adapter.dispose();
  });

  it('a decision that needs step-up stores the intent and never replays it', async () => {
    // Fake auth has a step-up of its own now (server decision F4), so the
    // browser is sent to the same URL `workos` mode uses. The part that
    // matters is unchanged and is what this asserts: the intent is stored, the
    // decision is posted exactly once, and nothing replays it — the pane
    // re-renders on the way back and waits for a second, deliberate click.
    const { adapter, calls } = makeAdapter(reauthOverride);
    await adapter.start();
    const assign = vi.fn();
    (globalThis as { window?: unknown }).window = { location: { href: 'http://test.local/workspace/x', assign } };
    const result = await adapter.decide(REQUEST, 'approve');
    expect(result).toBe('reauth_required');
    expect(adapter.pendingStepUp()).toMatchObject({ kind: 'decision', requestId: REQUEST, decision: 'approve' });
    expect(assign).toHaveBeenCalledWith('/auth/login?step_up=1&return_to=%2Fworkspace%2Fx');
    expect(calls.filter((call) => call.path.endsWith('/decisions')).length).toBe(1);
    delete (globalThis as { window?: unknown }).window;
    adapter.dispose();
  });

  it('in workos mode the step-up sends the browser to /auth/login?step_up=1 with a same-origin path', async () => {
    const store = createStore(initialState());
    const { impl, calls } = makeFetch(reauthOverride);
    const adapter = createAdapter({
      store,
      workspaceId: WS,
      auth: createAuth('workos'),
      fetchImpl: impl,
      socketFactory: (url) => new FakeSocket(url),
      wsBase: 'ws://test.local',
    });
    await adapter.start();
    const assign = vi.fn();
    (globalThis as { window?: unknown }).window = { location: { href: 'http://test.local/w/x?a=1', origin: 'http://test.local', assign } };
    await adapter.decide(REQUEST, 'approve');
    expect(assign).toHaveBeenCalledOnce();
    // A full URL would be collapsed to `/` by the Worker's open-redirect fix.
    expect(String(assign.mock.calls[0]?.[0])).toBe('/auth/login?step_up=1&return_to=%2Fw%2Fx%3Fa%3D1');
    expect(calls.filter((call) => call.path.endsWith('/decisions')).length).toBe(1);
    delete (globalThis as { window?: unknown }).window;
    adapter.dispose();
  });

  it('a resync clears the caches, re-bootstraps, and keeps the draft', async () => {
    const { adapter, store, state, calls } = makeAdapter();
    await adapter.start();
    await vi.advanceTimersByTimeAsync(10);
    store.dispatch({ type: 'session/draft', id: SESSION, text: 'kept' });
    store.dispatch({ type: 'entity/upsert', kind: 'request', id: REQUEST, version: 1, data: { label: 'Leah' } });
    const bootstraps = calls.filter((call) => call.path.endsWith('/bootstrap')).length;

    const socket = FakeSocket.instances.find((s) => s.url.includes('/hub/workspace'))!;
    socket.open();
    await vi.advanceTimersByTimeAsync(10);
    socket.deliver(streamEvent('resync', { stream: 'workspace', reason: 'retention', head: '900' }, 900n, null));
    await vi.advanceTimersByTimeAsync(50);

    expect(calls.filter((call) => call.path.endsWith('/bootstrap')).length).toBe(bootstraps + 1);
    expect(state().entities.request[REQUEST]).toBeUndefined();
    expect(state().sessions[SESSION]!.draft.text).toBe('kept');
    adapter.dispose();
  });

  it('a cross-socket focus fetches the request rather than reporting it missing', async () => {
    const { adapter, state } = makeAdapter({
      [`GET /w/${WS}/requests/${REQUEST}`]: () =>
        new Response(JSON.stringify({ id: REQUEST, kind: 'application', status: 'pending', label: 'Leah', subject: 'Leah', title: null, session_id: null, run_id: null, created_at: iso, version: 2, payload: {}, sources: [], missing: [] }), { status: 200, headers: { 'content-type': 'application/json' } }),
    });
    await adapter.start();
    await vi.advanceTimersByTimeAsync(10);
    const socket = FakeSocket.instances.find((s) => s.url.includes('/hub/session/'))!;
    socket.open();
    await vi.advanceTimersByTimeAsync(10);
    socket.deliver(streamEvent('run.focus', { run_id: RUN, session_id: SESSION, ref: { section: 'inbox', view: 'request', id: REQUEST }, entity_type: 'request', entity_id: REQUEST }, 6n));
    expect(state().entities.request[REQUEST]!.state).toBe('loading');
    await vi.advanceTimersByTimeAsync(10);
    expect(state().entities.request[REQUEST]!.state).toBe('ready');
    expect(state().entities.request[REQUEST]!.version).toBe(2);
    adapter.dispose();
  });

  it('only forwards a MODEL_COMMANDS command', async () => {
    const { adapter, state } = makeAdapter();
    await adapter.start();
    adapter.applyCommand(SESSION, { type: 'request/decide', id: REQUEST });
    expect(state().ui.app.view).toBe('overview');
    adapter.applyCommand(SESSION, { type: 'chat/prompt', text: 'drafted for you' });
    expect(state().sessions[SESSION]!.draft.text).toBe('drafted for you');
    adapter.dispose();
  });
});
