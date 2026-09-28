// Admin → Roles: the jobs people hold in this workspace, and who holds them.
//
// Holding a role is what lets a person decide the matching approvals (the
// Finance role decides partner invoices), so membership is the one thing on
// this page that changes authority. Every write needs a recent sign-in, and an
// Admin cannot add or remove themself: another Admin changes their roles, the
// same rule as the member role switch.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ADMIN, BUILTIN_ROLE_SLUGS, LIB, type ApprovalRoute, type MemberEntity, type WorkspaceRole } from '@hermes/shared';
import { useAdapter, useAppState, useNav } from '../store-context.js';
import { Button, Dialog, EmptyState, Skeleton } from '../ui/primitives.js';
import { AdminSettingsCard } from './AdminDetailLayout.js';
import { useWorkspaceLists } from './lists.js';
import { approvalsForRole } from './approval-routes.js';
import { useStepUp } from './use-step-up.js';
import './admin-roles.css';

export const ADMIN_ROLES_VIEW = 'Roles';

export const SELF_CHANGE_MESSAGE = 'Another Admin changes your own roles.';

/** Built-ins in the order the product introduces them, then custom roles by name. */
export function sortRoles(roles: readonly WorkspaceRole[]): WorkspaceRole[] {
  const rank = (role: WorkspaceRole) => {
    const index = (BUILTIN_ROLE_SLUGS as readonly string[]).indexOf(role.slug);
    return role.builtin ? (index < 0 ? BUILTIN_ROLE_SLUGS.length : index) : BUILTIN_ROLE_SLUGS.length + 1;
  };
  return [...roles].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}

export function roleHolders(role: WorkspaceRole): string {
  return role.members.length ? role.members.map((person) => person.name).join(', ') : 'No one yet';
}

export function roleAgents(role: WorkspaceRole): string | null {
  return role.agents.length ? role.agents.map((agent) => `${agent.name} · ${agent.principal.name}`).join(', ') : null;
}

/** The names of the roles a member holds, in role order; unknown slugs are left out. */
export function roleNamesFor(member: Pick<MemberEntity, 'reviewer_roles'>, roles: readonly WorkspaceRole[]): string[] {
  return sortRoles(roles).filter((role) => member.reviewer_roles.includes(role.slug)).map((role) => role.name);
}

/** People who can hold a role: active members with an account. */
export function roleCandidates(members: readonly MemberEntity[]): { user_id: string; name: string }[] {
  return members
    .filter((member): member is MemberEntity & { user_id: string } => member.status === 'active' && member.user_id !== null)
    .map((member) => ({ user_id: member.user_id, name: member.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function sameHolders(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id) => b.includes(id));
}

/** What a refused role write means, in the words an Admin would use. */
export function roleErrorMessage(error: unknown): string {
  switch ((error as { reason?: string } | null)?.reason) {
    case 'reauth_required': return 'Changing roles needs a recent sign-in.';
    case 'self_change': return SELF_CHANGE_MESSAGE;
    case 'role_exists': return 'A role with that name already exists.';
    case 'builtin_role_name': return 'Built-in roles keep their name.';
    case 'builtin_role': return 'Built-in roles cannot be deleted.';
    case 'role_in_use': return 'Remove everyone from this role before deleting it.';
    case 'role_routed': return 'Approvals still go to this role. Change them in Approvals first.';
    case 'unknown_member': return 'Someone on the list is no longer an active member. Reload and try again.';
    case 'unknown_role': return 'This role no longer exists. Reload and try again.';
    case 'too_many_roles': return 'A person can hold at most 32 roles.';
    default: return 'Could not save. Nothing was changed. Try again.';
  }
}

/** A refusal with, when a fresh sign-in would fix it, the way to get one. */
function Problem({ error }: { error: unknown }) {
  const { needsSignIn, signIn } = useStepUp('workspace_roles');
  return <p className="admin-roles-problem" role="alert">
    {roleErrorMessage(error)} {needsSignIn(error) && <Button link onClick={signIn}>Sign in again</Button>}
  </p>;
}

export function AdminRoles({ roleId }: { roleId: string | null }) {
  const state = useAppState();
  const adapter = useAdapter();
  const nav = useNav();
  const [roles, setRoles] = useState<WorkspaceRole[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  // What each role approves, so roles and approvals read as one system. Only
  // a hint here: if the rules cannot load, the rows simply leave it out.
  const [routes, setRoutes] = useState<ApprovalRoute[]>([]);
  const load = useCallback(() => {
    setError(null);
    void adapter.rest.listApprovalRoutes(state.workspace.id).then((list) => setRoutes(list.items)).catch(() => setRoutes([]));
    return adapter.rest.listRoles(state.workspace.id)
      .then((list) => setRoles(list.items))
      .catch(() => setError('Could not load the roles. Try again.'));
  }, [adapter, state.workspace.id]);
  useEffect(() => { void load(); }, [load]);

  const replace = (next: WorkspaceRole) => setRoles((rows) => rows?.some((row) => row.id === next.id)
    ? rows.map((row) => row.id === next.id ? next : row)
    : [...(rows ?? []), next]);

  if (error) return <div role="alert" className="admin-roles-error"><p>{error}</p><Button onClick={() => void load()}>Try again</Button></div>;
  if (!roles) return <Skeleton rows={4} label="Loading roles" />;
  if (roleId) {
    const selected = roles.find((role) => role.id === roleId);
    if (!selected) return <EmptyState icon="people" title="Role not found" action={<Button onClick={() => nav(ADMIN(ADMIN_ROLES_VIEW))}>All roles</Button>} />;
    return <RoleDetail
      key={selected.id}
      role={selected}
      onSaved={replace}
      onDeleted={() => {
        setRoles((rows) => rows?.filter((row) => row.id !== selected.id) ?? rows);
        nav(ADMIN(ADMIN_ROLES_VIEW));
      }}
    />;
  }
  return <>
    <header className="admin-detail-heading">
      <div>
        <h2 className="sr-only">Roles</h2>
        <p>Who holds each job, and what they approve.</p>
      </div>
      <Button onClick={() => setCreating(true)}>New role</Button>
    </header>
    <ul className="admin-roles-list" aria-label="Roles">
      {sortRoles(roles).map((role) => {
        const agents = roleAgents(role);
        const approves = approvalsForRole(routes, role.slug);
        return <li key={role.id}>
          <button type="button" className="admin-roles-row" onClick={() => nav({ ...ADMIN(ADMIN_ROLES_VIEW), id: role.id })}>
            <span className="admin-roles-name">{role.name}</span>
            {role.description && <span className="admin-roles-description">{role.description}</span>}
            <span className="admin-roles-facts">
              <span><span className="admin-roles-fact-label">People</span> {roleHolders(role)}</span>
              {agents && <span><span className="admin-roles-fact-label">Agents</span> {agents}</span>}
              {approves.length > 0 && <span><span className="admin-roles-fact-label">Approves</span> {approves.join(', ')}</span>}
            </span>
          </button>
        </li>;
      })}
    </ul>
    <NewRoleDialog
      open={creating}
      onClose={() => setCreating(false)}
      onCreated={(role) => {
        replace(role);
        setCreating(false);
        nav({ ...ADMIN(ADMIN_ROLES_VIEW), id: role.id });
      }}
    />
  </>;
}

function NewRoleDialog({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: (role: WorkspaceRole) => void }) {
  const state = useAppState();
  const adapter = useAdapter();
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [saving, setSaving] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);
  const close = () => {
    if (saving) return;
    setProblem(null);
    onClose();
  };
  const create = () => {
    setSaving(true);
    setProblem(null);
    void adapter.rest.createRole(state.workspace.id, { name: name.trim(), description: description.trim() })
      .then((role) => {
        setName('');
        setDescription('');
        onCreated(role);
      })
      .catch(setProblem)
      .finally(() => setSaving(false));
  };
  return <Dialog
    open={open}
    title="New role"
    onClose={close}
    actions={<>
      <Button disabled={saving} onClick={close}>Cancel</Button>
      <Button primary disabled={saving || !name.trim()} onClick={create}>{saving ? 'Creating…' : 'Create role'}</Button>
    </>}
  >
    <label className="skill-config-field"><span>Name</span><input maxLength={80} value={name} onChange={(event) => setName(event.target.value)} /></label>
    <label className="skill-config-field"><span>Description</span><textarea className="admin-roles-textarea" maxLength={500} rows={3} value={description} onChange={(event) => setDescription(event.target.value)} /></label>
    {problem !== null && <Problem error={problem} />}
  </Dialog>;
}

function RoleDetail({ role, onSaved, onDeleted }: { role: WorkspaceRole; onSaved: (role: WorkspaceRole) => void; onDeleted: () => void }) {
  const state = useAppState();
  const adapter = useAdapter();
  const nav = useNav();
  const lists = useWorkspaceLists();
  const people = useMemo(() => roleCandidates(lists.members), [lists.members]);
  const held = useMemo(() => role.members.map((person) => person.user_id), [role.members]);

  const [name, setName] = useState(role.name);
  const [description, setDescription] = useState(role.description);
  const [detailsState, setDetailsState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [detailsProblem, setDetailsProblem] = useState<unknown>(null);

  const [holders, setHolders] = useState<string[]>(held);
  const [holdersState, setHoldersState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [holdersProblem, setHoldersProblem] = useState<unknown>(null);

  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteProblem, setDeleteProblem] = useState<unknown>(null);

  const detailsChanged = (!role.builtin && name.trim() !== role.name) || description.trim() !== role.description;
  const holdersChanged = !sameHolders(holders, held);

  const saveDetails = () => {
    setDetailsState('saving');
    setDetailsProblem(null);
    const patch = { ...(!role.builtin && name.trim() !== role.name ? { name: name.trim() } : {}), description: description.trim() };
    void adapter.rest.updateRole(state.workspace.id, role.id, patch)
      .then((next) => {
        onSaved(next);
        setName(next.name);
        setDescription(next.description);
        setDetailsState('saved');
      })
      .catch((error: unknown) => {
        setDetailsProblem(error);
        setDetailsState('idle');
      });
  };

  const saveHolders = () => {
    setHoldersState('saving');
    setHoldersProblem(null);
    void adapter.rest.setRoleMembers(state.workspace.id, role.id, holders)
      .then((next) => {
        onSaved(next);
        setHolders(next.members.map((person) => person.user_id));
        adapter.invalidateList('members');
        setHoldersState('saved');
      })
      .catch((error: unknown) => {
        setHoldersProblem(error);
        setHoldersState('idle');
      });
  };

  const remove = () => {
    setDeleting(true);
    setDeleteProblem(null);
    void adapter.rest.deleteRole(state.workspace.id, role.id)
      .then(onDeleted)
      .catch((error: unknown) => {
        setDeleteProblem(error);
        setDeleting(false);
      });
  };

  return <>
    <div><Button link onClick={() => nav(ADMIN(ADMIN_ROLES_VIEW))}>← Roles</Button></div>
    <header className="admin-detail-heading"><div>
      <h2>{role.name}</h2>
      {role.description && <p>{role.description}</p>}
      {role.builtin && <p>Every workspace starts with this role. Its name stays the same; its description can change.</p>}
    </div></header>

    <AdminSettingsCard
      title="Details"
      footer={<>
        {detailsProblem !== null ? <Problem error={detailsProblem} /> : <p role="status">{detailsState === 'saved' && !detailsChanged ? 'Saved.' : ''}</p>}
        <Button primary disabled={!detailsChanged || detailsState === 'saving' || (!role.builtin && !name.trim())} onClick={saveDetails}>{detailsState === 'saving' ? 'Saving…' : 'Save'}</Button>
      </>}
    >
      {!role.builtin && <label className="skill-config-field"><span>Name</span><input maxLength={80} value={name} onChange={(event) => { setName(event.target.value); setDetailsState('idle'); }} /></label>}
      <label className="skill-config-field"><span>Description</span><textarea className="admin-roles-textarea" maxLength={500} rows={3} value={description} onChange={(event) => { setDescription(event.target.value); setDetailsState('idle'); }} /></label>
    </AdminSettingsCard>

    <AdminSettingsCard
      title="People"
      description={`Everyone checked here holds ${role.name}.`}
      footer={<>
        {holdersProblem !== null ? <Problem error={holdersProblem} /> : <p role="status">{holdersState === 'saved' && !holdersChanged ? 'Saved.' : ''}</p>}
        <Button primary disabled={!holdersChanged || holdersState === 'saving'} onClick={saveHolders}>{holdersState === 'saving' ? 'Saving…' : 'Save'}</Button>
      </>}
    >
      {people.length === 0
        ? <EmptyState compact icon="people" title="No active members yet" />
        : <fieldset className="admin-roles-people">
          <legend className="sr-only">People who hold {role.name}</legend>
          {people.map((person) => {
            const you = person.user_id === state.user.id;
            return <label key={person.user_id} className="admin-roles-person">
              <input
                type="checkbox"
                disabled={you || holdersState === 'saving'}
                checked={holders.includes(person.user_id)}
                onChange={(event) => {
                  setHoldersState('idle');
                  setHolders((ids) => event.target.checked ? [...ids, person.user_id] : ids.filter((id) => id !== person.user_id));
                }}
              />
              <span>{person.name}{you && <span className="admin-roles-person-note"> · You. {SELF_CHANGE_MESSAGE}</span>}</span>
            </label>;
          })}
        </fieldset>}
    </AdminSettingsCard>

    <AdminSettingsCard
      title="Agents"
      description={role.agent_template ? 'Agents join this role through the Partnerships and Finance handoff.' : undefined}
      footer={role.agent_template ? <Button onClick={() => nav(LIB('handoffs'))}>Handoff roles</Button> : undefined}
    >
      {role.agents.length
        ? role.agents.map((agent) => <div key={agent.agent_id} className="kv"><span className="grow">{agent.name}</span><span className="meta">Works for {agent.principal.name}</span></div>)
        : <EmptyState compact icon="iris" title="No agents work in this role yet" />}
    </AdminSettingsCard>

    {!role.builtin && <AdminSettingsCard
      title="Delete role"
      danger
      description={role.members.length ? 'Remove everyone from this role before deleting it.' : 'Nobody holds this role, so deleting it changes no one’s access.'}
      footer={<>
        {deleteProblem !== null ? <Problem error={deleteProblem} /> : <p>{confirmDelete ? `Delete ${role.name}?` : ''}</p>}
        {confirmDelete
          ? <div className="admin-roles-actions">
            <Button disabled={deleting} onClick={() => setConfirmDelete(false)}>Keep</Button>
            <Button primary disabled={deleting} onClick={remove}>{deleting ? 'Deleting…' : 'Delete'}</Button>
          </div>
          : <Button disabled={role.members.length > 0} onClick={() => { setDeleteProblem(null); setConfirmDelete(true); }}>Delete role</Button>}
      </>}
    />}
  </>;
}
