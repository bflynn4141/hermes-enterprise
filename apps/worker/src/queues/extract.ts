// The `extract` consumer: bytes to text.
//
// It runs on a Queue consumer rather than in the request that completed the
// upload, for the reason section 4 of the plan gives: a consumer gets 128 MB
// and a fifteen-minute wall, a request does not, and a 20 MB PDF parsed inline
// is a request that either times out or spends someone's whole CPU budget.
//
// Three families, three outcomes:
//
//   text/plain, text/markdown  decoded as UTF-8. This always works, because
//                              `complete` already refused anything that was not
//                              valid UTF-8.
//   application/pdf            parsed with `unpdf` (a serverless build of
//                              pdfjs). The plan left this **unverified**; it was
//                              run and it works under workerd. See `extractPdf`.
//   anything else              cannot happen — `complete` refused it — and is
//                              recorded as failed rather than silently skipped.
//
// The cutoffs are the plan's: 20 MB and 60 seconds of CPU. Both are checked
// here rather than trusted from the row, because the row records what was
// declared and this is the one place holding what actually arrived.
import type { Env } from '../env.js';
import { withWorkspaceTransaction } from '../jobs.js';
import { getObject } from '../storage/r2.js';
import { putExtractedText } from '../storage/text.js';
import { extractMessageSchema, type ExtractMessage } from './messages.js';

/** The plan's cutoffs. */
export const EXTRACT_MAX_BYTES = 20 * 1024 * 1024;
export const EXTRACT_MAX_MS = 60_000;

export class ExtractionFailure extends Error {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
    this.name = 'ExtractionFailure';
  }
}

/**
 * The PDF spike, resolved: **`unpdf` works under workerd.**
 *
 * Section 4 of the plan marked pdfjs under workerd **unverified** and left it as
 * a spike. It was run: `unpdf@1.8.1` (a serverless build of pdfjs with the
 * Node-only paths removed) loads in the Workers runtime and extracts text from
 * a real PDF. `test/worker/uploads.test.ts` is that spike, kept as a test, so
 * the answer stays true rather than being a sentence in a document — a runtime
 * upgrade that broke it would fail CI rather than silently produce empty
 * documents. It costs about 570 KB gzipped of the bundle.
 *
 * The import stays dynamic and guarded even so. If a future version fails to
 * initialise under workerd, a static import makes the whole Worker fail to
 * start — every route, for a PDF parser — whereas this makes one extraction
 * fail with a reason a reviewer can read.
 */

interface UnpdfModule {
  extractText(
    data: Uint8Array,
    options?: { mergePages?: boolean },
  ): Promise<{ text: string | string[]; totalPages: number }>;
}

/** Loaded once per isolate; `null` means it tried and could not. */
let pdfModule: UnpdfModule | null | undefined;

async function loadPdfEngine(): Promise<UnpdfModule | null> {
  if (pdfModule !== undefined) return pdfModule;
  try {
    pdfModule = (await import('unpdf')) as unknown as UnpdfModule;
  } catch (error) {
    console.log(JSON.stringify({ at: 'extract.pdf', ok: false, error: String(error) }));
    pdfModule = null;
  }
  return pdfModule;
}

async function extractPdf(bytes: Uint8Array): Promise<string> {
  const engine = await loadPdfEngine();
  if (!engine) {
    // The bundled engine refused to load. Honest and specific, because the
    // reviewer sees this string in the viewer.
    throw new ExtractionFailure(
      'extraction unavailable for PDF: the PDF engine failed to load',
      'pdf_engine_unavailable',
    );
  }
  try {
    const result = await engine.extractText(bytes, { mergePages: true });
    const text = Array.isArray(result.text) ? result.text.join('\n\n') : result.text;
    if (text.trim().length === 0) {
      // A scan with no text layer. Not an error — the file is fine — but an
      // empty document presented as extracted would be a lie, so it is a
      // failure with a reason someone can act on.
      throw new ExtractionFailure(
        'no text could be extracted: this PDF appears to be a scan without a text layer',
        'no_text_layer',
      );
    }
    return text;
  } catch (error) {
    if (error instanceof ExtractionFailure) throw error;
    throw new ExtractionFailure(
      `the PDF could not be parsed: ${error instanceof Error ? error.message : String(error)}`,
      'pdf_unreadable',
    );
  }
}

/** Decode text. `complete` already proved it is valid UTF-8. */
const extractText = (bytes: Uint8Array): string => new TextDecoder('utf-8').decode(bytes);

/** Pure enough to test: given bytes and a type, produce text or fail with a reason. */
export async function extractBytes(mime: string, bytes: Uint8Array): Promise<string> {
  if (bytes.byteLength > EXTRACT_MAX_BYTES) {
    throw new ExtractionFailure(`the object is larger than the ${EXTRACT_MAX_BYTES} byte cutoff`, 'too_large');
  }
  if (mime === 'text/plain' || mime === 'text/markdown') return extractText(bytes);
  if (mime === 'application/pdf') return extractPdf(bytes);
  throw new ExtractionFailure(`${mime} has no extraction path`, 'unsupported_mime');
}

/** One message. Throws to retry; the DLQ consumer records the final failure. */
export async function extractOne(env: Env, message: ExtractMessage, startedAt = Date.now()): Promise<void> {
  const object = await getObject(env, message.storage_key);
  if (!object) {
    // Not retryable in any useful sense: the object is gone, and three more
    // attempts will find it equally gone. Recorded now rather than after the
    // DLQ, so the reviewer sees a reason a minute earlier.
    await markExtraction(env, message, 'failed', 'the object is missing from storage');
    return;
  }

  const bytes = new Uint8Array(await object.arrayBuffer());
  try {
    const text = await extractBytes(message.mime, bytes);
    if (Date.now() - startedAt > EXTRACT_MAX_MS) {
      throw new ExtractionFailure(`extraction took longer than ${EXTRACT_MAX_MS / 1000} seconds`, 'timeout');
    }
    const counters = await putExtractedText(env, message.storage_key, text);
    await markExtraction(env, message, 'ready', null, counters);
  } catch (error) {
    if (error instanceof ExtractionFailure) {
      // A reason, not an exception: retrying a PDF with no engine three times
      // produces the same nothing, and the row should say why now.
      await markExtraction(env, message, 'failed', error.message);
      return;
    }
    throw error;
  }
}

/**
 * Write the outcome onto whichever row this message names.
 *
 * As the `app` role: the consumer is the Worker, not the run engine, and the
 * run engine holds no UPDATE on either table (migration 0009). The transaction
 * sets the tenant key without a membership check, the way every Cron and
 * consumer does (jobs.ts explains why there is no service member).
 */
export async function markExtraction(
  env: Env,
  message: Pick<ExtractMessage, 'workspace_id' | 'kind' | 'id'>,
  status: 'ready' | 'failed',
  error: string | null,
  counters?: { textLength: number; tokenEstimate: number },
): Promise<void> {
  const table = message.kind === 'attachment' ? 'attachments' : 'agent_files';
  await withWorkspaceTransaction(env, message.workspace_id, async (tx) => {
    await tx.query(
      `UPDATE ${table}
          SET extraction_status = $3,
              extraction_error = $4,
              text_length = COALESCE($5, text_length),
              token_estimate = COALESCE($6, token_estimate),
              updated_at = now()
        WHERE workspace_id = $1 AND id = $2`,
      [
        message.workspace_id,
        message.id,
        status,
        error?.slice(0, 1000) ?? null,
        counters?.textLength ?? null,
        counters?.tokenEstimate ?? null,
      ],
    );
  });
}

/**
 * One batch.
 *
 * Acked and retried per message rather than per batch: one unreadable PDF must
 * not send four healthy documents round the retry loop with it, and
 * `retryAll()` on a batch of five is four extra extractions for one failure.
 */
export async function extractBatch(batch: MessageBatch<unknown>, env: Env): Promise<void> {
  for (const message of batch.messages) {
    const parsed = extractMessageSchema.safeParse(message.body);
    if (!parsed.success) {
      // A message we cannot read is not a message we can retry into
      // understanding. Acked so it stops costing attempts, and logged loudly.
      console.log(JSON.stringify({ at: 'queue.extract', ok: false, error: 'unparseable message' }));
      message.ack();
      continue;
    }
    try {
      await extractOne(env, parsed.data);
      message.ack();
    } catch (error) {
      console.log(
        JSON.stringify({
          at: 'queue.extract',
          ok: false,
          id: parsed.data.id,
          attempts: message.attempts,
          error: String(error),
        }),
      );
      // Retried up to `max_retries: 3`, then the platform moves it to the
      // dead-letter queue, where dlq.ts writes the failure onto the row.
      message.retry();
    }
  }
}
