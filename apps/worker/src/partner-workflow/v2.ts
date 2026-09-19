// Exact-authority Partnerships -> Finance workflow.
//
// Public callers provide only business ids, immutable content bindings and
// optimistic revisions. This module derives identities, sessions, recipient,
// provenance and replay keys from authenticated server state.
import {
  invoicePayloadSchema,
  partnerDecisionAcknowledgmentSchema,
  partnerEngagementAuthorizationResultSchema,
  partnerHandoffResultSchema,
  partnerInvoiceCorrectionResultSchema,
  partnerInvoiceHandoffProjectionSchema,
  partnerInvoiceIntakeResultSchema,
  partnerWorkflowViewV2Schema,
  type ApprovalPayload,
  type PartnerEngagementAuthorizationInput,
  type PartnerHandoffResult,
  type PartnerInvoiceCorrectionInput,
  type PartnerInvoiceIntakeInput,
  type PartnerInvoiceIntakeResult,
  type PartnerWorkflowViewV2,
} from '@hermes/shared';
import type { QueryResultRow } from 'pg';
import type { Tx } from '../db/client.js';
import type { Env } from '../env.js';
import { proposeApproval } from '../domain/approvals.js';
import { enqueueJob } from '../jobs.js';
import { readExtractedText } from '../storage/text.js';
import { submitTurn, type TurnSession } from '../runs/submit.js';
import { PartnerWorkflowError, snapshotPartnerRunGrants } from './service.js';
import {
  PARTNER_INVOICE_REVIEW_DEFINITION,
  PARTNER_PROGRAM_MULTI_PARTY_DEFINITION,
} from '../enterprise-skills/registry.js';

function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`).join(',')}}`;
}

async function hash(value: unknown): Promise<`sha256:${string}`> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonical(value)));
  return `sha256:${[...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')}`;
}

interface WorkflowActor extends QueryResultRow {
  team_id: string;
  slug: 'partnerships' | 'finance';
  agent_id: string;
  agent_name: string;
  principal_user_id: string;
  principal_name: string;
  member_id: string;
  assignment_id: string;
  assignment_state: 'active' | 'paused';
  assignment_revision: number;
}

async function actors(tx: Tx, workspaceId: string): Promise<{ partnerships: WorkflowActor; finance: WorkflowActor }> {
  const { rows } = await tx.query<WorkflowActor>(
    `SELECT eta.team_id, et.slug, eta.agent_id, a.name AS agent_name,
            eta.principal_user_id, COALESCE(u.name,u.email) AS principal_name,
            m.id AS member_id, esa.id AS assignment_id, esa.state AS assignment_state,
            esa.revision AS assignment_revision
       FROM enterprise_team_agents eta
       JOIN enterprise_teams et ON et.workspace_id=eta.workspace_id AND et.id=eta.team_id
       JOIN agents a ON a.workspace_id=eta.workspace_id AND a.id=eta.agent_id
       JOIN users u ON u.id=eta.principal_user_id
       JOIN members m ON m.workspace_id=eta.workspace_id AND m.user_id=eta.principal_user_id AND m.status='active'
       JOIN enterprise_skill_assignments esa
         ON esa.workspace_id=eta.workspace_id AND esa.agent_id=eta.agent_id AND esa.team_id=eta.team_id
        AND esa.skill_key=CASE et.slug
          WHEN 'partnerships' THEN 'partner-program-screening' ELSE 'partner-invoice-review' END
        AND esa.skill_version=CASE et.slug WHEN 'partnerships' THEN $2 ELSE $4 END
       JOIN enterprise_skill_artifacts artifact ON artifact.id=esa.artifact_id
        AND artifact.digest=CASE et.slug WHEN 'partnerships' THEN $3 ELSE $5 END
      WHERE eta.workspace_id=$1`,
    [workspaceId,
      PARTNER_PROGRAM_MULTI_PARTY_DEFINITION.version, PARTNER_PROGRAM_MULTI_PARTY_DEFINITION.artifactDigest,
      PARTNER_INVOICE_REVIEW_DEFINITION.version, PARTNER_INVOICE_REVIEW_DEFINITION.artifactDigest],
  );
  const partnerships = rows.find((row) => row.slug === 'partnerships');
  const finance = rows.find((row) => row.slug === 'finance');
  if (!partnerships || !finance) {
    throw new PartnerWorkflowError('workflow_not_configured', 'Configure both employee role templates first.');
  }
  return { partnerships, finance };
}

async function requireAdmission(tx: Tx, workspaceId: string): Promise<void> {
  const settings = (await tx.query<{
    admission_state: string;
    readiness: Record<string, {
      agent_id?: string; assignment_id?: string; assignment_revision?: number;
      skill_version?: string; artifact_digest?: string;
    }>;
  }>(
    `SELECT admission_state,readiness FROM partner_workflow_settings WHERE workspace_id=$1 FOR SHARE`,
    [workspaceId],
  )).rows[0];
  if (settings?.admission_state !== 'enabled') {
    throw new PartnerWorkflowError('workflow_admission_disabled', 'New partner invoice admissions are disabled until both native roles are ready.');
  }
  const assignments = await tx.query<{
    role: 'partnerships' | 'finance'; agent_id: string; assignment_id: string;
    assignment_revision: number; assignment_state: string; skill_key: string;
    skill_version: string; artifact_digest: string;
  }>(
    `SELECT et.slug AS role,eta.agent_id,esa.id AS assignment_id,
            esa.revision AS assignment_revision,esa.state AS assignment_state,
            esa.skill_key,esa.skill_version,artifact.digest AS artifact_digest
       FROM enterprise_team_agents eta
       JOIN enterprise_teams et ON et.workspace_id=eta.workspace_id AND et.id=eta.team_id
       JOIN enterprise_skill_assignments esa
         ON esa.workspace_id=eta.workspace_id AND esa.agent_id=eta.agent_id AND esa.team_id=eta.team_id
        AND esa.skill_key=CASE et.slug
          WHEN 'partnerships' THEN 'partner-program-screening' ELSE 'partner-invoice-review' END
       JOIN enterprise_skill_artifacts artifact ON artifact.id=esa.artifact_id
      WHERE eta.workspace_id=$1 AND et.slug IN ('partnerships','finance')
      FOR SHARE OF eta,esa,artifact`,
    [workspaceId],
  );
  const expected = {
    partnerships: PARTNER_PROGRAM_MULTI_PARTY_DEFINITION,
    finance: PARTNER_INVOICE_REVIEW_DEFINITION,
  } as const;
  const ready = assignments.rows.length === 2 && (['partnerships', 'finance'] as const).every((role) => {
    const assignment = assignments.rows.find((candidate) => candidate.role === role);
    const attested = settings.readiness?.[role];
    const definition = expected[role];
    return Boolean(assignment && attested
      && assignment.assignment_state === 'active'
      && assignment.skill_key === definition.key
      && assignment.skill_version === definition.version
      && assignment.artifact_digest === definition.artifactDigest
      && attested.agent_id === assignment.agent_id
      && attested.assignment_id === assignment.assignment_id
      && attested.assignment_revision === assignment.assignment_revision
      && attested.skill_version === assignment.skill_version
      && attested.artifact_digest === assignment.artifact_digest);
  });
  if (!ready) {
    throw new PartnerWorkflowError(
      'workflow_readiness_incomplete',
      'A reviewed role assignment changed after native readiness was attested. Refresh readiness before submitting.',
    );
  }
}

interface SourceSnapshot extends QueryResultRow {
  id: string;
  name: string;
  sha256: string;
  storage_key: string;
  created_at: Date;
  author_name: string | null;
  session_id: string | null;
  uploaded_by: string | null;
  status: string;
  extraction_status: string;
}

async function sourceSnapshot(
  tx: Tx,
  env: Env,
  workspaceId: string,
  source: { attachment_id: string; expected_sha256: string },
): Promise<SourceSnapshot & { excerpt: string; text: string }> {
  const row = (await tx.query<SourceSnapshot>(
    `SELECT a.id,a.name,a.sha256,a.storage_key,a.created_at,a.session_id,a.uploaded_by,
            a.status,a.extraction_status,COALESCE(u.name,u.email) AS author_name
      FROM attachments a LEFT JOIN users u ON u.id=a.uploaded_by
      WHERE a.workspace_id=$1 AND a.id=$2 AND a.deleted_at IS NULL
      FOR SHARE OF a`,
    [workspaceId, source.attachment_id],
  )).rows[0];
  if (!row) throw new PartnerWorkflowError('attachment_not_accessible', 'The source attachment is not accessible in this workspace.');
  if (row.status !== 'ready' || row.extraction_status !== 'ready' || !row.sha256 || !row.storage_key) {
    throw new PartnerWorkflowError('attachment_not_ready', 'The source attachment and its extracted text must be ready.');
  }
  if (row.sha256 !== source.expected_sha256) {
    throw new PartnerWorkflowError('source_digest_mismatch', 'The source attachment changed; select and confirm it again.');
  }
  const text = await readExtractedText(env, row.storage_key);
  if (!text?.trim()) throw new PartnerWorkflowError('attachment_not_ready', 'The source attachment has no readable stored text.');
  return { ...row, text, excerpt: text.trim().slice(0, 2000) };
}

async function sourceSession(
  tx: Tx,
  workspaceId: string,
  source: SourceSnapshot,
  actor: WorkflowActor,
  userId: string,
): Promise<{ session: TurnSession; latestRunId: string }> {
  if (!source.session_id || source.uploaded_by !== userId || userId !== actor.principal_user_id) {
    throw new PartnerWorkflowError('partnerships_principal_required', 'Only the configured Partnerships principal may use a source from their own agent session.');
  }
  const session = (await tx.query<TurnSession>(
    `SELECT id,agent_id,owner_id,read_only,mode,model_id,effort
       FROM sessions WHERE workspace_id=$1 AND id=$2 AND agent_id=$3 AND owner_id=$4
        AND NOT archived AND NOT read_only`,
    [workspaceId, source.session_id, actor.agent_id, userId],
  )).rows[0];
  if (!session) throw new PartnerWorkflowError('source_workspace_mismatch', 'The source is not attached to an active Partnerships session.');
  const latestRunId = (await tx.query<{ id: string }>(
    `SELECT id FROM runs WHERE workspace_id=$1 AND session_id=$2 AND agent_id=$3
      ORDER BY created_at DESC LIMIT 1`,
    [workspaceId, session.id, actor.agent_id],
  )).rows[0]?.id;
  if (!latestRunId) throw new PartnerWorkflowError('source_workspace_mismatch', 'The source session has no stored Partnerships run.');
  return { session, latestRunId };
}

export async function proposePartnerEngagementAuthorization(
  tx: Tx,
  env: Env,
  workspaceId: string,
  userId: string,
  input: PartnerEngagementAuthorizationInput,
  jobs: string[],
) {
  const role = await actors(tx, workspaceId);
  if (role.partnerships.assignment_state !== 'active' || userId !== role.partnerships.principal_user_id) {
    throw new PartnerWorkflowError('partnerships_principal_required', 'Only the active configured Partnerships principal may propose engagement terms.');
  }
  const candidate = (await tx.query<{ display_name: string }>(
    `SELECT display_name FROM partner_candidates
      WHERE workspace_id=$1 AND agent_id=$2 AND id=$3`,
    [workspaceId, role.partnerships.agent_id, input.partner.id],
  )).rows[0];
  const existingPartner = (await tx.query(
    `SELECT 1 FROM partner_records WHERE workspace_id=$1 AND partner_id=$2 LIMIT 1`,
    [workspaceId, input.partner.id],
  )).rows[0];
  if (!candidate && !existingPartner) {
    throw new PartnerWorkflowError('partner_not_found', 'Choose a stored Partnerships candidate or existing engagement.');
  }
  if (candidate && candidate.display_name !== input.partner.name) {
    throw new PartnerWorkflowError('partner_identity_mismatch', 'The selected partner name does not match the stored candidate.');
  }
  const source = await sourceSnapshot(tx, env, workspaceId, input.source);
  const provenance = await sourceSession(tx, workspaceId, source, role.partnerships, userId);
  if (!source.text.includes(input.permitted_evidence_excerpt)) {
    throw new PartnerWorkflowError('source_excerpt_mismatch', 'The permitted excerpt must be exact text from the stored source.');
  }
  const fields: Array<[string, string | number | boolean]> = [
    ['input_provenance', input.input_provenance],
    ['partner_name', input.partner.name], ['reference', input.reference], ['purpose', input.purpose],
    ['currency', input.currency], ['authorized_total_minor', input.authorized_total_minor],
    ['valid_from', input.valid_from], ['valid_until', input.valid_until], ['one_invoice', input.one_invoice],
    ['permitted_evidence_excerpt', input.permitted_evidence_excerpt],
    ['source_attachment_id', input.source.attachment_id], ['source_sha256', input.source.expected_sha256],
  ];
  const proposalKey = `engagement:${input.idempotency_key}`;
  const existed = (await tx.query(
    `SELECT 1 FROM approval_requests WHERE workspace_id=$1 AND proposal_idempotency_key=$2`,
    [workspaceId, proposalKey],
  )).rows[0] !== undefined;
  const approval = await proposeApproval({
    tx, workspaceId, jobs, agentId: role.partnerships.agent_id, userId,
    sessionId: provenance.session.id,
  }, {
    label: `Authorize engagement terms · ${input.partner.name}`,
    policy_key: 'partner-engagement-authorization',
    proposal: {
      kind: 'approval', approval_type: 'record_change', illustrative: input.input_provenance === 'sample',
      summary: input.input_provenance === 'sample'
        ? `Record demonstration-only sample engagement terms for ${input.partner.name}.`
        : `Record externally agreed engagement terms for ${input.partner.name}.`,
      consequence: input.input_provenance === 'sample'
        ? 'Records labeled sample terms for a demonstration invoice check only. They do not prove a real agreement, authorize payment, prove delivery, or send anything.'
        : 'Records these terms only for one invoice check. This does not sign an agreement, authorize payment, prove delivery, or send anything.',
      evidence: [{ id: input.source.attachment_id, kind: 'source', label: source.name }],
      details: {
        system_id: 'enterprise-partner-records',
        system_label: 'Authorized partner engagement records',
        changes: fields.map(([field, after]) => ({ record_id: input.partner.id, field, before: null, after })),
        validation: [
          input.input_provenance === 'sample'
            ? 'Finance verifies these are labeled demonstration-only sample terms.'
            : 'Finance verifies these are the externally agreed terms.',
          'The attachment digest and permitted excerpt match the stored source.',
          'This authorization is limited to one invoice and expires with the stated dates.',
        ],
        rollback: 'Approve replacement terms to supersede this authorization. Existing audit history remains immutable.',
      },
    },
    target_agent_ids: [], target_member_ids: [role.finance.member_id],
    target_resource_ids: ['enterprise-partner-records'], dependent_request_ids: [],
    idempotency_key: proposalKey,
  });
  await tx.query(
    `INSERT INTO partner_engagement_authorizations
      (workspace_id,approval_request_id,authorization_revision,authorization_hash,reviewer_user_id,
        input_provenance,partner_id,partner_name,engagement_reference,purpose,currency,authorized_total_minor,
        valid_from,valid_until,one_invoice,permitted_evidence_excerpt,source_attachment_id,
        source_sha256,source_name,source_created_at,source_author_name,source_session_id,source_run_id,status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,true,$15,$16,$17,$18,$19,$20,$21,$22,'pending')
     ON CONFLICT (workspace_id,approval_request_id,authorization_revision,authorization_hash) DO NOTHING`,
    [workspaceId, approval.request_id, approval.payload.authorization.revision, approval.payload.authorization.hash,
      role.finance.principal_user_id, input.input_provenance, input.partner.id, input.partner.name,
      input.reference, input.purpose, input.currency, input.authorized_total_minor,
      input.valid_from, input.valid_until, input.permitted_evidence_excerpt, source.id, source.sha256,
      source.name, source.created_at, source.author_name, provenance.session.id, provenance.latestRunId],
  );
  return partnerEngagementAuthorizationResultSchema.parse({
    approval_request_id: approval.request_id,
    authorization_revision: approval.payload.authorization.revision,
    authorization_hash: approval.payload.authorization.hash,
    engagement_record_id: null,
    status: approval.status === 'approved' ? 'authorized' : approval.status,
    input_provenance: input.input_provenance,
    created: !existed,
  });
}

export async function materializePartnerEngagementAuthorization(
  tx: Tx,
  input: {
    workspaceId: string;
    requestId: string;
    authorizationRevision: number;
    authorizationHash: string;
    payload: ApprovalPayload;
  },
): Promise<boolean> {
  if (input.payload.approval_type !== 'record_change'
      || input.payload.details.system_id !== 'enterprise-partner-records') return false;
  const identity = (await tx.query<{ partner_id: string; engagement_reference: string }>(
    `SELECT partner_id,engagement_reference FROM partner_engagement_authorizations
      WHERE workspace_id=$1 AND approval_request_id=$2 AND authorization_revision=$3
        AND authorization_hash=$4`,
    [input.workspaceId, input.requestId, input.authorizationRevision, input.authorizationHash],
  )).rows[0];
  if (!identity) throw new PartnerWorkflowError('engagement_not_authorized', 'The approved request has no exact engagement materialization binding.');
  await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [
    `partner-engagement:${input.workspaceId}:${identity.partner_id}:${identity.engagement_reference}`,
  ]);
  const { rows } = await tx.query<{
    id: string; reviewer_user_id: string; engagement_record_id: string | null; partner_id: string;
    partner_name: string; engagement_reference: string; purpose: string; currency: string;
    authorized_total_minor: number; valid_from: string; valid_until: string; one_invoice: boolean;
    permitted_evidence_excerpt: string; source_attachment_id: string; source_sha256: string;
    source_session_id: string; source_run_id: string; status: string;
    input_provenance: 'sample' | 'customer';
  }>(
    `SELECT id,reviewer_user_id,engagement_record_id,partner_id,partner_name,
            engagement_reference,purpose,currency,authorized_total_minor,
            valid_from::text AS valid_from,valid_until::text AS valid_until,one_invoice,
            permitted_evidence_excerpt,source_attachment_id,source_sha256,
            source_session_id,source_run_id,status,input_provenance
       FROM partner_engagement_authorizations
      WHERE workspace_id=$1 AND approval_request_id=$2 AND authorization_revision=$3
        AND authorization_hash=$4 FOR UPDATE`,
    [input.workspaceId, input.requestId, input.authorizationRevision, input.authorizationHash],
  );
  const row = rows[0];
  if (!row) throw new PartnerWorkflowError('engagement_not_authorized', 'The approved request has no exact engagement materialization binding.');
  if (row.engagement_record_id && row.status === 'authorized') return true;
  if (row.status !== 'pending') throw new PartnerWorkflowError('authorization_superseded', 'The engagement authorization is no longer pending.');
  const reviewedChanges = Object.fromEntries(input.payload.details.changes.map((change) => [change.field, change.after]));
  const expectedChanges = {
    input_provenance: row.input_provenance,
    partner_name: row.partner_name, reference: row.engagement_reference, purpose: row.purpose,
    currency: row.currency, authorized_total_minor: row.authorized_total_minor,
    valid_from: row.valid_from, valid_until: row.valid_until, one_invoice: row.one_invoice,
    permitted_evidence_excerpt: row.permitted_evidence_excerpt,
    source_attachment_id: row.source_attachment_id, source_sha256: row.source_sha256,
  };
  if (input.payload.details.changes.length !== Object.keys(expectedChanges).length
      || canonical(reviewedChanges) !== canonical(expectedChanges)) {
    throw new PartnerWorkflowError('authorization_hash_mismatch', 'The reviewed record change does not match the exact engagement authorization row.');
  }
  const binding = input.payload.resource_bindings.find((item) => item.id === 'enterprise-partner-records');
  if (!binding?.immutable || binding.version !== 'engagement-authorization/v1') {
    throw new PartnerWorkflowError('authorization_hash_mismatch', 'The approval is not bound to the engagement materializer.');
  }
  const attachment = (await tx.query<{ sha256: string; status: string; uploaded_by: string | null }>(
    `SELECT sha256,status,uploaded_by FROM attachments
      WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL FOR SHARE`,
    [input.workspaceId, row.source_attachment_id],
  )).rows[0];
  if (!attachment || attachment.status !== 'ready' || attachment.sha256 !== row.source_sha256) {
    throw new PartnerWorkflowError('source_digest_mismatch', 'The engagement source changed before authorization finalized.');
  }
  const role = await actors(tx, input.workspaceId);
  if (role.finance.principal_user_id !== row.reviewer_user_id || role.finance.assignment_state !== 'active') {
    throw new PartnerWorkflowError('finance_recipient_unavailable', 'The named Finance reviewer is no longer the active configured principal.');
  }
  if (attachment.uploaded_by !== role.partnerships.principal_user_id) {
    throw new PartnerWorkflowError('source_workspace_mismatch', 'The engagement source is no longer bound to the configured Partnerships principal.');
  }
  const record = await tx.query<{ id: string }>(
    `INSERT INTO partner_records
       (workspace_id,team_id,owner_agent_id,kind,partner_id,data,evidence_ids,
        source_session_id,source_run_id,idempotency_key)
     VALUES ($1,$2,$3,'engagement',$4,$5::jsonb,ARRAY[$6]::text[],$7,$8,$9)
     ON CONFLICT (workspace_id,team_id,owner_agent_id,kind,idempotency_key) DO NOTHING
     RETURNING id`,
    [input.workspaceId, role.partnerships.team_id, role.partnerships.agent_id, row.partner_id,
      JSON.stringify({
        partner_name: row.partner_name, reference: row.engagement_reference, purpose: row.purpose,
        input_provenance: row.input_provenance,
        currency: row.currency, authorized_total_minor: row.authorized_total_minor,
        valid_from: row.valid_from, valid_until: row.valid_until, one_invoice: row.one_invoice,
        permitted_evidence_excerpt: row.permitted_evidence_excerpt,
        approval_request_id: input.requestId, authorization_revision: input.authorizationRevision,
        authorization_hash: input.authorizationHash, source_attachment_id: row.source_attachment_id,
        source_sha256: row.source_sha256,
      }), row.source_attachment_id, row.source_session_id, row.source_run_id,
      `engagement-authorization:${input.requestId}:${input.authorizationRevision}`],
  );
  const recordId = record.rows[0]?.id ?? (await tx.query<{ id: string }>(
    `SELECT id FROM partner_records WHERE workspace_id=$1 AND team_id=$2 AND owner_agent_id=$3
      AND kind='engagement' AND idempotency_key=$4`,
    [input.workspaceId, role.partnerships.team_id, role.partnerships.agent_id,
      `engagement-authorization:${input.requestId}:${input.authorizationRevision}`],
  )).rows[0]?.id;
  if (!recordId) throw new PartnerWorkflowError('engagement_not_authorized', 'Could not materialize the authorized engagement.');
  const superseded = await tx.query<{ engagement_record_id: string | null }>(
    `UPDATE partner_engagement_authorizations
        SET status='superseded'
      WHERE workspace_id=$1 AND partner_id=$2 AND engagement_reference=$3 AND id<>$4
        AND status='authorized'
      RETURNING engagement_record_id`,
    [input.workspaceId, row.partner_id, row.engagement_reference, row.id],
  );
  const supersededRecordIds = superseded.rows
    .map((candidate) => candidate.engagement_record_id)
    .filter((id): id is string => Boolean(id));
  if (supersededRecordIds.length > 0) {
    const staleHandoffs = await tx.query<{ id: string }>(
      `UPDATE partner_handoffs
          SET status='stale',validation_status='stale',human_decision_status='superseded',
              result_reason='Replacement engagement terms superseded this authorization.',
              completed_at=COALESCE(completed_at,now())
        WHERE workspace_id=$1 AND source_record_id=ANY($2::uuid[])
          AND human_decision_status IN ('not_ready','pending')
        RETURNING id`,
      [input.workspaceId, supersededRecordIds],
    );
    const handoffIds = staleHandoffs.rows.map((candidate) => candidate.id);
    if (handoffIds.length > 0) {
      await tx.query(
        `UPDATE requests request
            SET status='withdrawn'
           FROM partner_workflow_executions execution
          WHERE execution.workspace_id=$1 AND execution.handoff_id=ANY($2::uuid[])
            AND request.workspace_id=execution.workspace_id AND request.id=execution.request_id
            AND request.status='pending'`,
        [input.workspaceId, handoffIds],
      );
    }
  }
  await tx.query(
    `UPDATE partner_engagement_authorizations
        SET status='authorized',engagement_record_id=$2,authorized_at=now()
      WHERE id=$1 AND status='pending'`,
    [row.id, recordId],
  );
  await tx.query(
    `UPDATE approval_requests
        SET effect_status='executed',effect_reason='Authorized engagement record materialized atomically.',
            work_status='completed',work_reason='The exact reviewed terms are available for one invoice check.',
            finalization_job_id=NULL
      WHERE request_id=$1`,
    [input.requestId],
  );
  return true;
}

interface AuthorizedEngagement extends QueryResultRow {
  record_id: string; revision: number; data: Record<string, unknown>; authorization_hash: string;
  authorization_revision: number; auth_status: string; expires_at: Date; approval_status: string;
  valid_from: string; valid_until: string; source_attachment_id: string; source_sha256: string;
  source_name: string; source_created_at: Date; source_author_name: string | null;
  permitted_evidence_excerpt: string; partner_id: string; partner_name: string;
  consumed_handoff_id: string | null;
  input_provenance: 'sample' | 'customer';
}

async function authorizedEngagement(
  tx: Tx,
  workspaceId: string,
  recordId: string,
  expectedRevision: number,
  expectedHash: string,
): Promise<AuthorizedEngagement> {
  const row = (await tx.query<AuthorizedEngagement>(
    `SELECT pr.id AS record_id,pr.revision,pr.data,pea.authorization_hash,pea.authorization_revision,
            pea.status AS auth_status,ar.expires_at,ar.status AS approval_status,
            pea.valid_from::text,pea.valid_until::text,pea.source_attachment_id,pea.source_sha256,
            pea.source_name,pea.source_created_at,pea.source_author_name,pea.permitted_evidence_excerpt,
            pea.partner_id,pea.partner_name,pea.consumed_handoff_id,pea.input_provenance
       FROM partner_records pr
       JOIN partner_engagement_authorizations pea
         ON pea.workspace_id=pr.workspace_id AND pea.engagement_record_id=pr.id
       JOIN approval_requests ar
         ON ar.workspace_id=pea.workspace_id AND ar.request_id=pea.approval_request_id
      WHERE pr.workspace_id=$1 AND pr.id=$2 FOR UPDATE OF pr,pea,ar`,
    [workspaceId, recordId],
  )).rows[0];
  if (!row) throw new PartnerWorkflowError('engagement_not_authorized', 'The selected engagement has no recorded authorization.');
  if (row.revision !== expectedRevision) throw new PartnerWorkflowError('engagement_revision_mismatch', 'The engagement changed; refresh before submitting.');
  if (row.authorization_hash !== expectedHash) throw new PartnerWorkflowError('authorization_hash_mismatch', 'The engagement authorization changed; refresh before submitting.');
  if (row.auth_status !== 'authorized' || row.approval_status !== 'approved') {
    throw new PartnerWorkflowError(`authorization_${row.auth_status}`, `The engagement authorization is ${row.auth_status}.`);
  }
  const today = new Date().toISOString().slice(0, 10);
  // Approval expiry bounds how long reviewers may act on a pending proposal.
  // Once approved, the recorded engagement's explicit valid dates govern use.
  if (today < row.valid_from || today > row.valid_until) {
    throw new PartnerWorkflowError('authorization_expired', 'The engagement authorization is outside its valid period.');
  }
  const source = (await tx.query<{ status: string; sha256: string }>(
    `SELECT status,sha256 FROM attachments
      WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL FOR SHARE`,
    [workspaceId, row.source_attachment_id],
  )).rows[0];
  if (!source || source.status !== 'ready' || source.sha256 !== row.source_sha256) {
    throw new PartnerWorkflowError('source_digest_mismatch', 'The authorized engagement source is missing or changed.');
  }
  return row;
}

async function existingIntake(
  tx: Tx, workspaceId: string, userId: string, key: string, payloadHash: string,
): Promise<PartnerInvoiceIntakeResult | null> {
  const row = (await tx.query<{
    id: string; payload_hash: string; handoff_id: string; revision: number;
    source_run_id: string; finance_run_id: string | null; input_provenance: 'sample' | 'customer';
  }>(
    `SELECT pii.id,pii.payload_hash,pii.handoff_id,h.revision,pii.source_run_id,e.finance_run_id,
            pii.input_provenance
       FROM partner_invoice_intakes pii
       JOIN partner_handoffs h ON h.workspace_id=pii.workspace_id AND h.id=pii.handoff_id
       LEFT JOIN partner_workflow_executions e ON e.workspace_id=h.workspace_id AND e.handoff_id=h.id
      WHERE pii.workspace_id=$1 AND pii.requested_by=$2 AND pii.idempotency_key=$3`,
    [workspaceId, userId, key],
  )).rows[0];
  if (!row) return null;
  if (row.payload_hash !== payloadHash) throw new PartnerWorkflowError('idempotency_conflict', 'This idempotency key was already used for different invoice input.');
  return partnerInvoiceIntakeResultSchema.parse({
    intake_event_id: row.id, payload_hash: row.payload_hash, handoff_id: row.handoff_id,
    handoff_revision: row.revision, source_run_id: row.source_run_id,
    finance_run_id: row.finance_run_id, input_provenance: row.input_provenance, created: false,
  });
}

async function createIntake(
  tx: Tx,
  env: Env,
  workspaceId: string,
  userId: string,
  input: PartnerInvoiceIntakeInput,
  jobs: string[],
  predecessor: { id: string; revision: number; lineageRootId: string } | null = null,
): Promise<PartnerInvoiceIntakeResult> {
  await requireAdmission(tx, workspaceId);
  const role = await actors(tx, workspaceId);
  if (role.partnerships.assignment_state !== 'active' || role.finance.assignment_state !== 'active'
      || userId !== role.partnerships.principal_user_id) {
    throw new PartnerWorkflowError('partnerships_principal_required', 'The active configured Partnerships principal must submit this invoice.');
  }
  const { workflow_provenance: _serverOwned, ...invoiceInput } = input.invoice;
  const invoice = invoicePayloadSchema.parse(invoiceInput);
  const payloadHash = await hash({
    input_provenance: input.input_provenance,
    engagement_record_id: input.engagement_record_id,
    expected_engagement_revision: input.expected_engagement_revision,
    expected_authorization_hash: input.expected_authorization_hash,
    invoice_source: input.invoice_source,
    invoice,
    supersedes_handoff_id: predecessor?.id ?? null,
  });
  await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [`partner-intake:${workspaceId}:${userId}:${input.idempotency_key}`]);
  const replay = await existingIntake(tx, workspaceId, userId, input.idempotency_key, payloadHash);
  if (replay) return replay;
  const engagement = await authorizedEngagement(
    tx, workspaceId, input.engagement_record_id,
    input.expected_engagement_revision, input.expected_authorization_hash,
  );
  if (input.input_provenance !== engagement.input_provenance) {
    throw new PartnerWorkflowError('input_provenance_mismatch', 'Invoice input provenance must match the authorized engagement.');
  }
  const source = await sourceSnapshot(tx, env, workspaceId, input.invoice_source);
  const provenance = await sourceSession(tx, workspaceId, source, role.partnerships, userId);
  if (engagement.consumed_handoff_id
      && (!predecessor || engagement.consumed_handoff_id !== predecessor.lineageRootId)) {
    throw new PartnerWorkflowError('authorization_consumed', 'This engagement authorization is already reserved for another invoice lineage.');
  }
  const intakeId = crypto.randomUUID();
  const handoffId = crypto.randomUUID();
  const jobStart = jobs.length;
  const submitted = await submitTurn({
    tx, env, workspaceId, userId, session: provenance.session,
    clientTurnId: `partner-invoice-intake:${intakeId}`,
    text: [
      `A user confirmed invoice intake ${intakeId}.`,
      `Call publish_partner_invoice_review with intake_event_id ${intakeId} and expected_payload_hash ${payloadHash}.`,
      'Do not copy invoice fields, choose a recipient, approve, pay, send, or invent authority.',
    ].join('\n'),
    jobIds: jobs,
  });
  if (submitted.status === 201) {
    const publishJobId = jobs[jobStart];
    const launchJob = await enqueueJob(
      tx, workspaceId, 'run_launch', `run-launch:${submitted.create.runId}:1`,
      { ...submitted.create, ...(publishJobId ? { afterPublishJobId: publishJobId } : {}) },
    );
    if (launchJob) jobs.push(launchJob);
  }
  const sourceRunId = submitted.run.id;
  let invoiceRecordId: string;
  let invoiceRecordRevision: number;
  if (predecessor) {
    const prior = (await tx.query<{ invoice_record_id: string; invoice_record_revision: number }>(
      `SELECT invoice_record_id,invoice_record_revision FROM partner_handoffs
        WHERE workspace_id=$1 AND id=$2 FOR UPDATE`, [workspaceId, predecessor.id],
    )).rows[0];
    if (!prior) throw new PartnerWorkflowError('handoff_not_found', 'The invoice being corrected no longer exists.');
    const updated = (await tx.query<{ id: string; revision: number }>(
      `UPDATE partner_records
          SET data=$3::jsonb,evidence_ids=ARRAY[$4]::text[],source_session_id=$5,source_run_id=$6,
              revision=revision+1
        WHERE workspace_id=$1 AND id=$2 AND revision=$7
        RETURNING id,revision`,
      [workspaceId, prior.invoice_record_id, JSON.stringify(invoice), source.id,
        provenance.session.id, sourceRunId, prior.invoice_record_revision],
    )).rows[0];
    if (!updated) throw new PartnerWorkflowError('handoff_revision_mismatch', 'The invoice changed while applying the correction.');
    invoiceRecordId = updated.id;
    invoiceRecordRevision = updated.revision;
  } else {
    const inserted = (await tx.query<{ id: string; revision: number }>(
      `INSERT INTO partner_records
         (workspace_id,team_id,owner_agent_id,kind,partner_id,data,evidence_ids,
          source_session_id,source_run_id,idempotency_key)
       VALUES ($1,$2,$3,'invoice',$4,$5::jsonb,ARRAY[$6]::text[],$7,$8,$9)
       RETURNING id,revision`,
      [workspaceId, role.finance.team_id, role.finance.agent_id, engagement.partner_id,
        JSON.stringify(invoice), source.id, provenance.session.id, sourceRunId,
        `invoice-intake:${intakeId}`],
    )).rows[0];
    if (!inserted) throw new PartnerWorkflowError('invoice_intake_failed', 'Could not freeze the invoice record.');
    invoiceRecordId = inserted.id;
    invoiceRecordRevision = inserted.revision;
  }
  const projection = partnerInvoiceHandoffProjectionSchema.parse({
    input_provenance: input.input_provenance,
    partner: { id: engagement.partner_id, name: engagement.partner_name },
    engagement: {
      reference: String(engagement.data.reference), summary: String(engagement.data.purpose),
      currency: String(engagement.data.currency),
      authorized_total_minor: Number(engagement.data.authorized_total_minor),
      evidence_ids: [engagement.source_attachment_id], source_record_id: engagement.record_id,
      source_record_revision: engagement.revision,
    },
    invoice_record_id: invoiceRecordId, invoice_record_revision: invoiceRecordRevision,
    source_session: { id: provenance.session.id, excerpt: engagement.permitted_evidence_excerpt },
  });
  const revision = predecessor ? predecessor.revision + 1 : 1;
  const lineageRootId = predecessor?.lineageRootId ?? handoffId;
  await tx.query(
    `INSERT INTO partner_handoffs
       (id,workspace_id,from_team_id,to_team_id,source_record_id,source_record_revision,
        invoice_record_id,invoice_record_revision,projection,source_session_id,requested_by,status,
        simulated,idempotency_key,revision,lineage_root_id,supersedes_handoff_id,payload_hash,
        input_provenance,
        delivery_status,validation_status,agent_explanation_status,human_decision_status,acknowledgment_status)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb,$10,$11,'queued',false,$12,$13,$14,$15,$16,
             $17,'queued','queued','queued','not_ready','pending')`,
    [handoffId, workspaceId, role.partnerships.team_id, role.finance.team_id,
      engagement.record_id, engagement.revision, invoiceRecordId, invoiceRecordRevision,
      JSON.stringify(projection), provenance.session.id, userId, input.idempotency_key,
      revision, lineageRootId, predecessor?.id ?? null, payloadHash, input.input_provenance],
  );
  const reserved = await tx.query(
    `UPDATE partner_engagement_authorizations
        SET consumed_handoff_id=COALESCE(consumed_handoff_id,$2)
      WHERE workspace_id=$1 AND engagement_record_id=$3 AND status='authorized'
        AND (consumed_handoff_id IS NULL OR consumed_handoff_id=$2)`,
    [workspaceId, lineageRootId, engagement.record_id],
  );
  if (reserved.rowCount !== 1) {
    throw new PartnerWorkflowError('authorization_consumed', 'This engagement authorization was reserved concurrently.');
  }
  await tx.query(
    `INSERT INTO partner_invoice_intakes
       (id,workspace_id,handoff_id,payload_hash,input_provenance,engagement_record_id,expected_engagement_revision,
        expected_authorization_hash,invoice_source_attachment_id,invoice_source_sha256,
        invoice_source_name,invoice_source_created_at,invoice_source_author_name,invoice_source_excerpt,
        invoice_payload,requested_by,source_session_id,source_run_id,idempotency_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb,$16,$17,$18,$19)`,
    [intakeId, workspaceId, handoffId, payloadHash, input.input_provenance, engagement.record_id,
      engagement.revision, engagement.authorization_hash, source.id, source.sha256, source.name,
      source.created_at, source.author_name, source.excerpt, JSON.stringify(invoice), userId,
      provenance.session.id, sourceRunId, input.idempotency_key],
  );
  await tx.query(
    `INSERT INTO partner_workflow_executions (handoff_id,workspace_id,finance_agent_id)
     VALUES ($1,$2,$3)`,
    [handoffId, workspaceId, role.finance.agent_id],
  );
  await snapshotPartnerRunGrants(tx, workspaceId, sourceRunId, role.partnerships.agent_id, handoffId);
  await tx.query(
    `INSERT INTO events (workspace_id,actor_type,actor_user_id,kind,session_id,run_id,agent_id)
     VALUES ($1,'user',$2,$3,$4,$5,$6)`,
    [workspaceId, userId, predecessor ? 'partner.invoice_corrected' : 'partner.invoice_received',
      provenance.session.id, sourceRunId, role.partnerships.agent_id],
  );
  if (predecessor) {
    const moved = await tx.query(
      `UPDATE partner_handoffs
          SET superseded_by_handoff_id=$3,human_decision_status='superseded'
        WHERE workspace_id=$1 AND id=$2 AND superseded_by_handoff_id IS NULL`,
      [workspaceId, predecessor.id, handoffId],
    );
    if (moved.rowCount !== 1) throw new PartnerWorkflowError('correction_successor_exists', 'Another correction already replaced this handoff.');
    await tx.query(
      `UPDATE requests SET status='withdrawn'
        WHERE workspace_id=$1 AND id=(SELECT request_id FROM partner_workflow_executions WHERE handoff_id=$2)
          AND status='pending'`,
      [workspaceId, predecessor.id],
    );
  }
  return partnerInvoiceIntakeResultSchema.parse({
    intake_event_id: intakeId, payload_hash: payloadHash, handoff_id: handoffId,
    handoff_revision: revision, source_run_id: sourceRunId, finance_run_id: null,
    input_provenance: input.input_provenance, created: true,
  });
}

export async function submitPartnerInvoiceIntake(
  tx: Tx, env: Env, workspaceId: string, userId: string,
  input: PartnerInvoiceIntakeInput, jobs: string[],
): Promise<PartnerInvoiceIntakeResult> {
  return createIntake(tx, env, workspaceId, userId, input, jobs);
}

export async function correctPartnerInvoiceIntake(
  tx: Tx, env: Env, workspaceId: string, userId: string, handoffId: string,
  input: PartnerInvoiceCorrectionInput, jobs: string[],
) {
  await tx.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [`partner-handoff:${workspaceId}:${handoffId}`]);
  const predecessor = (await tx.query<{
    id: string; revision: number; lineage_root_id: string | null; status: string;
    input_provenance: 'sample' | 'customer' | null;
    superseded_by_handoff_id: string | null; request_id: string | null; request_status: string | null;
  }>(
    `SELECT h.id,h.revision,h.lineage_root_id,h.status,h.input_provenance,h.superseded_by_handoff_id,
            e.request_id,r.status AS request_status
       FROM partner_handoffs h
       LEFT JOIN partner_workflow_executions e ON e.handoff_id=h.id
       LEFT JOIN requests r ON r.id=e.request_id
      WHERE h.workspace_id=$1 AND h.id=$2 FOR UPDATE OF h`,
    [workspaceId, handoffId],
  )).rows[0];
  if (!predecessor) throw new PartnerWorkflowError('handoff_not_found', 'No such invoice handoff.');
  if (predecessor.revision !== input.expected_handoff_revision) {
    throw new PartnerWorkflowError('handoff_revision_mismatch', 'The handoff changed; refresh before correcting it.');
  }
  if (predecessor.superseded_by_handoff_id) {
    const replay = await createIntake(tx, env, workspaceId, userId, input, jobs, {
      id: predecessor.id, revision: predecessor.revision,
      lineageRootId: predecessor.lineage_root_id ?? predecessor.id,
    });
    if (replay.handoff_id !== predecessor.superseded_by_handoff_id) {
      throw new PartnerWorkflowError('correction_successor_exists', 'This handoff already has a correction.');
    }
    return partnerInvoiceCorrectionResultSchema.parse({
      superseded_handoff_id: predecessor.id, handoff_id: replay.handoff_id,
      handoff_revision: replay.handoff_revision, intake_event_id: replay.intake_event_id,
      payload_hash: replay.payload_hash, source_run_id: replay.source_run_id,
      finance_run_id: replay.finance_run_id, input_provenance: replay.input_provenance,
      created: replay.created,
    });
  }
  if (predecessor.request_id && predecessor.request_status !== 'pending') {
    throw new PartnerWorkflowError('handoff_already_decided', 'A decided invoice and its receipt cannot be rewritten.');
  }
  if (!['needs_information', 'stale', 'failed'].includes(predecessor.status)) {
    throw new PartnerWorkflowError('bad_invoice_correction', 'Only a handoff that needs information, is stale, or failed can be corrected.');
  }
  if (predecessor.input_provenance === 'sample' && input.input_provenance !== 'sample') {
    throw new PartnerWorkflowError('input_provenance_mismatch', 'A sample invoice lineage cannot be promoted to customer data.');
  }
  const result = await createIntake(tx, env, workspaceId, userId, input, jobs, {
    id: predecessor.id, revision: predecessor.revision,
    lineageRootId: predecessor.lineage_root_id ?? predecessor.id,
  });
  return partnerInvoiceCorrectionResultSchema.parse({
    superseded_handoff_id: predecessor.id, handoff_id: result.handoff_id,
    handoff_revision: result.handoff_revision, intake_event_id: result.intake_event_id,
    payload_hash: result.payload_hash, source_run_id: result.source_run_id,
    finance_run_id: result.finance_run_id, input_provenance: result.input_provenance, created: result.created,
  });
}

export async function publishConfirmedPartnerInvoiceReview(
  tx: Tx,
  workspaceId: string,
  runId: string,
  agentId: string,
  input: { intake_event_id: string; expected_payload_hash: string },
): Promise<{ handoff_id: string; job_id: string | null; created: boolean }> {
  const row = (await tx.query<{
    handoff_id: string; payload_hash: string; source_run_id: string; superseded_by_handoff_id: string | null;
  }>(
    `SELECT pii.handoff_id,pii.payload_hash,pii.source_run_id,h.superseded_by_handoff_id
       FROM partner_invoice_intakes pii
       JOIN partner_handoffs h ON h.workspace_id=pii.workspace_id AND h.id=pii.handoff_id
      WHERE pii.workspace_id=$1 AND pii.id=$2`,
    [workspaceId, input.intake_event_id],
  )).rows[0];
  if (!row || row.source_run_id !== runId) {
    throw new PartnerWorkflowError('run_grant_missing', 'This run is not bound to that confirmed invoice intake.');
  }
  if (row.payload_hash !== input.expected_payload_hash) {
    throw new PartnerWorkflowError('authorization_hash_mismatch', 'The confirmed intake payload hash does not match.');
  }
  if (row.superseded_by_handoff_id) throw new PartnerWorkflowError('handoff_superseded', 'This intake has been superseded by a correction.');
  const grant = await tx.query(
    `SELECT 1 FROM enterprise_run_grants g
       JOIN enterprise_skill_assignments esa ON esa.id=g.assignment_id
       JOIN enterprise_connection_bindings ecb ON ecb.id=g.connection_binding_id
      WHERE g.workspace_id=$1 AND g.run_id=$2 AND g.agent_id=$3
        AND g.capability='partner.handoff.publish' AND g.resource_kind='handoff' AND g.resource_id=$4
        AND g.effect='allow' AND g.revoked_at IS NULL AND 'publish_handoff'=ANY(g.allowed_actions)
        AND esa.state='active' AND esa.revision=g.assignment_revision AND ecb.state='active'`,
    [workspaceId, runId, agentId, row.handoff_id],
  );
  if (!grant.rows[0]) throw new PartnerWorkflowError('run_grant_missing', 'The current run lacks the exact handoff publication grant.');
  const existing = await tx.query<{ id: string }>(
    `SELECT id FROM jobs WHERE workspace_id=$1 AND kind='partner_invoice_review' AND key=$2`,
    [workspaceId, `partner-invoice-review:${row.handoff_id}`],
  );
  const jobId = existing.rows[0]?.id ?? await enqueueJob(
    tx, workspaceId, 'partner_invoice_review', `partner-invoice-review:${row.handoff_id}`,
    { handoff_id: row.handoff_id, intake_event_id: input.intake_event_id, payload_hash: row.payload_hash },
  );
  return { handoff_id: row.handoff_id, job_id: jobId, created: !existing.rows[0] };
}

function resultKind(validation: string): PartnerHandoffResult['kind'] {
  if (validation === 'passed') return 'checks_passed';
  if (validation === 'needs_information') return 'needs_information';
  if (validation === 'stale') return 'stale_source';
  if (validation === 'failed') return 'failed_processing';
  return 'pending_checks';
}

export async function getPartnerHandoffResult(
  tx: Tx,
  workspaceId: string,
  handoffId: string,
  viewer: { userId?: string; runId?: string; agentId?: string },
): Promise<PartnerHandoffResult> {
  const role = await actors(tx, workspaceId);
  const humanRole = viewer.userId === role.partnerships.principal_user_id ? 'partnerships'
    : viewer.userId === role.finance.principal_user_id ? 'finance' : null;
  if (viewer.runId && viewer.agentId) {
    const grant = await tx.query(
      `SELECT 1 FROM enterprise_run_grants g
        JOIN enterprise_skill_assignments esa ON esa.id=g.assignment_id
        JOIN enterprise_connection_bindings ecb ON ecb.id=g.connection_binding_id
       WHERE g.workspace_id=$1 AND g.run_id=$2 AND g.agent_id=$3
         AND g.resource_kind='handoff' AND g.resource_id=$4 AND g.capability='partner.shared.read'
         AND g.effect='allow' AND g.revoked_at IS NULL AND 'read_shared'=ANY(g.allowed_actions)
         AND esa.state='active' AND esa.revision=g.assignment_revision AND ecb.state='active'`,
      [workspaceId, viewer.runId, viewer.agentId, handoffId],
    );
    if (!grant.rows[0]) throw new PartnerWorkflowError('run_grant_missing', 'The current Finance run cannot read that handoff.');
  } else if (!humanRole) {
    throw new PartnerWorkflowError('handoff_not_found', 'No such invoice handoff.');
  }
  const row = (await tx.query<{
    id: string; revision: number; supersedes_handoff_id: string | null; source_record_id: string;
    source_record_revision: number; payload_hash: string; projection: unknown; request_id: string | null;
    delivery_status: string; validation_status: string; agent_explanation_status: string;
    human_decision_status: string; acknowledgment_status: string; checks: unknown; result_reason: string | null;
    engagement_attachment_id: string; engagement_name: string; engagement_sha256: string;
    engagement_created_at: Date; engagement_author: string | null; engagement_excerpt: string;
    authorization_hash: string; invoice_attachment_id: string; invoice_name: string; invoice_sha256: string;
    invoice_created_at: Date; invoice_author: string | null; invoice_excerpt: string;
    input_provenance: 'sample' | 'customer' | null;
  }>(
    `SELECT h.id,h.revision,h.supersedes_handoff_id,h.source_record_id,h.source_record_revision,
            h.payload_hash,h.projection,h.input_provenance,e.request_id,h.delivery_status,h.validation_status,
            h.agent_explanation_status,h.human_decision_status,h.acknowledgment_status,h.checks,h.result_reason,
            pea.source_attachment_id AS engagement_attachment_id,pea.source_name AS engagement_name,
            pea.source_sha256 AS engagement_sha256,pea.source_created_at AS engagement_created_at,
            pea.source_author_name AS engagement_author,pea.permitted_evidence_excerpt AS engagement_excerpt,
            pea.authorization_hash,
            pii.invoice_source_attachment_id AS invoice_attachment_id,pii.invoice_source_name AS invoice_name,
            pii.invoice_source_sha256 AS invoice_sha256,pii.invoice_source_created_at AS invoice_created_at,
            pii.invoice_source_author_name AS invoice_author,pii.invoice_source_excerpt AS invoice_excerpt
       FROM partner_handoffs h
       JOIN partner_engagement_authorizations pea
         ON pea.workspace_id=h.workspace_id AND pea.engagement_record_id=h.source_record_id
       JOIN partner_invoice_intakes pii ON pii.workspace_id=h.workspace_id AND pii.handoff_id=h.id
       LEFT JOIN partner_workflow_executions e ON e.workspace_id=h.workspace_id AND e.handoff_id=h.id
      WHERE h.workspace_id=$1 AND h.id=$2`,
    [workspaceId, handoffId],
  )).rows[0];
  if (!row) throw new PartnerWorkflowError('handoff_not_found', 'No such invoice handoff.');
  const projection = partnerInvoiceHandoffProjectionSchema.parse(row.projection);
  const kind = resultKind(row.validation_status);
  const result = {
    kind, handoff_id: row.id, handoff_revision: row.revision,
    supersedes_handoff_id: row.supersedes_handoff_id,
    engagement_record_id: row.source_record_id, engagement_revision: row.source_record_revision,
    authorization_hash: row.authorization_hash,
    input_provenance: row.input_provenance ?? projection.input_provenance,
    request_id: humanRole === 'partnerships' ? null : row.request_id,
    source_versions: {
      engagement: { attachment_id: row.engagement_attachment_id, name: row.engagement_name,
        sha256: row.engagement_sha256, created_at: row.engagement_created_at.toISOString(),
        author_name: row.engagement_author, excerpt: row.engagement_excerpt },
      invoice: { attachment_id: row.invoice_attachment_id, name: row.invoice_name,
        sha256: row.invoice_sha256, created_at: row.invoice_created_at.toISOString(),
        author_name: row.invoice_author, excerpt: row.invoice_excerpt },
    },
    checks: row.checks,
    outcome: {
      delivery: row.delivery_status, validation: row.validation_status,
      agent_explanation: row.agent_explanation_status, human_decision: row.human_decision_status,
      acknowledgment: row.acknowledgment_status,
    },
    ...(kind === 'failed_processing' ? { failure_code: row.result_reason ?? 'processing_failed' } : {}),
  };
  return partnerHandoffResultSchema.parse(result);
}

export async function loadPartnerWorkflowViewV2(
  tx: Tx, workspaceId: string, userId: string,
): Promise<PartnerWorkflowViewV2> {
  const member = (await tx.query<{ role: string }>(
    `SELECT role FROM members WHERE workspace_id=$1 AND user_id=$2 AND status='active'`, [workspaceId, userId],
  )).rows[0];
  if (!member) throw new PartnerWorkflowError('forbidden_partner_workflow_action', 'Active workspace membership is required.');
  let role: Awaited<ReturnType<typeof actors>> | null = null;
  try { role = await actors(tx, workspaceId); } catch (error) {
    if (!(error instanceof PartnerWorkflowError) || error.reason !== 'workflow_not_configured') throw error;
  }
  const viewerRole = role && userId === role.partnerships.principal_user_id ? 'partnerships'
    : role && userId === role.finance.principal_user_id ? 'finance'
      : member.role === 'admin' ? 'admin' : 'unrelated';
  const teams = await tx.query<{ id: string; slug: string; name: string }>(
    `SELECT id,slug,name FROM enterprise_teams WHERE workspace_id=$1 ORDER BY slug DESC`, [workspaceId],
  );
  const agents = await tx.query<{
    id: string; name: string; principal_user_id: string; principal_name: string; team_id: string;
    team_slug: 'partnerships' | 'finance'; team_name: 'Partnerships' | 'Finance';
    role_template_key: 'partnerships-agent' | 'finance-agent'; role_template_version: string;
    assignment_id: string; skill_key: 'partner-program-screening' | 'partner-invoice-review';
    skill_version: string; assignment_state: 'active' | 'paused'; assignment_revision: number;
    schedule: { enabled?: boolean }; capability_grants: string[]; artifact_digest: string;
  }>(
    `SELECT a.id,a.name,eta.principal_user_id,COALESCE(u.name,u.email) AS principal_name,
            et.id AS team_id,et.slug AS team_slug,et.name AS team_name,eta.role_template_key,
            eta.role_template_version,esa.id AS assignment_id,esa.skill_key,esa.skill_version,
            esa.state AS assignment_state,esa.revision AS assignment_revision,esa.schedule,
            esa.capability_grants,art.digest AS artifact_digest
       FROM enterprise_team_agents eta
       JOIN enterprise_teams et ON et.workspace_id=eta.workspace_id AND et.id=eta.team_id
       JOIN agents a ON a.workspace_id=eta.workspace_id AND a.id=eta.agent_id
       JOIN users u ON u.id=eta.principal_user_id
       JOIN enterprise_skill_assignments esa
         ON esa.workspace_id=eta.workspace_id AND esa.agent_id=eta.agent_id AND esa.team_id=eta.team_id
        AND esa.skill_key=CASE et.slug
          WHEN 'partnerships' THEN 'partner-program-screening' ELSE 'partner-invoice-review' END
       JOIN enterprise_skill_artifacts art ON art.id=esa.artifact_id
      WHERE eta.workspace_id=$1 ORDER BY et.slug DESC`, [workspaceId],
  );
  const settings = (await tx.query<{
    admission_state: 'disabled' | 'enabled';
    readiness: Record<string, {
      agent_id?: string; assignment_id?: string; assignment_revision?: number;
      skill_version?: string; artifact_digest?: string;
    }>;
  }>(
    `SELECT admission_state,readiness FROM partner_workflow_settings WHERE workspace_id=$1`, [workspaceId],
  )).rows[0];
  const admissionState = settings?.admission_state ?? 'disabled';
  const canSeePrivate = viewerRole === 'partnerships' || viewerRole === 'finance';
  const engagements = canSeePrivate ? (await tx.query<{
    id: string; revision: number; authorization_hash: string; status: string; partner_id: string;
    partner_name: string; engagement_reference: string; purpose: string; currency: string;
    authorized_total_minor: number; valid_from: string; valid_until: string; source_attachment_id: string;
    source_name: string; source_sha256: string; source_created_at: Date; source_author_name: string | null;
    permitted_evidence_excerpt: string;
    input_provenance: 'sample' | 'customer';
  }>(
    `SELECT pr.id,pr.revision,pea.authorization_hash,pea.status,pea.input_provenance,
            pea.partner_id,pea.partner_name,
            pea.engagement_reference,pea.purpose,pea.currency,pea.authorized_total_minor,
            pea.valid_from::text,pea.valid_until::text,pea.source_attachment_id,pea.source_name,
            pea.source_sha256,pea.source_created_at,pea.source_author_name,pea.permitted_evidence_excerpt
       FROM partner_engagement_authorizations pea
       JOIN partner_records pr ON pr.workspace_id=pea.workspace_id AND pr.id=pea.engagement_record_id
      WHERE pea.workspace_id=$1 ORDER BY pea.created_at DESC LIMIT 25`, [workspaceId],
  )).rows : [];
  const handoffs = canSeePrivate ? (await tx.query<{
    id: string; revision: number; supersedes_handoff_id: string | null; superseded_by_handoff_id: string | null;
    projection: unknown; source_session_id: string; finance_session_id: string | null; request_id: string | null;
    delivery_status: string; validation_status: string; agent_explanation_status: string;
    human_decision_status: string; acknowledgment_status: string; checks: unknown; result_reason: string | null;
    simulated: boolean; input_provenance: 'sample' | 'customer' | null;
    created_at: Date; decided_at: Date | null; ack: unknown; invoice_data: unknown;
  }>(
    `SELECT h.id,h.revision,h.supersedes_handoff_id,h.superseded_by_handoff_id,h.projection,
            h.source_session_id,e.finance_session_id,e.request_id,h.delivery_status,h.validation_status,
            h.agent_explanation_status,h.human_decision_status,h.acknowledgment_status,h.checks,
            h.result_reason,h.simulated,h.input_provenance,h.created_at,d.decided_at,invoice_rev.data AS invoice_data,
            CASE WHEN ack.id IS NULL THEN NULL ELSE jsonb_build_object(
              'handoff_id',ack.handoff_id,'partner_id',ack.partner_id,'partner_name',ack.partner_name,
              'engagement_reference',ack.engagement_reference,'outcome',ack.outcome,'result_code',ack.result_code,
              'finance_reviewer_display',ack.finance_reviewer_display,'recorded_at',ack.recorded_at,
              'delivery_status',ack.delivery_status) END AS ack
       FROM partner_handoffs h
       LEFT JOIN partner_workflow_executions e ON e.handoff_id=h.id
       JOIN partner_record_revisions invoice_rev
         ON invoice_rev.workspace_id=h.workspace_id AND invoice_rev.record_id=h.invoice_record_id
        AND invoice_rev.revision=h.invoice_record_revision
       LEFT JOIN decisions d ON d.request_id=e.request_id
       LEFT JOIN partner_decision_acknowledgments ack ON ack.handoff_id=h.id
      WHERE h.workspace_id=$1 ORDER BY h.created_at DESC LIMIT 25`, [workspaceId],
  )).rows : [];
  const partnerOptions = viewerRole === 'partnerships' && role ? (await tx.query<{ id: string; name: string; source: string }>(
    `SELECT id,display_name AS name,'candidate'::text AS source FROM partner_candidates
      WHERE workspace_id=$1 AND agent_id=$2
     UNION
     SELECT partner_id,partner_name,'engagement'::text FROM partner_engagement_authorizations
      WHERE workspace_id=$1 ORDER BY name LIMIT 50`, [workspaceId, role.partnerships.agent_id],
  )).rows : [];
  const configured = agents.rows.length === 2;
  const expectedDefinitions = {
    partnerships: PARTNER_PROGRAM_MULTI_PARTY_DEFINITION,
    finance: PARTNER_INVOICE_REVIEW_DEFINITION,
  } as const;
  const roleReady = (slug: 'partnerships' | 'finance') => {
    const row = agents.rows.find((agent) => agent.team_slug === slug);
    const attested = settings?.readiness?.[slug];
    const definition = expectedDefinitions[slug];
    return Boolean(row && attested && row.assignment_state === 'active'
      && row.skill_key === definition.key && row.skill_version === definition.version
      && row.artifact_digest === definition.artifactDigest
      && attested.agent_id === row.id && attested.assignment_id === row.assignment_id
      && attested.assignment_revision === row.assignment_revision
      && attested.skill_version === row.skill_version
      && attested.artifact_digest === row.artifact_digest);
  };
  const workflowReady = roleReady('partnerships') && roleReady('finance');
  return partnerWorkflowViewV2Schema.parse({
    configured, admission_state: admissionState, viewer_role: viewerRole,
    actions: {
      configure: member.role === 'admin', set_admission: member.role === 'admin' && configured,
      propose_engagement: viewerRole === 'partnerships',
      submit_invoice: viewerRole === 'partnerships' && admissionState === 'enabled' && workflowReady,
      correct_invoice: viewerRole === 'partnerships' && admissionState === 'enabled' && workflowReady,
      view_finance_review: viewerRole === 'finance',
    },
    teams: teams.rows,
    agents: agents.rows.map((row) => ({
      id: row.id,name: row.name,principal_user_id: row.principal_user_id,principal_name: row.principal_name,
      team: { id: row.team_id,slug: row.team_slug,name: row.team_name },
      role_template: { key: row.role_template_key,
        name: row.role_template_key === 'partnerships-agent' ? 'Partnerships agent' : 'Finance agent',
        version: row.role_template_version },
      skill_key: row.skill_key,skill_name: row.skill_key === 'partner-program-screening'
        ? 'Partner program screening' : 'Partner invoice review',skill_version: row.skill_version,
      assignment_id: row.assignment_id,assignment_revision: row.assignment_revision,
      assignment_state: row.assignment_state,schedule_enabled: row.schedule.enabled === true,
      capabilities: row.capability_grants,
    })),
    readiness: viewerRole === 'unrelated' ? [] : (['partnerships','finance'] as const).map((slug) => {
      const row = agents.rows.find((agent) => agent.team_slug === slug);
      const attested = settings?.readiness?.[slug];
      const ready = roleReady(slug);
      return {
        role: slug, configured: Boolean(row), assignment_state: row?.assignment_state ?? 'missing',
        native_status: ready ? 'ready' : row ? 'not_ready' : 'unknown',
        skill_key: slug === 'partnerships' ? 'partner-program-screening' : 'partner-invoice-review',
        skill_version: row?.skill_version ?? null, artifact_digest: row?.artifact_digest ?? null,
        missing: ready ? [] : row ? ['skill','tools','provider'] : ['principal','agent','assignment','skill','tools','provider'],
      };
    }),
    partner_options: partnerOptions,
    engagements: engagements.map((row) => ({
      id: row.id,revision: row.revision,authorization_hash: row.authorization_hash,
      authorization_status: row.status,input_provenance: row.input_provenance,
      partner: { id: row.partner_id,name: row.partner_name },
      reference: row.engagement_reference,purpose: row.purpose,currency: row.currency,
      authorized_total_minor: row.authorized_total_minor,valid_from: row.valid_from,valid_until: row.valid_until,
      one_invoice: true,source: { attachment_id: row.source_attachment_id,name: row.source_name,
        sha256: row.source_sha256,created_at: row.source_created_at.toISOString(),author_name: row.source_author_name,
        excerpt: row.permitted_evidence_excerpt },
    })),
    handoffs: handoffs.map((row) => {
      const projection = partnerInvoiceHandoffProjectionSchema.parse(row.projection);
      const invoice = invoicePayloadSchema.parse(row.invoice_data);
      return {
        id: row.id,revision: row.revision,supersedes_handoff_id: row.supersedes_handoff_id,
        superseded_by_handoff_id: row.superseded_by_handoff_id,current: !row.superseded_by_handoff_id,
        partner_id: projection.partner.id,partner_name: projection.partner.name,
        engagement_reference: projection.engagement.reference,
        invoice_number: invoice.number,invoice_currency: invoice.currency,
        invoice_total_minor: invoice.total_minor,
        source_session_id: viewerRole === 'partnerships' ? row.source_session_id : null,
        finance_session_id: viewerRole === 'finance' ? row.finance_session_id : null,
        request_id: viewerRole === 'finance' ? row.request_id : null,
        outcome: { delivery: row.delivery_status,validation: row.validation_status,
          agent_explanation: row.agent_explanation_status,human_decision: row.human_decision_status,
          acknowledgment: row.acknowledgment_status },
        result_kind: resultKind(row.validation_status),result_reason: row.result_reason,
        checks: row.checks,acknowledgment: row.ack ? partnerDecisionAcknowledgmentSchema.parse({
          ...(row.ack as Record<string, unknown>),
          recorded_at: new Date((row.ack as { recorded_at: string }).recorded_at).toISOString(),
        }) : null,input_provenance: row.input_provenance ?? projection.input_provenance,
        simulated: row.simulated,created_at: row.created_at.toISOString(),
        decided_at: row.decided_at?.toISOString() ?? null,
      };
    }),
    connector: { name: 'enterprise-partner-records',shared_code: true,enforcement: 'server',
      summary: 'Shared identity and approved engagement evidence only; private research and invoice data stay team-scoped.' },
  });
}
