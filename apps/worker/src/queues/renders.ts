// The `renders` consumer: a document version becomes a file in the store.
//
// The shape around the renderer was written in M1 and has not changed, because
// it is the part that is wrong in production if it is written in a hurry
// alongside the renderer: dedupe on `(document_id, version)`, per-message ack
// and retry, and a dead-letter consumer that writes the failure onto the row so
// that no document says "preparing" forever.
//
// What M4 filled in is the middle: the payload is rendered to a self-contained
// HTML file and put in R2 beside the uploads (src/documents/render.ts). The PDF
// is not, and the row says which of the two happened with two separate statuses
// rather than one that would have to lie about one of them — see
// docs/DECISIONS.md, D-7, for the workerd WebAssembly spike that settled it.
//
// Failure handling, in three kinds:
//
//   * a message that does not parse is acked and logged. A malformed message is
//     not going to parse on the fourth attempt either, and retrying it would
//     ride it into the dead-letter queue where it would still not parse;
//   * a payload that no longer validates against its schema is a *permanent*
//     failure with a reason, written onto the row and acked — the reviewer sees
//     "the document payload does not match the invoice schema" rather than a
//     document that never arrives;
//   * anything else — the database is unreachable, R2 refused the put — is
//     retried, because those are exactly the failures a retry fixes.
import type { Env } from '../env.js';
import { withWorkspaceTransaction } from '../jobs.js';
import { renderDocumentVersion } from '../documents/render.js';
import { renderMessageSchema, type RenderMessage } from './messages.js';

/** True when this version has already been rendered. Queues are at-least-once. */
export async function alreadyRendered(env: Env, message: RenderMessage): Promise<boolean> {
  return withWorkspaceTransaction(env, message.workspace_id, async (tx) => {
    const { rows } = await tx.query<{ render_status: string }>(
      `SELECT render_status FROM documents
        WHERE workspace_id = $1 AND id = $2 AND version = $3`,
      [message.workspace_id, message.document_id, message.version],
    );
    return rows[0]?.render_status === 'ready';
  });
}

/** Write a render outcome onto the document row. Used by M4 and by the DLQ. */
export async function markRender(
  env: Env,
  message: Pick<RenderMessage, 'workspace_id' | 'document_id'>,
  status: 'ready' | 'failed',
  error: string | null,
): Promise<void> {
  await withWorkspaceTransaction(env, message.workspace_id, async (tx) => {
    await tx.query(
      `UPDATE documents SET render_status = $3, render_error = $4, updated_at = now()
        WHERE workspace_id = $1 AND id = $2`,
      [message.workspace_id, message.document_id, status, error?.slice(0, 1000) ?? null],
    );
  });
}

export async function rendersBatch(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    const parsed = renderMessageSchema.safeParse(message.body);
    if (!parsed.success) {
      console.log(JSON.stringify({ at: 'queue.renders', ok: false, error: 'unparseable message' }));
      message.ack();
      continue;
    }
    const { workspace_id: workspaceId, document_id: documentId, version } = parsed.data;
    try {
      const outcome = await renderDocumentVersion(env, workspaceId, documentId, version);
      console.log(
        JSON.stringify({ at: 'queue.renders', document_id: documentId, version, outcome: outcome.status }),
      );
      // Every outcome here is terminal, including `missing`: a document row
      // that is not there has been erased or was never committed, and a message
      // about it is not going to find it on the fourth attempt.
      message.ack();
    } catch (error) {
      // Transient by elimination: the schema parsed and the render is
      // deterministic, so what is left is the database or the object store.
      console.log(JSON.stringify({ at: 'queue.renders', ok: false, document_id: documentId, error: String(error) }));
      message.retry();
    }
  }
}
