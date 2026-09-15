// The three long-wait Workflow classes.
//
// They are thin on purpose, for the same reason `RunAttempt` is (decision 42):
// everything that decides anything is a plain function over an abstract `step`,
// testable in Node against Docker Postgres, and the class is the wiring that
// hands it the real one. A Workflow body that could only be exercised inside
// workerd against a real seven-day sleep is a Workflow body nobody tests.
//
// All three are registered in wrangler.jsonc. They are separate Workflows
// rather than three code paths in one because their step names, retry
// behaviour and instance lifetimes have nothing in common, and because
// `instance.status()` answering "which of the three is this" is worth more
// during an incident than one fewer binding.
import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { NonRetryableError } from 'cloudflare:workflows';
import type { Env } from '../env.js';
import {
  deletionDeps,
  runWorkspaceDeletion,
  type DeletionStep,
  type WorkspaceDeletionParams,
} from './workspace-deletion.js';
import { runKekRotationWorkflow, type KekRotationParams, type RotationStep } from './kek-rotation.js';
import { runNightlyValidator, type ValidatorStep } from './nightly-validator.js';

/**
 * Step options for the long-wait Workflows.
 *
 * Longer delays and fewer attempts than the run engine's: nothing here is
 * user-facing, a failed attempt costs a retry rather than a visibly stuck
 * conversation, and the failures these steps hit (a WorkOS outage, a database
 * failover) resolve on a scale of minutes rather than seconds.
 */
export const LONG_STEP_CONFIG = {
  retries: { limit: 5, delay: 60_000, backoff: 'exponential' },
  timeout: '10 minutes',
} as const;

/**
 * Wrap a real `WorkflowStep` in the two-method interface the bodies take.
 *
 * `step.do` is called through the object and never through a pulled-off
 * reference: `step` is an RPC stub, and a detached `do` loses its receiver and
 * fails at run time with "the RPC receiver does not implement the method call".
 * The same trap `RunAttempt` documents.
 */
function longStep(step: WorkflowStep): DeletionStep & RotationStep & ValidatorStep {
  return {
    do<T>(name: string, fn: () => Promise<T>): Promise<T> {
      const loose = step as unknown as {
        do(name: string, config: typeof LONG_STEP_CONFIG, fn: () => Promise<T>): Promise<T>;
      };
      return loose.do(name, LONG_STEP_CONFIG, fn);
    },
    sleep(name: string, duration: string): Promise<void> {
      const loose = step as unknown as { sleep(name: string, duration: string): Promise<void> };
      return loose.sleep(name, duration);
    },
  };
}

/** Instance id for a workspace's deletion. One at a time, by construction. */
export const workspaceDeletionInstanceId = (workspaceId: string): string => `wsdel-${workspaceId}`;

export class WorkspaceDeletion extends WorkflowEntrypoint<Env, WorkspaceDeletionParams> {
  override async run(event: WorkflowEvent<WorkspaceDeletionParams>, step: WorkflowStep): Promise<void> {
    const params = event.payload;
    if (!params?.workspaceId) {
      throw new NonRetryableError('WorkspaceDeletion was created without a workspace id');
    }
    await runWorkspaceDeletion(params, deletionDeps(this.env), longStep(step));
  }
}

export class KekRotation extends WorkflowEntrypoint<Env, KekRotationParams> {
  override async run(event: WorkflowEvent<KekRotationParams>, step: WorkflowStep): Promise<void> {
    await runKekRotationWorkflow(this.env, event.payload ?? {}, longStep(step));
  }
}

export class NightlyValidator extends WorkflowEntrypoint<Env, Record<string, never>> {
  override async run(_event: WorkflowEvent<Record<string, never>>, step: WorkflowStep): Promise<void> {
    await runNightlyValidator(this.env, longStep(step));
  }
}
