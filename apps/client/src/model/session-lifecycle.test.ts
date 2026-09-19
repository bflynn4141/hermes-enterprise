import { describe, expect, it } from 'vitest';
import { mockUuid, parseStreamEvent, SCHEMA_VERSION, type Run } from '@hermes/shared';
import { actionsFor, createStore, initialState } from './store.js';
import { hasVisibleMessageContent } from '../app/chat/message-groups.js';

const sessionId = mockUuid(2);
const runId = mockUuid(3);
const origin = '2026-09-19T10:00:00.000Z';
const later = '2026-09-19T10:00:10.000Z';
const run = (patch: Partial<Run> = {}): Run => ({ id: runId, session_id: sessionId, agent_id: mockUuid(4), status: 'working', attempt: 1, title: null, steps: [], queue: [], started_at: origin, ...patch });
function fixture() {
  const store = createStore(initialState());
  store.dispatch({ type: 'session/create', id: sessionId });
  store.dispatch({ type: 'session/set', id: sessionId, patch: { agentId: mockUuid(4) } });
  store.dispatch({ type: 'run/start', sessionId, run: run() });
  return { store, session: () => store.getState().sessions[sessionId]!, event(kind: string, payload: unknown, id = '1') {
    const event = parseStreamEvent({ id, workspace_id: mockUuid(1), session_id: sessionId, schema_version: SCHEMA_VERSION, trace_id: 'test', at: later, kind, payload });
    for (const action of actionsFor(event, store.getState())) store.dispatch(action);
  } };
}

describe('session lifecycle ordering', () => {
  it('keeps the earlier waiting origin when the same attempt starts late', () => {
    const h = fixture();
    h.store.dispatch({ type: 'run/start', sessionId, run: run({ started_at: later }) });
    expect(h.session().run?.started_at).toBe(origin);
  });

  it('adopts a newer retry status without its lost start event and resets the old preview', () => {
    const h = fixture();
    h.store.dispatch({ type: 'stream/delta', sessionId, runId, turn: 0, stepAttempt: 1, delta: 'old' });
    h.event('run.status', { run_id: runId, attempt: 2, status: 'working' });
    expect(h.session().run?.attempt).toBe(2);
    expect(h.session().run?.started_at).toBe(later);
    expect(h.session().stream).toBeNull();
  });

  it('rejects stale attempt starts and deltas after retry admission', () => {
    const h = fixture();
    h.store.dispatch({ type: 'run/start', sessionId, run: run({ attempt: 2, started_at: later }) });
    h.store.dispatch({ type: 'run/start', sessionId, run: run() });
    h.event('message.delta', { run_id: runId, message_id: mockUuid(5), attempt: 1, turn: 0, step_attempt: 1, seq: 0, delta: 'old' });
    expect(h.session().run?.attempt).toBe(2);
    expect(h.session().stream).toBeNull();
  });

  it('rejects duplicate durable deltas at the store watermark', () => {
    const h = fixture();
    const payload = { run_id: runId, message_id: mockUuid(5), attempt: 1, turn: 0, step_attempt: 1, seq: 0, delta: 'once' };
    h.event('message.delta', payload);
    h.event('message.delta', payload);
    expect(h.session().stream?.text).toBe('once');
  });

  it('does not let a delayed working status reopen a completed attempt', () => {
    const h = fixture();
    h.store.dispatch({ type: 'run/status', sessionId, runId, status: 'completed', patch: { attempt: 1 } });
    h.store.dispatch({ type: 'run/status', sessionId, runId, status: 'working', patch: { attempt: 1 } });
    expect(h.session().run?.status).toBe('completed');
  });

  it('keeps an empty persisted failure visible without a presentation flag', () => {
    expect(hasVisibleMessageContent({ id: mockUuid(5), session_id: sessionId, seq: 1, role: 'iris', kind: null, text: '', blocks: [], status: 'incomplete', run_id: runId })).toBe(true);
  });
});
