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
  requestReviewBinding,
  type Decision,
  type EffectKind,
  type RequestKind,
  type RequestStatus,
} from '@hermes/shared';
import { publishEvents, enqueueJob } from '../jobs.js';
import type { Tx } from '../db/client.js';
import { workspaceLegalName } from './legal-name.js';
import { type TenantWork } from '../routes/tenant.js';
import { RouteError } from '../routes/errors.js';
import { plannedEffects } from './effects.js';
import { REQUEST_AUDIENCE_PREDICATE } from './requests.js';
import { PARTNER_INVOICE_REVIEW_DEFINITION } from '../enterprise-skills/registry.js';

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
  version: number;
  subject_key: string | null;
}

interface PartnerDecisionBinding {
  handoffId: string;
  authorizationId: string;
  partnerId: string;
  partnerName: string;
  engagementReference: string;
  reviewerDisplay: string;
  lineageRootId: string;
}

async function lockPartnerDecisionBinding(
  tx: Tx,
  workspaceId: string,
  requestId: string,
  userId: string,
): Promise<PartnerDecisionBinding | null> {
  const mapping = await tx.query<{ handoff_id: string }>(
    `SELECT handoff_id FROM partner_workflow_executions
      WHERE workspace_id=$1 AND request_id=$2`, [workspaceId, requestId],
  );
  const handoffId = mapping.rows[0]?.handoff_id;
  if (!handoffId) return null;
  await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [`partner-handoff:${workspaceId}:${handoffId}`]);
  const result = await tx.query<{
    handoff_id: string; authorization_id: string; finance_principal_id: string;
    reviewer_display: string; partner_id: string; partner_name: string; engagement_reference: string;
    lineage_root_id: string; superseded_by_handoff_id: string | null; validation_status: string; human_decision_status: string;
    source_record_revision: number; engagement_revision: number;
    invoice_record_revision: number; invoice_revision: number;
    expected_authorization_hash: string; authorization_hash: string; authorization_status: string;
    authorization_in_window: boolean;
    approval_status: string; engagement_source_status: string; engagement_source_sha256: string;
    engagement_source_deleted_at: Date | null;
    recorded_engagement_sha256: string; invoice_source_status: string; invoice_source_sha256: string;
    invoice_source_deleted_at: Date | null;
    recorded_invoice_sha256: string;
  }>(
    `SELECT h.id AS handoff_id,pea.id AS authorization_id,finance_eta.principal_user_id AS finance_principal_id,
            COALESCE(u.name,u.email) AS reviewer_display,pea.partner_id,pea.partner_name,
            pea.engagement_reference,h.lineage_root_id,h.superseded_by_handoff_id,h.validation_status,h.human_decision_status,
            h.source_record_revision,engagement.revision AS engagement_revision,
            h.invoice_record_revision,invoice.revision AS invoice_revision,
            pii.expected_authorization_hash,pea.authorization_hash,pea.status AS authorization_status,
            CURRENT_DATE BETWEEN pea.valid_from AND pea.valid_until AS authorization_in_window,
            approval.status AS approval_status,engagement_source.status AS engagement_source_status,
            engagement_source.sha256 AS engagement_source_sha256,
            engagement_source.deleted_at AS engagement_source_deleted_at,
            pea.source_sha256 AS recorded_engagement_sha256,
            invoice_source.status AS invoice_source_status,invoice_source.sha256 AS invoice_source_sha256,
            invoice_source.deleted_at AS invoice_source_deleted_at,
            pii.invoice_source_sha256 AS recorded_invoice_sha256
       FROM partner_workflow_executions execution
       JOIN partner_handoffs h ON h.workspace_id=execution.workspace_id AND h.id=execution.handoff_id
       JOIN partner_invoice_intakes pii ON pii.workspace_id=h.workspace_id AND pii.handoff_id=h.id
       JOIN partner_engagement_authorizations pea
         ON pea.workspace_id=h.workspace_id AND pea.engagement_record_id=h.source_record_id
       JOIN approval_requests approval
         ON approval.workspace_id=pea.workspace_id AND approval.request_id=pea.approval_request_id
       JOIN partner_records engagement ON engagement.workspace_id=h.workspace_id AND engagement.id=h.source_record_id
       JOIN partner_records invoice ON invoice.workspace_id=h.workspace_id AND invoice.id=h.invoice_record_id
       JOIN attachments engagement_source
         ON engagement_source.workspace_id=h.workspace_id AND engagement_source.id=pea.source_attachment_id
       JOIN attachments invoice_source
         ON invoice_source.workspace_id=h.workspace_id AND invoice_source.id=pii.invoice_source_attachment_id
       JOIN enterprise_team_agents finance_eta
         ON finance_eta.workspace_id=h.workspace_id AND finance_eta.team_id=h.to_team_id
        AND finance_eta.agent_id=execution.finance_agent_id
       JOIN enterprise_run_grants finance_grant
         ON finance_grant.workspace_id=execution.workspace_id
        AND finance_grant.run_id=execution.finance_run_id
        AND finance_grant.agent_id=execution.finance_agent_id
        AND finance_grant.resource_kind='handoff' AND finance_grant.resource_id=h.id
        AND finance_grant.capability='partner.invoice.review.prepare'
        AND finance_grant.effect='allow' AND finance_grant.revoked_at IS NULL
        AND 'prepare_review'=ANY(finance_grant.allowed_actions)
       JOIN enterprise_skill_assignments finance_skill
         ON finance_skill.id=finance_grant.assignment_id
        AND finance_skill.workspace_id=finance_eta.workspace_id
        AND finance_skill.agent_id=finance_eta.agent_id AND finance_skill.team_id=finance_eta.team_id
        AND finance_skill.skill_key='partner-invoice-review' AND finance_skill.skill_version=$4
        AND finance_skill.state='active' AND finance_skill.revision=finance_grant.assignment_revision
        AND finance_skill.artifact_id=finance_grant.artifact_id
       JOIN enterprise_skill_artifacts finance_artifact
         ON finance_artifact.id=finance_skill.artifact_id AND finance_artifact.digest=$5
        AND finance_artifact.digest=finance_grant.artifact_digest
       JOIN enterprise_connection_bindings finance_connector
         ON finance_connector.id=finance_grant.connection_binding_id AND finance_connector.state='active'
        AND NOT (finance_grant.capability=ANY(finance_connector.capability_denies))
       JOIN users u ON u.id=finance_eta.principal_user_id
      WHERE execution.workspace_id=$1 AND execution.request_id=$2 AND h.id=$3
      FOR UPDATE OF h,pea,engagement,invoice,engagement_source,invoice_source`,
    [workspaceId, requestId, handoffId,
      PARTNER_INVOICE_REVIEW_DEFINITION.version, PARTNER_INVOICE_REVIEW_DEFINITION.artifactDigest],
  );
  const row = result.rows[0];
  const current = row && row.finance_principal_id === userId
    && row.superseded_by_handoff_id === null
    && row.validation_status === 'passed' && row.human_decision_status === 'pending'
    && row.source_record_revision === row.engagement_revision
    && row.invoice_record_revision === row.invoice_revision
    && row.expected_authorization_hash === row.authorization_hash
    && row.authorization_status === 'authorized' && row.authorization_in_window
    && row.approval_status === 'approved'
    && row.engagement_source_status === 'ready' && !row.engagement_source_deleted_at
    && row.engagement_source_sha256 === row.recorded_engagement_sha256
    && row.invoice_source_status === 'ready' && !row.invoice_source_deleted_at
    && row.invoice_source_sha256 === row.recorded_invoice_sha256;
  if (!current) throw new RouteError('The governed invoice evidence or role binding changed; review a fresh handoff.', 'request_binding_stale', 409);
  return {
    handoffId: row.handoff_id, authorizationId: row.authorization_id, partnerId: row.partner_id,
    partnerName: row.partner_name, engagementReference: row.engagement_reference,
    reviewerDisplay: row.reviewer_display.slice(0, 120), lineageRootId: row.lineage_root_id,
  };
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

/**
 * After Partnerships admits an applicant, prepare one pending contractor
 * agreement for Finance when the contractor-agreements handoff is enabled.
 * Creates a new pending decision — never grants access, signs, or sends.
 */
async function prepareContractorAgreement(
  work: TenantWork,
  application: RequestRow,
): Promise<string | null> {
  const admission = await work.tx.query<{ admission_state: string }>(
    `SELECT admission_state FROM handoffs
      WHERE workspace_id=$1 AND key='contractor-agreements'`,
    [work.workspaceId],
  );
  if (admission.rows[0]?.admission_state !== 'enabled') return null;

  const finance = await work.tx.query<{ principal_user_id: string }>(
    `SELECT eta.principal_user_id
       FROM enterprise_team_agents eta
       JOIN enterprise_teams t ON t.workspace_id=eta.workspace_id AND t.id=eta.team_id
      WHERE eta.workspace_id=$1 AND t.slug='finance'
      LIMIT 1`,
    [work.workspaceId],
  );
  const financePrincipalId = finance.rows[0]?.principal_user_id;
  if (!financePrincipalId) return null;

  const payload = application.payload && typeof application.payload === 'object' && !Array.isArray(application.payload)
    ? application.payload as Record<string, unknown>
    : null;
  const applicant = payload?.applicant && typeof payload.applicant === 'object' && !Array.isArray(payload.applicant)
    ? payload.applicant as Record<string, unknown>
    : null;
  const name = typeof applicant?.name === 'string' && applicant.name.trim()
    ? applicant.name.trim().slice(0, 200)
    : application.label.slice(0, 200);
  if (!name) return null;
  const email = typeof applicant?.email === 'string' ? applicant.email : undefined;
  const proposedRole = typeof payload?.proposed_role === 'string' && payload.proposed_role.trim()
    ? payload.proposed_role.trim().slice(0, 120)
    : 'Independent contractor';
  const discovery = payload?.discovery && typeof payload.discovery === 'object' && !Array.isArray(payload.discovery)
    ? payload.discovery as Record<string, unknown>
    : null;
  const candidateId = typeof discovery?.candidate_id === 'string' ? discovery.candidate_id : undefined;

  const number = `AGR-${application.id.replace(/-/g, '').slice(0, 8).toUpperCase()}`;
  const agreementPayload = {
    kind: 'agreement' as const,
    number,
    version_label: 'draft',
    parties: [
      { name: await workspaceLegalName(work.tx, work.workspaceId) },
      email ? { name, email } : { name },
    ],
    sections: [{
      id: 'scope',
      heading: 'Scope',
      body: `Independent contractor engagement for ${proposedRole}.`,
      source_ids: [] as string[],
    }],
    workflow_provenance: {
      handoff_key: 'contractor-agreements' as const,
      source_application_id: application.id,
      admitted_partner: {
        name,
        ...(email ? { email } : {}),
        ...(candidateId ? { candidate_id: candidateId } : {}),
      },
    },
  };

  const subjectKey = `partner-contractor-agreement:${application.id}`;
  const inserted = await work.tx.query<{ id: string }>(
    `INSERT INTO requests
       (workspace_id, kind, subject_key, label, payload, status, session_id)
     VALUES ($1,'agreement',$2,$3,$4::jsonb,'pending',$5)
     ON CONFLICT (workspace_id, subject_key) WHERE subject_key LIKE 'partner-contractor-agreement:%'
     DO NOTHING
     RETURNING id`,
    [work.workspaceId, subjectKey, name, JSON.stringify(agreementPayload), application.session_id],
  );
  let agreementId = inserted.rows[0]?.id;
  if (!agreementId) {
    agreementId = (await work.tx.query<{ id: string }>(
      `SELECT id FROM requests WHERE workspace_id=$1 AND subject_key=$2`,
      [work.workspaceId, subjectKey],
    )).rows[0]?.id ?? undefined;
  }
  if (!agreementId) return null;

  await work.tx.query(
    `INSERT INTO request_audiences (workspace_id, request_id, user_id, purpose)
     VALUES ($1,$2,$3,'owner') ON CONFLICT (request_id, user_id) DO NOTHING`,
    [work.workspaceId, agreementId, financePrincipalId],
  );
  await work.tx.query(
    `INSERT INTO events (workspace_id, actor_type, actor_user_id, kind, request_id, session_id)
     VALUES ($1,'user',$2,'request.created',$3,$4)`,
    [work.workspaceId, work.userId, agreementId, application.session_id],
  );
  return agreementId;
}

export async function recordDecision(
  work: TenantWork,
  requestId: string,
  decision: Decision,
  note: string | null,
  review: { expected_version?: unknown; expected_payload_hash?: unknown } = {},
): Promise<DecisionOutcome> {
  // Partner corrections use the same advisory lock before touching the
  // handoff/request pair. Taking it before the request row prevents an
  // opposite lock order between a correction and a Finance decision.
  const partnerMapping = await work.tx.query<{ handoff_id: string }>(
    `SELECT handoff_id FROM partner_workflow_executions
      WHERE workspace_id=$1 AND request_id=$2`, [work.workspaceId, requestId],
  );
  if (partnerMapping.rows[0]?.handoff_id) {
    await work.tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [
      `partner-handoff:${work.workspaceId}:${partnerMapping.rows[0].handoff_id}`,
    ]);
  }
  // FOR UPDATE, so the second of two concurrent tabs waits here rather than
  // racing the status check. When it wakes, the row it re-reads is the one this
  // transaction committed, and it takes the conflict path below.
  const found = await work.tx.query<RequestRow>(
    `SELECT id, kind, status, session_id, label, payload, subject_key,
            GREATEST(0, EXTRACT(EPOCH FROM updated_at)::int) AS version
       FROM requests r WHERE r.id = $1 AND ${REQUEST_AUDIENCE_PREDICATE} FOR UPDATE OF r`,
    [requestId, work.userId],
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
  if (request.kind === 'task') {
    throw new RouteError('tasks are completed through their named workflow', 'task_route_required', 409);
  }

  if (request.kind === 'invoice' || request.kind === 'agreement') {
    if (review.expected_version === undefined && review.expected_payload_hash === undefined) {
      throw new RouteError('review the document before recording a decision', 'review_binding_required', 409);
    }
    if (typeof review.expected_version !== 'number' || !Number.isSafeInteger(review.expected_version)
      || review.expected_version < 0 || typeof review.expected_payload_hash !== 'string'
      || !/^sha256:[0-9a-f]{64}$/.test(review.expected_payload_hash)) {
      throw new RouteError('the document review binding is invalid', 'bad_review_binding', 422);
    }
    // Compare under the row lock, before any write. Content hashing also
    // catches edits inside the timestamp version's one-second resolution.
    const current = await requestReviewBinding(request);
    if (review.expected_version !== current.expected_version
      || review.expected_payload_hash !== current.expected_payload_hash) {
      throw new RouteError('this document changed; review it again before deciding', 'stale_request', 409);
    }
  }

  const partnerBinding = request.kind === 'invoice'
    ? await lockPartnerDecisionBinding(work.tx, work.workspaceId, requestId, work.userId)
    : null;

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

  let spawnedAgreementId: string | null = null;
  if (decision === 'approve' && request.kind === 'application') {
    spawnedAgreementId = await prepareContractorAgreement(work, request);
  }

  if (partnerBinding) {
    const consumed = await work.tx.query(
      `UPDATE partner_engagement_authorizations
          SET status='consumed'
        WHERE workspace_id=$1 AND id=$2 AND status='authorized' AND consumed_handoff_id=$3`,
      [work.workspaceId, partnerBinding.authorizationId, partnerBinding.lineageRootId],
    );
    if (consumed.rowCount !== 1) {
      throw new RouteError('The engagement authorization was consumed or revoked while deciding.', 'request_binding_stale', 409);
    }
    await work.tx.query(
      `UPDATE partner_handoffs
          SET human_decision_status=$3,acknowledgment_status='pending'
        WHERE workspace_id=$1 AND id=$2 AND human_decision_status='pending'`,
      [work.workspaceId, partnerBinding.handoffId, decision === 'approve' ? 'approved' : 'declined'],
    );
    await work.tx.query(
      `INSERT INTO partner_decision_acknowledgments
         (workspace_id,handoff_id,decision_id,partner_id,partner_name,engagement_reference,
          outcome,result_code,finance_reviewer_display,recorded_at,delivery_status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,now(),'pending')
       ON CONFLICT (workspace_id,decision_id) DO NOTHING`,
      [work.workspaceId, partnerBinding.handoffId, decisionId, partnerBinding.partnerId,
        partnerBinding.partnerName, partnerBinding.engagementReference,
        decision === 'approve' ? 'invoice_draft_saved' : 'declined',
        decision === 'approve' ? 'approved' : 'declined', partnerBinding.reviewerDisplay],
    );
    const acknowledgmentJob = await enqueueJob(
      work.tx,
      work.workspaceId,
      'partner_acknowledgment',
      `partner-acknowledgment:${decisionId}`,
      { handoff_id: partnerBinding.handoffId, decision_id: decisionId },
    );
    if (acknowledgmentJob) work.jobs.push(acknowledgmentJob);
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
    ...(spawnedAgreementId ? [{
      kind: 'entity.updated' as const,
      payload: {
        entity_type: 'request' as const,
        entity_id: spawnedAgreementId,
        ref: { section: 'inbox' as const, view: 'request' as const, id: spawnedAgreementId },
        version: null,
      },
    }] : []),
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
