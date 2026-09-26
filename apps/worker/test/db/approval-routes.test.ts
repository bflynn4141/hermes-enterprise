// Approval routing (migration 0073, decision C93): the rules an Admin edits,
// and each place that must obey them.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ApprovalRoute } from '@hermes/shared';
import { mirrorMembership } from '../../src/routes/members.js';
import { asUser, makeEnv } from './harness.js';
import { seedWorkspace, setTenant, withClient, type Fixture } from './helpers.js';
import { ageSession, fetchReviewBinding, INBOX_HEADERS, seedRequest } from './m4-fixtures.js';

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

const send = (fx: Fixture, userId: string, method: string, path: string, body?: unknown, headers?: Record<string, string>) =>
  asUser(env(), userId, `/w/${fx.workspaceId}${path}`, { method, ...(body === undefined ? {} : { body }), ...(headers ? { headers } : {}) });

const setRule = (fx: Fixture, key: string, rule: object) => send(fx, fx.adminId, 'PUT', `/approval-routes/${key}`, rule);

async function holds(fx: Fixture, userId: string, slugs: string[]): Promise<void> {
  await asTenant(fx, (c) => c.query(`UPDATE members SET reviewer_roles = $2 WHERE user_id = $1`, [userId, slugs]));
}

async function decide(fx: Fixture, userId: string, requestId: string) {
  return asUser(env(), userId, `/w/${fx.workspaceId}/requests/${requestId}/decisions`, {
    method: 'POST',
    headers: INBOX_HEADERS,
    body: { decision: 'approve', ...await fetchReviewBinding(env(), fx, requestId) },
  });
}

describe('approval rules', () => {
  it('start at the defaults the product already enforced', async () => {
    const fx = await seedWorkspace();
    const response = await asUser(env(), fx.adminId, `/w/${fx.workspaceId}/approval-routes`);
    expect(response.status).toBe(200);
    const items = ((await response.json()) as { items: ApprovalRoute[] }).items;
    expect(items.map((route) => route.key)).toEqual(['application', 'invoice', 'agreement', 'payment', 'access_grant', 'signature', 'email_send']);
    expect(items.every((route) => route.is_default)).toBe(true);
    expect(items.find((route) => route.key === 'payment')?.rule).toEqual({ admins: false, roles: ['finance'], approvals_required: 2, allow_requester: true });
    expect(items.find((route) => route.key === 'invoice')?.workflow_note).toMatch(/Finance person/);
  });

  it('are Admin-only, need a recent sign-in to change, and refuse rules nobody can meet', async () => {
    const fx = await seedWorkspace();
    expect((await asUser(env(), fx.memberId, `/w/${fx.workspaceId}/approval-routes`)).status).toBe(403);

    const nobody = await setRule(fx, 'payment', { admins: false, roles: [], approvals_required: 1, allow_requester: true });
    expect(await nobody.json()).toMatchObject({ reason: 'no_approver' });
    const twoDeciders = await setRule(fx, 'invoice', { admins: true, roles: [], approvals_required: 2, allow_requester: true });
    expect(await twoDeciders.json()).toMatchObject({ reason: 'decision_single_approver' });
    const unknown = await setRule(fx, 'payment', { admins: false, roles: ['treasury'], approvals_required: 1, allow_requester: true });
    expect(await unknown.json()).toMatchObject({ reason: 'unknown_role' });
    expect((await send(fx, fx.adminId, 'PUT', '/approval-routes/lunch', { admins: true, roles: [], approvals_required: 1, allow_requester: true })).status).toBe(404);

    const saved = await setRule(fx, 'payment', { admins: false, roles: ['finance', 'legal'], approvals_required: 3, allow_requester: false });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({ is_default: false, rule: { roles: ['finance', 'legal'], approvals_required: 3, allow_requester: false } });
    const reset = await send(fx, fx.adminId, 'DELETE', '/approval-routes/payment');
    expect(await reset.json()).toMatchObject({ is_default: true, rule: { roles: ['finance'], approvals_required: 2 } });

    await asUser(env(), fx.adminId, `/w/${fx.workspaceId}/approval-routes`);
    await ageSession(fx.adminId, 10);
    const stale = await setRule(fx, 'payment', { admins: false, roles: ['finance'], approvals_required: 1, allow_requester: true });
    expect(stale.status).toBe(401);
  });

  it('decide who may decide a request, and show it in the Inbox', async () => {
    const fx = await seedWorkspace();
    await holds(fx, fx.memberId, ['legal']);
    const requestId = await seedRequest(fx, 'application');

    // Default: Admins only. The Member is refused with the old reason.
    const before = await decide(fx, fx.memberId, requestId);
    expect(before.status).toBe(403);
    expect(await before.json()).toMatchObject({ reason: 'admin_required' });

    // Legal decides applications now, and Admins no longer do.
    await setRule(fx, 'application', { admins: false, roles: ['legal'], approvals_required: 1, allow_requester: true });
    const detail = await asUser(env(), fx.memberId, `/w/${fx.workspaceId}/requests/${requestId}`);
    expect(await detail.json()).toMatchObject({
      decision_summary: { approval_requirement: { pending_for_viewer: true, current: [{ label: 'Legal' }] } },
    });
    const admin = await decide(fx, fx.adminId, requestId);
    expect(admin.status).toBe(403);
    expect(await admin.json()).toMatchObject({ reason: 'approver_required' });
    expect((await decide(fx, fx.memberId, requestId)).status).toBe(201);
  });

  it('can keep someone from approving what their own agent prepared', async () => {
    const fx = await seedWorkspace();
    // Seeded requests belong to the Admin's session: the Admin's agent prepared it.
    const requestId = await seedRequest(fx, 'application');
    await holds(fx, fx.memberId, ['legal']);
    await setRule(fx, 'application', { admins: true, roles: ['legal'], approvals_required: 1, allow_requester: false });

    const own = await decide(fx, fx.adminId, requestId);
    expect(own.status).toBe(403);
    expect(await own.json()).toMatchObject({ reason: 'own_request' });
    const detail = await asUser(env(), fx.adminId, `/w/${fx.workspaceId}/requests/${requestId}`);
    expect(await detail.json()).toMatchObject({ decision_summary: { approval_requirement: { pending_for_viewer: false } } });
    expect((await decide(fx, fx.memberId, requestId)).status).toBe(201);
  });

  it('set who carries out an action, how many people it takes, and whether the approver may too', async () => {
    const fx = await seedWorkspace();
    const requestId = await seedRequest(fx, 'invoice');
    const approved = await decide(fx, fx.adminId, requestId);
    const [, paymentId] = ((await approved.json()) as { effect_ids: string[] }).effect_ids;
    const press = (userId: string) => send(fx, userId, 'POST', `/effects/${paymentId}/execute`, {});

    // One Finance holder is enough now, but not the person who approved the invoice.
    await setRule(fx, 'payment', { admins: false, roles: ['finance'], approvals_required: 1, allow_requester: false });
    const approver = await press(fx.adminId);
    expect(approver.status).toBe(403);
    expect(await approver.json()).toMatchObject({ reason: 'same_person' });

    const outsider = await press(fx.memberId);
    expect(outsider.status).toBe(403);
    expect(await outsider.json()).toMatchObject({ reason: 'role_required' });

    await holds(fx, fx.memberId, ['finance']);
    const done = await press(fx.memberId);
    expect(done.status).toBe(200);
    expect(await done.json()).toMatchObject({ status: 'unavailable' });
  });

  it('count confirmations against the rule as it is now, not as it was when the effect was made', async () => {
    const fx = await seedWorkspace();
    const requestId = await seedRequest(fx, 'invoice');
    const approved = await decide(fx, fx.adminId, requestId);
    const [, paymentId] = ((await approved.json()) as { effect_ids: string[] }).effect_ids;
    await setRule(fx, 'payment', { admins: false, roles: ['finance'], approvals_required: 3, allow_requester: true });
    const first = await send(fx, fx.adminId, 'POST', `/effects/${paymentId}/execute`, {});
    expect(await first.json()).toMatchObject({ status: 'pending', confirmations: { required: 3, recorded: 1 } });
  });

  it('keep a routed role from being deleted', async () => {
    const fx = await seedWorkspace();
    const created = await send(fx, fx.adminId, 'POST', '/roles', { name: 'Treasury' });
    const role = (await created.json()) as { id: string };
    await setRule(fx, 'payment', { admins: false, roles: ['treasury'], approvals_required: 1, allow_requester: true });
    const refused = await send(fx, fx.adminId, 'DELETE', `/roles/${role.id}`);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ reason: 'role_routed' });
    await send(fx, fx.adminId, 'DELETE', '/approval-routes/payment');
    expect((await send(fx, fx.adminId, 'DELETE', `/roles/${role.id}`)).status).toBe(204);
  });
});

describe('roles on an invitation', () => {
  it('are checked when inviting and granted when the person joins', async () => {
    const fx = await seedWorkspace();
    const email = `invitee-${randomUUID().slice(0, 8)}@example.test`;
    const bad = await send(fx, fx.adminId, 'POST', '/invitations', { email, role: 'member', role_slugs: ['treasury'] });
    expect(bad.status).toBe(422);
    expect(await bad.json()).toMatchObject({ reason: 'unknown_role' });

    const invited = await send(fx, fx.adminId, 'POST', '/invitations', { email, role: 'member', role_slugs: ['finance', 'legal'] });
    expect(invited.status).toBe(201);
    expect(await invited.json()).toMatchObject({ role_slugs: ['finance', 'legal'] });

    const userId = randomUUID();
    await withClient('owner', (c) => c.query(
      `INSERT INTO users (id, email, email_verified, name) VALUES ($1, $2, true, 'Invitee')`, [userId, email]));
    const joined = await asTenant(fx, async (c) => {
      await mirrorMembership(c as never, { workspaceId: fx.workspaceId, userId, role: 'member', workosMembershipId: null, status: 'active', email });
      return (await c.query<{ reviewer_roles: string[] }>(`SELECT reviewer_roles FROM members WHERE user_id = $1`, [userId])).rows[0]!.reviewer_roles;
    });
    expect(joined.sort()).toEqual(['finance', 'legal']);
  });
});
