// Decisions that need more than one person (migration 0074, decision C95).
//
// An approval is first a confirmation. The decision is recorded, exactly as a
// single person's always was, by the press that completes the count; until
// then the answer is 202 and nothing is decided, planned or saved. A decline
// still closes the request at once. Each confirmation counts only while its
// person is an active member who still passes the rule.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decisionPendingSchema } from '@hermes/shared';
import { asUser, makeEnv, readTenant } from './harness.js';
import { seedWorkspace, setTenant, withClient, type Fixture } from './helpers.js';
import { fetchReviewBinding, INBOX_HEADERS, seedRequest } from './m4-fixtures.js';

const env = () => makeEnv({ RENDERS_QUEUE: { send: () => undefined } } as never).env;

async function asOwner(fx: Fixture, sql: string, values: unknown[]): Promise<void> {
  await withClient('owner', async (c) => {
    await c.query('BEGIN');
    await setTenant(c, fx.workspaceId, fx.adminId);
    await c.query(sql, values);
    await c.query('COMMIT');
  });
}

const holds = (fx: Fixture, userId: string, slugs: string[]) =>
  asOwner(fx, `UPDATE members SET reviewer_roles = $2 WHERE user_id = $1`, [userId, slugs]);

/** A third person in the workspace. */
async function addMember(fx: Fixture, role: 'admin' | 'member', slugs: string[], name = 'Sam Lee'): Promise<string> {
  const userId = randomUUID();
  await withClient('owner', (c) => c.query(
    `INSERT INTO users (id, email, email_verified, name) VALUES ($1, $2, true, $3)`,
    [userId, `third-${userId.slice(0, 8)}@example.test`, name]));
  await asOwner(fx, `INSERT INTO members (workspace_id, user_id, role, reviewer_roles) VALUES ($1, $2, $3, $4)`, [fx.workspaceId, userId, role, slugs]);
  return userId;
}

const setRule = (fx: Fixture, key: string, rule: object) =>
  asUser(env(), fx.adminId, `/w/${fx.workspaceId}/approval-routes/${key}`, { method: 'PUT', body: rule });

const rule = (overrides: object = {}) => ({ admins: true, roles: ['finance'], approvals_required: 2, allow_requester: true, one_from_each: false, ...overrides });

async function decide(fx: Fixture, userId: string, requestId: string, decision: 'approve' | 'decline' = 'approve') {
  return asUser(env(), userId, `/w/${fx.workspaceId}/requests/${requestId}/decisions`, {
    method: 'POST',
    headers: INBOX_HEADERS,
    body: { decision, ...await fetchReviewBinding(env(), fx, requestId) },
  });
}

async function requirement(fx: Fixture, userId: string, requestId: string) {
  const response = await asUser(env(), userId, `/w/${fx.workspaceId}/requests/${requestId}`);
  return ((await response.json()) as { decision_summary: { approval_requirement: Record<string, unknown> } }).decision_summary.approval_requirement;
}

async function state(fx: Fixture, requestId: string) {
  return readTenant(fx.workspaceId, fx.adminId, async (c) => ({
    status: (await c.query<{ status: string }>(`SELECT status FROM requests WHERE id = $1`, [requestId])).rows[0]?.status,
    decisions: (await c.query<{ decided_by: string; decision: string }>(`SELECT decided_by, decision FROM decisions WHERE request_id = $1`, [requestId])).rows,
    effects: (await c.query(`SELECT 1 FROM effects WHERE request_id = $1`, [requestId])).rowCount,
    documents: (await c.query(`SELECT 1 FROM documents WHERE request_id = $1`, [requestId])).rowCount,
    confirmations: (await c.query(`SELECT 1 FROM decision_confirmations WHERE request_id = $1`, [requestId])).rowCount,
  }));
}

describe('a decision that needs two people', () => {
  it('waits after the first approval, ignores a repeat, and is decided by the second eligible person', async () => {
    const fx = await seedWorkspace();
    await holds(fx, fx.memberId, ['finance']);
    expect((await setRule(fx, 'invoice', rule())).status).toBe(200);
    const invoice = await seedRequest(fx, 'invoice');

    const first = await decide(fx, fx.adminId, invoice);
    expect(first.status).toBe(202);
    expect(decisionPendingSchema.parse(await first.json())).toEqual({ status: 'pending', confirmations: { required: 2, recorded: 1, by_viewer: true } });
    expect(await state(fx, invoice)).toMatchObject({ status: 'pending', decisions: [], effects: 0, documents: 0, confirmations: 1 });
    // The request changed, so open Inboxes refresh it.
    const published = await readTenant(fx.workspaceId, fx.adminId, async (c) => (await c.query(
      `SELECT 1 FROM stream_events WHERE kind = 'entity.updated' AND payload->>'entity_id' = $1`, [invoice])).rowCount);
    expect(published).toBe(1);

    expect(await requirement(fx, fx.adminId, invoice)).toMatchObject({
      pending_for_viewer: false, waiting_on_others: true, remaining_approvals: 1, viewer_approved: true,
      current: [{ label: 'Admins or Finance, 2 different people', approvals_recorded: 1, quorum: 2 }],
    });
    const forMember = await requirement(fx, fx.memberId, invoice);
    expect(forMember).toMatchObject({ pending_for_viewer: true, waiting_on_others: false });
    expect(forMember.viewer_approved).toBeUndefined();
    const bootstrap = async (userId: string) => ((await (await asUser(env(), userId, `/w/${fx.workspaceId}/bootstrap`)).json()) as { counts: { pending_for_me: number; pending_for_others: number } }).counts;
    expect(await bootstrap(fx.adminId)).toMatchObject({ pending_for_me: 0, pending_for_others: 1 });
    expect(await bootstrap(fx.memberId)).toMatchObject({ pending_for_me: 1, pending_for_others: 0 });

    const again = await decide(fx, fx.adminId, invoice);
    expect(again.status).toBe(202);
    expect(await again.json()).toEqual({ status: 'pending', confirmations: { required: 2, recorded: 1, by_viewer: true } });

    const second = await decide(fx, fx.memberId, invoice);
    expect(second.status).toBe(201);
    expect(await second.json()).toMatchObject({ resulting_status: 'created' });
    expect(await state(fx, invoice)).toMatchObject({ status: 'created', decisions: [{ decided_by: fx.memberId, decision: 'approve' }], effects: 2, documents: 1, confirmations: 2 });
    // After the decision, a later press returns the decision on file.
    expect((await decide(fx, fx.adminId, invoice)).status).toBe(200);
  });

  it('does not count the person whose agent prepared it when the rule keeps them out', async () => {
    const fx = await seedWorkspace();
    await holds(fx, fx.memberId, ['finance']);
    const third = await addMember(fx, 'member', ['finance']);
    await setRule(fx, 'application', rule());
    // Seeded requests come from the Admin's agent.
    const application = await seedRequest(fx, 'application');
    expect((await decide(fx, fx.adminId, application)).status).toBe(202);

    await setRule(fx, 'application', rule({ allow_requester: false }));
    expect(await requirement(fx, fx.memberId, application)).toMatchObject({ current: [{ approvals_recorded: 0, quorum: 2 }] });
    const member = await decide(fx, fx.memberId, application);
    expect(await member.json()).toMatchObject({ status: 'pending', confirmations: { recorded: 1 } });
    expect((await decide(fx, third, application)).status).toBe(201);
  });

  it('with one from each group, two Admins are not enough and an Admin plus Finance is', async () => {
    const fx = await seedWorkspace();
    await holds(fx, fx.adminId, []);
    await holds(fx, fx.memberId, ['finance']);
    const secondAdmin = await addMember(fx, 'admin', [], 'Rae Park');
    expect((await setRule(fx, 'application', rule({ one_from_each: true }))).status).toBe(200);
    const application = await seedRequest(fx, 'application');

    expect((await decide(fx, fx.adminId, application)).status).toBe(202);
    const both = await decide(fx, secondAdmin, application);
    expect(both.status).toBe(202);
    expect(await both.json()).toMatchObject({ confirmations: { required: 2, recorded: 2 } });
    expect(await requirement(fx, fx.memberId, application)).toMatchObject({
      pending_for_viewer: true, remaining_approvals: 1,
      current: [{ label: 'Admins and Finance, one of each', approvals_recorded: 2, quorum: 2 }],
    });
    expect(await state(fx, application)).toMatchObject({ status: 'pending', decisions: [] });

    expect((await decide(fx, fx.memberId, application)).status).toBe(201);
    expect(await state(fx, application)).toMatchObject({ status: 'admitted', effects: 1 });
  });

  it('closes on one person’s decline, including from someone who approved first', async () => {
    const fx = await seedWorkspace();
    await setRule(fx, 'agreement', rule());
    const agreement = await seedRequest(fx, 'agreement');
    expect((await decide(fx, fx.adminId, agreement)).status).toBe(202);
    const declined = await decide(fx, fx.adminId, agreement, 'decline');
    expect(declined.status).toBe(201);
    expect(await declined.json()).toMatchObject({ resulting_status: 'declined', effect_ids: [] });
    expect(await state(fx, agreement)).toMatchObject({ status: 'declined', decisions: [{ decided_by: fx.adminId, decision: 'decline' }], effects: 0, documents: 0 });
  });

  it('stops counting a confirmer who lost the role, or left', async () => {
    const fx = await seedWorkspace();
    await setRule(fx, 'invoice', rule({ admins: false }));
    await holds(fx, fx.memberId, ['finance']);
    const third = await addMember(fx, 'member', ['finance']);
    const invoice = await seedRequest(fx, 'invoice');

    // The Admin holds Finance and approves, then gives it up.
    expect((await decide(fx, fx.adminId, invoice)).status).toBe(202);
    await holds(fx, fx.adminId, ['access']);
    const member = await decide(fx, fx.memberId, invoice);
    expect(await member.json()).toMatchObject({ status: 'pending', confirmations: { recorded: 1 } });

    // The Member leaves: their approval goes with them.
    await asOwner(fx, `UPDATE members SET status = 'inactive' WHERE user_id = $1`, [fx.memberId]);
    const thirdPress = await decide(fx, third, invoice);
    expect(await thirdPress.json()).toMatchObject({ status: 'pending', confirmations: { recorded: 1 } });
    expect(await state(fx, invoice)).toMatchObject({ status: 'pending', confirmations: 3 });
  });

  it('keeps both approvers out of the payment when the payment rule keeps the approver out', async () => {
    const fx = await seedWorkspace();
    await holds(fx, fx.memberId, ['finance']);
    await setRule(fx, 'invoice', rule());
    await setRule(fx, 'payment', { admins: false, roles: ['finance'], approvals_required: 1, allow_requester: false });
    const invoice = await seedRequest(fx, 'invoice');
    await decide(fx, fx.adminId, invoice);
    const decided = await decide(fx, fx.memberId, invoice);
    const [, paymentId] = ((await decided.json()) as { effect_ids: string[] }).effect_ids;
    // The Admin approved first; the Member recorded the decision. Neither pays.
    for (const userId of [fx.adminId, fx.memberId]) {
      const press = await asUser(env(), userId, `/w/${fx.workspaceId}/effects/${paymentId}/execute`, { method: 'POST', body: {} });
      expect(await press.json()).toMatchObject({ reason: 'same_person' });
    }
  });
});
