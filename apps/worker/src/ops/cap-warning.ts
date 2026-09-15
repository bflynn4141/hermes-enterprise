// The 80 percent cap warning.
//
// Plan section 5: tenant caps are "enforced at instance creation from
// `model_calls`, with an 80 percent warning job". The enforcement already
// exists (`checkCaps`, called by the turns route). This is the other half: the
// warning that arrives *before* the wall, because a cap that is only discovered
// by hitting it is a cap that reads as an outage.
//
// It is a `jobs` row rather than a direct notification for the usual reason —
// every cross-system side effect after a commit is a job (CONVENTIONS,
// invariant 6) — and the job key contains the workspace and the *day*, so the
// warning is sent once per workspace per day however many turns cross the line.
// A workspace that raises its cap and crosses 80 percent of the new one the
// same day is warned once; that is the right trade against warning on every
// single turn for the rest of the afternoon.
//
// What the job does *not* do is send email. This build sends nothing
// (CONVENTIONS, invariant 5): it writes the `events` row and publishes an
// `entity.updated` so the Settings screen and the banner can render from the
// same numbers the cap is enforced from. The notification preference is read
// and recorded so the row says who would have been told.
import type { Env } from '../env.js';
import type { Tx } from '../db/client.js';
import { enqueueJob, withWorkspaceTransaction, publishEvents, type Job } from '../jobs.js';
import { checkCaps } from '../model/usage.js';
import { logEvent } from '../keys/redact.js';

/** The fraction `checkCaps` reports `warn` at. Named here so a test can cite it. */
export const WARN_FRACTION = 0.8;

/**
 * One key per workspace per tenant day.
 *
 * `UNIQUE(kind, key)` is global (decision 7), so the key carries the workspace
 * id: `cap_warning:latest` in one workspace would silently suppress every other
 * workspace's warning, and the suppressed tenant could not even see the row
 * that blocked it because row-level security hides it.
 */
export const capWarningKey = (workspaceId: string, day: string): string => `cap_warning:${workspaceId}:${day}`;

/** `YYYY-MM-DD` in the workspace's own timezone, the same day the cap resets on. */
async function tenantDay(tx: Tx, workspaceId: string): Promise<string> {
  const { rows } = await tx.query<{ day: string }>(
    `SELECT to_char(date_trunc('day', now() AT TIME ZONE COALESCE(s.timezone, 'UTC')), 'YYYY-MM-DD') AS day
       FROM (SELECT timezone FROM workspace_settings WHERE workspace_id = $1
             UNION ALL SELECT 'UTC' LIMIT 1) s`,
    [workspaceId],
  );
  return rows[0]?.day ?? new Date().toISOString().slice(0, 10);
}

/**
 * Queue the warning if this workspace has crossed the line today.
 *
 * Called from the turn path, inside the turn's transaction, after `checkCaps`
 * has already been read — so it costs no extra query on the hot path when the
 * workspace is nowhere near its cap. Returns the job id it queued, or null.
 */
export async function maybeQueueCapWarning(
  tx: Tx,
  workspaceId: string,
  caps: { warn: boolean; dailyTokenCap: number | null; tokensToday: number },
): Promise<string | null> {
  if (!caps.warn || caps.dailyTokenCap === null) return null;
  const day = await tenantDay(tx, workspaceId);
  return enqueueJob(tx, workspaceId, 'cap_warning', capWarningKey(workspaceId, day), {
    day,
    daily_token_cap: caps.dailyTokenCap,
    tokens_today: caps.tokensToday,
  });
}

export interface CapWarningResult {
  readonly sent: boolean;
  readonly recipients: number;
  readonly fraction: number | null;
}

/**
 * The runner. Re-reads the caps rather than trusting the payload: the job may
 * run a minute after it was queued, and a warning that quoted a stale number
 * would be a warning the Admin cannot reconcile with the usage screen.
 *
 * Re-reading can also find that the cap was raised in the meantime, in which
 * case the right answer is to do nothing and say so.
 */
export async function runCapWarningJob(env: Env, job: Job): Promise<CapWarningResult> {
  return withWorkspaceTransaction(env, job.workspace_id, async (tx) => {
    const caps = await checkCaps(tx, job.workspace_id);
    if (!caps.warn || caps.dailyTokenCap === null) {
      logEvent({ at: 'job.cap_warning', workspace_id: job.workspace_id, note: 'no longer over the threshold' });
      return { sent: false, recipients: 0, fraction: null };
    }

    // Who would be told. `user_notification_settings.blocked` is the "tell me
    // when the agent is blocked" preference, and a cap is the most common way
    // an agent is blocked. Admins only: a Member cannot change the cap, and a
    // notification you cannot act on is noise.
    const recipients = await tx.query<{ user_id: string }>(
      `SELECT m.user_id
         FROM members m
         LEFT JOIN user_notification_settings n
                ON n.workspace_id = m.workspace_id AND n.user_id = m.user_id
        WHERE m.workspace_id = $1
          AND m.role = 'admin'
          AND m.status = 'active'
          AND COALESCE(n.blocked, true)`,
      [job.workspace_id],
    );

    const fraction = Math.round((caps.tokensToday / caps.dailyTokenCap) * 1000) / 1000;

    // The audit row. Ids and an enum kind, like every other `events` row: the
    // numbers live in `model_calls` and are derived at read time.
    await tx.query(
      `INSERT INTO events (workspace_id, actor_type, kind) VALUES ($1, 'system', 'usage.cap_warning')`,
      [job.workspace_id],
    );

    // And the push, so an open Settings screen updates without a poll.
    await publishEvents(tx, job.workspace_id, [
      {
        kind: 'entity.updated',
        payload: { entity: 'workspace_settings', id: job.workspace_id, reason: 'cap_warning' },
      },
    ]);

    logEvent({
      at: 'job.cap_warning',
      workspace_id: job.workspace_id,
      fraction,
      recipients: recipients.rows.length,
      // No email in this build: the row records the requirement and a human
      // acts (CONVENTIONS, invariant 5).
      delivery: 'recorded_only',
    });
    return { sent: true, recipients: recipients.rows.length, fraction };
  });
}
