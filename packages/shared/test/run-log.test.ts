import { describe, expect, it } from 'vitest';
import { assertRunLog, mockRunStream, mockUuid, SCHEMA_VERSION, validateRunLog, type StreamEvent } from '../src/index.js';

const WS = mockUuid(1);
const SESSION = mockUuid(2);
const RUN = mockUuid(3);

const rows = (events: StreamEvent[]): unknown[] => JSON.parse(JSON.stringify(events)) as unknown[];

const raw = (id: string, kind: string, payload: unknown, sessionScoped = true): unknown => ({
  id,
  workspace_id: WS,
  session_id: sessionScoped ? SESSION : null,
  kind,
  schema_version: SCHEMA_VERSION,
  trace_id: 'trace-test',
  at: '2026-10-12T09:49:00.000Z',
  payload,
});

const started = (id: string) =>
  raw(id, 'run.started', {
    run_id: RUN,
    session_id: SESSION,
    attempt: 1,
    engine_version: 1,
    client_turn_id: 'turn-1',
    mode: 'work',
    model_id: 'deepseek-flash',
    effort: 'high',
    title: null,
    steps: [],
  });

const step = (id: string, state: 'todo' | 'active' | 'done' | 'failed') =>
  raw(id, 'run.step', { run_id: RUN, attempt: 1, turn: 0, step_id: 'read', label: 'Read', state });

const status = (id: string, s: string) => raw(id, 'run.status', { run_id: RUN, attempt: 1, status: s });

const final = (id: string, turn = 0) =>
  raw(id, 'message.final', {
    message_id: mockUuid(10),
    session_id: SESSION,
    run_id: RUN,
    turn,
    attempt: 1,
    text: 'done',
    blocks: [],
  });

describe('run-log validator', () => {
  it('accepts every mock scenario', () => {
    for (const scenario of ['completed', 'stopped', 'step_retry', 'waiting', 'error_retryable', 'proposes_request'] as const) {
      expect(() => assertRunLog(rows(mockRunStream(scenario)))).not.toThrow();
    }
  });

  it('rejects a run.step after the run stopped', () => {
    const result = validateRunLog([started('1'), status('2', 'stopped'), step('3', 'active')]);
    expect(result.ok).toBe(false);
    expect(result.violations.map((v) => v.rule)).toContain('step_after_stopped');
  });

  it('rejects a second message.final for one turn', () => {
    const result = validateRunLog([started('1'), final('2'), final('3')]);
    expect(result.violations.map((v) => v.rule)).toContain('duplicate_final');
  });

  it('accepts a second final when a message.reset reopened the turn', () => {
    const reset = raw('2', 'message.reset', { run_id: RUN, turn: 0, attempt: 1, step_attempt: 2, message_id: null });
    const result = validateRunLog([started('1'), final('2'), reset, final('4')]);
    expect(result.violations.map((v) => v.rule)).not.toContain('duplicate_final');
  });

  it('rejects ids that do not strictly increase', () => {
    const result = validateRunLog([started('5'), step('5', 'active')]);
    expect(result.violations.map((v) => v.rule)).toContain('monotonic_id');
  });

  it('compares ids beyond 2^53, which is why they are strings', () => {
    const a = '9007199254740993';
    const b = '9007199254740994';
    expect(validateRunLog([started(a), step(b, 'active')]).ok).toBe(true);
    expect(validateRunLog([started(b), step(a, 'active')]).ok).toBe(false);
  });

  it('rejects guidance applied before it was recorded, and accepts it after', () => {
    const guidanceId = mockUuid(20);
    const applied = raw('3', 'run.guidance.applied', { run_id: RUN, guidance_id: guidanceId, turn: 0 });
    expect(validateRunLog([started('1'), applied]).violations.map((v) => v.rule)).toContain('guidance_before_record');

    const recorded = raw('2', 'message.appended', {
      message_id: guidanceId,
      session_id: SESSION,
      seq: 1,
      role: 'user',
      kind: 'guidance',
      text: 'Weight readiness higher',
      blocks: [],
      status: 'complete',
      run_id: RUN,
    });
    expect(validateRunLog([started('1'), recorded, applied]).ok).toBe(true);
    // A replay window that begins after the guidance row also has to pass.
    expect(validateRunLog([started('1'), applied], { knownGuidanceIds: [guidanceId] }).ok).toBe(true);
  });

  it('rejects a run.step before run.started', () => {
    expect(validateRunLog([step('1', 'active')]).violations.map((v) => v.rule)).toContain('event_before_start');
  });

  it('reports a turn that streamed but never finalised, when asked', () => {
    const delta = raw('2', 'message.delta', {
      message_id: mockUuid(10),
      run_id: RUN,
      turn: 0,
      attempt: 1,
      step_attempt: 1,
      seq: 0,
      delta: 'partial',
    });
    expect(validateRunLog([started('1'), delta]).ok).toBe(true);
    expect(validateRunLog([started('1'), delta], { requireFinalPerTurn: true }).violations.map((v) => v.rule)).toContain(
      'missing_final',
    );
  });

  it('rejects a malformed row instead of skipping it', () => {
    const result = validateRunLog([{ kind: 'run.step', id: 'nope' }]);
    expect(result.violations[0]?.rule).toBe('schema');
  });
});
