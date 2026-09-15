// Reducer tests. The demo's store tests are ported, plus the cases the port
// introduced: the entity cache, the two cursors and `step_attempt`.
//
// Every test that involves a server event drives the store through
// `actionsFor(parseStreamEvent(...))`, so a schema change in the contract fails
// here rather than at runtime.
import { describe, expect, it } from 'vitest';
import { CTX, CTX_DEST, OV, parseStreamEvent, sameRef, SCHEMA_VERSION, mockUuid, mockRunStream, type StreamEvent } from '@hermes/shared';
import { parseRef, serialiseRef } from './routes.js';
import { actionsFor, createStore, initialState, reduce, type Action, type AppState, type SessionState } from './store.js';

const WS = mockUuid(1);
const SESSION_A = mockUuid(2);
const SESSION_B = mockUuid(21);
const RUN = mockUuid(3);
const MESSAGE = mockUuid(10);
const REQUEST = mockUuid(11);

function session(id: string, patch: Partial<SessionState> = {}): SessionState {
  return {
    id,
    title: 'Session',
    subtitle: null,
    mode: 'work',
    model: 'deepseek-flash',
    effort: 'high',
    runtime: 'cloud',
    pinned: false,
    archived: false,
    status: 'Ready',
    messages: [],
    oldestSeq: null,
    hasEarlier: false,
    draft: { text: '', attachments: [] },
    run: null,
    stream: null,
    focus: null,
    context: null,
    scrollTop: null,
    share: null,
    unread: false,
    pending: false,
    lastActivity: 0,
    carried: null,
    ...patch,
  };
}

function base(patch: Partial<AppState> = {}): AppState {
  const state = initialState();
  return {
    ...state,
    workspace: { id: WS, name: 'Nous', role: 'admin', jurisdiction: 'default' },
    user: { id: mockUuid(100), name: 'Maya', email: 'maya@nous.example', role: 'admin' },
    sessions: { [SESSION_A]: session(SESSION_A), [SESSION_B]: session(SESSION_B) },
    sessionOrder: [SESSION_A, SESSION_B],
    activeSessionId: SESSION_A,
    ...patch,
  };
}

const apply = (state: AppState, actions: Action[]): AppState => actions.reduce(reduce, state);

/** Feed one contract event through the same path the adapter uses. */
function feed(state: AppState, event: StreamEvent): AppState {
  return apply(state, actionsFor(event, state));
}

function event(kind: string, payload: unknown, id: bigint, sessionId: string | null = SESSION_A): StreamEvent {
  return parseStreamEvent({
    id: id.toString(),
    workspace_id: WS,
    session_id: sessionId,
    kind,
    schema_version: SCHEMA_VERSION,
    trace_id: 'trace-test',
    at: '2026-10-12T09:49:00.000Z',
    payload,
  });
}

// ---------------------------------------------------------------------------

describe('follow and pin', () => {
  it('manual navigation pins the view', () => {
    const state = apply(base(), [{ type: 'nav/app', object: CTX, manual: true }]);
    expect(state.ui.follow).toBe(false);
    expect(state.ui.pane).toBe('app');
  });

  it('navigating to the session focus does not pin', () => {
    const start = base({ sessions: { [SESSION_A]: session(SESSION_A, { focus: CTX }), [SESSION_B]: session(SESSION_B) } });
    const state = apply(start, [{ type: 'nav/app', object: CTX, manual: true }]);
    expect(state.ui.follow).toBe(true);
  });

  it('the CTX_DEST bug is fixed: `field` participates in sameRef', () => {
    expect(sameRef(CTX, CTX_DEST)).toBe(false);
    const start = base({ sessions: { [SESSION_A]: session(SESSION_A, { focus: CTX }), [SESSION_B]: session(SESSION_B) } });
    // Navigating from the blocker card to the destination field must pin.
    const state = apply(start, [{ type: 'nav/app', object: CTX_DEST, manual: true }]);
    expect(state.ui.follow).toBe(false);
  });

  it('a ref round-trips through the URL serialiser, `field` included', () => {
    expect(parseRef(`#${serialiseRef(CTX_DEST)}`)).toEqual(CTX_DEST);
    expect(parseRef(`#${serialiseRef(OV)}`)).toEqual(OV);
    const deep = { section: 'inbox' as const, view: 'request', id: REQUEST, sub: 'sources', step: 'two', field: 'line' };
    expect(parseRef(`#${serialiseRef(deep)}`)).toEqual(deep);
  });

  it('follow/resume returns to the session focus, and select restores follow', () => {
    const start = base({ sessions: { [SESSION_A]: session(SESSION_A, { focus: CTX }), [SESSION_B]: session(SESSION_B) } });
    const pinned = apply(start, [{ type: 'nav/app', object: OV, manual: true }]);
    expect(pinned.ui.follow).toBe(false);
    const resumed = reduce(pinned, { type: 'follow/resume' });
    expect(resumed.ui.follow).toBe(true);
    expect(resumed.ui.app).toEqual(CTX);
    const selected = reduce(pinned, { type: 'session/select', id: SESSION_B });
    expect(selected.ui.follow).toBe(true);
  });

  it('a focus event moves the app pane only for the active session while following', () => {
    const start = base();
    const other = feed(start, event('run.focus', { run_id: RUN, session_id: SESSION_B, ref: CTX, entity_type: null, entity_id: null }, 1n, SESSION_B));
    expect(other.ui.app).toEqual(OV);
    expect(other.sessions[SESSION_B]!.focus).toEqual(CTX);
    const mine = feed(start, event('run.focus', { run_id: RUN, session_id: SESSION_A, ref: CTX, entity_type: null, entity_id: null }, 1n));
    expect(mine.ui.app).toEqual(CTX);
  });
});

describe('sessions', () => {
  it('a run in one session never touches another', () => {
    const state = feed(base(), event('run.started', { run_id: RUN, session_id: SESSION_A, attempt: 1, engine_version: 1, client_turn_id: 't1', mode: 'work', model_id: 'deepseek-flash', effort: 'high', title: 'Screen', steps: [] }, 1n));
    expect(state.sessions[SESSION_A]!.run).not.toBeNull();
    expect(state.sessions[SESSION_B]!.run).toBeNull();
  });

  it('archiving the active session falls back to the next unarchived one', () => {
    const state = reduce(base(), { type: 'session/archive', id: SESSION_A, archived: true });
    expect(state.activeSessionId).toBe(SESSION_B);
  });

  it('an optimistic session is reconciled to the server id, and rolls back on failure', () => {
    const created = reduce(base(), { type: 'session/create', id: 'local-1' });
    expect(created.sessions['local-1']!.pending).toBe(true);
    const reconciled = reduce(created, { type: 'session/reconcile', localId: 'local-1', serverId: mockUuid(9) });
    expect(reconciled.sessions[mockUuid(9)]!.pending).toBe(false);
    expect(reconciled.sessions['local-1']).toBeUndefined();
    expect(reconciled.activeSessionId).toBe(mockUuid(9));
    const rolled = reduce(created, { type: 'session/rollback', id: 'local-1' });
    expect(rolled.sessions['local-1']).toBeUndefined();
    expect(rolled.activeSessionId).toBe(SESSION_A);
  });

  it('a message for an inactive session marks it unread rather than stealing the view', () => {
    const state = feed(base(), event('message.appended', { message_id: MESSAGE, session_id: SESSION_B, seq: 1, role: 'iris', kind: null, text: 'Receipt', blocks: [], status: 'complete', run_id: null }, 1n, SESSION_B));
    expect(state.sessions[SESSION_B]!.unread).toBe(true);
    expect(state.activeSessionId).toBe(SESSION_A);
  });
});

describe('the entity cache', () => {
  it('drops an upsert whose version is below the cached one', () => {
    let state = reduce(base(), { type: 'entity/upsert', kind: 'request', id: REQUEST, version: 5, data: { label: 'new' } });
    state = reduce(state, { type: 'entity/upsert', kind: 'request', id: REQUEST, version: 3, data: { label: 'stale' } });
    expect((state.entities.request[REQUEST]!.data as { label: string }).label).toBe('new');
    expect(state.entities.request[REQUEST]!.version).toBe(5);
  });

  it('a miss is `loading`, not `missing`', () => {
    const state = reduce(base(), { type: 'entity/loading', kind: 'request', id: REQUEST });
    expect(state.entities.request[REQUEST]!.state).toBe('loading');
  });

  it('`request.created` for an already cached id does not re-request it', () => {
    const cached = reduce(base(), { type: 'entity/upsert', kind: 'request', id: REQUEST, version: 2, data: { label: 'Leah' } });
    const actions = actionsFor(event('request.created', { request_id: REQUEST, kind: 'application', status: 'pending', label: 'Leah', run_id: null, session_id: null }, 2n, null), cached);
    expect(actions.some((action) => action.type === 'entity/loading')).toBe(false);
    const after = apply(cached, actions);
    expect((after.entities.request[REQUEST]!.data as { label: string }).label).toBe('Leah');
  });

  it('a cross-socket focus on an unknown request asks for it rather than reporting it missing', () => {
    const actions = actionsFor(event('run.focus', { run_id: RUN, session_id: SESSION_A, ref: { section: 'inbox', view: 'request', id: REQUEST }, entity_type: 'request', entity_id: REQUEST }, 3n), base());
    const loading = actions.find((action) => action.type === 'entity/loading');
    expect(loading).toMatchObject({ kind: 'request', id: REQUEST });
    const state = apply(base(), actions);
    expect(state.entities.request[REQUEST]!.state).toBe('loading');
    expect(state.entities.request[REQUEST]!.state).not.toBe('missing');
  });

  it('a decision is applied from the event; there is no client decide case', () => {
    const decided = feed(base({ counts: { inbox: 4, pendingGrants: 0, createdDocuments: 0, decisions: 0 } }), event('decision.recorded', { request_id: REQUEST, decision_id: mockUuid(70), decision: 'approve', resulting_status: 'admitted', decided_by: mockUuid(100), decided_at: '2026-10-12T09:50:00.000Z', effect_ids: [] }, 4n, null));
    expect(decided.counts.inbox).toBe(3);
    expect(decided.counts.decisions).toBe(1);
    expect(decided.entities.decision[mockUuid(70)]).toBeTruthy();
    // Reducing an unknown action is a no-op: `request/decide` does not exist.
    expect(reduce(decided, { type: 'request/decide' } as unknown as Action)).toBe(decided);
  });
});

describe('streaming text and step_attempt', () => {
  it('reset → deltas → reset → deltas → final leaves exactly one copy of the text', () => {
    let state = base();
    for (const streamEvent of mockRunStream('step_retry', { workspaceId: WS, sessionId: SESSION_A, runId: RUN })) state = feed(state, streamEvent);
    const messages = state.sessions[SESSION_A]!.messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]!.text).toBe('Leah scores 82 of 100. Customer impact is unverified.');
    // The accumulator is cleared by the final; the superseded attempt left nothing.
    expect(state.sessions[SESSION_A]!.stream).toBeNull();
  });

  it('a late delta from a superseded attempt is discarded', () => {
    let state = feed(base(), event('message.reset', { run_id: RUN, turn: 0, attempt: 1, step_attempt: 2, message_id: MESSAGE }, 1n));
    state = feed(state, event('message.delta', { message_id: MESSAGE, run_id: RUN, turn: 0, attempt: 1, step_attempt: 2, seq: 0, delta: 'good' }, 2n));
    state = feed(state, event('message.delta', { message_id: MESSAGE, run_id: RUN, turn: 0, attempt: 1, step_attempt: 1, seq: 9, delta: ' STALE' }, 3n));
    expect(state.sessions[SESSION_A]!.stream?.text).toBe('good');
  });

  it('a delta from a higher attempt is an implicit reset', () => {
    let state = feed(base(), event('message.reset', { run_id: RUN, turn: 0, attempt: 1, step_attempt: 1, message_id: MESSAGE }, 1n));
    state = feed(state, event('message.delta', { message_id: MESSAGE, run_id: RUN, turn: 0, attempt: 1, step_attempt: 1, seq: 0, delta: 'first' }, 2n));
    state = feed(state, event('message.delta', { message_id: MESSAGE, run_id: RUN, turn: 0, attempt: 1, step_attempt: 2, seq: 0, delta: 'second' }, 3n));
    expect(state.sessions[SESSION_A]!.stream?.text).toBe('second');
    expect(state.sessions[SESSION_A]!.stream?.stepAttempt).toBe(2);
  });

  it('`message.final {incomplete}` renders once and marks the message incomplete', () => {
    let state = feed(base(), event('message.reset', { run_id: RUN, turn: 0, attempt: 1, step_attempt: 1, message_id: MESSAGE }, 1n));
    const final = { message_id: MESSAGE, session_id: SESSION_A, run_id: RUN, turn: 0, attempt: 1, text: 'Partial answer', blocks: [], incomplete: true, worked_ms: 900 };
    state = feed(state, event('message.final', final, 2n));
    state = feed(state, event('message.final', final, 3n));
    const messages = state.sessions[SESSION_A]!.messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]!.incomplete).toBe(true);
    expect(state.sessions[SESSION_A]!.stream).toBeNull();
  });

  it('a stopped run keeps its completed steps and returns the active one to todo', () => {
    let state = base();
    for (const streamEvent of mockRunStream('stopped', { workspaceId: WS, sessionId: SESSION_A, runId: RUN })) state = feed(state, streamEvent);
    const run = state.sessions[SESSION_A]!.run!;
    expect(run.status).toBe('stopped');
    expect(run.steps.find((step) => step.id === 'read')!.state).toBe('todo');
  });
});

describe('the two cursors', () => {
  it('advance independently', () => {
    let state = base();
    state = feed(state, event('message.appended', { message_id: MESSAGE, session_id: SESSION_A, seq: 1, role: 'iris', kind: null, text: 'hi', blocks: [], status: 'complete', run_id: null }, 40n));
    state = feed(state, event('request.created', { request_id: REQUEST, kind: 'application', status: 'pending', label: 'Leah', run_id: null, session_id: null }, 7n, null));
    expect(state.cursors.session[SESSION_A]).toBe(40n);
    expect(state.cursors.workspace).toBe(7n);
  });

  it('never move backwards', () => {
    let state = reduce(base(), { type: 'cursor/advance', stream: 'workspace', id: 99n });
    state = reduce(state, { type: 'cursor/advance', stream: 'workspace', id: 12n });
    expect(state.cursors.workspace).toBe(99n);
  });

  it('carry ids beyond 2^53 without rounding', () => {
    const big = 9007199254740993n;
    const state = reduce(base(), { type: 'cursor/advance', stream: 'workspace', id: big });
    expect(state.cursors.workspace).toBe(big);
  });
});

describe('resync', () => {
  it('drops the caches and the message windows and keeps drafts and UI state', () => {
    let state = base();
    state = reduce(state, { type: 'session/draft', id: SESSION_A, text: 'half a sentence' });
    state = reduce(state, { type: 'entity/upsert', kind: 'request', id: REQUEST, version: 1, data: { label: 'Leah' } });
    state = reduce(state, { type: 'nav/app', object: CTX, manual: true });
    state = feed(state, event('resync', { stream: 'workspace', reason: 'retention', head: '500' }, 500n, null));
    expect(state.entities.request[REQUEST]).toBeUndefined();
    expect(state.cursors.workspace).toBe(500n);
    expect(state.sessions[SESSION_A]!.draft.text).toBe('half a sentence');
    expect(state.ui.app).toEqual(CTX);
    expect(state.ui.follow).toBe(false);
  });
});

describe('the store wrapper', () => {
  it('notifies only on a real state change', () => {
    const store = createStore(base());
    let calls = 0;
    store.subscribe(() => {
      calls += 1;
    });
    store.dispatch({ type: 'session/rename', id: SESSION_A, title: 'Renamed' });
    store.dispatch({ type: 'session/rename', id: 'nope', title: 'Nothing' });
    expect(calls).toBe(1);
  });
});
