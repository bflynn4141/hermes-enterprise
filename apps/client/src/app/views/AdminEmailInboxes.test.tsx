import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { mockUuid, type AgentDirectoryEntry, type WorkspaceRole } from '@hermes/shared';
import type { Adapter } from '../../model/adapter.js';
import { createStore, initialState } from '../../model/store.js';
import { StoreProvider } from '../store-context.js';
import { NewInbox, inboxAgentLabel, preferredInboxAgent } from './AdminEmailInboxes.js';

const brian = { member_id: mockUuid(1), user_id: mockUuid(2), name: 'Brian Flynn' };

function agent(id: number, name: string, role: { slug: string; name: string } | null, runtime: AgentDirectoryEntry['runtime']): AgentDirectoryEntry {
  return {
    id: mockUuid(id), name, responsibility: null, status: 'started', context_scope: 'private', owner: brian,
    role: role ? { team: role, role_template_key: `${role.slug}-agent`, principal: brian } : null,
    skills: [], runtime, model: null,
    approvals: { revision: 0, required: [] },
    viewer: { can_configure: true, can_view_conversations: true },
  };
}

// The staging demo workspace: two agents named Iris, both owned by Brian.
const partnershipsIris = agent(10, 'Iris', { slug: 'partnerships', name: 'Partnerships' }, { source: 'deployment', label: null, state: 'connected' });
const financeIris = agent(11, 'Iris', { slug: 'finance', name: 'Finance' }, { source: 'cloud_capacity', label: 'finance-pool-01', state: 'connected' });
const staging = [partnershipsIris, financeIris];

function role(slug: string, name: string): WorkspaceRole {
  return { id: mockUuid(slug.length + 100), slug, name, description: '', builtin: true, agent_template: null, members: [], agents: [] } as unknown as WorkspaceRole;
}

describe('inboxAgentLabel', () => {
  it('tells two same-named agents of one owner apart by their role', () => {
    expect(inboxAgentLabel(partnershipsIris, staging)).toBe('Iris · Brian Flynn · Partnerships');
    expect(inboxAgentLabel(financeIris, staging)).toBe('Iris · Brian Flynn · Finance');
  });

  it('adds where the agent runs only when name, owner and role still match', () => {
    const noRoleA = agent(12, 'Scout', null, { source: 'cloud_capacity', label: 'hermes-pool-03', state: 'connected' });
    const noRoleB = agent(13, 'Scout', null, { source: 'deployment', label: null, state: 'connected' });
    expect(inboxAgentLabel(noRoleA, [noRoleA, noRoleB])).toBe('Scout · Brian Flynn · hermes-pool-03');
    expect(inboxAgentLabel(noRoleB, [noRoleA, noRoleB])).toBe('Scout · Brian Flynn · Built in');
    expect(inboxAgentLabel(noRoleA, [noRoleA])).toBe('Scout · Brian Flynn');
  });
});

describe('preferredInboxAgent', () => {
  it('picks the agent holding the inbox role, else the first agent', () => {
    expect(preferredInboxAgent(staging, 'finance')?.id).toBe(financeIris.id);
    expect(preferredInboxAgent(staging, 'partnerships')?.id).toBe(partnershipsIris.id);
    expect(preferredInboxAgent([financeIris, partnershipsIris], 'legal')?.id).toBe(financeIris.id);
    expect(preferredInboxAgent([], 'finance')).toBeUndefined();
  });
});

describe('NewInbox', () => {
  it('lists both Iris agents distinctly and preselects the Partnerships one for a Partnerships inbox', () => {
    // Finance first, so the preselection cannot come from list order.
    const html = renderToStaticMarkup(
      <StoreProvider store={createStore(initialState())} adapter={{} as Adapter}>
        <NewInbox roles={[role('partnerships', 'Partnerships'), role('finance', 'Finance')]} agents={[financeIris, partnershipsIris]} onCreated={() => undefined} onClose={() => undefined} />
      </StoreProvider>,
    );
    expect(html).toContain(`<option value="${financeIris.id}">Iris · Brian Flynn · Finance</option>`);
    expect(html).toContain(`<option value="${partnershipsIris.id}" selected="">Iris · Brian Flynn · Partnerships</option>`);
  });
});
