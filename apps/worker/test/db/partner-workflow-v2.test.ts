// Independent Postgres acceptance for the exact-authority partner workflow.
//
// The storage and native-run edges are deterministic fixtures, but every
// authority, replay, correction, request, decision, draft and acknowledgment
// assertion below crosses the real tenant schema and production services.
import { createHash, randomUUID } from 'node:crypto';
import {
  approvalPayloadSchema,
  approvalViewSchema,
  requestEntitySchema,
  requestReviewBinding,
  type PartnerInvoiceCorrectionInput,
  type PartnerInvoiceIntakeInput,
} from '@hermes/shared';
import { describe, expect, it } from 'vitest';
import type { Env } from '../../src/env.js';
import type { Job } from '../../src/jobs.js';
import { RuntimeDb } from '../../src/runtime/store.js';
import { runPartnerInvoiceReviewJob } from '../../src/partner-workflow/job.js';
import {
  configurePartnerWorkflow,
  PartnerWorkflowError,
  preparePartnerInvoiceReviewModelTurn,
  processPartnerInvoiceReview,
} from '../../src/partner-workflow/service.js';
import {
  correctPartnerInvoiceIntake,
  getPartnerHandoffResult,
  materializePartnerEngagementAuthorization,
  proposePartnerEngagementAuthorization,
  publishConfirmedPartnerInvoiceReview,
  submitPartnerInvoiceIntake,
} from '../../src/partner-workflow/v2.js';
import { asUser, makeEnv } from './harness.js';
import { seedWorkspace, setTenant, withClient, type Fixture } from './helpers.js';
import { INBOX_HEADERS } from './m4-fixtures.js';

const ACTIVE_FROM = '2026-01-01';
const ACTIVE_UNTIL = '2099-12-31';
const AMOUNT_MINOR = 120_000;

interface WorkflowFixture extends Fixture {
  readonly financeAgentId: string;
  readonly unrelatedId: string;
  readonly candidateId: string;
  readonly env: Env;
  readonly storedText: Map<string, string>;
}

interface SourceFixture {
  readonly attachmentId: string;
  readonly sha256: string;
  readonly sessionId: string;
  readonly seedRunId: string;
  readonly storageKey: string;
  readonly text: string;
}

interface AuthorizedTerms {
  readonly approvalRequestId: string;
  readonly authorizationHash: string;
  readonly engagementRecordId: string;
  readonly engagementRevision: number;
  readonly source: SourceFixture;
  readonly inputProvenance: 'sample' | 'customer';
}

async function appTransaction<T>(
  fx: WorkflowFixture,
  userId: string,
  work: (client: Awaited<ReturnType<typeof import('./helpers.js')['client']>>) => Promise<T>,
): Promise<T> {
  return withClient('app', async (client) => {
    await client.query('BEGIN');
    try {
      await setTenant(client, fx.workspaceId, userId);
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}

function storageBucket(storedText: Map<string, string>): R2Bucket {
  return {
    get: async (key: string) => {
      const text = storedText.get(key);
      return text === undefined ? null : { text: async () => text } as R2ObjectBody;
    },
  } as unknown as R2Bucket;
}

async function workflowFixture(): Promise<WorkflowFixture> {
  const fx = await seedWorkspace();
  const financeAgentId = randomUUID();
  const unrelatedId = randomUUID();
  const candidateId = randomUUID();
  const candidateRunId = randomUUID();
  const storedText = new Map<string, string>();
  const { env } = makeEnv({
    MODEL_SCRIPTED: '1',
    ALLOWED_PROVIDERS: 'deepseek,anthropic,openai,nous_portal,openrouter',
    UPLOADS: storageBucket(storedText),
  });

  await withClient('owner', async (client) => {
    await client.query('BEGIN');
    try {
      await client.query(
        `INSERT INTO users (id,email,email_verified,name)
         VALUES ($1,$2,true,'Unaffiliated User')`,
        [unrelatedId, `unrelated-${fx.workspaceId}@example.test`],
      );
      await setTenant(client, fx.workspaceId, fx.adminId);
      await client.query(
        `INSERT INTO members (workspace_id,user_id,role,reviewer_roles)
         VALUES ($1,$2,'member','{}'::text[])`,
        [fx.workspaceId, unrelatedId],
      );
      await client.query(
        `INSERT INTO agents (id,workspace_id,name,status)
         VALUES ($1,$2,'Ledger','started')`,
        [financeAgentId, fx.workspaceId],
      );
      await client.query(
        `INSERT INTO runs
           (id,workspace_id,session_id,agent_id,status,model_id,client_turn_id,trace_id,ended_at)
         VALUES ($1,$2,$3,$4,'completed','deepseek-flash',$5,$6,now())`,
        [candidateRunId, fx.workspaceId, fx.sessionId, fx.agentId,
          `candidate-${candidateRunId}`, randomUUID()],
      );
      await client.query(
        `INSERT INTO partner_screening_runs
           (id,workspace_id,agent_id,created_by,idempotency_key,status,source,authentication,
            config_snapshot,api_requests_max,candidates_discovered,completed_at)
         VALUES ($1,$2,$3,$4,$5,'completed','github','unauthenticated','{}'::jsonb,1,1,now())`,
        [candidateRunId, fx.workspaceId, fx.agentId, fx.adminId, `candidate-${candidateRunId}`],
      );
      await client.query(
        `INSERT INTO partner_candidates
           (id,workspace_id,agent_id,source,source_key,display_name,profile_url,
            deterministic_priority,priority_breakdown,confidence,evidence_gaps,
            latest_run_id,first_seen_at,last_seen_at)
         VALUES ($1,$2,$3,'github',$4,'Private Partner LLC',$5,90,
                 '{"fit":90}'::jsonb,'high','{}'::text[],$6,now(),now())`,
        [candidateId, fx.workspaceId, fx.agentId, `candidate-${candidateId}`,
          `https://partners.example.test/${candidateId}`, candidateRunId],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });

  const result = { ...fx, financeAgentId, unrelatedId, candidateId, env, storedText };
  await appTransaction(result, fx.adminId, async (client) => {
    await configurePartnerWorkflow(client, fx.workspaceId, fx.adminId, {
      partnerships: { agent_id: fx.agentId, principal_user_id: fx.adminId },
      finance: { agent_id: financeAgentId, principal_user_id: fx.memberId },
    });
    const roles = await client.query<{
      role: 'partnerships' | 'finance';
      agent_id: string;
      assignment_id: string;
      assignment_revision: number;
      skill_name: string;
      skill_version: string;
      artifact_digest: string;
      tool_names: string[];
    }>(
      `SELECT et.slug AS role,eta.agent_id,esa.id AS assignment_id,
              esa.revision AS assignment_revision,art.manifest->>'runtime_name' AS skill_name,
              esa.skill_version,art.digest AS artifact_digest,
              CASE et.slug
                WHEN 'partnerships' THEN ARRAY['publish_partner_invoice_review']::text[]
                ELSE ARRAY['get_partner_handoff_result','list_requests','get_request']::text[]
              END AS tool_names
         FROM enterprise_team_agents eta
         JOIN enterprise_teams et ON et.id=eta.team_id
         JOIN enterprise_skill_assignments esa
           ON esa.workspace_id=eta.workspace_id AND esa.team_id=eta.team_id AND esa.agent_id=eta.agent_id
          AND esa.skill_key=CASE et.slug
            WHEN 'partnerships' THEN 'partner-program-screening' ELSE 'partner-invoice-review' END
         JOIN enterprise_skill_artifacts art ON art.id=esa.artifact_id
        WHERE eta.workspace_id=$1`,
      [fx.workspaceId],
    );
    const checkedAt = new Date().toISOString();
    const readiness = Object.fromEntries(roles.rows.map((role) => [role.role, {
      agent_id: role.agent_id,
      assignment_id: role.assignment_id,
      assignment_revision: role.assignment_revision,
      skill_name: role.skill_name,
      skill_version: role.skill_version,
      artifact_digest: role.artifact_digest,
      runtime_revision: 'fixture-native-runtime',
      plugin_version: 'fixture-native-plugin',
      tool_names: role.tool_names,
      checked_at: checkedAt,
    }]));
    await client.query(
      `UPDATE partner_workflow_settings
          SET admission_state='enabled',enabled_by=$2,enabled_at=now(),readiness=$3::jsonb,
              readiness_checked_at=now()
        WHERE workspace_id=$1`,
      [fx.workspaceId, fx.adminId, JSON.stringify(readiness)],
    );
  });
  return result;
}

async function addSource(fx: WorkflowFixture, label: string, text: string): Promise<SourceFixture> {
  const attachmentId = randomUUID();
  const sessionId = randomUUID();
  const seedRunId = randomUUID();
  const sha256 = createHash('sha256').update(text).digest('hex');
  const storageKey = `w/${fx.workspaceId}/uploads/${attachmentId}`;
  fx.storedText.set(`${storageKey}.txt`, text);

  await withClient('owner', async (client) => {
    await client.query('BEGIN');
    try {
      await setTenant(client, fx.workspaceId, fx.adminId);
      await client.query(
        `INSERT INTO sessions (id,workspace_id,owner_id,agent_id,title,model_id,mode)
         VALUES ($1,$2,$3,$4,$5,'deepseek-flash','work')`,
        [sessionId, fx.workspaceId, fx.adminId, fx.agentId, `${label} source`],
      );
      await client.query(
        `INSERT INTO runs
           (id,workspace_id,session_id,agent_id,status,model_id,client_turn_id,trace_id,ended_at)
         VALUES ($1,$2,$3,$4,'completed','deepseek-flash',$5,$6,now())`,
        [seedRunId, fx.workspaceId, sessionId, fx.agentId, `seed-${seedRunId}`, randomUUID()],
      );
      await client.query(
        `INSERT INTO attachments
           (id,workspace_id,session_id,name,storage_key,size_bytes,mime,sha256,status,
            extraction_status,text_length,token_estimate,uploaded_by,completed_at)
         VALUES ($1,$2,$3,$4,$5,$6,'text/plain',$7,'ready','ready',$8,$9,$10,now())`,
        [attachmentId, fx.workspaceId, sessionId, `${label}.txt`, storageKey,
          Buffer.byteLength(text), sha256, text.length, Math.ceil(text.length / 4), fx.adminId],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
  return { attachmentId, sha256, sessionId, seedRunId, storageKey, text };
}

async function authorizeTerms(
  fx: WorkflowFixture,
  options: {
    key: string;
    source: SourceFixture;
    inputProvenance?: 'sample' | 'customer';
    reference?: string;
    amountMinor?: number;
    validFrom?: string;
    validUntil?: string;
  },
): Promise<AuthorizedTerms> {
  const inputProvenance = options.inputProvenance ?? 'customer';
  const result = await appTransaction(fx, fx.adminId, (client) =>
    proposePartnerEngagementAuthorization(client, fx.env, fx.workspaceId, fx.adminId, {
      input_provenance: inputProvenance,
      partner: { id: fx.candidateId, name: 'Private Partner LLC' },
      reference: options.reference ?? 'ENG-PRIVATE-2026',
      purpose: inputProvenance === 'sample'
        ? 'Demonstration-only partner workshop.'
        : 'One externally agreed partner workshop.',
      currency: 'USD',
      authorized_total_minor: options.amountMinor ?? AMOUNT_MINOR,
      valid_from: options.validFrom ?? ACTIVE_FROM,
      valid_until: options.validUntil ?? ACTIVE_UNTIL,
      one_invoice: true,
      permitted_evidence_excerpt: options.source.text,
      source: { attachment_id: options.source.attachmentId, expected_sha256: options.source.sha256 },
      idempotency_key: options.key,
    }, []));

  const approval = await asUser(
    fx.env,
    fx.memberId,
    `/w/${fx.workspaceId}/requests/${result.approval_request_id}/approval/decisions`,
    {
      method: 'POST',
      headers: INBOX_HEADERS,
      body: {
        decision: 'approve',
        note: null,
        expected_authorization_revision: result.authorization_revision,
        expected_authorization_hash: result.authorization_hash,
        idempotency_key: `approve:${options.key}`,
      },
    },
  );
  expect(approval.status).toBe(201);
  const view = approvalViewSchema.parse(await approval.json());
  expect(view.status).toBe('approved');

  const materialized = await appTransaction(fx, fx.adminId, (client) =>
    materializePartnerEngagementAuthorization(client, {
      workspaceId: fx.workspaceId,
      requestId: result.approval_request_id,
      authorizationRevision: result.authorization_revision,
      authorizationHash: result.authorization_hash,
      payload: approvalPayloadSchema.parse(view.payload),
    }));
  expect(materialized).toBe(true);

  return appTransaction(fx, fx.adminId, async (client) => {
    const row = (await client.query<{
      engagement_record_id: string;
      revision: number;
      status: string;
      input_provenance: 'sample' | 'customer';
    }>(
      `SELECT pea.engagement_record_id,pr.revision,pea.status,pea.input_provenance
         FROM partner_engagement_authorizations pea
         JOIN partner_records pr ON pr.id=pea.engagement_record_id
        WHERE pea.workspace_id=$1 AND pea.approval_request_id=$2`,
      [fx.workspaceId, result.approval_request_id],
    )).rows[0];
    expect(row).toMatchObject({ status: 'authorized', input_provenance: inputProvenance });
    return {
      approvalRequestId: result.approval_request_id,
      authorizationHash: result.authorization_hash,
      engagementRecordId: row!.engagement_record_id,
      engagementRevision: row!.revision,
      source: options.source,
      inputProvenance,
    };
  });
}

function invoice(number: string, totalMinor = AMOUNT_MINOR, currency = 'USD') {
  return {
    kind: 'invoice' as const,
    number,
    currency,
    payee: { name: 'Private Partner LLC', email: 'billing@private-partner.example' },
    payer: { name: 'Hermes Enterprise' },
    issue_date: '2026-09-01',
    due_date: '2026-09-30',
    lines: [{ id: 'workshop', label: 'Partner workshop', qty: 1, amount_minor: totalMinor, source_ids: [] }],
    total_minor: totalMinor,
    notes: 'FINANCE-PRIVATE-NOTE',
  };
}

function intakeInput(
  terms: AuthorizedTerms,
  source: SourceFixture,
  key: string,
  value = invoice(`INV-${key}`),
): PartnerInvoiceIntakeInput {
  return {
    input_provenance: terms.inputProvenance,
    engagement_record_id: terms.engagementRecordId,
    expected_engagement_revision: terms.engagementRevision,
    expected_authorization_hash: terms.authorizationHash,
    invoice_source: { attachment_id: source.attachmentId, expected_sha256: source.sha256 },
    invoice: value,
    idempotency_key: key,
  };
}

function correctionInput(
  terms: AuthorizedTerms,
  source: SourceFixture,
  key: string,
  expectedHandoffRevision: number,
  value = invoice(`INV-${key}`),
): PartnerInvoiceCorrectionInput {
  return {
    ...intakeInput(terms, source, key, value),
    expected_handoff_revision: expectedHandoffRevision,
  };
}

async function submitIntake(fx: WorkflowFixture, input: PartnerInvoiceIntakeInput) {
  return appTransaction(fx, fx.adminId, (client) =>
    submitPartnerInvoiceIntake(client, fx.env, fx.workspaceId, fx.adminId, input, []));
}

async function executeNativeShapedReview(
  fx: WorkflowFixture,
  intake: Awaited<ReturnType<typeof submitIntake>>,
) {
  return appTransaction(fx, fx.adminId, async (client) => {
    const published = await publishConfirmedPartnerInvoiceReview(
      client,
      fx.workspaceId,
      intake.source_run_id,
      fx.agentId,
      { intake_event_id: intake.intake_event_id, expected_payload_hash: intake.payload_hash },
    );
    const create = await preparePartnerInvoiceReviewModelTurn(
      client, fx.env, fx.workspaceId, intake.handoff_id, [],
    );
    expect(create).not.toBeNull();
    const outcome = await processPartnerInvoiceReview(client, fx.workspaceId, intake.handoff_id);
    if (create) {
      await client.query(
        `UPDATE runs SET status='completed',ended_at=now() WHERE workspace_id=$1 AND id=$2`,
        [fx.workspaceId, create.runId],
      );
      await client.query(`SELECT project_partner_handoff_run_outcome($1)`, [create.runId]);
    }
    const execution = (await client.query<{ finance_run_id: string; request_id: string | null }>(
      `SELECT finance_run_id,request_id FROM partner_workflow_executions
        WHERE workspace_id=$1 AND handoff_id=$2`,
      [fx.workspaceId, intake.handoff_id],
    )).rows[0]!;
    const result = await getPartnerHandoffResult(
      client,
      fx.workspaceId,
      intake.handoff_id,
      outcome === 'stale'
        ? { userId: fx.memberId }
        : { runId: execution.finance_run_id, agentId: fx.financeAgentId },
    );
    return { published, outcome, execution, result };
  });
}

async function financeReviewBinding(fx: WorkflowFixture, requestId: string) {
  const response = await asUser(fx.env, fx.memberId, `/w/${fx.workspaceId}/requests/${requestId}`);
  expect(response.status).toBe(200);
  return requestReviewBinding(requestEntitySchema.parse(await response.json()));
}

async function decideInvoice(
  fx: WorkflowFixture,
  requestId: string,
  binding: Awaited<ReturnType<typeof financeReviewBinding>>,
  decision: 'approve' | 'decline' = 'approve',
) {
  return asUser(fx.env, fx.memberId, `/w/${fx.workspaceId}/requests/${requestId}/decisions`, {
    method: 'POST',
    headers: INBOX_HEADERS,
    body: { decision, note: 'FINANCE PRIVATE DECISION NOTE', ...binding },
  });
}

describe('Partnerships + Finance exact-authority workflow v2', () => {
  it('turns exact human-authorized terms into one immutable intake, checked draft and safe acknowledgment', async () => {
    const fx = await workflowFixture();
    const termsSource = await addSource(fx, 'engagement', 'Exactly one workshop is authorized for USD 1,200.00.');
    const terms = await authorizeTerms(fx, { key: 'positive-terms', source: termsSource });
    const invoiceSource = await addSource(fx, 'invoice', 'Invoice INV-POSITIVE requests USD 1,200.00 for one workshop.');
    const input = intakeInput(terms, invoiceSource, 'positive-intake', invoice('INV-POSITIVE'));
    const created = await submitIntake(fx, input);
    expect(created.created).toBe(true);

    const replay = await submitIntake(fx, input);
    expect(replay).toEqual({ ...created, created: false });
    await expect(submitIntake(fx, { ...input, invoice: invoice('INV-POSITIVE', 119_999) }))
      .rejects.toMatchObject({ reason: 'idempotency_conflict' } satisfies Partial<PartnerWorkflowError>);
    await withClient('app', async (client) => {
      await client.query('BEGIN');
      await setTenant(client, fx.workspaceId, fx.adminId);
      await expect(client.query(
        `UPDATE partner_invoice_intakes SET invoice_payload='{}'::jsonb WHERE id=$1`,
        [created.intake_event_id],
      )).rejects.toThrow(/permission denied|immutable/i);
      await client.query('ROLLBACK');
    });

    const checked = await executeNativeShapedReview(fx, created);
    expect(checked.outcome).toBe('completed');
    expect(checked.result).toMatchObject({
      kind: 'checks_passed',
      input_provenance: 'customer',
      request_id: checked.execution.request_id,
      outcome: { validation: 'passed', agent_explanation: 'completed', human_decision: 'pending' },
    });
    expect(checked.result.checks).toHaveLength(7);
    expect(checked.result.checks.every((check) => check.status === 'passed')).toBe(true);

    await appTransaction(fx, fx.adminId, async (client) => {
      await expect(getPartnerHandoffResult(client, fx.workspaceId, created.handoff_id, {
        runId: randomUUID(), agentId: fx.financeAgentId,
      })).rejects.toMatchObject({ reason: 'run_grant_missing' } satisfies Partial<PartnerWorkflowError>);
      await expect(getPartnerHandoffResult(client, fx.workspaceId, created.handoff_id, {
        userId: fx.unrelatedId,
      })).rejects.toMatchObject({ reason: 'handoff_not_found' } satisfies Partial<PartnerWorkflowError>);
      await expect(publishConfirmedPartnerInvoiceReview(
        client, fx.workspaceId, created.source_run_id, fx.financeAgentId,
        { intake_event_id: created.intake_event_id, expected_payload_hash: created.payload_hash },
      )).rejects.toMatchObject({ reason: 'run_grant_missing' } satisfies Partial<PartnerWorkflowError>);
    });

    const requestId = checked.execution.request_id!;
    const binding = await financeReviewBinding(fx, requestId);
    const decision = await decideInvoice(fx, requestId, binding);
    expect(decision.status).toBe(201);
    const replayDecision = await decideInvoice(fx, requestId, binding);
    expect(replayDecision.status).toBe(200);
    expect(replayDecision.headers.get('x-hermes-conflict')).toBe('true');

    const persisted = await appTransaction(fx, fx.memberId, async (client) => {
      const documents = await client.query<{ id: string; kind: string; version: number; payload: unknown }>(
        `SELECT id,kind,version,payload FROM documents WHERE workspace_id=$1 AND request_id=$2`,
        [fx.workspaceId, requestId],
      );
      const acknowledgments = await client.query<Record<string, unknown>>(
        `SELECT handoff_id,partner_id,partner_name,engagement_reference,outcome,result_code,
                finance_reviewer_display,recorded_at,delivery_status
           FROM partner_decision_acknowledgments WHERE workspace_id=$1 AND handoff_id=$2`,
        [fx.workspaceId, created.handoff_id],
      );
      const acknowledgmentJobs = await client.query(
        `SELECT 1 FROM jobs WHERE workspace_id=$1 AND kind='partner_acknowledgment'
          AND payload->>'handoff_id'=$2`,
        [fx.workspaceId, created.handoff_id],
      );
      return { documents: documents.rows, acknowledgments: acknowledgments.rows, acknowledgmentJobs: acknowledgmentJobs.rows };
    });
    expect(persisted.documents).toHaveLength(1);
    expect(persisted.documents[0]).toMatchObject({ kind: 'invoice', version: 1 });
    expect(persisted.acknowledgments).toHaveLength(1);
    expect(persisted.acknowledgmentJobs).toHaveLength(1);
    expect(persisted.acknowledgments[0]).toMatchObject({
      handoff_id: created.handoff_id,
      partner_name: 'Private Partner LLC',
      engagement_reference: 'ENG-PRIVATE-2026',
      outcome: 'invoice_draft_saved',
      result_code: 'approved',
      delivery_status: 'delivered',
    });
    const safeAcknowledgment = JSON.stringify(persisted.acknowledgments[0]);
    expect(safeAcknowledgment).not.toContain('FINANCE PRIVATE');
    expect(safeAcknowledgment).not.toContain('billing@private-partner.example');
    expect(safeAcknowledgment).not.toContain('INV-POSITIVE');
    expect(safeAcknowledgment).not.toMatch(/https?:\/\//);
  });

  it('supersedes reserved but undecided terms, blocks the old decision and preserves later decided receipts', async () => {
    const fx = await workflowFixture();
    const sourceA = await addSource(fx, 'terms-a', 'Version A authorizes USD 1,200.00 for one workshop.');
    const termsA = await authorizeTerms(fx, { key: 'terms-a', source: sourceA, reference: 'ENG-REVISED' });
    const invoiceA = await addSource(fx, 'invoice-a', 'Invoice A requests USD 1,200.00.');
    const intakeA = await submitIntake(fx, intakeInput(termsA, invoiceA, 'intake-a', invoice('INV-A')));
    const checkedA = await executeNativeShapedReview(fx, intakeA);
    expect(checkedA.result.kind).toBe('checks_passed');
    const oldRequestId = checkedA.execution.request_id!;
    const oldBinding = await financeReviewBinding(fx, oldRequestId);

    const sourceB = await addSource(fx, 'terms-b', 'Version B replaces A and authorizes USD 1,200.00 for one workshop.');
    const termsB = await authorizeTerms(fx, { key: 'terms-b', source: sourceB, reference: 'ENG-REVISED' });
    const statesAfterB = await appTransaction(fx, fx.adminId, async (client) => (
      await client.query<{ approval_request_id: string; status: string }>(
        `SELECT approval_request_id,status FROM partner_engagement_authorizations
          WHERE workspace_id=$1 AND partner_id=$2 AND engagement_reference='ENG-REVISED'
          ORDER BY created_at`,
        [fx.workspaceId, fx.candidateId],
      )
    ).rows);
    expect(statesAfterB).toEqual([
      { approval_request_id: termsA.approvalRequestId, status: 'superseded' },
      { approval_request_id: termsB.approvalRequestId, status: 'authorized' },
    ]);
    await expect(submitIntake(
      fx,
      intakeInput(termsA, await addSource(fx, 'old-terms-invoice', 'Old terms invoice.'), 'old-terms-replay'),
    )).rejects.toMatchObject({ reason: 'authorization_superseded' } satisfies Partial<PartnerWorkflowError>);
    const staleDecision = await decideInvoice(fx, oldRequestId, oldBinding);
    expect(staleDecision.status).toBe(409);
    expect(await staleDecision.json()).toMatchObject({ reason: 'not_pending' });

    const invoiceB = await addSource(fx, 'invoice-b', 'Invoice B requests USD 1,200.00.');
    const intakeB = await submitIntake(fx, intakeInput(termsB, invoiceB, 'intake-b', invoice('INV-B')));
    const checkedB = await executeNativeShapedReview(fx, intakeB);
    const bindingB = await financeReviewBinding(fx, checkedB.execution.request_id!);
    expect((await decideInvoice(fx, checkedB.execution.request_id!, bindingB)).status).toBe(201);

    const sourceC = await addSource(fx, 'terms-c', 'Version C authorizes future work without rewriting the B receipt.');
    await authorizeTerms(fx, { key: 'terms-c', source: sourceC, reference: 'ENG-REVISED' });
    const retained = await appTransaction(fx, fx.adminId, async (client) => {
      const b = (await client.query<{ status: string }>(
        `SELECT status FROM partner_engagement_authorizations
          WHERE workspace_id=$1 AND approval_request_id=$2`,
        [fx.workspaceId, termsB.approvalRequestId],
      )).rows[0];
      const acknowledgment = await client.query(
        `SELECT 1 FROM partner_decision_acknowledgments
          WHERE workspace_id=$1 AND handoff_id=$2`,
        [fx.workspaceId, intakeB.handoff_id],
      );
      return { b, acknowledgmentCount: acknowledgment.rowCount };
    });
    expect(retained).toEqual({ b: { status: 'consumed' }, acknowledgmentCount: 1 });
  });

  it('keeps sample provenance through real materialization, review and correction and refuses promotion', async () => {
    const fx = await workflowFixture();
    const termsSource = await addSource(fx, 'sample-terms', 'SAMPLE ONLY: one demo workshop for USD 1,200.00.');
    const terms = await authorizeTerms(fx, {
      key: 'sample-terms', source: termsSource, inputProvenance: 'sample', reference: 'DEMO-ENGAGEMENT',
    });
    const mismatchSource = await addSource(fx, 'sample-mismatch', 'SAMPLE ONLY: invoice requests USD 900.00.');
    const mismatch = await submitIntake(
      fx,
      intakeInput(terms, mismatchSource, 'sample-mismatch', invoice('DEMO-INV', 90_000)),
    );
    const mismatchResult = await executeNativeShapedReview(fx, mismatch);
    expect(mismatchResult.outcome).toBe('needs_information');
    expect(mismatchResult.result).toMatchObject({
      kind: 'needs_information', input_provenance: 'sample', request_id: null,
      outcome: { validation: 'needs_information', human_decision: 'not_ready' },
    });

    const correctedSource = await addSource(fx, 'sample-corrected', 'SAMPLE ONLY: corrected invoice requests USD 1,200.00.');
    const promotion = {
      ...correctionInput(terms, correctedSource, 'sample-promote', mismatch.handoff_revision, invoice('DEMO-INV-CORRECTED')),
      input_provenance: 'customer' as const,
    };
    await expect(appTransaction(fx, fx.adminId, (client) =>
      correctPartnerInvoiceIntake(
        client, fx.env, fx.workspaceId, fx.adminId, mismatch.handoff_id, promotion, [],
      )))
      .rejects.toMatchObject({ reason: 'input_provenance_mismatch' } satisfies Partial<PartnerWorkflowError>);

    const corrected = await appTransaction(fx, fx.adminId, (client) =>
      correctPartnerInvoiceIntake(
        client, fx.env, fx.workspaceId, fx.adminId, mismatch.handoff_id,
        correctionInput(terms, correctedSource, 'sample-corrected', mismatch.handoff_revision, invoice('DEMO-INV-CORRECTED')),
        [],
      ));
    const correctedResult = await executeNativeShapedReview(fx, corrected);
    expect(correctedResult.result).toMatchObject({ kind: 'checks_passed', input_provenance: 'sample' });
    const stored = await appTransaction(fx, fx.adminId, async (client) => {
      const engagement = (await client.query<{ data: Record<string, unknown>; input_provenance: string }>(
        `SELECT pr.data,pea.input_provenance FROM partner_records pr
          JOIN partner_engagement_authorizations pea ON pea.engagement_record_id=pr.id
         WHERE pr.workspace_id=$1 AND pr.id=$2`,
        [fx.workspaceId, terms.engagementRecordId],
      )).rows[0];
      const lineage = await client.query<{ input_provenance: string }>(
        `SELECT input_provenance FROM partner_handoffs
          WHERE workspace_id=$1 AND lineage_root_id=$2 ORDER BY revision`,
        [fx.workspaceId, mismatch.handoff_id],
      );
      return { engagement, lineage: lineage.rows };
    });
    expect(stored.engagement).toMatchObject({ input_provenance: 'sample', data: { input_provenance: 'sample' } });
    expect(stored.lineage).toEqual([{ input_provenance: 'sample' }, { input_provenance: 'sample' }]);
  });

  it('rejects expired terms, deleted sources and a paused exact Finance assignment', async () => {
    const expiredFx = await workflowFixture();
    const expiredSource = await addSource(expiredFx, 'expired-terms', 'Expired workshop terms.');
    const expired = await authorizeTerms(expiredFx, {
      key: 'expired', source: expiredSource, validFrom: '2020-01-01', validUntil: '2020-12-31',
    });
    await expect(submitIntake(
      expiredFx,
      intakeInput(expired, await addSource(expiredFx, 'expired-invoice', 'Invoice under expired terms.'), 'expired-intake'),
    )).rejects.toMatchObject({ reason: 'authorization_expired' } satisfies Partial<PartnerWorkflowError>);

    const engagementFx = await workflowFixture();
    const engagementSource = await addSource(engagementFx, 'deletable-terms', 'Terms whose source will be removed.');
    const deletedTerms = await authorizeTerms(engagementFx, { key: 'delete-engagement-source', source: engagementSource });
    await appTransaction(engagementFx, engagementFx.adminId, (client) => client.query(
      `UPDATE attachments SET deleted_at=now() WHERE workspace_id=$1 AND id=$2`,
      [engagementFx.workspaceId, engagementSource.attachmentId],
    ));
    await expect(submitIntake(
      engagementFx,
      intakeInput(deletedTerms, await addSource(engagementFx, 'unused-invoice', 'Unused invoice.'), 'deleted-engagement'),
    )).rejects.toMatchObject({ reason: 'source_digest_mismatch' } satisfies Partial<PartnerWorkflowError>);

    const invoiceFx = await workflowFixture();
    const currentSource = await addSource(invoiceFx, 'current-terms', 'Current workshop terms.');
    const currentTerms = await authorizeTerms(invoiceFx, { key: 'current', source: currentSource });
    const invoiceSource = await addSource(invoiceFx, 'deletable-invoice', 'Invoice source that will be removed.');
    const intake = await submitIntake(invoiceFx, intakeInput(currentTerms, invoiceSource, 'delete-invoice-source'));
    await appTransaction(invoiceFx, invoiceFx.adminId, (client) => client.query(
      `UPDATE attachments SET deleted_at=now() WHERE workspace_id=$1 AND id=$2`,
      [invoiceFx.workspaceId, invoiceSource.attachmentId],
    ));
    const stale = await executeNativeShapedReview(invoiceFx, intake);
    expect(stale.result).toMatchObject({ kind: 'stale_source', request_id: null });

    const pausedFx = await workflowFixture();
    const pausedSource = await addSource(pausedFx, 'paused-terms', 'Terms approved before Finance pauses.');
    const pausedTerms = await authorizeTerms(pausedFx, { key: 'paused', source: pausedSource });
    await appTransaction(pausedFx, pausedFx.adminId, async (client) => {
      await client.query(
        `INSERT INTO enterprise_skill_assignments
           (workspace_id,agent_id,team_id,artifact_id,skill_key,skill_version,state,config,
            capability_grants,schedule,approval_policy,assigned_by)
         SELECT esa.workspace_id,$2,finance.team_id,esa.artifact_id,esa.skill_key,esa.skill_version,
                'active',esa.config,esa.capability_grants,esa.schedule,esa.approval_policy,$3
           FROM enterprise_skill_assignments esa
           JOIN enterprise_team_agents finance ON finance.workspace_id=esa.workspace_id AND finance.agent_id=$2
          WHERE esa.workspace_id=$1 AND esa.agent_id=$4 AND esa.skill_key='partner-program-screening'`,
        [pausedFx.workspaceId, pausedFx.financeAgentId, pausedFx.adminId, pausedFx.agentId],
      );
      await client.query(
        `UPDATE enterprise_skill_assignments SET state='paused',revision=revision+1
          WHERE workspace_id=$1 AND agent_id=$2 AND skill_key='partner-invoice-review'`,
        [pausedFx.workspaceId, pausedFx.financeAgentId],
      );
    });
    await expect(submitIntake(
      pausedFx,
      intakeInput(pausedTerms, await addSource(pausedFx, 'paused-invoice', 'Invoice while Finance is paused.'), 'paused-intake'),
    )).rejects.toMatchObject({ reason: 'workflow_readiness_incomplete' } satisfies Partial<PartnerWorkflowError>);
  });

  it('requires fresh attestation after the exact active Finance assignment revision changes', async () => {
    const fx = await workflowFixture();
    const terms = await authorizeTerms(fx, {
      key: 'readiness-terms',
      source: await addSource(fx, 'readiness-terms', 'One workshop for USD 1,200.00.'),
    });
    await appTransaction(fx, fx.adminId, async (client) => {
      await client.query(
        `UPDATE enterprise_skill_assignments
            SET revision=revision+1
          WHERE workspace_id=$1 AND agent_id=$2 AND skill_key='partner-invoice-review'
            AND state='active'`,
        [fx.workspaceId, fx.financeAgentId],
      );
    });
    await expect(submitIntake(
      fx,
      intakeInput(
        terms,
        await addSource(fx, 'readiness-invoice', 'Invoice after assignment revision drift.'),
        'readiness-intake',
      ),
    )).rejects.toMatchObject({ reason: 'workflow_readiness_incomplete' } satisfies Partial<PartnerWorkflowError>);
  });

  it('serializes correction races, denies stale requests and accepts one invoice lineage', async () => {
    const fx = await workflowFixture();
    const terms = await authorizeTerms(fx, {
      key: 'race-terms',
      source: await addSource(fx, 'race-terms', 'One workshop for USD 1,200.00.'),
      reference: 'ENG-RACE',
    });
    const originalSource = await addSource(fx, 'race-original', 'Original invoice for USD 1,200.00.');
    const original = await submitIntake(fx, intakeInput(terms, originalSource, 'race-original', invoice('INV-RACE-OLD')));
    const checked = await executeNativeShapedReview(fx, original);
    const oldRequestId = checked.execution.request_id!;
    const oldBinding = await financeReviewBinding(fx, oldRequestId);

    await appTransaction(fx, fx.adminId, async (client) => {
      await client.query(
        `UPDATE attachments SET deleted_at=now() WHERE workspace_id=$1 AND id=$2`,
        [fx.workspaceId, originalSource.attachmentId],
      );
      await client.query(
        `UPDATE partner_handoffs
            SET status='stale',validation_status='stale',human_decision_status='not_ready'
          WHERE workspace_id=$1 AND id=$2`,
        [fx.workspaceId, original.handoff_id],
      );
    });
    const staleDecision = await decideInvoice(fx, oldRequestId, oldBinding);
    expect(staleDecision.status).toBe(409);
    expect(await staleDecision.json()).toMatchObject({ reason: 'request_binding_stale' });

    const sourceOne = await addSource(fx, 'race-correction-one', 'Corrected invoice one for USD 1,200.00.');
    const sourceTwo = await addSource(fx, 'race-correction-two', 'Corrected invoice two for USD 1,200.00.');
    const correctionOne = correctionInput(terms, sourceOne, 'race-one', original.handoff_revision, invoice('INV-RACE-ONE'));
    const correctionTwo = correctionInput(terms, sourceTwo, 'race-two', original.handoff_revision, invoice('INV-RACE-TWO'));
    const raced = await Promise.allSettled([
      appTransaction(fx, fx.adminId, (client) => correctPartnerInvoiceIntake(
        client, fx.env, fx.workspaceId, fx.adminId, original.handoff_id, correctionOne, [],
      )),
      appTransaction(fx, fx.adminId, (client) => correctPartnerInvoiceIntake(
        client, fx.env, fx.workspaceId, fx.adminId, original.handoff_id, correctionTwo, [],
      )),
    ]);
    const winners = raced.filter((entry): entry is PromiseFulfilledResult<Awaited<ReturnType<typeof correctPartnerInvoiceIntake>>> => entry.status === 'fulfilled');
    expect(winners).toHaveLength(1);
    expect(raced.filter((entry) => entry.status === 'rejected')).toHaveLength(1);

    const oldRetry = await decideInvoice(fx, oldRequestId, oldBinding);
    expect(oldRetry.status).toBe(409);
    expect(await oldRetry.json()).toMatchObject({ reason: 'not_pending' });

    const successor = winners[0]!.value;
    const successorResult = await executeNativeShapedReview(fx, successor);
    expect(successorResult.result.kind).toBe('checks_passed');
    const successorBinding = await financeReviewBinding(fx, successorResult.execution.request_id!);
    expect((await decideInvoice(fx, successorResult.execution.request_id!, successorBinding)).status).toBe(201);

    const persisted = await appTransaction(fx, fx.adminId, async (client) => {
      const successors = await client.query(
        `SELECT 1 FROM partner_handoffs WHERE workspace_id=$1 AND supersedes_handoff_id=$2`,
        [fx.workspaceId, original.handoff_id],
      );
      const decisions = await client.query(
        `SELECT 1 FROM decisions d JOIN requests r ON r.id=d.request_id
          WHERE d.workspace_id=$1 AND r.subject_key LIKE 'partner-invoice-handoff:%'`,
        [fx.workspaceId],
      );
      const documents = await client.query(
        `SELECT 1 FROM documents d JOIN requests r ON r.id=d.request_id
          WHERE d.workspace_id=$1 AND r.subject_key LIKE 'partner-invoice-handoff:%'`,
        [fx.workspaceId],
      );
      const acknowledgments = await client.query(
        `SELECT 1 FROM partner_decision_acknowledgments WHERE workspace_id=$1`,
        [fx.workspaceId],
      );
      const lineage = await client.query<{ status: string; superseded_by_handoff_id: string | null }>(
        `SELECT status,superseded_by_handoff_id FROM partner_handoffs
          WHERE workspace_id=$1 AND lineage_root_id=$2 ORDER BY revision`,
        [fx.workspaceId, original.handoff_id],
      );
      return {
        successorCount: successors.rowCount,
        decisionCount: decisions.rowCount,
        documentCount: documents.rowCount,
        acknowledgmentCount: acknowledgments.rowCount,
        lineage: lineage.rows,
      };
    });
    expect(persisted).toMatchObject({
      successorCount: 1,
      decisionCount: 1,
      documentCount: 1,
      acknowledgmentCount: 1,
    });
    expect(persisted.lineage).toHaveLength(2);
    expect(persisted.lineage[0]?.superseded_by_handoff_id).toBe(successor.handoff_id);
  });

  it('serializes a correction against the guarded human decision without two accepted outcomes', async () => {
    const fx = await workflowFixture();
    const terms = await authorizeTerms(fx, {
      key: 'decision-race-terms',
      source: await addSource(fx, 'decision-race-terms', 'One workshop for USD 1,200.00.'),
      reference: 'ENG-DECISION-RACE',
    });
    const original = await submitIntake(fx, intakeInput(
      terms,
      await addSource(fx, 'decision-race-original', 'Original valid invoice for USD 1,200.00.'),
      'decision-race-original',
      invoice('INV-DECISION-RACE-OLD'),
    ));
    const checked = await executeNativeShapedReview(fx, original);
    expect(checked.result.kind).toBe('checks_passed');
    const requestId = checked.execution.request_id!;
    const binding = await financeReviewBinding(fx, requestId);
    const correctionSource = await addSource(
      fx, 'decision-race-correction', 'Corrected valid invoice for USD 1,200.00.',
    );
    const correction = correctionInput(
      terms,
      correctionSource,
      'decision-race-correction',
      original.handoff_revision,
      invoice('INV-DECISION-RACE-NEW'),
    );

    // The legacy aggregate status is the correction command's eligibility
    // signal. The authoritative validation, evidence and request binding stay
    // passed and fresh so either command may legitimately acquire the shared
    // advisory lock first.
    await appTransaction(fx, fx.adminId, (client) => client.query(
      `UPDATE partner_handoffs SET status='needs_information'
        WHERE workspace_id=$1 AND id=$2`,
      [fx.workspaceId, original.handoff_id],
    ));

    const [correctionRace, decisionRace] = await Promise.allSettled([
      appTransaction(fx, fx.adminId, (client) => correctPartnerInvoiceIntake(
        client, fx.env, fx.workspaceId, fx.adminId, original.handoff_id, correction, [],
      )),
      decideInvoice(fx, requestId, binding),
    ]);
    expect(decisionRace.status).toBe('fulfilled');
    const decisionResponse = (decisionRace as PromiseFulfilledResult<Response>).value;
    expect(decisionResponse.status).not.toBe(500);

    let acceptedHandoffId = original.handoff_id;
    let expectedSuccessors = 0;
    if (correctionRace.status === 'fulfilled') {
      expect(decisionResponse.status).toBe(409);
      expect(await decisionResponse.json()).toMatchObject({ reason: 'not_pending' });
      acceptedHandoffId = correctionRace.value.handoff_id;
      expectedSuccessors = 1;
      const successorResult = await executeNativeShapedReview(fx, correctionRace.value);
      expect(successorResult.result.kind).toBe('checks_passed');
      const successorBinding = await financeReviewBinding(fx, successorResult.execution.request_id!);
      expect((await decideInvoice(fx, successorResult.execution.request_id!, successorBinding)).status).toBe(201);
    } else {
      expect(decisionResponse.status).toBe(201);
      expect(correctionRace.reason).toMatchObject({
        reason: 'handoff_already_decided',
      } satisfies Partial<PartnerWorkflowError>);
    }

    const persisted = await appTransaction(fx, fx.adminId, async (client) => {
      const successors = await client.query(
        `SELECT 1 FROM partner_handoffs WHERE workspace_id=$1 AND supersedes_handoff_id=$2`,
        [fx.workspaceId, original.handoff_id],
      );
      const accepted = await client.query<{ status: string; consumed_handoff_id: string }>(
        `SELECT status,consumed_handoff_id FROM partner_engagement_authorizations
          WHERE workspace_id=$1 AND engagement_record_id=$2`,
        [fx.workspaceId, terms.engagementRecordId],
      );
      const decisions = await client.query(
        `SELECT 1 FROM decisions d JOIN requests r ON r.id=d.request_id
          WHERE d.workspace_id=$1 AND r.subject_key LIKE 'partner-invoice-handoff:%'`,
        [fx.workspaceId],
      );
      const documents = await client.query(
        `SELECT 1 FROM documents d JOIN requests r ON r.id=d.request_id
          WHERE d.workspace_id=$1 AND r.subject_key LIKE 'partner-invoice-handoff:%'`,
        [fx.workspaceId],
      );
      const acknowledgments = await client.query<{ handoff_id: string }>(
        `SELECT handoff_id FROM partner_decision_acknowledgments WHERE workspace_id=$1`,
        [fx.workspaceId],
      );
      return {
        successorCount: successors.rowCount,
        accepted: accepted.rows[0],
        decisionCount: decisions.rowCount,
        documentCount: documents.rowCount,
        acknowledgments: acknowledgments.rows,
      };
    });
    expect(persisted.successorCount).toBe(expectedSuccessors);
    expect(persisted.accepted).toEqual({ status: 'consumed', consumed_handoff_id: original.handoff_id });
    expect(persisted.decisionCount).toBe(1);
    expect(persisted.documentCount).toBe(1);
    expect(persisted.acknowledgments).toEqual([{ handoff_id: acceptedHandoffId }]);
  });

  it('returns authoritative failure and needs-information results without inventing requests', async () => {
    const fx = await workflowFixture();
    const terms = await authorizeTerms(fx, {
      key: 'result-terms', source: await addSource(fx, 'result-terms', 'One workshop for USD 1,200.00.'),
    });
    const mismatch = await submitIntake(fx, intakeInput(
      terms,
      await addSource(fx, 'result-mismatch', 'Invoice requests USD 900.00.'),
      'result-mismatch',
      invoice('INV-RESULT-MISMATCH', 90_000),
    ));
    const needsInformation = await executeNativeShapedReview(fx, mismatch);
    expect(needsInformation.result).toMatchObject({ kind: 'needs_information', request_id: null });

    const failedFx = await workflowFixture();
    const failedTerms = await authorizeTerms(failedFx, {
      key: 'failure-terms', source: await addSource(failedFx, 'failure-terms', 'One workshop for USD 1,200.00.'),
    });
    const failedIntake = await submitIntake(failedFx, intakeInput(
      failedTerms,
      await addSource(failedFx, 'failure-invoice', 'Invoice awaiting a worker.'),
      'failure-intake',
    ));
    const queued = await appTransaction(failedFx, failedFx.adminId, async (client) => {
      await publishConfirmedPartnerInvoiceReview(
        client, failedFx.workspaceId, failedIntake.source_run_id, failedFx.agentId,
        { intake_event_id: failedIntake.intake_event_id, expected_payload_hash: failedIntake.payload_hash },
      );
      return (await client.query<Job>(
        `SELECT id,workspace_id,kind,key,payload,attempts FROM jobs
          WHERE workspace_id=$1 AND kind='partner_invoice_review' AND key=$2`,
        [failedFx.workspaceId, `partner-invoice-review:${failedIntake.handoff_id}`],
      )).rows[0]!;
    });
    await runPartnerInvoiceReviewJob(failedFx.env, { ...queued, attempts: 4 });
    const failed = await appTransaction(failedFx, failedFx.memberId, (client) =>
      getPartnerHandoffResult(client, failedFx.workspaceId, failedIntake.handoff_id, { userId: failedFx.memberId }));
    expect(failed).toMatchObject({
      kind: 'failed_processing',
      failure_code: 'Invoice review exceeded three attempts.',
      request_id: null,
      outcome: { validation: 'failed', human_decision: 'not_ready' },
    });
  });

  it('projects only the exact fenced automatic failure into the linked partner handoff', async () => {
    const fx = await workflowFixture();
    const terms = await authorizeTerms(fx, {
      key: 'automatic-failure-terms',
      source: await addSource(fx, 'automatic-failure-terms', 'One workshop for USD 1,200.00.'),
    });
    const intake = await submitIntake(fx, intakeInput(
      terms,
      await addSource(fx, 'automatic-failure-invoice', 'Invoice requests USD 1,200.00.'),
      'automatic-failure-intake',
    ));
    const runId = await appTransaction(fx, fx.adminId, async (client) => {
      await publishConfirmedPartnerInvoiceReview(
        client, fx.workspaceId, intake.source_run_id, fx.agentId,
        { intake_event_id: intake.intake_event_id, expected_payload_hash: intake.payload_hash },
      );
      const create = await preparePartnerInvoiceReviewModelTurn(
        client, fx.env, fx.workspaceId, intake.handoff_id, [],
      );
      expect(create).not.toBeNull();
      await client.query(
        `UPDATE runs SET attempt=2,status='working',stop_requested=false,automatic_recovery=true,error=NULL
          WHERE workspace_id=$1 AND id=$2`,
        [fx.workspaceId, create!.runId],
      );
      return create!.runId;
    });
    const drift = {
      class: 'permanent', retryable: false, reason: 'automatic_recovery_runtime_drift',
      message: 'The managed runtime changed before automatic recovery could start.',
    };
    const runtime = new RuntimeDb(fx.env, fx.workspaceId, 'partner-automatic-failure-projection');
    try {
      expect(await runtime.failAutomaticRecoveryExecution(runId, 1, drift)).toBe(false);
      expect(await appTransaction(fx, fx.adminId, async (client) =>
        (await client.query<{ agent_explanation_status: string }>(
          'SELECT agent_explanation_status FROM partner_handoffs WHERE workspace_id=$1 AND id=$2',
          [fx.workspaceId, intake.handoff_id],
        )).rows[0]!.agent_explanation_status)).toBe('running');
      expect(await runtime.failAutomaticRecoveryExecution(runId, 2, drift)).toBe(true);
    } finally {
      await runtime.close();
    }
    expect(await appTransaction(fx, fx.adminId, async (client) =>
      (await client.query<{ agent_explanation_status: string }>(
        'SELECT agent_explanation_status FROM partner_handoffs WHERE workspace_id=$1 AND id=$2',
        [fx.workspaceId, intake.handoff_id],
      )).rows[0]!.agent_explanation_status)).toBe('failed');
  });
});
