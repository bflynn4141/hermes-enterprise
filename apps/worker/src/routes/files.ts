// Context sources: `agent_files`, over the same storage and the same queue.
//
// A Context source is a file an Admin adds to the agent's Context pane — a
// policy, a rubric, a form — rather than a file dropped on one turn. It is the
// same object in the same bucket with the same sniff, the same hash and the
// same extraction, so these routes are the attachments routes with `kind` set
// to `agent_file`. The differences are two, and both are in the service:
//
//   * an `agent_files` row has no `status` column; it is `ready` once it has a
//     hash, which is exactly when `complete` succeeded;
//   * deleting one deletes the row, because a Context source is a setting
//     rather than history, whereas an attachment is soft-deleted so that a
//     message still referencing it keeps rendering.
//
// Adding or removing one is an Admin's act: Context is the agent's standing
// instruction material, and a Member changing it would change how every future
// run behaves for everyone.
import type { Context } from 'hono';
import { attachmentDetailSchema } from '@hermes/shared';
import type { Env } from '../env.js';
import { inWorkspace, RouteError } from './tenant.js';
import {
  completeAttachmentRoute,
  createAttachmentRoute,
  deleteAttachmentRoute,
  directUploadRoute,
  getAttachmentRoute,
} from './attachments.js';
import { toAttachment, type FileRow } from '../attachments/service.js';
import { requireAgentContextAccess } from '../domain/agent-context-access.js';

export const createFile = async (c: Context<{ Bindings: Env }>): Promise<Response> => {
  await requireAdminForFiles(c);
  return createAttachmentRoute(c, 'agent_file');
};
export const completeFile = async (c: Context<{ Bindings: Env }>): Promise<Response> => {
  await requireAdminForFiles(c);
  return completeAttachmentRoute(c, 'agent_file');
};
export const getFile = (c: Context<{ Bindings: Env }>): Promise<Response> => getAttachmentRoute(c, 'agent_file');
export const deleteFile = async (c: Context<{ Bindings: Env }>): Promise<Response> => {
  await requireAdminForFiles(c);
  return deleteAttachmentRoute(c, 'agent_file');
};
export const uploadFile = async (c: Context<{ Bindings: Env }>): Promise<Response> => {
  await requireAdminForFiles(c);
  return directUploadRoute(c, 'agent_file');
};

/**
 * The Admin check, in its own transaction ahead of the work.
 *
 * It costs one round trip rather than threading a flag through the shared
 * service, and the alternative — a `requireAdmin` parameter on every shared
 * function — is the kind of option that eventually gets passed `false`.
 */
async function requireAdminForFiles(c: Context<{ Bindings: Env }>): Promise<void> {
  await inWorkspace(c, async (work) => {
    work.requireAdmin('changing the agent Context');
  });
}

/** GET /w/:ws/files — the Context pane's list. */
export async function listFiles(c: Context<{ Bindings: Env }>): Promise<Response> {
  const rows = await inWorkspace(c, async (work) => {
    const selected=c.req.query('agent_id');
    if(!selected||!/^[0-9a-f-]{36}$/i.test(selected))throw new RouteError('Select an agent','bad_id',400);
    await requireAgentContextAccess(work, selected);
    const { rows } = await work.tx.query<FileRow>(
      `SELECT id, name, storage_key, size_bytes, mime, sha256,
              extraction_status, extraction_error, text_length, token_estimate, created_at
         FROM agent_files
        WHERE workspace_id = $1 AND agent_id=$2
        ORDER BY created_at DESC
        LIMIT 200`,
      [work.workspaceId, selected??null],
    );
    return rows;
  });

  return c.json({
    items: rows.map((row) =>
      attachmentDetailSchema.parse({
        ...toAttachment(row),
        kind: 'agent_file',
        extraction_status: row.extraction_status,
        extraction_error: row.extraction_error,
        text_length: row.text_length,
        token_estimate: row.token_estimate,
        created_at: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
        // The list does not mint a URL per row: a presigned GET is a bearer
        // credential, and minting two hundred of them to render a list is two
        // hundred credentials nobody asked for. The viewer asks for one.
        url: null,
        url_expires_at: null,
      }),
    ),
    cursor: null,
    total: rows.length,
  });
}
