import { describe, expect, it } from 'vitest';
import { mockUuid, parseStreamEvent, SCHEMA_VERSION, sessionSnapshotSchema, type Run } from '@hermes/shared';
import { actionsFor, createStore, initialState } from './store.js';
import { hasVisibleMessageContent } from '../app/chat/message-groups.js';

const sessionId = mockUuid(2);
const runId = mockUuid(3);
const origin = '2026-09-19T10:00:00.000Z';
const later = '2026-09-19T10:00:10.000Z';
const run = (patch: Partial<Run> = {}): Run => ({ id: runId, session_id: sessionId, agent_id: mockUuid(4), status: 'working', attempt: 1, title: null, steps: [], queue: [], started_at: origin, ...patch });
function fixture() {
  const initial = initialState();
  initial.workspace.id = mockUuid(1);
  const store = createStore(initial);
  store.dispatch({ type: 'session/create', id: sessionId });
  store.dispatch({ type: 'session/set', id: sessionId, patch: { agentId: mockUuid(4) } });
  store.dispatch({ type: 'run/start', sessionId, run: run() });
  return { store, session: () => store.getState().sessions[sessionId]!, event(kind: string, payload: unknown, id = '1') {
    const event = parseStreamEvent({ id, workspace_id: mockUuid(1), session_id: sessionId, schema_version: SCHEMA_VERSION, trace_id: 'test', at: later, kind, payload });
    for (const action of actionsFor(event, store.getState())) store.dispatch(action);
  } };
}

describe('session lifecycle ordering', () => {
  it.each([
    { turn: 0, step: 1, durable: 'First. ' },
    { turn: 0, step: 2, durable: 'First. Complete checkpoint.' },
    { turn: 1, step: 1, durable: 'New provider turn.' },
    { turn: 0, step: 2, durable: 'New step.', status: 'final' },
    { turn: 1, step: 1, durable: 'New turn.', status: 'final' },
  ])('retains a later preview/checkpoint against an equal-watermark snapshot: $turn/$step/$status', ({ turn, step, durable, status }) => {
    const h = fixture();
    h.store.dispatch({ type: 'stream/delta', sessionId, runId, turn, stepAttempt: step, delta: durable });
    h.store.dispatch({ type: 'stream/preview', sessionId, runId, turn, stepAttempt: step, offset: durable.length, delta: ' Live preview.' });
    h.store.dispatch({ type: 'cursor/advance', stream: 'session', sessionId, id: 10n });
    const snapshot = sessionSnapshotSchema.parse({ workspace_id: mockUuid(1), watermark: '10', recovery: null,
      session: { id: sessionId, agent_id: mockUuid(4), title: 'Session', mode: 'work', model_id: 'model', effort: null, runtime: 'cloud', pinned: false, archived: false, focus_ref: null, status: 'Working', last_activity_at: origin },
      messages: { items: [], cursor: null, total: 0 },
      run: { ...run(), model_id: 'model', effort: null, admitted_at: origin, execution_started_at: origin, ended_at: null },
      stream: { run_id: runId, attempt: 1, turn: 0, step_attempt: 1, message_id: mockUuid(5), text: '', seq: -1, status: status ?? 'streaming' },
    });
    h.store.dispatch({ type: 'session/snapshot', snapshot });
    expect(h.session().stream).toMatchObject({ turn, stepAttempt: step, text: `${durable} Live preview.`, durableText: durable });
  });

  it('does not regress a saved terminal answer when an equal-watermark response arrives late', () => {
    const h = fixture();
    const message = { id: mockUuid(5), session_id: sessionId, seq: 1, role: 'iris' as const, kind: null, text: 'Full terminal answer.', blocks: [], status: 'complete' as const, run_id: runId };
    h.store.dispatch({ type: 'stream/final', sessionId, message });
    h.store.dispatch({ type: 'run/status', sessionId, runId, status: 'completed' });
    h.store.dispatch({ type: 'cursor/advance', stream: 'session', sessionId, id: 10n });
    h.store.dispatch({ type: 'session/snapshot', snapshot: sessionSnapshotSchema.parse({ workspace_id: mockUuid(1), watermark: '10', recovery: null,
      session: { id: sessionId, agent_id: mockUuid(4), title: 'Session', mode: 'work', model_id: 'model', effort: null, runtime: 'cloud', pinned: false, archived: false, focus_ref: null, status: 'Working', last_activity_at: origin },
      messages: { items: [{ ...message, text: 'Full terminal' }], cursor: null, total: 1 },
      run: { ...run(), model_id: 'model', effort: null, admitted_at: origin, execution_started_at: origin, ended_at: null },
      stream: null,
    }) });
    expect(h.session().run?.status).toBe('completed');
    expect(h.session().messages[0]?.text).toBe(message.text);
  });

  it('rejects a delayed reset and older provider turn after its prefix was already rendered', () => {
    const h = fixture();
    h.store.dispatch({ type: 'stream/delta', sessionId, runId, turn: 1, stepAttempt: 2, delta: 'New turn' });
    h.store.dispatch({ type: 'stream/reset', sessionId, runId, turn: 1, stepAttempt: 2 });
    h.store.dispatch({ type: 'stream/delta', sessionId, runId, turn: 0, stepAttempt: 3, delta: 'Old turn' });
    expect(h.session().stream?.text).toBe('New turn');
  });

  it('never appends an out-of-order durable suffix across a missing sequence', () => {
    const h = fixture();
    const delta = { run_id: runId, message_id: mockUuid(5), attempt: 1, turn: 0, step_attempt: 1 };
    h.event('message.delta', { ...delta, seq: 0, delta: 'First. ' }, '1');
    h.event('message.delta', { ...delta, seq: 2, delta: 'Third.' }, '2');
    expect(h.session().stream?.text).toBe('First. ');
    h.event('message.delta', { ...delta, seq: 0, delta: 'First. ' }, '3');
    expect(h.session().stream?.text).toBe('First. ');
    h.event('message.delta', { ...delta, seq: 1, delta: 'Second. ' }, '4');
    h.event('message.delta', { ...delta, seq: 2, delta: 'Third.' }, '5');
    expect(h.session().stream?.text).toBe('First. Second. Third.');
  });

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
