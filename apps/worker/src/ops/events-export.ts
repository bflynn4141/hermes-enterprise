// `events_export`: the weekly audit CSV.
//
// Plan section 5, Backups and restore: "Nightly `pg_dump` from GitHub Actions
// to a separate R2 bucket with a 30-day lifecycle rule, plus the weekly events
// CSV and a copy of the uploads prefix."
//
// Three things a dump does not give you, which is why this exists separately:
//
//   A dump is one file for the whole database, and restoring it to read one
//   workspace's audit trail means standing up a Postgres. The CSV is per
//   workspace, per week, and a reviewer can open it.
//
//   A dump is a snapshot of *now*. `events` is append-only and 90 days of
//   stream events age out; a weekly slice keeps the audit trail past the
//   retention of the tables it was derived from.
//
//   A dump is ours to read. This file is the shape an auditor can be handed,
//   and M6 replaces it with the WorkOS Audit Logs emitter — which is the reason
//   the columns here are exactly the columns that emitter would carry.
//
// It writes ids, enum kinds and timestamps. There is no free-text column in
// `events` and that is not an accident: CONVENTIONS says "`events` rows hold
// ids and enum kinds only", which is what makes this file safe to export at
// all, and a test asserts the header list has not grown a payload.
import type { Env } from '../env.js';
import { withWorkspaceTransaction, type Job } from '../jobs.js';
import { logEvent } from '../keys/redact.js';

/** `events_export:{workspace}:{iso-week}` — a key with an id, per the rule. */
export const eventsExportKey = (workspaceId: string, week: string): string => `events_export:${workspaceId}:${week}`;

/**
 * The columns, fixed and asserted by a test.
 *
 * Ids and enums. Adding a column that could carry text turns this file from an
 * audit export into a data export, and the erasure inventory does not cover it.
 */
export const EVENT_CSV_COLUMNS = [
  'id',
  'created_at',
  'actor_type',
  'actor_user_id',
  'kind',
  'request_id',
  'run_id',
  'session_id',
  'decision_id',
  'effect_id',
  'document_id',
  'member_id',
  'invitation_id',
  'subject_id',
  'key_id',
] as const;

/** RFC 4180: quote everything, double the quotes inside. Nulls are empty. */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = value instanceof Date ? value.toISOString() : String(value);
  return `"${text.replace(/"/g, '""')}"`;
}

export function toCsv(rows: readonly Record<string, unknown>[]): string {
  const lines = [EVENT_CSV_COLUMNS.join(',')];
  for (const row of rows) lines.push(EVENT_CSV_COLUMNS.map((column) => csvCell(row[column])).join(','));
  return `${lines.join('\n')}\n`;
}

/** `w/{workspace}/exports/events-{week}.csv`, under the same workspace prefix
 *  everything else uses — so a workspace deletion's prefix delete takes it. */
export const eventsExportObjectKey = (workspaceId: string, week: string): string =>
  `w/${workspaceId}/exports/events-${week}.csv`;

export interface EventsExportResult {
  readonly rows: number;
  readonly key: string;
  readonly configured: boolean;
}

export async function runEventsExport(env: Env, job: Job): Promise<EventsExportResult> {
  const payload = (job.payload ?? {}) as { week?: string; from?: string; to?: string };
  const week = payload.week ?? new Date().toISOString().slice(0, 10);

  const rows = await withWorkspaceTransaction(env, job.workspace_id, async (tx) => {
    const result = await tx.query<Record<string, unknown>>(
      `SELECT ${EVENT_CSV_COLUMNS.join(', ')} FROM events
        WHERE workspace_id = $1
          AND created_at >= COALESCE($2::timestamptz, now() - interval '7 days')
          AND created_at <  COALESCE($3::timestamptz, now())
        ORDER BY created_at, id`,
      [job.workspace_id, payload.from ?? null, payload.to ?? null],
    );
    return result.rows;
  });

  const key = eventsExportObjectKey(job.workspace_id, week);
  const body = toCsv(rows);

  // The backup bucket, not the uploads bucket: this is a copy that has to
  // survive the uploads bucket being wrong. With no backup bucket bound — a
  // development machine — it logs that it did nothing rather than failing
  // forever, exactly as `backup_uploads` does.
  if (!env.BACKUP_UPLOADS) {
    logEvent({ at: 'job.events_export', workspace_id: job.workspace_id, rows: rows.length, note: 'no backup bucket bound' });
    return { rows: rows.length, key, configured: false };
  }

  await env.BACKUP_UPLOADS.put(key, body, {
    httpMetadata: { contentType: 'text/csv; charset=utf-8' },
    customMetadata: { workspace_id: job.workspace_id, week, rows: String(rows.length) },
  });

  logEvent({ at: 'job.events_export', workspace_id: job.workspace_id, rows: rows.length, key });
  return { rows: rows.length, key, configured: true };
}
