// `backup_uploads`: the nightly copy of one workspace's uploads.
//
// Neon's history window covers the rows. It does not cover R2, and R2 object
// versioning is **likely** absent (plan, section 5), so a deletion or an
// overwrite in the uploads bucket has nothing behind it. The answer is the
// plan's: a copy of the uploads prefix into a separate bucket with its own
// 30-day lifecycle rule, alongside the nightly `pg_dump` and the weekly events
// CSV.
//
// It is a `jobs` row rather than a Cron body because it is per workspace and
// because that is the rule: every cross-system side effect after a commit is a
// job, with a key containing a uuid, retried by the minute Cron until it is
// done. A backup that silently did not run is the failure this repository's
// jobs table exists to prevent.
//
// The binding is optional on purpose. A development machine has no second
// bucket, and a job that failed forever because of that would bury every real
// failure under noise. With no binding it logs that it did nothing and finishes.
import type { Env } from '../env.js';
import { bucket, listPrefix } from './r2.js';
import { uploadsPrefix } from './keys.js';

export interface BackupResult {
  readonly copied: number;
  readonly skipped: number;
  readonly configured: boolean;
}

/** `backup_uploads:{workspace}:{yyyy-mm-dd}` — a key with an id, per the rule. */
export const backupJobKey = (workspaceId: string, day: string): string => `backup_uploads:${workspaceId}:${day}`;

export async function runBackupUploads(env: Env, workspaceId: string): Promise<BackupResult> {
  if (!env.BACKUP_UPLOADS) {
    console.log(JSON.stringify({ at: 'backup.uploads', workspace_id: workspaceId, note: 'no backup bucket bound' }));
    return { copied: 0, skipped: 0, configured: false };
  }

  const objects = await listPrefix(env, uploadsPrefix(workspaceId));
  let copied = 0;
  let skipped = 0;

  for (const object of objects) {
    // Already there and the same bytes: R2 has no server-side copy through the
    // binding, so every copy is a read plus a write, and the etag comparison is
    // what keeps a nightly job from re-uploading the whole corpus every night.
    const existing = await env.BACKUP_UPLOADS.head(object.key);
    if (existing && existing.etag === object.etag) {
      skipped += 1;
      continue;
    }
    const source = await bucket(env).get(object.key);
    if (!source) continue;
    await env.BACKUP_UPLOADS.put(object.key, source.body, {
      httpMetadata: object.httpMetadata,
      customMetadata: object.customMetadata,
    });
    copied += 1;
  }

  const result = { copied, skipped, configured: true };
  console.log(JSON.stringify({ at: 'backup.uploads', workspace_id: workspaceId, ...result }));
  return result;
}
