import { describe, expect, it } from 'vitest';
import { sessionSnapshotSchema, sessionSettingsSchema } from '../src/index.js';

const id = '00000000-0000-4000-8000-000000000001';
const otherId = '00000000-0000-4000-8000-000000000002';
const at = '2026-09-19T10:00:00.000Z';
const snapshot = () => ({
  workspace_id: id,
  session: { id, agent_id: id, title: 'Session', mode: 'work', model_id: 'test', effort: null,
    runtime: 'cloud', pinned: false, archived: false, focus_ref: null, status: 'working', last_activity_at: at },
  messages: { items: [], cursor: null, total: null },
  run: { id, session_id: id, agent_id: id, status: 'working', attempt: 2, title: null, steps: [],
    queue: [], model_id: 'test', effort: null, started_at: at, admitted_at: at, execution_started_at: null, ended_at: null },
  stream: { run_id: id, attempt: 2, turn: 0, step_attempt: 1, message_id: null, text: 'durable prefix', seq: 0, status: 'streaming' },
  recovery: { next_retry_at: null, not_before: null, cancelled: false, blocked_reason: null },
  watermark: '9007199254740993',
});

describe('selected-session snapshot contract', () => {
  it('keeps large replay ids exact and accepts a run admitted before execution', () => {
    expect(sessionSnapshotSchema.parse(snapshot()).watermark).toBe('9007199254740993');
  });

  it('rejects another session, agent, or attempt embedded in an otherwise valid snapshot', () => {
    const wrongSession = snapshot();
    wrongSession.run.session_id = otherId;
    const wrongAgent = snapshot();
    wrongAgent.run.agent_id = otherId;
    const wrongAttempt = snapshot();
    wrongAttempt.stream.attempt = 1;
    for (const input of [wrongSession, wrongAgent, wrongAttempt]) {
      expect(sessionSnapshotSchema.safeParse(input).success).toBe(false);
    }
  });

  it('requires both model and nullable effort for a settings compare-and-swap', () => {
    expect(sessionSettingsSchema.safeParse({ model_id: 'test' }).success).toBe(false);
    expect(sessionSettingsSchema.parse({ model_id: 'test', effort: null })).toEqual({ model_id: 'test', effort: null });
  });
});
