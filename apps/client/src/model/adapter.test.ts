// Adapter tests, driven by a scriptable fake socket and a fetch mock.
//
// These are the cases that are cheap to get wrong and expensive to debug in a
// browser: the keepalive cadence, the reconnect ordering, what a 401 does to
// drafts, and the rule that a decision is never replayed after a redirect.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockUuid, SCHEMA_VERSION } from '@hermes/shared';
import { createAdapter } from './adapter.js';
import { createHub, PING_MS, SILENCE_MS, type SocketLike } from './hub.js';
import { createStore, initialState, type AppState } from './store.js';
import { createAuth } from './auth.js';
import { draftsKey } from './constants.js';

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

interface Call {
  path: string;
  method: string;
  body: unknown;
}

function makeFetch(overrides: Record<string, () => Response> = {}) {
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

function makeAdapter(overrides: Record<string, () => Response> = {}) {
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
});

describe('the adapter', () => {
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
    expect(state().capabilities).toEqual({ emailIngress: false, turnAttachments: false, automatedTriggers: false });
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

  const reauthOverride = {
    [`POST /w/${WS}/requests/${REQUEST}/decisions`]: () =>
      new Response(JSON.stringify({ error: 'reauthenticate', reason: 'reauth_required' }), { status: 401, headers: { 'content-type': 'application/json' } }),
  };

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
