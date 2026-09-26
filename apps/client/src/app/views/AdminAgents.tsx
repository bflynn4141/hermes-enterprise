// Admin → Agents: every agent in the workspace, and one agent's role, skills
// and approval switches.
//
// An Admin governs what an agent may do but does not read another member's
// conversations. The directory the server sends carries no run content, and
// this view links to nothing that would show it: no sessions, traces or
// waiting actions for an agent the viewer cannot read.
import { useCallback, useEffect, useState } from 'react';
import { ADMIN, LIB, type AgentDirectory, type AgentDirectoryEntry, type EnterpriseSkillAssignment } from '@hermes/shared';
import { useAdapter, useAppState, useNav } from '../store-context.js';
import { Button, EmptyState, Skeleton } from '../ui/primitives.js';
import { AdminSettingsCard } from './AdminDetailLayout.js';
import { ApprovalSwitches } from './AgentPermissions.js';
import { SkillAssignmentEditor } from './Workspace.js';
import './admin-agents.css';

export const ADMIN_AGENTS_VIEW = 'All agents';

export function agentStatusLabel(agent: AgentDirectoryEntry): string {
  if (agent.status === 'started') return 'Active';
  if (agent.status === 'provisioning') return 'Setting up';
  return 'Not set up';
}

export function runtimeLabel(runtime: AgentDirectoryEntry['runtime']): string {
  const place = runtime.source === 'cloud_capacity' || runtime.source === 'cloud_provisioned'
    ? ['Hermes Cloud', runtime.label].filter(Boolean).join(' · ')
    : runtime.source === 'deployment' ? 'Deployment runtime' : 'No runtime yet';
  if (runtime.source === 'none' || runtime.state === 'connected') return place;
  return `${place} (${runtime.state === 'failed' ? 'needs attention' : runtime.state === 'setting_up' ? 'setting up' : 'not connected'})`;
}

export function roleLabel(agent: AgentDirectoryEntry): string {
  return agent.role ? agent.role.team.name : 'No role';
}

export function AdminAgents({ agentId }: { agentId: string | null }) {
  const state = useAppState();
  const adapter = useAdapter();
  const nav = useNav();
  const [directory, setDirectory] = useState<AgentDirectory | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = useCallback(() => {
    setError(null);
    return adapter.rest.adminAgents(state.workspace.id)
      .then(setDirectory)
      .catch(() => setError('Could not load the agents. Try again.'));
  }, [adapter, state.workspace.id]);
  useEffect(() => { void load(); }, [load]);

  if (error) return <div role="alert" className="admin-agents-error"><p>{error}</p><Button onClick={() => void load()}>Try again</Button></div>;
  if (!directory) return <Skeleton rows={4} label="Loading agents" />;
  const selected = agentId ? directory.items.find((agent) => agent.id === agentId) ?? null : null;
  if (agentId) {
    if (!selected) return <EmptyState icon="iris" title="Agent not found" action={<Button onClick={() => nav(ADMIN(ADMIN_AGENTS_VIEW))}>All agents</Button>} />;
    return <AgentGovernance key={selected.id} agent={selected} onChanged={() => void load()} />;
  }
  return <>
    <header className="admin-detail-heading"><div><h2>Agents</h2><p>Every agent in this workspace, who it works for, and what it may do. You can change an agent’s role, skills and approvals. Its conversations stay with the people it works for.</p></div></header>
    {directory.items.length === 0
      ? <EmptyState icon="iris" title="No agents yet" detail="An agent appears here when someone joins and finishes setup." />
      : <ul className="admin-agents-list" aria-label="Agents">
        {directory.items.map((agent) => <li key={agent.id}>
          <button type="button" className="admin-agents-row" onClick={() => nav({ ...ADMIN(ADMIN_AGENTS_VIEW), id: agent.id })}>
            <span className="admin-agents-row-main">
              <span className="admin-agents-name">{agent.name}</span>
              <span className="admin-agents-facts">
                {[
                  agent.owner ? agent.owner.name : 'No owner',
                  roleLabel(agent),
                  agent.skills.length ? agent.skills.map((skill) => skill.state === 'paused' ? `${skill.name} (paused)` : skill.name).join(', ') : 'No skills',
                  runtimeLabel(agent.runtime),
                ].join(' · ')}
              </span>
            </span>
            <span className="admin-agents-status">{agentStatusLabel(agent)}</span>
          </button>
        </li>)}
      </ul>}
  </>;
}

function AgentGovernance({ agent, onChanged }: { agent: AgentDirectoryEntry; onChanged: () => void }) {
  const state = useAppState();
  const adapter = useAdapter();
  const nav = useNav();
  const [assignments, setAssignments] = useState<EnterpriseSkillAssignment[] | null>(null);
  const [configuring, setConfiguring] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reauth, setReauth] = useState(false);
  const owner = agent.owner?.name ?? 'the person it works for';
  useEffect(() => {
    let live = true;
    void adapter.rest.listSkillAssignments(state.workspace.id, agent.id)
      .then((page) => { if (live) setAssignments(page.items); })
      .catch(() => { if (live) setNotice('Could not load this agent’s skills.'); });
    return () => { live = false; };
  }, [adapter, state.workspace.id, agent.id]);
  const stepUp = () => {
    const url = adapter.auth.stepUpUrl(window.location.href, 'agent_governance');
    if (url) window.location.assign(url);
  };
  return <>
    <div><Button link onClick={() => nav(ADMIN(ADMIN_AGENTS_VIEW))}>← All agents</Button></div>
    <header className="admin-detail-heading"><div>
      <h2>{agent.name}</h2>
      <p>{agent.responsibility ?? 'No responsibility written yet.'}</p>
      {!agent.viewer.can_view_conversations && <p>You can change what {agent.name} may do. Its conversations and waiting actions stay with {owner}.</p>}
    </div></header>
    {notice && <p className="admin-agents-notice" role="status">{notice} {reauth && <Button link onClick={stepUp}>Sign in again</Button>}</p>}
    <AdminSettingsCard title="Role" footer={<><p>Roles are set for Partnerships and Finance together.</p><Button onClick={() => nav(LIB('handoffs'))}>Change roles</Button></>}>
      <div className="kv"><span className="grow">Works for</span><span className="meta">{agent.owner?.name ?? 'No owner'}</span></div>
      <div className="kv"><span className="grow">Role</span><span className="meta">{agent.role ? `${agent.role.team.name}, for ${agent.role.principal.name}` : 'No role'}</span></div>
      <div className="kv"><span className="grow">Visibility</span><span className="meta">{agent.context_scope === 'workspace' ? 'Shared with the workspace' : `Private to ${owner}`}</span></div>
      <div className="kv"><span className="grow">Status</span><span className="meta">{agentStatusLabel(agent)}</span></div>
      <div className="kv"><span className="grow">Runs on</span><span className="meta">{runtimeLabel(agent.runtime)}</span></div>
    </AdminSettingsCard>
    <AdminSettingsCard title="Skills" description={`What ${agent.name} is assigned to do. Pausing a skill removes its tools from new runs.`}>
      {!assignments && !notice && <Skeleton rows={2} label="Loading skills" />}
      {assignments?.length === 0 && <p>No skills assigned.</p>}
      {assignments?.map((assignment) => <div key={assignment.id} className="admin-agents-skill">
        <div className="admin-agents-skill-row">
          <div><span className="admin-agents-name">{assignment.name}</span><p className="meta">{[assignment.team?.name, assignment.version, assignment.state === 'active' ? 'Active' : 'Paused'].filter(Boolean).join(' · ')}</p></div>
          <Button aria-expanded={configuring === assignment.id} onClick={() => setConfiguring(configuring === assignment.id ? null : assignment.id)}>{configuring === assignment.id ? 'Close' : 'Configure'}</Button>
        </div>
        {configuring === assignment.id && <SkillAssignmentEditor key={`${assignment.id}:${assignment.revision}`} assignment={assignment} onCancel={() => setConfiguring(null)} onSave={async (patch) => {
          setNotice(null); setReauth(false);
          try {
            const next = await adapter.rest.updateSkillAssignment(state.workspace.id, agent.id, assignment.id, patch);
            setAssignments((rows) => rows?.map((row) => row.id === next.id ? next : row) ?? rows);
            setConfiguring(null);
            setNotice('Skill saved.');
            onChanged();
          } catch (caught) {
            if ((caught as { reason?: string }).reason === 'reauth_required') {
              setReauth(true);
              setNotice('Changing another person’s agent needs a recent sign-in. Your draft is kept.');
            }
            throw caught;
          }
        }} />}
      </div>)}
    </AdminSettingsCard>
    <AdminSettingsCard title="Human approval" description={`Choose when ${agent.name} asks a person before taking an action.`}>
      <ApprovalSwitches workspaceId={state.workspace.id} agentId={agent.id} agentName={agent.name} />
    </AdminSettingsCard>
  </>;
}
