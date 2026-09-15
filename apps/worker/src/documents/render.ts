// Rendering a document version.
//
// Called by the `renders` queue consumer and by nothing else. It reads one
// `(document_id, version)` pair, renders the payload to a self-contained HTML
// file, puts it in R2 beside the uploads, and writes the outcome onto the row.
//
// ## The PDF, and why there is not one
//
// The plan lists `@react-pdf/renderer` under workerd as **unverified**. It has
// now been verified, and the answer is no. The spike (recorded in
// docs/DECISIONS.md, D-7) got as far as a rendered element tree and then:
//
//     failed to asynchronously prepare wasm: CompileError:
//     WebAssembly.instantiate(): Wasm code generation disallowed by embedder
//
// `@react-pdf/renderer` lays text out with yoga-layout, which ships its
// WebAssembly as a base64 string and compiles it at runtime. Workers allow
// WebAssembly only as a statically imported module in the bundle, so every
// build of that library that compiles bytes at runtime is unreachable here,
// whichever export condition resolves.
//
// So the row carries two statuses rather than one. `render_status = 'ready'`
// because the HTML render is real and complete; `pdf_status = 'unavailable'`
// with the reason above, because the PDF is not. Collapsing them into one
// column would have made the viewer say "Rendering failed" about a document
// that renders perfectly well, and an honest missing feature reads better than
// a dishonest error.
import { documentPayloadSchema } from '@hermes/shared';
import type { Env } from '../env.js';
import { withWorkspaceTransaction, publishEvents, runJobsAfterCommit } from '../jobs.js';
import { putObject } from '../storage/r2.js';
import { documentHtmlKey } from './keys.js';
import { renderAgreementHtml, renderInvoiceHtml } from './template.js';

/** The sentence the viewer shows where a PDF would be. */
export const PDF_UNAVAILABLE_REASON =
  'No PDF in this build: the PDF renderer needs runtime WebAssembly, which Workers refuse. The HTML render is saved.';

export type RenderOutcome =
  | { readonly status: 'rendered'; readonly storageKey: string }
  | { readonly status: 'already' }
  | { readonly status: 'missing' }
  | { readonly status: 'failed'; readonly reason: string };

interface DocumentRow {
  id: string;
  kind: string;
  version: number;
  payload: unknown;
  render_status: string;
}

/**
 * Is there already a render for this pair?
 *
 * Queues are at-least-once, and a document version is immutable once written,
 * so a second message about the same `(document_id, version)` is a duplicate
 * delivery and re-rendering it would burn CPU to produce identical bytes. The
 * check is the row's own state rather than a dedupe table, because the row is
 * the thing that would have to be wrong for a re-render to be needed.
 */
export async function renderDocumentVersion(
  env: Env,
  workspaceId: string,
  documentId: string,
  version: number,
): Promise<RenderOutcome> {
  const row = await withWorkspaceTransaction(env, workspaceId, async (tx) => {
    const { rows } = await tx.query<DocumentRow>(
      `SELECT id, kind, version, payload, render_status
         FROM documents WHERE workspace_id = $1 AND id = $2 AND version = $3`,
      [workspaceId, documentId, version],
    );
    return rows[0] ?? null;
  });

  if (!row) return { status: 'missing' };
  if (row.render_status === 'ready') return { status: 'already' };

  const parsed = documentPayloadSchema.safeParse(row.payload);
  if (!parsed.success) {
    // A payload that no longer validates is a real failure with a real reason,
    // and the reviewer sees the reason rather than a document that never
    // arrives. It is not retryable: the same bytes will fail the same way.
    const reason = `the document payload does not match the ${row.kind} schema`;
    await writeOutcome(env, workspaceId, documentId, version, {
      renderStatus: 'failed',
      renderError: reason,
      pdfStatus: 'failed',
      pdfError: reason,
      storageKey: null,
    });
    return { status: 'failed', reason };
  }

  const html =
    parsed.data.kind === 'invoice' ? renderInvoiceHtml(parsed.data) : renderAgreementHtml(parsed.data);
  const storageKey = documentHtmlKey(workspaceId, documentId, version);

  // The object first, the row second. An object with no row is garbage the
  // daily sweep collects; a row claiming a render that is not in the store is a
  // viewer that 404s with no explanation.
  await putObject(env, storageKey, html, {
    httpMetadata: { contentType: 'text/html; charset=utf-8' },
    customMetadata: { workspace_id: workspaceId, document_id: documentId, version: String(version) },
  });

  await writeOutcome(env, workspaceId, documentId, version, {
    renderStatus: 'ready',
    renderError: null,
    pdfStatus: 'unavailable',
    pdfError: PDF_UNAVAILABLE_REASON,
    storageKey,
  });

  return { status: 'rendered', storageKey };
}

interface Outcome {
  renderStatus: 'ready' | 'failed';
  renderError: string | null;
  pdfStatus: 'unavailable' | 'failed';
  pdfError: string | null;
  storageKey: string | null;
}

/** Write the outcome and tell the client's cache the row moved. */
async function writeOutcome(
  env: Env,
  workspaceId: string,
  documentId: string,
  version: number,
  outcome: Outcome,
): Promise<void> {
  const jobs = await withWorkspaceTransaction(env, workspaceId, async (tx) => {
    await tx.query(
      `UPDATE documents
          SET render_status = $3, render_error = $4, pdf_status = $5, pdf_error = $6,
              storage_key = COALESCE($7, storage_key), updated_at = now()
        WHERE workspace_id = $1 AND id = $2 AND version = $8`,
      [
        workspaceId,
        documentId,
        outcome.renderStatus,
        outcome.renderError,
        outcome.pdfStatus,
        outcome.pdfError,
        outcome.storageKey,
        version,
      ],
    );
    return publishEvents(tx, workspaceId, [
      {
        kind: 'entity.updated',
        payload: {
          entity_type: 'document',
          entity_id: documentId,
          ref: { section: 'library', view: 'documents', id: documentId },
          version,
        },
      },
    ]);
  });
  await runJobsAfterCommit(env, workspaceId, jobs);
}
