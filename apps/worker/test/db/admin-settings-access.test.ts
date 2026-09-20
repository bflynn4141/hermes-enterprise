import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { Env } from '../../src/env.js';
import { asUser, makeEnv, readTenant } from './harness.js';
import { seedWorkspace, setTenant, withClient } from './helpers.js';

const configuredIntegrationEnv = (): Env => makeEnv({
  SLACK_ENABLED: '1',
  SLACK_CLIENT_ID: 'slack-client',
  SLACK_CLIENT_SECRET: 'slack-secret',
  SLACK_SIGNING_SECRET: 'slack-signing-secret',
  SLACK_STATE_SECRET: 'slack-state-secret',
  SLACK_REDIRECT_URI: 'https://hermes.test/integrations/slack/oauth/callback',
  GMAIL_OUTREACH_ENABLED: '1',
  GMAIL_CLIENT_ID: 'gmail-send-client',
  GMAIL_CLIENT_SECRET: 'gmail-send-secret',
  GMAIL_STATE_SECRET: 'gmail-send-state-secret-value-1234567890',
  GMAIL_REDIRECT_URI: 'https://hermes.test/integrations/gmail/oauth/callback',
  GMAIL_EVIDENCE_ENABLED: '1',
  GMAIL_EVIDENCE_CLIENT_ID: 'gmail-read-client',
  GMAIL_EVIDENCE_CLIENT_SECRET: 'gmail-read-secret',
  GMAIL_EVIDENCE_STATE_SECRET: 'gmail-read-state-secret-value-1234567890',
  GMAIL_EVIDENCE_REDIRECT_URI: 'https://hermes.test/integrations/gmail-evidence/oauth/callback',
}).env;

describe('member-safe connection status', () => {
  it('preserves personal Slack linking while redacting workspace installation metadata', async () => {
    const fx = await seedWorkspace();
    const installationId = randomUUID();
    await withClient('owner', async (client) => {
      await client.query('BEGIN');
      await setTenant(client, fx.workspaceId, fx.adminId);
      const member = await client.query<{ id: string }>(
        'SELECT id FROM members WHERE workspace_id=$1 AND user_id=$2',
        [fx.workspaceId, fx.memberId],
      );
      await client.query(
        `INSERT INTO agent_owners(workspace_id,agent_id,member_id) VALUES($1,$2,$3)`,
        [fx.workspaceId, fx.agentId, member.rows[0]!.id],
      );
      await client.query(
        `INSERT INTO slack_installations
           (id,workspace_id,installed_by,slack_install_key,slack_app_id,slack_team_id,
            slack_team_name,is_enterprise_install,slack_bot_user_id,slack_authed_user_id,
            granted_scopes,ciphertext,iv,wrapped_dek,wrap_iv,kek_version)
         VALUES($1,$2,$3,$4,'A-TEST','T-PRIVATE','Private team',false,'U-BOT','U-ADMIN',
            ARRAY['app_mentions:read','chat:write','im:history'],'\\x01','\\x02','\\x03','\\x04',1)`,
        [installationId, fx.workspaceId, fx.adminId, `team:T-PRIVATE-${fx.workspaceId}`],
      );
      await client.query('COMMIT');
    });
    const env = configuredIntegrationEnv();

    const member = await asUser(env, fx.memberId, `/w/${fx.workspaceId}/integrations/slack`);
    expect(member.status).toBe(200);
    expect(await member.json()).toMatchObject({
      configured: true, status: 'connected', installation_kind: null,
      team_name: null, enterprise_name: null, connected_at: null,
      granted_scopes: [], reconnect_required: false, can_manage: false,
      agent: { id: fx.agentId, name: 'Iris' },
    });
    const link = await asUser(env, fx.memberId, `/w/${fx.workspaceId}/integrations/slack/link-code`, {
      method: 'POST', body: {},
    });
    expect(link.status).toBe(201);
    expect(await link.json()).toMatchObject({ command: expect.stringMatching(/^link hmx_[0-9a-f]+$/) });

    const admin = await asUser(env, fx.adminId, `/w/${fx.workspaceId}/integrations/slack`);
    expect(await admin.json()).toMatchObject({
      installation_kind: 'workspace', team_name: 'Private team',
      granted_scopes: ['app_mentions:read', 'chat:write', 'im:history'], can_manage: true,
    });
  });

  it('reports connection availability to Members without mailbox identity or operational counts', async () => {
    const fx = await seedWorkspace();
    const outboundId = randomUUID();
    const inboundId = randomUUID();
    await withClient('owner', async (client) => {
      await client.query('BEGIN');
      await setTenant(client, fx.workspaceId, fx.adminId);
      await client.query(
        `INSERT INTO outbound_email_accounts
           (id,workspace_id,provider,address,status,ciphertext,iv,wrapped_dek,wrap_iv,kek_version,
            scope,token_expires_at,connected_by)
         VALUES($1,$2,'gmail','sender-private@example.test','connected','\\x01','\\x02','\\x03','\\x04',1,
            'https://www.googleapis.com/auth/gmail.send',now()+interval '1 hour',$3)`,
        [outboundId, fx.workspaceId, fx.adminId],
      );
      await client.query(
        `INSERT INTO gmail_evidence_accounts
           (id,workspace_id,address,status,ciphertext,iv,wrapped_dek,wrap_iv,kek_version,
            scope,token_expires_at,connected_by)
         VALUES($1,$2,'reader-private@example.test','connected','\\x01','\\x02','\\x03','\\x04',1,
            'https://www.googleapis.com/auth/gmail.readonly',now()+interval '1 hour',$3)`,
        [inboundId, fx.workspaceId, fx.adminId],
      );
      await client.query('COMMIT');
    });
    const env = configuredIntegrationEnv();

    const outbound = await asUser(env, fx.memberId, `/w/${fx.workspaceId}/integrations/email`);
    expect(outbound.status).toBe(200);
    expect(await outbound.json()).toMatchObject({
      configured: true, status: 'connected', address: null, connected_at: null,
      pending_messages: 0, can_manage: false,
    });
    const inbound = await asUser(env, fx.memberId, `/w/${fx.workspaceId}/integrations/email/evidence`);
    expect(inbound.status).toBe(200);
    expect(await inbound.json()).toMatchObject({
      configured: true, status: 'connected', address: null, connected_at: null,
      latest_import_at: null, imported_threads: 0, can_manage: false,
    });

    expect(await (await asUser(env, fx.adminId, `/w/${fx.workspaceId}/integrations/email`)).json())
      .toMatchObject({ address: 'sender-private@example.test', connected_at: expect.any(String), can_manage: true });
    expect(await (await asUser(env, fx.adminId, `/w/${fx.workspaceId}/integrations/email/evidence`)).json())
      .toMatchObject({ address: 'reader-private@example.test', connected_at: expect.any(String), can_manage: true });
  });
});

describe('agent configuration read boundaries', () => {
  it('selects a Member-owned agent and rejects a same-workspace private agent owned by somebody else', async () => {
    const fx = await seedWorkspace();
    const memberAgentId = randomUUID();
    const memberSessionId = randomUUID();
    const wakeCalls: string[] = [];
    await withClient('owner', async (client) => {
      await client.query('BEGIN');
      await setTenant(client, fx.workspaceId, fx.adminId);
      const members = await client.query<{ id: string; user_id: string }>(
        'SELECT id,user_id FROM members WHERE workspace_id=$1', [fx.workspaceId],
      );
      const adminMemberId = members.rows.find((row) => row.user_id === fx.adminId)!.id;
      const memberMemberId = members.rows.find((row) => row.user_id === fx.memberId)!.id;
      await client.query('UPDATE agents SET context_scope=\'private\' WHERE id=$1', [fx.agentId]);
      await client.query(
        'INSERT INTO agent_owners(workspace_id,agent_id,member_id) VALUES($1,$2,$3)',
        [fx.workspaceId, fx.agentId, adminMemberId],
      );
      await client.query(
        `INSERT INTO agents(id,workspace_id,name,status,context_scope) VALUES($1,$2,'Dana Iris','started','private')`,
        [memberAgentId, fx.workspaceId],
      );
      await client.query(
        'INSERT INTO agent_owners(workspace_id,agent_id,member_id) VALUES($1,$2,$3)',
        [fx.workspaceId, memberAgentId, memberMemberId],
      );
      await client.query(
        `INSERT INTO sessions(id,workspace_id,owner_id,agent_id,title,model_id)
         VALUES($1,$2,$3,$4,'Member private session','deepseek-flash')`,
        [memberSessionId, fx.workspaceId, fx.memberId, memberAgentId],
      );
      await client.query(
        `INSERT INTO agent_context_fields(workspace_id,agent_id,key,value,scope,set_by)
         VALUES($1,$2,'private_admin_note','admin only','future',$3),
               ($1,$4,'member_note','member only','future',$5)`,
        [fx.workspaceId, fx.agentId, fx.adminId, memberAgentId, fx.memberId],
      );
      await client.query(
        `INSERT INTO instruction_versions(workspace_id,agent_id,body,status,proposed_by,saved_at)
         VALUES($1,$2,'Admin private instruction','saved',$3,now()),
               ($1,$4,'Member private instruction','saved',$5,now())`,
        [fx.workspaceId, fx.agentId, fx.adminId, memberAgentId, fx.memberId],
      );
      await client.query(
        `INSERT INTO runs(workspace_id,session_id,agent_id,status,model_id,client_turn_id,waiting_for,workflow_instance_id)
         VALUES($1,$2,$3,'waiting','deepseek-flash',$4,'answer','admin-wake'),
               ($1,$5,$6,'waiting','deepseek-flash',$7,'answer','member-wake')`,
        [fx.workspaceId, fx.sessionId, fx.agentId, randomUUID(), memberSessionId, memberAgentId, randomUUID()],
      );
      await client.query('COMMIT');
    });
    const { env } = makeEnv({
      RUN_ATTEMPT: {
        get: (id: string) => ({ sendEvent: async () => { wakeCalls.push(id); } }),
      } as unknown as Env['RUN_ATTEMPT'],
    });

    const fields = await asUser(env, fx.memberId, `/w/${fx.workspaceId}/context-fields`);
    expect(fields.status).toBe(200);
    expect(await fields.json()).toMatchObject({
      items: [expect.objectContaining({ field: 'member_note', value: 'member only' })], total: 1,
    });
    const changed = await asUser(env, fx.memberId, `/w/${fx.workspaceId}/context-fields/answer`, {
      method: 'PATCH', body: { value: 'member answer', scope: 'future' },
    });
    expect(changed.status).toBe(200);
    expect(wakeCalls).toEqual(['member-wake']);

    const deniedPaths = [
      `/w/${fx.workspaceId}/instructions?agent_id=${fx.agentId}`,
      `/w/${fx.workspaceId}/skills?agent_id=${fx.agentId}`,
      `/w/${fx.workspaceId}/agents/${fx.agentId}/skill-assignments`,
      `/w/${fx.workspaceId}/agents/${fx.agentId}/permissions`,
    ];
    for (const path of deniedPaths) {
      const denied = await asUser(env, fx.memberId, path);
      expect(denied.status, path).toBe(404);
    }
    expect((await asUser(env, fx.memberId, `/w/${fx.workspaceId}/instructions?agent_id=${memberAgentId}`)).status).toBe(200);
    expect((await asUser(env, fx.adminId, `/w/${fx.workspaceId}/instructions?agent_id=${fx.agentId}`)).status).toBe(200);
    expect((await asUser(env, fx.adminId, `/w/${fx.workspaceId}/instructions?agent_id=${memberAgentId}`)).status).toBe(404);

    const deniedInstructionWrite = await asUser(env, fx.adminId, `/w/${fx.workspaceId}/instructions?agent_id=${memberAgentId}`, {
      method: 'POST',
      headers: { 'x-requested-from': 'skills' },
      body: { text: 'Must not cross owners.', expected_current_id: null },
    });
    expect(deniedInstructionWrite.status).toBe(404);
    const deniedPermissionWrite = await asUser(env, fx.adminId, `/w/${fx.workspaceId}/agents/${memberAgentId}/permissions`, {
      method: 'PATCH',
      body: { revision: 0, operation_id: 'prepare_drafts', require_human_approval: true },
    });
    expect(deniedPermissionWrite.status).toBe(404);
    const deniedAssignmentWrite = await asUser(
      env,
      fx.adminId,
      `/w/${fx.workspaceId}/agents/${memberAgentId}/skill-assignments/${randomUUID()}`,
      { method: 'PATCH', body: { revision: 1, state: 'paused' } },
    );
    expect(deniedAssignmentWrite.status).toBe(404);

    const stored = await readTenant(fx.workspaceId, fx.adminId, (client) => client.query<{ agent_id: string; key: string; value: string }>(
      `SELECT agent_id,key,value FROM agent_context_fields WHERE workspace_id=$1 ORDER BY key`, [fx.workspaceId],
    ));
    expect(stored.rows).toEqual([
      { agent_id: memberAgentId, key: 'answer', value: 'member answer' },
      { agent_id: memberAgentId, key: 'member_note', value: 'member only' },
      { agent_id: fx.agentId, key: 'private_admin_note', value: 'admin only' },
    ]);
  });
});
