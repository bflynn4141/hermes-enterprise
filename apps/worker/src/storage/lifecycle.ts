// The daily sweep: objects nobody is accounting for.
//
// A presigned PUT is a promise the browser may or may not keep. Someone picks a
// file, we mint a URL and write an `uploading` row, the tab closes, the bytes
// land anyway and `complete` is never called. The object is then in the bucket
// with no row that says it is real, and nothing will ever ask about it again.
//
// The plan's rule is the one implemented here: delete objects with no completed
// `attachments` row after 24 hours. Two details make it safe:
//
//   * Age first. An object younger than the presign window is very likely an
//     upload in flight, and a sweep that raced `complete` would delete a file a
//     person is watching upload.
//   * The workspace comes out of the key, and the question is asked inside that
//     workspace's own transaction. No role in this system can read two tenants'
//     rows (migration 0008), so "is this key accounted for?" can only be asked
//     one tenant at a time — and that is a feature, not a workaround.
import type { Env } from '../env.js';
import { withWorkspaceTransaction } from '../jobs.js';
import { deleteObject, listPrefix } from './r2.js';
import { isTextKey, parseUploadKey, textKey } from './keys.js';

/** How long an object may exist unaccounted for. */
export const ORPHAN_AGE_MS = 24 * 60 * 60 * 1000;

export interface SweepResult {
  readonly scanned: number;
  readonly orphans: number;
  readonly deleted: number;
  readonly errors: number;
}

/**
 * One pass over the uploads prefix.
 *
 * `limit` bounds the work because this runs on a Cron handler, which gets 30
 * seconds of CPU at sub-hour intervals; anything left is swept tomorrow, and
 * an orphan costing one more day of storage is not an incident.
 */
export async function sweepOrphanedUploads(env: Env, now = Date.now(), limit = 1000): Promise<SweepResult> {
  const objects = (await listPrefix(env, 'w/')).slice(0, limit);
  let orphans = 0;
  let deleted = 0;
  let errors = 0;

  // Grouped by workspace so the sweep opens one transaction per tenant rather
  // than one per object.
  const candidates = new Map<string, { key: string; id: string }[]>();
  for (const object of objects) {
    // The `.txt` companion is accounted for by its object, not by a row of its
    // own; deleting it here would race the extraction consumer.
    if (isTextKey(object.key)) continue;
    if (now - object.uploaded.getTime() < ORPHAN_AGE_MS) continue;
    const parsed = parseUploadKey(object.key);
    if (!parsed) continue;
    const list = candidates.get(parsed.workspaceId) ?? [];
    list.push({ key: object.key, id: parsed.id });
    candidates.set(parsed.workspaceId, list);
  }

  for (const [workspaceId, entries] of candidates) {
    try {
      const accounted = await withWorkspaceTransaction(env, workspaceId, async (tx) => {
        const { rows } = await tx.query<{ storage_key: string }>(
          `SELECT storage_key FROM attachments
            WHERE workspace_id = $1
              AND storage_key = ANY($2::text[])
              AND status = 'ready'
              AND deleted_at IS NULL
          UNION ALL
           SELECT storage_key FROM agent_files
            WHERE workspace_id = $1 AND storage_key = ANY($2::text[])`,
          [workspaceId, entries.map((e) => e.key)],
        );
        return new Set(rows.map((r) => r.storage_key));
      });

      const unaccounted = entries.filter((entry) => !accounted.has(entry.key));
      orphans += unaccounted.length;
      if (unaccounted.length === 0) continue;
      // The `.txt` goes with it: an extraction that ran before the row was
      // abandoned would otherwise leave the document's text behind.
      await deleteObject(env, unaccounted.flatMap((entry) => [entry.key, textKey(entry.key)]));
      deleted += unaccounted.length;
    } catch (error) {
      // One tenant's failure is not the sweep's failure: tomorrow's pass sees
      // the same objects, and stopping here would spare every workspace after
      // this one in the map.
      errors += 1;
      console.log(
        JSON.stringify({ at: 'sweep.uploads', workspace_id: workspaceId, ok: false, error: String(error) }),
      );
    }
  }

  const result = { scanned: objects.length, orphans, deleted, errors };
  console.log(JSON.stringify({ at: 'sweep.uploads', ...result }));
  return result;
}
