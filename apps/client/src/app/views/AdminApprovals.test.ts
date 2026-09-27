import { describe, expect, it } from 'vitest';
import { APPROVAL_ROUTES, mockUuid, type ApprovalRoute, type WorkspaceRole } from '@hermes/shared';
import { createAuth } from '../../model/auth.js';
import { createMockBackend } from '../../model/mock.js';
import { RestError, createRest } from '../../model/rest.js';
import { authorisedRef } from '../../model/store.js';
import { roleErrorMessage } from './AdminRoles.js';
import {
  amountToMinor,
  approvalRefusalMessage,
  approvalRouteErrorMessage,
  approvalsForRole,
  canApproveLine,
  canRequireEachGroup,
  joinOr,
  minorToAmount,
  sameRouteRules,
  sameThreshold,
  settleRule,
  memberRolesErrorMessage,
  roleNameMap,
  ruleSummary,
  sameRule,
  splitRoutes,
  unheldRoles,
  unheldWarning,
} from './approval-routes.js';

const names = roleNameMap([
  { slug: 'finance', name: 'Finance' },
  { slug: 'legal', name: 'Legal' },
  { slug: 'access', name: 'Access reviewer' },
]);

const route = (key: ApprovalRoute['key'], rule: Partial<ApprovalRoute['rule']> = {}, threshold: ApprovalRoute['threshold'] = null): ApprovalRoute => {
  const definition = APPROVAL_ROUTES.find((row) => row.key === key)!;
  return {
    key, kind: definition.kind, label: definition.label, description: definition.description, workflow_note: definition.workflow_note,
    amount: definition.amount,
    rule: { ...definition.default, ...rule, roles: [...(rule.roles ?? definition.default.roles)] },
    threshold,
    is_default: Object.keys(rule).length === 0 && threshold === null, updated_at: null,
  };
};
const band = (rule: Partial<ApprovalRoute['rule']>, over_minor = 500_000, currency = 'USD') => ({
  over_minor, currency, rule: { admins: false, roles: [], approvals_required: 1, allow_requester: true, one_from_each: false, ...rule },
});

const defaults = APPROVAL_ROUTES.map((row) => route(row.key));

const role = (slug: string, name: string, holders: string[] = []): WorkspaceRole => ({
  id: mockUuid(slug.length * 11 + name.length), slug, name, description: '', builtin: false, agent_template: null,
  members: holders.map((holder, index) => ({ user_id: mockUuid(900 + index), name: holder })), agents: [],
});

describe('approval rule copy', () => {
  it('joins groups the way a person would say them', () => {
    expect(joinOr([])).toBe('');
    expect(joinOr(['Finance'])).toBe('Finance');
    expect(joinOr(['Admins', 'Finance'])).toBe('Admins or Finance');
    expect(joinOr(['Admins', 'Finance', 'Legal'])).toBe('Admins, Finance or Legal');
  });

  it('summarises each rule in one plain line', () => {
    expect(ruleSummary(route('payment'), names)).toBe('Finance · 2 different people');
    expect(ruleSummary(route('invoice', { roles: ['finance'] }), names)).toBe('Admins or Finance');
    expect(ruleSummary(route('application', { allow_requester: false }), names))
      .toBe('Admins · the person whose agent prepared it can’t approve it');
    expect(ruleSummary(route('signature', { admins: false, roles: ['legal'], approvals_required: 1, allow_requester: false }), names))
      .toBe('Legal · the person who approved the request can’t also do this');
    expect(ruleSummary(route('access_grant'), names)).toBe('Access reviewer');
    // A role the page cannot name still reads, by its slug.
    expect(ruleSummary(route('agreement', { admins: false, roles: ['vendors'], approvals_required: 1 }), names)).toBe('vendors');
    expect(ruleSummary(route('payment', { admins: false, roles: [] }), names)).toBe('Nobody');
    // Decisions may take several people (C95), and one from each group.
    expect(ruleSummary(route('invoice', { approvals_required: 2 }), names)).toBe('Admins · 2 different people');
    expect(ruleSummary(route('invoice', { roles: ['finance'], approvals_required: 2, one_from_each: true }), names)).toBe('Admins and Finance · one of each');
  });

  it('summarises a rule with a band above an amount (C94)', () => {
    expect(ruleSummary(route('invoice', {}, band({ admins: true, roles: ['finance'], approvals_required: 2, one_from_each: true })), names))
      .toBe('Admins · over 5,000.00 USD: Admins and Finance, one of each');
    expect(ruleSummary(route('payment', {}, band({ roles: ['legal'], allow_requester: false }, 1_000_050, 'EUR')), names))
      .toBe('Finance · 2 different people · over 10,000.50 EUR: Legal, the person who approved the request can’t also do this');
  });

  it('reads the amount an Admin types, and keeps one from each only where it can apply', () => {
    expect(amountToMinor('5000')).toBe(500_000);
    expect(amountToMinor(' 5000.5 ')).toBe(500_050);
    expect(amountToMinor('0')).toBeNull();
    expect(amountToMinor('5000.123')).toBeNull();
    expect(amountToMinor('-1')).toBeNull();
    expect(amountToMinor('')).toBeNull();
    expect(amountToMinor('10000001')).toBeNull();
    expect(minorToAmount(500_050)).toBe('5000.5');
    const rule = { admins: true, roles: ['finance'], approvals_required: 2, allow_requester: true, one_from_each: true };
    expect(canRequireEachGroup(rule)).toBe(true);
    expect(canRequireEachGroup({ ...rule, roles: [] })).toBe(false);
    expect(settleRule({ ...rule, approvals_required: 1 }).one_from_each).toBe(false);
    expect(settleRule(rule)).toBe(rule);
  });

  it('splits decisions from actions in catalog order', () => {
    const { decisions, actions } = splitRoutes(defaults);
    expect(decisions.map((row) => row.key)).toEqual(['application', 'invoice', 'agreement']);
    expect(actions.map((row) => row.key)).toEqual(['payment', 'access_grant', 'signature', 'email_send']);
  });

  it('answers "Can approve" with the shared approvalsFor', () => {
    expect(canApproveLine(defaults, { role: 'member', reviewer_roles: [] })).toBe('Can approve: Nothing yet');
    expect(canApproveLine(defaults, { role: 'member', reviewer_roles: ['finance'] })).toBe('Can approve: Pay an approved invoice');
    expect(canApproveLine(defaults, { role: 'admin', reviewer_roles: ['access'] })).toBe(
      'Can approve: Admit a partner applicant, Approve an invoice draft, Approve an agreement draft, Grant access to an admitted partner, Sign an approved agreement, Send an approved document',
    );
  });

  it('lists what each role approves, for Admin → Roles', () => {
    expect(approvalsForRole(defaults, 'finance')).toEqual(['Pay an approved invoice']);
    expect(approvalsForRole([route('invoice', {}, band({ roles: ['legal'] }))], 'legal')).toEqual(['Approve an invoice draft']);
    expect(canApproveLine([route('invoice', {}, band({ roles: ['legal'] }))], { role: 'member', reviewer_roles: ['legal'] })).toBe('Can approve: Approve an invoice draft');
    expect(approvalsForRole(defaults, 'legal')).toEqual([]);
    expect(approvalsForRole([route('invoice', { roles: ['finance'] }), route('payment')], 'finance')).toEqual(['Approve an invoice draft', 'Pay an approved invoice']);
  });

  it('warns about chosen roles nobody holds, without blocking', () => {
    const roles = [role('finance', 'Finance', ['Alex Rivera']), role('legal', 'Legal'), role('vendors', 'Vendors')];
    expect(unheldRoles({ roles: ['finance', 'legal'] }, roles)).toEqual(['Legal']);
    expect(unheldWarning('Legal')).toBe('Nobody holds Legal yet, so this will wait until someone does.');
  });

  it('compares rules and thresholds without caring about role order', () => {
    const rule = { admins: true, roles: ['finance', 'legal'], approvals_required: 1, allow_requester: true, one_from_each: false };
    expect(sameRule(rule, { ...rule, roles: ['legal', 'finance'] })).toBe(true);
    expect(sameRule(rule, { ...rule, allow_requester: false })).toBe(false);
    expect(sameRule(rule, { ...rule, roles: ['finance'] })).toBe(false);
    expect(sameRule({ ...rule, approvals_required: 2 }, { ...rule, approvals_required: 2, one_from_each: true })).toBe(false);
    const over = band({ roles: ['legal'] });
    expect(sameThreshold(null, null)).toBe(true);
    expect(sameThreshold(over, null)).toBe(false);
    expect(sameThreshold(over, { ...over, rule: { ...over.rule } })).toBe(true);
    expect(sameThreshold(over, { ...over, over_minor: 500_001 })).toBe(false);
    expect(sameThreshold(over, { ...over, currency: 'EUR' })).toBe(false);
    expect(sameRouteRules({ rule, threshold: over }, { rule, threshold: null })).toBe(false);
    expect(sameRouteRules({ rule, threshold: over }, { rule: { ...rule, roles: ['legal', 'finance'] }, threshold: over })).toBe(true);
  });

  it('explains every refusal the approval routes can give', () => {
    expect(approvalRouteErrorMessage({ reason: 'reauth_required' })).toBe('Changing who approves needs a recent sign-in.');
    expect(approvalRouteErrorMessage({ reason: 'no_approver' })).toBe('Choose at least one group who can approve.');
    expect(approvalRouteErrorMessage({ reason: 'no_amount_for_route' })).toBe('This approval has no amount, so it can’t use a different rule above one. Nothing was changed.');
    expect(approvalRouteErrorMessage({ reason: 'one_from_each_needs_groups' })).toBe('One from each group needs two or more groups and two or more people. Nothing was changed.');
    expect(approvalRouteErrorMessage({ reason: 'unknown_role' })).toContain('no longer exists');
    expect(approvalRouteErrorMessage({ reason: 'bad_rule' })).toBe('That rule is not valid. Nothing was changed. Try again.');
    expect(approvalRouteErrorMessage({ reason: 'unknown_route' })).toContain('no longer exists');
    expect(approvalRouteErrorMessage(new Error('boom'))).toBe('Could not save. Nothing was changed. Try again.');
    expect(memberRolesErrorMessage({ reason: 'self_change' })).toBe('Another Admin changes your own roles.');
    expect(memberRolesErrorMessage({ reason: 'too_many_roles' })).toBe('A person can hold at most 32 roles.');
    expect(memberRolesErrorMessage({ reason: 'unknown_role' })).toContain('no longer exists');
    expect(memberRolesErrorMessage({ reason: 'reauth_required' })).toBe('Changing roles needs a recent sign-in.');
    expect(roleErrorMessage({ reason: 'role_routed' })).toBe('Approvals still go to this role. Change them in Approvals first.');
  });

  it('turns Inbox refusals into plain sentences and leaves other errors to the caller', () => {
    expect(approvalRefusalMessage(new RestError(403, 'approver_required', 'this needs Finance'))).toBe('This needs Finance.');
    expect(approvalRefusalMessage(new RestError(403, 'role_required', 'this needs Admins or Finance'))).toBe('This needs Admins or Finance.');
    expect(approvalRefusalMessage(new RestError(403, 'role_required', 'executing this needs the finance role'))).toBe('Someone with a different role approves this.');
    expect(approvalRefusalMessage(new RestError(403, 'own_request', 'your agent prepared this, so someone else approves it'))).toBe('Your agent prepared this, so someone else approves it.');
    expect(approvalRefusalMessage(new RestError(403, 'same_person', 'you approved this request, so someone else carries it out'))).toBe('You approved this request, so someone else carries it out.');
    expect(approvalRefusalMessage(new RestError(409, 'already_decided', 'already decided'))).toBeNull();
  });

  it('sends an old Inbox rules link to Approvals', () => {
    expect(authorisedRef('admin', { section: 'admin', view: 'Inbox rules' })).toEqual({ section: 'admin', view: 'Approvals' });
    expect(authorisedRef('admin', { section: 'settings', view: 'Inbox rules' })).toEqual({ section: 'admin', view: 'Approvals' });
    expect(authorisedRef('member', { section: 'admin', view: 'Inbox rules' })).toEqual({ section: 'settings', view: 'Notifications' });
    expect(authorisedRef('admin', { section: 'admin', view: 'Approvals', id: 'payment' })).toEqual({ section: 'admin', view: 'Approvals', id: 'payment' });
  });
});

describe('the mock approval routes, through the real client', () => {
  const setup = (options: Parameters<typeof createMockBackend>[0] = {}) => {
    const mock = createMockBackend(options);
    const rest = createRest({ auth: createAuth('fake'), fetchImpl: mock.fetchImpl });
    return { rest, ws: mock.workspaceId };
  };
  const reason = async (call: Promise<unknown>) => call.then(() => 'ok', (error: { reason?: string }) => error.reason);

  it('lists all seven in catalog order at their defaults', async () => {
    const { rest, ws } = setup();
    const { items } = await rest.listApprovalRoutes(ws);
    expect(items.map((row) => row.key)).toEqual(['application', 'invoice', 'agreement', 'payment', 'access_grant', 'signature', 'email_send']);
    expect(items.every((row) => row.is_default && row.updated_at === null)).toBe(true);
    expect(items.find((row) => row.key === 'payment')?.rule).toEqual({ admins: false, roles: ['finance'], approvals_required: 2, allow_requester: true, one_from_each: false });
    expect(items.filter((row) => row.amount).map((row) => row.key)).toEqual(['invoice', 'payment']);
    expect(items.every((row) => row.threshold === null)).toBe(true);
  });

  it('saves and resets a band above an amount', async () => {
    const { rest, ws } = setup();
    const over = band({ admins: true, roles: ['finance'], approvals_required: 2, one_from_each: true }, 100_000);
    const saved = await rest.updateApprovalRoute(ws, 'invoice', { admins: true, roles: [], approvals_required: 1, allow_requester: true, threshold: over });
    expect(saved).toMatchObject({ is_default: false, threshold: over });
    const cleared = await rest.updateApprovalRoute(ws, 'invoice', { admins: true, roles: [], approvals_required: 2, allow_requester: true, threshold: null });
    expect(cleared).toMatchObject({ threshold: null, rule: { approvals_required: 2 } });
    expect(await rest.resetApprovalRoute(ws, 'invoice')).toMatchObject({ is_default: true, threshold: null });
  });

  it('saves a rule, then resets it to the default', async () => {
    const { rest, ws } = setup();
    const saved = await rest.updateApprovalRoute(ws, 'payment', { admins: false, roles: ['finance', 'finance'], approvals_required: 3, allow_requester: false });
    expect(saved).toMatchObject({ is_default: false, rule: { roles: ['finance'], approvals_required: 3, allow_requester: false } });
    expect(saved.updated_at).not.toBeNull();
    expect((await rest.listApprovalRoutes(ws)).items.find((row) => row.key === 'payment')?.is_default).toBe(false);
    const reset = await rest.resetApprovalRoute(ws, 'payment');
    expect(reset).toMatchObject({ is_default: true, updated_at: null, rule: { approvals_required: 2, allow_requester: true } });
  });

  it('refuses what the server refuses', async () => {
    const { rest, ws } = setup();
    const rule = { admins: true, roles: [], approvals_required: 1, allow_requester: true };
    expect(await reason(rest.updateApprovalRoute(ws, 'invoice', { ...rule, admins: false }))).toBe('no_approver');
    expect(await reason(rest.updateApprovalRoute(ws, 'invoice', { ...rule, approvals_required: 2 }))).toBe('ok');
    expect(await reason(rest.updateApprovalRoute(ws, 'application', { ...rule, threshold: band({ admins: true }) }))).toBe('no_amount_for_route');
    expect(await reason(rest.updateApprovalRoute(ws, 'invoice', { ...rule, approvals_required: 2, one_from_each: true }))).toBe('one_from_each_needs_groups');
    expect(await reason(rest.updateApprovalRoute(ws, 'invoice', { ...rule, threshold: band({}) }))).toBe('no_approver');
    expect(await reason(rest.updateApprovalRoute(ws, 'invoice', { ...rule, threshold: band({ roles: ['vendors'] }) }))).toBe('unknown_role');
    expect(await reason(rest.updateApprovalRoute(ws, 'invoice', { ...rule, threshold: band({ admins: true }, 0) }))).toBe('bad_rule');
    expect(await reason(rest.updateApprovalRoute(ws, 'invoice', { ...rule, roles: ['vendors'] }))).toBe('unknown_role');
    expect(await reason(rest.updateApprovalRoute(ws, 'invoice', { ...rule, approvals_required: 9 }))).toBe('bad_rule');
    expect(await reason(rest.updateApprovalRoute(ws, 'refund' as never, rule))).toBe('unknown_route');
    expect(await reason(rest.resetApprovalRoute(ws, 'refund' as never))).toBe('unknown_route');
    expect(await reason(setup({ seat: 'member' }).rest.listApprovalRoutes(ws))).toBe('admin_required');
  });

  it('keeps a routed role from being deleted, and strips a deleted role from pending invitations', async () => {
    const { rest, ws } = setup();
    const vendors = await rest.createRole(ws, { name: 'Vendors', description: '' });
    await rest.updateApprovalRoute(ws, 'signature', { admins: true, roles: ['vendors'], approvals_required: 1, allow_requester: true });
    expect(await reason(rest.deleteRole(ws, vendors.id))).toBe('role_routed');
    await rest.resetApprovalRoute(ws, 'signature');
    await rest.updateApprovalRoute(ws, 'payment', { admins: false, roles: ['finance'], approvals_required: 2, allow_requester: true, threshold: band({ roles: ['vendors'] }) });
    expect(await reason(rest.deleteRole(ws, vendors.id))).toBe('role_routed');
    await rest.resetApprovalRoute(ws, 'payment');

    const invited = await rest.invite(ws, { email: 'robin@example.com', role: 'member', role_slugs: ['vendors', 'finance'] });
    expect(invited.role_slugs).toEqual(['vendors', 'finance']);
    await rest.deleteRole(ws, vendors.id);
    const row = (await rest.listInvitations(ws)).items.find((item) => item.id === invited.id);
    expect(row?.role_slugs).toEqual(['finance']);
  });

  it('refuses unknown or too many roles on an invitation', async () => {
    const { rest, ws } = setup();
    expect(await reason(rest.invite(ws, { email: 'robin@example.com', role: 'member', role_slugs: ['vendors'] }))).toBe('unknown_role');
    const many = Array.from({ length: 33 }, (_, index) => `role-${index}`);
    expect(await reason(rest.invite(ws, { email: 'robin@example.com', role: 'member', role_slugs: many }))).toBe('too_many_roles');
  });

  it('sets a member’s roles, keeps their workspace role, and refuses your own row', async () => {
    const { rest, ws } = setup();
    const { items } = await rest.listMembers(ws);
    const alex = items.find((row) => row.name === 'Alex Rivera')!;
    const maya = items.find((row) => row.name === 'Maya Chen')!;
    const next = await rest.setMemberRoles(ws, alex.id, ['finance', 'legal']);
    expect(next).toMatchObject({ role: alex.role, reviewer_roles: ['finance', 'legal'] });
    const legal = (await rest.listRoles(ws)).items.find((row) => row.slug === 'legal')!;
    expect(legal.members.map((person) => person.name)).toEqual(['Alex Rivera']);
    expect(await reason(rest.setMemberRoles(ws, alex.id, ['vendors']))).toBe('unknown_role');
    expect(await reason(rest.setMemberRoles(ws, maya.id, []))).toBe('self_change');
  });

  it('asks for a fresh sign-in only in a browser when the fixture says so', async () => {
    const { rest, ws } = setup({ approvalWritesStepUp: true });
    // Outside a browser the mock treats the step-up as satisfied, as the roles fixture does.
    await expect(rest.resetApprovalRoute(ws, 'payment')).resolves.toMatchObject({ key: 'payment' });
  });
});
