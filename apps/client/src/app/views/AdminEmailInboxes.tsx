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
import { INBOUND_EMAIL_LIST_MAX, REQ, type EmailInbox, type InboundEmailList, type InboundEmailListItem, type WorkspaceRole } from '@hermes/shared';
import { useAdapter, useAppState, useNav } from '../store-context.js';
import { Avatar, Button, Dialog, EmptyState, Item, Pill, SearchField, Skeleton, Snippet, StatusDot, ToggleGroup, type StatusTone } from '../ui/primitives.js';
import { fullTime, timeAgo } from '../ui/time.js';
import { Glass, Icon } from '../ui/icons.js';
import { sortRoles } from './AdminRoles.js';
import { useStepUp } from './use-step-up.js';
import { useEmailPolling } from './use-email-polling.js';
import './email-message.css';

export const ADMIN_EMAIL_INBOXES_VIEW = 'Inboxes';

type MailTone = 'quiet' | 'working' | 'ready' | 'done' | 'problem';
const DOT_TONE: Record<MailTone, StatusTone> = { quiet: 'muted', working: 'working', ready: 'ready', done: 'ok', problem: 'problem' };
/** Rows in the first page of an agent's email, and how many more "Show more" adds. */
const FIRST_PAGE = 10;
const MORE = 25;
/** An agent with more email than this gets search and sorting. */
const TOOLS_FROM = 5;

/**
 * One email's state in the words of docs/DESIGN.md, with a sentence when a
 * person needs to know why. The agent is named, because the reader chose it.
 */
export function mailState(message: InboundEmailListItem, agent: string): { text: string; tone: MailTone; note: string | null } {
  if (message.retrying) return { text: 'Trying again soon', tone: 'working', note: `The model was busy. ${agent} will try again in a few minutes.` };
  switch (message.status) {
    case 'received': return { text: `Waiting for ${agent}`, tone: 'working', note: null };
    case 'triaging': return { text: 'Reading', tone: 'working', note: null };
    // A server from before C100's list sorting does not say; read that as still waiting.
    case 'suggested': return message.awaiting_review === false
      ? { text: 'Reviewed', tone: 'done', note: null }
      : { text: 'Ready for review', tone: 'ready', note: null };
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

export function CopyAddress({ address, name }: { address: string; name?: string }) {
  return <Snippet className="email-inbox-address" value={address} label={name ? `${name}’s address` : 'the address'} />;
}

/**
 * A status a person can act on, as the status itself: "Couldn't read it"
 * becomes "Try again" under the pointer or keyboard focus, in the same space,
 * and says why on hover. Touch screens, which have no hover, show the action.
 */
function RetryStatus({ message, tone, text, note, subject, busy, disabled, onRetry }: {
  message: InboundEmailListItem; tone: StatusTone; text: string; note: string | null; subject: string;
  busy: boolean; disabled: boolean; onRetry: () => void;
}) {
  const action = message.problem === 'daily_limit' ? 'Read it now' : 'Try again';
  return (
    <button type="button" className="email-status-action" disabled={disabled} title={note ?? undefined}
      aria-label={`${text}. ${action}: ${subject}`} onClick={onRetry}>
      <span className="when-idle"><StatusDot tone={tone} label={busy ? 'Asking…' : text} /></span>
      <span className="when-active" aria-hidden="true"><Icon name="replace" size={14} strokeWidth={1.8} />{action}</span>
    </button>
  );
}

/** Waits `ms` after the last change before passing a value on, so typing does not send a request per key. */
function useSettled<T>(value: T, ms: number): T {
  const [settled, setSettled] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setSettled(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return settled;
}

function RecentMail({ inbox }: { inbox: EmailInbox }) {
  const adapter = useAdapter();
  const state = useAppState();
  const nav = useNav();
  const [list, setList] = useState<InboundEmailList | null | 'hidden'>(null);
  const [loadError, setLoadError] = useState(false);
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<'recent' | 'priority'>('recent');
  const [limit, setLimit] = useState(FIRST_PAGE);
  const q = useSettled(search.trim(), 300);
  // A new search or order starts from the first page again.
  useEffect(() => setLimit(FIRST_PAGE), [q, sort]);
  const load = useCallback(() => adapter.rest.listInboxMessages(state.workspace.id, inbox.id, { q, sort, limit }),
    [adapter, state.workspace.id, inbox.id, q, sort, limit]);
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
        ? { ...current, messages: current.messages.map((row) => row.id === next.id ? next : row) }
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
  const searching = q !== '' || search !== '';
  if (list.messages.length === 0 && !searching) return <>{refreshProblem}<EmptyState compact icon="inbox" title="No email yet" detail="Send one to the address above to try it." /></>;
  const total = list.total ?? list.messages.length;
  return <>
    {refreshProblem}
    {(inbox.message_count > TOOLS_FROM || searching) && <div className="email-inbox-tools">
      <SearchField label={`Search ${inbox.agent.name}’s email`} value={search} onChange={setSearch} />
      <ToggleGroup label="Sort email" value={sort} onChange={setSort} options={[['recent', 'Recent'], ['priority', 'Priority']]} />
    </div>}
    {list.messages.length === 0
      ? <EmptyState compact icon="inbox" title="No matching email" detail="Try a sender, an address or words from the subject." />
      : <ul className="email-inbox-messages" aria-label={`Recent email at ${inbox.label}`}>
        {list.messages.map((message) => {
          const requestId = message.request_ids[0];
          const subject = message.subject || '(no subject)';
          const stateWords = mailState(message, inbox.agent.name);
          const flagged = message.sender.warnings.some((warning) => warning.severity === 'caution');
          const sender = message.sender.name ?? message.sender.address;
          const toDo = message.brief?.action_items.filter((item) => item.owner === 'us').length ?? 0;
          return <li key={message.id} data-tone={stateWords.tone}>
            <div className="email-row">
              <span className="email-row-sender" title={`${sender} <${message.sender.address}>`}><Avatar person={{ name: sender }} size={26} /></span>
              <span className="email-row-main">
                {requestId
                  ? <button type="button" className="email-inbox-subject" title={subject} onClick={() => nav(REQ(requestId))}>{subject}</button>
                  : <span className="email-inbox-subject" title={subject}>{subject}</span>}
                <span className="sr-only">, from {sender}</span>
              </span>
              <span className="email-row-todo">{toDo > 0 && <Pill tone="info" icon="check">{toDo} to do</Pill>}</span>
              <span className="email-row-status">
                {message.can_retry
                  ? <RetryStatus message={message} tone={DOT_TONE[stateWords.tone]} text={stateWords.text} note={stateWords.note} subject={subject}
                    busy={retrying === message.id} disabled={retrying !== null} onRetry={() => void retry(message)} />
                  : flagged && message.status === 'suggested' && message.awaiting_review !== false
                  ? <StatusDot tone="warn" label="Check the sender" hint={`Ready for review. ${message.sender.warnings.find((warning) => warning.severity === 'caution')?.detail ?? ''}`.trim()} />
                  : <StatusDot tone={DOT_TONE[stateWords.tone]} label={stateWords.text} hint={stateWords.note ?? undefined} />}
              </span>
              <time dateTime={message.received_at} title={fullTime(message.received_at)}>
                <span className="time-full">{timeAgo(message.received_at)}</span>
                <span className="time-short" aria-hidden="true">{timeAgo(message.received_at, Date.now(), { compact: true })}</span>
              </time>
            </div>
            {retryProblem?.id === message.id && <p className="problem" role="alert">{retryErrorMessage(retryProblem.error)}</p>}
          </li>;
        })}
      </ul>}
    {total > list.messages.length && <div className="email-inbox-more">
      <span>{list.messages.length} of {total}</span>
      <Button small onClick={() => setLimit((current) => Math.min(current + MORE, INBOUND_EMAIL_LIST_MAX))} disabled={limit >= INBOUND_EMAIL_LIST_MAX}>Show more</Button>
    </div>}
  </>;
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
    : 'Owner reviews';

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
        {inboxes.map((inbox) => {
          const name = inbox.kind === 'agent' ? inbox.agent.name : inbox.label;
          const active = inbox.status === 'active';
          return <li key={inbox.id} data-state={inbox.status}>
            <Item
              className="email-agent-head"
              media={<span className="email-agent-mark"><Glass name={inbox.kind === 'agent' ? 'iris' : 'inbox'} size={24} /></span>}
              title={<><h4>{name}</h4>{active
                ? <StatusDot tone="ok" label="Receiving" />
                : <StatusDot tone="warn" label="Paused" hint="New email is turned away until you resume." />}</>}
              description={<>
                <span className="email-agent-fact"><Icon name="users" size={14} />{inbox.kind === 'agent' ? reviewers(inbox) : `Read by ${inbox.agent.name}`}</span>
                <span className="email-agent-fact"><Icon name="mail" size={14} />{inbox.message_count} {inbox.message_count === 1 ? 'email' : 'emails'}</span>
              </>}
              actions={<>
                <Button small disabled={busyId !== null} onClick={() => void setStatus(inbox, active ? 'paused' : 'active')}>
                  <Icon name={active ? 'pause' : 'play'} size={14} />{active ? 'Pause' : 'Resume'}
                </Button>
                <Button small danger disabled={busyId !== null} onClick={() => setRemoving(inbox)}>
                  {inbox.kind === 'agent' ? 'Replace address' : 'Remove address'}
                </Button>
              </>}
            />
            <CopyAddress address={inbox.address} name={name} />
            <RecentMail inbox={inbox} />
          </li>;
        })}
      </ul>}
    {inboxes.length > 0 && <details className="admin-help">
      <summary>How to send email to an agent</summary>
      <ol>
        <li>Email the agent’s address directly, or copy it on a thread.</li>
        <li>To route a shared address such as partners@ to an agent, in Google Workspace: Admin console → Apps → Google Workspace → Gmail → Routing → Add another rule.</li>
        <li>In Microsoft 365: Exchange admin center → Mail flow → Rules → Add a rule that sends a copy to the address.</li>
      </ol>
    </details>}
    {removing && <Dialog open title={removing.kind === 'agent' ? `Replace ${removing.agent.name}’s address?` : `Remove ${removing.label}?`} onClose={() => setRemoving(null)} actions={<>
      <Button onClick={() => setRemoving(null)}>Keep it</Button>
      <Button primary danger disabled={busyId === removing.id} onClick={() => void remove(removing)}>{removing.kind === 'agent' ? 'Replace address' : 'Remove address'}</Button>
    </>}>
      <p className="email-inbox-confirm"><code>{removing.address}</code> stops working and its {removing.message_count === 1 ? 'email is' : `${removing.message_count} emails are`} deleted. {removing.kind === 'agent'
        ? `${removing.agent.name} gets a new address right away.`
        : `${removing.agent.name} stops reading it.`} Decisions stay in History. This can’t be undone.</p>
    </Dialog>}
  </>;
}
