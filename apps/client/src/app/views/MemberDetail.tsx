// Member administration keeps workspace access, business responsibilities and
// custody separate. All writes use the existing guarded member routes; values
// change only after the server confirms them.
import { useCallback, useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import { ADMIN, HISTORY, MEMBERS, approvalsFor, type AgentDirectoryEntry, type ApprovalRoute, type MemberEntity, type WorkspaceRole } from '@hermes/shared';
import { useAdapter, useAppState, useIsAdmin, useNav } from '../store-context.js';
import { Avatar, Button, Dialog, EmptyState, Popover, Skeleton, Tabs } from '../ui/primitives.js';
import { AdminSettingsCard } from './AdminDetailLayout.js';
import { sortRoles } from './AdminRoles.js';
import { manageErrorMessage, type ManageAction } from './MemberRoles.js';
import { ruleSummary, roleNameMap } from './approval-routes.js';
import { useStepUp } from './use-step-up.js';
import { MemberWalletAccess } from './MemberWalletAccess.js';
import './member-detail.css';

export const MEMBER_SECTIONS = [
  { id: 'overview', label: 'Overview' }, { id: 'roles', label: 'Roles & permissions' },
  { id: 'agents', label: 'Agents' }, { id: 'wallet', label: 'Wallet access' },
] as const;
export type MemberSection = typeof MEMBER_SECTIONS[number]['id'];
export const memberSection = (value: string | undefined): MemberSection => MEMBER_SECTIONS.find(tab => tab.id === value)?.id ?? 'overview';
export const sameRoles = (a: readonly string[], b: readonly string[]): boolean => a.length === b.length && a.every(role => b.includes(role));
export const memberStatus = (status: MemberEntity['status']): string => status === 'active' ? 'Active' : status === 'inactive' ? 'Removed' : status === 'invited' ? 'Invited' : 'Expired';

export function changedApprovals(routes: readonly ApprovalRoute[], before: Pick<MemberEntity, 'role' | 'reviewer_roles'>, after: Pick<MemberEntity, 'role' | 'reviewer_roles'>) {
  const old = approvalsFor(routes, before), next = approvalsFor(routes, after);
  return { added: next.filter(route => !old.some(item => item.key === route.key)), removed: old.filter(route => !next.some(item => item.key === route.key)) };
}

function keepFocus(event: KeyboardEvent<HTMLDivElement>) {
  if (event.key !== 'Tab') return;
  const items = [...event.currentTarget.querySelectorAll<HTMLElement>('input:not([disabled]),button:not([disabled]),a[href],[tabindex="0"]')];
  const first = items[0], last = items.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
}

export function MemberDetail({ id }: { id: string }) {
  const state = useAppState();
  // Switching user/workspace discards drafts and in-flight presentation state.
  return <MemberDetailContent key={`${state.workspace.id}:${state.user.id}:${id}`} id={id} />;
}

function MemberDetailContent({ id }: { id: string }) {
  const state = useAppState(), adapter = useAdapter(), nav = useNav(), admin = useIsAdmin();
  const selected = memberSection(state.ui.app.sub);
  const [person, setPerson] = useState<MemberEntity | null>(null);
  const [loading, setLoading] = useState(true), [loadError, setLoadError] = useState(false);
  const [roles, setRoles] = useState<WorkspaceRole[] | null>(null);
  const [routes, setRoutes] = useState<ApprovalRoute[] | null>(null);
  const [catalogError, setCatalogError] = useState(false);
  const [rolePicker, setRolePicker] = useState(false), [workspacePicker, setWorkspacePicker] = useState(false), [remove, setRemove] = useState(false);
  const [draft, setDraft] = useState<string[]>([]), [draftWorkspace, setDraftWorkspace] = useState<'admin' | 'member'>('member');
  const [search, setSearch] = useState(''), [busy, setBusy] = useState(false), [notice, setNotice] = useState<string | null>(null);
  const [problem, setProblem] = useState<{ action: ManageAction; error: unknown } | null>(null);
  const mounted = useRef(true), flight = useRef(false), anchor = useRef<HTMLButtonElement>(null);
  const { needsSignIn, signIn } = useStepUp('workspace_roles');
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const load = useCallback(async () => {
    setLoadError(false); setLoading(true);
    try { const list = await adapter.rest.listMembers(state.workspace.id); if (mounted.current) setPerson(list.items.find(member => member.id === id) ?? null); }
    catch { if (mounted.current) setLoadError(true); }
    finally { if (mounted.current) setLoading(false); }
  }, [adapter, state.workspace.id, id]);
  const loadCatalog = useCallback(async () => {
    if (!admin) return;
    setCatalogError(false);
    try {
      const [r, a] = await Promise.all([adapter.rest.listRoles(state.workspace.id), adapter.rest.listApprovalRoutes(state.workspace.id)]);
      if (mounted.current) { setRoles(r.items); setRoutes(a.items); }
    } catch { if (mounted.current) { setRoles(null); setRoutes(null); setCatalogError(true); } }
  }, [adapter, admin, state.workspace.id]);
  useEffect(() => { void load(); void loadCatalog(); }, [load, loadCatalog]);
  const go = (sub: MemberSection) => nav({ section: 'members', id, sub });
  const closeRoles = () => { if (!flight.current) { setRolePicker(false); setProblem(null); setSearch(''); } };
  const mutate = async (action: ManageAction, request: () => Promise<MemberEntity | void>) => {
    if (flight.current || !person) return;
    flight.current = true; setBusy(true); setProblem(null); setNotice(null);
    try {
      const result = await request();
      adapter.invalidateList('members'); adapter.invalidateList('history');
      if (!mounted.current) return;
      if (action === 'remove') { setPerson({ ...person, status: 'inactive', reviewer_roles: [] }); setRemove(false); go('overview'); }
      else if (result) setPerson(result);
      setRolePicker(false); setWorkspacePicker(false);
      setNotice(action === 'remove' ? 'Member removed' : 'Roles updated');
    } catch (error) { if (mounted.current) setProblem({ action, error }); }
    finally { flight.current = false; if (mounted.current) setBusy(false); }
  };
  if (loading && !person) return <div className="member-detail"><Skeleton rows={4} label="Loading member" /></div>;
  if (loadError) return <div className="member-detail" role="alert"><p>Member details could not be loaded.</p><Button onClick={() => void load()}>Try again</Button></div>;
  if (!person) return <EmptyState icon="people" title="Member not found" action={<Button onClick={() => nav(MEMBERS)}>All members</Button>} />;
  const self = person.user_id === state.user.id, active = person.status === 'active', canEdit = admin && active && !self;
  const assigned = roles ? sortRoles(roles).filter(role => person.reviewer_roles.includes(role.slug)) : [];
  const changes = routes ? changedApprovals(routes, person, { ...person, reviewer_roles: draft }) : null;
  const approvals = routes ? approvalsFor(routes, person).filter(route => route.key !== 'payment') : [];
  const problemNode = problem && <p className="action-error" role="alert">{manageErrorMessage(problem.action, problem.error)}{' '}{needsSignIn(problem.error) && <Button link onClick={signIn}>Sign in again</Button>}</p>;
  const workspaceControl = <Button disabled={!canEdit} onClick={() => { setDraftWorkspace(person.role === 'admin' ? 'admin' : 'member'); setProblem(null); setWorkspacePicker(true); }}>Change role</Button>;
  const catalogState = catalogError ? <div role="alert">Roles and permissions could not be loaded. <Button link onClick={() => void loadCatalog()}>Try again</Button></div> : <Skeleton rows={2} label="Loading roles and permissions" />;
  return <div className="scroll"><div className="member-detail">
    <Button link onClick={() => nav(MEMBERS)}>← Members</Button>
    <header className="member-detail-identity"><Avatar person={{ name: person.name }} size={44} /><div><h1>{person.name}</h1><p>{person.role === 'admin' ? 'Admin' : 'Member'} · {memberStatus(person.status)}{self ? ' · You' : ''}</p></div></header>
    <div className="member-detail-tabs"><Tabs tabs={MEMBER_SECTIONS} value={selected} onChange={value => go(memberSection(value))} label="Member sections" /></div>
    {notice && <p role="status" className="meta">{notice}</p>}
    {selected === 'overview' && <>
      <AdminSettingsCard title="Profile">
        <DetailRow label="Email">{person.email || 'Private'}</DetailRow>
        <DetailRow label="Status">{memberStatus(person.status)}</DetailRow>
        <DetailRow label="Joined">{person.joined_at ? new Date(person.joined_at).toLocaleDateString(undefined, { month: 'long', day: 'numeric', year: 'numeric' }) : 'Not joined'}</DetailRow>
      </AdminSettingsCard>
      <AdminSettingsCard title="Workspace access" footer={active && admin ? workspaceControl : undefined}>
        <DetailRow label="Workspace role">{person.role === 'admin' ? 'Admin' : 'Member'}</DetailRow>
        {!active && <p className="meta">Workspace access is revoked. Wallet permissions need separate verification.</p>}
        {self && admin && <p className="meta">Another Admin changes your own roles.</p>}
      </AdminSettingsCard>
      {!active && admin && <MemberWalletAccess member={person} compact />}
      <nav className="member-mobile-sections" aria-label="Member details">
        {MEMBER_SECTIONS.filter(tab => tab.id !== 'overview').map(tab => <button type="button" key={tab.id} onClick={() => go(tab.id)}><span>{tab.label}</span><span aria-hidden="true">→</span></button>)}
      </nav>
      {admin && <div className="member-detail-actions"><Button link onClick={() => nav(HISTORY('all'))}>View history</Button>{canEdit && <Button className="danger" onClick={() => { setProblem(null); setRemove(true); }}>Remove member</Button>}</div>}
    </>}
    {selected === 'roles' && (admin ? roles && routes ? <section aria-label="Roles and permissions">
      <div className="member-setting-row"><strong>Workspace role</strong><span className="member-setting-value"><span className="member-role-chip">{person.role === 'admin' ? 'Admin' : 'Member'}</span></span>{workspaceControl}</div>
      <div className="member-setting-row"><strong>Responsibilities</strong><div className="member-setting-value member-role-chips">{assigned.length ? assigned.map(role => <button type="button" className="member-role-chip" key={role.id} onClick={() => nav({ ...ADMIN('Roles'), id: role.id })}>{role.name}</button>) : <span className="meta">None assigned</span>}</div>
        <button type="button" className="btn" ref={anchor} disabled={!canEdit} onClick={() => { setDraft([...person.reviewer_roles]); setSearch(''); setProblem(null); setRolePicker(true); }}>Edit roles</button>
      </div>
      <div className="member-permissions-heading"><h2>Permissions</h2><Button link onClick={() => nav(ADMIN('Approvals'))}>Approval rules ↗</Button></div>
      {!active ? <EmptyState compact icon="people" title="Workspace access removed" /> : approvals.length ? approvals.map(route => <details className="member-permission" key={route.key}><summary><span>{route.label}</span><span className="meta">Eligible to review</span></summary><p className="meta">{ruleSummary(route, roleNameMap(roles))}{route.workflow_note ? ` · ${route.workflow_note}` : ''}</p></details>) : <EmptyState compact icon="settings" title="No approvals assigned by these roles" />}
      <div className="member-setting-row"><span className="grow">Payment access</span><Button link onClick={() => go('wallet')}>View wallet access →</Button></div>
      {self && <p className="meta member-self-note">Another Admin changes your own roles.</p>}
      <Popover open={rolePicker} onClose={closeRoles} anchorRef={anchor} label="Edit roles" width={400} portal fitViewport className="member-role-picker">
        <div onKeyDown={keepFocus}>
          <div className="member-picker-heading"><h2>Edit roles</h2><label><span className="sr-only">Search roles</span><input type="search" placeholder="Search roles…" value={search} onChange={event => setSearch(event.target.value)} /></label></div>
          <fieldset className="member-picker-options"><legend className="sr-only">Responsibilities</legend>
            {sortRoles(roles).filter(role => role.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())).map(role => <label key={role.id}><input type="checkbox" disabled={busy} checked={draft.includes(role.slug)} onChange={event => setDraft(current => event.target.checked ? [...current, role.slug] : current.filter(slug => slug !== role.slug))} /><span>{role.name}</span></label>)}
            {!roles.some(role => role.name.toLocaleLowerCase().includes(search.toLocaleLowerCase())) && <EmptyState compact icon="people" title="No matching roles" />}
          </fieldset>
          {!sameRoles(draft, person.reviewer_roles) && <div className="member-picker-impact"><strong>After saving</strong>{changes && (changes.added.length || changes.removed.length) ? <>{changes.added.map(route => <p key={route.key}>{route.label} review added.</p>)}{changes.removed.map(route => <p key={route.key}>{route.label} review removed.</p>)}</> : <p>Responsibilities change; approval eligibility stays the same.</p>}<p>Payment permissions remain separate.</p></div>}
          {problemNode && <div className="member-picker-impact">{problemNode}</div>}
          <div className="member-picker-actions"><Button disabled={busy} onClick={closeRoles}>Cancel</Button><Button primary disabled={busy || sameRoles(draft, person.reviewer_roles)} onClick={() => void mutate('roles', () => adapter.rest.setMemberRoles(state.workspace.id, id, draft))}>{busy ? 'Saving…' : 'Save roles'}</Button></div>
        </div>
      </Popover>
    </section> : catalogState : <EmptyState icon="settings" title="An Admin manages roles and permissions" />)}
    {selected === 'agents' && <MemberAgents member={person} />}
    {selected === 'wallet' && <MemberWalletAccess member={person} />}
    <Dialog open={workspacePicker} title={`Change ${person.name}’s workspace role`} onClose={() => { if (!busy) { setWorkspacePicker(false); setProblem(null); } }} actions={<><Button disabled={busy} onClick={() => setWorkspacePicker(false)}>Cancel</Button><Button primary disabled={busy || draftWorkspace === person.role || !canEdit} onClick={() => void mutate('role', () => adapter.rest.setMemberRole(state.workspace.id, id, draftWorkspace))}>{busy ? 'Saving…' : 'Save role'}</Button></>}>
      <fieldset className="member-workspace-choices"><legend className="sr-only">Workspace role</legend>{(['member', 'admin'] as const).map(role => <label key={role}><input type="radio" name="workspace-role" value={role} checked={draftWorkspace === role} disabled={busy} onChange={() => setDraftWorkspace(role)} /><span><strong>{role === 'admin' ? 'Admin' : 'Member'}</strong><span>{role === 'admin' ? 'Manages members, keys and settings.' : 'Works with agents and reviews what their roles allow.'}</span></span></label>)}</fieldset>
      {draftWorkspace !== person.role && <p className="meta">Workspace approval rules will apply. Wallet ownership and payment access stay separate.</p>}{problemNode}
    </Dialog>
    <Dialog open={remove} title={`Remove ${person.name} from ${state.workspace.name}?`} onClose={() => { if (!busy) setRemove(false); }} actions={<><Button disabled={busy} onClick={() => setRemove(false)}>Keep member</Button><Button className="danger" disabled={busy || !canEdit} onClick={() => void mutate('remove', () => adapter.rest.removeMember(state.workspace.id, id))}>{busy ? 'Removing…' : 'Remove member'}</Button></>}>
      <p>They will lose access to this workspace.</p>
      <DetailRow label={`Links ${person.name.split(" ")[0]} shared`}>Their links are revoked</DetailRow><DetailRow label="Agent work">Runs are asked to stop; sessions become read-only</DetailRow><DetailRow label="Pending work">Returns for reassignment</DetailRow>
      <p className="meta">Wallet permissions need their own verified removal.</p>{problemNode}
    </Dialog>
  </div></div>;
}

export function DetailRow({ label, children }: { label: string; children: ReactNode }) { return <div className="member-detail-row"><span className="meta">{label}</span><span>{children}</span></div>; }

function MemberAgents({ member }: { member: MemberEntity }) {
  const state = useAppState(), adapter = useAdapter(), admin = useIsAdmin(), nav = useNav();
  const [agents, setAgents] = useState<AgentDirectoryEntry[] | null>(null), [error, setError] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!admin) return;
    let live = true; setError(false);
    void adapter.rest.adminAgents(state.workspace.id).then(result => { if (live) setAgents(result.items.filter(agent => agent.owner?.user_id === member.user_id)); }).catch(() => { if (live) setError(true); });
    return () => { live = false; };
  }, [adapter, admin, state.workspace.id, member.user_id, attempt]);
  if (!admin) return <EmptyState icon="settings" title="An Admin manages agent access" />;
  if (error) return <div role="alert">Agents could not be loaded. <Button link onClick={() => setAttempt(value => value + 1)}>Try again</Button></div>;
  if (!agents) return <Skeleton rows={3} label="Loading member agents" />;
  if (!agents.length) return <EmptyState icon="iris" title="No agents assigned" />;
  return <>{agents.map(agent => <AdminSettingsCard key={agent.id} title={agent.name} footer={<Button onClick={() => nav({ ...ADMIN('All agents'), id: agent.id })}>Manage agent settings</Button>}>
    <DetailRow label="Works for">{member.name}</DetailRow><DetailRow label="Role">{agent.role?.team.name ?? 'None assigned'}</DetailRow><DetailRow label="Visibility">{agent.context_scope === 'private' ? `Private to ${member.name}` : 'Shared with workspace'}</DetailRow><DetailRow label="Status">{agent.status === 'started' ? 'Active' : agent.status === 'provisioning' ? 'Setting up' : 'Not set up'}</DetailRow>
    {!agent.viewer.can_view_conversations && <p className="meta">Conversations and waiting actions stay with {member.name}.</p>}
  </AdminSettingsCard>)}</>;
}
