// Workspace roles (migration 0072, decision C92): the catalog, who may change
// it, and the database rules that keep membership and roles in step.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { WorkspaceRole } from '@hermes/shared';
import { configurePartnerWorkflow } from '../../src/partner-workflow/service.js';
import { asUser, makeEnv } from './harness.js';
import { seedWorkspace, setTenant, withClient, type Fixture } from './helpers.js';
import { ageSession } from './m4-fixtures.js';

const env = () => makeEnv().env;

async function asTenant<T>(fx: Fixture, fn: (c: import('pg').Client) => Promise<T>): Promise<T> {
  return withClient('app', async (c) => {
    await c.query('BEGIN');
    try {
      await setTenant(c, fx.workspaceId, fx.adminId);
      const result = await fn(c);
      await c.query('COMMIT');
      return result;
    } catch (error) {
      await c.query('ROLLBACK');
      throw error;
    }
  });
}

async function roles(fx: Fixture): Promise<WorkspaceRole[]> {
  const response = await asUser(env(), fx.adminId, `/w/${fx.workspaceId}/roles`);
  expect(response.status).toBe(200);
  return ((await response.json()) as { items: WorkspaceRole[] }).items;
}

const send = (fx: Fixture, userId: string, method: string, path: string, body?: unknown) =>
  asUser(env(), userId, `/w/${fx.workspaceId}${path}`, { method, ...(body === undefined ? {} : { body }) });

describe('workspace roles', () => {
  it('starts every workspace with the built-in roles, holding what its tags held', async () => {
    const fx = await seedWorkspace();
    const list = await roles(fx);
    expect(list.map((role) => [role.slug, role.name, role.builtin, role.agent_template])).toEqual([
      ['partnerships', 'Partnerships', true, 'partnerships-agent'],
      ['finance', 'Finance', true, 'finance-agent'],
      ['access', 'Access reviewer', true, null],
      ['legal', 'Legal', true, null],
      ['shared_intelligence_reviewer', 'Shared Intelligence reviewer', true, null],
    ]);
    // The fixture Admin was seeded with the access and finance tags.
    const holders = (slug: string) => list.find((role) => role.slug === slug)?.members.map((m) => m.user_id);
    expect(holders('finance')).toEqual([fx.adminId]);
    expect(holders('access')).toEqual([fx.adminId]);
    expect(holders('partnerships')).toEqual([]);
  });

  it('is Admin-only, and needs a recent sign-in to change', async () => {
    const fx = await seedWorkspace();
    expect((await asUser(env(), fx.memberId, `/w/${fx.workspaceId}/roles`)).status).toBe(403);
    // Reading works on an old sign-in; changing needs a recent one.
    expect((await asUser(env(), fx.adminId, `/w/${fx.workspaceId}/roles`)).status).toBe(200);
    await ageSession(fx.adminId, 10);
    expect((await asUser(env(), fx.adminId, `/w/${fx.workspaceId}/roles`)).status).toBe(200);
    const stale = await send(fx, fx.adminId, 'POST', '/roles', { name: 'Partner Success' });
    expect(stale.status).toBe(401);
    expect(await stale.json()).toMatchObject({ reason: 'reauth_required' });
  });

  it('adds, renames and removes a custom role; built-ins keep their name and stay', async () => {
    const fx = await seedWorkspace();
    const created = await send(fx, fx.adminId, 'POST', '/roles', { name: 'Partner Success', description: 'Keeps partners onboarded.' });
    expect(created.status).toBe(201);
    const role = (await created.json()) as WorkspaceRole;
    expect(role).toMatchObject({ slug: 'partner-success', name: 'Partner Success', builtin: false, agent_template: null, members: [] });

    const duplicate = await send(fx, fx.adminId, 'POST', '/roles', { name: 'partner success' });
    expect(duplicate.status).toBe(409);
    expect(await duplicate.json()).toMatchObject({ reason: 'role_exists' });

    const renamed = await send(fx, fx.adminId, 'PATCH', `/roles/${role.id}`, { name: 'Partner Care' });
    expect(await renamed.json()).toMatchObject({ slug: 'partner-success', name: 'Partner Care' });

    const finance = (await roles(fx)).find((item) => item.slug === 'finance')!;
    const rename = await send(fx, fx.adminId, 'PATCH', `/roles/${finance.id}`, { name: 'Accounts' });
    expect(rename.status).toBe(422);
    expect(await rename.json()).toMatchObject({ reason: 'builtin_role_name' });
    const described = await send(fx, fx.adminId, 'PATCH', `/roles/${finance.id}`, { description: 'Pays partners.' });
    expect(await described.json()).toMatchObject({ name: 'Finance', description: 'Pays partners.' });
    expect((await send(fx, fx.adminId, 'DELETE', `/roles/${finance.id}`)).status).toBe(422);

    expect((await send(fx, fx.adminId, 'PUT', `/roles/${role.id}/members`, { user_ids: [fx.memberId] })).status).toBe(200);
    const held = await send(fx, fx.adminId, 'DELETE', `/roles/${role.id}`);
    expect(held.status).toBe(409);
    expect(await held.json()).toMatchObject({ reason: 'role_in_use' });
    await send(fx, fx.adminId, 'PUT', `/roles/${role.id}/members`, { user_ids: [] });
    expect((await send(fx, fx.adminId, 'DELETE', `/roles/${role.id}`)).status).toBe(204);
    expect((await roles(fx)).some((item) => item.slug === 'partner-success')).toBe(false);
  });

  it('lets many people hold a role, and nobody change their own', async () => {
    const fx = await seedWorkspace();
    const finance = (await roles(fx)).find((item) => item.slug === 'finance')!;

    // The Admin already holds Finance; keeping them and adding the Member is fine.
    const both = await send(fx, fx.adminId, 'PUT', `/roles/${finance.id}/members`, { user_ids: [fx.adminId, fx.memberId] });
    expect(both.status).toBe(200);
    expect(((await both.json()) as WorkspaceRole).members.map((m) => m.user_id).sort()).toEqual([fx.adminId, fx.memberId].sort());
    const memberRoles = await asTenant(fx, async (c) =>
      (await c.query<{ reviewer_roles: string[] }>(`SELECT reviewer_roles FROM members WHERE user_id = $1`, [fx.memberId])).rows[0]!.reviewer_roles);
    expect(memberRoles).toEqual(['finance']);

    // Dropping themself is a change to their own authority.
    const self = await send(fx, fx.adminId, 'PUT', `/roles/${finance.id}/members`, { user_ids: [fx.memberId] });
    expect(self.status).toBe(409);
    expect(await self.json()).toMatchObject({ reason: 'self_change' });

    const stranger = await send(fx, fx.adminId, 'PUT', `/roles/${finance.id}/members`, { user_ids: [randomUUID()] });
    expect(stranger.status).toBe(422);
    expect(await stranger.json()).toMatchObject({ reason: 'unknown_member' });
  });

  it('refuses a role that does not exist, in the member route and in the database', async () => {
    const fx = await seedWorkspace();
    const members = await asUser(env(), fx.adminId, `/w/${fx.workspaceId}/members`);
    const member = ((await members.json()) as { items: { id: string; user_id: string }[] }).items.find((m) => m.user_id === fx.memberId)!;
    const patched = await send(fx, fx.adminId, 'PATCH', `/members/${member.id}`, { reviewer_roles: ['treasury'] });
    expect(patched.status).toBe(422);
    expect(await patched.json()).toMatchObject({ reason: 'unknown_role' });

    await expect(asTenant(fx, (c) =>
      c.query(`UPDATE members SET reviewer_roles = ARRAY['treasury'] WHERE user_id = $1`, [fx.memberId]),
    )).rejects.toThrow(/no role treasury/);
  });

  it('records the Partnerships person when a lane is bound, and a workspace with roles still deletes', async () => {
    const fx = await seedWorkspace();
    const financeAgentId = randomUUID();
    await asTenant(fx, async (c) => {
      await c.query(`INSERT INTO agents (id, workspace_id, name, status) VALUES ($1, $2, 'Ledger', 'started')`, [financeAgentId, fx.workspaceId]);
      await configurePartnerWorkflow(c, fx.workspaceId, fx.adminId, {
        partnerships: { agent_id: fx.agentId, principal_user_id: fx.adminId },
        finance: { agent_id: financeAgentId, principal_user_id: fx.memberId },
      });
    });
    const list = await roles(fx);
    expect(list.find((role) => role.slug === 'partnerships')?.members.map((m) => m.user_id)).toEqual([fx.adminId]);
    expect(list.find((role) => role.slug === 'finance')?.members.map((m) => m.user_id).sort()).toEqual([fx.adminId, fx.memberId].sort());
    expect(list.find((role) => role.slug === 'finance')?.agents).toMatchObject([
      { agent_id: financeAgentId, name: 'Ledger', principal: { user_id: fx.memberId } },
    ]);

    // Roles, lanes and holders cascade away together in whatever order.
    await asTenant(fx, (c) => c.query(`UPDATE workspaces SET deletion_requested_at = now() - interval '31 days' WHERE id = $1`, [fx.workspaceId]));
    const deleted = await asTenant(fx, (c) =>
      c.query<{ deleted: number }>(`SELECT hermes_delete_workspace($1::uuid) AS deleted`, [fx.workspaceId]),
    );
    expect(deleted.rows[0]?.deleted).toBe(1);
  });
});
