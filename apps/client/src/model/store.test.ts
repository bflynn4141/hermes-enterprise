// Reducer tests. The demo's store tests are ported, plus the cases the port
// introduced: the entity cache, the two cursors and `step_attempt`.
//
// Every test that involves a server event drives the store through
// `actionsFor(parseStreamEvent(...))`, so a schema change in the contract fails
// here rather than at runtime.
import { describe, expect, it } from 'vitest';
import { CTX, CTX_DEST, INBOX, OV, parseStreamEvent, sameRef, SCHEMA_VERSION, mockUuid, mockRunStream, type Ref, type StreamEvent } from '@hermes/shared';
import { parseRef, serialiseRef } from './routes.js';
import {
  DEFAULT_SESSION_TITLE,
  IRIS_MIN_WIDTH,
  actionsFor,
  autoTitleFrom,
  createStore,
  initialState,
  irisMaxWidth,
  isBlankSession,
  navWidthFor,
  NAV_WIDTH,
  reduce,
  resolveIrisWidth,
  visibleSessions,
  workAreaFor,
  type Action,
  type AppState,
  type SessionState,
} from './store.js';

const WS = mockUuid(1);
const SESSION_A = mockUuid(2);
const SESSION_B = mockUuid(21);
const RUN = mockUuid(3);
const AGENT = mockUuid(4);
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
    pendingTurn: null,
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
    titleSource: 'auto',
    ...patch,
    agentId: patch.agentId ?? AGENT,
  };
}

function base(patch: Partial<AppState> = {}): AppState {
  const state = initialState();
  return {
    ...state,
    workspace: { id: WS, name: 'Nous', role: 'admin', jurisdiction: 'default' },
    user: { id: mockUuid(100), name: 'Maya', email: 'maya@nous.example', role: 'admin' },
    agent: { ...state.agent, id: AGENT },
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
  it('moves legacy Admin settings links for Admins and refuses them for Members before mount', () => {
    const admin = reduce(base(), { type: 'nav/app', object: { section: 'settings', view: 'Runtime capacity' }, manual: true });
    expect(admin.ui.app).toEqual({ section: 'admin', view: 'Runtime capacity' });

    const member = base({
      workspace: { id: WS, name: 'Nous', role: 'member', jurisdiction: 'default' },
      user: { id: mockUuid(101), name: 'Alex', email: 'alex@nous.example', role: 'member' },
    });
    const direct = reduce(member, { type: 'nav/app', object: { section: 'admin', view: 'Runtime capacity' }, manual: true });
    expect(direct.ui.app).toEqual({ section: 'settings', view: 'Notifications' });
    const legacy = reduce(member, { type: 'nav/app', object: { section: 'settings', view: 'Provider keys' }, manual: true });
    expect(legacy.ui.app).toEqual({ section: 'settings', view: 'Notifications' });
  });

  it('unmounts an open Admin page when bootstrap demotes the viewer', () => {
    const open = reduce(base(), { type: 'nav/app', object: { section: 'admin', view: 'Usage' }, manual: true });
    const demoted = reduce(open, {
      type: 'bootstrap/apply',
      patch: {
        workspace: { ...open.workspace, role: 'member' },
        user: { ...open.user, role: 'member' },
      },
    });
    expect(demoted.ui.app).toEqual({ section: 'settings', view: 'Notifications' });
  });

  it('routes an agentless reviewer to Inbox without auto-selecting history', () => {
    const withHistory = base({
      agent: { id: null, name: 'Iris', email: null, summary: '', setupStep: null, provisioningStatus: null },
      sessions: { [SESSION_A]: session(SESSION_A) },
      activeSessionId: SESSION_A,
    });
    const booted = reduce(withHistory, { type: 'bootstrap/apply', patch: { ready: true } });
    expect(booted.activeSessionId).toBeNull();
    expect(booted.ui).toMatchObject({ app: INBOX, irisPanel: 'hidden', pane: 'app', follow: false });
    expect(reduce(booted, { type: 'nav/app', object: OV, manual: true }).ui.app).toEqual(INBOX);
    const selected = reduce(booted, { type: 'session/select', id: SESSION_A });
    expect(selected.activeSessionId).toBe(SESSION_A);
    expect(selected.ui).toMatchObject({ pane: 'chat', irisPanel: 'open' });
  });

  it('closes privileged views and drops cached Admin records as soon as a hub evicts the viewer', () => {
    let open = reduce(base({ settings: { default_model_id: 'model', flags: { secret: true } } }), {
      type: 'nav/app', object: { section: 'admin', view: 'Provider keys' }, manual: true,
    });
    open = reduce(open, { type: 'entity/upsert', kind: 'provider_key', id: 'key-1', version: 1, data: { label: 'Private key' } });
    open = reduce(open, { type: 'list/set', key: 'invitations', ids: ['invite-1'], total: 1 });

    const evicted = reduce(open, { type: 'auth/evicted' });
    expect(evicted.user.role).toBe('member');
    expect(evicted.ui.app).toEqual({ section: 'settings', view: 'Notifications' });
    expect(evicted.entities.provider_key).toEqual({});
    expect(evicted.entities.lists).toEqual({});
    expect(evicted.settings).toEqual({ default_model_id: 'model' });
  });

  it('stores an Admin focus for history but never follows it into a Member view', () => {
    const member = base({
      workspace: { id: WS, name: 'Nous', role: 'member', jurisdiction: 'default' },
      user: { id: mockUuid(101), name: 'Alex', email: 'alex@nous.example', role: 'member' },
    });
    const object: Ref = { section: 'admin', view: 'Provider keys' };
    const next = reduce(member, { type: 'iris/focus', sessionId: SESSION_A, object });
    expect(next.sessions[SESSION_A]!.focus).toEqual(object);
    expect(next.ui.app).toEqual({ section: 'settings', view: 'Notifications' });
  });

  it('does not restore an Admin focus when a Member selects an older session', () => {
    const member = base({
      workspace: { id: WS, name: 'Nous', role: 'member', jurisdiction: 'default' },
      user: { id: mockUuid(101), name: 'Alex', email: 'alex@nous.example', role: 'member' },
      sessions: {
        [SESSION_A]: session(SESSION_A),
        [SESSION_B]: session(SESSION_B, { focus: { section: 'admin', view: 'Usage' } }),
      },
    });
    const selected = reduce(member, { type: 'session/select', id: SESSION_B });
    expect(selected.ui.app).toEqual({ section: 'settings', view: 'Notifications' });
  });

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

describe('prompt-driven views and filters', () => {
  const pendingApplications: Ref = { section: 'inbox', view: 'list', filters: { status: 'pending', kind: 'application' } };
  const resolvedInvoices: Ref = { section: 'inbox', view: 'list', filters: { status: 'resolved', kind: 'invoice', query: 'Ada & Sons / 2026?' } };
  const hiddenSamples: Ref = { section: 'inbox', view: 'list', filters: { status: 'pending', provenance: 'sample', visibility: 'hidden', sort: 'recent' } };
  const focusEvent = (ref: Ref, id: bigint = 1n, sessionId = SESSION_A): StreamEvent =>
    event('run.focus', { run_id: RUN, session_id: sessionId, ref, entity_type: null, entity_id: null }, id, sessionId);

  it('applies the complete incoming Inbox view without making a request or incrementing a badge', () => {
    const start = base({ counts: { inbox: 4, pendingGrants: 2, createdDocuments: 3, decisions: 6 } });
    const state = feed(start, focusEvent(resolvedInvoices));
    expect(state.ui.app).toEqual(resolvedInvoices);
    expect(state.ui.inboxTab).toBe('resolved');
    expect(state.ui.follow).toBe(true);
    expect(state.counts).toBe(start.counts);
    expect(state.entities).toBe(start.entities);
  });

  it('replaces previous filters, including resetting an unfiltered Inbox to Needs review', () => {
    const first = feed(base(), focusEvent(resolvedInvoices));
    const second = feed(first, focusEvent(pendingApplications, 2n));
    expect(second.ui.app.filters).toEqual({ status: 'pending', kind: 'application' });
    expect(second.ui.inboxTab).toBe('needs-review');
    const third = feed(second, focusEvent({ section: 'inbox', view: 'list' }, 3n));
    expect(third.ui.app.filters).toBeUndefined();
    expect(third.ui.inboxTab).toBe('needs-review');
  });

  it('pins manual filters, holds them during a new focus, and resumes the latest full view', () => {
    const focused = feed(base(), focusEvent(pendingApplications));
    const pinnedRef: Ref = { ...pendingApplications, filters: { ...pendingApplications.filters, query: 'Leah' } };
    const pinned = reduce(focused, { type: 'nav/app', object: pinnedRef, manual: true });
    expect(pinned.ui.follow).toBe(false);
    const waiting = feed(pinned, focusEvent(resolvedInvoices, 2n));
    expect(waiting.ui.app).toEqual(pinnedRef);
    expect(waiting.ui.inboxTab).toBe('needs-review');
    expect(waiting.sessions[SESSION_A]!.focus).toEqual(resolvedInvoices);
    const resumed = reduce(waiting, { type: 'follow/resume' });
    expect(resumed.ui.app).toEqual(resolvedInvoices);
    expect(resumed.ui.inboxTab).toBe('resolved');
    expect(resumed.ui.follow).toBe(true);
  });

  it('manual Inbox tabs update the canonical ref, retain list filters and pin the view', () => {
    const focused = feed(base(), focusEvent(pendingApplications));
    const resolved = reduce(focused, { type: 'nav/tab', key: 'inboxTab', value: 'resolved' });
    expect(resolved.ui.app).toEqual({ section: 'inbox', view: 'list', filters: { kind: 'application', status: 'resolved' } });
    expect(resolved.ui.inboxTab).toBe('resolved');
    expect(resolved.ui.follow).toBe(false);
    const rules = reduce(resolved, { type: 'nav/tab', key: 'inboxTab', value: 'rules' });
    expect(rules.ui.app).toEqual({ section: 'inbox', view: 'rules' });
    expect(rules.ui.inboxTab).toBe('rules');
  });

  it('does not let an inactive session alter the visible tab or filters, but restores them on selection', () => {
    const focused = feed(base(), focusEvent(pendingApplications));
    const other = feed(focused, focusEvent(resolvedInvoices, 1n, SESSION_B));
    expect(other.ui.app).toEqual(pendingApplications);
    expect(other.ui.inboxTab).toBe('needs-review');
    const selected = reduce(other, { type: 'session/select', id: SESSION_B });
    expect(selected.ui.app).toEqual(resolvedInvoices);
    expect(selected.ui.inboxTab).toBe('resolved');
  });

  it('opens the Rules and History tabs and keeps manual History navigation pinned', () => {
    const rules = feed(base(), focusEvent({ section: 'inbox', view: 'rules' }));
    expect(rules.ui.inboxTab).toBe('rules');
    const history = feed(rules, focusEvent({ section: 'history', view: 'blocked' }, 2n));
    expect(history.ui.historyTab).toBe('blocked');
    const manual = reduce(history, { type: 'nav/tab', key: 'historyTab', value: 'all' });
    expect(manual.ui.app).toEqual({ section: 'history', view: 'all' });
    expect(manual.ui.historyTab).toBe('all');
    expect(manual.ui.follow).toBe(false);
    const resumed = reduce(manual, { type: 'follow/resume' });
    expect(resumed.ui.historyTab).toBe('blocked');
  });

  it('keeps legacy session refs from selecting a History tab that does not exist', () => {
    const history = feed(base(), focusEvent({ section: 'history', view: 'blocked' }));
    const sessionFocus = feed(history, focusEvent({ section: 'history', view: 'sessions', id: SESSION_B }, 2n));
    expect(sessionFocus.ui.app).toEqual({ section: 'history', view: 'sessions', id: SESSION_B });
    expect(sessionFocus.ui.historyTab).toBe('blocked');
  });

  it('round-trips request state, origin, visibility and a search containing URL punctuation', () => {
    expect(parseRef(`#${serialiseRef(resolvedInvoices)}`)).toEqual(resolvedInvoices);
    expect(parseRef(`#${serialiseRef(pendingApplications)}`)).toEqual(pendingApplications);
    expect(parseRef(`#${serialiseRef(hiddenSamples)}`)).toEqual(hiddenSamples);
    expect(parseRef('#inbox/list?status=invalid')).toBeNull();
    expect(parseRef('#inbox/list?kind=unknown')).toBeNull();
    expect(parseRef('#inbox/list?unexpected=true')).toBeNull();
    expect(parseRef('#inbox/%invalid')).toBeNull();
  });
});

describe('sessions', () => {
  it('a run in one session never touches another', () => {
    const state = feed(base(), event('run.started', { run_id: RUN, session_id: SESSION_A, attempt: 1, engine_version: 1, client_turn_id: 't1', mode: 'work', model_id: 'deepseek-flash', effort: 'high', title: 'Screen', steps: [] }, 1n));
    expect(state.sessions[SESSION_A]!.run).not.toBeNull();
    expect(state.sessions[SESSION_A]!.run?.started_at).toBe('2026-10-12T09:49:00.000Z');
    expect(state.sessions[SESSION_B]!.run).toBeNull();
  });

  it('reconciles an optimistic turn exactly when server events beat the POST response', () => {
    const clientTurnId = mockUuid(23);
    let state = reduce(base(), {
      type: 'turn/optimistic',
      sessionId: SESSION_A,
      clientTurnId,
      message: {
        id: mockUuid(24), session_id: SESSION_A, seq: 0, role: 'user', kind: null,
        text: 'Screen the next applicant.', blocks: [], status: 'complete', run_id: clientTurnId,
      },
      run: {
        id: clientTurnId, session_id: SESSION_A, agent_id: AGENT, status: 'working',
        attempt: 1, title: null, steps: [], queue: [], guidance: null,
      },
    });
    state = feed(state, event('run.started', {
      run_id: RUN, session_id: SESSION_A, attempt: 1, engine_version: 1,
      client_turn_id: clientTurnId, mode: 'work', model_id: 'deepseek-flash',
      effort: 'high', title: null, steps: [],
    }, 1n));
    expect(state.sessions[SESSION_A]!.pendingTurn?.runId).toBe(RUN);
    expect(state.sessions[SESSION_A]!.run?.id).toBe(RUN);

    state = feed(state, event('message.appended', {
      message_id: MESSAGE, session_id: SESSION_A, seq: 0, role: 'user', kind: null,
      text: 'Screen the next applicant.', blocks: [], status: 'complete', run_id: RUN,
      client_turn_id: clientTurnId,
    }, 2n));
    expect(state.sessions[SESSION_A]!.pendingTurn).toBeNull();
    expect(state.sessions[SESSION_A]!.messages).toHaveLength(1);
    expect(state.sessions[SESSION_A]!.messages[0]?.id).toBe(MESSAGE);
  });

  it('does not let a late status from the previous run hide a new optimistic turn', () => {
    const clientTurnId = mockUuid(25);
    const state = feed(
      reduce(base(), {
        type: 'turn/optimistic',
        sessionId: SESSION_A,
        clientTurnId,
        message: {
          id: mockUuid(26), session_id: SESSION_A, seq: 1, role: 'user', kind: null,
          text: 'Second turn.', blocks: [], status: 'complete', run_id: clientTurnId,
        },
        run: {
          id: clientTurnId, session_id: SESSION_A, agent_id: AGENT, status: 'working',
          attempt: 1, title: null, steps: [], queue: [], guidance: null,
        },
      }),
      event('run.status', {
        run_id: RUN, attempt: 1, status: 'completed', waiting_for: null,
        waiting_label: null, active_ms: 1000, error: null,
      }, 3n),
    );

    expect(state.sessions[SESSION_A]!.run?.id).toBe(clientTurnId);
    expect(state.sessions[SESSION_A]!.run?.status).toBe('working');
    expect(state.sessions[SESSION_A]!.status).toBe('Working');
    expect(state.sessions[SESSION_A]!.pendingTurn?.clientTurnId).toBe(clientTurnId);
  });

  it.each(['client-id', 'run-id', 'admission-after-message', 'run-start-after-message'] as const)('confirms a pending turn by %s even when its local sequence is only a placeholder', (via) => {
    const clientTurnId = mockUuid(28);
    let state = reduce(base(), {
      type: 'turn/optimistic', sessionId: SESSION_A, clientTurnId,
      message: { id: mockUuid(29), session_id: SESSION_A, seq: Number.MAX_SAFE_INTEGER,
        role: 'user', kind: null, text: 'again', blocks: [], status: 'complete', run_id: clientTurnId },
      run: { id: clientTurnId, session_id: SESSION_A, agent_id: AGENT, status: 'working',
        attempt: 1, title: null, steps: [], queue: [], guidance: null },
    });
    const message = { id: MESSAGE, session_id: SESSION_A, seq: 2, role: 'user' as const,
      kind: null, text: 'again', blocks: [], status: 'complete' as const, run_id: RUN };
    if (via === 'run-id') state = reduce(state, {
      type: 'turn/accepted', sessionId: SESSION_A, clientTurnId, runId: RUN, status: 'working', attempt: 1,
    });
    state = reduce(state, { type: 'message/confirm-turn', sessionId: SESSION_A, message,
      ...(via === 'client-id' ? { clientTurnId } : {}) });
    if (via === 'admission-after-message') state = reduce(state, {
      type: 'turn/accepted', sessionId: SESSION_A, clientTurnId, runId: RUN, status: 'working', attempt: 1,
    });
    if (via === 'run-start-after-message') state = reduce(state, {
      type: 'run/start', sessionId: SESSION_A, clientTurnId,
      run: { id: RUN, session_id: SESSION_A, agent_id: AGENT, status: 'working',
        attempt: 1, title: null, steps: [], queue: [], guidance: null },
    });
    expect(state.sessions[SESSION_A]!.pendingTurn).toBeNull();
    expect(state.sessions[SESSION_A]!.messages).toEqual([message]);
    expect(state.sessions[SESSION_A]!.run?.id).toBe(RUN);
  });

  it('does not confirm a repeated prompt from an older run before admission establishes identity', () => {
    const clientTurnId = mockUuid(28);
    let state = reduce(base(), {
      type: 'turn/optimistic', sessionId: SESSION_A, clientTurnId,
      message: { id: mockUuid(29), session_id: SESSION_A, seq: 0, role: 'user', kind: null,
        text: 'again', blocks: [], status: 'complete', run_id: clientTurnId },
      run: { id: clientTurnId, session_id: SESSION_A, agent_id: AGENT, status: 'working',
        attempt: 1, title: null, steps: [], queue: [], guidance: null },
    });
    state = reduce(state, { type: 'message/confirm-turn', sessionId: SESSION_A,
      message: { id: MESSAGE, session_id: SESSION_A, seq: 20, role: 'user', kind: null,
        text: 'again', blocks: [], status: 'complete', run_id: RUN } });
    expect(state.sessions[SESSION_A]!.pendingTurn?.clientTurnId).toBe(clientTurnId);
    expect(state.sessions[SESSION_A]!.run?.id).toBe(clientTurnId);
  });

  it('late turn admission cannot roll a completed run back to working', () => {
    const clientTurnId = mockUuid(28);
    let state = reduce(base(), {
      type: 'turn/optimistic', sessionId: SESSION_A, clientTurnId,
      message: { id: mockUuid(29), session_id: SESSION_A, seq: 0, role: 'user', kind: null,
        text: 'again', blocks: [], status: 'complete', run_id: clientTurnId },
      run: { id: clientTurnId, session_id: SESSION_A, agent_id: AGENT, status: 'working',
        attempt: 1, title: null, steps: [], queue: [], guidance: null },
    });
    state = reduce(state, { type: 'run/start', sessionId: SESSION_A, clientTurnId,
      run: { ...state.sessions[SESSION_A]!.run!, id: RUN } });
    state = reduce(state, { type: 'run/status', sessionId: SESSION_A, runId: RUN, status: 'completed' });
    state = reduce(state, { type: 'turn/accepted', sessionId: SESSION_A, clientTurnId,
      runId: RUN, status: 'working', attempt: 1 });
    expect(state.sessions[SESSION_A]!.run?.status).toBe('completed');
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

  it('counts a proposed request once when focus arrives before request.created', () => {
    const initial = base({ counts: { inbox: 0, pendingGrants: 0, createdDocuments: 0, decisions: 0 } });
    const focused = feed(initial, event('run.focus', { run_id: RUN, session_id: SESSION_A, ref: { section: 'inbox', view: 'request', id: REQUEST }, entity_type: 'request', entity_id: REQUEST }, 3n));
    const created = feed(focused, event('request.created', { request_id: REQUEST, kind: 'application', status: 'pending', label: 'Leah', run_id: RUN, session_id: SESSION_A }, 4n, null));
    expect(focused.counts.inbox).toBe(1);
    expect(created.counts.inbox).toBe(1);
  });

  it('a decision is applied from the event; there is no client decide case', () => {
    const decided = feed(base({ counts: { inbox: 4, pendingGrants: 0, createdDocuments: 0, decisions: 0 } }), event('decision.recorded', { request_id: REQUEST, decision_id: mockUuid(70), decision: 'approve', resulting_status: 'admitted', decided_by: mockUuid(100), decided_at: '2026-10-12T09:50:00.000Z', effect_ids: [] }, 4n, null));
    expect(decided.counts.inbox).toBe(3);
    expect(decided.counts.decisions).toBe(1);
    expect(decided.entities.decision[mockUuid(70)]).toBeTruthy();
    // Reducing an unknown action is a no-op: `request/decide` does not exist.
    expect(reduce(decided, { type: 'request/decide' } as unknown as Action)).toBe(decided);
  });

  it('refreshes member and invitation lists for an invitation-derived agent join', () => {
    const actions = actionsFor(event('member.agent_joined', {
      source: 'invitation.accepted',
      invitation_id: mockUuid(80),
      member_id: mockUuid(81),
      agent_id: mockUuid(82),
      coordination_request_id: REQUEST,
    }, 5n, null), base());
    expect(actions).toContainEqual({ type: 'list/invalidate', key: 'members' });
    expect(actions).toContainEqual({ type: 'list/invalidate', key: 'invitations' });
    expect(actions.some((action) => action.type === 'message/add')).toBe(false);
    expect(actions.some((action) => action.type === 'run/start')).toBe(false);
  });
});

describe('streaming text and step_attempt', () => {
  it('keeps an authoritative final under every reset/delta/preview/final delivery order', () => {
    const permutations = <T,>(items: readonly T[]): T[][] =>
      items.length <= 1
        ? [Array.from(items)]
        : items.flatMap((item, index) =>
            permutations([...items.slice(0, index), ...items.slice(index + 1)])
              .map((rest) => [item, ...rest]));
    const frames = [
      event('message.reset', { run_id: RUN, turn: 0, attempt: 1, step_attempt: 1, message_id: MESSAGE }, 1n),
      event('message.delta', { message_id: MESSAGE, run_id: RUN, turn: 0, attempt: 1, step_attempt: 1, seq: 0, delta: 'Draft' }, 2n),
      event('message.final', {
        message_id: MESSAGE, session_id: SESSION_A, run_id: RUN, turn: 0,
        attempt: 1, text: 'Authoritative answer', blocks: [], incomplete: false, worked_ms: 900,
      }, 3n),
      event('run.status', { run_id: RUN, attempt: 1, status: 'completed', active_ms: 900 }, 4n),
    ] as const;

    for (const ordering of permutations(frames)) {
      let state = base();
      for (const frame of ordering) state = feed(state, frame);
      state = reduce(state, { type: 'stream/preview', sessionId: SESSION_A, runId: RUN, turn: 0, stepAttempt: 1, offset: 0, delta: 'Late preview' });
      state = reduce(state, { type: 'stream/reset', sessionId: SESSION_A, runId: RUN, turn: 0, stepAttempt: 2 });
      state = reduce(state, { type: 'stream/delta', sessionId: SESSION_A, runId: RUN, turn: 0, stepAttempt: 2, delta: 'Late durable text' });

      expect(state.sessions[SESSION_A]!.messages).toHaveLength(1);
      expect(state.sessions[SESSION_A]!.messages[0]?.text).toBe('Authoritative answer');
      expect([null, 'Authoritative answer']).toContain(state.sessions[SESSION_A]!.stream?.text ?? null);
      state = reduce(state, { type: 'stream/reveal-complete', sessionId: SESSION_A, runId: RUN });
      expect(state.sessions[SESSION_A]!.stream).toBeNull();

      state = reduce(state, { type: 'stream/reset', sessionId: SESSION_A, runId: RUN, turn: 1, stepAttempt: 1 });
      state = reduce(state, { type: 'stream/delta', sessionId: SESSION_A, runId: RUN, turn: 1, stepAttempt: 1, delta: 'Next turn' });
      expect(state.sessions[SESSION_A]!.stream).toMatchObject({ turn: 1, text: 'Next turn' });
    }
  });

  it('does not finalize a live reply from a persisted streaming placeholder', () => {
    let state = reduce(base(), { type: 'stream/reset', sessionId: SESSION_A, runId: RUN, turn: 0, stepAttempt: 1 });
    state = reduce(state, { type: 'stream/preview', sessionId: SESSION_A, runId: RUN, turn: 0, stepAttempt: 1, offset: 0, delta: 'Rain drums steadily' });
    const before = state;
    state = reduce(state, { type: 'stream/final', sessionId: SESSION_A, message: {
      id: MESSAGE, session_id: SESSION_A, seq: 1, role: 'iris', kind: null,
      text: '', blocks: [], status: 'streaming', run_id: RUN,
    } });
    expect(state).toBe(before);
    expect(state.sessions[SESSION_A]!.stream).toMatchObject({ text: 'Rain drums steadily', status: 'streaming' });
    expect(state.sessions[SESSION_A]!.messages).toHaveLength(0);
  });

  it('shows a preview immediately and reconciles committed overlap without duplication', () => {
    let state = reduce(base(), { type: 'stream/reset', sessionId: SESSION_A, runId: RUN, turn: 0, stepAttempt: 1 });
    state = reduce(state, { type: 'stream/preview', sessionId: SESSION_A, runId: RUN, turn: 0, stepAttempt: 1, offset: 0, delta: 'Hello world' });
    expect(state.sessions[SESSION_A]!.stream?.text).toBe('Hello world');
    expect(state.sessions[SESSION_A]!.stream?.durableText).toBe('');

    state = reduce(state, { type: 'stream/delta', sessionId: SESSION_A, runId: RUN, turn: 0, stepAttempt: 1, delta: 'Hello ' });
    expect(state.sessions[SESSION_A]!.stream?.text).toBe('Hello world');
    expect(state.sessions[SESSION_A]!.stream?.durableText).toBe('Hello ');
    state = reduce(state, { type: 'stream/delta', sessionId: SESSION_A, runId: RUN, turn: 0, stepAttempt: 1, delta: 'world' });
    expect(state.sessions[SESSION_A]!.stream?.text).toBe('Hello world');
    expect(state.sessions[SESSION_A]!.stream?.durableText).toBe('Hello world');
  });

  it('ignores a preview gap and lets the next durable checkpoint recover it', () => {
    let state = reduce(base(), { type: 'stream/reset', sessionId: SESSION_A, runId: RUN, turn: 0, stepAttempt: 1 });
    state = reduce(state, { type: 'stream/preview', sessionId: SESSION_A, runId: RUN, turn: 0, stepAttempt: 1, offset: 6, delta: 'world' });
    expect(state.sessions[SESSION_A]!.stream?.text).toBe('');
    state = reduce(state, { type: 'stream/delta', sessionId: SESSION_A, runId: RUN, turn: 0, stepAttempt: 1, delta: 'Hello world' });
    expect(state.sessions[SESSION_A]!.stream?.text).toBe('Hello world');
  });

  it('reset → deltas → reset → deltas → final leaves exactly one copy of the text', () => {
    let state = base();
    for (const streamEvent of mockRunStream('step_retry', { workspaceId: WS, sessionId: SESSION_A, runId: RUN })) state = feed(state, streamEvent);
    const messages = state.sessions[SESSION_A]!.messages;
    expect(messages).toHaveLength(1);
    expect(messages[0]!.text).toBe('Leah scores 82 of 100. Customer impact is unverified.');
    // The renderer owns the handoff: it receives the authoritative final text,
    // then clears the accumulator after the paced reveal catches up.
    expect(state.sessions[SESSION_A]!.stream).toMatchObject({
      runId: RUN,
      text: 'Leah scores 82 of 100. Customer impact is unverified.',
      status: 'complete',
    });
    state = reduce(state, { type: 'stream/reveal-complete', sessionId: SESSION_A, runId: RUN });
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
    expect(state.sessions[SESSION_A]!.stream).toMatchObject({ text: 'Partial answer', status: 'incomplete' });
    state = reduce(state, { type: 'stream/reveal-complete', sessionId: SESSION_A, runId: RUN });
    expect(state.sessions[SESSION_A]!.stream).toBeNull();
  });

  it('ignores a late delta after the authoritative final while the reveal catches up', () => {
    let state = feed(base(), event('message.reset', { run_id: RUN, turn: 0, attempt: 1, step_attempt: 1, message_id: MESSAGE }, 1n));
    state = feed(state, event('message.delta', { message_id: MESSAGE, run_id: RUN, turn: 0, attempt: 1, step_attempt: 1, seq: 0, delta: 'Draft' }, 2n));
    state = feed(state, event('message.final', {
      message_id: MESSAGE, session_id: SESSION_A, run_id: RUN, turn: 0,
      attempt: 1, text: 'Authoritative answer', blocks: [], incomplete: false,
      worked_ms: 900,
    }, 3n));
    state = feed(state, event('message.delta', { message_id: MESSAGE, run_id: RUN, turn: 0, attempt: 1, step_attempt: 1, seq: 1, delta: ' stale' }, 4n));
    expect(state.sessions[SESSION_A]!.stream?.text).toBe('Authoritative answer');
  });

  it('keeps a newer preview visible when the previous run final arrives late', () => {
    const nextRun = mockUuid(27);
    let state = reduce(base(), {
      type: 'stream/preview', sessionId: SESSION_A, runId: nextRun,
      turn: 0, stepAttempt: 1, offset: 0, delta: 'New answer',
    });
    state = feed(state, event('message.final', {
      message_id: MESSAGE, session_id: SESSION_A, run_id: RUN, turn: 0,
      attempt: 1, text: 'Previous answer', blocks: [], incomplete: false,
      worked_ms: 900,
    }, 4n));

    expect(state.sessions[SESSION_A]!.stream?.runId).toBe(nextRun);
    expect(state.sessions[SESSION_A]!.stream?.text).toBe('New answer');
    expect(state.sessions[SESSION_A]!.messages.at(-1)?.text).toBe('Previous answer');
  });

  it('a stale reveal completion cannot clear a newer run', () => {
    const nextRun = mockUuid(27);
    let state = reduce(base(), {
      type: 'stream/preview', sessionId: SESSION_A, runId: nextRun,
      turn: 0, stepAttempt: 1, offset: 0, delta: 'New answer',
    });
    state = reduce(state, { type: 'stream/reveal-complete', sessionId: SESSION_A, runId: RUN });
    expect(state.sessions[SESSION_A]!.stream?.runId).toBe(nextRun);
  });

  it('a delayed preview cannot resurrect a final reply after reveal completion', () => {
    let state = feed(base(), event('message.reset', { run_id: RUN, turn: 0, attempt: 1, step_attempt: 1, message_id: MESSAGE }, 1n));
    state = feed(state, event('message.final', {
      message_id: MESSAGE, session_id: SESSION_A, run_id: RUN, turn: 0,
      attempt: 1, text: 'Final answer', blocks: [], incomplete: false, worked_ms: 900,
    }, 2n));
    state = reduce(state, { type: 'stream/reveal-complete', sessionId: SESSION_A, runId: RUN });
    // Even if the terminal run.status was missed, the saved final fences the
    // abandoned best-effort RPC once it eventually arrives.
    state = reduce(state, { type: 'stream/preview', sessionId: SESSION_A, runId: RUN, turn: 0, stepAttempt: 1, offset: 0, delta: 'Stale draft' });
    expect(state.sessions[SESSION_A]!.stream).toBeNull();
    expect(state.sessions[SESSION_A]!.messages).toHaveLength(1);

    const nextRun = mockUuid(27);
    state = reduce(state, { type: 'stream/reset', sessionId: SESSION_A, runId: nextRun, turn: 0, stepAttempt: 1 });
    state = reduce(state, { type: 'stream/preview', sessionId: SESSION_A, runId: nextRun, turn: 0, stepAttempt: 1, offset: 0, delta: 'New answer' });
    state = reduce(state, { type: 'stream/preview', sessionId: SESSION_A, runId: RUN, turn: 0, stepAttempt: 1, offset: 0, delta: 'Stale draft' });
    expect(state.sessions[SESSION_A]!.stream).toMatchObject({ runId: nextRun, text: 'New answer' });
  });

  it('accepts previews after an explicit reset for a later turn in the same run', () => {
    let state = feed(base(), event('message.final', {
      message_id: MESSAGE, session_id: SESSION_A, run_id: RUN, turn: 0,
      attempt: 1, text: 'First turn', blocks: [], incomplete: false, worked_ms: 900,
    }, 1n));
    state = reduce(state, { type: 'stream/reset', sessionId: SESSION_A, runId: RUN, turn: 1, stepAttempt: 1 });
    state = reduce(state, { type: 'stream/preview', sessionId: SESSION_A, runId: RUN, turn: 1, stepAttempt: 1, offset: 0, delta: 'Second turn' });
    expect(state.sessions[SESSION_A]!.stream).toMatchObject({ turn: 1, text: 'Second turn' });
  });

  it('cannot replace an active run with an old preview even when its final was missed', () => {
    const nextRun = mockUuid(27);
    let state = feed(base(), event('run.started', {
      run_id: nextRun, session_id: SESSION_A, attempt: 1, engine_version: 1,
      client_turn_id: mockUuid(28), mode: 'work', model_id: 'deepseek-flash',
      effort: 'high', title: null, steps: [],
    }, 1n));
    const stale = { type: 'stream/preview' as const, sessionId: SESSION_A, runId: RUN, turn: 0, stepAttempt: 1, offset: 0, delta: 'Stale draft' };
    state = reduce(state, stale);
    expect(state.sessions[SESSION_A]!.stream).toBeNull();
    // A legitimate first preview still initializes without a message.reset.
    state = reduce(state, { ...stale, runId: nextRun, delta: 'New answer' });
    state = reduce(state, stale);
    expect(state.sessions[SESSION_A]!.stream).toMatchObject({ runId: nextRun, text: 'New answer' });
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

// ---------------------------------------------------------------------------
// The Iris panel (decision C33)
// ---------------------------------------------------------------------------

describe('the Iris panel', () => {
  it('starts open and toggles open↔rail, not open↔nothing', () => {
    let state = base();
    expect(state.ui.irisPanel).toBe('open');
    state = reduce(state, { type: 'iris/toggle' });
    expect(state.ui.irisPanel).toBe('rail');
    state = reduce(state, { type: 'iris/toggle' });
    expect(state.ui.irisPanel).toBe('open');
  });

  it('keeps the old boolean callers working: open:false is the rail, open:true opens', () => {
    let state = base();
    state = reduce(state, { type: 'iris/toggle', open: false });
    expect(state.ui.irisPanel).toBe('rail');
    state = reduce(state, { type: 'iris/toggle', open: true });
    expect(state.ui.irisPanel).toBe('open');
  });

  it('only opens from hidden — a toggle does not half-undo a deliberate hide', () => {
    let state = reduce(base(), { type: 'iris/panel', panel: 'hidden' });
    state = reduce(state, { type: 'iris/toggle' });
    expect(state.ui.irisPanel).toBe('open');
  });

  it('clamps the width to the minimum and to 60 percent of the work area', () => {
    const work = workAreaFor(1840); // 1600
    let state = reduce(base(), { type: 'iris/width', width: 120, workArea: work });
    expect(state.ui.irisWidth).toBe(IRIS_MIN_WIDTH);
    state = reduce(state, { type: 'iris/width', width: 9000, workArea: work });
    expect(state.ui.irisWidth).toBe(irisMaxWidth(work));
    expect(state.ui.irisWidth).toBe(960);
    state = reduce(state, { type: 'iris/width', width: 700, workArea: work });
    expect(state.ui.irisWidth).toBe(700);
    state = reduce(state, { type: 'iris/width', width: null });
    expect(state.ui.irisWidth).toBeNull();
  });

  it('resolves a null width by the demo rule: 800 at 1840, an equal split below it', () => {
    expect(resolveIrisWidth(null, 1840)).toBe(800);
    expect(resolveIrisWidth(null, 1920)).toBe(800);
    // 1440 − 240 nav = 1200 of work area, split evenly.
    expect(resolveIrisWidth(null, 1440)).toBe(600);
    // The navigation is 240 px at every width (decision C36), so the split
    // below the wide breakpoint is always of `windowWidth - 240`.
    expect(resolveIrisWidth(null, 1100)).toBe(430);
    // A remembered width still obeys the ceiling at a narrower window.
    expect(resolveIrisWidth(900, 1440)).toBe(720);
  });

  it('keeps the expanded navigation width independent of the window', () => {
    // The regression guard for C36: window width must not silently collapse a
    // component whose disclosure state is still expanded.
    expect(navWidthFor(1840)).toBe(NAV_WIDTH);
    expect(navWidthFor(1100)).toBe(NAV_WIDTH);
    expect(navWidthFor(900)).toBe(NAV_WIDTH);
    expect(workAreaFor(900)).toBe(660);
  });

  it('releases the expanded navigation width when the sidebar becomes a rail', () => {
    expect(navWidthFor(1840, true)).toBe(52);
    expect(workAreaFor(1840, true)).toBe(1788);
  });

  it('counts Iris messages that arrive while collapsed, and clears on open', () => {
    let state = reduce(base(), { type: 'iris/panel', panel: 'rail' });
    state = feed(state, event('message.appended', { session_id: SESSION_A, message_id: MESSAGE, seq: 4, role: 'iris', kind: 'text', text: 'Done', blocks: [], status: 'complete', run_id: RUN }, 10n));
    expect(state.ui.irisUnread).toBe(1);
    // The person's own message is not something they missed.
    state = feed(state, event('message.appended', { session_id: SESSION_A, message_id: mockUuid(12), seq: 5, role: 'user', kind: 'text', text: 'ok', blocks: [], status: 'complete', run_id: null }, 11n));
    expect(state.ui.irisUnread).toBe(1);
    // A replay of the same message must not count twice.
    state = feed(state, event('message.appended', { session_id: SESSION_A, message_id: MESSAGE, seq: 4, role: 'iris', kind: 'text', text: 'Done', blocks: [], status: 'complete', run_id: RUN }, 12n));
    expect(state.ui.irisUnread).toBe(1);
    state = reduce(state, { type: 'iris/panel', panel: 'open' });
    expect(state.ui.irisUnread).toBe(0);
  });

  it('does not count while the panel is open', () => {
    const state = feed(base(), event('message.appended', { session_id: SESSION_A, message_id: MESSAGE, seq: 4, role: 'iris', kind: 'text', text: 'Done', blocks: [], status: 'complete', run_id: RUN }, 10n));
    expect(state.ui.irisUnread).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Sessions: no twins, and titles that name themselves (decision C34)
// ---------------------------------------------------------------------------

describe('session titles and blank sessions', () => {
  const blank = (id: string) => session(id, { title: DEFAULT_SESSION_TITLE, messages: [], run: null });

  it('lists a blank session only when it is the one you are in', () => {
    const state = base({
      sessions: { a: blank('a'), b: blank('b'), c: session('c', { title: 'Partner applications' }) },
      sessionOrder: ['a', 'b', 'c'],
      activeSessionId: 'a',
    });
    expect(visibleSessions(state).map((s) => s.id)).toEqual(['a', 'c']);
  });

  it('a session with a message is not blank, whatever it is called', () => {
    const used = session('a', { title: DEFAULT_SESSION_TITLE, messages: [{ id: MESSAGE, session_id: 'a', seq: 1, role: 'user', kind: 'text', text: 'hi', blocks: [], status: 'complete', run_id: null, at: '2026-10-12T09:49:00.000Z' }] });
    expect(isBlankSession(used)).toBe(false);
    expect(isBlankSession(blank('b'))).toBe(true);
  });

  it('takes the first six words of the first turn, and trims what reads as truncation', () => {
    expect(autoTitleFrom('Screen the applicant and tell me what is missing')).toBe('Screen the applicant and tell me');
    expect(autoTitleFrom('  Review   the   invoice.  ')).toBe('Review the invoice');
    expect(autoTitleFrom('   ')).toBeNull();
    expect(autoTitleFrom('x'.repeat(200))).toHaveLength(58);
  });

  it('auto-titling is refused once somebody has renamed the session', () => {
    let state = base();
    state = reduce(state, { type: 'session/auto-title', id: SESSION_A, title: 'Screen the applicant' });
    expect(state.sessions[SESSION_A]!.title).toBe('Screen the applicant');
    state = reduce(state, { type: 'session/rename', id: SESSION_A, title: 'Q4 partners' });
    expect(state.sessions[SESSION_A]!.titleSource).toBe('manual');
    state = reduce(state, { type: 'session/auto-title', id: SESSION_A, title: 'Ada Ling · application' });
    expect(state.sessions[SESSION_A]!.title).toBe('Q4 partners');
  });

  it('a server row that still says "New session" does not undo a local title', () => {
    let state = base();
    state = reduce(state, { type: 'session/auto-title', id: SESSION_A, title: 'Screen the applicant' });
    state = reduce(state, {
      type: 'session/upsert',
      session: { id: SESSION_A, agent_id: AGENT, title: DEFAULT_SESSION_TITLE, mode: 'work', model_id: 'deepseek-flash', effort: 'high', runtime: 'cloud', pinned: false, archived: false, focus_ref: null, status: 'Ready', last_activity_at: '2026-10-12T09:49:00.000Z', share: null, context: null, version: 2 },
    });
    expect(state.sessions[SESSION_A]!.title).toBe('Screen the applicant');
  });
});
