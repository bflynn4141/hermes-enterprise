import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { recordDecision } from '../../src/domain/decisions.js';
import { loadHandoffDetail, loadHandoffsList, readHandoffAdmission } from '../../src/handoffs/service.js';
import { configurePartnerWorkflow } from '../../src/partner-workflow/service.js';
import { loadPartnerWorkflowViewV2 } from '../../src/partner-workflow/v2.js';
import type { TenantWork } from '../../src/routes/tenant.js';
import { asUser, makeEnv } from './harness.js';
import { seedWorkspace, setTenant, withClient } from './helpers.js';
import { applicationPayload, INBOX_HEADERS, seedRequest } from './m4-fixtures.js';

async function configuredFixture() {
  const fx = await seedWorkspace();
  const financeAgentId = randomUUID();
  await withClient('owner', async (client) => {
    await client.query('BEGIN');
    try {
      await setTenant(client, fx.workspaceId, fx.adminId);
      await client.query(
        `INSERT INTO agents (id,workspace_id,name,status) VALUES ($1,$2,'Ledger','started')`,
        [financeAgentId, fx.workspaceId],
      );
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
  await withClient('app', async (client) => {
    await client.query('BEGIN');
    try {
      await setTenant(client, fx.workspaceId, fx.adminId);
      await configurePartnerWorkflow(client, fx.workspaceId, fx.adminId, {
        partnerships: { agent_id: fx.agentId, principal_user_id: fx.adminId },
        finance: { agent_id: financeAgentId, principal_user_id: fx.memberId },
      });
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
  return { ...fx, financeAgentId };
}

describe('handoffs table', () => {
  it('creates a contractor-agreements handoff when roles are configured', async () => {
    const fx = await configuredFixture();
    await withClient('app', async (client) => {
      await client.query('BEGIN');
      try {
        await setTenant(client, fx.workspaceId, fx.adminId);
        const admission = await readHandoffAdmission(client, fx.workspaceId);
        expect(admission.handoff_id).toBeTruthy();
        expect(admission.admission_state).toBe('disabled');
        const view = await loadPartnerWorkflowViewV2(client, fx.workspaceId, fx.adminId);
        const list = await loadHandoffsList(client, fx.workspaceId, fx.adminId, view);
        expect(list).toHaveLength(1);
        expect(list[0]?.key).toBe('contractor-agreements');
        const detail = await loadHandoffDetail(client, fx.workspaceId, list[0]!.id, view);
        expect(detail.steps).toHaveLength(5);
        expect(detail.crossing).toHaveLength(3);
        expect(detail.lanes).toHaveLength(2);
        expect(detail.steps[0]?.label).toBe('Screens and admits the applicant');
        expect(detail.crossing[1]?.key).toBe('contractor_agreement');
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  });

  it('admits an applicant into a Finance contractor agreement and shows the pair in motion', async () => {
    const fx = await configuredFixture();
    const applicationId = await seedRequest(fx, 'application', {
      label: 'Nova Partner',
      payload: applicationPayload('Nova Partner', 'Contractor'),
    });

    await withClient('app', async (client) => {
      await client.query('BEGIN');
      try {
        await setTenant(client, fx.workspaceId, fx.adminId);
        await client.query(
          `UPDATE handoffs SET admission_state='enabled', enabled_by=$2, enabled_at=now()
            WHERE workspace_id=$1 AND key='contractor-agreements'`,
          [fx.workspaceId, fx.adminId],
        );
        await client.query(
          `UPDATE members SET reviewer_roles = ARRAY['finance']::text[]
            WHERE workspace_id=$1 AND user_id=$2`,
          [fx.workspaceId, fx.memberId],
        );

        const work = {
          tx: client,
          workspaceId: fx.workspaceId,
          userId: fx.adminId,
          role: 'admin' as const,
          session: { sid: randomUUID(), authenticated_at: new Date().toISOString() },
          jobs: [] as string[],
          requireAdmin: () => undefined,
        } as unknown as TenantWork;

        const outcome = await recordDecision(work, applicationId, 'approve', null);
        expect(outcome.resulting_status).toBe('admitted');

        const agreement = await client.query<{
          id: string;
          status: string;
          payload: { workflow_provenance?: { source_application_id?: string; handoff_key?: string } };
        }>(
          `SELECT id, status, payload FROM requests
            WHERE workspace_id=$1 AND kind='agreement'
              AND subject_key=$2`,
          [fx.workspaceId, `partner-contractor-agreement:${applicationId}`],
        );
        expect(agreement.rows).toHaveLength(1);
        expect(agreement.rows[0]?.status).toBe('pending');
        expect(agreement.rows[0]?.payload.workflow_provenance?.handoff_key).toBe('contractor-agreements');
        expect(agreement.rows[0]?.payload.workflow_provenance?.source_application_id).toBe(applicationId);

        const audience = await client.query<{ user_id: string }>(
          `SELECT user_id FROM request_audiences WHERE request_id=$1`,
          [agreement.rows[0]!.id],
        );
        expect(audience.rows.map((row) => row.user_id)).toContain(fx.memberId);

        const view = await loadPartnerWorkflowViewV2(client, fx.workspaceId, fx.memberId);
        const list = await loadHandoffsList(client, fx.workspaceId, fx.memberId, view);
        const detail = await loadHandoffDetail(client, fx.workspaceId, list[0]!.id, view);
        expect(detail.in_motion).toHaveLength(1);
        expect(detail.in_motion[0]?.title).toBe('Nova Partner');
        expect(detail.in_motion[0]?.subtitle).toBe('Agreement ready for review');
        expect(detail.in_motion[0]?.open_request_id).toBe(agreement.rows[0]!.id);

        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  });

  it('lets a Finance member decide only the agreement admit created, not a lookalike an agent proposed', async () => {
    const fx = await configuredFixture();
    const applicationId = await seedRequest(fx, 'application', {
      label: 'Nova Partner',
      payload: applicationPayload('Nova Partner', 'Contractor'),
    });
    let genuineId = '';
    let genuine: Record<string, unknown> = {};
    await withClient('app', async (client) => {
      await client.query('BEGIN');
      try {
        await setTenant(client, fx.workspaceId, fx.adminId);
        await client.query(
          `UPDATE handoffs SET admission_state='enabled', enabled_by=$2, enabled_at=now()
            WHERE workspace_id=$1 AND key='contractor-agreements'`,
          [fx.workspaceId, fx.adminId],
        );
        await client.query(
          `UPDATE members SET reviewer_roles = ARRAY['finance']::text[] WHERE workspace_id=$1 AND user_id=$2`,
          [fx.workspaceId, fx.memberId],
        );
        const work = {
          tx: client,
          workspaceId: fx.workspaceId,
          userId: fx.adminId,
          role: 'admin' as const,
          session: { sid: randomUUID(), authenticated_at: new Date().toISOString() },
          jobs: [] as string[],
          requireAdmin: () => undefined,
        } as unknown as TenantWork;
        await recordDecision(work, applicationId, 'approve', null);
        const row = (await client.query<{ id: string; payload: Record<string, unknown> }>(
          `SELECT id, payload FROM requests WHERE workspace_id=$1 AND subject_key=$2`,
          [fx.workspaceId, `partner-contractor-agreement:${applicationId}`],
        )).rows[0]!;
        genuineId = row.id;
        genuine = row.payload;
        await client.query('COMMIT');
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });

    // Same provenance in the payload, but the subject key an agent proposal gets.
    const lookalikeId = await seedRequest(fx, 'agreement', {
      label: 'Nova Partner',
      payload: genuine,
      subjectKey: 'name:lookalike',
    });
    await withClient('owner', async (client) => {
      await client.query('BEGIN');
      await setTenant(client, fx.workspaceId, fx.adminId);
      await client.query(
        `INSERT INTO request_audiences (workspace_id, request_id, user_id, purpose) VALUES ($1,$2,$3,'owner')`,
        [fx.workspaceId, lookalikeId, fx.memberId],
      );
      await client.query('COMMIT');
    });

    const env = makeEnv();
    const decideAsFinance = (requestId: string) =>
      asUser(env.env, fx.memberId, `/w/${fx.workspaceId}/requests/${requestId}/decisions`, {
        method: 'POST',
        headers: INBOX_HEADERS,
        body: { decision: 'approve' },
      });

    const lookalike = await decideAsFinance(lookalikeId);
    expect(lookalike.status).toBe(403);
    expect(await lookalike.json()).toMatchObject({ reason: 'admin_required' });

    // The genuine one clears the permission check and stops at the review binding.
    const allowed = await decideAsFinance(genuineId);
    expect(await allowed.json()).toMatchObject({ reason: 'review_binding_required' });

    const listed = await withClient('app', async (client) => {
      await client.query('BEGIN');
      try {
        await setTenant(client, fx.workspaceId, fx.memberId);
        const view = await loadPartnerWorkflowViewV2(client, fx.workspaceId, fx.memberId);
        const list = await loadHandoffsList(client, fx.workspaceId, fx.memberId, view);
        const detail = await loadHandoffDetail(client, fx.workspaceId, list[0]!.id, view);
        await client.query('COMMIT');
        return detail;
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
    expect(listed.in_motion.map((item) => item.open_request_id)).toEqual([genuineId]);
  });
});
