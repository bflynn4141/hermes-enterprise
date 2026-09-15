// Attachments: the four routes a file passes through, plus a dev-only fifth.
//
//   POST   /w/:ws/attachments              declare, and mint a presigned PUT
//   PUT    /w/:ws/attachments/:id/upload   development only; see below
//   POST   /w/:ws/attachments/:id/complete verify the bytes, enqueue `extract`
//   GET    /w/:ws/attachments/:id          metadata, plus a viewer URL
//   DELETE /w/:ws/attachments/:id          soft-delete the row, drop the objects
//
// Three properties hold across all of them:
//
//   * `workspace_id` comes from the path and nowhere else, like every tenant
//     route (CONVENTIONS, invariant 7), and the object key is derived from it,
//     so one workspace cannot mint a URL into another's prefix even if it
//     guesses an id.
//   * The queue send happens *after* the transaction commits. A message sent
//     inside one can be delivered before the row it is about exists, and an
//     `extract` consumer that cannot find its row has no honest answer.
//   * The object deletion happens after the commit too, for the same reason in
//     reverse: a rolled-back transaction must not leave the bytes gone.
import type { Context } from 'hono';
import { attachmentDetailSchema, attachmentSchema, attachmentUploadSchema } from '@hermes/shared';
import type { Env } from '../env.js';
import { isDevelopment } from '../env.js';
import { requireCsrf, requireOrigin } from '../auth.js';
import { inWorkspace, jsonBody, pathUuid, RouteError } from './tenant.js';
import {
  declareUpload,
  isComplete,
  loadRow,
  markDeleted,
  recordVerdict,
  toAttachment,
  uploadTarget,
  verifyObject,
  viewUrl,
  type FileRow,
} from '../attachments/service.js';
import { enqueueExtract } from '../queues/index.js';
import { deleteObject, headObject, putObject } from '../storage/r2.js';
import { textKey, uploadKey } from '../storage/keys.js';
import { ATTACHMENT_MAX_BYTES, type AttachmentKind } from '@hermes/shared';

/**
 * Shared by `attachments.ts` and `files.ts`: the two differ only in which table
 * the id lives in and which path the dev upload route sits at.
 */
export async function createAttachmentRoute(
  c: Context<{ Bindings: Env }>,
  kind: AttachmentKind,
): Promise<Response> {
  requireOrigin(c, { required: false });
  requireCsrf(c);
  const input = await jsonBody<unknown>(c);
  const origin = new URL(c.req.url).origin;

  const declared = await inWorkspace(c, async (work) => {
    const { row, storageKey } = await declareUpload(c.env, work, kind, input);
    return { row, storageKey, workspaceId: work.workspaceId };
  });

  // Minted after the commit: a URL for a row that rolled back is a writable URL
  // for an object nothing accounts for.
  const target = await uploadTarget(
    c.env,
    origin,
    kind,
    declared.workspaceId,
    declared.row.id,
    declared.storageKey,
    declared.row.mime ?? 'text/plain',
  );

  return c.json(
    attachmentUploadSchema.parse({ attachment: attachmentSchema.parse(toAttachment(declared.row)), upload: target }),
    201,
  );
}

/**
 * Verify the bytes and, if they are what was declared, mark the row ready.
 *
 * Three phases, in three separate steps, and the separation is the point:
 *
 *   1. one transaction to load the row, which is also the membership check;
 *   2. verification with no transaction open — it streams up to 20 MB, and a
 *      Postgres connection held for the length of a download is one out of a
 *      budget the plan alarms on at 150;
 *   3. one transaction to record the verdict, which *commits either way*. A
 *      refusal recorded inside a transaction that then rolls back is a row that
 *      says `uploading` forever about bytes we have already decided to delete.
 */
export async function completeAttachmentRoute(
  c: Context<{ Bindings: Env }>,
  kind: AttachmentKind,
): Promise<Response> {
  requireOrigin(c, { required: false });
  requireCsrf(c);
  const id = pathUuid(c, 'id');

  const loaded = await inWorkspace(c, async (work) => ({
    row: await loadRow(work, kind, id),
    workspaceId: work.workspaceId,
  }));

  if (isComplete(loaded.row, kind)) {
    // Idempotent: two tabs finishing the same upload is one completion, and the
    // second gets the same answer rather than a conflict.
    return c.json(attachmentSchema.parse(toAttachment(loaded.row)));
  }

  const verdict = await verifyObject(c.env, loaded.row);
  const recorded = await inWorkspace(c, (work) => recordVerdict(work, kind, id, verdict));

  if (!verdict.ok) {
    // The object goes with the refusal, after the commit that recorded it.
    // Leaving it for the daily sweep means a file we have just decided is
    // lying about what it is sits in the workspace's store for a day.
    if (loaded.row.storage_key) {
      await deleteObject(c.env, [loaded.row.storage_key, textKey(loaded.row.storage_key)]);
    }
    throw new RouteError(verdict.detail, verdict.reason, verdict.status);
  }
  if (!recorded) throw new RouteError('no such file', 'unknown_attachment', 404);

  // After the commit, for the reason in the header comment: a queue message can
  // be delivered before an uncommitted row exists.
  await enqueueExtract(c.env, {
    workspace_id: loaded.workspaceId,
    kind,
    id: recorded.id,
    storage_key: loaded.row.storage_key as string,
    mime: recorded.mime ?? 'text/plain',
  });

  return c.json(attachmentSchema.parse(toAttachment(recorded)));
}

export async function getAttachmentRoute(c: Context<{ Bindings: Env }>, kind: AttachmentKind): Promise<Response> {
  const id = pathUuid(c, 'id');
  const row = await inWorkspace(c, (work) => loadRow(work, kind, id));
  const view = await viewUrl(c.env, row);
  return c.json(attachmentDetailSchema.parse(detail(row, kind, view)));
}

function detail(
  row: FileRow,
  kind: AttachmentKind,
  view: { url: string | null; expiresAt: string | null },
): unknown {
  return {
    ...toAttachment(row),
    kind,
    extraction_status: row.extraction_status,
    extraction_error: row.extraction_error,
    text_length: row.text_length,
    token_estimate: row.token_estimate,
    created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    url: view.url,
    url_expires_at: view.expiresAt,
  };
}

export async function deleteAttachmentRoute(c: Context<{ Bindings: Env }>, kind: AttachmentKind): Promise<Response> {
  requireOrigin(c, { required: false });
  requireCsrf(c);
  const id = pathUuid(c, 'id');

  const removed = await inWorkspace(c, async (work) => {
    const row = await loadRow(work, kind, id);
    await markDeleted(work, kind, id);
    return { storageKey: row.storage_key };
  });

  if (removed.storageKey) {
    // After the commit. The reverse order would delete the bytes for a
    // transaction that then rolled back.
    await deleteObject(c.env, [removed.storageKey, textKey(removed.storageKey)]);
  }
  return c.body(null, 204);
}

/**
 * Development only: PUT the bytes through the Worker.
 *
 * `wrangler dev --local` simulates R2 on disk. There is no account behind it and
 * therefore no S3 credentials to sign a presigned URL with, so without this
 * route a local upload would be impossible and the whole path untestable
 * locally. It exists so that the *same* client code runs in both places: the
 * client PUTs to whatever URL `POST /attachments` gave it.
 *
 * Two things keep it from being an unsigned upload endpoint in production:
 * `ENVIRONMENT` must be development (a deployed environment answers 404, as
 * though the route did not exist), and it still runs inside the tenant
 * transaction, so the caller must be a member of the workspace and the row must
 * already exist in it.
 */
export async function directUploadRoute(c: Context<{ Bindings: Env }>, kind: AttachmentKind): Promise<Response> {
  if (!isDevelopment(c.env)) {
    // Not 403: outside development this route does not exist, and saying "you
    // may not" would advertise that it might.
    throw new RouteError('not found', 'unknown_route', 404);
  }
  requireOrigin(c, { required: false });
  const id = pathUuid(c, 'id');

  const target = await inWorkspace(c, async (work) => {
    const row = await loadRow(work, kind, id);
    return { storageKey: row.storage_key ?? uploadKey(work.workspaceId, id), mime: row.mime ?? 'text/plain' };
  });

  const declaredLength = Number(c.req.header('content-length') ?? '0');
  if (declaredLength > ATTACHMENT_MAX_BYTES) {
    throw new RouteError(`a file may be at most ${ATTACHMENT_MAX_BYTES} bytes`, 'too_large', 422);
  }
  const body = await c.req.arrayBuffer();
  if (body.byteLength > ATTACHMENT_MAX_BYTES) {
    throw new RouteError(`a file may be at most ${ATTACHMENT_MAX_BYTES} bytes`, 'too_large', 422);
  }

  await putObject(c.env, target.storageKey, body, { httpMetadata: { contentType: target.mime } });
  const stored = await headObject(c.env, target.storageKey);
  return c.json({ ok: true, size: stored?.size ?? body.byteLength });
}

// The bound forms Hono registers. `attachments` is the turn-facing table.
export const createAttachment = (c: Context<{ Bindings: Env }>): Promise<Response> =>
  createAttachmentRoute(c, 'attachment');
export const completeAttachment = (c: Context<{ Bindings: Env }>): Promise<Response> =>
  completeAttachmentRoute(c, 'attachment');
export const getAttachment = (c: Context<{ Bindings: Env }>): Promise<Response> =>
  getAttachmentRoute(c, 'attachment');
export const deleteAttachment = (c: Context<{ Bindings: Env }>): Promise<Response> =>
  deleteAttachmentRoute(c, 'attachment');
export const uploadAttachment = (c: Context<{ Bindings: Env }>): Promise<Response> =>
  directUploadRoute(c, 'attachment');
