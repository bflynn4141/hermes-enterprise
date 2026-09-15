// Object keys, in one place.
//
// The workspace is the first segment of every key. That is not tidiness: it is
// what makes erasure a prefix delete and what lets the daily orphan sweep ask
// the right tenant about an object without a database role that can read every
// tenant's rows (migration 0008 explains why no such role exists).
//
//     w/{workspace}/uploads/{attachment}        the bytes as uploaded
//     w/{workspace}/uploads/{attachment}.txt    the extracted text
//     w/{workspace}/documents/{document}...     M4's rendered documents
//
// The extracted text sits next to the object rather than in Postgres because it
// can be megabytes, it is derived, and a row that holds it turns every `SELECT
// *` on the table into a transfer of the whole corpus.

/** Everything belonging to one workspace. The erasure path deletes this. */
export const workspacePrefix = (workspaceId: string): string => `w/${workspaceId}/`;

/** Just the uploads, which is what the nightly backup copies. */
export const uploadsPrefix = (workspaceId: string): string => `w/${workspaceId}/uploads/`;

export const uploadKey = (workspaceId: string, id: string): string => `w/${workspaceId}/uploads/${id}`;

/** The extracted text, always the object's key plus `.txt`. */
export const textKey = (storageKey: string): string => `${storageKey}.txt`;

/** True for the `.txt` companions, which the sweep must not treat as orphans. */
export const isTextKey = (key: string): boolean => key.endsWith('.txt');

const KEY_PATTERN = /^w\/([0-9a-f-]{36})\/uploads\/([0-9a-f-]{36})$/i;

/**
 * Read a key back into the two ids it was built from.
 *
 * The sweep lists objects, not rows, so this is how it learns which workspace
 * to open a transaction against. A key that does not parse is not ours and is
 * left alone: deleting an object we cannot account for is exactly the mistake
 * a sweep should never make.
 */
export function parseUploadKey(key: string): { workspaceId: string; id: string } | null {
  const match = KEY_PATTERN.exec(key);
  if (!match?.[1] || !match[2]) return null;
  return { workspaceId: match[1], id: match[2] };
}
