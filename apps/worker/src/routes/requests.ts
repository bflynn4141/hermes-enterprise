// The Inbox's read routes, plus the human review note.
//
//   GET  /w/:ws/requests?status=&kind=&q=   the list behind the Inbox tabs
//   GET  /w/:ws/requests/:id                one request, shaped for its view
//   GET  /w/:ws/requests/:id/effects        what the decision recorded
//   GET  /w/:ws/requests/:id/documents      what the decision saved
//   POST /w/:ws/requests/:id/notes          a human's review note
//
// Nothing here changes a request's status. The note route is the one write, and
// it writes `request_notes` — the same table the agent's `save_review_note`
// tool writes, with `author_type = 'user'` instead of `'agent'`, so the review
// pane shows one thread rather than two lists that have to be interleaved.
//
// The list is the Inbox's four tabs: `?status=pending` is "Needs you",
// `?status=admitted,created,drafted` is "Decided", `?kind=` narrows to one
// shape, and `q` matches the label. `status` takes a comma-separated list
// because a tab is a set of statuses, not one.
import type { Context } from 'hono';
import {
  effectEntitySchema,
  documentEntitySchema,
  paginatedSchema,
  requestEntitySchema,
  REQUEST_KINDS,
  REQUEST_STATUSES,
} from '@hermes/shared';
import type { Env } from '../env.js';
import { requireCsrf, requireOrigin } from '../auth.js';
import { inWorkspace, jsonBody, pathUuid, RouteError } from './tenant.js';
import { loadRequest, toRequestEntity, REQUEST_SELECT, type RequestRow } from '../domain/requests.js';
import { loadApprovalListProjection } from '../domain/approvals.js';
import { effectRows, toEffectEntity } from '../domain/effect-rows.js';
import { DOCUMENT_SELECT, toDocumentEntity, type DocumentRow } from '../documents/service.js';

const LIST_LIMIT = 100;

const requestPage = paginatedSchema(requestEntitySchema);
const effectPage = paginatedSchema(effectEntitySchema);
const documentPage = paginatedSchema(documentEntitySchema);

/** `?status=pending,admitted` -> the statuses the contract actually names. */
function statusFilter(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(',')
    .map((value) => value.trim())
    .filter((value): value is string => (REQUEST_STATUSES as readonly string[]).includes(value));
}

export async function listRequests(c: Context<{ Bindings: Env }>): Promise<Response> {
  const statuses = statusFilter(c.req.query('status'));
  const kindRaw = c.req.query('kind');
  const kind = kindRaw && (REQUEST_KINDS as readonly string[]).includes(kindRaw) ? kindRaw : null;
  const q = (c.req.query('q') ?? '').trim().slice(0, 120);
  const limit = Math.min(LIST_LIMIT, Math.max(1, Number(c.req.query('limit') ?? LIST_LIMIT) || LIST_LIMIT));

  const rows = await inWorkspace(c, async (work) => {
    const where: string[] = [];
    const values: unknown[] = [];
    if (statuses.length > 0) {
      values.push(statuses);
      where.push(`r.status = ANY ($${values.length}::text[])`);
    }
    if (kind) {
      values.push(kind);
      where.push(`r.kind = $${values.length}`);
    }
    if (q) {
      // The label only. The payload holds the applicant's evidence, and a
      // search that reached into it would be a way to read one field of a
      // record the reader has not opened.
      values.push(`%${q}%`);
      where.push(`r.label ILIKE $${values.length}`);
    }
    values.push(limit);

    const result = await work.tx.query<RequestRow>(
      `${REQUEST_SELECT}
        ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT $${values.length}`,
      values,
    );
    const projections = new Map<string, Awaited<ReturnType<typeof loadApprovalListProjection>>>();
    for (const row of result.rows) {
      if (row.kind === 'approval') projections.set(row.id, await loadApprovalListProjection(work.tx, row.id, work.userId));
    }
    return { rows: result.rows, projections };
  });

  return c.json(
    requestPage.parse({
      items: rows.rows.map((row) => toRequestEntity(row, rows.projections.get(row.id) ?? null)),
      cursor: null,
      total: rows.rows.length,
    }),
  );
}

export async function getRequest(c: Context<{ Bindings: Env }>): Promise<Response> {
  const requestId = pathUuid(c, 'id');
  const result = await inWorkspace(c, async (work) => {
    const row = await loadRequest(work.tx, requestId);
    const approval = row?.kind === 'approval' ? await loadApprovalListProjection(work.tx, requestId, work.userId) : null;
    return { row, approval };
  });
  if (!result.row) throw new RouteError('no such request', 'unknown_request', 404);
  return c.json(requestEntitySchema.parse(toRequestEntity(result.row, result.approval)));
}

export async function listRequestEffects(c: Context<{ Bindings: Env }>): Promise<Response> {
  const requestId = pathUuid(c, 'id');
  const rows = await inWorkspace(c, (work) => effectRows(work.tx, { requestId }));
  return c.json(effectPage.parse({ items: rows.map(toEffectEntity), cursor: null, total: rows.length }));
}

export async function listRequestDocuments(c: Context<{ Bindings: Env }>): Promise<Response> {
  const requestId = pathUuid(c, 'id');
  const rows = await inWorkspace(c, async (work) => {
    const result = await work.tx.query<DocumentRow>(
      `${DOCUMENT_SELECT} WHERE d.request_id = $1 ORDER BY d.version DESC`,
      [requestId],
    );
    return result.rows;
  });
  return c.json(
    documentPage.parse({ items: rows.map((row) => toDocumentEntity(row)), cursor: null, total: rows.length }),
  );
}

/**
 * POST /w/:ws/requests/:id/notes
 *
 * A review note is not a decision and is guarded like what it is: any member of
 * the workspace may leave one, on a request in any status. It is also never
 * sent anywhere — the demo's note block said "Review note · Not sent" and that
 * is still true, because there is nothing in this repository that could send
 * it.
 */
export async function createRequestNote(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: false });
  requireCsrf(c);
  const requestId = pathUuid(c, 'id');
  const input = await jsonBody<{ body?: string }>(c);
  const body = typeof input.body === 'string' ? input.body.trim() : '';
  if (!body) throw new RouteError('a note needs a body', 'empty_note', 422);

  const row = await inWorkspace(c, async (work) => {
    const exists = await work.tx.query(`SELECT 1 FROM requests WHERE id = $1`, [requestId]);
    if (exists.rowCount !== 1) throw new RouteError('no such request', 'unknown_request', 404);

    await work.tx.query(
      `INSERT INTO request_notes (workspace_id, request_id, body, author_type, author_id)
       VALUES ($1, $2, $3, 'user', $4)`,
      [work.workspaceId, requestId, body.slice(0, 4000), work.userId],
    );
    const row = await loadRequest(work.tx, requestId);
    const approval = row?.kind === 'approval' ? await loadApprovalListProjection(work.tx, requestId, work.userId) : null;
    return { row, approval };
  });

  if (!row.row) throw new RouteError('no such request', 'unknown_request', 404);
  return c.json(requestEntitySchema.parse(toRequestEntity(row.row, row.approval)), 201);
}
