// The dead-letter consumers: the reason a row never says "preparing" forever.
//
// A queue with no dead-letter queue deletes a message that exhausts its
// retries. The message is gone, the consumer never got to write anything, and
// the row it was about keeps claiming it is being worked on — a failure whose
// only symptom is silence. Cloudflare's dead-letter queues hold such messages,
// and they expire after four days, so a human reading a dashboard is not a
// plan either.
//
// So both DLQs have a consumer, and the consumer's whole job is to write the
// failure onto the row: `extraction_status = 'failed'` with a reason, or
// `render_status = 'failed'` with a reason. Nothing retries here — this is the
// end of the line, by definition — and every message is acked, because a
// dead-letter message that cannot be acked is one that comes back.
import type { Env } from '../env.js';
import { markExtraction } from './extract.js';
import { markRender } from './renders.js';
import { extractMessageSchema, renderMessageSchema } from './messages.js';

/** What the row says after the retries ran out. Named, because it is user copy. */
export const DLQ_REASON = 'extraction failed after every retry; the file may be damaged or unreadable';
export const DLQ_RENDER_REASON = 'rendering failed after every retry';

export async function extractDlqBatch(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    const parsed = extractMessageSchema.safeParse(message.body);
    if (!parsed.success) {
      console.log(JSON.stringify({ at: 'queue.extract-dlq', ok: false, error: 'unparseable message' }));
      message.ack();
      continue;
    }
    try {
      await markExtraction(env, parsed.data, 'failed', DLQ_REASON);
      console.log(JSON.stringify({ at: 'queue.extract-dlq', id: parsed.data.id, marked: 'failed' }));
    } catch (error) {
      // The database is unreachable. Logged rather than retried: the DLQ's own
      // retry budget is one, and a message that bounces here is a message that
      // expires in four days with nothing written either way.
      console.log(JSON.stringify({ at: 'queue.extract-dlq', ok: false, id: parsed.data.id, error: String(error) }));
    }
    message.ack();
  }
}

export async function rendersDlqBatch(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    const parsed = renderMessageSchema.safeParse(message.body);
    if (!parsed.success) {
      console.log(JSON.stringify({ at: 'queue.renders-dlq', ok: false, error: 'unparseable message' }));
      message.ack();
      continue;
    }
    try {
      await markRender(env, parsed.data, 'failed', DLQ_RENDER_REASON);
      console.log(JSON.stringify({ at: 'queue.renders-dlq', document_id: parsed.data.document_id, marked: 'failed' }));
    } catch (error) {
      console.log(
        JSON.stringify({
          at: 'queue.renders-dlq',
          ok: false,
          document_id: parsed.data.document_id,
          error: String(error),
        }),
      );
    }
    message.ack();
  }
}
