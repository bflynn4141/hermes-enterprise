// Admin → Role inboxes (decision C98): forwarding addresses for a role, each
// read by one agent that suggests replies and hand-offs for people to approve.
//
// Admins configure the addresses; the mail itself belongs to the role. So this
// page lists recent messages only to someone who could read them anyway (the
// inbox agent's owner or a holder of its role). Every write needs a recent
// sign-in, like every other Admin change to who can act.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { REQ, type AgentDirectoryEntry, type EmailInbox, type InboundEmailList, type WorkspaceRole } from '@hermes/shared';
import { useAdapter, useAppState, useNav } from '../store-context.js';
import { Button, Dialog, EmptyState, Skeleton } from '../ui/primitives.js';
import { AdminSettingsCard } from './AdminDetailLayout.js';
import { sortRoles } from './AdminRoles.js';
import { useStepUp } from './use-step-up.js';
import './email-message.css';

export const ADMIN_EMAIL_INBOXES_VIEW = 'Inboxes';

const STATUS_WORDS: Record<InboundEmailList['messages'][number]['status'], string> = {
  received: 'Received',
  triaging: 'Agent reading',
  suggested: 'Suggestion waiting',
  no_action: 'Nothing needed',
  failed: 'Could not process',
};

export function inboxErrorMessage(error: unknown): string {
  switch ((error as { reason?: string } | null)?.reason) {
    case 'reauth_required': return 'Changing inboxes needs a recent sign-in.';
    case 'email_intake_not_configured': return 'This deployment has no receiving email domain yet. An operator sets EMAIL_INTAKE_DOMAIN and Email Routing first.';
    case 'agent_owner_missing': return 'That agent has no owner to reply as. Give it an owner in All agents first.';
    case 'unknown_role': return 'That role no longer exists. Reload and try again.';
    case 'unknown_agent': return 'That agent no longer exists. Reload and try again.';
    default: return 'Could not save. Nothing was changed. Try again.';
  }
}

function Problem({ error }: { error: unknown }) {
  const { needsSignIn, signIn } = useStepUp('gmail');
  return <p className="admin-roles-problem" role="alert">
    {inboxErrorMessage(error)} {needsSignIn(error) && <Button link onClick={signIn}>Sign in again</Button>}
  </p>;
}

function CopyAddress({ address }: { address: string }) {
  const [copied, setCopied] = useState(false);
  return <span className="email-inbox-address">
    <code>{address}</code>
    <Button small onClick={() => {
      void navigator.clipboard?.writeText(address).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1600); }, () => undefined);
    }}>{copied ? 'Copied' : 'Copy'}</Button>
  </span>;
}

function RecentMail({ inbox }: { inbox: EmailInbox }) {
  const adapter = useAdapter();
  const state = useAppState();
  const nav = useNav();
  const [list, setList] = useState<InboundEmailList | null | 'hidden'>(null);
  useEffect(() => {
    let live = true;
    void adapter.rest.listInboxMessages(state.workspace.id, inbox.id).then(
      (result) => { if (live) setList(result); },
      // A 404 means this Admin is not someone who reads this role's mail.
      () => { if (live) setList('hidden'); },
    );
    return () => { live = false; };
  }, [adapter, state.workspace.id, inbox.id, inbox.message_count]);
  if (list === null) return null;
  if (list === 'hidden') return <p className="email-inbox-facts">Only the people in this role and the agent’s owner read its mail.</p>;
  if (list.messages.length === 0) return <p className="email-inbox-facts">No email yet.</p>;
  return <ul className="email-inbox-messages" aria-label={`Recent email at ${inbox.label}`}>
    {list.messages.slice(0, 5).map((message) => {
      const requestId = message.request_ids[0];
      return <li key={message.id}>
        {requestId
          ? <Button link onClick={() => nav(REQ(requestId))}>{message.subject || '(no subject)'}</Button>
          : <span>{message.subject || '(no subject)'}</span>}
        <span className="state">{STATUS_WORDS[message.status]}</span>
        <span className="from">{message.sender.name ?? message.sender.address}</span>
      </li>;
    })}
  </ul>;
}

const RUNTIME_WORDS: Record<AgentDirectoryEntry['runtime']['source'], string> = {
  cloud_capacity: 'Cloud runtime',
  cloud_provisioned: 'Cloud runtime',
  deployment: 'deployment runtime',
  none: 'no runtime',
};

/**
 * How the inbox picker names an agent. Two agents can share a name and an
 * owner (staging has two "Iris · Brian Flynn"), so the role goes in whenever
 * the agent holds one, and where it runs is added only when the name, owner
 * and role still leave two agents looking the same.
 */
export function inboxAgentLabel(agent: AgentDirectoryEntry, peers: readonly AgentDirectoryEntry[]): string {
  const base = (entry: AgentDirectoryEntry): string =>
    [entry.name, entry.owner?.name, entry.role?.team.name].filter(Boolean).join(' · ');
  const label = base(agent);
  const twin = peers.some((peer) => peer.id !== agent.id && base(peer) === label);
  return twin ? `${label} · ${agent.runtime.label ?? RUNTIME_WORDS[agent.runtime.source]}` : label;
}

/** The agent a new inbox for `roleSlug` starts with: the one holding that role, if any. */
export function preferredInboxAgent(agents: readonly AgentDirectoryEntry[], roleSlug: string): AgentDirectoryEntry | undefined {
  return agents.find((agent) => agent.role?.team.slug === roleSlug) ?? agents[0];
}

export function NewInbox({ roles, agents, onCreated, onClose }: {
  roles: readonly WorkspaceRole[];
  agents: readonly AgentDirectoryEntry[];
  onCreated: (inbox: EmailInbox) => void;
  onClose: () => void;
}) {
  const adapter = useAdapter();
  const state = useAppState();
  const owned = useMemo(() => agents.filter((agent) => agent.owner && agent.status === 'started'), [agents]);
  const [roleSlug, setRoleSlug] = useState(roles.find((role) => role.slug === 'partnerships')?.slug ?? roles[0]?.slug ?? '');
  const [agentId, setAgentId] = useState(preferredInboxAgent(owned, roleSlug)?.id ?? '');
  const [label, setLabel] = useState(roles.find((role) => role.slug === roleSlug)?.name ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const create = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      onCreated(await adapter.rest.createEmailInbox(state.workspace.id, { role_slug: roleSlug, agent_id: agentId, label: label.trim() }));
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };
  return <Dialog open title="Add a role inbox" onClose={onClose} actions={<>
    <Button onClick={onClose}>Cancel</Button>
    <Button primary disabled={busy || !roleSlug || !agentId || label.trim().length === 0} onClick={() => void create()}>{busy ? 'Adding…' : 'Add inbox'}</Button>
  </>}>
    <p className="email-inbox-help">Hermes gives the role a private forwarding address. The agent reads what arrives and suggests replies or hand-offs; a person approves each one.</p>
    <div className="email-inbox-form">
      <label>Role
        <select value={roleSlug} onChange={(event) => {
          setRoleSlug(event.target.value);
          // Follow the role to its own agent; with none, keep the Admin's pick.
          const match = owned.find((agent) => agent.role?.team.slug === event.target.value);
          if (match) setAgentId(match.id);
          setLabel(roles.find((role) => role.slug === event.target.value)?.name ?? label);
        }}>{roles.map((role) => <option key={role.slug} value={role.slug}>{role.name}</option>)}</select>
      </label>
      <label>Agent that reads it
        <select value={agentId} onChange={(event) => setAgentId(event.target.value)}>
          {owned.length === 0 && <option value="">No agent with an owner</option>}
          {owned.map((agent) => <option key={agent.id} value={agent.id}>{inboxAgentLabel(agent, owned)}</option>)}
        </select>
      </label>
      <label>Name
        <input value={label} maxLength={120} onChange={(event) => setLabel(event.target.value)} />
      </label>
    </div>
    {error !== null && <Problem error={error} />}
  </Dialog>;
}

export function AdminEmailInboxes() {
  const adapter = useAdapter();
  const state = useAppState();
  const [inboxes, setInboxes] = useState<EmailInbox[] | null>(null);
  const [domain, setDomain] = useState<string | null>(null);
  const [roles, setRoles] = useState<WorkspaceRole[]>([]);
  const [agents, setAgents] = useState<AgentDirectoryEntry[]>([]);
  const [loadError, setLoadError] = useState(false);
  const [adding, setAdding] = useState(false);
  const [removing, setRemoving] = useState<EmailInbox | null>(null);
  const [problem, setProblem] = useState<unknown>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoadError(false);
    void adapter.rest.listRoles(state.workspace.id).then((list) => setRoles(sortRoles(list.items))).catch(() => setRoles([]));
    void adapter.rest.adminAgents(state.workspace.id).then((list) => setAgents(list.items)).catch(() => setAgents([]));
    void adapter.rest.listEmailInboxes(state.workspace.id).then(
      (list) => { setInboxes(list.inboxes); setDomain(list.domain); },
      () => setLoadError(true),
    );
  }, [adapter, state.workspace.id]);
  useEffect(() => { load(); }, [load]);

  const replace = (next: EmailInbox): void => setInboxes((rows) => rows?.some((row) => row.id === next.id)
    ? rows.map((row) => row.id === next.id ? next : row)
    : [...(rows ?? []), next]);
  const setStatus = async (inbox: EmailInbox, status: 'active' | 'paused'): Promise<void> => {
    setBusyId(inbox.id);
    setProblem(null);
    try { replace(await adapter.rest.setEmailInboxStatus(state.workspace.id, inbox.id, status)); }
    catch (caught) { setProblem(caught); }
    finally { setBusyId(null); }
  };
  const remove = async (inbox: EmailInbox): Promise<void> => {
    setBusyId(inbox.id);
    setProblem(null);
    try {
      await adapter.rest.deleteEmailInbox(state.workspace.id, inbox.id);
      setInboxes((rows) => rows?.filter((row) => row.id !== inbox.id) ?? rows);
      setRemoving(null);
    } catch (caught) { setProblem(caught); }
    finally { setBusyId(null); }
  };
  const roleName = (slug: string): string => roles.find((role) => role.slug === slug)?.name ?? slug;

  if (loadError) return <div role="alert" className="admin-roles-error"><p>Could not load role inboxes. Try again.</p><Button onClick={load}>Try again</Button></div>;
  if (!inboxes) return <Skeleton rows={4} label="Loading role inboxes" />;
  return <>
    <header className="admin-detail-heading">
      <div>
        <h2>Role inboxes</h2>
        <p>Give a role an address people can forward or copy email to. Its agent reads each message and suggests a reply or a hand-off. Nothing is sent until a person approves it.</p>
      </div>
      <Button disabled={!domain} onClick={() => setAdding(true)}>Add inbox</Button>
    </header>
    {!domain && <p className="email-inbox-help">This deployment has no receiving domain yet. An operator sets it up once in Cloudflare Email Routing; see docs/EMAIL-INTAKE.md.</p>}
    {problem !== null && <Problem error={problem} />}
    {inboxes.length === 0
      ? <EmptyState icon="inbox" title="No role inboxes yet" detail="Add one for Partnerships so partner email reaches its agent." />
      : <ul className="email-inboxes-list" aria-label="Role inboxes">
        {inboxes.map((inbox) => <li key={inbox.id}>
          <div className="email-inbox-top">
            <strong>{inbox.label}</strong>
            <span className="email-inbox-status" data-state={inbox.status}>{inbox.status === 'active' ? 'Receiving' : 'Paused · mail is refused'}</span>
            <span className="email-inbox-actions">
              <Button small disabled={busyId === inbox.id} onClick={() => void setStatus(inbox, inbox.status === 'active' ? 'paused' : 'active')}>{inbox.status === 'active' ? 'Pause' : 'Resume'}</Button>
              <Button small disabled={busyId === inbox.id} onClick={() => setRemoving(inbox)}>Remove</Button>
            </span>
          </div>
          <CopyAddress address={inbox.address} />
          <p className="email-inbox-facts">{roleName(inbox.role_slug)} · Read by {inbox.agent.name} · {inbox.message_count} {inbox.message_count === 1 ? 'email' : 'emails'}</p>
          <RecentMail inbox={inbox} />
        </li>)}
      </ul>}
    <AdminSettingsCard title="Getting mail to an inbox" description="Any of these works. Hermes sees only what reaches the address.">
      <div className="email-inbox-help">
        <ol>
          <li>Copy the address on shared mail, or add it to a group such as partners@.</li>
          <li>In Google Workspace, route a group’s mail to it (Admin console → Apps → Gmail → Routing → Add more recipients).</li>
          <li>In Gmail or Outlook, forward selected messages to it with a filter.</li>
        </ol>
        <p>Replies go only to the address that sent the email. Senders the server flags, for a failed domain check, a lookalike domain or new bank details, need a second person to approve.</p>
      </div>
    </AdminSettingsCard>
    {adding && <NewInbox roles={roles} agents={agents} onClose={() => setAdding(false)} onCreated={(inbox) => { replace(inbox); setAdding(false); }} />}
    {removing && <Dialog open title={`Remove ${removing.label}?`} onClose={() => setRemoving(null)} actions={<>
      <Button onClick={() => setRemoving(null)}>Keep it</Button>
      <Button primary disabled={busyId === removing.id} onClick={() => void remove(removing)}>Remove inbox</Button>
    </>}>
      <p>Mail to {removing.address} will be refused, every email it received will be deleted, and its agent loses the reply tools. Approvals already decided keep their records.</p>
    </Dialog>}
  </>;
}
