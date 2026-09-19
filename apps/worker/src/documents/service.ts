// Documents as the Library and the review pane read them.
//
// The Library shows two lists, and they come from different places:
//
//   * **Drafts awaiting review** are pending `invoice` and `agreement`
//     *requests*. No `documents` row exists yet, deliberately: the document is
//     created by the decision, so a draft in the Library is a proposal, and the
//     only thing that can turn it into a saved document is a human. The entity
//     the client gets for one of these carries the request's id and version 0,
//     which is how a reader can tell a proposal from a version.
//   * **Saved documents** are `documents` rows, which exist only after a
//     decision approved one.
//
// `documentEntitySchema` is `.strict()`, so everything a screen needs has to be
// one of its fields or a sibling route. That is why versions are
// `GET /documents/:id/versions` and the rendered file is
// `GET /documents/:id/render` rather than two more keys here.
import type { Tx } from '../db/client.js';
import { requestAudiencePredicate } from '../domain/audience.js';
import { PDF_UNAVAILABLE_REASON } from './render.js';

export interface DocumentRow {
  id: string;
  request_id: string;
  kind: string;
  version: number;
  payload: Record<string, unknown> | null;
  storage_key: string | null;
  render_status: string;
  render_error: string | null;
  pdf_status: string;
  pdf_error: string | null;
  request_status: string;
  created_at: Date;
}

export const DOCUMENT_SELECT = `
  SELECT d.id, d.request_id, d.kind, d.version, d.payload, d.storage_key,
         d.render_status, d.render_error, d.pdf_status, d.pdf_error,
         r.status AS request_status, d.created_at
    FROM documents d
    JOIN requests r ON r.id = d.request_id`;

const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};

const numberOf = (payload: Record<string, unknown>): string | null =>
  typeof payload.number === 'string' && payload.number.length > 0 ? payload.number.slice(0, 64) : null;

/**
 * The status line under a document's title.
 *
 * It states the two things a reader of a document most needs to know and a
 * database row does not say on its own: that it is saved, and that nothing left
 * the building. The demo put the same sentence under every saved document.
 */
export function documentStatus(kind: string, requestStatus: string, renderStatus: string): string {
  if (requestStatus === 'pending') return 'Draft · Awaiting review';
  const base = kind === 'invoice' ? 'Saved · Not sent · No money moved' : 'Saved · Unsigned · Not sent';
  if (renderStatus === 'pending') return `${base} · Preparing the render`;
  if (renderStatus === 'failed') return `${base} · Render failed`;
  return base;
}

/**
 * Database `pdf_status` to contract `pdf_status`.
 *
 * The database has a fifth value the contract does not: `unavailable`, which
 * means "this build renders no PDFs and here is why" — a different thing from
 * `failed`, which means "this document's PDF was attempted and did not come
 * out". The contract sees `none` plus the reason in `pdf_error`, so the client
 * shows an explanation rather than an error it would be wrong to retry.
 */
export function toPdfStatus(dbStatus: string): 'none' | 'preparing' | 'ready' | 'failed' {
  switch (dbStatus) {
    case 'preparing':
      return 'preparing';
    case 'ready':
      return 'ready';
    case 'failed':
      return 'failed';
    case 'unavailable':
    default:
      return 'none';
  }
}

export interface DocumentEntityOptions {
  /** Only set once there is a PDF to point at, which in this build is never. */
  readonly pdfUrl?: string | null;
}

export function toDocumentEntity(row: DocumentRow, options: DocumentEntityOptions = {}): Record<string, unknown> {
  const payload = asRecord(row.payload);
  const number = numberOf(payload);
  const kind = row.kind === 'invoice' || row.kind === 'agreement' ? row.kind : 'reference';
  return {
    id: row.id,
    kind,
    number,
    title: (number ? `${kind === 'invoice' ? 'Invoice' : 'Agreement'} ${number}` : `Document ${row.id.slice(0, 8)}`)
      .slice(0, 200),
    status: documentStatus(row.kind, row.request_status, row.render_status).slice(0, 64),
    request_id: row.request_id,
    pdf_status: toPdfStatus(row.pdf_status),
    pdf_url: options.pdfUrl ?? null,
    pdf_error: (row.pdf_error ?? (row.pdf_status === 'unavailable' ? PDF_UNAVAILABLE_REASON : null))?.slice(0, 200) ?? null,
    payload,
    version: row.version,
    created_at: row.created_at.toISOString(),
  };
}

/**
 * A pending invoice or agreement request, shown as the draft it is.
 *
 * Version 0 is the tell: no `documents` row exists, because nobody has decided.
 */
export interface DraftRow {
  id: string;
  kind: string;
  payload: Record<string, unknown> | null;
  created_at: Date;
}

export function toDraftEntity(row: DraftRow): Record<string, unknown> {
  return toDocumentEntity({
    id: row.id,
    request_id: row.id,
    kind: row.kind,
    version: 0,
    payload: row.payload,
    storage_key: null,
    render_status: 'missing',
    render_error: null,
    pdf_status: 'none',
    pdf_error: null,
    request_status: 'pending',
    created_at: row.created_at,
  });
}

/** One document version, or null. Runs under the caller's tenant transaction. */
export async function loadDocument(tx: Tx, documentId: string, userId: string): Promise<DocumentRow | null> {
  const { rows } = await tx.query<DocumentRow>(
    `${DOCUMENT_SELECT} WHERE d.id = $1 AND ${requestAudiencePredicate('r.id', '$2')}`,
    [documentId, userId],
  );
  return rows[0] ?? null;
}

/** Every version of the document that shares this one's request, newest first. */
export async function loadVersions(tx: Tx, requestId: string, userId: string): Promise<DocumentRow[]> {
  const { rows } = await tx.query<DocumentRow>(
    `${DOCUMENT_SELECT} WHERE d.request_id = $1 AND ${requestAudiencePredicate('r.id', '$2')}
      ORDER BY d.version DESC`,
    [requestId, userId],
  );
  return rows;
}
