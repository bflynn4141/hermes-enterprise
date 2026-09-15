// The jobs table: every cross-system side effect after a commit.
//
// A job row is written in the same transaction as the change that implies it,
// so the effect cannot exist without the change or the change without the
// effect. The committing request tries the job immediately; the minute Cron
// retries whatever is still undone. That is what makes a dropped post-commit
// RPC cost a minute of lag rather than a lost receipt.
import type { Tx } from './db/client.js';

export interface Job {
  readonly id: string;
  readonly workspace_id: string;
  readonly kind: string;
  readonly key: string;
  readonly payload: unknown;
  readonly attempts: number;
}

/** How long a claimer holds a job before another may take it. */
export const CLAIM_SECONDS = 120;

/**
 * Claim one job.
 *
 * The whole safety argument is in the WHERE clause: the row is only claimed if
 * it is still undone and either unlocked or expired, and `RETURNING` reports
 * whether this caller won. Two claimers racing on one row means one UPDATE
 * matches and the other matches nothing, so a receipt is sent once even when
 * the committing request and the Cron reach for it in the same millisecond.
 */
export async function claimJob(tx: Tx, jobId: string): Promise<Job | null> {
  const { rows } = await tx.query<Job>(
    `UPDATE jobs
        SET locked_until = now() + ($2 || ' seconds')::interval,
            attempts = attempts + 1
      WHERE id = $1
        AND done_at IS NULL
        AND (locked_until IS NULL OR locked_until < now())
      RETURNING id, workspace_id, kind, key, payload, attempts`,
    [jobId, String(CLAIM_SECONDS)],
  );
  return rows[0] ?? null;
}

/** Claim the next due job for a workspace, if any. Same predicate, no id. */
export async function claimNextJob(tx: Tx): Promise<Job | null> {
  const { rows } = await tx.query<Job>(
    `UPDATE jobs
        SET locked_until = now() + ($1 || ' seconds')::interval,
            attempts = attempts + 1
      WHERE id = (
        SELECT id FROM jobs
         WHERE done_at IS NULL
           AND next_at <= now()
           AND (locked_until IS NULL OR locked_until < now())
         ORDER BY next_at
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      )
      RETURNING id, workspace_id, kind, key, payload, attempts`,
    [String(CLAIM_SECONDS)],
  );
  return rows[0] ?? null;
}

export async function finishJob(tx: Tx, jobId: string): Promise<void> {
  await tx.query('UPDATE jobs SET done_at = now(), locked_until = NULL WHERE id = $1', [jobId]);
}

/** Release a failed job for a later attempt, with backoff. */
export async function failJob(tx: Tx, jobId: string, error: string, attempts: number): Promise<void> {
  const backoffSeconds = Math.min(3600, 30 * 2 ** Math.max(0, attempts - 1));
  await tx.query(
    `UPDATE jobs
        SET locked_until = NULL,
            last_error = $2,
            next_at = now() + ($3 || ' seconds')::interval
      WHERE id = $1`,
    [jobId, error.slice(0, 1000), String(backoffSeconds)],
  );
}

/**
 * Enqueue inside the caller's transaction. `ON CONFLICT DO NOTHING` on
 * UNIQUE(kind, key) is the idempotency: a decision recorded twice by two tabs
 * still produces one receipt row, because both name the same key.
 *
 * The key must contain an id that is unique across workspaces (a decision id, a
 * document id, a stream range), because UNIQUE(kind, key) is global. A key like
 * `receipt:latest` would let one workspace's enqueue silently suppress
 * another's, and the suppressed tenant could not even see the row that blocked
 * it, because row-level security hides it. A test pins this down.
 */
export async function enqueueJob(
  tx: Tx,
  workspaceId: string,
  kind: string,
  key: string,
  payload: unknown = {},
): Promise<void> {
  await tx.query(
    `INSERT INTO jobs (workspace_id, kind, key, payload)
     VALUES ($1, $2, $3, $4::jsonb)
     ON CONFLICT (kind, key) DO NOTHING`,
    [workspaceId, kind, key, JSON.stringify(payload)],
  );
}
