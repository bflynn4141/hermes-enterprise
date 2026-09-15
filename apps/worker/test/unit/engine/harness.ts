// The engine test harness: a run, in Node, with no network and no workerd.
import { assertRunLog } from '@hermes/shared';
import { ScriptedProvider } from '../../../src/model/scripted.js';
import type { ModelProvider, ProviderEvent } from '../../../src/model/types.js';
import { ProviderError, ZERO_USAGE } from '../../../src/model/types.js';
import { runAttempt, type EngineDeps } from '../../../src/engine/engine.js';
import type { EmittedEvent } from '../../../src/engine/agent-db.js';
import { FakeAgentDb } from './fake-db.js';
import { FakeStep } from './fake-step.js';

export interface HarnessResult {
  readonly db: FakeAgentDb;
  readonly step: FakeStep;
  readonly provider: ScriptedProvider;
  readonly error: unknown;
  /** Milliseconds between the Stop flag being set and the stream aborting. */
  readonly stopLatencyMs: number | null;
  readonly forwards: number;
}

export interface HarnessOptions {
  readonly db?: FakeAgentDb;
  readonly step?: FakeStep;
  readonly provider?: ModelProvider;
  /** Flip Stop after this many forwarded delta batches. */
  readonly stopAfterForwards?: number;
  readonly armContextAnswer?: boolean;
  readonly attempt?: number;
}

export const textDelta = (text: string): ProviderEvent => ({ type: 'text_delta', text });
export const usage = (input = 100, output = 20): ProviderEvent => ({
  type: 'usage',
  usage: { ...ZERO_USAGE, input_tokens: input, output_tokens: output },
});
export const toolCall = (id: string, name: string, args: unknown): ProviderEvent => ({
  type: 'tool_call',
  call: { id, name, arguments: JSON.stringify(args) },
});
export const stop = (reason: 'end_turn' | 'tool_use'): ProviderEvent => ({ type: 'stop', reason });

/** A payload that passes the shared application schema. */
export const APPLICATION = {
  kind: 'application',
  applicant: { name: 'Ada Ling', email: 'Ada.Ling@Example.com' },
  proposed_role: 'Research fellow',
  score: 72,
  score_max: 100,
  criteria: [{ id: 'c1', label: 'Publications', points: 40, points_max: 50, evidence: 'Three papers', source_ids: ['s1'] }],
  sources: [{ id: 's1', name: 'CV', note: 'uploaded' }],
  missing: ['references'],
};

export const transientError = (): ProviderError => new ProviderError('scripted 503', 'transient', 503, 'scripted');
export const authError = (): ProviderError => new ProviderError('scripted 401', 'auth', 401, 'scripted');
export const permanentError = (): ProviderError =>
  new ProviderError('scripted 400: context length exceeded', 'permanent', 400, 'scripted');
export const malformedError = (): ProviderError =>
  new ProviderError('tool arguments for propose_request are not JSON', 'malformed', undefined, 'scripted');

export async function runHarness(
  scripts: readonly { events: readonly ProviderEvent[]; throwAfter?: ProviderError }[],
  options: HarnessOptions = {},
): Promise<HarnessResult> {
  const db = options.db ?? new FakeAgentDb();
  const step = options.step ?? new FakeStep();
  const provider = (options.provider as ScriptedProvider) ?? new ScriptedProvider(scripts);
  if (options.armContextAnswer) step.arm('context-answered', { run_id: 'x', key: 'x' });

  let forwards = 0;
  let stopSetAt: number | null = null;
  let stopSeenAt: number | null = null;

  const deps: EngineDeps = {
    db,
    providerFor: () => provider,
    forward: (_sessionId: string, _runId: string, _events: readonly EmittedEvent[]) => {
      forwards += 1;
      if (options.stopAfterForwards !== undefined && forwards >= options.stopAfterForwards && !db.stopFlag) {
        db.stopFlag = true;
        stopSetAt = Date.now();
      }
      if (db.stopFlag && stopSeenAt === null && stopSetAt !== null) stopSeenAt = Date.now();
      return Promise.resolve({ stop_requested: db.stopFlag });
    },
    now: () => new Date(),
    engineVersion: 1,
  };

  let error: unknown = null;
  try {
    await runAttempt(deps, step, {
      runId: 'run',
      attempt: options.attempt ?? 1,
      traceId: 'trace-0000',
    });
  } catch (caught) {
    error = caught;
  }

  return {
    db,
    step,
    provider,
    error,
    stopLatencyMs: stopSetAt !== null && stopSeenAt !== null ? stopSeenAt - stopSetAt : null,
    forwards,
  };
}

/** Every test runs the shared run-log validator over what it emitted. */
export function assertValidLog(db: FakeAgentDb, options: { requireFinalPerTurn?: boolean } = {}): void {
  assertRunLog(db.streamEvents(), {
    requireFinalPerTurn: options.requireFinalPerTurn ?? false,
    knownGuidanceIds: db.guidance.map((g) => g.id),
  });
}
