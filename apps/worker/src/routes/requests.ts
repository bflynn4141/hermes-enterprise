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
import { inWorkspace, jsonBody, pathUuid, RouteError, type TenantWork } from './tenant.js';
import { loadRequest, toRequestEntity, REQUEST_AUDIENCE_PREDICATE, REQUEST_SELECT, type RequestRow } from '../domain/requests.js';
import { loadApprovalListProjection } from '../domain/approvals.js';
import { effectRows, toEffectEntity } from '../domain/effect-rows.js';
import { loadVersions, toDocumentEntity } from '../documents/service.js';
import { enqueueRequestTriage, JEV_MODEL_ID } from '../inbox-triage/service.js';

const LIST_LIMIT = 100;
const TRIAGE_ENQUEUE_LIMIT = 5;

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

const financeWorkflowRequest = (row: RequestRow): boolean =>
  row.kind === 'invoice'
  && !!row.payload
  && typeof row.payload === 'object'
  && !Array.isArray(row.payload)
  && 'workflow_provenance' in row.payload;

async function financeReviewer(work: TenantWork): Promise<boolean> {
  const { rows } = await work.tx.query<{ reviewer_roles: string[] }>(
    `SELECT reviewer_roles FROM members WHERE workspace_id=$1 AND user_id=$2 AND status='active'`,
    [work.workspaceId, work.userId],
  );
  return rows[0]?.reviewer_roles.includes('finance') ?? false;
}

export async function listRequests(c: Context<{ Bindings: Env }>): Promise<Response> {
  const statuses = statusFilter(c.req.query('status'));
  const kindRaw = c.req.query('kind');
  const kind = kindRaw && (REQUEST_KINDS as readonly string[]).includes(kindRaw) ? kindRaw : null;
  const q = (c.req.query('q') ?? '').trim().slice(0, 120);
  const limit = Math.min(LIST_LIMIT, Math.max(1, Number(c.req.query('limit') ?? LIST_LIMIT) || LIST_LIMIT));
  const sort = c.req.query('sort') === 'recent' ? 'recent' : 'priority';
  const triageActive = c.env.INBOX_TRIAGE_MODE === 'active';

  const rows = await inWorkspace(c, async (work) => {
    const values: unknown[] = [work.workspaceId, work.userId];
    const where: string[] = ['r.workspace_id=$1', REQUEST_AUDIENCE_PREDICATE];
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
        WHERE ${where.join(' AND ')}
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT $${values.length}`,
      values,
    );
    const projections = new Map<string, Awaited<ReturnType<typeof loadApprovalListProjection>>>();
    const jobs: string[] = [];
    for (const row of result.rows) {
      if (row.kind === 'approval') projections.set(row.id, await loadApprovalListProjection(work.tx, row.id, work.userId));
      if (
        jobs.length < TRIAGE_ENQUEUE_LIMIT
        && row.status === 'pending'
        && c.env.INBOX_TRIAGE_MODE !== 'off'
        && (row.triage_model_id !== JEV_MODEL_ID
          || row.triage_rubric_version !== (c.env.INBOX_TRIAGE_RUBRIC_VERSION ?? '1')
          || !row.triage_status)
      ) {
        const jobId = await enqueueRequestTriage(
          work.tx,
          work.workspaceId,
          row.id,
          row.version,
          c.env.INBOX_TRIAGE_RUBRIC_VERSION ?? '1',
        );
        if (jobId) jobs.push(jobId);
      }
    }
    return { rows: result.rows, projections, role: work.role, financeReviewer: await financeReviewer(work) };
  });

  const items = rows.rows.map((row) => toRequestEntity(
    row,
    rows.projections.get(row.id) ?? null,
    triageActive,
    rows.role === 'admin' || (rows.financeReviewer && financeWorkflowRequest(row)),
  ));
  if (sort === 'priority' && triageActive) {
    const rank = { urgent: 0, high: 1, normal: 2, low: 3, assessing: 4 } as const;
    items.sort((left, right) => {
      const a = requestEntitySchema.parse(left);
      const b = requestEntitySchema.parse(right);
      return rank[a.triage?.band ?? 'assessing'] - rank[b.triage?.band ?? 'assessing']
        || Number(Boolean(b.decision_summary?.approval_requirement.pending_for_viewer)) - Number(Boolean(a.decision_summary?.approval_requirement.pending_for_viewer))
        || (b.triage?.score ?? -1) - (a.triage?.score ?? -1)
        || Date.parse(a.created_at) - Date.parse(b.created_at)
        || a.id.localeCompare(b.id);
    });
  }

  return c.json(
    requestPage.parse({
      items,
      cursor: null,
      total: rows.rows.length,
    }),
  );
}

export async function getRequest(c: Context<{ Bindings: Env }>): Promise<Response> {
  const requestId = pathUuid(c, 'id');
  const result = await inWorkspace(c, async (work) => {
    const row = await loadRequest(work.tx, requestId, work.userId);
    const approval = row?.kind === 'approval' ? await loadApprovalListProjection(work.tx, requestId, work.userId) : null;
    return { row, approval, role: work.role, financeReviewer: await financeReviewer(work) };
  });
  if (!result.row) throw new RouteError('no such request', 'unknown_request', 404);
  return c.json(requestEntitySchema.parse(toRequestEntity(
    result.row,
    result.approval,
    c.env.INBOX_TRIAGE_MODE === 'active',
    result.role === 'admin' || (result.financeReviewer && financeWorkflowRequest(result.row)),
  )));
}

export async function listRequestEffects(c: Context<{ Bindings: Env }>): Promise<Response> {
  const requestId = pathUuid(c, 'id');
  const rows = await inWorkspace(c, async (work) => {
    if (!await loadRequest(work.tx, requestId, work.userId)) throw new RouteError('no such request', 'unknown_request', 404);
    return effectRows(work.tx, { requestId, audienceUserId: work.userId });
  });
  return c.json(effectPage.parse({ items: rows.map(toEffectEntity), cursor: null, total: rows.length }));
}

export async function listRequestDocuments(c: Context<{ Bindings: Env }>): Promise<Response> {
  const requestId = pathUuid(c, 'id');
  const rows = await inWorkspace(c, async (work) => {
    if (!await loadRequest(work.tx, requestId, work.userId)) throw new RouteError('no such request', 'unknown_request', 404);
    return loadVersions(work.tx, requestId, work.userId);
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
    if (!await loadRequest(work.tx, requestId, work.userId)) throw new RouteError('no such request', 'unknown_request', 404);

    await work.tx.query(
      `INSERT INTO request_notes (workspace_id, request_id, body, author_type, author_id)
       VALUES ($1, $2, $3, 'user', $4)`,
      [work.workspaceId, requestId, body.slice(0, 4000), work.userId],
    );
    const row = await loadRequest(work.tx, requestId, work.userId);
    const approval = row?.kind === 'approval' ? await loadApprovalListProjection(work.tx, requestId, work.userId) : null;
    return { row, approval, role: work.role, financeReviewer: await financeReviewer(work) };
  });

  if (!row.row) throw new RouteError('no such request', 'unknown_request', 404);
  return c.json(requestEntitySchema.parse(toRequestEntity(
    row.row,
    row.approval,
    c.env.INBOX_TRIAGE_MODE === 'active',
    row.role === 'admin' || (row.financeReviewer && financeWorkflowRequest(row.row)),
  )), 201);
}
