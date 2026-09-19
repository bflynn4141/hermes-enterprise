import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { partnerInvoiceReviewHandoffInputSchema, requestEntitySchema, requestReviewBinding } from '@hermes/shared';
import {
  configurePartnerWorkflow,
  getPartnerRecordForRun,
  listPartnerRecordsForRun,
  PartnerWorkflowError,
  processPartnerInvoiceReview,
  publishPartnerInvoiceReviewHandoff,
  snapshotPartnerRunGrants,
} from '../../src/partner-workflow/service.js';
import { runPartnerInvoiceReviewJob } from '../../src/partner-workflow/job.js';
import type { Env } from '../../src/env.js';
import type { Job } from '../../src/jobs.js';
import { asUser, makeEnv, readTenant } from './harness.js';
import { seedWorkspace, setTenant, withClient } from './helpers.js';
import { INBOX_HEADERS } from './m4-fixtures.js';
import { PgAgentDb } from '../../src/engine/pg-agent-db.js';
import { PARTNER_INVOICE_REVIEW_DEFINITION } from '../../src/enterprise-skills/registry.js';
import { materializeLegacyPartnerAssignment } from '../../src/enterprise-skills/service.js';
import { runtimeSkillManifestsForAgent } from '../../src/runtime/skills.js';

const legacyDefaultPolicy = {
  source: 'agentcash_people', source_purpose: 'person_partner_research', organization_only: false, no_outreach: true,
  role_label: 'Hermes consultant', search_queries: [], intake_urls: [], keywords: ['AI agents'],
  people_search: { current_position_seniority_level: ['Founder'], person_skills: ['AI agents'], current_position_titles: [], person_locations: [] },
  ranking_weights: { relevance: 40, activity: 25, adoption: 20, openness: 15 },
  minimum_priority: 50, lookback_days: 365, max_candidates: 5, max_api_requests: 1,
  minimum_rate_remaining: 5, max_spend_usd: 0.15,
};

async function fixture() {
  const fx = await seedWorkspace();
  const financeAgentId = randomUUID();
  const partnershipsRunId = randomUUID();
  const financeSeedSessionId = randomUUID();
  const financeSeedRunId = randomUUID();
  await withClient('owner', async (client) => {
    await client.query('BEGIN');
    await setTenant(client, fx.workspaceId, fx.adminId);
    await client.query(
      `INSERT INTO agents (id,workspace_id,name,status) VALUES ($1,$2,'Ledger','started')`,
      [financeAgentId, fx.workspaceId],
    );
    await client.query(
      `INSERT INTO sessions (id,workspace_id,owner_id,agent_id,title,model_id)
       VALUES ($1,$2,$3,$4,'Finance setup','deepseek-flash')`,
      [financeSeedSessionId, fx.workspaceId, fx.memberId, financeAgentId],
    );
    await client.query(
      `INSERT INTO runs
         (id,workspace_id,session_id,agent_id,status,model_id,client_turn_id,ended_at)
       VALUES
         ($1,$3,$4,$5,'completed','deepseek-flash','partnerships-source',now()),
         ($2,$3,$6,$7,'completed','deepseek-flash','finance-seed',now())`,
      [partnershipsRunId, financeSeedRunId, fx.workspaceId, fx.sessionId, fx.agentId,
        financeSeedSessionId, financeAgentId],
    );
    await client.query('COMMIT');
  });
  await withClient('app', async (client) => {
    await client.query('BEGIN');
    await setTenant(client, fx.workspaceId, fx.adminId);
    await configurePartnerWorkflow(client, fx.workspaceId, fx.adminId, {
      partnerships: { agent_id: fx.agentId, principal_user_id: fx.adminId },
      finance: { agent_id: financeAgentId, principal_user_id: fx.memberId },
    });
    await snapshotPartnerRunGrants(client, fx.workspaceId, partnershipsRunId, fx.agentId);
    await snapshotPartnerRunGrants(client, fx.workspaceId, financeSeedRunId, financeAgentId);
    await client.query('COMMIT');
  });
  return { ...fx, financeAgentId, partnershipsRunId, financeSeedSessionId, financeSeedRunId };
}

const invoiceEvent = (fx: Awaited<ReturnType<typeof fixture>>, idempotencyKey: string, overrides: {
  number?: string; totalMinor?: number; authorizedMinor?: number; currency?: string;
  invoiceCurrency?: string; engagementCurrency?: string; simulated?: boolean;
} = {}) => partnerInvoiceReviewHandoffInputSchema.parse({
  partner: { id: randomUUID(), name: 'Private Partner LLC' },
  engagement: {
    reference: `ENG-${idempotencyKey}`,
    summary: 'One partner workshop authorized by the recorded engagement.',
    currency: overrides.engagementCurrency ?? overrides.currency ?? 'USD',
    authorized_total_minor: overrides.authorizedMinor ?? 120_000,
    evidence_ids: [`agreement:${idempotencyKey}`],
  },
  invoice: {
    kind: 'invoice',
    number: overrides.number ?? `INV-${idempotencyKey}`,
    currency: overrides.invoiceCurrency ?? overrides.currency ?? 'USD',
    payee: { name: 'Private Partner LLC', email: 'billing@private-partner.example' },
    payer: { name: 'Hermes Enterprise' },
    issue_date: '2026-09-01',
    due_date: '2026-09-30',
    lines: [{ id: 'workshop', label: 'Partner workshop', qty: 1, amount_minor: overrides.totalMinor ?? 120_000, source_ids: [`agreement:${idempotencyKey}`] }],
    total_minor: overrides.totalMinor ?? 120_000,
    notes: 'FINANCE-PRIVATE-NOTE',
  },
  source_session_id: fx.sessionId,
  source_run_id: fx.partnershipsRunId,
  simulated: overrides.simulated ?? true,
  idempotency_key: idempotencyKey,
});

describe('Partnerships + Finance partner workflow', () => {
  it('replaces stray grants with the reviewed Finance template and blocks legacy Partnerships fallback', async () => {
    const fx = await fixture();
    const { env } = makeEnv({
      PARTNER_SCREENING_DEFAULT_CONFIG_JSON: JSON.stringify(legacyDefaultPolicy),
    });
    const inspected = await withClient('app', async (client) => {
      await client.query('BEGIN');
      await setTenant(client, fx.workspaceId, fx.adminId);
      await client.query(
        `UPDATE enterprise_skill_assignments
            SET capability_grants=capability_grants || ARRAY['partner.discovery.read']::text[],
                revision=revision+1
          WHERE workspace_id=$1 AND agent_id=$2 AND skill_key='partner-invoice-review'`,
        [fx.workspaceId, fx.financeAgentId],
      );
      await configurePartnerWorkflow(client, fx.workspaceId, fx.adminId, {
        partnerships: { agent_id: fx.agentId, principal_user_id: fx.adminId },
        finance: { agent_id: fx.financeAgentId, principal_user_id: fx.memberId },
      });
      const assignment = await client.query<{ capability_grants: string[] }>(
        `SELECT capability_grants FROM enterprise_skill_assignments
          WHERE workspace_id=$1 AND agent_id=$2 AND skill_key='partner-invoice-review'`,
        [fx.workspaceId, fx.financeAgentId],
      );
      const legacyMaterialization = await materializeLegacyPartnerAssignment(
        env, client, fx.workspaceId, fx.financeAgentId, fx.adminId,
      );
      const partnerAssignments = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM enterprise_skill_assignments
          WHERE workspace_id=$1 AND agent_id=$2 AND skill_key='partner-program-screening'`,
        [fx.workspaceId, fx.financeAgentId],
      );
      const manifests = await runtimeSkillManifestsForAgent(env, client, fx.workspaceId, fx.financeAgentId);
      await client.query('COMMIT');
      return { assignment: assignment.rows[0]!, legacyMaterialization, partnerAssignments: partnerAssignments.rows[0]!.count, manifests };
    });
    expect(inspected.assignment.capability_grants).toEqual([
      ...PARTNER_INVOICE_REVIEW_DEFINITION.defaultCapabilityGrants,
    ]);
    expect(inspected.manifests).toEqual([
      expect.objectContaining({ name: PARTNER_INVOICE_REVIEW_DEFINITION.runtimeName }),
    ]);
    expect(inspected.legacyMaterialization).toBeNull();
    expect(inspected.partnerAssignments).toBe(0);
    const agentDb = new PgAgentDb(env, fx.workspaceId, 'finance-default-policy-boundary');
    try {
      await expect(agentDb.loadToolNames(fx.financeAgentId)).resolves.toEqual(['list_requests', 'get_request']);
    } finally {
      await agentDb.close();
    }
  });

  it('prepares one private Finance decision from one explicit handoff and exposes only the shared projection', async () => {
    const fx = await fixture();
    const event = invoiceEvent(fx, 'positive');
    const result = await withClient('app', async (client) => {
      await client.query('BEGIN');
      await setTenant(client, fx.workspaceId, fx.adminId);
      const published = await publishPartnerInvoiceReviewHandoff(client, fx.workspaceId, fx.adminId, event);
      const replay = await publishPartnerInvoiceReviewHandoff(client, fx.workspaceId, fx.adminId, event);
      expect(replay).toMatchObject({ handoffId: published.handoffId, created: false, jobId: null });

      const records = await client.query<{ source_record_id: string; invoice_record_id: string }>(
        `SELECT source_record_id,invoice_record_id FROM partner_handoffs WHERE id=$1`,
        [published.handoffId],
      );
      const refs = records.rows[0]!;
      expect(await getPartnerRecordForRun(client, {
        workspaceId: fx.workspaceId, runId: fx.partnershipsRunId, agentId: fx.agentId,
      }, refs.invoice_record_id)).toBeNull();
      expect(await getPartnerRecordForRun(client, {
        workspaceId: fx.workspaceId, runId: fx.financeSeedRunId, agentId: fx.financeAgentId,
      }, refs.source_record_id)).toBeNull();
      const financeRecords = await listPartnerRecordsForRun(client, {
        workspaceId: fx.workspaceId, runId: fx.financeSeedRunId, agentId: fx.financeAgentId,
      });
      expect(financeRecords.some((row) => row.id === refs.invoice_record_id)).toBe(true);
      expect(financeRecords.some((row) => row.id === refs.source_record_id)).toBe(false);

      expect(await processPartnerInvoiceReview(client, fx.workspaceId, published.handoffId)).toBe('completed');
      expect(await processPartnerInvoiceReview(client, fx.workspaceId, published.handoffId)).toBe('completed');
      const execution = await client.query<{
        request_id: string; finance_session_id: string; finance_run_id: string;
      }>(
        `SELECT request_id,finance_session_id,finance_run_id
           FROM partner_workflow_executions WHERE handoff_id=$1`,
        [published.handoffId],
      );
      const requestCount = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM requests WHERE subject_key=$1`,
        [`partner-invoice-handoff:${published.handoffId}`],
      );
      expect(requestCount.rows[0]?.count).toBe('1');
      const agentMessage = await client.query<{
        protocol: string; status: string; sender_display: string; wire_text: string;
      }>(
        `SELECT protocol,status,sender_display,wire_text
           FROM partner_agent_messages WHERE handoff_id=$1`,
        [published.handoffId],
      );
      expect(agentMessage.rows[0]).toMatchObject({
        protocol: 'hermes-bot-mode/v1', status: 'delivered', sender_display: 'Iris',
      });
      expect(agentMessage.rows[0]?.wire_text).toMatch(/^Message from 🤖 Iris \(@agent-[0-9a-f-]+\):/);
      await client.query('COMMIT');
      return { published, execution: execution.rows[0]!, refs };
    });

    const { env } = makeEnv();
    const hiddenDetail = await asUser(env, fx.adminId, `/w/${fx.workspaceId}/requests/${result.execution.request_id}`);
    expect(hiddenDetail.status).toBe(404);
    const partnershipsList = await asUser(env, fx.adminId, `/w/${fx.workspaceId}/requests`);
    expect(JSON.stringify(await partnershipsList.json())).not.toContain('FINANCE-PRIVATE-NOTE');
    const financeDetail = await asUser(env, fx.memberId, `/w/${fx.workspaceId}/requests/${result.execution.request_id}`);
    expect(financeDetail.status).toBe(200);
    const financeEntity = await financeDetail.json() as {
      decision_summary?: { approval_requirement?: { current?: Array<{ label?: string }>; pending_for_viewer?: boolean } };
    };
    const financeBody = JSON.stringify(financeEntity);
    expect(financeBody).toContain('FINANCE-PRIVATE-NOTE');
    expect(financeBody).toContain('"simulated":true');
    expect(financeEntity.decision_summary?.approval_requirement?.current?.[0]?.label).toBe('Finance reviewer');
    expect(financeEntity.decision_summary?.approval_requirement?.pending_for_viewer).toBe(true);

    const agentDb = new PgAgentDb(env, fx.workspaceId, 'finance-role-template-tools');
    try {
      await expect(agentDb.loadToolNames(fx.financeAgentId)).resolves.toEqual(expect.arrayContaining([
        'list_requests', 'get_request',
      ]));
      await expect(agentDb.loadToolNames(fx.financeAgentId)).resolves.not.toEqual(expect.arrayContaining([
        'list_partner_candidates', 'get_partner_candidate', 'propose_request', 'save_review_note',
      ]));
    } finally {
      await agentDb.close();
    }

    const reviewBinding = await requestReviewBinding(requestEntitySchema.parse(financeEntity));
    const decision = await asUser(env, fx.memberId, `/w/${fx.workspaceId}/requests/${result.execution.request_id}/decisions`, {
      method: 'POST', headers: INBOX_HEADERS, body: { decision: 'decline', ...reviewBinding },
    });
    expect(decision.status).toBe(201);
    expect(await decision.json()).toMatchObject({
      request_id: result.execution.request_id, resulting_status: 'declined', effect_ids: [],
    });

    const sourceSession = await asUser(env, fx.memberId, `/w/${fx.workspaceId}/sessions/${fx.sessionId}`);
    expect(sourceSession.status).toBe(404);
    const financeSession = await asUser(env, fx.memberId, `/w/${fx.workspaceId}/sessions/${result.execution.finance_session_id}`);
    expect(financeSession.status).toBe(200);

    const workflow = await asUser(env, fx.adminId, `/w/${fx.workspaceId}/partner-workflow`);
    expect(workflow.status).toBe(200);
    const workflowBody = JSON.stringify(await workflow.json());
    expect(workflowBody).toContain('Private Partner LLC');
    expect(workflowBody).not.toContain('FINANCE-PRIVATE-NOTE');
    expect(workflowBody).not.toContain('billing@private-partner.example');

    const other = await seedWorkspace();
    await withClient('app', async (client) => {
      await client.query('BEGIN');
      await setTenant(client, other.workspaceId, other.adminId);
      const crossWorkspace = await client.query(`SELECT 1 FROM partner_records WHERE id=$1`, [result.refs.invoice_record_id]);
      expect(crossWorkspace.rows).toHaveLength(0);
      await client.query('ROLLBACK');
    });

    await withClient('agent', async (client) => {
      await client.query('BEGIN');
      await setTenant(client, fx.workspaceId, fx.adminId);
      await expect(client.query('SELECT * FROM partner_records')).rejects.toThrow(/permission denied/i);
      await client.query('ROLLBACK');
    });
  });

  it('admits a non-simulated Bot Mode handoff as a real Finance run before starting its workflow', async () => {
    const fx = await fixture();
    const published = await withClient('app', async (client) => {
      await client.query('BEGIN');
      await setTenant(client, fx.workspaceId, fx.adminId);
      const value = await publishPartnerInvoiceReviewHandoff(
        client,
        fx.workspaceId,
        fx.adminId,
        invoiceEvent(fx, 'live-hybrid', { simulated: false }),
      );
      await client.query('COMMIT');
      return value;
    });
    const queuedJob = await readTenant(fx.workspaceId, fx.adminId, async (client) => (
      await client.query<Job>(
        `SELECT id,workspace_id,kind,key,payload,attempts
           FROM jobs WHERE workspace_id=$1 AND kind='partner_invoice_review' AND key=$2`,
        [fx.workspaceId, `partner-invoice-review:${published.handoffId}`],
      )
    ).rows[0]);
    expect(queuedJob).toBeDefined();

    const workflows: Array<{ id: string; params: unknown }> = [];
    const { env } = makeEnv({
      ENVIRONMENT: 'development',
      MODEL_SCRIPTED: '1',
      ALLOWED_PROVIDERS: 'deepseek,anthropic,openai,nous_portal,openrouter',
      RUN_ATTEMPT: {
        create: (input: { id: string; params: unknown }) => {
          workflows.push(input);
          return Promise.resolve({ id: input.id });
        },
      } as unknown as Env['RUN_ATTEMPT'],
    });
    await runPartnerInvoiceReviewJob(env, queuedJob!);
    expect(workflows).toHaveLength(1);

    const stored = await readTenant(fx.workspaceId, fx.memberId, async (client) => {
      const result = await client.query<{
        handoff_status: string; request_id: string; run_status: string; session_id: string; run_id: string;
      }>(
        `SELECT h.status AS handoff_status,e.request_id,r.status AS run_status,
                e.finance_session_id AS session_id,e.finance_run_id AS run_id
           FROM partner_handoffs h
           JOIN partner_workflow_executions e ON e.handoff_id=h.id
           JOIN runs r ON r.id=e.finance_run_id
          WHERE h.id=$1`,
        [published.handoffId],
      );
      const message = await client.query<{
        protocol: string; status: string; wire_text: string; recipient_run_id: string;
      }>(`SELECT protocol,status,wire_text,recipient_run_id FROM partner_agent_messages WHERE handoff_id=$1`, [published.handoffId]);
      const turn = await client.query<{ provider_message: {
        content: string; enterprise_turn_author?: { id: string; name: string; is_bot: boolean };
      } }>(
        `SELECT provider_message FROM run_turns WHERE run_id=$1 AND role='user'`,
        [result.rows[0]?.run_id],
      );
      const syntheticAnswers = await client.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM messages WHERE session_id=$1 AND role='iris'`,
        [result.rows[0]?.session_id],
      );
      return { result: result.rows[0]!, message: message.rows[0]!, turn: turn.rows[0]!, syntheticAnswers: syntheticAnswers.rows[0]?.count };
    });
    expect(stored.result).toMatchObject({ handoff_status: 'completed', run_status: 'working' });
    expect(stored.result.request_id).toBeTruthy();
    expect(stored.message).toMatchObject({
      protocol: 'hermes-bot-mode/v1', status: 'delivered', recipient_run_id: stored.result.run_id,
    });
    expect(stored.message.wire_text).toMatch(/^Message from 🤖 Iris \(@agent-[0-9a-f-]+\):/);
    expect(stored.turn.provider_message.content).toBe(stored.message.wire_text);
    expect(stored.turn.provider_message.enterprise_turn_author).toMatchObject({
      id: expect.stringMatching(/^bot:agent-/), name: 'Iris', is_bot: true,
    });
    expect(stored.syntheticAnswers).toBe('0');
  });

  it('keeps qualification separate, fails closed on mismatch/duplicates/stale sources, and rechecks pause/deny', async () => {
    expect(partnerInvoiceReviewHandoffInputSchema.safeParse({
      partner: { id: randomUUID(), name: 'Qualified Prospect' },
      source_session_id: randomUUID(), source_run_id: randomUUID(), simulated: true,
      idempotency_key: 'qualification-is-not-an-invoice',
    }).success).toBe(false);
    const fx = await fixture();
    const withoutEvidence = invoiceEvent(fx, 'without-evidence');
    expect(partnerInvoiceReviewHandoffInputSchema.safeParse({
      ...withoutEvidence,
      engagement: { ...withoutEvidence.engagement, evidence_ids: [] },
    }).success).toBe(false);
    await withClient('app', async (client) => {
      await client.query('BEGIN');
      await setTenant(client, fx.workspaceId, fx.adminId);
      await client.query(
        `INSERT INTO requests (workspace_id,kind,subject_key,label,payload,status,session_id)
         VALUES ($1,'application','qualified-prospect-only','Qualified prospect only',
                 '{"kind":"application","applicant":{"name":"Prospect"},"proposed_role":"Partner","score":80,"score_max":100,"criteria":[{"id":"fit","label":"Fit","points":80,"points_max":100,"evidence":"Public evidence only","source_ids":[]}],"sources":[],"missing":[]}'::jsonb,
                 'pending',$2)`,
        [fx.workspaceId, fx.sessionId],
      );
      expect((await client.query(`SELECT 1 FROM partner_handoffs`)).rows).toHaveLength(0);
      expect((await client.query(`SELECT 1 FROM partner_workflow_executions`)).rows).toHaveLength(0);

      const mismatch = await publishPartnerInvoiceReviewHandoff(
        client, fx.workspaceId, fx.adminId,
        invoiceEvent(fx, 'mismatch', { totalMinor: 120_000, authorizedMinor: 100_000 }),
      );
      expect(await processPartnerInvoiceReview(client, fx.workspaceId, mismatch.handoffId)).toBe('needs_information');
      expect((await client.query(`SELECT 1 FROM requests WHERE subject_key=$1`, [`partner-invoice-handoff:${mismatch.handoffId}`])).rows).toHaveLength(0);

      const currencyMismatch = await publishPartnerInvoiceReviewHandoff(
        client, fx.workspaceId, fx.adminId,
        invoiceEvent(fx, 'currency-mismatch', { engagementCurrency: 'USD', invoiceCurrency: 'EUR' }),
      );
      expect(await processPartnerInvoiceReview(client, fx.workspaceId, currencyMismatch.handoffId)).toBe('needs_information');

      const first = await publishPartnerInvoiceReviewHandoff(
        client, fx.workspaceId, fx.adminId,
        invoiceEvent(fx, 'dup-a', { number: 'INV-DUPLICATE' }),
      );
      expect(await processPartnerInvoiceReview(client, fx.workspaceId, first.handoffId)).toBe('completed');
      const second = await publishPartnerInvoiceReviewHandoff(
        client, fx.workspaceId, fx.adminId,
        invoiceEvent(fx, 'dup-b', { number: 'INV-DUPLICATE' }),
      );
      expect(await processPartnerInvoiceReview(client, fx.workspaceId, second.handoffId)).toBe('needs_information');

      const stale = await publishPartnerInvoiceReviewHandoff(client, fx.workspaceId, fx.adminId, invoiceEvent(fx, 'stale'));
      await client.query(
        `UPDATE partner_records SET data=jsonb_set(data,'{notes}','"changed"'::jsonb), revision=revision+1
          WHERE id=(SELECT invoice_record_id FROM partner_handoffs WHERE id=$1)`,
        [stale.handoffId],
      );
      expect(await processPartnerInvoiceReview(client, fx.workspaceId, stale.handoffId)).toBe('stale');

      const deniedRecord = (await client.query<{ id: string }>(
        `SELECT invoice_record_id AS id FROM partner_handoffs WHERE id=$1`,
        [first.handoffId],
      )).rows[0]!.id;
      await client.query(
        `UPDATE enterprise_connection_bindings SET capability_denies=ARRAY['partner.invoice.read']
          WHERE workspace_id=$1 AND team_id=(SELECT team_id FROM enterprise_team_agents WHERE agent_id=$2)`,
        [fx.workspaceId, fx.financeAgentId],
      );
      await expect(getPartnerRecordForRun(client, {
        workspaceId: fx.workspaceId, runId: fx.financeSeedRunId, agentId: fx.financeAgentId,
      }, deniedRecord)).rejects.toMatchObject({ reason: 'connector_forbidden' } satisfies Partial<PartnerWorkflowError>);
      await client.query(
        `UPDATE enterprise_connection_bindings SET capability_denies='{}'
          WHERE workspace_id=$1 AND team_id=(SELECT team_id FROM enterprise_team_agents WHERE agent_id=$2)`,
        [fx.workspaceId, fx.financeAgentId],
      );

      const paused = await publishPartnerInvoiceReviewHandoff(client, fx.workspaceId, fx.adminId, invoiceEvent(fx, 'paused'));
      await client.query(
        `UPDATE enterprise_skill_assignments SET state='paused', revision=revision+1
          WHERE workspace_id=$1 AND agent_id=$2 AND skill_key='partner-invoice-review'`,
        [fx.workspaceId, fx.financeAgentId],
      );
      await expect(processPartnerInvoiceReview(client, fx.workspaceId, paused.handoffId))
        .rejects.toMatchObject({ reason: 'run_grant_unavailable' } satisfies Partial<PartnerWorkflowError>);
      await client.query('ROLLBACK');
    });
  });
});
