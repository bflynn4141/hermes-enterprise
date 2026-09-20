// Declaring, completing, reading and deleting an upload.
//
// One module for two tables. `attachments` is a file on a turn; `agent_files`
// is a Context source. They are the same object in the same bucket with the
// same extraction path, and the only differences are which row the id points at
// and whether it hangs off a session or an agent — so the difference is a
// parameter, not a second implementation. A second implementation is how the
// sniff ends up on one path and not the other.
//
// The order in `complete` is the part worth reading:
//
//   1. head the object, and compare its size with the declared size;
//   2. stream it back through `get()` and hash it while sniffing the head;
//   3. on any disagreement, mark the row `failed`, delete the object, refuse;
//   4. only then mark `ready` and enqueue `extract`.
//
// Deleting on refusal matters. An object we declined to account for is an
// object the daily sweep would eventually remove, and "eventually" is not the
// answer for a file we just decided was lying about what it is.
import { requireAgentContextAccess } from '../domain/agent-context-access.js';
import {
  ATTACHMENT_MAX_BYTES,
  ATTACHMENT_PRESIGN_SECONDS,
  ATTACHMENT_VIEW_SECONDS,
  attachmentDeclarationSchema,
  type AttachmentDeclaration,
  type AttachmentKind,
} from '@hermes/shared';
import { isDevelopment, type Env } from '../env.js';
import { RouteError, type TenantWork } from '../routes/tenant.js';
import { consumeRate, LIMITS } from '../auth/rate-limit.js';
import { uploadKey } from '../storage/keys.js';
import { getObject, headObject, presignGet, presignPut, presigningAvailable } from '../storage/r2.js';
import { sha256Hex } from '../storage/sigv4.js';
import { SNIFF_BYTES, sniff } from './sniff.js';

/** Which table an id lives in. Everything else about the two is identical. */
export const TABLES: Record<AttachmentKind, 'attachments' | 'agent_files'> = {
  attachment: 'attachments',
  agent_file: 'agent_files',
};

export interface FileRow {
  id: string;
  name: string;
  storage_key: string | null;
  size_bytes: number | string | null;
  mime: string | null;
  sha256: string | null;
  status?: string;
  extraction_status: string;
  extraction_error: string | null;
  text_length: number | null;
  token_estimate: number | null;
  created_at: Date;
}

/**
 * The wire shape, from either table.
 *
 * `agent_files` has no `status` column: a Context source is only ever listed
 * once it exists, and its interesting state is the extraction. It reports
 * `ready` once it has a hash, which is exactly when `complete` succeeded.
 */
export function toAttachment(row: FileRow): {
  id: string;
  name: string;
  size: number;
  mime: string;
  sha256: string | null;
  status: string;
} {
  return {
    id: row.id,
    name: row.name,
    size: Number(row.size_bytes ?? 0),
    mime: row.mime ?? 'text/plain',
    sha256: row.sha256,
    status: row.status ?? (row.sha256 ? 'ready' : 'uploading'),
  };
}

const SELECT_ATTACHMENT = `id, name, storage_key, size_bytes, mime, sha256, status,
         extraction_status, extraction_error, text_length, token_estimate, created_at`;
const SELECT_AGENT_FILE = `id, agent_id, name, storage_key, size_bytes, mime, sha256,
         extraction_status, extraction_error, text_length, token_estimate, created_at`;

export async function loadRow(work: TenantWork, kind: AttachmentKind, id: string): Promise<FileRow> {
  const { rows } =
    kind === 'attachment'
      ? await work.tx.query<FileRow>(
          `SELECT ${SELECT_ATTACHMENT} FROM attachments
            WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL`,
          [work.workspaceId, id],
        )
      : await work.tx.query<FileRow>(
          `SELECT ${SELECT_AGENT_FILE} FROM agent_files WHERE workspace_id = $1 AND id = $2`,
          [work.workspaceId, id],
        );
  const row = rows[0];
  if (!row) throw new RouteError('no such file', 'unknown_attachment', 404);
  if (kind === 'agent_file') {
    const agentId = (row as FileRow & { agent_id: string | null }).agent_id;
    if (!agentId) throw new RouteError('Source is not assigned to an agent', 'unknown_attachment', 404);
    await requireAgentContextAccess(work, agentId);
  }
  return row;
}

/**
 * Declare an upload: one row, one key, one presigned PUT.
 *
 * The row is written first and the URL is minted for the key that row names, so
 * there is no moment where a URL exists for an object nothing is accounting
 * for. The reverse order would hand out a writable URL and then maybe fail to
 * record it.
 *
 * The rate limit is consumed inside the caller's transaction (see
 * auth/rate-limit.ts): an attempt that fails for another reason gives its count
 * back with the rollback.
 */
export async function declareUpload(
  env: Env,
  work: TenantWork,
  kind: AttachmentKind,
  input: unknown,
): Promise<{ row: FileRow; storageKey: string; declaration: AttachmentDeclaration }> {
  requireUploadConfiguration(env);
  const parsed = attachmentDeclarationSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new RouteError(
      issue ? `${issue.path.join('.') || 'body'}: ${issue.message}` : 'the declaration is not valid',
      // A size over the cap is its own reason, because the client's copy for it
      // is a number the person can act on rather than "invalid".
      issue?.path[0] === 'size' ? 'too_large' : 'bad_declaration',
      issue?.path[0] === 'size' ? 422 : 400,
    );
  }
  const declaration = parsed.data;
  if (declaration.size > ATTACHMENT_MAX_BYTES) {
    throw new RouteError(`a file may be at most ${ATTACHMENT_MAX_BYTES} bytes`, 'too_large', 422);
  }

  await consumeRate(work.tx, work.userId, work.workspaceId, LIMITS.upload);

  // `session_id` is client-supplied and was written to the row unchecked
  // (security review O7). Row-level security kept it inside the workspace, but
  // inside a workspace it named *any* session, so a member could hang a file
  // off somebody else's conversation — where it renders in that person's
  // transcript and is read by their runs. The rule is the same one
  // `routes/sessions.ts` applies everywhere else: your own session, or nothing.
  if (kind === 'attachment' && declaration.session_id) {
    const { rows } = await work.tx.query<{ id: string }>(
      `SELECT id FROM sessions WHERE workspace_id = $1 AND id = $2 AND owner_id = $3`,
      [work.workspaceId, declaration.session_id, work.userId],
    );
    if (!rows[0]) throw new RouteError('no such session', 'unknown_session', 404);
  }

  const id = crypto.randomUUID();
  if (kind === 'agent_file') {
    if (!declaration.agent_id) throw new RouteError('Select an agent', 'bad_id', 400);
    await requireAgentContextAccess(work, declaration.agent_id);
  }
  const storageKey = uploadKey(work.workspaceId, id);

  const { rows } =
    kind === 'attachment'
      ? await work.tx.query<FileRow>(
          `INSERT INTO attachments
             (id, workspace_id, session_id, name, storage_key, size_bytes, mime, uploaded_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING ${SELECT_ATTACHMENT}`,
          [
            id,
            work.workspaceId,
            declaration.session_id ?? null,
            declaration.name,
            storageKey,
            declaration.size,
            declaration.mime,
            work.userId,
          ],
        )
      : await work.tx.query<FileRow>(
          `INSERT INTO agent_files
             (id, workspace_id, agent_id, name, storage_key, size_bytes, mime, uploaded_by)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
           RETURNING ${SELECT_AGENT_FILE}`,
          [
            id,
            work.workspaceId,
            declaration.agent_id ?? null,
            declaration.name,
            storageKey,
            declaration.size,
            declaration.mime,
            work.userId,
          ],
        );

  const row = rows[0];
  if (!row) throw new RouteError('the attachment was not created', 'create_failed', 409);
  return { row, storageKey, declaration };
}

export interface UploadTarget {
  method: 'PUT';
  url: string;
  expires_at: string;
  headers: Record<string, string>;
  direct: boolean;
}

/**
 * Where the browser should PUT the bytes.
 *
 * With S3 credentials: R2 itself, for fifteen minutes. Without them — local
 * development — this Worker's own dev-only route, clearly marked `direct`. The
 * route refuses to exist outside development, so the fallback cannot become an
 * unsigned upload endpoint in production by accident.
 */
export async function uploadTarget(
  env: Env,
  origin: string,
  kind: AttachmentKind,
  workspaceId: string,
  id: string,
  storageKey: string,
  mime: string,
): Promise<UploadTarget> {
  requireUploadConfiguration(env);
  if (presigningAvailable(env)) {
    const signed = await presignPut(env, storageKey, ATTACHMENT_PRESIGN_SECONDS);
    return {
      method: 'PUT',
      url: signed.url,
      expires_at: signed.expiresAt.toISOString(),
      // The type is not signed, so R2 will store whatever the browser sends;
      // `complete` is what decides whether the bytes match the declaration.
      headers: { 'content-type': mime },
      direct: false,
    };
  }
  const path = kind === 'attachment' ? 'attachments' : 'files';
  return {
    method: 'PUT',
    url: `${origin}/w/${workspaceId}/${path}/${id}/upload`,
    expires_at: new Date(Date.now() + ATTACHMENT_PRESIGN_SECONDS * 1000).toISOString(),
    headers: { 'content-type': mime },
    direct: true,
  };
}

function requireUploadConfiguration(env: Env): void {
  if (!isDevelopment(env) && !presigningAvailable(env)) {
    throw new RouteError('File uploads are unavailable until storage is configured. Contact your workspace administrator.', 'uploads_unavailable', 503);
  }
}

/** What verification concluded about the bytes. */
export type Verdict =
  | { readonly ok: true; readonly digest: string }
  | { readonly ok: false; readonly reason: string; readonly detail: string; readonly status: 409 | 422 };

/**
 * Verify the bytes. No transaction is open while this runs.
 *
 * Two reasons it is not inside one. The first is correctness: a refusal has to
 * be *recorded*, and marking the row failed inside the transaction whose error
 * rolls back is a refusal nobody can see — the row sits at `uploading` forever
 * and the sweep eventually deletes the object underneath it. A test pins this
 * down. The second is capacity: this streams up to 20 MB, and a Postgres
 * connection held open for the length of a download is a connection out of a
 * budget the plan alarms on at 150.
 *
 * Streamed where the runtime allows it. Web Crypto's `digest` needs the whole
 * buffer, which for a 20 MB object is 20 MB of isolate memory held while we
 * hash it; workerd's `crypto.DigestStream` hashes a chunk at a time instead.
 * Node — where the `db` project runs this same code against real Postgres — has
 * no `DigestStream`, so there is a buffered fallback, bounded by the size check
 * that runs before it.
 */
export async function verifyObject(env: Env, row: FileRow): Promise<Verdict> {
  if (!row.storage_key) {
    return { ok: false, reason: 'no_object', detail: 'this file has no object', status: 409 };
  }
  const head = await headObject(env, row.storage_key);
  if (!head) {
    return { ok: false, reason: 'no_object', detail: 'the object was not uploaded', status: 409 };
  }

  const declaredSize = Number(row.size_bytes ?? 0);
  if (head.size !== declaredSize) {
    return {
      ok: false,
      reason: 'size_mismatch',
      detail: `declared ${declaredSize} bytes, stored ${head.size}`,
      status: 422,
    };
  }
  if (head.size > ATTACHMENT_MAX_BYTES) {
    return {
      ok: false,
      reason: 'too_large',
      detail: `a file may be at most ${ATTACHMENT_MAX_BYTES} bytes`,
      status: 422,
    };
  }

  const object = await getObject(env, row.storage_key);
  if (!object) {
    return { ok: false, reason: 'no_object', detail: 'the object was not uploaded', status: 409 };
  }

  const { head: firstBytes, digest, size } = await hashAndHead(object);
  if (size !== declaredSize) {
    // The head said one thing and the stream another. Rare, and exactly the
    // case a second check is for.
    return {
      ok: false,
      reason: 'size_mismatch',
      detail: `declared ${declaredSize} bytes, read ${size}`,
      status: 422,
    };
  }

  const sniffed = sniff(row.mime ?? '', firstBytes);
  if (!sniffed.ok) {
    return {
      ok: false,
      reason: sniffed.reason ?? 'magic_mismatch',
      detail: sniffed.detail ?? 'the file is not what it says it is',
      status: 422,
    };
  }
  return { ok: true, digest };
}

/**
 * Write the verdict onto the row, in its own transaction.
 *
 * Both outcomes commit. A refusal that rolled back would leave the row saying
 * `uploading` about bytes we have already decided to delete.
 */
export async function recordVerdict(
  work: TenantWork,
  kind: AttachmentKind,
  id: string,
  verdict: Verdict,
): Promise<FileRow | null> {
  // Object verification runs outside the initial transaction. Recheck the
  // current binding before committing either success or destructive refusal.
  if (kind === 'agent_file') await loadRow(work, kind, id);
  if (verdict.ok) return markReady(work, kind, id, verdict.digest);
  await markFailed(work, kind, id, verdict.reason, verdict.detail);
  return null;
}

/** Already done? Two tabs finishing one upload is one completion. */
export const isComplete = (row: FileRow, kind: AttachmentKind): boolean =>
  kind === 'attachment' ? row.status === 'ready' : Boolean(row.sha256);

interface StreamedDigest {
  readonly head: Uint8Array;
  readonly digest: string;
  readonly size: number;
}

/** The first `SNIFF_BYTES` and a sha256 of the whole object, in one pass. */
async function hashAndHead(object: R2ObjectBody): Promise<StreamedDigest> {
  const DigestStream = (crypto as { DigestStream?: new (algorithm: string) => WritableStream<BufferSource> })
    .DigestStream;
  if (!DigestStream) {
    const bytes = new Uint8Array(await object.arrayBuffer());
    return { head: bytes.subarray(0, SNIFF_BYTES), digest: await sha256Hex(bytes), size: bytes.byteLength };
  }

  const stream = new DigestStream('SHA-256');
  const writer = stream.getWriter();
  const reader = object.body.getReader();
  const head = new Uint8Array(SNIFF_BYTES);
  let headLength = 0;
  let size = 0;

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const chunk = value as Uint8Array;
    size += chunk.byteLength;
    if (headLength < SNIFF_BYTES) {
      const take = Math.min(SNIFF_BYTES - headLength, chunk.byteLength);
      head.set(chunk.subarray(0, take), headLength);
      headLength += take;
    }
    await writer.write(chunk);
  }
  await writer.close();

  const digest = [...new Uint8Array(await (stream as unknown as { digest: Promise<ArrayBuffer> }).digest)]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return { head: head.subarray(0, headLength), digest, size };
}

async function markReady(work: TenantWork, kind: AttachmentKind, id: string, digest: string): Promise<FileRow> {
  const { rows } =
    kind === 'attachment'
      ? await work.tx.query<FileRow>(
          `UPDATE attachments
              SET status = 'ready', status_reason = NULL, sha256 = $3,
                  completed_at = now(), updated_at = now()
            WHERE workspace_id = $1 AND id = $2
            RETURNING ${SELECT_ATTACHMENT}`,
          [work.workspaceId, id, digest],
        )
      : await work.tx.query<FileRow>(
          `UPDATE agent_files SET sha256 = $3, updated_at = now()
            WHERE workspace_id = $1 AND id = $2
            RETURNING ${SELECT_AGENT_FILE}`,
          [work.workspaceId, id, digest],
        );
  const row = rows[0];
  if (!row) throw new RouteError('no such file', 'unknown_attachment', 404);
  return row;
}

async function markFailed(
  work: TenantWork,
  kind: AttachmentKind,
  id: string,
  reason: string,
  detail: string,
): Promise<void> {
  const message = `${reason}: ${detail}`.slice(0, 1000);
  if (kind === 'attachment') {
    await work.tx.query(
      `UPDATE attachments
          SET status = 'failed', status_reason = $3,
              extraction_status = 'failed', extraction_error = $3, updated_at = now()
        WHERE workspace_id = $1 AND id = $2`,
      [work.workspaceId, id, message],
    );
  } else {
    await work.tx.query(
      `UPDATE agent_files
          SET extraction_status = 'failed', extraction_error = $3, updated_at = now()
        WHERE workspace_id = $1 AND id = $2`,
      [work.workspaceId, id, message],
    );
  }
}

/** Soft-delete the row; the caller deletes the objects after the commit. */
export async function markDeleted(work: TenantWork, kind: AttachmentKind, id: string): Promise<void> {
  if (kind === 'attachment') {
    // Soft, because a message may still reference it and History has to keep
    // rendering: the viewer shows "no longer available" rather than a hole.
    await work.tx.query(
      `UPDATE attachments SET status = 'deleted', deleted_at = now(), updated_at = now()
        WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL`,
      [work.workspaceId, id],
    );
  } else {
    // A Context source is a setting, not history: removing it removes the row.
    await work.tx.query(`DELETE FROM agent_files WHERE workspace_id = $1 AND id = $2`, [work.workspaceId, id]);
  }
}

/** A short-lived presigned GET for the viewer, or null where none can be minted. */
export async function viewUrl(
  env: Env,
  row: FileRow,
): Promise<{ url: string | null; expiresAt: string | null }> {
  if (!row.storage_key || !presigningAvailable(env)) return { url: null, expiresAt: null };
  const signed = await presignGet(env, row.storage_key, ATTACHMENT_VIEW_SECONDS, row.name);
  return { url: signed.url, expiresAt: signed.expiresAt.toISOString() };
}
