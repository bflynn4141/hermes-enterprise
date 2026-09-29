// Every outside connection on one list (docs/CONNECTORS.md), against real
// Postgres and the real loaders. Microsoft sending and agent addresses are
// configured here; Gmail, Slack and read-only Gmail are not.
import { describe, expect, it } from 'vitest';
import { connectorListSchema, emailInboxListSchema } from '@hermes/shared';
import type { Env } from '../../src/env.js';
import { withWorkspaceTransaction } from '../../src/jobs.js';
import { storeSendingAccount } from '../../src/outbound-email/gmail-store.js';
import { asUser, makeEnv } from './harness.js';
import { seedWorkspace, setTenant, withClient, type Fixture } from './helpers.js';

const env: Env = makeEnv({
  KEK_V1: Buffer.alloc(32, 31).toString('base64'),
  MICROSOFT_MAIL_ENABLED: '1',
  MICROSOFT_CLIENT_ID: 'ms-client', MICROSOFT_CLIENT_SECRET: 'ms-secret',
  MICROSOFT_STATE_SECRET: 'microsoft-state-secret-at-least-thirty-two-chars',
  MICROSOFT_REDIRECT_URI: 'https://hermes.test/integrations/microsoft/oauth/callback',
  EMAIL_INTAKE_DOMAIN: 'in.hermes.test',
  EMAIL_REPLY_MODE: 'send_after_approval',
  ENVIRONMENT: 'development',
} as unknown as Partial<Env>).env;

async function scoped<T extends Record<string, unknown>>(workspaceId: string, sql: string, params: readonly unknown[] = []): Promise<T[]> {
  return withClient('owner', async (c) => {
    await c.query('BEGIN');
    try {
      await setTenant(c, workspaceId, '00000000-0000-4000-8000-000000000000');
      const result = await c.query<T>(sql, [...params]);
      await c.query('COMMIT');
      return result.rows;
    } catch (error) {
      await c.query('ROLLBACK');
      throw error;
    }
  });
}

async function connections(fx: Fixture, userId: string) {
  const response = await asUser(env, userId, `/w/${fx.workspaceId}/connections`);
  expect(response.status, await response.clone().text()).toBe(200);
  const list = connectorListSchema.parse(await response.json());
  return Object.fromEntries(list.connections.map((connection) => [connection.key, connection]));
}

const connectMicrosoft = (fx: Fixture) => withWorkspaceTransaction(env, fx.workspaceId, (tx) => storeSendingAccount(tx, env, {
  workspaceId: fx.workspaceId, connectedBy: fx.adminId, address: 'ops@contoso.example', provider: 'microsoft',
  token: { access_token: 'a', refresh_token: 'r', expires_at: new Date(Date.now() + 3_600_000).toISOString(), scope: 'Mail.Send', token_type: 'Bearer' },
}));

describe('the connections list', () => {
  it('says which connections this deployment has, and which are connected', async () => {
    const fx = await seedWorkspace();
    await connectMicrosoft(fx);
    const list = await connections(fx, fx.adminId);
    expect(Object.keys(list)).toEqual(['gmail_sending', 'microsoft_sending', 'agent_address', 'slack', 'gmail_evidence']);
    expect(list.gmail_sending).toMatchObject({ state: 'not_configured' });
    expect(list.slack).toMatchObject({ state: 'not_configured', detail_view: 'Slack' });
    expect(list.gmail_evidence).toMatchObject({ state: 'not_configured' });
    expect(list.microsoft_sending).toMatchObject({ state: 'connected', identity: 'ops@contoso.example', waiting: 0, reason: null });
    expect(list.agent_address).toMatchObject({ state: 'not_connected', identity: '@in.hermes.test' });
  });

  it('shows a Member each state but not the account behind it', async () => {
    const fx = await seedWorkspace();
    await connectMicrosoft(fx);
    const list = await connections(fx, fx.memberId);
    expect(list.microsoft_sending).toMatchObject({ state: 'connected', identity: null, waiting: 0 });
    expect(list.agent_address!.identity).toBeNull();
  });

  it('stops saying Connected once the provider refused the account', async () => {
    const fx = await seedWorkspace();
    const account = await connectMicrosoft(fx);
    await scoped(fx.workspaceId, `UPDATE outbound_email_accounts SET status='error' WHERE id=$1`, [account.id]);
    expect((await connections(fx, fx.adminId)).microsoft_sending).toMatchObject({ state: 'needs_attention', reason: expect.stringMatching(/Reconnect/) });
  });

  it('flags agent addresses whose approved replies have no way out', async () => {
    const fx = await seedWorkspace();
    const [member] = await scoped<{ id: string }>(fx.workspaceId, `SELECT id FROM members WHERE workspace_id=$1 AND user_id=$2`, [fx.workspaceId, fx.adminId]);
    await scoped(fx.workspaceId, `INSERT INTO agent_owners (workspace_id, agent_id, member_id) VALUES ($1,$2,$3)`, [fx.workspaceId, fx.agentId, member!.id]);
    const inboxes = await asUser(env, fx.adminId, `/w/${fx.workspaceId}/email/inboxes`);
    expect(emailInboxListSchema.parse(await inboxes.json()).inboxes.some((inbox) => inbox.kind === 'agent')).toBe(true);
    // This deployment approves replies but has no Cloudflare send binding.
    expect((await connections(fx, fx.adminId)).agent_address).toMatchObject({ state: 'needs_attention', reason: expect.stringMatching(/no sending binding/) });
    const withBinding = { ...env, EMAIL: { send: async () => ({ messageId: 'x' }) } } as unknown as Env;
    const response = await asUser(withBinding, fx.adminId, `/w/${fx.workspaceId}/connections`);
    const list = connectorListSchema.parse(await response.json());
    expect(list.connections.find((connection) => connection.key === 'agent_address')).toMatchObject({ state: 'connected' });

    await scoped(fx.workspaceId, `UPDATE email_inboxes SET status='paused' WHERE workspace_id=$1 AND kind='agent'`, [fx.workspaceId]);
    expect((await connections(fx, fx.adminId)).agent_address).toMatchObject({ state: 'paused' });
  });
});
