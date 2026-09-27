// Approval routing (migration 0073, decision C93): the rules an Admin edits,
// and each place that must obey them.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { ApprovalRoute } from '@hermes/shared';
import { mirrorMembership } from '../../src/routes/members.js';
import { asUser, makeEnv } from './harness.js';
import { seedWorkspace, setTenant, withClient, type Fixture } from './helpers.js';
import { ageSession, fetchReviewBinding, INBOX_HEADERS, invoicePayload, seedRequest } from './m4-fixtures.js';

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
    expect(items.find((route) => route.key === 'payment')?.rule).toEqual({ admins: false, roles: ['finance'], approvals_required: 2, allow_requester: true, one_from_each: false });
    expect(items.filter((route) => route.amount).map((route) => route.key)).toEqual(['invoice', 'payment']);
    expect(items.every((route) => route.threshold === null)).toBe(true);
    expect(items.find((route) => route.key === 'invoice')?.workflow_note).toMatch(/Finance person/);
  });

  it('are Admin-only, need a recent sign-in to change, and refuse rules nobody can meet', async () => {
    const fx = await seedWorkspace();
    expect((await asUser(env(), fx.memberId, `/w/${fx.workspaceId}/approval-routes`)).status).toBe(403);

    const nobody = await setRule(fx, 'payment', { admins: false, roles: [], approvals_required: 1, allow_requester: true });
    expect(await nobody.json()).toMatchObject({ reason: 'no_approver' });
    // A decision may take several people since C95.
    const twoDeciders = await setRule(fx, 'invoice', { admins: true, roles: [], approvals_required: 2, allow_requester: true });
    expect(twoDeciders.status).toBe(200);
    expect(await twoDeciders.json()).toMatchObject({ rule: { approvals_required: 2, one_from_each: false } });
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
    expect(await detail.json()).toMatchObject({
      decision_summary: { approval_requirement: { pending_for_viewer: false, current: [{ label: 'Admins or Legal, not you: your agent prepared this' }] } },
    });
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
    expect(await first.json()).toMatchObject({ status: 'pending', required_role: 'finance', confirmations: { required: 3, recorded: 1 } });
    // Hand payments to Legal: waiting payments now say so.
    await holds(fx, fx.memberId, ['legal']);
    await setRule(fx, 'payment', { admins: false, roles: ['legal'], approvals_required: 1, allow_requester: true });
    const list = await send(fx, fx.adminId, 'GET', `/requests/${requestId}/effects`);
    expect(((await list.json()) as { items: { id: string; required_role: string }[] }).items.find((item) => item.id === paymentId))
      .toMatchObject({ required_role: 'legal' });
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

const band = (rule: object, overMinor = 500_000, currency = 'USD') => ({ over_minor: overMinor, currency, rule });
const legalOnly = { admins: false, roles: ['legal'], approvals_required: 1, allow_requester: true, one_from_each: false };
const adminsOnly = { admins: true, roles: [], approvals_required: 1, allow_requester: true, one_from_each: false };

/** An invoice for `minor` in `currency`, one line, so the document still parses. */
const invoiceAt = (minor: number, currency = 'USD') => ({
  ...invoicePayload(`INV-${minor}-${currency}`),
  currency,
  total_minor: minor,
  lines: [{ id: 'l1', label: 'Workshop delivery', qty: 1, amount_minor: minor, source_ids: [] }],
});

async function decideAs(fx: Fixture, userId: string, requestId: string, decision: 'approve' | 'decline' = 'approve') {
  return asUser(env(), userId, `/w/${fx.workspaceId}/requests/${requestId}/decisions`, {
    method: 'POST',
    headers: INBOX_HEADERS,
    body: { decision, ...await fetchReviewBinding(env(), fx, requestId) },
  });
}

async function requirementFor(fx: Fixture, userId: string, requestId: string) {
  const response = await asUser(env(), userId, `/w/${fx.workspaceId}/requests/${requestId}`);
  return ((await response.json()) as { decision_summary: { approval_requirement: { pending_for_viewer: boolean; current: { label: string }[] } } })
    .decision_summary.approval_requirement;
}

describe('a different rule above an amount (C94)', () => {
  it('saves, reads and resets with the base rule, and only for work with an amount', async () => {
    const fx = await seedWorkspace();
    const saved = await setRule(fx, 'invoice', { ...adminsOnly, threshold: band({ admins: true, roles: ['finance'], approvals_required: 2, allow_requester: false, one_from_each: true }) });
    expect(saved.status).toBe(200);
    expect(await saved.json()).toMatchObject({
      amount: true,
      rule: adminsOnly,
      threshold: { over_minor: 500_000, currency: 'USD', rule: { admins: true, roles: ['finance'], approvals_required: 2, allow_requester: false, one_from_each: true } },
      is_default: false,
    });
    const listed = await asUser(env(), fx.adminId, `/w/${fx.workspaceId}/approval-routes`);
    expect(listed.headers.get('cache-control')).toBe('no-store');
    expect(((await listed.json()) as { items: ApprovalRoute[] }).items.find((route) => route.key === 'invoice')?.threshold?.over_minor).toBe(500_000);

    // Saving without a threshold removes the band and keeps the base rule.
    const without = await setRule(fx, 'invoice', { ...adminsOnly, approvals_required: 2 });
    expect(await without.json()).toMatchObject({ threshold: null, rule: { approvals_required: 2 } });
    const rows = await asTenant(fx, async (c) => (await c.query<{ band: string }>(
      `SELECT band FROM approval_route_rules WHERE route_key = 'invoice' ORDER BY band`)).rows.map((row) => row.band));
    expect(rows).toEqual(['base']);

    await setRule(fx, 'payment', { admins: false, roles: ['finance'], approvals_required: 2, allow_requester: true, threshold: band(adminsOnly) });
    const reset = await send(fx, fx.adminId, 'DELETE', '/approval-routes/payment');
    expect(await reset.json()).toMatchObject({ is_default: true, threshold: null, rule: { roles: ['finance'], approvals_required: 2 } });
    expect(await asTenant(fx, async (c) => (await c.query(`SELECT 1 FROM approval_route_rules WHERE route_key = 'payment'`)).rowCount)).toBe(0);
  });

  it('refuses a threshold on work with no amount, and one from each without two groups and two people', async () => {
    const fx = await seedWorkspace();
    const noAmount = await setRule(fx, 'application', { ...adminsOnly, threshold: band(adminsOnly) });
    expect(noAmount.status).toBe(422);
    expect(await noAmount.json()).toMatchObject({ reason: 'no_amount_for_route' });

    const oneGroup = await setRule(fx, 'payment', { admins: false, roles: ['finance'], approvals_required: 2, allow_requester: true, one_from_each: true });
    expect(await oneGroup.json()).toMatchObject({ reason: 'one_from_each_needs_groups' });
    const onePerson = await setRule(fx, 'invoice', { ...adminsOnly, threshold: band({ admins: true, roles: ['finance'], approvals_required: 1, allow_requester: true, one_from_each: true }) });
    expect(await onePerson.json()).toMatchObject({ reason: 'one_from_each_needs_groups' });
    const nobody = await setRule(fx, 'invoice', { ...adminsOnly, threshold: band({ ...adminsOnly, admins: false }) });
    expect(await nobody.json()).toMatchObject({ reason: 'no_approver' });
    const unknownInBand = await setRule(fx, 'invoice', { ...adminsOnly, threshold: band({ ...adminsOnly, roles: ['treasury'] }) });
    expect(await unknownInBand.json()).toMatchObject({ reason: 'unknown_role' });
    const zero = await setRule(fx, 'invoice', { ...adminsOnly, threshold: band(adminsOnly, 0) });
    expect(await zero.json()).toMatchObject({ reason: 'bad_rule' });
    expect(await asTenant(fx, async (c) => (await c.query(`SELECT 1 FROM approval_route_rules`)).rowCount)).toBe(0);

    // The database refuses the same shapes on its own.
    await expect(asTenant(fx, (c) => c.query(
      `INSERT INTO approval_route_rules (workspace_id, route_key, band, admins, approvals_required, allow_requester, over_minor, over_currency)
       VALUES ($1, 'signature', 'over', true, 1, true, 100, 'USD')`, [fx.workspaceId]))).rejects.toThrow(/approval_route_rules_band_amount/);
    await expect(asTenant(fx, (c) => c.query(
      `INSERT INTO approval_route_rules (workspace_id, route_key, admins, approvals_required, allow_requester, one_from_each)
       VALUES ($1, 'signature', true, 1, true, true)`, [fx.workspaceId]))).rejects.toThrow(/approval_route_rules_one_from_each_people/);
  });

  it('keeps a role named only above the amount from being deleted', async () => {
    const fx = await seedWorkspace();
    const created = await send(fx, fx.adminId, 'POST', '/roles', { name: 'Treasury' });
    const role = (await created.json()) as { id: string };
    await setRule(fx, 'payment', { admins: false, roles: ['finance'], approvals_required: 2, allow_requester: true, threshold: band({ ...adminsOnly, admins: false, roles: ['treasury'] }) });
    const refused = await send(fx, fx.adminId, 'DELETE', `/roles/${role.id}`);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({ reason: 'role_routed' });
    // The database guard holds even without the route's check.
    await expect(asTenant(fx, (c) => c.query(`DELETE FROM workspace_roles WHERE id = $1`, [role.id]))).rejects.toThrow(/approvals still route to role treasury/);
    await setRule(fx, 'payment', { admins: false, roles: ['finance'], approvals_required: 2, allow_requester: true, threshold: null });
    expect((await send(fx, fx.adminId, 'DELETE', `/roles/${role.id}`)).status).toBe(204);
  });

  it('sends an invoice over the amount to the band, one under it to the base rule, and another currency to the band', async () => {
    const fx = await seedWorkspace();
    await holds(fx, fx.memberId, ['legal']);
    await setRule(fx, 'invoice', { ...adminsOnly, threshold: band(legalOnly) });
    const large = await seedRequest(fx, 'invoice', { label: 'Invoice large', payload: invoiceAt(12_000_000) });
    const small = await seedRequest(fx, 'invoice', { label: 'Invoice small', payload: invoiceAt(90_000) });
    const exact = await seedRequest(fx, 'invoice', { label: 'Invoice exact', payload: invoiceAt(500_000) });
    const euros = await seedRequest(fx, 'invoice', { label: 'Invoice euros', payload: invoiceAt(90_000, 'EUR') });

    expect(await requirementFor(fx, fx.memberId, large)).toMatchObject({ pending_for_viewer: true, current: [{ label: 'Legal (over 5,000.00 USD)' }] });
    expect(await requirementFor(fx, fx.adminId, large)).toMatchObject({ pending_for_viewer: false });
    expect(await requirementFor(fx, fx.adminId, small)).toMatchObject({ pending_for_viewer: true, current: [{ label: 'Workspace Admin' }] });
    expect(await requirementFor(fx, fx.memberId, euros)).toMatchObject({ pending_for_viewer: true, current: [{ label: 'Legal (amounts not in USD)' }] });

    const adminOnLarge = await decideAs(fx, fx.adminId, large);
    expect(adminOnLarge.status).toBe(403);
    expect(await adminOnLarge.json()).toMatchObject({ reason: 'approver_required', error: 'this needs Legal (over 5,000.00 USD)' });
    expect((await decideAs(fx, fx.memberId, large)).status).toBe(201);

    const memberOnSmall = await decideAs(fx, fx.memberId, small);
    expect(memberOnSmall.status).toBe(403);
    expect(await memberOnSmall.json()).toMatchObject({ reason: 'admin_required' });
    expect((await decideAs(fx, fx.adminId, small)).status).toBe(201);
    // "Over" is strictly greater: exactly 5,000.00 is the base rule's.
    expect((await decideAs(fx, fx.adminId, exact)).status).toBe(201);

    expect((await decideAs(fx, fx.adminId, euros)).status).toBe(403);
    expect((await decideAs(fx, fx.memberId, euros)).status).toBe(201);
  });

  it('labels the requester rule of the band, and the Inbox counts follow the band', async () => {
    const fx = await seedWorkspace();
    await holds(fx, fx.memberId, ['legal']);
    await setRule(fx, 'invoice', { ...adminsOnly, threshold: band({ admins: true, roles: ['legal'], approvals_required: 1, allow_requester: false, one_from_each: false }) });
    const large = await seedRequest(fx, 'invoice', { label: 'Invoice large', payload: invoiceAt(12_000_000) });
    // Seeded requests come from the Admin's agent, and the band keeps the requester out.
    expect(await requirementFor(fx, fx.adminId, large)).toMatchObject({
      pending_for_viewer: false,
      current: [{ label: 'Admins or Legal (over 5,000.00 USD), not you: your agent prepared this' }],
    });
    const own = await decideAs(fx, fx.adminId, large);
    expect(await own.json()).toMatchObject({ reason: 'own_request' });
    const member = await asUser(env(), fx.memberId, `/w/${fx.workspaceId}/requests?status=pending`);
    const items = ((await member.json()) as { items: { id: string; decision_summary: { approval_requirement: { pending_for_viewer: boolean } } }[] }).items;
    expect(items.find((item) => item.id === large)?.decision_summary.approval_requirement.pending_for_viewer).toBe(true);
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
