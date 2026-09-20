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
import {
  canDecideLegacyRequest,
  loadRequest,
  toRequestEntity,
  REQUEST_ACTIVE_PRESENTATION_PREDICATE,
  REQUEST_AUDIENCE_PREDICATE,
  REQUEST_REVIEWABLE_PREDICATE,
  REQUEST_SELECT,
  type RequestRow,
} from '../domain/requests.js';
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

async function reviewerRoles(work: TenantWork): Promise<string[]> {
  const { rows } = await work.tx.query<{ reviewer_roles: string[] }>(
    `SELECT reviewer_roles FROM members WHERE workspace_id=$1 AND user_id=$2 AND status='active'`,
    [work.workspaceId, work.userId],
  );
  return rows[0]?.reviewer_roles ?? [];
}

export async function listRequests(c: Context<{ Bindings: Env }>): Promise<Response> {
  const statuses = statusFilter(c.req.query('status'));
  const kindRaw = c.req.query('kind');
  const kind = kindRaw && (REQUEST_KINDS as readonly string[]).includes(kindRaw) ? kindRaw : null;
  const q = (c.req.query('q') ?? '').trim().slice(0, 120);
  const limit = Math.min(LIST_LIMIT, Math.max(1, Number(c.req.query('limit') ?? LIST_LIMIT) || LIST_LIMIT));
  const sort = c.req.query('sort') === 'recent' ? 'recent' : 'priority';
  const provenanceRaw = c.req.query('provenance');
  const provenance = ['operational', 'sample', 'test', 'unknown'].includes(provenanceRaw ?? '') ? provenanceRaw : null;
  const visibilityRaw = c.req.query('visibility');
  const visibility = visibilityRaw === 'hidden' || visibilityRaw === 'all' ? visibilityRaw : 'active';
  const triageActive = c.env.INBOX_TRIAGE_MODE === 'active';

  const rows = await inWorkspace(c, async (work) => {
    const values: unknown[] = [work.workspaceId, work.userId];
    const where: string[] = ['r.workspace_id=$1', REQUEST_AUDIENCE_PREDICATE, REQUEST_REVIEWABLE_PREDICATE];
    if (visibility === 'active') where.push(REQUEST_ACTIVE_PRESENTATION_PREDICATE);
    if (visibility === 'hidden') where.push('presentation.hidden_at IS NOT NULL');
    if (provenance) {
      values.push(provenance);
      where.push(`COALESCE(provenance.kind, 'unknown') = $${values.length}`);
    }
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
    return { rows: result.rows, projections, role: work.role, reviewerRoles: await reviewerRoles(work) };
  });

  const items = rows.rows.map((row) => toRequestEntity(
    row,
    rows.projections.get(row.id) ?? null,
    triageActive,
    canDecideLegacyRequest(row, rows.role, rows.reviewerRoles),
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
    return { row, approval, role: work.role, reviewerRoles: await reviewerRoles(work) };
  });
  if (!result.row) throw new RouteError('no such request', 'unknown_request', 404);
  return c.json(requestEntitySchema.parse(toRequestEntity(
    result.row,
    result.approval,
    c.env.INBOX_TRIAGE_MODE === 'active',
    canDecideLegacyRequest(result.row, result.role, result.reviewerRoles),
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
 * is still true because this route only writes the internal review thread.
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
    return { row, approval, role: work.role, reviewerRoles: await reviewerRoles(work) };
  });

  if (!row.row) throw new RouteError('no such request', 'unknown_request', 404);
  return c.json(requestEntitySchema.parse(toRequestEntity(
    row.row,
    row.approval,
    c.env.INBOX_TRIAGE_MODE === 'active',
    canDecideLegacyRequest(row.row, row.role, row.reviewerRoles),
  )), 201);
}

/**
 * PATCH /w/:ws/requests/:id/presentation
 *
 * Personal Inbox organization only. A hidden row remains directly readable,
 * auditable and actionable through its URL, and other reviewers' lists/counts
 * are unchanged. The current required reviewer must decide or route the work
 * before hiding it; presentation state is never a way to suppress an approval.
 */
export async function patchRequestPresentation(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: false });
  requireCsrf(c);
  const requestId = pathUuid(c, 'id');
  const input = await jsonBody<{ hidden?: unknown; reason?: unknown }>(c);
  if (typeof input.hidden !== 'boolean') {
    throw new RouteError('hidden must be true or false', 'bad_presentation', 422);
  }
  const reason = typeof input.reason === 'string' ? input.reason.trim() : '';
  if (input.hidden && (reason.length < 5 || reason.length > 500)) {
    throw new RouteError('a reason of 5 to 500 characters is required', 'hide_reason_required', 422);
  }

  const result = await inWorkspace(c, async (work) => {
    const row = await loadRequest(work.tx, requestId, work.userId);
    if (!row) throw new RouteError('no such request', 'unknown_request', 404);
    const approval = row.kind === 'approval'
      ? await loadApprovalListProjection(work.tx, requestId, work.userId)
      : null;
    const roles = await reviewerRoles(work);
    const canDecide = canDecideLegacyRequest(row, work.role, roles);
    const requiredForViewer = row.status === 'pending' && (
      row.kind === 'approval' ? approval?.pending_for_viewer === true
        : row.kind !== 'task' && canDecide
    );
    if (input.hidden && requiredForViewer) {
      throw new RouteError(
        'Decide or route this required review before hiding it.',
        'required_review_cannot_be_hidden',
        409,
      );
    }

    const current = await work.tx.query<{ hidden_at: Date | null }>(
      `SELECT hidden_at FROM request_presentations WHERE request_id=$1 AND user_id=$2`,
      [requestId, work.userId],
    );
    const wasHidden = current.rows[0]?.hidden_at !== null && current.rows[0]?.hidden_at !== undefined;
    if (input.hidden !== wasHidden) {
      await work.tx.query(
        `INSERT INTO request_presentations
           (workspace_id, request_id, user_id, hidden_at, hidden_reason, restored_at)
         VALUES ($1,$2,$3,CASE WHEN $4::boolean THEN now() ELSE NULL END,
                 CASE WHEN $4::boolean THEN $5 ELSE NULL END,
                 CASE WHEN $4::boolean THEN NULL ELSE now() END)
         ON CONFLICT (request_id,user_id) DO UPDATE SET
           hidden_at=EXCLUDED.hidden_at,
           hidden_reason=CASE WHEN $4::boolean THEN EXCLUDED.hidden_reason ELSE request_presentations.hidden_reason END,
           restored_at=EXCLUDED.restored_at,
           updated_at=now()`,
        [work.workspaceId, requestId, work.userId, input.hidden, reason || null],
      );
      await work.tx.query(
        `INSERT INTO events (workspace_id, actor_type, actor_user_id, kind, request_id)
         VALUES ($1,'user',$2,$3,$4)`,
        [work.workspaceId, work.userId, input.hidden ? 'request.hidden' : 'request.restored', requestId],
      );
    }

    const updated = await loadRequest(work.tx, requestId, work.userId);
    if (!updated) throw new RouteError('no such request', 'unknown_request', 404);
    return toRequestEntity(updated, approval, c.env.INBOX_TRIAGE_MODE === 'active', canDecide);
  });

  return c.json(requestEntitySchema.parse(result));
}
