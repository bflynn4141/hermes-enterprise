// Extracted text: where it lives, and how the engine reads it a page at a time.
//
// The text sits in R2 next to the object it came from, at `{key}.txt`. Not in
// Postgres: it can be megabytes, it is derived and re-derivable, and a column
// holding it makes every `SELECT *` on the table a transfer of the whole
// corpus. What Postgres keeps is the two numbers a caller needs *before*
// fetching anything — `text_length` and `token_estimate` — so a list can show
// "about 12,000 tokens" without reading a byte.
//
// `getDocumentText` is the read side, and it is capped. A tool result is model
// input: handing 20 MB of extracted PDF to a provider is not a tool result, it
// is a bill and usually a context-window error. So one call returns at most
// 6,000 estimated tokens and the offset to ask for next, and a model that wants
// the rest asks again — which is also what makes the read interruptible when a
// run is stopped.
import { CHARS_PER_TOKEN, MAX_DOCUMENT_TEXT_TOKENS, type DocumentText } from '@hermes/shared';
import type { Env } from '../env.js';
import { withWorkspaceTransaction } from '../jobs.js';
import { getObject, putObject } from './r2.js';
import { textKey } from './keys.js';

/**
 * Characters to tokens, crudely and on purpose.
 *
 * Four characters to a token is wrong for every individual document and close
 * enough for all of them. The number's only job is to bound a page; the real
 * count comes back from the provider, and paying a tokeniser's bundle size and
 * CPU to guess better here would buy nothing.
 */
export const estimateTokens = (text: string): number => Math.ceil(text.length / CHARS_PER_TOKEN);

/** How many characters fit in a page of `maxTokens`. */
const pageChars = (maxTokens: number): number => maxTokens * CHARS_PER_TOKEN;

export interface TextPage {
  readonly text: string;
  readonly offset: number;
  readonly nextOffset: number | null;
  readonly tokenEstimate: number;
  readonly totalLength: number;
  readonly truncated: boolean;
}

/**
 * One page of a string, at most `maxTokens` estimated tokens.
 *
 * Pure, so the cap is testable without a bucket. The page ends at the last
 * newline inside the window when there is one, because cutting a document in
 * the middle of a line is how a model comes to quote half a sentence as if it
 * were the whole clause. A window with no newline at all (one long line) is cut
 * where the cap falls, since the alternative is no progress.
 */
export function pageOf(text: string, offset = 0, maxTokens = MAX_DOCUMENT_TEXT_TOKENS): TextPage {
  const total = text.length;
  const start = Math.max(0, Math.min(offset, total));
  const limit = pageChars(maxTokens);
  let end = Math.min(start + limit, total);

  if (end < total) {
    const lastBreak = text.lastIndexOf('\n', end);
    // Only honour the break if it leaves a page worth reading; a document whose
    // first newline is at character 40,000 must still make progress.
    if (lastBreak > start + limit / 2) end = lastBreak + 1;
  }

  const slice = text.slice(start, end);
  return {
    text: slice,
    offset: start,
    nextOffset: end < total ? end : null,
    tokenEstimate: estimateTokens(slice),
    totalLength: total,
    truncated: end < total,
  };
}

/** Write the extracted text next to its object. Returns what the row records. */
export async function putExtractedText(
  env: Env,
  storageKey: string,
  text: string,
): Promise<{ textLength: number; tokenEstimate: number }> {
  await putObject(env, textKey(storageKey), text, {
    httpMetadata: { contentType: 'text/plain; charset=utf-8' },
  });
  return { textLength: text.length, tokenEstimate: estimateTokens(text) };
}

/** Read it back whole. Used by the extraction consumer and by `getDocumentText`. */
export async function readExtractedText(env: Env, storageKey: string): Promise<string | null> {
  const object = await getObject(env, textKey(storageKey));
  return object ? object.text() : null;
}

interface FileRow {
  id: string;
  name: string;
  storage_key: string | null;
  extraction_status: string;
  extraction_error: string | null;
}

/**
 * The engine's `get_document_text` tool, minus the registration.
 *
 * `env` leads the arguments rather than trailing them because everything in
 * this Worker that touches a binding takes it first; the three the plan names —
 * workspace, file, offset — follow in that order.
 *
 * The lookup runs as the `agent` role, which holds SELECT on `attachments` and
 * `agent_files` and nothing else on either (migration 0009). A tool that could
 * mark its own source ready would be a tool that could hide a failed
 * extraction.
 */
export async function getDocumentText(
  env: Env,
  workspaceId: string,
  fileId: string,
  offset = 0,
  maxTokens = MAX_DOCUMENT_TEXT_TOKENS,
): Promise<DocumentText> {
  const row = await withWorkspaceTransaction(
    env,
    workspaceId,
    async (tx) => {
      // Two tables, one shape: an attachment on a turn and a Context source are
      // the same thing at different moments, and the tool should not care.
      const attachment = await tx.query<FileRow>(
        `SELECT id, name, storage_key, extraction_status, extraction_error
           FROM attachments WHERE workspace_id = $1 AND id = $2 AND deleted_at IS NULL`,
        [workspaceId, fileId],
      );
      if (attachment.rows[0]) return attachment.rows[0];
      const file = await tx.query<FileRow>(
        `SELECT id, name, storage_key, extraction_status, extraction_error
           FROM agent_files WHERE workspace_id = $1 AND id = $2`,
        [workspaceId, fileId],
      );
      return file.rows[0] ?? null;
    },
    'agent',
  );

  if (!row) throw new DocumentTextError('no such document', 'unknown_document');
  if (row.extraction_status !== 'ready' || !row.storage_key) {
    // The reason is the row's own, so the model is told "extraction unavailable
    // for PDF" rather than "not found", and can say so to the person.
    throw new DocumentTextError(
      row.extraction_error ?? `the text of this document is ${row.extraction_status}`,
      `extraction_${row.extraction_status}`,
    );
  }

  const text = await readExtractedText(env, row.storage_key);
  if (text === null) {
    throw new DocumentTextError('the extracted text is missing from storage', 'text_missing');
  }

  const page = pageOf(text, offset, maxTokens);
  return {
    id: row.id,
    name: row.name,
    text: page.text,
    offset: page.offset,
    next_offset: page.nextOffset,
    token_estimate: page.tokenEstimate,
    total_length: page.totalLength,
    truncated: page.truncated,
  };
}

export class DocumentTextError extends Error {
  constructor(
    message: string,
    readonly reason: string,
  ) {
    super(message);
    this.name = 'DocumentTextError';
  }
}
