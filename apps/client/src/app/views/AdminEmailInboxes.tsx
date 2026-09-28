// Admin → Email, agent email (decisions C98, C100). Every agent has its own
// address, created with it; approved replies go out from that address. Nobody
// provisions an address: an Admin configures roles, and an agent's role
// decides who reviews its mail. Addresses Admins made for roles before C100
// keep working and are listed with the agent that reads them.
//
// The mail belongs to the people who review it, so this page lists recent
// messages only to someone who could read them anyway (the agent's owner or a
// holder of its role). Pausing and replacing need a recent sign-in, like every
// other Admin change to who can act.
import { useCallback, useEffect, useState } from 'react';
import { REQ, type EmailInbox, type InboundEmailList, type InboundEmailListItem, type WorkspaceRole } from '@hermes/shared';
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
        daily_limit: `${agent} has read today’s number of emails. Read it now, or it waits here.`,
        other: `Something went wrong while ${agent} was reading it. Nothing was sent.`,
      };
      if (message.problem === 'daily_limit') return { text: 'Waiting for you', tone: 'quiet', note: why.daily_limit };
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

/** An agent's own address (C100), or null while it has none; undefined while loading. */
export function useAgentAddress(agentId: string): string | null | undefined {
  const adapter = useAdapter();
  const state = useAppState();
  const [address, setAddress] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    void adapter.rest.listEmailInboxes(state.workspace.id)
      .then((list) => { if (live) setAddress(list.inboxes.find((inbox) => inbox.kind === 'agent' && inbox.agent.id === agentId)?.address ?? null); })
      .catch(() => { if (live) setAddress(null); });
    return () => { live = false; };
  }, [adapter, state.workspace.id, agentId]);
  return address;
}

export function CopyAddress({ address }: { address: string }) {
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
          {message.can_retry && <Button small disabled={retrying !== null} aria-label={`${message.problem === 'daily_limit' ? 'Read it now' : 'Try again'}: ${subject}`} onClick={() => void retry(message)}>
            {retrying === message.id ? 'Asking…' : message.problem === 'daily_limit' ? 'Read it now' : 'Try again'}
          </Button>}
        </span>}
        {retryProblem?.id === message.id && <p className="problem" role="alert">{retryErrorMessage(retryProblem.error)}</p>}
      </li>;
    })}
  </ul></>;
}

/** Agent email, the first section of Admin → Email (C100). */
export function AdminEmailInboxes() {
  const adapter = useAdapter();
  const state = useAppState();
  const [inboxes, setInboxes] = useState<EmailInbox[] | null>(null);
  const [domain, setDomain] = useState<string | null>(null);
  const [roles, setRoles] = useState<WorkspaceRole[]>([]);
  const [loadError, setLoadError] = useState(false);
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
    return () => { live = false; };
  }, [adapter, state.workspace.id]);

  const replace = (next: EmailInbox): void => setInboxes((rows) => rows?.map((row) => row.id === next.id ? next : row) ?? rows);
  const setStatus = async (inbox: EmailInbox, status: 'active' | 'paused'): Promise<void> => {
    setBusyId(inbox.id);
    setProblem(null);
    polling.suspend();
    try { replace(await adapter.rest.setEmailInboxStatus(state.workspace.id, inbox.id, status)); }
    catch (caught) { setProblem(caught); }
    finally { setBusyId(null); polling.refresh(); }
  };
  // Removing an agent's address gives it a new one on the next load.
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
  const roleName = (slug: string): string => roles.find((role) => role.slug === slug)?.name ?? slug;
  const reviewers = (inbox: EmailInbox): string => inbox.role_slug
    ? `${roleName(inbox.role_slug)} reviews`
    : 'Its owner reviews';

  if (loadError && !inboxes) return <div role="alert" className="admin-roles-error"><p>Could not load agent email. Try again.</p><Button onClick={polling.refresh}>Try again</Button></div>;
  if (!inboxes) return <Skeleton rows={4} label="Loading agent email" />;
  return <>
    <header className="admin-section-heading"><h3>Agent email</h3></header>
    {loadError && <p className="email-inbox-facts" role="status">Couldn’t refresh agent email. We’ll try again. <Button small disabled={busyId !== null} onClick={polling.refresh}>Try now</Button></p>}
    {problem !== null && <Problem error={problem} />}
    {!domain
      ? <EmptyState compact icon="inbox" title="Agent email isn’t turned on yet" detail="Ask the person who runs Hermes for your company to turn it on." />
      : inboxes.length === 0
      ? <EmptyState compact icon="iris" title="No agent has an address yet" detail="An agent gets its own address once someone owns it." />
      : <ul className="email-inboxes-list" aria-label="Agent email">
        {inboxes.map((inbox) => <li key={inbox.id}>
          <div className="email-inbox-top">
            <strong>{inbox.kind === 'agent' ? inbox.agent.name : inbox.label}</strong>
            <span className="email-inbox-status" data-state={inbox.status}>{inbox.status === 'active' ? 'Receiving' : 'Paused · new email is turned away'}</span>
            <span className="email-inbox-actions">
              <Button small disabled={busyId !== null} onClick={() => void setStatus(inbox, inbox.status === 'active' ? 'paused' : 'active')}>{inbox.status === 'active' ? 'Pause' : 'Resume'}</Button>
              <Button small disabled={busyId !== null} onClick={() => setRemoving(inbox)}>{inbox.kind === 'agent' ? 'New address' : 'Remove'}</Button>
            </span>
          </div>
          <CopyAddress address={inbox.address} />
          <p className="email-inbox-facts">{inbox.kind === 'agent'
            ? `${reviewers(inbox)} · ${inbox.message_count} ${inbox.message_count === 1 ? 'email' : 'emails'}`
            : `${inbox.role_slug ? roleName(inbox.role_slug) : 'Role'} address · Read by ${inbox.agent.name} · ${inbox.message_count} ${inbox.message_count === 1 ? 'email' : 'emails'}`}</p>
          <RecentMail inbox={inbox} />
        </li>)}
      </ul>}
    {inboxes.length > 0 && <details className="admin-help">
      <summary>How to send email to an agent</summary>
      <ol>
        <li>Email the agent’s address directly, or copy it on a thread.</li>
        <li>To route a shared address such as partners@ to an agent, in Google Workspace: Admin console → Apps → Google Workspace → Gmail → Routing → Add another rule.</li>
        <li>In Microsoft 365: Exchange admin center → Mail flow → Rules → Add a rule that sends a copy to the address.</li>
      </ol>
    </details>}
    {removing && <Dialog open title={removing.kind === 'agent' ? `Give ${removing.agent.name} a new address?` : `Remove ${removing.label}?`} onClose={() => setRemoving(null)} actions={<>
      <Button onClick={() => setRemoving(null)}>Keep it</Button>
      <Button primary disabled={busyId === removing.id} onClick={() => void remove(removing)}>{removing.kind === 'agent' ? 'New address' : 'Remove address'}</Button>
    </>}>
      <p>{removing.kind === 'agent'
        ? `${removing.address} will stop receiving email and the email it received will be deleted. ${removing.agent.name} gets a new address right away, so update anything that forwards to the old one. Decisions already made stay in History.`
        : `New email to ${removing.address} will be turned away, every email it received will be deleted, and ${removing.agent.name} will stop suggesting replies for it. Decisions already made stay in History.`}</p>
    </Dialog>}
  </>;
}
