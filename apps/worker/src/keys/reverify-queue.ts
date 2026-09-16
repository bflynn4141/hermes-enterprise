// The durable half of provider-key re-verification.
//
// A `jobs` row is tenant-scoped, while the minute Cron can only discover work
// through the platform `job_ready` table. Both rows must therefore be written
// in the same transaction. Keeping the upsert here also makes the route-driven
// retry and the weekly sweep obey the same scheduling and resurrection rules.
import type { Tx } from '../db/client.js';

export interface ReverifyJobInput {
  readonly workspaceId: string;
  readonly keyId: string;
  readonly provider: string;
  readonly forbiddenCount?: number;
  readonly delaySeconds: number;
}

/** Enqueue or refresh one re-verification and its cross-tenant ready pointer. */
export async function enqueueReverifyJob(tx: Tx, input: ReverifyJobInput): Promise<string> {
  const payload = {
    key_id: input.keyId,
    provider: input.provider,
    ...(input.forbiddenCount === undefined ? {} : { forbidden_count: input.forbiddenCount }),
  };
  const { rows } = await tx.query<{ id: string; next_at: Date }>(
    `INSERT INTO jobs (workspace_id, kind, key, payload, next_at)
     VALUES ($1, 'reverify', $2, $3::jsonb, now() + ($4 || ' seconds')::interval)
     ON CONFLICT (kind, key) DO UPDATE
       SET payload = EXCLUDED.payload,
           done_at = NULL,
           next_at = CASE
             WHEN jobs.done_at IS NULL THEN LEAST(jobs.next_at, EXCLUDED.next_at)
             ELSE EXCLUDED.next_at
           END,
           locked_until = CASE WHEN jobs.done_at IS NULL THEN jobs.locked_until ELSE NULL END,
           attempts = CASE WHEN jobs.done_at IS NULL THEN jobs.attempts ELSE 0 END,
           last_error = CASE WHEN jobs.done_at IS NULL THEN jobs.last_error ELSE NULL END
     RETURNING id, next_at`,
    [input.workspaceId, `reverify:${input.keyId}`, JSON.stringify(payload), String(input.delaySeconds)],
  );
  const job = rows[0];
  if (!job) throw new Error('re-verification job was not enqueued');

  await tx.query(
    `INSERT INTO job_ready (job_id, workspace_id, next_at)
     VALUES ($1, $2, $3)
     ON CONFLICT (job_id) DO UPDATE
       SET workspace_id = EXCLUDED.workspace_id, next_at = EXCLUDED.next_at`,
    [job.id, input.workspaceId, job.next_at],
  );
  return job.id;
}
