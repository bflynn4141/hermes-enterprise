// WorkspaceDeletion: the seven-day sleep.
//
// Plan section 5, Secrets and long waits: "`WorkspaceDeletion` sleeps 7 days
// then deletes the WorkOS organization, the rows and the R2 prefix."
//
// The shape is the argument. `DELETE /w/:ws` does the part that has to be
// immediate — revoke every session, stop every run, mark the workspace — and
// then a Workflow holds the part that has to be reversible. Seven days is not a
// grace period for politeness: a deletion is the one operation in this product
// with no undo, and the two ways it goes wrong (an Admin who misclicked, an
// attacker who got a session) both look identical at the moment it is
// requested and completely different a day later.
//
// Why a Workflow rather than a `jobs` row with `next_at = now() + 7 days`: the
// job would work, and it would also be indistinguishable from a job that is
// merely stuck. A Workflow instance has a status a human can query, a sleep the
// platform owns, and `terminate()` as the cancel — and `step.sleep` is
// documented for exactly this (plan section 5, **verified**).
//
// Four steps, in this order, and the order is load-bearing:
//
//   1. sleep 7 days                    reversible until it returns
//   2. re-read the row                 the cancel check, after the sleep
//   3. delete the WorkOS organization  their side first: it is the one we
//                                      cannot retry against a deleted row
//   4. delete the rows                 ON DELETE CASCADE from `workspaces`
//   5. delete the R2 prefix            objects last, because an object with no
//                                      row is garbage the sweep collects, and a
//                                      row with no object is a broken product
//
// Steps 3 to 5 are each idempotent on their own, which they have to be: a
// Workflow step can run more than once.
import type { Env } from '../env.js';
import { withWorkspaceTransaction } from '../jobs.js';
import { optionalWorkosPort } from '../auth/workos.js';
import { deleteWorkspacePrefix } from '../storage/erasure.js';
import { logError, logEvent } from '../keys/redact.js';

/** Plan section 5. Also the number Settings > Data and privacy quotes. */
export const DELETION_SLEEP = '7 days' as const;
export const DELETION_SLEEP_DAYS = 7;

export interface WorkspaceDeletionParams {
  readonly workspaceId: string;
  readonly requestedBy: string;
  readonly requestedAt: string;
}

/**
 * The narrow slice of `step` this Workflow uses, so the whole body can be run
 * in Node against a fake clock. `sleep` is a real seven days in production and
 * a resolved promise in a test, which is the only way this is testable at all.
 */
export interface DeletionStep {
  do<T>(name: string, fn: () => Promise<T>): Promise<T>;
  sleep(name: string, duration: string): Promise<void>;
}

export interface DeletionDeps {
  readonly env: Env;
  /** Injected so a test can assert the WorkOS call without a network. */
  deleteOrganization(organizationId: string): Promise<void>;
  /** Injected for the same reason; the default deletes the R2 prefix. */
  deleteObjects(workspaceId: string): Promise<number>;
}

export interface DeletionOutcome {
  readonly deleted: boolean;
  readonly reason: 'done' | 'cancelled' | 'already_deleted';
  readonly objects: number;
  readonly organization: string | null;
}

/** The default dependencies: the real port and the real bucket. */
export function deletionDeps(env: Env): DeletionDeps {
  return {
    env,
    async deleteOrganization(organizationId: string): Promise<void> {
      const port = optionalWorkosPort(env);
      if (!port) {
        // `AUTH_MODE=fake`, or a deployment with no WorkOS credentials. The
        // rows still go; logging the gap is better than failing forever on an
        // organization that does not exist on our side either.
        logEvent({ at: 'workspace_deletion.workos', note: 'no WorkOS port configured', organization: organizationId });
        return;
      }
      await port.deleteOrganization(organizationId);
    },
    deleteObjects: (workspaceId: string) => deleteWorkspacePrefix(env, workspaceId),
  };
}

/**
 * The body, as a function over an abstract step.
 *
 * Returns rather than throws on a cancel: an instance that ends because the
 * Admin changed their mind is a success, and a Workflow that recorded it as a
 * failure would make the "did any deletion fail" alarm useless.
 */
export async function runWorkspaceDeletion(
  params: WorkspaceDeletionParams,
  deps: DeletionDeps,
  step: DeletionStep,
): Promise<DeletionOutcome> {
  const { env } = deps;
  const { workspaceId } = params;

  await step.sleep('grace-period', DELETION_SLEEP);

  // The cancel check, and it runs *after* the sleep on purpose. Cancelling by
  // terminating the instance works too and is what the route does; this is the
  // belt to that brace, for the case where the terminate call was lost.
  const state = await step.do('read-workspace', async () =>
    withWorkspaceTransaction(env, workspaceId, async (tx) => {
      const { rows } = await tx.query<{
        id: string;
        deletion_requested_at: Date | null;
        workos_organization_id: string | null;
      }>(
        `SELECT id, deletion_requested_at, workos_organization_id FROM workspaces WHERE id = $1`,
        [workspaceId],
      );
      return rows[0] ?? null;
    }),
  );

  if (!state) {
    logEvent({ at: 'workspace_deletion', workspace_id: workspaceId, note: 'already gone' });
    return { deleted: false, reason: 'already_deleted', objects: 0, organization: null };
  }
  if (!state.deletion_requested_at) {
    logEvent({ at: 'workspace_deletion', workspace_id: workspaceId, note: 'cancelled during the grace period' });
    return { deleted: false, reason: 'cancelled', objects: 0, organization: null };
  }

  const organization = state.workos_organization_id;
  if (organization) {
    await step.do('delete-workos-organization', async () => {
      try {
        await deps.deleteOrganization(organization);
      } catch (error) {
        // A 404 from WorkOS means a previous attempt of this step already did
        // it. Anything else is retried by the step's own retry policy.
        const message = error instanceof Error ? error.message : String(error);
        if (!/not.?found|404/i.test(message)) throw error;
        logEvent({ at: 'workspace_deletion.workos', note: 'organization already gone', organization });
      }
      return true;
    });
  }

  // The audit row goes in *before* the rows are deleted, because
  // `ON DELETE CASCADE` from `workspaces` takes `events` with it. It is written
  // for the same reason a tombstone is: the deletion is the last thing this
  // workspace's own audit trail records, and the platform-level record of it is
  // the log line and the Workflow instance.
  await step.do('audit', async () => {
    await withWorkspaceTransaction(env, workspaceId, async (tx) => {
      await tx.query(
        `INSERT INTO events (workspace_id, actor_type, actor_user_id, kind) VALUES ($1, 'user', $2, 'workspace.deleted')`,
        [workspaceId, params.requestedBy],
      );
    });
    return true;
  });

  await step.do('delete-rows', async () => {
    // One call. Every tenant table references `workspaces (id) ON DELETE
    // CASCADE`, so this is the erasure: there is no list of tables to keep in
    // sync with the schema, which is the list that would be wrong.
    //
    // It goes through `hermes_delete_workspace`, a SECURITY DEFINER procedure
    // (migration 0012), because `app` deliberately holds no DELETE on
    // `workspaces` — removal is a status change everywhere else in this product
    // and a role that could delete a tenant row is a role one bug away from
    // deleting a tenant. The procedure refuses a workspace nobody asked to
    // delete, so the grant does not widen what a stray call can do.
    return withWorkspaceTransaction(env, workspaceId, async (tx) => {
      const { rows } = await tx.query<{ deleted: number }>(
        `SELECT hermes_delete_workspace($1::uuid) AS deleted`,
        [workspaceId],
      );
      return rows[0]?.deleted ?? 0;
    });
  });

  const objects = await step.do('delete-objects', async () => {
    try {
      return await deps.deleteObjects(workspaceId);
    } catch (error) {
      // The rows are gone and the objects are not. That is the recoverable
      // half — the daily orphan sweep collects an object with no row after 24
      // hours — so this is logged rather than thrown, and the Workflow ends
      // having done the part that matters legally.
      logError({ at: 'workspace_deletion.objects', workspace_id: workspaceId, error });
      return 0;
    }
  });

  logEvent({
    at: 'workspace_deletion',
    workspace_id: workspaceId,
    organization,
    objects,
    note: 'deleted after the grace period',
  });
  return { deleted: true, reason: 'done', objects, organization };
}
