// The run engine's Workflow, registered but not implemented.
//
// M1 puts the class in the config and proves the binding parses; the tool loop
// arrives in M3. It throws `NonRetryableError` rather than returning, because a
// stub that silently succeeded would let a run reach `completed` with no work
// done, and the sweep would never notice.
//
// Two rules are already fixed here, because they are the ones that are painful
// to change later:
//
//   * the instance id is `${run_id}-a${attempt}`. Workflow ids must match
//     /^[a-zA-Z0-9_][a-zA-Z0-9-_]*$/ and be at most 100 characters, and they
//     cannot contain '/'. A uuid plus that suffix satisfies both, and the id
//     is derivable from the row, so a sweep can look an instance up.
//   * `create()` throws on a duplicate id, so the `runs` row is the idempotency
//     record, not the Workflow. The route inserts the row first under
//     UNIQUE(session_id, client_turn_id), then creates the instance and treats
//     a duplicate-id error as a no-op.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import type { Env } from '../env.js';

export interface RunAttemptParams {
  readonly runId: string;
  readonly workspaceId: string;
  readonly sessionId: string;
  readonly attempt: number;
  readonly engineVersion: number;
  readonly traceId: string;
}

/** Cloudflare's documented instance-id pattern. Asserted by a unit test. */
export const WORKFLOW_ID_PATTERN = /^[a-zA-Z0-9_][a-zA-Z0-9\-_]*$/;
export const WORKFLOW_ID_MAX_LENGTH = 100;

export function runAttemptInstanceId(runId: string, attempt: number): string {
  const id = `${runId}-a${attempt}`;
  if (!WORKFLOW_ID_PATTERN.test(id) || id.length > WORKFLOW_ID_MAX_LENGTH) {
    throw new Error(`run attempt id is not a valid Workflow instance id: ${id}`);
  }
  return id;
}

/** Step names are checkpoint keys, so they must be deterministic and stable. */
export const stepNames = {
  provider: (turn: number) => `turn-${turn}-provider`,
  tool: (turn: number, toolCallId: string) => `turn-${turn}-tool-${toolCallId}`,
} as const;

/**
 * Step options, fixed now because the defaults are wrong for this workload: the
 * documented default is `timeout: '10 minutes'` per attempt, and a Max-effort
 * turn can stream for longer than that.
 */
export const STEP_OPTIONS = {
  provider: { retries: { limit: 3, delay: 10_000, backoff: 'exponential' }, timeout: '30 minutes' },
  tool: { retries: { limit: 5, delay: 10_000, backoff: 'exponential' }, timeout: '2 minutes' },
} as const;

export class RunAttempt extends WorkflowEntrypoint<Env, RunAttemptParams> {
  override async run(event: WorkflowEvent<RunAttemptParams>, step: WorkflowStep): Promise<void> {
    void step;
    throw new NonRetryableError(
      `NotImplemented: the run engine lands in M3. Attempt ${event.payload.attempt} of run ${event.payload.runId} did no work.`,
    );
  }
}
