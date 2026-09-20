// History, and the erasure that has to leave it standing.
//
//   GET    /w/:ws/history?tab=all|decisions|blocked&before=&limit=
//   GET    /w/:ws/history/counts
//   DELETE /w/:ws/applicants/:subject_key
//
// ## Why counts are a second route
//
// `paginatedSchema(eventRowSchema)` is `.strict()` and names three keys, so the
// counts the History header shows cannot ride along in the page. They get their
// own route, which is the better shape anyway: the page changes as you scroll
// and the counts do not, and a client that re-reads the counts on every page of
// a backscroll is asking the database four aggregate questions it already knew
// the answers to. Counts are derived from the same source rows and document
// view as the lists, never from a stored counter. The per-request audience
// predicate must run before aggregation; a workspace-wide aggregate cannot
// recover which rows this caller was allowed to count.
//
// ## Why erasure is here
//
// Because History is the thing an erasure is most likely to break, and putting
// them in one file makes that impossible to forget. `redact_subject` rewrites
// the subject rows — the request payload, its label, the notes, the run turns —
// and never touches `events` or `stream_events`, which hold ids and enum kinds
// only. So the audit trail survives verbatim and every sentence that used to
// name the applicant now says "a deleted applicant", because the sentences are
// composed at read time from rows that have been tombstoned
// (src/domain/history.ts). A test redacts a subject and asks for the page.
import type { Context } from 'hono';
import { eventRowSchema, paginatedSchema } from '@hermes/shared';
import type { Env } from '../env.js';
import { requireCsrf, requireOrigin, requireStepUp } from '../auth.js';
import { inWorkspace, RouteError } from './tenant.js';
import { isHistoryTab, loadHistory, renderHistoryRow } from '../domain/history.js';
import { requestAudiencePredicate } from '../domain/audience.js';
import { deletePrefix } from '../storage/r2.js';
import { documentPrefix } from '../documents/keys.js';
import { REQUEST_ACTIVE_PRESENTATION_PREDICATE, REQUEST_REVIEWABLE_PREDICATE } from '../domain/requests.js';

const historyPage = paginatedSchema(eventRowSchema);
const HISTORY_LIMIT = 100;

export async function listHistory(c: Context<{ Bindings: Env }>): Promise<Response> {
  const tabRaw = c.req.query('tab') ?? 'all';
  if (!isHistoryTab(tabRaw)) throw new RouteError(`unknown history tab: ${tabRaw}`, 'bad_tab', 400);
  const before = c.req.query('before') ?? null;
  if (before && Number.isNaN(Date.parse(before))) {
    throw new RouteError('before must be an ISO timestamp', 'bad_cursor', 400);
  }
  const limit = Math.min(HISTORY_LIMIT, Math.max(1, Number(c.req.query('limit') ?? 50) || 50));

  const rows = await inWorkspace(c, (work) => loadHistory(work.tx, tabRaw, before, limit, work.userId));
  const items = rows.map(renderHistoryRow);

  // The cursor is the last row's timestamp, which is also what the client uses
  // to group into Today and Yesterday: one value, one meaning.
  const last = items[items.length - 1];
  return c.json(
    historyPage.parse({
      items,
      cursor: items.length === limit && last ? last.at : null,
      total: null,
    }),
  );
}

export async function historyCounts(c: Context<{ Bindings: Env }>): Promise<Response> {
  const counts = await inWorkspace(c, async (work) => {
    const { rows } = await work.tx.query<{
      decisions: number;
      approved: number;
      declined: number;
      pending_grants: number;
      inbox: number;
      documents: number;
    }>(
      `SELECT (SELECT count(*)::int FROM decisions decision_row
                JOIN requests r ON r.id = decision_row.request_id
               WHERE decision_row.workspace_id = $1 AND ${requestAudiencePredicate('r.id', '$2')})
                + (SELECT count(*)::int FROM approval_requests approval_row
                    JOIN requests r ON r.id = approval_row.request_id
                   WHERE approval_row.workspace_id = $1 AND approval_row.status IN ('approved','declined')
                     AND ${requestAudiencePredicate('r.id', '$2')}) AS decisions,
              (SELECT count(*)::int FROM decisions decision_row
                JOIN requests r ON r.id = decision_row.request_id
               WHERE decision_row.workspace_id = $1 AND decision_row.decision = 'approve'
                 AND ${requestAudiencePredicate('r.id', '$2')})
                + (SELECT count(*)::int FROM approval_requests approval_row
                    JOIN requests r ON r.id = approval_row.request_id
                   WHERE approval_row.workspace_id = $1 AND approval_row.status = 'approved'
                     AND ${requestAudiencePredicate('r.id', '$2')}) AS approved,
              (SELECT count(*)::int FROM decisions decision_row
                JOIN requests r ON r.id = decision_row.request_id
               WHERE decision_row.workspace_id = $1 AND decision_row.decision = 'decline'
                 AND ${requestAudiencePredicate('r.id', '$2')})
                + (SELECT count(*)::int FROM approval_requests approval_row
                    JOIN requests r ON r.id = approval_row.request_id
                   WHERE approval_row.workspace_id = $1 AND approval_row.status = 'declined'
                     AND ${requestAudiencePredicate('r.id', '$2')}) AS declined,
              (SELECT count(*)::int FROM effects effect_row
                JOIN requests r ON r.id = effect_row.request_id
               WHERE effect_row.workspace_id = $1 AND effect_row.kind = 'access_grant'
                 AND effect_row.status IN ('pending', 'assigned')
                 AND ${requestAudiencePredicate('r.id', '$2')}) AS pending_grants,
              (SELECT count(*)::int FROM requests r
                WHERE r.workspace_id = $1 AND r.status = 'pending'
                  AND ${REQUEST_REVIEWABLE_PREDICATE}
                  AND ${REQUEST_ACTIVE_PRESENTATION_PREDICATE}
                  AND ${requestAudiencePredicate('r.id', '$2')}) AS inbox,
              (SELECT count(*)::int FROM v_created_documents document_view
                JOIN requests r ON r.id = document_view.request_id
               WHERE document_view.workspace_id = $1
                 AND ${requestAudiencePredicate('r.id', '$2')}) AS documents`,
      [work.workspaceId, work.userId],
    );
    return rows[0] ?? { decisions: 0, approved: 0, declined: 0, pending_grants: 0, inbox: 0, documents: 0 };
  });
  return c.json(counts);
}

/**
 * DELETE /w/:ws/applicants/:subject_key
 *
 * A data subject access request, run store by store in the order the inventory
 * demands: the rows first, the objects second. If the objects went first and
 * the transaction rolled back, the store would hold nothing and the database
 * would still point at it — an object nobody can find and nobody can delete
 * again, the one failure an erasure path must not have.
 *
 * `redact_subject` is SECURITY DEFINER and writes its own `subject.redacted`
 * audit row, so an erasure is as auditable as a decision, and it erases by
 * `subject_id` — which the run engine does not write. Migration 0010 derives
 * that id from `(workspace_id, subject_key)` with a trigger, so this route can
 * turn the key a human has into the id the procedure needs.
 *
 * What this does not reach: attachments, which hang off a session rather than a
 * subject and have no per-person link to follow. They are covered by workspace
 * deletion, and Settings > Data and privacy says so.
 */
export async function eraseApplicant(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: true });
  requireCsrf(c);
  const subjectKey = (c.req.param('subject_key') ?? '').trim();
  if (!subjectKey || subjectKey.length > 200) {
    throw new RouteError('subject_key is required', 'bad_subject_key', 400);
  }

  const result = await inWorkspace(c, async (work) => {
    work.requireAdmin('erasing an applicant');
    requireStepUp(work.session);

    const subjects = await work.tx.query<{ subject_id: string }>(
      `SELECT DISTINCT COALESCE(subject_id, subject_id_for(workspace_id, subject_key)) AS subject_id
         FROM requests
        WHERE workspace_id = $1 AND subject_key = $2`,
      [work.workspaceId, subjectKey],
    );
    if (subjects.rowCount === 0) throw new RouteError('no rows name that subject', 'unknown_subject', 404);

    // Collected before the redaction, because afterwards the request rows no
    // longer carry the key that finds them.
    const documents = await work.tx.query<{ id: string }>(
      `SELECT d.id FROM documents d
         JOIN requests r ON r.id = d.request_id
        WHERE r.workspace_id = $1 AND r.subject_key = $2`,
      [work.workspaceId, subjectKey],
    );

    let touched = 0;
    for (const subject of subjects.rows) {
      const { rows } = await work.tx.query<{ redact_subject: number }>(
        `SELECT redact_subject($1::uuid, $2::uuid)`,
        [subject.subject_id, work.workspaceId],
      );
      touched += rows[0]?.redact_subject ?? 0;
    }

    return {
      workspaceId: work.workspaceId,
      subjects: subjects.rows.map((row) => row.subject_id),
      documentIds: documents.rows.map((row) => row.id),
      rows: touched,
    };
  });

  // After the commit. The daily sweep collects anything this drops.
  let objects = 0;
  for (const documentId of result.documentIds) {
    try {
      objects += await deletePrefix(c.env, documentPrefix(result.workspaceId, documentId));
    } catch (error) {
      console.log(JSON.stringify({ at: 'erasure.documents', ok: false, error: String(error) }));
    }
  }

  return c.json({
    subjects: result.subjects,
    rows_redacted: result.rows,
    objects_deleted: objects,
    note: 'Erasure completes after the database history window and the backup lifecycle rule have passed.',
  });
}
