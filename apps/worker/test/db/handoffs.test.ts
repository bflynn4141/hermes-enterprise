import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { loadHandoffDetail, loadHandoffsList, readHandoffAdmission } from '../../src/handoffs/service.js';
import { configurePartnerWorkflow } from '../../src/partner-workflow/service.js';
import { loadPartnerWorkflowViewV2 } from '../../src/partner-workflow/v2.js';
import { seedWorkspace, setTenant, withClient } from './helpers.js';

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
});
