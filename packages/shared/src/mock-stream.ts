// A deterministic mock event stream.
//
// It exists so the kept reducer, the client and the tests can be developed
// against the contract before the run engine exists (M3), and so a test can ask
// for a *specific* difficult sequence — a stopped run, a retried step, a run
// that waits for context — without standing up Postgres, a Workflow and a
// provider. Everything it emits parses as a `StreamEvent` and satisfies the
// run-log validator unless the scenario deliberately breaks a rule.
import { parseStreamEvent, SCHEMA_VERSION, type StreamEvent } from './events.js';
import type { Ref } from './refs.js';

export interface MockStreamOptions {
  readonly workspaceId?: string;
  readonly sessionId?: string;
  readonly runId?: string;
  readonly traceId?: string;
  /** First stream id; ids increase by one per event. */
  readonly firstId?: bigint;
  /** Wall clock for `at`; advances 250 ms per event so ordering is visible. */
  readonly startedAt?: Date;
  readonly modelId?: string;
  /** The request `proposes_request` creates. Defaults to the fixture id the snapshots use. */
  readonly requestId?: string;
}

/** Deterministic v4-shaped uuids, so snapshots do not churn between runs. */
export function mockUuid(seed: number): string {
  const hex = seed.toString(16).padStart(12, '0');
  return `00000000-0000-4000-8000-${hex}`;
}

const DEFAULTS = {
  workspaceId: mockUuid(1),
  sessionId: mockUuid(2),
  runId: mockUuid(3),
  traceId: 'trace-mock-0001',
  modelId: 'deepseek-flash',
};

class Builder {
  private id: bigint;
  private at: Date;
  private readonly events: StreamEvent[] = [];

  constructor(
    private readonly ws: string,
    private readonly session: string,
    private readonly trace: string,
    firstId: bigint,
    startedAt: Date,
  ) {
    this.id = firstId;
    this.at = startedAt;
  }

  push(kind: string, payload: unknown, sessionScoped = true): void {
    const raw = {
      id: this.id.toString(),
      workspace_id: this.ws,
      session_id: sessionScoped ? this.session : null,
      kind,
      schema_version: SCHEMA_VERSION,
      trace_id: this.trace,
      at: this.at.toISOString(),
      payload,
    };
    // Parsing here means a malformed generator fails in the generator's own
    // test, not three layers away in a client test.
    this.events.push(parseStreamEvent(raw));
    this.id += 1n;
    this.at = new Date(this.at.getTime() + 250);
  }

  done(): StreamEvent[] {
    return this.events;
  }
}

export type MockScenario =
  | 'completed'
  | 'stopped'
  | 'step_retry'
  | 'waiting'
  | 'error_retryable'
  | 'proposes_request';

const FOCUS_OVERVIEW: Ref = { section: 'agents', view: 'overview' };

/**
 * Build one run as a stream of events.
 *
 * - `completed`: two steps, streamed text, one final.
 * - `stopped`: Stop lands mid-step; the run reaches `stopped` and nothing steps after.
 * - `step_retry`: a provider step fails and retries; `message.reset` supersedes
 *   the first attempt's deltas, so the final text appears once.
 * - `waiting`: the run asks for context and parks in `waiting`.
 * - `error_retryable`: a transient provider failure ends the attempt.
 * - `proposes_request`: the run proposes a request; the workspace socket gets
 *   `request.created` *after* the session socket already focused it, which is
 *   the cross-socket ordering the client must tolerate.
 */
export function mockRunStream(scenario: MockScenario = 'completed', options: MockStreamOptions = {}): StreamEvent[] {
  const ws = options.workspaceId ?? DEFAULTS.workspaceId;
  const session = options.sessionId ?? DEFAULTS.sessionId;
  const runId = options.runId ?? DEFAULTS.runId;
  const trace = options.traceId ?? DEFAULTS.traceId;
  const modelId = options.modelId ?? DEFAULTS.modelId;
  const messageId = mockUuid(10);
  const requestId = options.requestId ?? mockUuid(11);
  const b = new Builder(ws, session, trace, options.firstId ?? 1n, options.startedAt ?? new Date('2026-10-12T09:49:00.000Z'));

  const steps = [
    { id: 'read', label: 'Read the application', state: 'todo' as const },
    { id: 'criteria', label: 'Read the partner criteria', state: 'todo' as const },
  ];

  b.push('run.started', {
    run_id: runId,
    session_id: session,
    attempt: 1,
    engine_version: 1,
    client_turn_id: 'turn-0001',
    mode: 'work',
    model_id: modelId,
    effort: 'high',
    title: 'Screen the application',
    steps,
  });
  b.push('run.focus', {
    run_id: runId,
    session_id: session,
    ref: FOCUS_OVERVIEW,
    entity_type: 'session',
    entity_id: session,
  });
  b.push('run.step', { run_id: runId, attempt: 1, turn: 0, step_id: 'read', label: 'get_request', state: 'active', tool_call_id: 'mock-call-get-request' });

  if (scenario === 'stopped') {
    b.push('run.status', { run_id: runId, attempt: 1, status: 'stopping' });
    b.push('run.step', { run_id: runId, attempt: 1, turn: 0, step_id: 'read', label: 'get_request', state: 'todo', tool_call_id: 'mock-call-get-request' });
    b.push('run.status', { run_id: runId, attempt: 1, status: 'stopped', active_ms: 1250 });
    return b.done();
  }

  if (scenario === 'error_retryable') {
    b.push('run.status', {
      run_id: runId,
      attempt: 1,
      status: 'error',
      error: { class: 'transient', retryable: true, reason: 'provider_5xx', message: 'The provider returned 503.', step_id: 'read' },
    });
    return b.done();
  }

  b.push('run.step', { run_id: runId, attempt: 1, turn: 0, step_id: 'read', label: 'get_request', state: 'done', tool_call_id: 'mock-call-get-request' });
  b.push('run.step', { run_id: runId, attempt: 1, turn: 0, step_id: 'criteria', label: 'get_document_text', state: 'active', tool_call_id: 'mock-call-get-document' });

  if (scenario === 'step_retry') {
    // First step attempt streams, then fails. Its deltas stay in the outbox.
    b.push('message.reset', { run_id: runId, turn: 0, attempt: 1, step_attempt: 1, message_id: messageId });
    b.push('message.delta', { message_id: messageId, run_id: runId, turn: 0, attempt: 1, step_attempt: 1, seq: 0, delta: 'Leah scores 8' });
    // The retry announces itself; the reducer discards step_attempt 1.
    b.push('message.reset', { run_id: runId, turn: 0, attempt: 1, step_attempt: 2, message_id: messageId });
    b.push('message.delta', { message_id: messageId, run_id: runId, turn: 0, attempt: 1, step_attempt: 2, seq: 0, delta: 'Leah scores 82 of 100. ' });
    b.push('message.delta', { message_id: messageId, run_id: runId, turn: 0, attempt: 1, step_attempt: 2, seq: 1, delta: 'Customer impact is unverified.' });
  } else {
    b.push('message.reset', { run_id: runId, turn: 0, attempt: 1, step_attempt: 1, message_id: messageId });
    b.push('message.delta', { message_id: messageId, run_id: runId, turn: 0, attempt: 1, step_attempt: 1, seq: 0, delta: 'Leah scores 82 of 100. ' });
    b.push('message.delta', { message_id: messageId, run_id: runId, turn: 0, attempt: 1, step_attempt: 1, seq: 1, delta: 'Customer impact is unverified.' });
  }

  b.push('run.step', { run_id: runId, attempt: 1, turn: 0, step_id: 'criteria', label: 'get_document_text', state: 'done', tool_call_id: 'mock-call-get-document' });

  if (scenario === 'proposes_request') {
    b.push('run.focus', {
      run_id: runId,
      session_id: session,
      ref: { section: 'inbox', view: 'request', id: requestId },
      entity_type: 'request',
      entity_id: requestId,
    });
  }

  b.push('message.final', {
    message_id: messageId,
    session_id: session,
    run_id: runId,
    turn: 0,
    attempt: 1,
    text: 'Leah scores 82 of 100. Customer impact is unverified.',
    blocks:
      scenario === 'proposes_request'
        ? [
            {
              type: 'card',
              title: 'Leah Martinez',
              subtitle: '82 / 100 - Awaiting your review',
              action: { label: 'Open request', command: { type: 'open_request', id: requestId } },
            },
          ]
        : [],
    worked_ms: 2250,
  });

  if (scenario === 'waiting') {
    b.push('run.status', { run_id: runId, attempt: 1, status: 'waiting', waiting_for: 'context', waiting_label: 'Feedback destination', active_ms: 2250 });
    return b.done();
  }

  b.push('run.status', { run_id: runId, attempt: 1, status: 'completed', active_ms: 2250 });

  if (scenario === 'proposes_request') {
    // Workspace socket, after the session socket already pointed at it.
    b.push(
      'request.created',
      { request_id: requestId, kind: 'application', status: 'pending', label: 'Leah Martinez', run_id: runId, session_id: session },
      false,
    );
  }

  return b.done();
}

/** The same events as JSON lines, for a mock server or a fixture file. */
export function mockRunStreamJsonl(scenario: MockScenario = 'completed', options: MockStreamOptions = {}): string {
  return mockRunStream(scenario, options)
    .map((e) => JSON.stringify(e))
    .join('\n');
}
