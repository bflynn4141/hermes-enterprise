import { afterEach, describe, expect, it, vi } from 'vitest';
import { asUser, makeEnv } from './harness.js';
import { seedWorkspace, setTenant, withClient } from './helpers.js';

describe('durable member provisioning', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('records one safe background operation and makes no Cloud or WorkOS call', async () => {
    const fx = await seedWorkspace();
    const { env } = makeEnv({ HERMES_MEMBER_PROVISIONING_ENABLED: '1', AGENT_RUNTIME: 'hermes' });
    const network = vi.fn(() => { throw new Error('No external call is allowed in preparation'); });
    vi.stubGlobal('fetch', network);
    const path = `/w/${fx.workspaceId}/invitations`;
    const first = await asUser(env, fx.adminId, path, { method: 'POST', body: {
      email: 'new-partner@example.test', role: 'member', role_template_key: 'partnerships-agent',
    } });
    expect(first.status).toBe(201);
    const body = await first.json() as Record<string, unknown>;
    expect(body).toMatchObject({ email: 'new-partner@example.test', role_template_key: 'partnerships-agent' });
    expect(body).not.toHaveProperty('cloud_agent_id');
    expect(JSON.stringify(body)).not.toMatch(/token|credential|instance_id/i);

    const duplicate = await asUser(env, fx.adminId, path, { method: 'POST', body: {
      email: 'new-partner@example.test', role: 'member', role_template_key: 'finance-agent',
    } });
    expect(duplicate.status).toBe(200);
    expect(network).not.toHaveBeenCalled();

    await withClient('app', async c => {
      await c.query('BEGIN'); await setTenant(c, fx.workspaceId, fx.adminId);
      const operations = await c.query(`SELECT preparation,issue,role_template_key,cancellation FROM member_provisioning_operations`);
      expect(operations.rows).toEqual([{ preparation: 'awaiting_connection', issue: 'cloud_not_connected', role_template_key: 'partnerships-agent', cancellation: 'none' }]);
      const delivery = await c.query(`SELECT delivery_status,workos_invitation_id FROM invitations WHERE email='new-partner@example.test'`);
      expect(delivery.rows).toEqual([{ delivery_status: 'not_required', workos_invitation_id: null }]);
      const sendJobs = await c.query(`SELECT id FROM jobs WHERE kind='workos_sync' AND payload->>'action' IN ('send_invitation','resend_invitation')`);
      expect(sendJobs.rows).toHaveLength(0);
      const expiryJobs = await c.query(`SELECT id FROM jobs WHERE kind='hermes_invitation_expire'`);
      expect(expiryJobs.rows).toHaveLength(0);
      await c.query('COMMIT');
    });
  });

  it('blocks direct delivery, isolates tenants, and completes local cancellation', async () => {
    const first = await seedWorkspace(); const second = await seedWorkspace();
    const { env } = makeEnv({ HERMES_MEMBER_PROVISIONING_ENABLED: '1', AGENT_RUNTIME: 'hermes' });
    const created = await asUser(env, first.adminId, `/w/${first.workspaceId}/invitations`, { method: 'POST', body: {
      email: 'finance@example.test', role: 'member', role_template_key: 'finance-agent',
    } });
    const invitation = await created.json() as { id: string };
    await withClient('app', async c => {
      await c.query('BEGIN'); await setTenant(c, first.workspaceId, first.adminId);
      await expect(c.query(`INSERT INTO jobs(workspace_id,kind,key,payload) VALUES($1,'workos_sync',$2,$3::jsonb)`, [
        first.workspaceId, `forbidden-send:${invitation.id}`,
        JSON.stringify({ action: 'send_invitation', invitation_id: invitation.id }),
      ])).rejects.toMatchObject({ code: '23514' });
      await c.query('ROLLBACK');
    });
    await withClient('app', async c => {
      await c.query('BEGIN'); await setTenant(c, second.workspaceId, second.adminId);
      expect((await c.query('SELECT id FROM member_provisioning_operations')).rows).toHaveLength(0);
      await expect(c.query(`INSERT INTO member_provisioning_operations(workspace_id,invitation_id,requested_by,role_template_key)
        VALUES($1,$2,$3,'finance-agent')`, [second.workspaceId, invitation.id, second.adminId])).rejects.toMatchObject({ code: '23503' });
      await c.query('ROLLBACK');
    });
    await withClient('agent', async c => {
      await c.query('BEGIN'); await setTenant(c, first.workspaceId, first.adminId);
      await expect(c.query('SELECT * FROM member_provisioning_operations')).rejects.toMatchObject({ code: '42501' });
      await c.query('ROLLBACK');
    });
    expect((await asUser(env, first.adminId, `/w/${first.workspaceId}/invitations/${invitation.id}/withdraw`, { method: 'POST' })).status).toBe(204);
    await withClient('app', async c => {
      await c.query('BEGIN'); await setTenant(c, first.workspaceId, first.adminId);
      expect((await c.query('SELECT cancellation FROM member_provisioning_operations')).rows).toEqual([{ cancellation: 'complete' }]);
      await c.query('COMMIT');
    });
  });
});
