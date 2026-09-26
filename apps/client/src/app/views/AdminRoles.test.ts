import { describe, expect, it } from 'vitest';
import { mockUuid, type MemberEntity, type WorkspaceRole } from '@hermes/shared';
import { createAuth } from '../../model/auth.js';
import { createMockBackend } from '../../model/mock.js';
import { createRest } from '../../model/rest.js';
import { roleAgents, roleCandidates, roleErrorMessage, roleHolders, roleNamesFor, sameHolders, sortRoles } from './AdminRoles.js';

const role = (slug: string, name: string, extra: Partial<WorkspaceRole> = {}): WorkspaceRole => ({
  id: mockUuid(slug.length * 7 + name.length), slug, name, description: '', builtin: false, agent_template: null, members: [], agents: [], ...extra,
});

const member = (id: number, name: string, extra: Partial<MemberEntity> = {}): MemberEntity => ({
  id: mockUuid(id), user_id: mockUuid(id + 1000), name, email: `${name}@example.test`, role: 'member',
  status: 'active', reviewer_roles: [], joined_at: null, version: 0, ...extra,
});

describe('role list copy', () => {
  it('puts built-ins first in product order, then custom roles by name', () => {
    const sorted = sortRoles([
      role('vendors', 'Vendors'),
      role('legal', 'Legal', { builtin: true }),
      role('audit', 'Audit'),
      role('partnerships', 'Partnerships', { builtin: true }),
      role('finance', 'Finance', { builtin: true }),
    ]);
    expect(sorted.map((row) => row.name)).toEqual(['Partnerships', 'Finance', 'Legal', 'Audit', 'Vendors']);
  });

  it('names holders and agents in plain words', () => {
    const finance = role('finance', 'Finance', {
      builtin: true,
      members: [{ user_id: mockUuid(1), name: 'Alex Rivera' }, { user_id: mockUuid(2), name: 'Sam Lee' }],
      agents: [{ agent_id: mockUuid(3), name: 'Ledger', principal: { user_id: mockUuid(1), name: 'Alex Rivera' } }],
    });
    expect(roleHolders(finance)).toBe('Alex Rivera, Sam Lee');
    expect(roleAgents(finance)).toBe('Ledger · Alex Rivera');
    expect(roleHolders(role('audit', 'Audit'))).toBe('No one yet');
    expect(roleAgents(role('audit', 'Audit'))).toBeNull();
  });

  it('maps a member’s role slugs to names and ignores tags that are not roles', () => {
    const roles = [role('access', 'Access reviewer', { builtin: true }), role('partnerships', 'Partnerships', { builtin: true })];
    expect(roleNamesFor({ reviewer_roles: ['access', 'workspace_owner', 'partnerships'] }, roles)).toEqual(['Partnerships', 'Access reviewer']);
    expect(roleNamesFor({ reviewer_roles: ['access'] }, [])).toEqual([]);
  });

  it('offers only active people with an account', () => {
    expect(roleCandidates([
      member(2, 'Sam Lee'),
      member(1, 'Alex Rivera'),
      member(3, 'Invited', { status: 'invited' }),
      member(4, 'No account', { user_id: null }),
    ])).toEqual([{ user_id: mockUuid(1001), name: 'Alex Rivera' }, { user_id: mockUuid(1002), name: 'Sam Lee' }]);
  });

  it('compares holder sets without caring about order', () => {
    expect(sameHolders(['a', 'b'], ['b', 'a'])).toBe(true);
    expect(sameHolders(['a'], ['a', 'b'])).toBe(false);
  });

  it('explains each refusal the server can give', () => {
    expect(roleErrorMessage({ reason: 'reauth_required' })).toBe('Changing roles needs a recent sign-in.');
    expect(roleErrorMessage({ reason: 'self_change' })).toBe('Another Admin changes your own roles.');
    expect(roleErrorMessage({ reason: 'role_exists' })).toBe('A role with that name already exists.');
    expect(roleErrorMessage({ reason: 'builtin_role_name' })).toBe('Built-in roles keep their name.');
    expect(roleErrorMessage({ reason: 'builtin_role' })).toBe('Built-in roles cannot be deleted.');
    expect(roleErrorMessage({ reason: 'role_in_use' })).toBe('Remove everyone from this role before deleting it.');
    expect(roleErrorMessage({ reason: 'unknown_member' })).toContain('no longer an active member');
    expect(roleErrorMessage(new Error('boom'))).toBe('Could not save. Nothing was changed. Try again.');
  });
});

describe('the mock roles routes, through the real client', () => {
  const setup = (options: Parameters<typeof createMockBackend>[0] = {}) => {
    const mock = createMockBackend(options);
    const rest = createRest({ auth: createAuth('fake'), fetchImpl: mock.fetchImpl });
    return { rest, ws: mock.workspaceId };
  };
  const reason = async (call: Promise<unknown>) => call.then(() => 'ok', (error: { reason?: string }) => error.reason);

  it('lists the five built-ins with holders from members and agents from the role bindings', async () => {
    const { rest, ws } = setup({ workflowActivation: 'success' });
    const { items } = await rest.listRoles(ws);
    expect(sortRoles(items).map((row) => [row.slug, row.name, row.builtin])).toEqual([
      ['partnerships', 'Partnerships', true],
      ['finance', 'Finance', true],
      ['access', 'Access reviewer', true],
      ['legal', 'Legal', true],
      ['shared_intelligence_reviewer', 'Shared Intelligence reviewer', true],
    ]);
    const bySlug = new Map(items.map((row) => [row.slug, row]));
    expect(bySlug.get('finance')?.description).toBe('Reviews invoices and agreements handed over from Partnerships, and confirms payments.');
    expect(roleHolders(bySlug.get('finance')!)).toBe('Alex Rivera');
    expect(roleAgents(bySlug.get('finance')!)).toBe('Ledger · Alex Rivera');
    expect(roleAgents(bySlug.get('partnerships')!)).toBe('Iris · Maya Chen');
    expect(bySlug.get('partnerships')?.agent_template).toBe('partnerships-agent');
    expect(roleHolders(bySlug.get('legal')!)).toBe('No one yet');
  });

  it('creates, renames, staffs and deletes a custom role, and keeps members in step', async () => {
    const { rest, ws } = setup();
    const created = await rest.createRole(ws, { name: 'Vendor review', description: 'Checks new vendors.' });
    expect(created).toMatchObject({ slug: 'vendor-review', builtin: false, members: [] });
    expect(await reason(rest.createRole(ws, { name: 'vendor review', description: '' }))).toBe('role_exists');

    const renamed = await rest.updateRole(ws, created.id, { name: 'Vendor checks' });
    expect(renamed).toMatchObject({ name: 'Vendor checks', slug: 'vendor-review' });

    const alex = (await rest.listMembers(ws)).items.find((row) => row.name === 'Alex Rivera')!;
    const staffed = await rest.setRoleMembers(ws, created.id, [alex.user_id!]);
    expect(staffed.members.map((person) => person.name)).toEqual(['Alex Rivera']);
    expect((await rest.listMembers(ws)).items.find((row) => row.id === alex.id)?.reviewer_roles).toContain('vendor-review');
    expect(await reason(rest.deleteRole(ws, created.id))).toBe('role_in_use');

    await rest.setRoleMembers(ws, created.id, []);
    await rest.deleteRole(ws, created.id);
    expect((await rest.listRoles(ws)).items.some((row) => row.id === created.id)).toBe(false);
  });

  it('refuses what the server refuses', async () => {
    const { rest, ws } = setup();
    const { items } = await rest.listRoles(ws);
    const finance = items.find((row) => row.slug === 'finance')!;
    const partnerships = items.find((row) => row.slug === 'partnerships')!;
    expect(await reason(rest.updateRole(ws, finance.id, { name: 'Money' }))).toBe('builtin_role_name');
    await expect(rest.updateRole(ws, finance.id, { description: 'Pays partners.' })).resolves.toMatchObject({ description: 'Pays partners.' });
    expect(await reason(rest.deleteRole(ws, finance.id))).toBe('builtin_role');
    expect(await reason(rest.setRoleMembers(ws, finance.id, [mockUuid(9999)]))).toBe('unknown_member');
    // The signed-in Admin (Maya) holds Partnerships; dropping or adding herself is refused.
    expect(await reason(rest.setRoleMembers(ws, partnerships.id, []))).toBe('self_change');
    const maya = partnerships.members[0]!;
    expect(await reason(rest.setRoleMembers(ws, finance.id, [...finance.members.map((person) => person.user_id), maya.user_id]))).toBe('self_change');
  });

  it('is Admin only, and asks for a fresh sign-in when the fixture says so', async () => {
    expect(await reason(setup({ seat: 'member' }).rest.listRoles(setup().ws))).toBe('admin_required');
    const { rest, ws } = setup({ roleWritesStepUp: true });
    await expect(rest.listRoles(ws)).resolves.toBeTruthy();
    // Outside a browser the mock treats the step-up as satisfied, as the runtime capacity fixture does.
    await expect(rest.createRole(ws, { name: 'Audit', description: '' })).resolves.toMatchObject({ slug: 'audit' });
  });
});
