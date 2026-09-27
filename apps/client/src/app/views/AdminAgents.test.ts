import { describe, expect, it } from 'vitest';
import { mockUuid, type AgentDirectoryEntry, type EnterpriseSkillCatalogEntry, type MemberEntity } from '@hermes/shared';
import { agentNameProblem, agentStatusLabel, agentWriteMessage, assignableSkills, roleLabel, runtimeLabel } from './AdminAgents.js';
import { agentOptions, personOptions, setupProblem } from './PartnerWorkflow.js';

const ledger: AgentDirectoryEntry = {
  id: mockUuid(103), name: 'Ledger', responsibility: 'Finance review', status: 'started', context_scope: 'private',
  owner: { member_id: mockUuid(201), user_id: mockUuid(101), name: 'Alex Rivera' },
  role: { team: { slug: 'finance', name: 'Finance' }, role_template_key: 'finance-agent', principal: { member_id: mockUuid(201), user_id: mockUuid(101), name: 'Alex Rivera' } },
  skills: [], runtime: { source: 'cloud_capacity', label: 'hermes-pool-04', state: 'connected' },
  model: { id: 'nous:anthropic/claude-sonnet-5', label: 'Anthropic: Claude Sonnet 5', source: 'workspace_default' },
  approvals: { revision: 0, required: [] }, viewer: { can_configure: true, can_view_conversations: false },
};

describe('Admin agent directory copy', () => {
  it('says where an agent runs without technical detail', () => {
    expect(runtimeLabel(ledger.runtime)).toBe('Hermes Cloud · hermes-pool-04');
    expect(runtimeLabel({ source: 'cloud_provisioned', label: 'iris-dana', state: 'setting_up' })).toBe('Hermes Cloud · iris-dana (setting up)');
    expect(runtimeLabel({ source: 'cloud_capacity', label: 'hermes-pool-05', state: 'failed' })).toBe('Hermes Cloud · hermes-pool-05 (needs attention)');
    expect(runtimeLabel({ source: 'deployment', label: null, state: 'connected' })).toBe('This deployment');
    expect(runtimeLabel({ source: 'none', label: null, state: 'not_connected' })).toBe('Not set up yet');
  });

  it('names status and role in plain words', () => {
    expect(agentStatusLabel(ledger)).toBe('Active');
    expect(agentStatusLabel({ ...ledger, status: 'draft' })).toBe('Not set up');
    expect(roleLabel(ledger)).toBe('Finance');
    expect(roleLabel({ ...ledger, role: null })).toBe('No role');
  });
});

describe('configuring an agent', () => {
  it('asks for a name of 1 to 80 characters', () => {
    expect(agentNameProblem('Ledger')).toBeNull();
    expect(agentNameProblem('   ')).toBe('An agent needs a name.');
    expect(agentNameProblem('x'.repeat(81))).toBe('Use 80 characters or fewer.');
  });

  it('turns each refusal into plain words, never the server’s sentence', () => {
    expect(agentWriteMessage({ reason: 'reauth_required' }, 'this agent’s model')).toBe('Changing this agent’s model needs a recent sign-in.');
    expect(agentWriteMessage({ reason: 'one_active_skill' }, 'x')).toBe('Pause or remove the current skill first.');
    expect(agentWriteMessage({ reason: 'unknown_model' }, 'x')).toBe('That model isn’t available for this agent. Nothing was changed.');
    const rebuild = agentWriteMessage({ reason: 'runtime_rebuild_required', message: 'see docs/HERMES-AGENT-RUNTIME.md' } as { reason: string }, 'x');
    expect(rebuild).toMatch(/set up again/);
    expect(rebuild).not.toMatch(/docs\/|runtime/i);
    expect(agentWriteMessage({ reason: 'something_new' }, 'x')).toBe('Could not save. Nothing was changed. Try again.');
    expect(agentWriteMessage(null, 'x')).toBe('Could not save. Nothing was changed. Try again.');
  });

  it('offers only the agent’s role’s skills that it does not already have', () => {
    const entry = (key: string, template: string): EnterpriseSkillCatalogEntry => ({
      key, name: key, description: '', version: '1.0.0', digest: `sha256:${'0'.repeat(64)}`, tools: [], template,
    });
    const catalog = [entry('partner-program-screening', 'partnerships-agent'), entry('partner-invoice-review', 'finance-agent')];
    expect(assignableSkills(catalog, ledger, []).map((row) => row.key)).toEqual(['partner-invoice-review']);
    expect(assignableSkills(catalog, ledger, [{ skill_key: 'partner-invoice-review' }])).toEqual([]);
    expect(assignableSkills(catalog, { role: null }, [])).toEqual([]);
  });
});

describe('role pickers', () => {
  const member = (id: number, name: string, extra: Partial<MemberEntity> = {}): MemberEntity => ({
    id: mockUuid(id), user_id: mockUuid(id + 1000), name, email: `${name}@example.test`, role: 'member',
    status: 'active', reviewer_roles: [], joined_at: null, version: 0, ...extra,
  });

  it('offers active people by name and never an invitee without an account', () => {
    expect(personOptions([
      member(1, 'Maya Chen'),
      member(2, 'Invited', { status: 'invited' }),
      member(3, 'Hidden', { user_id: null }),
    ])).toEqual([{ value: mockUuid(1001), label: 'Maya Chen' }]);
  });

  it('names each agent with the person it works for', () => {
    expect(agentOptions([ledger, { ...ledger, id: mockUuid(104), name: 'Iris', owner: null }])).toEqual([
      { value: mockUuid(103), label: 'Ledger · Alex Rivera' },
      { value: mockUuid(104), label: 'Iris' },
    ]);
  });

  it('asks for a different person and agent per team, as the server does', () => {
    const base = { partnershipsUser: 'a', partnershipsAgent: 'x', financeUser: 'b', financeAgent: 'y' };
    expect(setupProblem(base)).toBeNull();
    expect(setupProblem({ ...base, financeUser: 'a' })).toBe('Partnerships and Finance need different people.');
    expect(setupProblem({ ...base, financeAgent: 'x' })).toBe('Partnerships and Finance need different agents.');
    expect(setupProblem({ ...base, financeUser: '', financeAgent: '' })).toBeNull();
  });
});
