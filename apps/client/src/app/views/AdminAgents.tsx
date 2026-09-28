// Admin → Agents: every agent in the workspace, and one agent's name, role,
// model, skills and approval switches (decisions C91 and C96).
//
// An Admin governs what an agent may do but does not read another member's
// conversations. The directory the server sends carries no run content, and
// this view links to nothing that would show it: no sessions, traces or
// waiting actions for an agent the viewer cannot read. Every change here asks
// the server, which needs a recent sign-in for it.
import { useCallback, useEffect, useState } from 'react';
import { ADMIN, LIB, type AgentDirectory, type AgentDirectoryEntry, type EnterpriseSkillAssignment, type EnterpriseSkillCatalogEntry } from '@hermes/shared';
import { useAdapter, useAppState, useNav } from '../store-context.js';
import { catalogRows } from '../selectors.js';
import { Button, EmptyState, MenuItem, Skeleton } from '../ui/primitives.js';
import { AdminSettingsCard } from './AdminDetailLayout.js';
import { ApprovalSwitches } from './AgentPermissions.js';
import { SkillAssignmentEditor, providerName } from './Workspace.js';
import { needsSignIn, useStepUp } from './use-step-up.js';
import './admin-agents.css';
import './admin-roles.css';

export const ADMIN_AGENTS_VIEW = 'All agents';

export function agentStatusLabel(agent: AgentDirectoryEntry): string {
  if (agent.status === 'started') return 'Active';
  if (agent.status === 'provisioning') return 'Setting up';
  return 'Not set up';
}

export function runtimeLabel(runtime: AgentDirectoryEntry['runtime']): string {
  const place = runtime.source === 'cloud_capacity' || runtime.source === 'cloud_provisioned'
    ? ['Hermes Cloud', runtime.label].filter(Boolean).join(' · ')
    : runtime.source === 'deployment' ? 'This deployment' : 'Not set up yet';
  if (runtime.source === 'none' || runtime.state === 'connected') return place;
  return `${place} (${runtime.state === 'failed' ? 'needs attention' : runtime.state === 'setting_up' ? 'setting up' : 'not connected'})`;
}

export function roleLabel(agent: AgentDirectoryEntry): string {
  return agent.role ? agent.role.team.name : 'No role';
}

export const AGENT_NAME_MAX = 80;

/** A name the server will take: 1 to 80 characters once trimmed. */
export function agentNameProblem(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'An agent needs a name.';
  if (trimmed.length > AGENT_NAME_MAX) return `Use ${AGENT_NAME_MAX} characters or fewer.`;
  return null;
}

/**
 * What a refused agent change means, in the words an Admin would use.
 * `subject` finishes the step-up sentence: "Changing <subject> needs…".
 */
export function agentWriteMessage(error: unknown, subject: string): string {
  const refusal = error as { reason?: string } | null;
  switch (refusal?.reason) {
    case 'reauth_required': return `Changing ${subject} needs a recent sign-in.`;
    case 'bad_agent_update': return `Use a name of 1 to ${AGENT_NAME_MAX} characters. Nothing was changed.`;
    case 'unknown_model':
    case 'provider_not_allowed': return 'That model isn’t available for this agent. Nothing was changed.';
    case 'unknown_agent': return 'This agent no longer exists. Nothing was changed.';
    // The server's sentence names an operator runbook; the Admin gets the next step instead.
    case 'runtime_rebuild_required': return 'This agent has to be set up again before its skills can change. Ask the person who runs Hermes for your company. Nothing was changed.';
    case 'one_active_skill': return 'Pause or remove the current skill first.';
    case 'already_assigned': return 'This agent already has that skill.';
    case 'no_lane': return 'Give this agent a role before assigning a skill.';
    case 'skill_role_mismatch': return 'That skill belongs to another role.';
    default: return 'Could not save. Nothing was changed. Try again.';
  }
}

/** Catalog skills this agent could take: its role's, and not already assigned. */
export function assignableSkills(
  catalog: readonly EnterpriseSkillCatalogEntry[],
  agent: Pick<AgentDirectoryEntry, 'role'>,
  assignments: readonly Pick<EnterpriseSkillAssignment, 'skill_key'>[],
): EnterpriseSkillCatalogEntry[] {
  if (!agent.role) return [];
  return catalog.filter((entry) => entry.template === agent.role!.role_template_key
    && !assignments.some((assignment) => assignment.skill_key === entry.key));
}

/** A refusal, with a way to sign in again when that would fix it. */
function Problem({ error, subject }: { error: unknown; subject: string }) {
  const { signIn } = useStepUp('agent_governance');
  return <p className="admin-roles-problem" role="alert">
    {agentWriteMessage(error, subject)} {needsSignIn(error) && <Button link onClick={signIn}>Sign in again</Button>}
  </p>;
}

type SaveState = 'idle' | 'saving' | 'saved';

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
    return <AgentGovernance
      key={selected.id}
      agent={selected}
      onChanged={() => void load()}
      onUpdated={(entry) => setDirectory((current) => current && ({ ...current, items: current.items.map((item) => item.id === entry.id ? entry : item) }))}
    />;
  }
  return <>
    <header className="admin-detail-heading"><div><h2 className="sr-only">Agents</h2><p>Who each agent works for, and what it may do.</p></div></header>
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

function AgentGovernance({ agent, onChanged, onUpdated }: { agent: AgentDirectoryEntry; onChanged: () => void; onUpdated: (entry: AgentDirectoryEntry) => void }) {
  const state = useAppState();
  const nav = useNav();
  const owner = agent.owner?.name ?? 'the person it works for';
  return <>
    <div><Button link onClick={() => nav(ADMIN(ADMIN_AGENTS_VIEW))}>← All agents</Button></div>
    <header className="admin-detail-heading"><div>
      <h2>{agent.name}</h2>
      <p>{agent.responsibility ?? 'No responsibility written yet.'}</p>
      {!agent.viewer.can_view_conversations && <p>You can change what {agent.name} may do. Its conversations and waiting actions stay with {owner}.</p>}
    </div></header>
    <NameCard agent={agent} onUpdated={onUpdated} />
    <AdminSettingsCard title="Role" footer={<><p>Roles are set for Partnerships and Finance together.</p><Button onClick={() => nav(LIB('handoffs'))}>Change roles</Button></>}>
      <div className="kv"><span className="grow">Works for</span><span className="meta">{agent.owner?.name ?? 'No owner'}</span></div>
      <div className="kv"><span className="grow">Role</span><span className="meta">{agent.role ? `${agent.role.team.name}, for ${agent.role.principal.name}` : 'No role'}</span></div>
      <div className="kv"><span className="grow">Visibility</span><span className="meta">{agent.context_scope === 'workspace' ? 'Shared with the workspace' : `Private to ${owner}`}</span></div>
      <div className="kv"><span className="grow">Status</span><span className="meta">{agentStatusLabel(agent)}</span></div>
      <div className="kv"><span className="grow">Runs on</span><span className="meta">{runtimeLabel(agent.runtime)}</span></div>
    </AdminSettingsCard>
    <ModelCard agent={agent} onUpdated={onUpdated} />
    <SkillsCard agent={agent} onChanged={onChanged} />
    <AdminSettingsCard title="Human approval" description={`Choose when ${agent.name} asks a person before taking an action.`}>
      <ApprovalSwitches workspaceId={state.workspace.id} agentId={agent.id} agentName={agent.name} />
    </AdminSettingsCard>
  </>;
}

/** Status line for a save pair: the problem when there is one, else "Saved." once. */
function SaveStatus({ problem, state, changed, subject }: { problem: unknown; state: SaveState; changed: boolean; subject: string }) {
  if (problem !== null) return <Problem error={problem} subject={subject} />;
  return <p role="status">{state === 'saved' && !changed ? 'Saved.' : ''}</p>;
}

function NameCard({ agent, onUpdated }: { agent: AgentDirectoryEntry; onUpdated: (entry: AgentDirectoryEntry) => void }) {
  const state = useAppState();
  const adapter = useAdapter();
  const [name, setName] = useState(agent.name);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [problem, setProblem] = useState<unknown>(null);
  const changed = name.trim() !== agent.name;
  const invalid = agentNameProblem(name);
  const save = () => {
    setSaveState('saving');
    setProblem(null);
    void adapter.rest.patchAdminAgent(state.workspace.id, agent.id, { name: name.trim() })
      .then((entry) => { onUpdated(entry); setName(entry.name); setSaveState('saved'); })
      // The draft stays in the field so a sign-in or a retry does not lose it.
      .catch((error: unknown) => { setProblem(error); setSaveState('idle'); });
  };
  return <AdminSettingsCard
    title="Name"
    footer={<>
      {problem === null && changed && invalid
        ? <p className="admin-roles-problem" role="alert">{invalid}</p>
        : <SaveStatus problem={problem} state={saveState} changed={changed} subject="this agent’s name" />}
      <div className="admin-roles-actions"><Button primary disabled={!changed || invalid !== null || saveState === 'saving'} onClick={save}>{saveState === 'saving' ? 'Saving…' : 'Save'}</Button></div>
    </>}
  >
    <label className="kv"><span className="grow">Name</span><input className="admin-agents-input" maxLength={AGENT_NAME_MAX + 20} value={name} onChange={(event) => { setName(event.target.value); setSaveState('idle'); setProblem(null); }} /></label>
  </AdminSettingsCard>;
}

function ModelCard({ agent, onUpdated }: { agent: AgentDirectoryEntry; onUpdated: (entry: AgentDirectoryEntry) => void }) {
  const state = useAppState();
  const adapter = useAdapter();
  const rows = catalogRows(state).filter((row) => row.enabled);
  const defaultId = (state.settings as { default_model_id?: string }).default_model_id ?? null;
  const defaultLabel = catalogRows(state).find((row) => row.model_id === defaultId)?.label
    ?? (agent.model?.source === 'workspace_default' ? agent.model.label : 'none set');
  const saved = agent.model?.source === 'agent' ? agent.model.id : null;
  const [choice, setChoice] = useState<string | null>(saved);
  const [saveState, setSaveState] = useState<SaveState>('idle');
  const [problem, setProblem] = useState<unknown>(null);
  const changed = choice !== saved;
  // The agent's own model may not be one this list offers any more; keep it
  // visible so the radio group always shows what is saved.
  const options = saved && !rows.some((row) => row.model_id === saved) && agent.model
    ? [...rows, { model_id: saved, label: agent.model.label, provider: '', enabled: true }]
    : rows;
  const pick = (value: string | null) => { setChoice(value); setSaveState('idle'); setProblem(null); };
  const save = () => {
    setSaveState('saving');
    setProblem(null);
    void adapter.rest.patchAdminAgent(state.workspace.id, agent.id, { model_id: choice })
      .then((entry) => { onUpdated(entry); setSaveState('saved'); })
      .catch((error: unknown) => { setProblem(error); setSaveState('idle'); });
  };
  return <AdminSettingsCard
    title="Model"
    footer={<>
      <SaveStatus problem={problem} state={saveState} changed={changed} subject="this agent’s model" />
      <div className="admin-roles-actions"><Button primary disabled={!changed || saveState === 'saving'} onClick={save}>{saveState === 'saving' ? 'Saving…' : 'Save'}</Button></div>
    </>}
  >
    <div className="col" role="radiogroup" aria-label={`Model for ${agent.name}`} style={{ gap: 4 }}>
      <MenuItem role="radio" checked={choice === null} onClick={() => pick(null)}>{`Workspace default (${defaultLabel})`}</MenuItem>
      {options.map((row) => <MenuItem role="radio" key={row.model_id} checked={choice === row.model_id} sub={row.provider ? `From ${providerName(row.provider)}` : undefined} onClick={() => pick(row.model_id)}>{row.label}</MenuItem>)}
    </div>
    <p className="meta">New conversations start with this model. People can still change it in a conversation.</p>
  </AdminSettingsCard>;
}

function SkillsCard({ agent, onChanged }: { agent: AgentDirectoryEntry; onChanged: () => void }) {
  const state = useAppState();
  const adapter = useAdapter();
  const [assignments, setAssignments] = useState<EnterpriseSkillAssignment[] | null>(null);
  const [catalog, setCatalog] = useState<EnterpriseSkillCatalogEntry[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [configuring, setConfiguring] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);
  const [status, setStatus] = useState('');
  const [adding, setAdding] = useState('');
  useEffect(() => {
    let live = true;
    void adapter.rest.listSkillAssignments(state.workspace.id, agent.id)
      .then((page) => { if (live) setAssignments(page.items); })
      .catch(() => { if (live) setLoadError(true); });
    // The catalog is only what the Add control offers; without it the card still works.
    void adapter.rest.skillCatalog(state.workspace.id)
      .then((list) => { if (live) setCatalog(list.items); })
      .catch(() => undefined);
    return () => { live = false; };
  }, [adapter, state.workspace.id, agent.id]);
  const assignable = assignments ? assignableSkills(catalog, agent, assignments) : [];
  const selected = assignable.some((entry) => entry.key === adding) ? adding : assignable[0]?.key ?? '';
  const begin = () => { setBusy(true); setProblem(null); setStatus(''); };
  const remove = (assignment: EnterpriseSkillAssignment) => {
    begin();
    void adapter.rest.deleteSkillAssignment(state.workspace.id, agent.id, assignment.id)
      .then(() => {
        setAssignments((rows) => rows?.filter((row) => row.id !== assignment.id) ?? rows);
        setConfirming(null);
        setStatus('Skill removed.');
        onChanged();
      })
      .catch((error: unknown) => { setProblem(error); setConfirming(null); })
      .finally(() => setBusy(false));
  };
  const add = () => {
    if (!selected) return;
    begin();
    void adapter.rest.createSkillAssignment(state.workspace.id, agent.id, selected)
      .then((assignment) => {
        setAssignments((rows) => [...(rows ?? []).filter((row) => row.id !== assignment.id), assignment]);
        setAdding('');
        setStatus('Skill assigned.');
        onChanged();
      })
      .catch((error: unknown) => setProblem(error))
      .finally(() => setBusy(false));
  };
  return <AdminSettingsCard
    title="Skills"
    description={`What ${agent.name} is assigned to do. A paused skill is not used in new tasks.`}
    footer={problem !== null || status || assignable.length > 0 ? <>
      {problem !== null ? <Problem error={problem} subject="this agent’s skills" /> : <p role="status">{status}</p>}
      {assignable.length > 0 && <div className="admin-roles-actions"><Button disabled={busy} onClick={add}>{busy ? 'Saving…' : 'Add'}</Button></div>}
    </> : undefined}
  >
    {!assignments && !loadError && <Skeleton rows={2} label="Loading skills" />}
    {loadError && <p>Could not load this agent’s skills.</p>}
    {assignments?.length === 0 && <EmptyState compact icon="skill" title="No skills assigned" />}
    {assignments?.map((assignment) => <div key={assignment.id} className="admin-agents-skill">
      <div className="admin-agents-skill-row">
        <div><span className="admin-agents-name">{assignment.name}</span><p className="meta">{[assignment.team?.name, assignment.state === 'active' ? 'Active' : 'Paused'].filter(Boolean).join(' · ')}</p></div>
        {confirming === assignment.id
          ? <div className="admin-roles-actions">
            <span className="meta admin-agents-confirm">Remove {assignment.name}?</span>
            <Button disabled={busy} onClick={() => setConfirming(null)}>Keep</Button>
            <Button primary disabled={busy} onClick={() => remove(assignment)}>{busy ? 'Removing…' : 'Remove'}</Button>
          </div>
          : <div className="admin-roles-actions">
            <Button aria-expanded={configuring === assignment.id} onClick={() => setConfiguring(configuring === assignment.id ? null : assignment.id)}>{configuring === assignment.id ? 'Close' : 'Configure'}</Button>
            <Button disabled={busy} onClick={() => { setProblem(null); setStatus(''); setConfirming(assignment.id); }}>Remove</Button>
          </div>}
      </div>
      {configuring === assignment.id && <SkillAssignmentEditor key={`${assignment.id}:${assignment.revision}`} assignment={assignment} onCancel={() => setConfiguring(null)} onSave={async (patch) => {
        setProblem(null); setStatus('');
        try {
          const next = await adapter.rest.updateSkillAssignment(state.workspace.id, agent.id, assignment.id, patch);
          setAssignments((rows) => rows?.map((row) => row.id === next.id ? next : row) ?? rows);
          setConfiguring(null);
          setStatus('Skill saved.');
          onChanged();
        } catch (caught) {
          if (needsSignIn(caught)) setProblem(caught);
          throw caught;
        }
      }} />}
    </div>)}
    {assignments?.length === 0 && !agent.role && <p>Skills come from a role. Give {agent.name} a role to assign one.</p>}
    {assignable.length > 0 && <label className="kv"><span className="grow">Assign a skill</span>
      <select className="admin-agents-input" disabled={busy} value={selected} onChange={(event) => { setAdding(event.target.value); setProblem(null); setStatus(''); }}>
        {assignable.map((entry) => <option key={entry.key} value={entry.key}>{entry.name}</option>)}
      </select>
    </label>}
  </AdminSettingsCard>;
}
