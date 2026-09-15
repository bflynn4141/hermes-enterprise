// The two object-store hooks the erasure inventory names.
//
// Section 6 of the plan lists R2 in the inventory with "delete by `agent_files`
// and `documents.storage_key`" — that is, by row. These two helpers are the
// store's half of that, and the DSAR and redaction paths call them after their
// transaction has committed: a deletion that happened in the store and rolled
// back in the database is an object nobody can find and nobody can delete
// again, which is the one failure mode an erasure path must not have.
//
// Order, therefore: commit the rows first, delete the objects second, and let
// the daily sweep collect anything the second step dropped. An object with no
// row is garbage the sweep removes after 24 hours; a row with no object is a
// file that renders an honest "no longer available".
import type { Env } from '../env.js';
import { deleteObject, deletePrefix } from './r2.js';
import { textKey, uploadKey, workspacePrefix } from './keys.js';

/**
 * Everything one workspace ever uploaded: the objects, the extracted text, and
 * from M4 the rendered documents. Used by workspace deletion after its 7-day
 * sleep, and by a full DSAR erasure.
 *
 * The prefix is the whole argument for putting the workspace first in the key.
 * The alternative — a list of ids from the database — deletes exactly what the
 * database still remembers, which is not the same set as what is in the bucket,
 * and the difference is precisely the objects nobody is accounting for.
 */
export async function deleteWorkspacePrefix(env: Env, workspaceId: string): Promise<number> {
  const deleted = await deletePrefix(env, workspacePrefix(workspaceId));
  console.log(JSON.stringify({ at: 'erasure.prefix', workspace_id: workspaceId, objects: deleted }));
  return deleted;
}

/**
 * One attachment: the object and its extracted text.
 *
 * Both, always. Leaving the `.txt` behind would leave the document's contents
 * in the store under a key derived from the one we just deleted, which is the
 * kind of half-erasure that is worse than none because it reads as done.
 */
export async function deleteAttachment(env: Env, workspaceId: string, attachmentId: string): Promise<void> {
  const key = uploadKey(workspaceId, attachmentId);
  await deleteObject(env, [key, textKey(key)]);
  console.log(JSON.stringify({ at: 'erasure.attachment', workspace_id: workspaceId, attachment_id: attachmentId }));
}
