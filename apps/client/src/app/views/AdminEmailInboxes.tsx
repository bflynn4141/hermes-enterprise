// Admin → Role inboxes (decision C98): forwarding addresses for a role, each
// read by one agent that suggests replies and hand-offs for people to approve.
//
// Admins configure the addresses; the mail itself belongs to the role. So this
// page lists recent messages only to someone who could read them anyway (the
// inbox agent's owner or a holder of its role). Every write needs a recent
// sign-in, like every other Admin change to who can act.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { REQ, type AgentDirectoryEntry, type EmailInbox, type InboundEmailList, type InboundEmailListItem, type WorkspaceRole } from '@hermes/shared';
import { useAdapter, useAppState, useNav } from '../store-context.js';
import { Button, Dialog, EmptyState, Skeleton } from '../ui/primitives.js';
import { sortRoles } from './AdminRoles.js';
import { useStepUp } from './use-step-up.js';
import { useEmailPolling } from './use-email-polling.js';
import './email-message.css';

export const ADMIN_EMAIL_INBOXES_VIEW = 'Inboxes';

type MailTone = 'quiet' | 'working' | 'ready' | 'problem';

/**
 * One email's state in the words of docs/DESIGN.md, with a sentence when a
 * person needs to know why. The agent is named, because the reader chose it.
 */
export function mailState(message: InboundEmailListItem, agent: string): { text: string; tone: MailTone; note: string | null } {
  if (message.retrying) return { text: 'Trying again soon', tone: 'working', note: `The model was busy. ${agent} will try again in a few minutes.` };
  switch (message.status) {
    case 'received': return { text: `Waiting for ${agent}`, tone: 'working', note: null };
    case 'triaging': return { text: 'Reading', tone: 'working', note: null };
    case 'suggested': return { text: 'Ready for review', tone: 'ready', note: null };
    case 'no_action': return message.problem === 'inbox_paused'
      ? { text: 'Inbox paused', tone: 'quiet', note: 'It arrived while the inbox was paused, so nobody read it.' }
      : { text: 'No reply suggested', tone: 'quiet', note: message.can_retry ? `You can ask ${agent} to read it again. Nothing will be sent without approval.` : null };
    case 'failed': {
      const why: Record<NonNullable<InboundEmailListItem['problem']>, string> = {
        provider_busy: `The model was busy, so ${agent} couldn’t read it. Nothing was sent.`,
        needs_setup: `${agent}’s model needs attention in Admin → Models. Nothing was sent.`,
        no_owner: `${agent} has no owner to reply as. Give it an owner in Admin → Agents, then try again.`,
        inbox_paused: 'The inbox is paused. Resume it, then try again.',
        other: `Something went wrong while ${agent} was reading it. Nothing was sent.`,
      };
      return { text: 'Couldn’t read it', tone: 'problem', note: why[message.problem ?? 'other'] };
    }
    default: return { text: 'Updated', tone: 'quiet', note: null };
  }
}

const receivedAt = (value: string): string => {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return '';
  const today = new Date();
  return date.toDateString() === today.toDateString()
    ? date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
    : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
};

export function inboxErrorMessage(error: unknown): string {
  switch ((error as { reason?: string } | null)?.reason) {
    case 'reauth_required': return 'Please sign in again to change inboxes.';
    case 'email_intake_not_configured': return 'Role inboxes aren’t turned on for this Hermes yet. Ask the person who runs Hermes for your company to turn them on.';
    case 'agent_owner_missing': return 'That agent has no owner to reply as. Give it an owner in Admin → Agents first.';
    case 'unknown_role': return 'That role no longer exists. Reload and try again.';
    case 'unknown_agent': return 'That agent no longer exists. Reload and try again.';
    default: return 'Couldn’t save. Nothing was changed. Try again.';
  }
}

export function retryErrorMessage(error: unknown): string {
  switch ((error as { reason?: string } | null)?.reason) {
    case 'inbox_paused': return 'This inbox is paused. Resume it, then try again.';
    case 'not_retryable': return 'The agent is already reading this email or has created a suggestion. Refresh to see its latest status.';
    case 'rate_limited': return 'That was a lot of tries in a row. Wait a minute, then try again.';
    default: return 'Couldn’t ask the agent again. Try again in a moment.';
  }
}

function Problem({ error }: { error: unknown }) {
  const { needsSignIn, signIn } = useStepUp('workspace_roles');
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
  const [loadError, setLoadError] = useState(false);
  const load = useCallback(() => adapter.rest.listInboxMessages(state.workspace.id, inbox.id), [adapter, state.workspace.id, inbox.id]);
  const polling = useEmailPolling(load,
    (result) => { setList(result); setLoadError(false); },
    (error) => {
      // Only an explicit access response hides previously readable content.
      if ([403, 404].includes((error as { status?: number } | null)?.status ?? 0)) {
        setList('hidden');
        setLoadError(false);
      } else setLoadError(true);
    });
  const [retrying, setRetrying] = useState<string | null>(null);
  const [retryProblem, setRetryProblem] = useState<{ id: string; error: unknown } | null>(null);
  const retry = async (message: InboundEmailListItem): Promise<void> => {
    setRetrying(message.id);
    setRetryProblem(null);
    polling.suspend();
    try {
      const next = await adapter.rest.retryInboundEmail(state.workspace.id, message.id);
      setList((current) => current && current !== 'hidden'
        ? { messages: current.messages.map((row) => row.id === next.id ? next : row) }
        : current);
    } catch (caught) {
      setRetryProblem({ id: message.id, error: caught });
    } finally {
      setRetrying(null);
      polling.refresh();
    }
  };
  const refreshProblem = loadError && <p className="email-inbox-facts" role="status">Couldn’t refresh recent email. We’ll try again. <Button small disabled={retrying !== null} onClick={polling.refresh}>Try now</Button></p>;
  if (list === null) return refreshProblem || null;
  if (list === 'hidden') return <p className="email-inbox-facts">Only the people in this role and {inbox.agent.name}’s owner can read this inbox’s email.</p>;
  if (list.messages.length === 0) return <>{refreshProblem}<EmptyState compact icon="inbox" title="No email yet" detail="Send one to the address above to try it." /></>;
  return <>{refreshProblem}<ul className="email-inbox-messages" aria-label={`Recent email at ${inbox.label}`}>
    {list.messages.slice(0, 5).map((message) => {
      const requestId = message.request_ids[0];
      const subject = message.subject || '(no subject)';
      const stateWords = mailState(message, inbox.agent.name);
      const flagged = message.sender.warnings.some((warning) => warning.severity === 'caution');
      return <li key={message.id} data-tone={stateWords.tone}>
        <span className="email-inbox-message-main">
          {requestId
            ? <button type="button" className="email-inbox-subject" onClick={() => nav(REQ(requestId))}>{subject}</button>
            : <span className="email-inbox-subject">{subject}</span>}
          <span className="email-inbox-sub">
            {message.sender.name ?? message.sender.address}
            {flagged && <span className="email-inbox-flag"> · Check the sender</span>}
          </span>
        </span>
        <span className="email-inbox-message-side">
          <time dateTime={message.received_at}>{receivedAt(message.received_at)}</time>
          <span className="state" data-tone={stateWords.tone}>{stateWords.text}</span>
        </span>
        {(stateWords.note || message.can_retry) && <span className="email-inbox-note">
          {stateWords.note && <span>{stateWords.note}</span>}
          {message.can_retry && <Button small disabled={retrying !== null} aria-label={`Try again: ${subject}`} onClick={() => void retry(message)}>
            {retrying === message.id ? 'Asking…' : 'Try again'}
          </Button>}
        </span>}
        {retryProblem?.id === message.id && <p className="problem" role="alert">{retryErrorMessage(retryProblem.error)}</p>}
      </li>;
    })}
  </ul></>;
}

const RUNTIME_WORDS: Record<AgentDirectoryEntry['runtime']['source'], string> = {
  cloud_capacity: 'Hermes Cloud',
  cloud_provisioned: 'Hermes Cloud',
  deployment: 'Built in',
  none: 'Not set up',
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

/** Role inboxes, the first section of Admin → Email. */
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

  const load = useCallback(() => adapter.rest.listEmailInboxes(state.workspace.id), [adapter, state.workspace.id]);
  const polling = useEmailPolling(load,
    (list) => { setInboxes(list.inboxes); setDomain(list.domain); setLoadError(false); },
    () => setLoadError(true));
  useEffect(() => {
    let live = true;
    void adapter.rest.listRoles(state.workspace.id).then((list) => { if (live) setRoles(sortRoles(list.items)); }).catch(() => { if (live) setRoles([]); });
    void adapter.rest.adminAgents(state.workspace.id).then((list) => { if (live) setAgents(list.items); }).catch(() => { if (live) setAgents([]); });
    return () => { live = false; };
  }, [adapter, state.workspace.id]);

  const replace = (next: EmailInbox): void => setInboxes((rows) => rows?.some((row) => row.id === next.id)
    ? rows.map((row) => row.id === next.id ? next : row)
    : [...(rows ?? []), next]);
  const setStatus = async (inbox: EmailInbox, status: 'active' | 'paused'): Promise<void> => {
    setBusyId(inbox.id);
    setProblem(null);
    polling.suspend();
    try { replace(await adapter.rest.setEmailInboxStatus(state.workspace.id, inbox.id, status)); }
    catch (caught) { setProblem(caught); }
    finally { setBusyId(null); polling.refresh(); }
  };
  const remove = async (inbox: EmailInbox): Promise<void> => {
    setBusyId(inbox.id);
    setProblem(null);
    polling.suspend();
    try {
      await adapter.rest.deleteEmailInbox(state.workspace.id, inbox.id);
      setInboxes((rows) => rows?.filter((row) => row.id !== inbox.id) ?? rows);
      setRemoving(null);
    } catch (caught) { setProblem(caught); }
    finally { setBusyId(null); polling.refresh(); }
  };
  const roleName = (slug: string): string => roles.find((role) => role.slug === slug)?.name ?? inboxes?.find((inbox) => inbox.role_slug === slug)?.label ?? 'This';

  if (loadError && !inboxes) return <div role="alert" className="admin-roles-error"><p>Could not load role inboxes. Try again.</p><Button onClick={polling.refresh}>Try again</Button></div>;
  if (!inboxes) return <Skeleton rows={4} label="Loading role inboxes" />;
  const addInbox = <Button disabled={busyId !== null} onClick={() => setAdding(true)}>Add inbox</Button>;
  return <>
    {/* With no inboxes the Add button belongs to the empty state, below it. */}
    <header className="admin-section-heading">
      <h3>Role inboxes</h3>
      {domain && inboxes.length > 0 && addInbox}
    </header>
    {loadError && <p className="email-inbox-facts" role="status">Couldn’t refresh role inboxes. We’ll try again. <Button small disabled={busyId !== null} onClick={polling.refresh}>Try now</Button></p>}
    {problem !== null && <Problem error={problem} />}
    {!domain
      ? <EmptyState compact icon="inbox" title="Role inboxes aren’t turned on yet" detail="Ask the person who runs Hermes for your company to turn them on." />
      : inboxes.length === 0
      ? <EmptyState compact icon="inbox" title="No role inboxes yet" detail="Each role gets an address. Its agent suggests replies; people approve them." action={addInbox} />
      : <ul className="email-inboxes-list" aria-label="Role inboxes">
        {inboxes.map((inbox) => <li key={inbox.id}>
          <div className="email-inbox-top">
            <strong>{inbox.label}</strong>
            <span className="email-inbox-status" data-state={inbox.status}>{inbox.status === 'active' ? 'Receiving' : 'Paused · new email is turned away'}</span>
            <span className="email-inbox-actions">
              <Button small disabled={busyId !== null} onClick={() => void setStatus(inbox, inbox.status === 'active' ? 'paused' : 'active')}>{inbox.status === 'active' ? 'Pause' : 'Resume'}</Button>
              <Button small disabled={busyId !== null} onClick={() => setRemoving(inbox)}>Remove</Button>
            </span>
          </div>
          <CopyAddress address={inbox.address} />
          <p className="email-inbox-facts">{roleName(inbox.role_slug)} team · Read by {inbox.agent.name} · {inbox.message_count} {inbox.message_count === 1 ? 'email' : 'emails'}</p>
          <RecentMail inbox={inbox} />
        </li>)}
      </ul>}
    {inboxes.length > 0 && <details className="admin-help">
      <summary>How to send email to an inbox</summary>
      <ol>
        <li>Copy the address onto shared email, or add it to a group such as partners@.</li>
        <li>In Google Workspace: Admin console → Apps → Google Workspace → Gmail → Routing → Add another rule.</li>
        <li>In Microsoft 365: Exchange admin center → Mail flow → Rules → Add a rule that sends a copy to the address.</li>
        <li>In Gmail or Outlook, forward chosen emails to it with a filter.</li>
      </ol>
    </details>}
    {adding && <NewInbox roles={roles} agents={agents} onClose={() => setAdding(false)} onCreated={(inbox) => { polling.refresh(); replace(inbox); setAdding(false); }} />}
    {removing && <Dialog open title={`Remove ${removing.label}?`} onClose={() => setRemoving(null)} actions={<>
      <Button onClick={() => setRemoving(null)}>Keep it</Button>
      <Button primary disabled={busyId === removing.id} onClick={() => void remove(removing)}>Remove inbox</Button>
    </>}>
      <p>New email to {removing.address} will be turned away, every email it received will be deleted, and {removing.agent.name} will stop suggesting replies for it. Decisions already made stay in History.</p>
    </Dialog>}
  </>;
}
