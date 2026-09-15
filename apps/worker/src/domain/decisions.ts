// The decision transaction.
//
// This is the one place in the system that moves a request out of `pending`.
// Not a job, not a queue consumer, not a tool, not the Cron: those roles either
// have no grant for it (`agent`) or no route to it at all. Invariant 1 in
// docs/CONVENTIONS.md is this function plus the five guards in front of it.
//
// Everything below happens in the caller's transaction, which means either all
// of it is true or none of it is:
//
//   1. lock the request row, and refuse anything that is not `pending`;
//   2. INSERT decisions, under UNIQUE(request_id) — the reason two tabs cannot
//      produce two decisions;
//   3. UPDATE requests SET status = <resulting> WHERE id = $1 AND status =
//      'pending' — the second guard, asserted on rowcount, so a lost race is a
//      rollback rather than a decision recorded against a resolved request;
//   4. INSERT events (ids and enum kinds only — never the applicant's name);
//   5. INSERT effects in `pending`, each with the role that may execute it;
//   6. INSERT documents for an approved invoice or agreement, render pending;
//   7. INSERT stream_events `decision.recorded` plus the `entity.updated` rows
//      the client's cache keys off;
//   8. INSERT jobs: the receipt (keyed on `decision_id`), the publish, and the
//      render.
//
// Then the commit, and only then the jobs — which the committing request runs
// itself and the Cron retries if it dies (jobs.ts).
//
// The kind x decision -> status table is `RESULTING_STATUS` in
// `packages/shared`, ported verbatim from the demo's `decide()`, so the
// behaviour a prototype demonstrated and the behaviour a database enforces
// cannot drift apart without a test failing.
import {
  RESULTING_STATUS,
  type Decision,
  type EffectKind,
  type RequestKind,
  type RequestStatus,
} from '@hermes/shared';
import { publishEvents, enqueueJob } from '../jobs.js';
import type { Tx } from '../db/client.js';
import { RouteError, type TenantWork } from '../routes/tenant.js';
import { plannedEffects } from './effects.js';

export interface DecisionOutcome {
  readonly decision_id: string;
  readonly request_id: string;
  readonly resulting_status: RequestStatus;
  readonly effect_ids: string[];
  readonly document_ids: string[];
  /** True when this call found a decision already recorded and returned it. */
  readonly conflict: boolean;
}

interface RequestRow {
  id: string;
  kind: RequestKind;
  status: RequestStatus;
  session_id: string | null;
  label: string;
  payload: unknown;
}

/**
 * Who should execute this effect?
 *
 * The decider is ordered last on purpose. An access grant or a payment carried
 * out by the same person who approved it is exactly the separation the roles
 * exist to create, and while nothing here *forbids* it — a one-Admin workspace
 * has no alternative — the default assignment should not hand it back to them.
 */
async function assigneeFor(
  tx: Tx,
  workspaceId: string,
  requiredRole: string,
  deciderId: string,
): Promise<string | null> {
  const { rows } = await tx.query<{ user_id: string }>(
    `SELECT user_id FROM members
      WHERE workspace_id = $1
        AND status = 'active'
        AND (($2 = 'admin' AND role = 'admin') OR $2 = ANY (reviewer_roles))
      ORDER BY (user_id = $3), joined_at
      LIMIT 1`,
    [workspaceId, requiredRole, deciderId],
  );
  return rows[0]?.user_id ?? null;
}

/** The decision already on file, with the rows it produced. */
async function existingDecision(tx: Tx, requestId: string): Promise<DecisionOutcome | null> {
  const { rows } = await tx.query<{ id: string; resulting_status: RequestStatus }>(
    `SELECT id, resulting_status FROM decisions WHERE request_id = $1`,
    [requestId],
  );
  const decision = rows[0];
  if (!decision) return null;

  const effects = await tx.query<{ id: string }>(
    `SELECT id FROM effects WHERE decision_id = $1 ORDER BY created_at, id`,
    [decision.id],
  );
  const documents = await tx.query<{ id: string }>(
    `SELECT id FROM documents WHERE request_id = $1 ORDER BY version`,
    [requestId],
  );
  return {
    decision_id: decision.id,
    request_id: requestId,
    resulting_status: decision.resulting_status,
    effect_ids: effects.rows.map((row) => row.id),
    document_ids: documents.rows.map((row) => row.id),
    conflict: true,
  };
}

export async function recordDecision(
  work: TenantWork,
  requestId: string,
  decision: Decision,
  note: string | null,
): Promise<DecisionOutcome> {
  // FOR UPDATE, so the second of two concurrent tabs waits here rather than
  // racing the status check. When it wakes, the row it re-reads is the one this
  // transaction committed, and it takes the conflict path below.
  const found = await work.tx.query<RequestRow>(
    `SELECT id, kind, status, session_id, label, payload
       FROM requests WHERE id = $1 FOR UPDATE`,
    [requestId],
  );
  const request = found.rows[0];
  if (!request) throw new RouteError('no such request', 'unknown_request', 404);

  if (request.status !== 'pending') {
    const already = await existingDecision(work.tx, requestId);
    if (already) return already;
    // A resolved request with no decision row cannot happen through this route,
    // and inventing one now would be the first time the invariant broke. 409.
    throw new RouteError(
      `this request is already ${request.status}`,
      'not_pending',
      409,
    );
  }

  // General approvals have their own revision-bound, multi-reviewer voting
  // transaction. Never let the legacy single-admin route bypass that policy.
  if (request.kind === 'approval') {
    throw new RouteError('approval requests use the approval decision route', 'approval_route_required', 409);
  }

  const resulting = RESULTING_STATUS[request.kind][decision];

  const inserted = await work.tx.query<{ id: string }>(
    `INSERT INTO decisions (workspace_id, request_id, decision, resulting_status, decided_by, sid, note)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (request_id) DO NOTHING
     RETURNING id`,
    [work.workspaceId, requestId, decision, resulting, work.userId, work.session.sid, note],
  );
  const decisionId = inserted.rows[0]?.id;
  if (!decisionId) {
    const already = await existingDecision(work.tx, requestId);
    if (already) return already;
    throw new RouteError('a decision is already recorded for this request', 'conflict', 409);
  }

  const moved = await work.tx.query(
    `UPDATE requests SET status = $2 WHERE id = $1 AND status = 'pending'`,
    [requestId, resulting],
  );
  if (moved.rowCount !== 1) {
    // The row moved under us despite the lock. Rolling back is the only honest
    // answer: a decisions row whose request never moved would make the Inbox
    // and History disagree forever.
    throw new RouteError('this request is no longer pending', 'not_pending', 409);
  }

  await work.tx.query(
    `INSERT INTO events (workspace_id, actor_type, actor_user_id, kind, request_id, decision_id, session_id)
     VALUES ($1, 'user', $2, 'decision.recorded', $3, $4, $5)`,
    [work.workspaceId, work.userId, requestId, decisionId, request.session_id],
  );

  // ---------------------------------------------------------------------
  // Effects: recorded, never executed
  // ---------------------------------------------------------------------
  const effectIds: string[] = [];
  for (const planned of plannedEffects(request.kind, decision)) {
    const assignee = await assigneeFor(work.tx, work.workspaceId, planned.requiredRole, work.userId);
    const { rows } = await work.tx.query<{ id: string }>(
      `INSERT INTO effects
         (workspace_id, decision_id, request_id, kind, status, required_role, approvals_required, assignee_id)
       VALUES ($1, $2, $3, $4, 'pending', $5, $6, $7)
       RETURNING id`,
      [
        work.workspaceId,
        decisionId,
        requestId,
        planned.kind satisfies EffectKind,
        planned.requiredRole,
        planned.approvalsRequired,
        assignee,
      ],
    );
    const effectId = rows[0]?.id;
    if (!effectId) continue;
    effectIds.push(effectId);
    if (assignee) {
      await work.tx.query(
        `INSERT INTO events (workspace_id, actor_type, actor_user_id, kind, request_id, decision_id, effect_id)
         VALUES ($1, 'user', $2, 'effect.assigned', $3, $4, $5)`,
        [work.workspaceId, work.userId, requestId, decisionId, effectId],
      );
    }
  }

  // ---------------------------------------------------------------------
  // Documents: version 1 of an approved invoice or agreement
  // ---------------------------------------------------------------------
  const documentIds: string[] = [];
  if (decision === 'approve' && (request.kind === 'invoice' || request.kind === 'agreement')) {
    const { rows } = await work.tx.query<{ id: string; version: number }>(
      `INSERT INTO documents
         (workspace_id, request_id, kind, version, payload, render_status, pdf_status, created_by)
       VALUES ($1, $2, $3, 1, $4::jsonb, 'pending', 'preparing', $5)
       ON CONFLICT (request_id, version) DO NOTHING
       RETURNING id, version`,
      [work.workspaceId, requestId, request.kind, JSON.stringify(request.payload ?? {}), work.userId],
    );
    const document = rows[0];
    if (document) {
      documentIds.push(document.id);
      await work.tx.query(
        `INSERT INTO events (workspace_id, actor_type, actor_user_id, kind, request_id, decision_id, document_id)
         VALUES ($1, 'user', $2, 'document.created', $3, $4, $5)`,
        [work.workspaceId, work.userId, requestId, decisionId, document.id],
      );
      // The render is a job, not a direct queue send, for the reason every
      // post-commit side effect is (invariant 6): the row that says "render
      // this" commits with the document, and the Cron retries it if this
      // request dies before the queue accepted the message.
      const renderJob = await enqueueJob(
        work.tx,
        work.workspaceId,
        'render',
        `render:${document.id}:${document.version}`,
        { document_id: document.id, version: document.version },
      );
      if (renderJob) work.jobs.push(renderJob);
    }
  }

  // ---------------------------------------------------------------------
  // The outbox, and the jobs that deliver it
  // ---------------------------------------------------------------------
  const decidedAt = new Date().toISOString();
  const publishJobs = await publishEvents(work.tx, work.workspaceId, [
    {
      kind: 'decision.recorded',
      payload: {
        request_id: requestId,
        decision_id: decisionId,
        decision,
        resulting_status: resulting,
        decided_by: work.userId,
        decided_at: decidedAt,
        effect_ids: effectIds,
      },
    },
    {
      kind: 'entity.updated',
      payload: {
        entity_type: 'request',
        entity_id: requestId,
        ref: { section: 'inbox', view: 'request', id: requestId },
        version: null,
      },
    },
    ...effectIds.map((id) => ({
      kind: 'entity.updated',
      payload: {
        entity_type: 'effect',
        entity_id: id,
        ref: { section: 'inbox', view: 'request', id: requestId },
        version: null,
      },
    })),
    ...documentIds.map((id) => ({
      kind: 'entity.updated',
      payload: {
        entity_type: 'document',
        entity_id: id,
        ref: { section: 'library', view: 'documents', id },
        version: null,
      },
    })),
  ]);
  work.jobs.push(...publishJobs);

  // Keyed on the decision id: two tabs that somehow both reached the enqueue
  // would write one row, because UNIQUE(kind, key) is the idempotency and the
  // key names the decision rather than the moment.
  const receiptJob = await enqueueJob(work.tx, work.workspaceId, 'receipt', `receipt:${decisionId}`, {
    decision_id: decisionId,
    request_id: requestId,
    session_id: request.session_id,
    kind: request.kind,
    decision,
    resulting_status: resulting,
    effect_ids: effectIds,
  });
  if (receiptJob) work.jobs.push(receiptJob);

  return {
    decision_id: decisionId,
    request_id: requestId,
    resulting_status: resulting,
    effect_ids: effectIds,
    document_ids: documentIds,
    conflict: false,
  };
}
