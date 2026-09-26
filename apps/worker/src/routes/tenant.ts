// The shape every tenant route has.
//
// Authenticate, open one transaction with the tenant key from the *path*, read
// the caller's role under the policy that key established, do the work, commit,
// then run the jobs the work queued. Written once here so that no route can
// accidentally do it in a different order — in particular, so that no route can
// read `workspace_id` from a header, and so that no route can run a side effect
// before the transaction that justifies it has committed.
import type { Context } from 'hono';
import type { Env } from '../env.js';
import { getSession } from '../auth.js';
import type { Session } from '../auth/types.js';
import { AuthError } from '../auth/types.js';
import { withTenantTransaction, type Tx } from '../db/client.js';
import { runJobsAfterCommit } from '../jobs.js';
import { RouteError } from './errors.js';

export interface TenantWork {
  readonly tx: Tx;
  readonly workspaceId: string;
  readonly userId: string;
  readonly session: Session;
  /** 'admin' | 'member', read inside the transaction. */
  readonly role: 'admin' | 'member';
  /**
   * Jobs this request queued. They are run after the commit, by the same
   * request, and retried by the Cron if this attempt fails.
   */
  readonly jobs: string[];
  /** Refuse the work unless the caller is an Admin. */
  requireAdmin(action: string): void;
}

export interface WorkspacePhaseTimings {
  readonly authenticationMs: number;
  readonly transactionMs: number;
  readonly afterCommitJobsMs: number;
}

export interface InWorkspaceOptions {
  readonly onTimings?: (timings: WorkspacePhaseTimings) => void;
}

export async function inWorkspace<T>(
  c: Context<{ Bindings: Env }>,
  fn: (work: TenantWork) => Promise<T>,
  options: InWorkspaceOptions = {},
): Promise<T> {
  const authenticationStartedAt = Date.now();
  const session = await getSession(c);
  const authenticationMs = Math.max(0, Date.now() - authenticationStartedAt);
  const workspaceId = c.req.param('ws') ?? '';
  const jobs: string[] = [];

  const transactionStartedAt = Date.now();
  const result = await withTenantTransaction(
    c.env,
    'app',
    { workspaceId, userId: session.userId },
    async (tx, membershipRole) => {
      // `withTenantTransaction` already read this row under tenant RLS. Reusing
      // its result avoids asking Postgres the identical membership question a
      // second time on every authenticated route.
      const role = membershipRole === 'admin' ? 'admin' as const : 'member' as const;
      const work: TenantWork = {
        tx,
        workspaceId,
        userId: session.userId,
        session,
        role,
        jobs,
        requireAdmin(action: string) {
          if (role !== 'admin') {
            throw new RouteError(`${action} needs an Admin`, 'admin_required', 403);
          }
        },
      };
      return fn(work);
    },
  );
  const transactionMs = Math.max(0, Date.now() - transactionStartedAt);

  const jobsStartedAt = Date.now();
  if (jobs.length > 0) await runJobsAfterCommit(c.env, workspaceId, jobs);
  const afterCommitJobsMs = Math.max(0, Date.now() - jobsStartedAt);
  try { options.onTimings?.({ authenticationMs, transactionMs, afterCommitJobsMs }); }
  catch { /* Route telemetry must never change the committed response. */ }
  return result;
}

/** Parse and validate a uuid taken from the path. */
export function pathUuid(c: Context<{ Bindings: Env }>, name: string): string {
  const value = c.req.param(name) ?? '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)) {
    throw new RouteError(`${name} is not a uuid`, 'bad_id', 400);
  }
  return value;
}

export async function jsonBody<T>(c: Context<{ Bindings: Env }>): Promise<T> {
  try {
    return (await c.req.json()) as T;
  } catch {
    throw new RouteError('the request body is not JSON', 'bad_body', 400);
  }
}

export { AuthError };
export { RouteError } from './errors.js';
