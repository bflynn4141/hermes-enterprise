// The platform instance cap.
//
// Plan section 5, Cost, spend, rate limits: "Our platform cap is a maximum of
// Workflow instances per hour plus a billing notification at $50/month". The
// tenant caps (`daily_token_cap`, `max_concurrent_runs`) protect a customer
// from their own runaway agent; this one protects *us* from every customer at
// once, and from the failure mode neither tenant cap catches — a bug in our own
// code that creates instances in a loop, which is under no workspace's cap
// because it is under all of them.
//
// Three properties, all deliberate:
//
//   It is counted before the instance exists, not after. The counter increments
//   inside the turn's transaction, so a turn that fails for any other reason
//   gives its budget back with the rollback, and a turn that succeeds has
//   already paid.
//
//   It is one row, not one row per user. `rate_counters` is keyed by user
//   first, which is exactly right for "30 turns a minute" and exactly wrong
//   here: the question is how many instances the *platform* created this hour.
//   Hence `platform_counters` (migration 0012), which is outside row-level
//   security because the question is cross-tenant by nature.
//
//   It is configurable and fails open on a missing value, not closed. An
//   unset or unparseable `PLATFORM_MAX_INSTANCES_PER_HOUR` means no cap, which
//   is what local development and the test suite want; a deployment that meant
//   to set it and did not gets the same behaviour it had before this existed
//   rather than a Worker that refuses every turn.
import type { Env } from '../env.js';
import type { Tx } from '../db/client.js';
import { RouteError } from '../routes/errors.js';
import { logEvent } from '../keys/redact.js';

/** The `platform_counters.bucket` value. One row per hour. */
export const INSTANCE_BUCKET = 'workflow.instances';

export const INSTANCE_WINDOW_SECONDS = 3_600;

/**
 * The configured ceiling, or null for "no cap".
 *
 * Zero is a cap of zero — a deliberate full stop, the same shape as
 * `ENGINE_PAUSED` but expressed as a number — and is distinguished from unset.
 */
export function instanceCap(env: Env): number | null {
  const raw = (env.PLATFORM_MAX_INSTANCES_PER_HOUR ?? '').trim();
  if (raw === '') return null;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.floor(value);
}

export interface InstanceCapState {
  readonly allowed: boolean;
  readonly cap: number | null;
  readonly used: number;
}

/**
 * Count one prospective Workflow creation against this hour, and say whether it
 * may proceed.
 *
 * Runs in the caller's transaction. The bucket is floor(epoch / 3600), the same
 * arithmetic `rate_counters` uses, so the two counters agree about what an hour
 * is and a reader comparing them is not comparing two different clocks.
 *
 * With no cap configured the row is still written. That is not waste: the
 * counter is also the metric — `/health` and the daily-spend dataset read it —
 * and a platform that only counts once someone set a limit is a platform with
 * no number to choose the limit from.
 */
export async function consumeInstanceCap(tx: Tx, env: Env): Promise<InstanceCapState> {
  const cap = instanceCap(env);
  const { rows } = await tx.query<{ count: number }>(
    `INSERT INTO platform_counters (bucket, window_start, count)
     VALUES ($1, to_timestamp(floor(extract(epoch FROM now()) / $2) * $2), 1)
     ON CONFLICT (bucket, window_start)
       DO UPDATE SET count = platform_counters.count + 1
     RETURNING count`,
    [INSTANCE_BUCKET, INSTANCE_WINDOW_SECONDS],
  );
  const used = rows[0]?.count ?? 0;
  return { allowed: cap === null || used <= cap, cap, used };
}

/**
 * The call the turns route makes.
 *
 * A refusal is 429 with `reason: 'platform_capacity'` and copy that does not
 * blame the customer, because they did nothing wrong: their workspace is inside
 * its own caps and the platform is not. It is also logged, because a workspace
 * hitting this is an incident on our side and nobody would otherwise know.
 */
export async function requireInstanceCapacity(tx: Tx, env: Env, workspaceId: string): Promise<void> {
  const state = await consumeInstanceCap(tx, env);
  if (state.allowed) return;
  logEvent({
    at: 'ops.instance_cap',
    workspace_id: workspaceId,
    cap: state.cap,
    used: state.used,
    note: 'platform instance cap reached; turn refused',
  });
  throw new RouteError(
    'The service is at capacity right now. Your workspace is inside its own limits; this one is ours. Try again shortly.',
    'platform_capacity',
    429,
  );
}

/** What the health route reports: this hour's creations, without counting one. */
export async function readInstanceCounter(tx: Tx, env: Env): Promise<InstanceCapState> {
  const cap = instanceCap(env);
  const { rows } = await tx.query<{ count: number }>(
    `SELECT count FROM platform_counters
      WHERE bucket = $1
        AND window_start = to_timestamp(floor(extract(epoch FROM now()) / $2) * $2)`,
    [INSTANCE_BUCKET, INSTANCE_WINDOW_SECONDS],
  );
  const used = rows[0]?.count ?? 0;
  return { allowed: cap === null || used <= cap, cap, used };
}

/**
 * Drop buckets older than a day.
 *
 * The table would otherwise grow one row an hour forever, which is slow enough
 * that nobody notices and permanent enough that somebody eventually does. Run
 * by the nightly Cron.
 */
export async function sweepPlatformCounters(tx: Tx): Promise<number> {
  const { rowCount } = await tx.query(
    `DELETE FROM platform_counters WHERE window_start < now() - interval '2 days'`,
  );
  return rowCount ?? 0;
}
