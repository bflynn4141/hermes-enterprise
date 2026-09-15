// The `renders` consumer: the scaffold M4 fills in.
//
// M4 renders a `documents` row's payload to HTML and PDF and puts both in R2
// next to the uploads. What exists now is everything around that: the message
// shape, the dedupe rule, the per-message ack and retry, and the dead-letter
// handling — because those are the parts that are wrong in production if they
// are written in a hurry alongside the renderer.
//
// Dedupe is on `(document_id, version)`, per the plan. A document version is
// immutable once written, so a second message about the same pair is a
// duplicate delivery (queues are at-least-once) and re-rendering it would burn
// CPU to produce the same bytes. The check is "is `render_status` already
// ready for this version" rather than a separate dedupe table.
//
// `@react-pdf/renderer` under workerd is **unverified** in the plan and is not
// a dependency of this Worker. When M4 lands it either works, or the fallback
// is the same one extraction uses: a failed status with an honest reason,
// never a blank document presented as a rendered one.
import type { Env } from '../env.js';
import { withWorkspaceTransaction } from '../jobs.js';
import { renderMessageSchema, type RenderMessage } from './messages.js';

export class RenderUnavailable extends Error {
  constructor(readonly reason = 'renderer_unavailable') {
    super('document rendering lands in M4');
    this.name = 'RenderUnavailable';
  }
}

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

/**
 * One batch.
 *
 * Every message is acked with an honest `failed` status rather than retried:
 * there is no renderer, so three more attempts produce three more nothings, and
 * a message that rode the retries into the dead-letter queue would tell the
 * reviewer "failed" four minutes later than this does.
 */
export async function rendersBatch(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    const parsed = renderMessageSchema.safeParse(message.body);
    if (!parsed.success) {
      console.log(JSON.stringify({ at: 'queue.renders', ok: false, error: 'unparseable message' }));
      message.ack();
      continue;
    }
    try {
      if (await alreadyRendered(env, parsed.data)) {
        message.ack();
        continue;
      }
      await markRender(env, parsed.data, 'failed', 'document rendering lands in M4');
      console.log(
        JSON.stringify({ at: 'queue.renders', document_id: parsed.data.document_id, note: 'renderer lands in M4' }),
      );
      message.ack();
    } catch (error) {
      console.log(JSON.stringify({ at: 'queue.renders', ok: false, error: String(error) }));
      message.retry();
    }
  }
}
