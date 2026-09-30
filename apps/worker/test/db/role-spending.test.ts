// Real route/transaction/RLS coverage; these drafts must never alter authority.
import { describe, expect, it } from 'vitest';
import { ROLE_SPENDING_USDC_ADDRESS, type RoleSpendingDraft, type WorkspaceRole } from '@hermes/shared';
import { asUser, makeEnv } from './harness.js';
import { seedWorkspace, setTenant, withClient, type Fixture } from './helpers.js';
import { ageSession } from './m4-fixtures.js';

const policy = () => ({ version: 1, chain_id: 8453, asset: 'USDC', token_address: ROLE_SPENDING_USDC_ADDRESS,
  decimals: 6, max_transfer_base_units: '100000000', allowed_recipients: [`0x${'12'.repeat(20)}`],
  human_approvals: 2, future_period_limits: [] });
const env = () => makeEnv().env;
const path = (fx: Fixture, role: string) => `/w/${fx.workspaceId}/roles/${role}/spending-policy`;
const read = (fx: Fixture, role: string, user = fx.adminId) => asUser(env(), user, path(fx, role));
const save = (fx: Fixture, role: string, revision = 0, user = fx.adminId) =>
  asUser(env(), user, path(fx, role), { method: 'PUT', body: { expected_revision: revision, policy: policy() } });
async function roleId(fx: Fixture) {
  const res = await asUser(env(), fx.adminId, `/w/${fx.workspaceId}/roles`);
  const list = await res.json() as { items: WorkspaceRole[] };
  return list.items.find((role) => role.slug === 'finance')!.id;
}
async function query<T>(fx: Fixture, run: (c: import('pg').Client) => Promise<T>): Promise<T> {
  return withClient('app', async (c) => {
    await c.query('BEGIN');
    try {
      await setTenant(c, fx.workspaceId, fx.adminId);
      const result = await run(c);
      await c.query('COMMIT'); return result;
    } catch (error) { await c.query('ROLLBACK'); throw error; }
  });
}
describe('role spending drafts', () => {
  it('requires current Admin access and fresh sign-in for writes', async () => {
    const fx = await seedWorkspace(); const role = await roleId(fx);
    expect((await read(fx, role, fx.memberId)).status).toBe(403);
    expect((await save(fx, role, 0, fx.memberId)).status).toBe(403);
    await ageSession(fx.adminId, 10);
    expect((await read(fx, role)).status).toBe(200);
    expect((await save(fx, role)).status).toBe(401);
  });
  it('persists an exact, immutable audit revision without activating authority', async () => {
    const fx = await seedWorkspace(); const role = await roleId(fx);
    expect(await (await read(fx, role)).json()).toMatchObject({ revision: 0, policy: null, state: 'draft_only', enforcement: 'none' });
    const before = await query(fx, c => c.query('SELECT id, reviewer_roles FROM members ORDER BY id'));
    const written = await save(fx, role);
    expect(written.status).toBe(200);
    expect(written.headers.get('cache-control')).toBe('no-store');
    const first = await written.json() as RoleSpendingDraft;
    expect(first).toMatchObject({ role_id: role, revision: 1, policy: policy(), state: 'draft_only', enforcement: 'none',
      provider_activation_available: false, updated_by: fx.adminId, free_tier: { signature_usage: 'unverified', free_execution_guaranteed: false } });
    expect(await (await read(fx, role)).json()).toEqual(first);
    expect((await save(fx, role, 1)).status).toBe(200);
    expect((await query(fx, c => c.query('SELECT id, reviewer_roles FROM members ORDER BY id'))).rows).toEqual(before.rows);
    const revisions = await query(fx, c => c.query('SELECT revision, requested_by FROM role_spending_drafts WHERE role_id = $1 ORDER BY revision', [role]));
    expect(revisions.rows).toEqual([{ revision: 1, requested_by: fx.adminId }, { revision: 2, requested_by: fx.adminId }]);
    expect((await query(fx, c => c.query("SELECT id FROM events WHERE kind = 'settings.changed'"))).rows).toHaveLength(2);
    expect((await query(fx, c => c.query('SELECT * FROM workspace_wallet_config'))).rows).toEqual([]);
  });
  it('serializes first-save races and refuses a stale revision without another audit write', async () => {
    const fx = await seedWorkspace(); const role = await roleId(fx);
    const answers = await Promise.all([save(fx, role), save(fx, role)]);
    expect(answers.map((res) => res.status).sort()).toEqual([200, 409]);
    const stale = await save(fx, role);
    expect(stale.status).toBe(409);
    expect(await stale.json()).toMatchObject({ reason: 'revision_conflict' });
    expect((await query(fx, c => c.query('SELECT revision FROM role_spending_drafts'))).rows).toEqual([{ revision: 1 }]);
  });
  it('never accepts another tenant’s role, scope override, or policy row', async () => {
    const fx = await seedWorkspace(); const other = await seedWorkspace();
    const role = await roleId(fx); const foreign = await roleId(other);
    expect((await save(fx, foreign)).status).toBe(404);
    expect((await read(fx, foreign)).status).toBe(404);
    expect((await read(fx, role, other.adminId)).status).toBe(404);
    const spoofed = await asUser(env(), fx.adminId, path(fx, role), { method: 'PUT', body: {
      expected_revision: 0, workspace_id: other.workspaceId, policy: policy(),
    } });
    expect(spoofed.status).toBe(422);
    await save(fx, role);
    expect((await query(other, c => c.query('SELECT * FROM role_spending_drafts WHERE workspace_id = $1', [fx.workspaceId]))).rows).toEqual([]);
    await expect(query(fx, c => c.query(
      'INSERT INTO role_spending_drafts(workspace_id,role_id,role_name,revision,policy,requested_by) VALUES ($1,$2,$3,1,$4,$5)',
      [fx.workspaceId, foreign, 'Foreign role', JSON.stringify(policy()), fx.adminId],
    ))).rejects.toMatchObject({ code: '23503' });
  });
  it('preserves custom role audit after deletion without carrying authority into a replacement role', async () => {
    const fx = await seedWorkspace();
    const created = await asUser(env(), fx.adminId, `/w/${fx.workspaceId}/roles`, { method: 'POST', body: { name: 'Procurement' } });
    const role = (await created.json() as WorkspaceRole).id;
    expect((await save(fx, role)).status).toBe(200);
    expect((await asUser(env(), fx.adminId, `/w/${fx.workspaceId}/roles/${role}`, { method: 'DELETE' })).status).toBe(204);
    expect((await read(fx, role)).status).toBe(404);
    expect((await query(fx, c => c.query('SELECT role_name FROM role_spending_drafts WHERE role_id = $1', [role]))).rows).toEqual([{ role_name: 'Procurement' }]);
    const replacement = await asUser(env(), fx.adminId, `/w/${fx.workspaceId}/roles`, { method: 'POST', body: { name: 'Procurement' } });
    const newRole = (await replacement.json() as WorkspaceRole).id;
    expect(newRole).not.toBe(role);
    expect(await (await read(fx, newRole)).json()).toMatchObject({ revision: 0, policy: null });
  });
  it('rejects cross-origin and missing cookie CSRF mutations', async () => {
    const fx = await seedWorkspace(); const role = await roleId(fx);
    const options = { method: 'PUT', body: { expected_revision: 0, policy: policy() } };
    expect((await asUser(env(), fx.adminId, path(fx, role), { ...options, origin: 'https://foreign.test' })).status).toBe(403);
    expect((await asUser(makeEnv({ AUTH_MODE: 'workos' }).env, fx.adminId, path(fx, role), options)).status).toBe(403);
    expect((await query(fx, c => c.query('SELECT * FROM role_spending_drafts'))).rows).toEqual([]);
  });
  it('denies agent access and app edits to the append-only draft history', async () => {
    const fx = await seedWorkspace(); const role = await roleId(fx); await save(fx, role);
    await expect(query(fx, c => c.query('UPDATE role_spending_drafts SET revision = 2'))).rejects.toMatchObject({ code: '42501' });
    await expect(query(fx, c => c.query('DELETE FROM role_spending_drafts'))).rejects.toMatchObject({ code: '42501' });
    await withClient('agent', async (c) => {
      await c.query('BEGIN'); await setTenant(c, fx.workspaceId, fx.adminId);
      await expect(c.query('SELECT * FROM role_spending_drafts')).rejects.toMatchObject({ code: '42501' });
      await c.query('ROLLBACK');
    });
  });
});
