import { describe, expect, it } from 'vitest';
import type { Message, StreamEvent } from '@hermes/shared';
import { reconstructSessionStream } from '../../src/domain/session-snapshot.js';

const id = '00000000-0000-4000-8000-000000000001';
const messageId = '00000000-0000-4000-8000-000000000002';
const run = { id, attempt: 2, status: 'working' };
function event(kind: string, seq: number, payload: Record<string, unknown>): StreamEvent {
  return { id: String(seq), kind, workspace_id: id, session_id: id, at: '2026-09-19T10:00:00.000Z',
    trace_id: 'test', schema_version: 1,
    payload: { run_id: id, attempt: 2, turn: 0, step_attempt: 1, message_id: messageId, ...payload } } as StreamEvent;
}
const reset = event('message.reset', 1, {});
const first = event('message.delta', 2, { seq: 0, delta: 'saved ' });
const second = event('message.delta', 3, { seq: 1, delta: 'prefix' });

describe('durable selected-session stream reconstruction', () => {
  it('recovers the whole checkpoint prefix independent of delivery order or duplicates', () => {
    expect(reconstructSessionStream(run, [second, reset, first, first], [])).toMatchObject({
      run_id: id, attempt: 2, text: 'saved prefix', seq: 1, step_attempt: 1, status: 'streaming',
    });
  });

  it('ignores old retry attempts and replaced step attempts', () => {
    const old = event('message.delta', 5, { attempt: 1, seq: 1, delta: 'old attempt' });
    const replaced = event('message.delta', 6, { seq: 2, delta: 'replaced step' });
    expect(reconstructSessionStream(run, [reset, first, event('message.reset', 3, { step_attempt: 2 }),
      event('message.delta', 4, { step_attempt: 2, seq: 0, delta: 'new attempt' }), old, replaced], []))
      .toMatchObject({ text: 'new attempt', seq: 0, step_attempt: 2 });
  });

  it('uses a persisted final message even before the terminal run status commits', () => {
    const message: Message = { id: messageId, session_id: id, run_id: id, seq: 1, role: 'iris',
      kind: null, text: 'saved prefix and final answer', blocks: [], status: 'complete' };
    expect(reconstructSessionStream(run, [reset, first], [message])).toMatchObject({ text: message.text, status: 'final' });
  });

  it('refuses a gapped checkpoint rather than advancing a cursor over missing text', () => {
    expect(() => reconstructSessionStream(run, [reset, second], [])).toThrowError('durable checkpoint');
  });

  it('keeps final text authoritative over later duplicate deltas', () => {
    expect(reconstructSessionStream(run, [reset, first, event('message.final', 3, { text: 'complete answer' }), event('message.delta', 4, { seq: 1, delta: 'late suffix' })], []))
      .toMatchObject({ text: 'complete answer', status: 'final' });
  });

  it('refuses conflicting checkpoint sequence values rather than choosing arbitrary text', () => {
    expect(() => reconstructSessionStream(run, [reset, first, event('message.delta', 3, { seq: 0, delta: 'different' })], []))
      .toThrowError('durable checkpoint');
  });

  it('does not restore previous retry text before the new attempt starts', () => {
    expect(reconstructSessionStream(run, [event('message.delta', 1, { attempt: 1, seq: 0, delta: 'old' })], [])).toBeNull();
  });

  it('does not promote a previous final message when a retry fails before creating its own stream', () => {
    const old: Message = { id: messageId, session_id: id, run_id: id, seq: 1, role: 'iris',
      kind: null, text: 'previous answer', blocks: [], status: 'incomplete' };
    expect(reconstructSessionStream({ ...run, status: 'error' }, [], [old])).toBeNull();
  });
});
