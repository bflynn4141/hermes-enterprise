// Which consumer gets this batch.
//
// One `queue()` handler serves four queues, and the only thing it is given to
// tell them apart is `batch.queue` — the queue's *name*, which is suffixed per
// environment (`hermes-extract`, `hermes-extract-staging`,
// `hermes-extract-production`, and a `-dlq` for each). So the routing matches
// on the stem and the suffix rather than on an exact name: a new environment
// adds a suffix, and a router that listed names would silently stop handling a
// queue the day someone added one.
//
// The default is `retryAll()`, not `ack()`. A batch from a queue this build does
// not know about is a deploy that is behind, and retrying it costs a delay
// while acking it loses the messages.
import type { Env } from '../env.js';
import { extractBatch } from './extract.js';
import { rendersBatch } from './renders.js';
import { extractDlqBatch, rendersDlqBatch } from './dlq.js';
import type { ExtractMessage } from './messages.js';

export { extractMessageSchema, renderMessageSchema } from './messages.js';
export type { ExtractMessage, RenderMessage } from './messages.js';

/** `hermes-extract`, `hermes-extract-staging`, `hermes-extract-production`. */
const isExtract = (queue: string): boolean => queue.startsWith('hermes-extract') && !queue.endsWith('-dlq');
const isExtractDlq = (queue: string): boolean => queue.startsWith('hermes-extract') && queue.endsWith('-dlq');
const isRenders = (queue: string): boolean => queue.startsWith('hermes-renders') && !queue.endsWith('-dlq');
const isRendersDlq = (queue: string): boolean => queue.startsWith('hermes-renders') && queue.endsWith('-dlq');

export async function handleQueue(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  if (isExtractDlq(batch.queue)) return extractDlqBatch(batch, env);
  if (isRendersDlq(batch.queue)) return rendersDlqBatch(batch, env);
  if (isExtract(batch.queue)) return extractBatch(batch, env);
  if (isRenders(batch.queue)) return rendersBatch(batch, env);

  console.log(JSON.stringify({ at: 'queue', queue: batch.queue, note: 'no consumer for this queue' }));
  batch.retryAll();
}

/**
 * Enqueue an extraction.
 *
 * Called after the transaction that made the row `ready` has committed, never
 * inside it: a queue message can be delivered before an uncommitted row exists,
 * and a consumer that cannot find its row has no honest answer — it cannot tell
 * "not yet" from "never".
 *
 * A send that fails is logged rather than thrown. The upload succeeded and the
 * caller should be told so; the extraction is a second question, and the row
 * says `pending` until something answers it.
 */
export async function enqueueExtract(env: Env, message: ExtractMessage): Promise<void> {
  try {
    await env.EXTRACT_QUEUE.send(message);
  } catch (error) {
    console.log(JSON.stringify({ at: 'queue.enqueue', queue: 'extract', ok: false, error: String(error) }));
  }
}
