// What the nightly Cron queues, per workspace.
//
// Four things, and none of the external work is done here: each effect becomes
// a `jobs` row,
// because the Cron handler has 30 seconds of CPU and copying a workspace's
// uploads prefix does not fit in it, and because a `jobs` row is retried until
// it is done while a Cron body that failed is simply a night that did not
// happen (CONVENTIONS, invariant 6).
//
//   backup_uploads   nightly, keyed by workspace and day
//   events_export    weekly, keyed by workspace and ISO week
//   reverify          weekly, one durable job per stale provider key
//   spend.daily      written straight to Analytics Engine, because it is a
//                    metric rather than an effect: nothing downstream depends
//                    on it and a missing point is a gap in a chart
//
// The workspace list comes from `workspace_directory`, the platform table that
// holds ids and nothing else — the same table the KEK rotation and the nightly
// validator read, and the only answer this database has to "which workspaces
// exist" (migration 0008).
import type { Env } from '../env.js';
import { connect } from '../db/client.js';
import { enqueueJob, withWorkspaceTransaction } from '../jobs.js';
import { backupJobKey } from '../storage/backup.js';
import { eventsExportKey } from './events-export.js';
import { recordDailySpend } from './analytics.js';
import { logEvent } from '../keys/redact.js';
import { enqueueWeeklyReverify } from '../keys/reverify.js';

/** `2026-W07`. The key's uniqueness unit for the weekly export. */
export function isoWeek(date: Date): string {
  // Thursday of this week decides the year, which is the ISO rule and the
  // reason a naive "year plus week number" is wrong for three days each January.
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const day = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((d.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

async function listWorkspaces(env: Env): Promise<string[]> {
  const client = await connect(env, 'app');
  try {
    const { rows } = await client.query<{ workspace_id: string }>(
      `SELECT workspace_id FROM workspace_directory ORDER BY workspace_id`,
    );
    return rows.map((row) => row.workspace_id);
  } finally {
    await client.end();
  }
}

export interface NightlyResult {
  readonly workspaces: number;
  readonly backups: number;
  readonly exports: number;
  readonly reverifications: number;
  readonly spendPoints: number;
}

/**
 * Queue the night's work.
 *
 * `now` is injected so a test can assert that the weekly export is queued on a
 * Monday and not on a Tuesday without waiting six days for one.
 */
export async function runNightly(env: Env, now: Date = new Date()): Promise<NightlyResult> {
  const workspaces = await listWorkspaces(env);
  const day = now.toISOString().slice(0, 10);
  const week = isoWeek(now);
  // Monday. One day a week, and the key carries the week, so a Cron that fires
  // twice on the same Monday queues one export.
  const weekly = now.getUTCDay() === 1;

  let backups = 0;
  let exports = 0;
  let reverifications = 0;
  let spendPoints = 0;

  for (const workspaceId of workspaces) {
    try {
      await withWorkspaceTransaction(env, workspaceId, async (tx) => {
        if (await enqueueJob(tx, workspaceId, 'backup_uploads', backupJobKey(workspaceId, day))) backups += 1;
        if (weekly && (await enqueueJob(tx, workspaceId, 'events_export', eventsExportKey(workspaceId, week), { week }))) {
          exports += 1;
        }
        if (weekly) reverifications += await enqueueWeeklyReverify(tx, workspaceId);

        // Yesterday's spend, in the workspace's own timezone, for the daily
        // platform-spend series. Read here rather than in a job because it is
        // one aggregate query and because a metric is not worth a retry.
        const { rows } = await tx.query<{ day: string; cost: string; tokens: string }>(
          `WITH s AS (SELECT COALESCE(timezone, 'UTC') AS tz FROM workspace_settings WHERE workspace_id = $1)
           SELECT to_char(date_trunc('day', m.created_at AT TIME ZONE s.tz), 'YYYY-MM-DD') AS day,
                  sum(m.cost_usd_estimate)::text                AS cost,
                  sum(m.input_tokens + m.output_tokens)::text   AS tokens
             FROM model_calls m, s
            WHERE m.workspace_id = $1
              AND m.created_at >= (date_trunc('day', now() AT TIME ZONE s.tz) - interval '1 day') AT TIME ZONE s.tz
              AND m.created_at <   date_trunc('day', now() AT TIME ZONE s.tz) AT TIME ZONE s.tz
            GROUP BY 1`,
          [workspaceId],
        );
        for (const row of rows) {
          if (
            recordDailySpend(env, workspaceId, {
              day: row.day,
              costUsd: Number(row.cost) || 0,
              tokens: Number(row.tokens) || 0,
            })
          ) {
            spendPoints += 1;
          }
        }
      });
    } catch (error) {
      // One workspace's failure must not stop the others: the whole point of
      // the nightly pass is that it covers every tenant, and a tenant with a
      // broken settings row should cost that tenant a night, not everyone.
      logEvent({ at: 'cron.nightly', ok: false, workspace_id: workspaceId, error: String(error) });
    }
  }

  const result = { workspaces: workspaces.length, backups, exports, reverifications, spendPoints };
  logEvent({ at: 'cron.nightly', ...result, weekly });
  return result;
}
