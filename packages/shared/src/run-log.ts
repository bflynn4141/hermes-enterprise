// The run-log validator.
//
// It consumes a sequence of `stream_events` rows and decides whether the run
// they describe is one a client could have rendered. Engine tests run it over
// scripted runs; the nightly validator Workflow runs it over production runs, a
// page of runs per step. A violation is a bug in the engine, not in the client,
// which is the point: the client is allowed to be simple because the log is
// checked.
//
// The rules, in the order the plan states them:
//   1. ids are strictly increasing across the sequence;
//   2. no `run.step` after the run reached a terminal status;
//   3. exactly one `message.final` per (run, turn);
//   4. `run.guidance.applied` only after guidance was recorded for that run;
//   5. plus the invariants those three imply: a run is started before it is
//      stepped, deltas belong to a live turn, and a superseded step attempt
//      never produces the final message.
import { safeParseStreamEvent, type StreamEvent } from './events.js';

export interface RunLogViolation {
  /** Index in the input sequence, so a failing test can point at the row. */
  readonly index: number;
  readonly id: string | null;
  readonly kind: string;
  readonly rule:
    | 'schema'
    | 'monotonic_id'
    | 'step_after_stopped'
    | 'duplicate_final'
    | 'missing_final'
    | 'guidance_before_record'
    | 'event_before_start'
    | 'delta_after_final'
    | 'status_after_terminal';
  readonly message: string;
}

export interface RunLogResult {
  readonly ok: boolean;
  readonly violations: readonly RunLogViolation[];
  /** Runs seen, with the turns that produced a final message. */
  readonly runs: ReadonlyMap<string, { readonly finals: ReadonlySet<number>; readonly status: string | null }>;
}

export interface RunLogOptions {
  /**
   * Require that every turn that emitted deltas also emitted a final message.
   * Off by default because a log slice can legitimately end mid-turn; the
   * nightly validator turns it on for runs whose status is terminal.
   */
  readonly requireFinalPerTurn?: boolean;
  /**
   * Guidance ids already recorded before this slice begins (a replay window
   * that starts after the guidance row was written).
   */
  readonly knownGuidanceIds?: readonly string[];
}

const TERMINAL: ReadonlySet<string> = new Set(['stopped', 'error', 'completed']);

interface RunState {
  started: boolean;
  status: string | null;
  finals: Set<number>;
  deltaTurns: Set<number>;
  finalizedTurns: Set<number>;
}

export function validateRunLog(events: readonly unknown[], options: RunLogOptions = {}): RunLogResult {
  const violations: RunLogViolation[] = [];
  const runs = new Map<string, RunState>();
  const guidance = new Set<string>(options.knownGuidanceIds ?? []);
  let lastId: bigint | null = null;

  const runOf = (runId: string): RunState => {
    let state = runs.get(runId);
    if (!state) {
      state = { started: false, status: null, finals: new Set(), deltaTurns: new Set(), finalizedTurns: new Set() };
      runs.set(runId, state);
    }
    return state;
  };

  events.forEach((raw, index) => {
    const parsed = safeParseStreamEvent(raw);
    if (!parsed.success) {
      const kind = typeof raw === 'object' && raw !== null && 'kind' in raw ? String((raw as { kind: unknown }).kind) : 'unknown';
      violations.push({ index, id: null, kind, rule: 'schema', message: parsed.error.message });
      return;
    }
    const e: StreamEvent = parsed.data;

    // Rule 1: ids strictly increase. Replay depends on it, and an out-of-order
    // pair means two writers shared a sequence.
    const id = BigInt(e.id);
    if (lastId !== null && id <= lastId) {
      violations.push({
        index,
        id: e.id,
        kind: e.kind,
        rule: 'monotonic_id',
        message: `id ${e.id} does not exceed the previous id ${lastId.toString()}`,
      });
    }
    lastId = lastId === null || id > lastId ? id : lastId;

    switch (e.kind) {
      case 'run.started': {
        runOf(e.payload.run_id).started = true;
        break;
      }
      case 'run.step': {
        const run = runOf(e.payload.run_id);
        if (!run.started) {
          violations.push({ index, id: e.id, kind: e.kind, rule: 'event_before_start', message: `run.step before run.started for ${e.payload.run_id}` });
        }
        // Rule 2: nothing steps after the run has finished. This is the
        // invariant behind "Stop shows no step after it".
        if (run.status !== null && TERMINAL.has(run.status)) {
          violations.push({
            index,
            id: e.id,
            kind: e.kind,
            rule: 'step_after_stopped',
            message: `run.step after the run reached ${run.status}`,
          });
        }
        break;
      }
      case 'run.status': {
        const run = runOf(e.payload.run_id);
        if (run.status !== null && TERMINAL.has(run.status) && e.payload.status !== run.status) {
          violations.push({
            index,
            id: e.id,
            kind: e.kind,
            rule: 'status_after_terminal',
            message: `status ${e.payload.status} after the terminal status ${run.status}`,
          });
        }
        run.status = e.payload.status;
        break;
      }
      case 'run.guidance.applied': {
        // Rule 4: guidance cannot be applied before it was recorded. A
        // `run.queue.updated` or an out-of-band write is not a recording.
        if (!guidance.has(e.payload.guidance_id)) {
          violations.push({
            index,
            id: e.id,
            kind: e.kind,
            rule: 'guidance_before_record',
            message: `guidance ${e.payload.guidance_id} applied before it was recorded`,
          });
        }
        break;
      }
      case 'message.appended': {
        // The user's own turn message is how guidance reaches the log: the
        // route records the guidance row and appends the message in one
        // transaction, and the message id is the guidance id.
        if (e.payload.kind === 'guidance') guidance.add(e.payload.message_id);
        break;
      }
      case 'message.delta': {
        const run = runOf(e.payload.run_id);
        run.deltaTurns.add(e.payload.turn);
        if (run.finalizedTurns.has(e.payload.turn)) {
          violations.push({
            index,
            id: e.id,
            kind: e.kind,
            rule: 'delta_after_final',
            message: `delta for turn ${e.payload.turn} after message.final`,
          });
        }
        break;
      }
      case 'message.reset': {
        // A step retry discards the superseded attempt's text. The turn is
        // open again, so a later final is the first one, not a duplicate.
        const run = runOf(e.payload.run_id);
        run.finals.delete(e.payload.turn);
        run.finalizedTurns.delete(e.payload.turn);
        break;
      }
      case 'message.final': {
        const run = runOf(e.payload.run_id);
        // Rule 3: exactly one final per turn.
        if (run.finals.has(e.payload.turn)) {
          violations.push({
            index,
            id: e.id,
            kind: e.kind,
            rule: 'duplicate_final',
            message: `a second message.final for turn ${e.payload.turn}`,
          });
        }
        run.finals.add(e.payload.turn);
        run.finalizedTurns.add(e.payload.turn);
        break;
      }
      default:
        break;
    }
  });

  if (options.requireFinalPerTurn) {
    for (const [runId, run] of runs) {
      for (const turn of run.deltaTurns) {
        if (!run.finals.has(turn)) {
          violations.push({
            index: -1,
            id: null,
            kind: 'message.final',
            rule: 'missing_final',
            message: `run ${runId} turn ${turn} streamed deltas but never finalised`,
          });
        }
      }
    }
  }

  const summary = new Map<string, { finals: ReadonlySet<number>; status: string | null }>();
  for (const [runId, run] of runs) summary.set(runId, { finals: run.finals, status: run.status });

  return { ok: violations.length === 0, violations, runs: summary };
}

/** Throwing wrapper for tests and the nightly validator. */
export function assertRunLog(events: readonly unknown[], options: RunLogOptions = {}): void {
  const result = validateRunLog(events, options);
  if (result.ok) return;
  const lines = result.violations.map((v) => `  [${v.index}] ${v.kind}: ${v.rule} - ${v.message}`);
  throw new Error(`run log invalid:\n${lines.join('\n')}`);
}
