import { describe, expect, it } from 'vitest';
import type { WalletOverview, WalletRecord } from '@hermes/shared';
import { asUser, makeEnv } from './harness.js';
import { seedWorkspace, setTenant, withClient, type Fixture } from './helpers.js';
import { ageSession } from './m4-fixtures.js';
const env = (enabled = true) => makeEnv({ TURNKEY_WALLETS_ENABLED: enabled ? '1' : undefined }).env;
const list = (fx: Fixture, user = fx.adminId) => asUser(env(), user, `/w/${fx.workspaceId}/wallets`);
const enroll = (fx: Fixture, body: unknown, user = fx.adminId, enabled = true) =>
  asUser(env(enabled), user, `/w/${fx.workspaceId}/wallets/enrollment`, { method: 'POST', body });
async function memberId(fx: Fixture, userId: string) {
  return withClient('owner', async (c) => {
    await c.query('BEGIN'); await setTenant(c, fx.workspaceId, fx.adminId);
    const { rows } = await c.query('SELECT id FROM members WHERE workspace_id = $1 AND user_id = $2', [fx.workspaceId, userId]);
    await c.query('COMMIT'); return rows[0].id as string;
  });
}
describe('wallet enrollment', () => {
  it('fails closed while disabled and requires an Admin with fresh authentication', async () => {
    const fx = await seedWorkspace();
    const off = await asUser(env(false), fx.adminId, `/w/${fx.workspaceId}/wallets`);
    expect(await off.json()).toMatchObject({ enabled: false, items: [] });
    expect((await enroll(fx, { kind: 'workspace' }, fx.adminId, false)).status).toBe(503);
    expect((await enroll(fx, { kind: 'workspace' }, fx.memberId)).status).toBe(403);
    await ageSession(fx.adminId, 10);
    expect((await enroll(fx, { kind: 'workspace' })).status).toBe(401);
  });
  it('records one durable request on concurrent retries, never a pretend address', async () => {
    const fx = await seedWorkspace();
    const responses = await Promise.all([enroll(fx, { kind: 'workspace' }), enroll(fx, { kind: 'workspace' })]);
    expect(responses.map(r => r.status)).toEqual([202, 202]);
    const first = await responses[0]!.json() as WalletRecord;
    expect(await responses[1]!.json()).toEqual(first);
    expect(first).toMatchObject({ kind: 'workspace', address: null, status: 'awaiting_owner_enrollment' });
    const overview = await (await list(fx)).json() as WalletOverview;
    expect(overview.items).toHaveLength(1);
    expect((await enroll(fx, { kind: 'workspace', address: '0x123', suborg_id: 'pretend' })).status).toBe(422);
  });
  it('isolates tenants and only returns a member their own wallet', async () => {
    const fx = await seedWorkspace(); const other = await seedWorkspace();
    const ownId = await memberId(fx, fx.memberId);
    await enroll(fx, { kind: 'workspace' });
    await enroll(fx, { kind: 'member', member_id: await memberId(fx, fx.adminId) });
    await enroll(fx, { kind: 'member', member_id: ownId });
    expect((await enroll(fx, { kind: 'agent', agent_id: fx.agentId })).status).toBe(404);
    const visible = await (await list(fx, fx.memberId)).json() as WalletOverview;
    expect(visible.items.map(i => i.member_id)).toEqual([ownId]);
    expect((await (await list(fx)).json() as WalletOverview).items).toHaveLength(3);
    expect((await enroll(fx, { kind: 'member', member_id: await memberId(other, other.memberId) })).status).toBe(404);
    expect((await enroll(fx, { kind: 'agent', agent_id: other.agentId })).status).toBe(404);
    expect((await list(fx, other.adminId)).status).toBe(404);
    await withClient('app', async c => {
      await c.query('BEGIN'); await setTenant(c, other.workspaceId, other.adminId);
      expect((await c.query('SELECT id FROM wallet_principals WHERE workspace_id = $1', [fx.workspaceId])).rows).toEqual([]);
      await expect(c.query('INSERT INTO workspace_wallet_config(workspace_id) VALUES ($1)', [fx.workspaceId])).rejects.toMatchObject({code:'42501'});
      await c.query('ROLLBACK');
    });
  });
  it('uses current agent ownership and revokes visibility immediately on reassignment', async () => {
    const fx = await seedWorkspace();
    const ownId = await memberId(fx, fx.memberId);
    const adminMember = await memberId(fx, fx.adminId);
    async function setOwner(member: string) {
      await withClient('owner', async c => {
        await c.query('BEGIN'); await setTenant(c, fx.workspaceId, fx.adminId);
        await c.query('INSERT INTO agent_owners(workspace_id,agent_id,member_id) VALUES ($1,$2,$3) ON CONFLICT (agent_id) DO UPDATE SET member_id = EXCLUDED.member_id', [fx.workspaceId,fx.agentId,member]);
        await c.query('COMMIT');
      });
    }
    await setOwner(ownId);
    expect((await enroll(fx, { kind: 'agent', agent_id: fx.agentId })).status).toBe(202);
    expect((await (await list(fx, fx.memberId)).json() as WalletOverview).items.map(i => i.agent_id)).toEqual([fx.agentId]);
    await setOwner(adminMember);
    expect((await (await list(fx, fx.memberId)).json() as WalletOverview).items).toEqual([]);
  });
  it('refuses foreign origin and missing cookie CSRF without recording enrollment', async () => {
    const fx = await seedWorkspace();
    expect((await asUser(env(), fx.adminId, `/w/${fx.workspaceId}/wallets/enrollment`, { method: 'POST', body: {kind:'workspace'}, origin: 'https://foreign.test' })).status).toBe(403);
    expect((await asUser(makeEnv({TURNKEY_WALLETS_ENABLED:'1',AUTH_MODE:'workos'}).env, fx.adminId, `/w/${fx.workspaceId}/wallets/enrollment`, { method: 'POST', body: {kind:'workspace'} })).status).toBe(403);
    expect((await (await list(fx)).json() as WalletOverview).items).toEqual([]);
  });
  it('denies agent DB reads and app insertion of unverified accounts', async () => {
    const fx = await seedWorkspace();
    await enroll(fx, { kind: 'workspace' });
    await withClient('agent', async c => {
      await c.query('BEGIN'); await setTenant(c, fx.workspaceId, fx.adminId);
      await expect(c.query('SELECT * FROM wallet_principals')).rejects.toMatchObject({ code: '42501' });
      await c.query('ROLLBACK');
    });
    await withClient('app', async c => {
      await c.query('BEGIN'); await setTenant(c, fx.workspaceId, fx.adminId);
      await expect(c.query('INSERT INTO wallet_accounts DEFAULT VALUES')).rejects.toMatchObject({ code: '42501' });
      await c.query('ROLLBACK');
    });
  });
});
