// History, Members, Library and Settings.
//
// History reads `events` rows — the demo's fabricated local event log is gone,
// along with `eventTime()` and `uid('evt')`. Members read the WorkOS mirror.
// Settings carries personal preferences and member-safe connection/privacy facts.
// Admin carries workspace configuration and the irreversible controls behind step-up.
//
// FilterTable supports History.
// Run limits use explicit saves. Members use the product’s own inline rows
// (decision C46) — `RecordsTable` is a database surface and a membership list
// is not one.
import { BrandIcon } from '../ui/brand-icons.js';
import { AdminConnections } from './AdminConnections.js';
import { useEffect, useMemo, useState, type JSX, type ReactNode } from 'react';
import { FilterTable } from '@hermes/motion-components';
import { ADMIN, CTX, LIB, MEMBERS, REQ, SETTINGS, memberProvisioningPresentation, type ApprovalRoute, type DataPrivacy, type DocumentEntity, type EnterpriseSkillAssignment, type EventRow, type InboundEmailConnection, type InboundEmailThreadImport, type InvitationEntity, type LibrarySource, type MaskedProviderKey, type MemberEntity, type MemberRoleTemplate, type OutboundEmailConnection, type SettingsView, type SlackConnection, type UsageRange, type UsageReport, type WorkspaceRole } from '@hermes/shared';
import { useAdapter, useAppState, useDispatch, useEntity, useIsAdmin, useNav } from '../store-context.js';
import { Glass, Icon, KIND_ICON } from '../ui/icons.js';
import { Ack, Avatar, Button, Dialog, EmptyState, MenuItem, Panel, Skeleton, Tabs, Toggle, Pill } from '../ui/primitives.js';
import { ADMIN_SETTINGS_GROUPS, ADMIN_VIEW_ALIASES, DEFAULT_PROVIDER, EMPTY, LIBRARY_TABS, PROVIDER_CHOICES, SETTINGS_TABS } from '../../model/constants.js';
import { LIST_KEYS, agentName, catalogRows, memberCounts, requestStatusLabel } from '../selectors.js';
import { storeStepUp } from '../../model/auth.js';
import { useWorkspaceLists } from './lists.js';
import { DocumentView } from './Inbox.js';
import { ProviderConnect, type ProviderConnectStatus } from '../providers/ProviderConnect.js';
import { PartnerWorkflow } from './PartnerWorkflow.js';
import { invitationDeliveryMessage, invitationFailureMessage, invitationSuccessMessage } from '../../model/invitation-copy.js';
import { RuntimeCapacityTab } from './RuntimeCapacity.js';
import { SharedIntelligence } from './SharedIntelligence.js';
import { CloudConnection } from './CloudConnection.js';
import { cloudConnectionErrorMessage, type CloudConnectionStatus } from '../../model/cloud-connection.js';
import { Markdown } from '../chat/Markdown.js';
import { AdminSharedIntelligence } from './AdminSharedIntelligence.js';
import { AdminDetailLayout, AdminSettingsCard, AdminPageHeader, type ConnectionBadge } from './AdminDetailLayout.js';
import { AdminAgents } from './AdminAgents.js';
import { AdminRoles, roleNamesFor } from './AdminRoles.js';
import { AdminApprovals } from './AdminApprovals.js';
import { AdminEmailInboxes } from './AdminEmailInboxes.js';
import { CanApprove, RoleChecklist, jobLockedRole, knownRoleSlugs } from './MemberRoles.js';
import { useStepUp } from './use-step-up.js';
import { AdminWallets } from './Wallets.js';
import { AdminRunLimits } from './AdminRunLimits.js';

/**
 * History, with `FilterTable` over the rows (plan 10b).
 *
 * Two axes, and they are not the same axis. The tabs pick which *kind* of
 * activity is listed — everything, decisions only, blocked only — because that
 * is the question a reviewer asks. The table's own filter picks the *state* a
 * row is in, which is the question an operator asks. Neither is derived from
 * the other, so both are offered and both are labelled.
 *
 * `FilterTable`'s three states are mapped from the server's `status` word.
 * The Worker (domain/history.ts) writes one vocabulary: the words in
 * `NEEDS_PERSON` mean the row's subject is waiting on somebody right now;
 * every other word is a finished state (Sent, Handled, Added, Retried…), so
 * finished work never reads "Working". The Blocked tab lists the same
 * `NEEDS_PERSON` rows the table marks "Needs review".
 */
const NEEDS_PERSON = new Set(['Needs review', 'Waiting', 'Stopped', 'Needs attention']);
const DECISION_KINDS = new Set(['decision.recorded', 'approval.vote_recorded', 'approval.finalized']);
export const historyState = (row: EventRow): 'todo' | 'progress' | 'done' => (NEEDS_PERSON.has(row.status) ? 'todo' : 'done');

export function History() {
  const state = useAppState();
  const dispatch = useDispatch();
  const nav = useNav();
  const lists = useWorkspaceLists();
  const tab = state.ui.historyTab;
  const events = useMemo(
    () => lists.history.filter((row) => (tab === 'decisions' ? DECISION_KINDS.has(row.kind) : tab === 'blocked' ? NEEDS_PERSON.has(row.status) : true)),
    [lists.history, tab],
  );
  const emptyCopy = tab === 'decisions' ? EMPTY.historyDecisions : tab === 'blocked' ? EMPTY.historyBlocked : EMPTY.historyAll;
  // The table takes strings, so the row it hands back is matched on the same
  // strings. `task` is unique enough in practice and the lookup falls back to
  // the index, so an open never lands on the wrong event.
  const tableRows = useMemo(
    () =>
      events.slice(0, 200).map((row) => ({
        task: row.text,
        date: new Date(row.at).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }),
        status: historyState(row),
        owner: row.actor_name,
      })),
    [events],
  );

  return (
    <div className="scroll">
      <div className="app-body">
        <div className="row" style={{ height: 42 }}>
          <h1 className="display-32">History</h1>
        </div>
        <Tabs
          tabs={[
            { id: 'all', label: 'All activity' },
            { id: 'decisions', label: 'Decisions' },
            { id: 'blocked', label: 'Blocked' },
          ]}
          value={tab}
          onChange={(value) => dispatch({ type: 'nav/tab', key: 'historyTab', value })}
          label="History views"
        />
        {tab !== 'blocked' && (
          <Panel
            icon="admission"
            title={state.counts.decisions ? `${state.counts.decisions} decision${state.counts.decisions === 1 ? '' : 's'} recorded` : EMPTY.historyDecisions}
            subtitle={`${state.counts.pendingGrants} access grant${state.counts.pendingGrants === 1 ? '' : 's'} pending · ${state.counts.inbox} request${state.counts.inbox === 1 ? '' : 's'} still waiting`}
          />
        )}
        {events.length === 0 ? (
          <EmptyState icon="trace" title={emptyCopy} />
        ) : (
          <div className="hermes-ui table-host">
            <FilterTable
              rows={tableRows}
              labels={{ columns: { task: 'Activity', date: 'When', status: 'State', owner: 'Who' } }}
              onOpenRow={(row) => {
                const found = events.find((event) => event.text === row.task);
                if (!found) return;
                if (found.ref) nav(found.ref);
                else if (found.request_id) nav(REQ(found.request_id));
              }}
            />
          </div>
        )}
        {events.length > 200 && <p className="meta">Showing the most recent 200 of {events.length}.</p>}
      </div>
    </div>
  );
}

/**
 * Members, over the product's own inline rows (decision C46).
 *
 * This screen was briefly `RecordsTable`, the library's database surface, and
 * it brought a database's furniture with it: a selection checkbox column, an
 * "Add calculation" affordance, a horizontal scroller and — from the library's
 * fixture columns — an "Evidence" header that means nothing about a colleague.
 * A membership list is a list of people, so it is a list: avatar, name, the
 * two pills that say what they are and where they stand, when they joined, and
 * the one action that row affords.
 *
 * The two tabs are two different tables, because they are two different rows.
 * "All members" reads the WorkOS membership mirror; "Invitations" reads the
 * invitations list, which is where an unaccepted invitation actually lives —
 * the mirror only ever holds people who have accepted, so the old tab (members
 * filtered to a non-active status) was filtering a set the server never fills.
 */
const memberStatusLabel = (status: MemberEntity['status']): string =>
  status === 'active' ? 'Joined' : status === 'invited' ? 'Invited' : status === 'expired' ? 'Expired' : 'Removed';

const invitationStatusLabel = (status: InvitationEntity['status']): string =>
  status === 'pending' ? 'Invited' : status === 'expired' ? 'Expired' : status === 'withdrawn' ? 'Withdrawn' : status === 'bounced' ? 'Bounced' : status === 'resent' ? 'Resent' : 'Accepted';

/** The pill's tone, and the only thing about a person this screen colours. */
const statusTone = (label: string): string => (label === 'Joined' ? 'ok' : label === 'Expired' || label === 'Bounced' ? 'warn' : 'muted');

export function Members() {
  const state = useAppState();
  const adapter = useAdapter();
  const nav = useNav();
  const admin = useIsAdmin();
  const lists = useWorkspaceLists();
  const [tab, setTab] = useState('all');
  const [invite, setInvite] = useState(false);
  const [email, setEmail] = useState('');
  const [jobRole, setJobRole] = useState<MemberRoleTemplate>('partnerships-agent');
  const [ack, setAck] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // The refusal behind `notice`, so a stale sign-in can offer a fresh one.
  const [noticeProblem, setNoticeProblem] = useState<unknown>(null);
  const [inviteProblem, setInviteProblem] = useState<unknown>(null);
  const [pending, setPending] = useState<string | null>(null);
  // Roles chosen in the Invite dialog, and the draft of a managed member's roles.
  const [inviteRoles, setInviteRoles] = useState<string[]>([]);
  const { needsSignIn, signIn } = useStepUp('workspace_roles');
  useEffect(() => { if (!admin && tab !== 'all') setTab('all'); }, [admin, tab]);
  // Role names for each person's role slugs. Admin only, like the slugs
  // themselves; if the list cannot load, the cards simply show no roles.
  const [roles, setRoles] = useState<WorkspaceRole[]>([]);
  useEffect(() => {
    if (!admin) { setRoles([]); return; }
    let live = true;
    void adapter.rest.listRoles(state.workspace.id)
      .then((list) => { if (live) setRoles(list.items); })
      .catch(() => { if (live) setRoles([]); });
    return () => { live = false; };
  }, [adapter, admin, state.workspace.id]);
  // Who approves what, for the "Can approve" lines. Admin only, like the page
  // it comes from; if it cannot load, the lines are left out rather than guessed.
  const [routes, setRoutes] = useState<ApprovalRoute[] | null>(null);
  useEffect(() => {
    if (!admin) { setRoutes(null); return; }
    let live = true;
    void adapter.rest.listApprovalRoutes(state.workspace.id)
      .then((list) => { if (live) setRoutes(list.items); })
      .catch(() => { if (live) setRoutes(null); });
    return () => { live = false; };
  }, [adapter, admin, state.workspace.id]);
  const setupOnly = state.capabilities.memberInvitationMode === 'setup_only';
  const setupRoles = state.capabilities.memberRoleTemplates;
  const selectedJobRole = setupRoles.includes(jobRole) ? jobRole : setupRoles[0] ?? null;
  // The job's role is granted when the person joins, whatever is ticked, so
  // the checklist shows it ticked and fixed (C97). It follows the job picker;
  // the Admin's own ticks stay in `inviteRoles` and survive a job change.
  const jobRoleLock = jobLockedRole(roles, setupOnly ? selectedJobRole : 'partnerships-agent');
  const inviteRoleSlugs = knownRoleSlugs(inviteRoles, roles).filter((slug) => slug !== jobRoleLock?.slug);
  const counts = memberCounts(state);
  const all = lists.members;
  // Withdrawn and accepted invitations are history, and History is where they
  // are read; this tab is the ones an Admin can still do something about.
  const invitations = lists.invitations.filter((row) => row.status === 'pending' || row.status === 'expired');
  const invitationsChanged = () => {
    adapter.invalidateList('invitations');
    adapter.invalidateList('members');
  };
  const showAck = (message: string): void => {
    setAck(message);
    setTimeout(() => setAck(null), 1600);
  };
  const runInvitationAction = (action: 'resend' | 'withdraw', row: InvitationEntity): void => {
    const key = `${action}:${row.id}`;
    setPending(key);
    setNotice(null);
    const request = action === 'resend'
      ? adapter.rest.resendInvitation(state.workspace.id, row.id)
      : adapter.rest.withdrawInvitation(state.workspace.id, row.id);
    void request
      .then((result) => {
        invitationsChanged();
        showAck(action === 'resend'
          ? invitationSuccessMessage(result as InvitationEntity)
          : 'Invitation withdrawn');
      })
      .catch((error: unknown) => {
        setNoticeProblem(error);
        setNotice(action === 'resend'
          ? invitationFailureMessage(error)
          : 'Could not withdraw that invitation. Try again.');
      })
      .finally(() => setPending(null));
  };

  return (
    <div className="scroll">
      <div className="app-body">
        <div className="row members-header" style={{ minHeight: 42 }}>
          <h1 className="display-32">Members</h1>
          <span className="grow" />
          <span className="meta">
            {counts.joined} joined · {counts.invited} pending
          </span>
          {admin && <Button onClick={() => {
            setNotice(null);
            setInviteProblem(null);
            setInviteRoles([]);
            setInvite(true);
          }}>Invite member</Button>}
        </div>
        <Tabs
          tabs={[
            { id: 'all', label: 'All members' },
            ...(admin ? [{ id: 'invites', label: 'Invitations' }] : []),
          ]}
          value={tab}
          onChange={(next) => {
            setNotice(null);
            setTab(next);
          }}
          label="Member views"
        />
        {tab === 'all' ? (
          all.length === 0 ? (
            <EmptyState icon="people" title="No members yet" />
          ) : (
            <div className="member-card-list" role="list">
              {all.map((member) => {
                const status = memberStatusLabel(member.status);
                const roleNames = admin ? roleNamesFor(member, roles) : [];
                return (
                  <div className="member-card" role="listitem" key={member.id}>
                    <div className="member-card-identity">
                      <Avatar person={{ name: member.name }} size={40} />
                      <div className="row-main">
                        <span className="member-card-title truncate">
                          {member.name}
                          {member.user_id === state.user.id && <span className="meta"> · You</span>}
                        </span>
                        {member.email && <span className="member-card-email truncate">{member.email}</span>}
                      </div>
                    </div>
                    <div className="member-card-facts">
                      <Pill>{member.role === 'admin' ? 'Admin' : 'Member'}</Pill>
                      <Pill tone={statusTone(status)}>{status}</Pill>
                    </div>
                    <div className="member-card-summary">
                      {roleNames.length > 0 && <span className="member-card-roles">{roleNames.join(', ')}</span>}
                      <span>{member.joined_at ? `Joined ${new Date(member.joined_at).toLocaleDateString()}` : 'Not joined yet'}</span>
                    </div>
                    {(admin || member.user_id === state.user.id) && <div className="member-card-actions"><Button onClick={() => nav({ section: 'members', id: member.id, sub: 'overview' })}>Manage</Button></div>}
                  </div>
                );
              })}
            </div>
          )
        ) : invitations.length === 0 ? (
          <EmptyState icon="people" title={EMPTY.invitations} />
        ) : (
          <div className="member-card-list" role="list">
            {invitations.map((row) => {
              const provisioning = row.status !== 'expired' && row.provisioning
                ? memberProvisioningPresentation(row.provisioning, { setupEnabled: setupOnly })
                : null;
              const status = provisioning?.label ?? invitationStatusLabel(row.status);
              const delivery = invitationDeliveryMessage(row);
              const invitedRoles = roleNamesFor({ reviewer_roles: row.role_slugs ?? [] }, roles);
              return (
                <div className="member-card member-invitation-card" role="listitem" key={row.id}>
                  <div className="member-card-identity">
                    <Avatar person={{ name: row.email }} size={40} />
                    <div className="row-main">
                      <span className="member-card-title truncate">{row.email}</span>
                      <span className="member-card-email">
                        {row.provisioning && row.provisioning.delivery === 'not_queued' ? 'Setup requested' : 'Invited'}{' '}
                        {new Date(row.invited_at).toLocaleDateString()}
                      </span>
                      {invitedRoles.length > 0 && <span className="member-card-roles">Gets {invitedRoles.join(', ')} when they join</span>}
                    </div>
                  </div>
                  <div className="member-card-facts">
                    <Pill>{row.role_template_key === 'finance-agent' ? 'Finance' : row.role_template_key === 'partnerships-agent' ? 'Partnerships' : row.role === 'admin' ? 'Admin' : 'Member'}</Pill>
                  </div>
                  <div className="member-card-status" data-tone={provisioning?.tone ?? 'neutral'}>
                    <i aria-hidden="true" />
                    <div>
                      <strong>{status}</strong>
                      <span>{provisioning?.detail ?? delivery ?? 'Waiting for them to join.'}</span>
                    </div>
                  </div>
                  {admin && (
                    <div className="member-card-actions">
                      {(provisioning?.action === 'connect_cloud' || provisioning?.action === 'review_billing') && (
                        <Button onClick={() => nav(ADMIN('Organization'))}>Cloud settings</Button>
                      )}
                      {/* One route behind two words: the server resends a
                          pending invitation and an expired one alike. */}
                      {(!provisioning || provisioning.action === 'resend') && <Button
                        disabled={pending !== null}
                        onClick={() => {
                          runInvitationAction('resend', row);
                        }}
                      >
                        {pending === `resend:${row.id}` ? 'Sending…' : row.status === 'expired' ? 'Reinvite' : 'Resend'}
                      </Button>}
                      {(!provisioning || provisioning.canCancel) && <Button
                        link
                        disabled={pending !== null}
                        onClick={() => {
                          runInvitationAction('withdraw', row);
                        }}
                      >
                        {pending === `withdraw:${row.id}` ? 'Cancelling…' : provisioning ? 'Cancel' : 'Withdraw'}
                      </Button>}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {!admin && <p className="meta">Read-only. Roles and removals are an Admin&apos;s.</p>}
        {notice && <p className="meta action-error" role="alert">
          {notice}{' '}{needsSignIn(noticeProblem) && <Button link onClick={signIn}>Sign in again</Button>}
        </p>}
        <Ack show={!!ack} style={{ right: 0, top: -12, position: 'relative' }}>
          {ack}
        </Ack>
        <Dialog
          open={invite}
          title="Invite member"
          onClose={() => {
            if (pending === 'invite') return;
            setInvite(false);
            setInviteProblem(null);
          }}
          actions={
            <>
              <Button disabled={pending === 'invite'} onClick={() => {
                setInvite(false);
                setInviteProblem(null);
              }}>Cancel</Button>
              <Button
                primary
                disabled={pending === 'invite' || !/^[\w.+-]+@[\w-]+\.[\w.-]+$/.test(email) || (setupOnly && !selectedJobRole)}
                onClick={() => {
                  setPending('invite');
                  setInviteProblem(null);
                  // The job's own role is not sent: the job grants it, and sending
                  // it would make every invitation look like one that grants roles.
                  const roleSlugs = inviteRoleSlugs;
                  const request = {
                    email,
                    role: 'member' as const,
                    ...(setupOnly && selectedJobRole ? { role_template_key: selectedJobRole } : {}),
                    ...(roleSlugs.length ? { role_slugs: roleSlugs } : {}),
                  };
                  void adapter.rest
                    .invite(state.workspace.id, request)
                    .then((created) => {
                      invitationsChanged();
                      setEmail('');
                      setInviteRoles([]);
                      setInvite(false);
                      setTab('invites');
                      showAck(invitationSuccessMessage(created));
                    })
                    .catch(setInviteProblem)
                    .finally(() => setPending(null));
                }}
              >
                {pending === 'invite' ? setupOnly ? 'Starting…' : 'Sending…' : setupOnly ? 'Start setup' : 'Send invitation'}
              </Button>
            </>
          }
        >
          <label className="field">
            <span className="sr-only">Work email</span>
            <input type="email" placeholder="name@example.com" value={email} onChange={(event) => setEmail(event.target.value)} />
          </label>
          {setupOnly && <label className="field">
            <span>Job role</span>
            <select value={selectedJobRole ?? ''} onChange={(event) => setJobRole(event.target.value as MemberRoleTemplate)}>
              {setupRoles.map((role) => <option key={role} value={role}>{role === 'finance-agent' ? 'Finance' : 'Partnerships'}</option>)}
            </select>
          </label>}
          <p className="meta">{setupOnly
            ? 'Hermes sets up an agent for them first. The invitation email goes out once it is ready.'
            : 'Hermes sets aside an agent for them. Their card shows whether the invitation email was sent.'}</p>
          {setupOnly && !setupRoles.includes('finance-agent') && <p className="meta">
            Finance appears here once a Finance agent is added under Admin → Capacity.
          </p>}
          {roles.length > 0 && <div className="member-approvals">
            <RoleChecklist roles={roles} selected={inviteRoles} locked={jobRoleLock} disabled={pending === 'invite'} onChange={setInviteRoles} />
            <CanApprove routes={routes} person={{ role: 'member', reviewer_roles: jobRoleLock ? [...inviteRoleSlugs, jobRoleLock.slug] : inviteRoleSlugs }} />
          </div>}
          {inviteProblem !== null && <p className="meta action-error" role="alert">
            {invitationFailureMessage(inviteProblem)}{' '}{needsSignIn(inviteProblem) && <Button link onClick={signIn}>Sign in again</Button>}
          </p>}
        </Dialog>

      </div>
    </div>
  );
}

export function Library({ view, id }: { view: string; id: string | null }) {
  const nav = useNav();
  if (view === 'documents' && id) return <SavedDocument id={id} />;
  return (
    <div className="scroll">
      <div className="app-body" style={{ minHeight: '100%' }}>
        <div className="row" style={{ height: 42 }}>
          <h1 className="display-32">Library</h1>
        </div>
        <Tabs tabs={LIBRARY_TABS} value={view} onChange={(next) => nav(LIB(next))} label="Library sections" />
        {view === 'handoffs' && <PartnerWorkflow />}
        {view === 'skills' && <LibrarySkills />}
        {view === 'documents' && <LibraryDocuments />}
        {/* Connections and Shared Intelligence are independent, reviewed Library workflows. */}
        {view === 'connections' && <LibraryConnections />}
        {view === 'intelligence' && <SharedIntelligence />}
      </div>
    </div>
  );
}

/**
 * The result an OAuth callback left in the URL (`?gmail=connected`,
 * `?gmail_evidence=failed`), read once and then removed so a reload or a
 * shared link does not repeat it.
 */
function useCallbackResult(param: string): 'connected' | 'failed' | null {
  const [result] = useState<'connected' | 'failed' | null>(() => {
    try {
      const value = new URL(window.location.href).searchParams.get(param);
      return value === 'connected' || value === 'failed' ? value : null;
    } catch {
      return null;
    }
  });
  useEffect(() => {
    if (!result) return;
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete(param);
      window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
    } catch {
      // Leaving the parameter in place only repeats a message.
    }
  }, [param, result]);
  return result;
}

const plural = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

function LibraryConnections() {
  const state = useAppState();
  const adapter = useAdapter();
  const nav = useNav();
  const admin = useIsAdmin();
  const [inbound, setInbound] = useState<InboundEmailConnection | null>(null);
  const [outbound, setOutbound] = useState<OutboundEmailConnection | null>(null);
  const [threadId, setThreadId] = useState('');
  const [busy, setBusy] = useState<'connect' | 'import' | 'disconnect' | null>(null);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const callback = useCallbackResult('gmail_evidence');
  const [notice, setNotice] = useState<string | null>(() => (callback === 'connected'
    ? 'Read-only Gmail is connected.'
    : callback === 'failed' ? 'Gmail was not connected. Nothing changed. Try again.' : null));
  const [result, setResult] = useState<InboundEmailThreadImport | null>(null);

  const load = (): void => {
    if (!state.workspace.id) return;
    void Promise.all([
      adapter.rest.inboundEmailConnection(state.workspace.id),
      adapter.rest.outboundEmailConnection(state.workspace.id),
    ]).then(([readConnection, sendConnection]) => {
      setInbound(readConnection);
      setOutbound(sendConnection);
    }).catch(() => setNotice('Connection status could not be loaded. Try again.'));
  };
  useEffect(load, [adapter, state.workspace.id]);

  const stepUp = (): boolean => {
    const url = adapter.auth.stepUpUrl(window.location.href, 'gmail');
    if (url) {
      window.location.assign(url);
      return true;
    }
    setNotice('This needs a recent sign-in. Sign in again to continue.');
    return false;
  };
  const errorNotice = (caught: unknown): void => {
    const error = caught as { status?: number; reason?: string };
    if (error.status === 401 && error.reason === 'reauth_required') {
      stepUp();
      return;
    }
    setNotice(error.reason === 'admin_required' ? EMPTY.adminRequired
      : error.reason === 'gmail_evidence_unavailable' ? 'Read-only Gmail is not available on this deployment yet. Ask the person who runs Hermes for your company to turn it on.'
        : error.reason === 'gmail_evidence_not_connected' ? 'Connect read-only Gmail before saving a conversation.'
          : 'That did not work. Nothing was sent or changed.');
  };
  const connect = async (): Promise<void> => {
    setBusy('connect');
    setNotice(null);
    try {
      const started = await adapter.rest.startGmailEvidenceOAuth(state.workspace.id);
      window.location.assign(started.authorize_url);
    } catch (caught) {
      errorNotice(caught);
      setBusy(null);
    }
  };
  // Hermes erases its stored read access; saved conversations stay (docs/CONNECTORS.md).
  const disconnect = async (): Promise<void> => {
    setBusy('disconnect');
    setNotice(null);
    try {
      await adapter.rest.disconnectGmailEvidence(state.workspace.id);
      setDisconnectOpen(false);
      setNotice('Read-only Gmail is disconnected. Saved conversations stay in your Library.');
      load();
    } catch (caught) {
      setDisconnectOpen(false);
      errorNotice(caught);
    } finally {
      setBusy(null);
    }
  };
  const importThread = async (): Promise<void> => {
    if (!state.agent.id || threadId.trim().length < 4) return;
    setBusy('import');
    setNotice(null);
    setResult(null);
    try {
      const imported = await adapter.rest.importGmailEvidenceThread(state.workspace.id, {
        agent_id: state.agent.id,
        thread_id: threadId.trim(),
      });
      setResult(imported);
      setThreadId('');
      setInbound((current) => current ? {
        ...current,
        imported_threads: current.imported_threads + (imported.created ? 1 : 0),
        latest_import_at: imported.imported_at,
      } : current);
    } catch (caught) {
      errorNotice(caught);
    } finally {
      setBusy(null);
    }
  };

  if (!inbound || !outbound) return <Skeleton rows={6} label="Loading connections" />;
  const connected = inbound.status === 'connected';
  return (
    <div className="col">
      {notice && <Ack show>{notice}</Ack>}
      {result && (
        <Ack show>
          {result.created ? 'Saved to your Library.' : 'This conversation was already saved.'}
          {' '}Found {plural(result.events.replies, 'reply', 'replies')}, {plural(result.events.bounces, 'possible bounce', 'possible bounces')} and {plural(result.events.unsubscribes, 'unsubscribe request', 'unsubscribe requests')}. Nothing was sent.
        </Ack>
      )}
      <Panel
        icon="context"
        title={connected ? (admin && inbound.address ? `Read-only Gmail · ${inbound.address}` : 'Read-only Gmail connected') : inbound.configured ? 'Connect read-only Gmail' : 'Read-only Gmail is not available yet'}
        subtitle={connected
          ? 'Hermes can only read the one conversation you choose. It cannot send from this account.'
          : inbound.configured
            ? 'Hermes never lists or searches the mailbox. This is separate from the account Hermes sends from.'
            : 'Ask the person who runs Hermes for your company to turn it on.'}
        right={admin && inbound.configured ? (
          <div className="sender-actions">
            {connected && <Button danger disabled={busy !== null} onClick={() => setDisconnectOpen(true)}>Disconnect</Button>}
            <Button primary={!connected} disabled={busy !== null} onClick={() => void connect()}>
              {busy === 'connect' ? 'Opening Google…' : connected ? 'Reconnect' : 'Connect'}
            </Button>
          </div>
        ) : undefined}
      >
        <div className="kv"><span className="grow">Access</span><span className="meta">Read only</span></div>
        <div className="kv"><span className="grow">What Hermes reads</span><span className="meta">One conversation at a time, chosen by an Admin</span></div>
        {admin && <div className="kv"><span className="grow">Saved conversations</span><span className="meta">{inbound.imported_threads}</span></div>}
        {!admin && <p className="meta">A workspace Admin manages this connection and saves conversations.</p>}
      </Panel>
      {connected && admin && (
        <Panel
          icon="document"
          title="Save a Gmail conversation to the Library"
          subtitle="Hermes reads the conversation once and saves a copy. Nothing in Gmail changes."
        >
          <div className="row" style={{ alignItems: 'end' }}>
            <label className="field grow">
              <span>Conversation ID</span>
              <input
                value={threadId}
                onChange={(event) => setThreadId(event.target.value)}
                placeholder="Paste the conversation ID"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            <Button primary disabled={busy !== null || threadId.trim().length < 4 || !state.agent.id} onClick={() => void importThread()}>
              {busy === 'import' ? 'Saving…' : 'Save to Library'}
            </Button>
          </div>
          <p className="meta">A reply or an unsubscribe request in the conversation stops future outreach to that person. Something that only looks like a bounce is noted, but never stops outreach on its own. Saving never sends email.</p>
        </Panel>
      )}
      <Panel
        icon="send"
        title={outbound.status === 'connected' ? (admin && outbound.address ? `Sending from ${outbound.address}` : 'Sending account connected') : 'No sending account connected'}
        subtitle="Sending is set up separately, in Admin → Email. Permission to read is never used to send."
        right={admin ? <Button link onClick={() => nav(ADMIN('Email'))}>Open Email settings</Button> : undefined}
      >
        <div className="kv"><span className="grow">What gets sent</span><span className="meta">{outbound.mode === 'send_after_approval' ? 'Only emails a person approved, exactly as approved' : 'Nothing. Approved emails are saved as drafts'}</span></div>
        {admin && <div className="kv"><span className="grow">Waiting to send</span><span className="meta">{outbound.pending_messages}</span></div>}
      </Panel>
      <Dialog
        open={disconnectOpen}
        title="Disconnect read-only Gmail?"
        onClose={() => setDisconnectOpen(false)}
        actions={<><Button onClick={() => setDisconnectOpen(false)}>Cancel</Button><Button danger primary disabled={busy !== null} onClick={() => void disconnect()}>{busy === 'disconnect' ? 'Disconnecting…' : 'Disconnect'}</Button></>}
      >
        <p>Hermes deletes its read access to {inbound.address ?? 'this mailbox'} and can’t save more conversations from it. Conversations already saved stay in your Library.</p>
        <p className="meta">To remove Hermes from the Google account as well, remove it in that account’s security settings.</p>
      </Dialog>
    </div>
  );
}

function LibrarySkills() {
  const state = useAppState();
  const adapter = useAdapter();
  const admin = useIsAdmin();
  const lists = useWorkspaceLists();
  const [ack, setAck] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [assignments, setAssignments] = useState<EnterpriseSkillAssignment[]>([]);
  const [editing, setEditing] = useState<string | null>(null);
  const agentId = state.agent.id;
  useEffect(() => {
    if (!agentId) return;
    let current = true;
    void adapter.rest.listSkillAssignments(state.workspace.id, agentId)
      .then((page) => { if (current) setAssignments(page.items); })
      .catch(() => undefined);
    return () => { current = false; };
  }, [adapter.rest, agentId, state.workspace.id]);
  return (
    <div className="col">
      {error && <p className="meta action-error" role="alert">{error}</p>}
      {lists.skills.length === 0 && <EmptyState icon="skill" title="No shared skills yet" />}
      {lists.skills.map((skill) => {
        const assignment = assignments.find((item) => `managed:${item.skill_key}` === skill.id);
        return (
          <div key={skill.id} className="skill-assignment-shell">
            <div className="list-row" style={{ minHeight: 112 }}>
              <Glass name="skill" size={32} className="row-icon" />
              <div className="row-main">
                <span className="t">{skill.name}</span>
                <span className="s">
                  {skill.description} · Shared by {skill.shared_by}
                  {assignment ? ` · ${assignment.state === 'active' ? 'Active' : 'Paused'}` : ''}
                </span>
              </div>
              <span style={{ position: 'relative', display: 'flex', gap: 8 }}>
                {assignment && (
                  <Button disabled={!admin} onClick={() => setEditing(editing === assignment.id ? null : assignment.id)}>
                    {editing === assignment.id ? 'Close' : admin ? 'Configure' : EMPTY.adminRequired}
                  </Button>
                )}
                {!assignment && (
                  <Button
                    disabled={skill.adopted || !admin}
                    onClick={() => {
                      setError(null);
                      void adapter.rest
                        .adoptSkill(state.workspace.id, skill.id)
                        .then(() => {
                          adapter.invalidateList(LIST_KEYS.skills);
                          setAck(skill.id);
                          setTimeout(() => setAck(null), 1600);
                        })
                        .catch(() => setError('Could not add that skill. Try again.'));
                    }}
                  >
                    {skill.adopted ? 'In use' : admin ? 'Add' : EMPTY.adminRequired}
                  </Button>
                )}
                <Ack show={ack === skill.id} style={{ right: 0, top: -40 }}>Added</Ack>
              </span>
            </div>
            {assignment && editing === assignment.id && agentId && (
              <SkillAssignmentEditor
                assignment={assignment}
                onCancel={() => setEditing(null)}
                onSave={async (patch) => {
                  const next = await adapter.rest.updateSkillAssignment(state.workspace.id, agentId, assignment.id, patch);
                  setAssignments((items) => items.map((item) => item.id === next.id ? next : item));
                  setEditing(null);
                }}
              />
            )}
          </div>
        );
      })}
    </div>
  );
}

function valueAt(config: Record<string, unknown>, path: string): unknown {
  return path.split('.').reduce<unknown>((value, key) =>
    value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>)[key] : undefined, config);
}

function valueWith(config: Record<string, unknown>, path: string, value: unknown): Record<string, unknown> {
  const next = structuredClone(config);
  const keys = path.split('.');
  let cursor = next;
  keys.slice(0, -1).forEach((key) => {
    const child = cursor[key];
    if (!child || typeof child !== 'object' || Array.isArray(child)) cursor[key] = {};
    cursor = cursor[key] as Record<string, unknown>;
  });
  cursor[keys.at(-1)!] = value;
  return next;
}

export function SkillAssignmentEditor({
  assignment,
  onCancel,
  onSave,
}: {
  assignment: EnterpriseSkillAssignment;
  onCancel: () => void;
  onSave: (patch: { revision: number; state: 'active' | 'paused'; config: Record<string, unknown>; schedule: { enabled: boolean; interval_minutes: number } }) => Promise<void>;
}) {
  const [config, setConfig] = useState<Record<string, unknown>>(() => structuredClone(assignment.config));
  const [state, setState] = useState<'active' | 'paused'>(assignment.state);
  const [schedule, setSchedule] = useState(assignment.schedule);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <form
      className="skill-config-panel"
      onSubmit={(event) => {
        event.preventDefault();
        if (saving) return;
        setSaving(true);
        setError(null);
        void onSave({ revision: assignment.revision, state, config, schedule }).catch((caught: unknown) => {
          setSaving(false);
          setError((caught as { reason?: string }).reason === 'stale_revision'
            ? 'This skill changed in another window. Your changes are kept here. Reload to see the latest settings before saving again.'
            : 'Could not save. Your changes are kept here. Check the settings and try again.');
        });
      }}
    >
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div className="t">How {assignment.agent_name ?? 'this agent'} performs this skill</div>
          <div className="s">Every saved change is kept. Outreach stays a draft until a person approves it.</div>
        </div>
        <label className="skill-config-compact-field">
          <span>Status</span>
          <select value={state} onChange={(event) => setState(event.target.value as 'active' | 'paused')}>
            <option value="active">Active</option>
            <option value="paused">Paused</option>
          </select>
        </label>
      </div>
      <div className="skill-config-grid">
        {assignment.config_fields.map((field) => {
          const current = valueAt(config, field.path);
          const update = (value: unknown) => setConfig((previous) => valueWith(previous, field.path, value));
          return (
            <label key={field.path} className="skill-config-field">
              <span>{field.label}</span>
              {field.kind === 'select' ? (
                <select value={String(current ?? '')} onChange={(event) => update(event.target.value)}>
                  {field.options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
                </select>
              ) : field.kind === 'integer' ? (
                <input type="number" min={field.minimum ?? undefined} max={field.maximum ?? undefined} value={Number(current ?? 0)} onChange={(event) => update(Number(event.target.value))} />
              ) : field.kind === 'string_list' ? (
                <input value={Array.isArray(current) ? current.join(', ') : ''} onChange={(event) => update(event.target.value.split(',').map((part) => part.trim()).filter(Boolean))} />
              ) : (
                <input value={String(current ?? '')} onChange={(event) => update(event.target.value)} />
              )}
              <small>{field.description}</small>
            </label>
          );
        })}
        <label className="skill-config-field">
          <span>Run every</span>
          <select
            disabled={!schedule.enabled}
            value={schedule.interval_minutes}
            onChange={(event) => setSchedule({ ...schedule, interval_minutes: Number(event.target.value) })}
          >
            {![60, 360, 720, 1440].includes(schedule.interval_minutes) && (
              <option value={schedule.interval_minutes}>{schedule.interval_minutes} minutes</option>
            )}
            <option value={60}>Hour</option>
            <option value={360}>6 hours</option>
            <option value={720}>12 hours</option>
            <option value={1440}>Day</option>
          </select>
          <small>How often it looks on its own. You can still ask it any time.</small>
        </label>
        <label className="skill-config-check">
          <input type="checkbox" checked={schedule.enabled} onChange={(event) => setSchedule({ ...schedule, enabled: event.target.checked })} />
          <span>Look on its own on this schedule</span>
        </label>
      </div>
      {error && <div className="danger-note" role="alert">{error}</div>}
      <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
        <Button quiet disabled={saving} onClick={onCancel}>Cancel</Button>
        <Button primary type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save'}</Button>
      </div>
    </form>
  );
}

function LibraryDocuments() {
  const nav = useNav();
  const state = useAppState();
  const adapter = useAdapter();
  const dispatch = useDispatch();
  const lists = useWorkspaceLists();
  const [query, setQuery] = useState('');
  const [sources, setSources] = useState<LibrarySource[]>([]);
  const [sourcesLoading, setSourcesLoading] = useState(true);
  const [sourcesError, setSourcesError] = useState('');
  const [openSource, setOpenSource] = useState<LibrarySource | null>(null);
  const [sourceStatus, setSourceStatus] = useState('');
  const agentId = state.agent.id;
  useEffect(() => {
    if (!agentId) { setSources([]); setSourcesLoading(false); return; }
    let live = true;
    setSourcesLoading(true); setSourcesError('');
    void adapter.rest.listLibrarySources(state.workspace.id, agentId)
      .then((page) => { if (live) setSources(page.items); })
      .catch(() => { if (live) setSourcesError('Could not load shared sources. Try again.'); })
      .finally(() => { if (live) setSourcesLoading(false); });
    return () => { live = false; };
  }, [adapter.rest, state.workspace.id, agentId]);
  const match = (text: string): boolean => text.toLowerCase().includes(query.toLowerCase());
  const documents = lists.documents.filter((doc) => match(doc.title));
  const sharedSources = sources.filter((source) => match(`${source.title} ${source.summary}`));
  const drafts = lists.requests.filter((request) => (request.kind === 'invoice' || request.kind === 'agreement') && request.status === 'pending');
  const session = state.activeSessionId ? state.sessions[state.activeSessionId] : null;
  const canSelectSource = !!session && session.agentId === agentId && !session.pendingTurn
    && !['working', 'waiting'].includes(session.run?.status ?? '') && session.draft.attachments.length < 5;
  const selectSource = (source: LibrarySource): void => {
    if (!session || !canSelectSource) return;
    dispatch({ type: 'session/attach', id: session.id, attachment: {
      id: source.id,
      label: source.title,
      icon: 'context',
      kind: 'source',
      sha256: source.sha256,
      source_kind: 'library_source',
    } });
    dispatch({ type: 'iris/panel', panel: 'open' });
    setSourceStatus(`${source.title} selected for your next message. Nothing has been sent.`);
  };

  return (
    <>
      <label className="search">
        <Icon name="search" />
        <input placeholder="Search documents" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search documents" />
      </label>
      <h2 className="section-title">Shared sources</h2>
      {sourceStatus && <p className="meta" role="status">{sourceStatus}</p>}
      {sourcesError && <p className="meta action-error" role="alert">{sourcesError}</p>}
      <div className="col">
        {sourcesLoading && <Skeleton rows={1} label="Loading shared sources" />}
        {!sourcesLoading && !sourcesError && sharedSources.length === 0 && <EmptyState compact icon="context" title="No shared sources for this agent" />}
        {sharedSources.map((source) => {
          const selected = session?.draft.attachments.some((item) => item.id === source.id) ?? false;
          return <div className="list-row" key={source.id}>
            <Glass name="context" size={28} className="row-icon" />
            <div className="row-main">
              <span className="t">{source.title}</span>
              <span className="s">{source.version_label} · {source.audiences.join(' + ')} · {source.summary}</span>
            </div>
            <Button link onClick={() => setOpenSource(source)}>Open →</Button>
            {state.capabilities.turnAttachments && <Button disabled={!canSelectSource || selected} onClick={() => selectSource(source)}>{selected ? 'Selected' : `Use with ${agentName(state)}`}</Button>}
          </div>;
        })}
      </div>
      <h2 className="section-title">Drafts awaiting review</h2>
      <div className="col">
        {drafts.length === 0 && <EmptyState compact icon="agreement" title="No drafts are waiting for review" />}
        {drafts.map((request) => (
          <div className="list-row" key={request.id}>
            <Glass name={KIND_ICON[request.kind] ?? 'context'} size={28} className="row-icon" />
            <div className="row-main">
              <span className="t">{request.label}</span>
              <span className="s">{requestStatusLabel(request)}</span>
            </div>
            <Button onClick={() => nav(REQ(request.id))}>Review in Inbox</Button>
          </div>
        ))}
      </div>
      <h2 className="section-title">Saved documents</h2>
      <div className="col">
        {documents.length === 0 && <EmptyState compact icon="invoice" title="No documents created yet" />}
        {documents.map((doc) => (
          <div className="list-row" key={doc.id}>
            <Glass name={KIND_ICON[doc.kind] ?? 'context'} size={28} className="row-icon" />
            <div className="row-main">
              <span className="t">{doc.title}</span>
              <span className="s">
                {doc.status}
                {doc.pdf_status === 'preparing'
                  ? ` · ${EMPTY.pdfPreparing}`
                  : doc.pdf_status === 'failed'
                    ? ' · The PDF could not be made. The document is still saved.'
                    : doc.pdf_status === 'none' && doc.pdf_error
                      ? ' · Saved without a PDF'
                      : ''}
              </span>
            </div>
            <Button link onClick={() => nav(LIB('documents', doc.id))}>
              Open →
            </Button>
          </div>
        ))}
      </div>
      <Dialog
        open={openSource !== null}
        title={openSource?.title ?? 'Shared source'}
        onClose={() => setOpenSource(null)}
        actions={openSource && state.capabilities.turnAttachments ? <Button primary disabled={!canSelectSource || (session?.draft.attachments.some((item) => item.id === openSource.id) ?? false)} onClick={() => { selectSource(openSource); setOpenSource(null); }}>Use with {agentName(state)}</Button> : undefined}
      >
        {openSource && <>
          <p className="meta">{openSource.version_label} · Shared with {openSource.audiences.join(' and ')}</p>
          <Markdown text={openSource.content_markdown} />
        </>}
      </Dialog>
    </>
  );
}

function SavedDocument({ id }: { id: string }) {
  const nav = useNav();
  const record = useEntity<DocumentEntity>('document', id);
  const requestRecord = useEntity<import('@hermes/shared').RequestEntity>('request', record.data?.request_id ?? null);
  if (record.state === 'loading') return <div className="app-body"><Skeleton rows={5} label="Loading the document" /></div>;
  if (!record.data) return <div className="app-body"><EmptyState icon="invoice" title="Document not found" /></div>;
  return (
    <div className="app-pane-body" style={{ paddingBottom: 0 }}>
      <div className="row">
        <Button link onClick={() => nav(LIB('documents'))}>
          ← Documents
        </Button>
        <span className="grow" />
        <span className="meta">Saved document · Reopening cannot create it again</span>
      </div>
      {requestRecord.data ? <DocumentView request={requestRecord.data} document={record.data} readOnly />
        : requestRecord.state === 'loading' ? <Skeleton rows={4} />
          : <EmptyState icon="invoice" title="Review unavailable" detail="The request behind this document is not visible to you." />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export function Settings({ view }: { view: string }) {
  const nav = useNav();
  const selected = SETTINGS_TABS.includes(view as (typeof SETTINGS_TABS)[number]) ? view : 'Notifications';
  return (
    <div className="scroll">
      <div className="app-body settings-page" style={{ minHeight: '100%' }}>
        <h1 className="sr-only">Settings</h1>
        <Tabs tabs={SETTINGS_TABS.map((tab) => ({ id: tab, label: tab }))} value={selected} onChange={(next) => nav(SETTINGS(next))} label="Settings sections" />
        {selected === 'Notifications' && <NotificationsTab />}
        {selected === 'Slack account' && <SlackTab personal />}
        {selected === 'Data and privacy' && <PrivacyTab />}
      </div>
    </div>
  );
}

export function AdminSettings({ view, id = null }: { view: string; id?: string | null }) {
  const admin = useIsAdmin();
  const current = ADMIN_VIEW_ALIASES[view] ?? view;
  const selected = ADMIN_SETTINGS_GROUPS.some((group) => group.items.some((item) => item.id === current)) ? current : 'Organization';
  if (!admin) return null;
  const panel = (
    <div className="admin-settings-view">
      {selected === 'Organization' && <OrganizationTab />}
      {selected === 'Roles' && <AdminRoles roleId={id} />}
      {selected === 'Approvals' && <AdminApprovals routeKey={id} />}
      {selected === 'All agents' && <AdminAgents agentId={id} />}
      {selected === 'All connections' && <AdminConnections />}
      {selected === 'Slack' && <SlackTab />}
      {selected === 'Email' && <EmailPage />}
      {selected === 'Wallets' && <AdminWallets />}
      {selected === 'Provider keys' && <div className="admin-detail-page"><ProviderKeysTab /><ModelDefaults /></div>}
      {selected === 'Runtime capacity' && <RuntimeCapacityTab />}
      {selected === 'Usage' && <div className="admin-detail-page"><UsageTab /><UsageLimits /></div>}
      {selected === 'Data and privacy' && <PrivacyTab adminControls />}
      {selected === 'intelligence' && <AdminSharedIntelligence />}
    </div>
  );
  return (
    <div className="scroll">
      <div className="app-body admin-settings-page">
        <h1 className="sr-only">Admin</h1>
        <AdminDetailLayout selected={selected}>
          {panel}
        </AdminDetailLayout>
      </div>
    </div>
  );
}

const UNCONFIGURED_EMAIL = 'Outreach from a Google or Microsoft account isn’t turned on for this deployment; agents still reply from their own address.';

/** The two services a sending account can be (C99), in the words and logos people know them by. */
const SENDERS = {
  gmail: { service: 'Google', product: 'Gmail', brand: 'gmail', signIn: 'google', opening: 'Opening Google…' },
  microsoft: { service: 'Microsoft', product: 'Microsoft 365', brand: 'microsoft', signIn: 'microsoft', opening: 'Opening Microsoft…' },
} as const;
type SenderProvider = keyof typeof SENDERS;

function EmailTab() {
  const state = useAppState();
  const adapter = useAdapter();
  const admin = useIsAdmin();
  const [connection, setConnection] = useState<OutboundEmailConnection | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [busy, setBusy] = useState<SenderProvider | null>(null);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const gmailResult = useCallbackResult('gmail');
  const microsoftResult = useCallbackResult('microsoft');
  const [notice, setNotice] = useState<string | null>(() => {
    const [provider, result] = microsoftResult ? ['microsoft', microsoftResult] as const : ['gmail', gmailResult] as const;
    const { product } = SENDERS[provider];
    return result === 'connected'
      ? `${product} is connected. Approved emails will be sent from this account.`
      : result === 'failed' ? `${product} was not connected. Nothing changed. Try again.` : null;
  });

  const load = (): void => {
    if (!state.workspace.id) return;
    setConnection(null);
    setStatusError(null);
    void adapter.rest.outboundEmailConnection(state.workspace.id)
      .then(setConnection)
      .catch(() => setStatusError('Email status could not be loaded. Try again.'));
  };
  useEffect(load, [adapter, state.workspace.id]);

  const connect = async (provider: SenderProvider): Promise<void> => {
    setBusy(provider);
    setNotice(null);
    try {
      const started = provider === 'microsoft'
        ? await adapter.rest.startMicrosoftOAuth(state.workspace.id)
        : await adapter.rest.startGmailOAuth(state.workspace.id);
      window.location.assign(started.authorize_url);
    } catch (caught) {
      const error = caught as { status?: number; reason?: string };
      if (error.status === 401 && error.reason === 'reauth_required') {
        const url = adapter.auth.stepUpUrl(window.location.href, provider);
        if (url) window.location.assign(url);
        else setNotice('This needs a recent sign-in. Sign in again to continue.');
      } else {
        setNotice(error.reason === `${provider}_unavailable`
          ? UNCONFIGURED_EMAIL
          : error.reason === 'admin_required' ? EMPTY.adminRequired : `${SENDERS[provider].service} could not be opened. Nothing changed. Try again.`);
      }
      setBusy(null);
    }
  };

  // Hermes deletes its stored access; approved email that hadn't gone out waits
  // for a sending account again (docs/CONNECTORS.md).
  const disconnect = async (): Promise<void> => {
    if (!connection?.provider) return;
    const { product } = SENDERS[connection.provider];
    setDisconnecting(true);
    try {
      const result = await adapter.rest.disconnectOutboundEmail(state.workspace.id);
      setDisconnectOpen(false);
      setNotice(result.waiting > 0
        ? `${product} is disconnected. ${result.waiting === 1 ? '1 approved email is' : `${result.waiting} approved emails are`} waiting for a sending account.`
        : `${product} is disconnected.`);
      load();
    } catch (caught) {
      const error = caught as { status?: number; reason?: string };
      if (error.status === 401 && error.reason === 'reauth_required') {
        const url = adapter.auth.stepUpUrl(window.location.href, connection.provider);
        if (url) { window.location.assign(url); return; }
      }
      setDisconnectOpen(false);
      setNotice(error.reason === 'admin_required' ? EMPTY.adminRequired : `${product} could not be disconnected. Nothing changed. Try again.`);
    } finally {
      setDisconnecting(false);
    }
  };

  if (!connection && !statusError) return <Skeleton rows={4} label="Loading email connection" />;
  const connected = connection?.status === 'connected';
  const current = connection?.provider ? SENDERS[connection.provider] : null;
  const available = (Object.keys(SENDERS) as SenderProvider[]).filter((provider) => connection?.providers[provider]);
  const sendingEnabled = connection?.mode === 'send_after_approval';
  const badge: ConnectionBadge | null = statusError ? null : connected ? { label: 'Connected', tone: 'ok' } : connection?.status === 'error' ? { label: 'Needs attention', tone: 'warn' } : null;
  const connectButton = (provider: SenderProvider, primary = false) => (
    <Button key={provider} primary={primary} disabled={busy !== null} onClick={() => void connect(provider)}>
      <BrandIcon name={SENDERS[provider].signIn} size={16} />
      {busy === provider ? SENDERS[provider].opening : `Connect ${SENDERS[provider].service}`}
    </Button>
  );
  const other = connection?.provider ? available.find((provider) => provider !== connection.provider) : undefined;
  return (
    <>
      {notice && <Ack show>{notice}</Ack>}
      <AdminSettingsCard
        title="Outreach account"
        brand={current && connection?.status !== 'disconnected' ? current.brand : 'email'}
        badge={badge}
        description={current && connected
          ? `Outreach goes out from this ${current.product} account; agents reply from their own address.`
          : connection?.configured || statusError ? 'Outreach goes out from a Google or Microsoft account you connect; agents reply from their own address.' : UNCONFIGURED_EMAIL}
        footer={statusError ? (
          <Button disabled={busy !== null} onClick={load}>Try again</Button>
        ) : admin && connection?.configured ? (
          current && connection.provider ? (
            <div className="sender-actions">
              {other && <Button link disabled={busy !== null} onClick={() => void connect(other)}>Use {SENDERS[other].service} instead</Button>}
              <Button primary={!connected} disabled={busy !== null} onClick={() => void connect(connection.provider!)}>
                {busy === connection.provider ? current.opening : `Reconnect ${current.product}`}
              </Button>
            </div>
          ) : (
            <div className="sender-actions">{available.map((provider) => connectButton(provider))}</div>
          )
        ) : undefined}
      >
        {statusError ? (
          <p className="meta" role="alert">{statusError}</p>
        ) : connection && (connection.address || connection.configured) && (
          <>
            {connection.address && <div className="kv"><span className="grow">Sends from</span><span className="meta">{connection.address}</span></div>}
            {connection.configured && connected && <div className="kv"><span className="grow">Sending</span><span className="meta">{sendingEnabled ? 'On, only what a person approved' : 'Off, approved emails are kept as drafts'}</span></div>}
            {connection.configured && connection.pending_messages > 0 && <div className="kv"><span className="grow">Waiting to send</span><span className="meta">{connection.pending_messages}</span></div>}
          </>
        )}
      </AdminSettingsCard>
      {admin && current && connection?.status !== 'disconnected' && (
        <AdminSettingsCard
          title={`Disconnect ${current.product}`}
          description="Outreach stops going out from this account. Emails already sent stay sent."
          danger
          footer={<>
            <p className="meta">You will confirm before the account is disconnected.</p>
            <Button danger disabled={busy !== null || disconnecting} onClick={() => setDisconnectOpen(true)}>Disconnect</Button>
          </>}
        />
      )}
      <Dialog
        open={disconnectOpen}
        title={`Disconnect ${current?.product ?? 'the sending account'}?`}
        onClose={() => setDisconnectOpen(false)}
        actions={<><Button onClick={() => setDisconnectOpen(false)}>Cancel</Button><Button danger primary disabled={disconnecting} onClick={() => void disconnect()}>{disconnecting ? 'Disconnecting…' : 'Disconnect'}</Button></>}
      >
        <p>Hermes deletes its access to {connection?.address ?? 'this account'}. Approved emails that haven’t gone out will wait until a sending account is connected again.</p>
        <p className="meta">To remove Hermes from the {current?.service ?? 'provider'} account as well, remove it in that account’s security settings.</p>
      </Dialog>
    </>
  );
}

/** Admin → Email: every agent's own address (C100), then the account outreach goes out from. */
function EmailPage() {
  return (
    <div className="admin-detail-page">
      <AdminPageHeader title="Email" />
      <AdminEmailInboxes />
      <EmailTab />
    </div>
  );
}

function SlackTab({ personal = false }: { personal?: boolean }) {
  const state = useAppState();
  const adapter = useAdapter();
  const admin = useIsAdmin();
  const [connection, setConnection] = useState<SlackConnection | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [linkCommand, setLinkCommand] = useState<string | null>(null);

  const load = (): void => {
    if (!state.workspace.id) return;
    setConnection(null);
    setStatusError(null);
    void adapter.rest.slackConnection(state.workspace.id)
      .then(setConnection)
      .catch(() => setStatusError('Slack status could not be loaded. Try again.'));
  };
  useEffect(load, [adapter, state.workspace.id]);

  const stepUp = (): boolean => {
    const url = adapter.auth.stepUpUrl(window.location.href, 'slack');
    if (url) {
      window.location.assign(url);
      return true;
    }
    setNotice('This needs a recent sign-in. Sign in again to continue.');
    return false;
  };

  const connect = async (): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      const started = await adapter.rest.startSlackOAuth(state.workspace.id);
      window.location.assign(started.authorize_url);
    } catch (caught) {
      const error = caught as { status?: number; reason?: string };
      if (error.status === 401 && error.reason === 'reauth_required') {
        stepUp();
      } else {
        setNotice(error.reason === 'slack_unavailable'
          ? 'Slack is not available on this deployment yet. Ask the person who runs Hermes for your company to turn it on.'
          : error.reason === 'admin_required'
            ? EMPTY.adminRequired
            : 'Slack could not be opened. Nothing changed. Try again.');
      }
      setBusy(false);
    }
  };

  const disconnect = async (): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      const result = await adapter.rest.disconnectSlack(state.workspace.id);
      setDisconnectOpen(false);
      setNotice(result.remote_revocation === 'pending'
        ? 'Slack is disconnected. Hermes will finish removing its access in Slack automatically.'
        : 'Slack is disconnected.');
      load();
    } catch (caught) {
      const error = caught as { status?: number; reason?: string };
      if (error.status === 401 && error.reason === 'reauth_required') stepUp();
      else setNotice(error.reason === 'admin_required' ? EMPTY.adminRequired : 'Slack could not be disconnected. Try again.');
    } finally {
      setBusy(false);
    }
  };

  const createLinkCode = async (): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      const result = await adapter.rest.createSlackLinkCode(state.workspace.id);
      setLinkCommand(result.command);
    } catch (caught) {
      const error = caught as { status?: number; reason?: string };
      if (error.status === 401 && error.reason === 'reauth_required') stepUp();
      else setNotice(error.reason === 'agent_unavailable'
        ? 'Your Hermes agent is not ready yet.'
        : 'A Slack link code could not be created. Try again.');
    } finally {
      setBusy(false);
    }
  };

  if (!connection && (personal || !statusError)) return <Skeleton rows={5} label="Loading Slack connection" />;
  if (!connection) {
    return (
      <div className="admin-detail-page">
        <AdminPageHeader title="Slack" />
        <AdminSettingsCard
          title="Slack status is unavailable"
          description="Hermes could not check the connection."
          footer={<>
            <p className="meta">Checking again does not change the connection.</p>
            <Button disabled={busy} onClick={load}>Retry</Button>
          </>}
        >
          <p className="meta" role="alert">{statusError}</p>
        </AdminSettingsCard>
      </div>
    );
  }
  const connected = connection.status === 'connected';
  const destination = connection.enterprise_name ?? connection.team_name ?? 'Slack';
  if (personal) {
    return (
      <>
        <div>
          <h2 className="section-title">Slack account</h2>
          <p className="meta">Link your own Slack identity to the same Hermes account you use here.</p>
        </div>
        {notice && <Ack show>{notice}</Ack>}
        {!connected ? (
          <EmptyState icon="context" title="Slack is not connected to this workspace" detail="Ask a workspace Admin to connect Slack before linking your account." />
        ) : (
          <Panel icon="context" title={`Available in ${destination}`} subtitle="A one-time command links only your identity. It expires in 10 minutes.">
            <div className="row">
              <div className="grow">
                <div className="panel-title">Link your Slack identity</div>
                <div className="meta">Create the command here, then send it to the Hermes app in a direct message.</div>
              </div>
              <Button disabled={busy} onClick={createLinkCode}>Create link command</Button>
            </div>
            {linkCommand && <code className="meta" style={{ userSelect: 'all' }}>{linkCommand}</code>}
          </Panel>
        )}
      </>
    );
  }
  const badge: ConnectionBadge | null = connected ? { label: 'Connected', tone: 'ok' } : connection.status === 'error' ? { label: 'Needs attention', tone: 'warn' } : null;
  return (
    <div className="admin-detail-page">
      <AdminPageHeader title="Slack" />
      {notice && <Ack show>{notice}</Ack>}
      <AdminSettingsCard
        brand="slack"
        badge={badge}
        title={connected
          ? 'Slack'
          : connection.status === 'error'
            ? 'Slack needs to be reconnected'
            : connection.configured
              ? 'Connect this workspace to Slack'
              : 'Slack is not available yet'}
        description={connected
          ? `${destination} · ${connection.agent?.name ?? 'Your Hermes agent'} replies in Slack`
          : connection.configured
            ? 'You approve the connection in Slack. You never enter a Slack password in Hermes.'
            : 'Slack is not available on this deployment yet. Ask the person who runs Hermes for your company to turn it on.'}
        footer={admin && connection.configured && !connected ? (
          <Button primary disabled={busy} onClick={connect}>
            {busy ? 'Opening Slack…' : connection.status === 'error' ? 'Reconnect Slack' : 'Connect Slack'}
          </Button>
        ) : undefined}
      />

      {connected && (
        <AdminSettingsCard
          title="Link your Slack identity"
          description="Create a one-time command, then send it to the app in a direct message. It expires in 10 minutes."
          footer={<>
            <p className="meta">The command links only your signed-in Hermes account.</p>
            <Button disabled={busy} onClick={createLinkCode}>Create link command</Button>
          </>}
        >
            {linkCommand && <code className="meta" style={{ userSelect: 'all' }}>{linkCommand}</code>}
        </AdminSettingsCard>
      )}

      {admin && connected && (
        <AdminSettingsCard
          title="Disconnect Slack"
          description="New Slack messages will stop reaching Hermes. Earlier conversations stay in Hermes."
          danger
          footer={<>
            <p className="meta">You will confirm before the workspace is disconnected.</p>
            <Button danger disabled={busy} onClick={() => setDisconnectOpen(true)}>Disconnect</Button>
          </>}
        />
      )}
      <Dialog
        open={disconnectOpen}
        title="Disconnect Slack?"
        onClose={() => setDisconnectOpen(false)}
        actions={<><Button onClick={() => setDisconnectOpen(false)}>Cancel</Button><Button danger primary disabled={busy} onClick={disconnect}>Disconnect</Button></>}
      >
        <p>New Slack messages will stop reaching Hermes immediately. Earlier conversations stay in Hermes.</p>
      </Dialog>
    </div>
  );
}

/**
 * Organization, and the one control with no undo.
 *
 * Deleting a workspace is two halves that happen at two times, and the screen
 * says which is which: access is revoked *now* — shares gone, sessions
 * read-only, runs asked to stop, everyone evicted from their sockets — and the
 * rows and objects go in seven days. The immediate half is immediate because
 * one of the two reasons anybody presses this is "someone got in", and that
 * cannot wait a week. The seven days exist so the other reason has a cancel.
 *
 * Admin, a typed confirmation, and step-up.
 */
function OrganizationCloudConnection() {
  const state = useAppState();
  const adapter = useAdapter();
  const [connection, setConnection] = useState<(CloudConnectionStatus & { available: boolean }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    const load = () => { void adapter.rest.cloudConnection(state.workspace.id).then(value => {
      if (active) { setConnection(value); }
    }).catch(() => { if (active) setError('Cloud connection status could not be loaded.'); }); };
    setConnection(null);
    setError(new URL(window.location.href).searchParams.get('cloud') === 'failed' ? 'Cloud was not connected. Your previous connection, if any, is unchanged. Please try again.' : null);
    load();
    window.addEventListener('focus', load);
    const interval = window.setInterval(load, 30_000);
    return () => { active = false; window.removeEventListener('focus', load); window.clearInterval(interval); };
  }, [adapter, state.workspace.id]);
  const connect = async () => {
    setBusy(true); setError(null);
    try {
      const result = await adapter.rest.startCloudConnection(state.workspace.id);
      const url = new URL(result.authorization_url);
      if (url.origin !== 'https://portal.nousresearch.com' || url.pathname !== '/oauth/authorize' || url.username || url.password) throw new Error('untrusted redirect');
      window.location.assign(url.href);
    } catch (caught) {
      const reason = (caught as { reason?: string }).reason ?? '';
      if (reason === 'reauth_required') {
        const url = adapter.auth.stepUpUrl(window.location.href, 'provider_key');
        if (url) { window.location.assign(url); return; }
        setError('Sign in again, then connect Cloud.');
      } else { setError(cloudConnectionErrorMessage(reason)); }
      setBusy(false);
    }
  };
  if (!connection) return <p role="status">{error ?? 'Loading Cloud connection…'}</p>;
  return <CloudConnection status={connection} available={connection.available} busy={busy} error={error} onConnect={() => { void connect(); }} />;
}

/** The party name agreements use. Unset means the workspace name. */
function LegalNameRow({ workspaceName, legalName, admin, onSave }: {
  workspaceName: string;
  legalName: string | null;
  admin: boolean;
  onSave: (legalName: string | null) => Promise<unknown>;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const save = (): void => {
    setBusy(true);
    setError(null);
    void onSave(draft.trim() || null)
      .then(() => setEditing(false))
      .catch(() => setError('Could not save the legal name. Try again.'))
      .finally(() => setBusy(false));
  };
  if (editing) {
    return (
      <div className="kv" data-testid="legal-name-editor">
        <label className="field grow">
          <span>Legal name on agreements</span>
          <input value={draft} maxLength={200} placeholder={workspaceName} onChange={(event) => setDraft(event.target.value)} />
        </label>
        <Button disabled={busy} onClick={() => setEditing(false)}>Cancel</Button>
        <Button primary disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</Button>
        {error && <p className="meta" role="alert">{error}</p>}
      </div>
    );
  }
  return (
    <div className="kv">
      <span className="grow">Legal name</span>
      <span className="meta">{legalName ?? `${workspaceName} (workspace name)`}</span>
      {admin && (
        <Button link onClick={() => { setDraft(legalName ?? ''); setEditing(true); }}>
          Edit
        </Button>
      )}
    </div>
  );
}

function OrganizationTab() {
  const state = useAppState();
  const adapter = useAdapter();
  const admin = useIsAdmin();
  const nav = useNav();
  const counts = memberCounts(state);
  const [view, setView] = useState<SettingsView | null>(null);
  const [dialog, setDialog] = useState<'delete' | 'undelete' | null>(null);
  const [typed, setTyped] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [scheduled, setScheduled] = useState<{ at: string; copy: string } | null>(null);
  const [reauthed, setReauthed] = useState(false);

  const load = (): void => {
    if (!state.workspace.id) return;
    void adapter.rest
      .settings(state.workspace.id)
      .then(setView)
      .catch(() => undefined);
  };
  useEffect(load, [adapter, state.workspace.id]);

  useEffect(() => {
    const intent = adapter.pendingStepUp();
    if (intent?.kind === 'workspace') {
      setReauthed(true);
      setDialog(intent.decision === 'decline' ? 'undelete' : 'delete');
      adapter.clearStepUp();
    }
  }, [adapter]);

  const pending = scheduled ?? (view?.deletion.scheduled_at ? { at: view.deletion.scheduled_at, copy: '' } : null);

  const guarded = async (run: () => Promise<void>, intent: 'delete' | 'undelete'): Promise<void> => {
    setNotice(null);
    try {
      await run();
    } catch (caught) {
      const error = caught as { status?: number; reason?: string };
      if (error.status === 401 && error.reason === 'reauth_required') {
        storeStepUp({ kind: 'workspace', decision: intent === 'undelete' ? 'decline' : 'approve', returnTo: window.location.href });
        const url = adapter.auth.stepUpUrl(window.location.href, 'provider_key');
        if (url) window.location.assign(url);
        else setNotice('This needs a recent sign-in. Sign in again to continue.');
        return;
      }
      setNotice(
        error.reason === 'already_scheduled'
          ? 'This workspace is already scheduled for deletion.'
          : error.reason === 'not_scheduled'
            ? 'This workspace is not scheduled for deletion.'
            : error.reason === 'not_admin'
              ? EMPTY.adminRequired
              : 'That did not go through. Try again.',
      );
    }
  };

  return (
    <>
      <AdminPageHeader title="General" />
      <AdminSettingsCard title="Workspace information">
      {[
        ['Workspace', state.workspace.name],
        ['Your role', state.user.role === 'admin' ? 'Admin' : 'Member'],
        ['Signed in as', state.user.email || '—'],
        ['Data location', state.workspace.jurisdiction === 'eu' ? 'European Union' : 'Standard'],
        ['Timezone', view?.timezone ?? 'UTC'],
        ['Members', `${counts.joined} joined · ${counts.invited} invited`],
      ].map(([key, value]) => (
        <div className="kv" key={key}>
          <span className="grow">{key}</span>
          <span className="meta">{value}</span>
          {key === 'Members' && (
            <Button link onClick={() => nav(MEMBERS)}>
              Manage →
            </Button>
          )}
        </div>
      ))}
      <LegalNameRow
        workspaceName={state.workspace.name}
        legalName={view?.legal_name ?? null}
        admin={admin}
        onSave={(legalName) => adapter.rest.patchSettings(state.workspace.id, { legal_name: legalName }).then(setView)}
      />
      </AdminSettingsCard>

      {admin && (
        <>
          <OrganizationCloudConnection />
          <AdminSettingsCard title="Delete workspace" danger>
          {pending ? (
            <>
              <Panel
                icon="admission"
                title="Scheduled for deletion"
                subtitle={`Everyone lost access when deletion was requested. Everything is deleted on ${new Date(pending.at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}.`}
                right={
                  <Button
                    onClick={() => {
                      setDialog('undelete');
                      setNotice(null);
                    }}
                  >
                    Cancel deletion
                  </Button>
                }
              />
              {pending.copy && <p className="meta" style={{ maxWidth: 760 }}>Backup copies kept for recovering from failures expire on their own within 30 days.</p>}
            </>
          ) : (
            <div className="row">
              <span className="meta grow" style={{ maxWidth: 620 }}>
                Everyone loses access right away. Everything is deleted after seven days; you can cancel until then.
              </span>
              <Button danger
                quiet
                onClick={() => {
                  setDialog('delete');
                  setTyped('');
                  setNotice(null);
                }}
              >
                Delete workspace…
              </Button>
            </div>
          )}
          {notice && <p className="meta" role="alert">{notice}</p>}
          </AdminSettingsCard>
        </>
      )}

      <Dialog
        open={dialog === 'delete'}
        title={`Delete ${state.workspace.name}?`}
        onClose={() => setDialog(null)}
        actions={
          <>
            <Button onClick={() => setDialog(null)}>Keep it</Button>
            <Button danger
              primary
              disabled={typed.trim() !== state.workspace.name}
              onClick={() =>
                void guarded(async () => {
                  const result = await adapter.rest.deleteWorkspace(state.workspace.id);
                  setScheduled({ at: result.scheduled_at, copy: result.copy });
                  setDialog(null);
                  setReauthed(false);
                  load();
                }, 'delete')
              }
            >
              {reauthed ? 'Confirm deletion' : 'Delete'}
            </Button>
          </>
        }
      >
        {reauthed && <p className="meta">You signed in again. Confirm to continue.</p>}
        <p>
          Everyone loses access now. Nothing is deleted for seven days, and you can cancel on this screen until then. Type the workspace name to confirm.
        </p>
        <label className="field">
          <span className="sr-only">Workspace name</span>
          <input placeholder={state.workspace.name} value={typed} onChange={(event) => setTyped(event.target.value)} />
        </label>
      </Dialog>

      <Dialog
        open={dialog === 'undelete'}
        title="Cancel the deletion?"
        onClose={() => setDialog(null)}
        actions={
          <>
            <Button onClick={() => setDialog(null)}>Leave it scheduled</Button>
            <Button
              primary
              onClick={() =>
                void guarded(async () => {
                  await adapter.rest.undeleteWorkspace(state.workspace.id);
                  setScheduled(null);
                  setDialog(null);
                  setReauthed(false);
                  load();
                }, 'undelete')
              }
            >
              {reauthed ? 'Confirm cancel' : 'Cancel deletion'}
            </Button>
          </>
        }
      >
        {reauthed && <p className="meta">You signed in again. Confirm to continue.</p>}
        <p>The workspace will not be deleted. Conversations stay read-only until someone reopens them, so no old work restarts on its own.</p>
      </Dialog>
    </>
  );
}

/**
 * Agents: the durable defaults and the two caps.
 *
 * A catalog row is enabled only when a verified key exists for its provider, so
 * this screen and the composer agree by construction.
 *
 * Run limits save explicitly and render the server response. Zero tokens
 * is a deliberate stop; an empty daily limit means no limit.
 */
/** Workspace settings as the server holds them, and one way to change them, for Models and Usage. */
function useWorkspaceSettings() {
  const state = useAppState();
  const adapter = useAdapter();
  const [ack, setAck] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<SettingsView | null>(null);
  const settings = state.settings as { default_model_id?: string; default_effort?: string | null; daily_token_cap?: number | null; max_concurrent_runs?: number };

  // Bootstrap is a snapshot from page load; these screens are where settings change.
  useEffect(() => {
    if (!state.workspace.id) return undefined;
    let live = true;
    void adapter.rest.settings(state.workspace.id).then((next) => { if (live) setView(next); }).catch(() => undefined);
    return () => { live = false; };
  }, [adapter, state.workspace.id]);

  const save = (patch: Record<string, unknown>): Promise<boolean> => {
    setError(null);
    return adapter.rest
      .patchSettings(state.workspace.id, patch)
      .then((next) => {
        setView(next);
        setAck(true);
        setTimeout(() => setAck(false), 1600);
        return true;
      })
      .catch((caught: unknown) => {
        const reason = (caught as { reason?: string }).reason;
        setError(reason === 'not_admin' ? EMPTY.adminRequired : reason === 'bad_cap' ? 'Enter a whole number, or leave it empty for no limit.' : 'Couldn’t save that. Try again.');
        return false;
      });
  };

  const caps = view?.caps ?? {
    daily_token_cap: settings.daily_token_cap ?? null,
    max_concurrent_runs: settings.max_concurrent_runs ?? 1,
    tokens_today: 0,
    active_runs: 0,
    warn: false,
  };
  return {
    ack, error, save, caps,
    modelId: view?.defaults.model_id ?? settings.default_model_id,
    effort: view?.defaults.effort ?? settings.default_effort,
  };
}

/** The model and effort new conversations start with (Models page). */
function ModelDefaults() {
  const state = useAppState();
  const admin = useIsAdmin();
  const nav = useNav();
  const catalog = catalogRows(state);
  const { ack, error, save, modelId, effort } = useWorkspaceSettings();
  const current = catalog.find((row) => row.model_id === modelId);
  return (
    <AdminSettingsCard title="Default model" description="New conversations start with this model.">
      <span style={{ position: 'relative', display: 'block' }}><Ack show={ack} style={{ right: 0, top: -40 }}>Saved</Ack></span>
      {catalog.length === 0 ? (
        <EmptyState icon="skill" title={EMPTY.noProvider} detail={EMPTY.providerKeys} action={<Button onClick={() => nav(ADMIN('Provider keys'))}>Connect Nous Portal</Button>} />
      ) : (
        <div className="col" role="radiogroup" aria-label="Default model" style={{ gap: 4 }}>
          {catalog.map((row) => (
            <MenuItem
              key={row.model_id}
              role="radio"
              checked={modelId === row.model_id}
              disabled={!row.enabled || !admin}
              sub={row.enabled ? undefined : modelUnavailableReason(row.disabled_reason, row.provider)}
              onClick={() => save({ default_model_id: row.model_id })}
            >
              {row.label}
            </MenuItem>
          ))}
        </div>
      )}
      <div className="kv">
        <span className="grow">Effort</span>
        {current?.effort ? (
          <div className="effort-row" role="radiogroup" aria-label="Default effort">
            {current.effort.map((value) => (
              <button key={value} type="button" role="radio" aria-checked={effort === value} disabled={!admin} onClick={() => save({ default_effort: value })}>
                {effortLabel(value)}
              </button>
            ))}
          </div>
        ) : (
          <span className="meta">Not available for this model</span>
        )}
      </div>
      {error && <p className="meta" role="alert">{error}</p>}
    </AdminSettingsCard>
  );
}

/** Daily usage and tasks at the same time, editable (Usage page). */
function UsageLimits() {
  const admin = useIsAdmin();
  const { error, save, caps } = useWorkspaceSettings();
  if (!admin) return null;
  return (
    <>
      <AdminRunLimits key={`${caps.daily_token_cap}:${caps.max_concurrent_runs}`} dailyLimit={caps.daily_token_cap} concurrentLimit={caps.max_concurrent_runs} onSave={save} />
      <AdminSettingsCard title="Current usage">
        <div className="kv">
          <span className="grow">Today</span>
          <span className="meta">{caps.daily_token_cap === null ? 'No limit' : `${caps.tokens_today.toLocaleString()} of ${caps.daily_token_cap.toLocaleString()} used today`}</span>
          {caps.daily_token_cap !== null && <Button danger link onClick={() => void save({ daily_token_cap: null })}>Remove limit</Button>}
        </div>
        <div className="kv">
          <span className="grow">Running</span>
          <span className="meta">{caps.active_runs} of {caps.max_concurrent_runs} running now</span>
        </div>
      </AdminSettingsCard>
      {error && <p className="meta" role="alert">{error}</p>}
    </>
  );
}

/** A provider's brand name; never its slug (docs/DESIGN.md). */
const PROVIDER_NAMES: Readonly<Record<string, string>> = {
  nous: 'Nous Portal',
  nous_portal: 'Nous Portal',
  openrouter: 'OpenRouter',
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
};
export const providerName = (id: string | null | undefined): string =>
  (id && (PROVIDER_CHOICES.find((choice) => choice.id === id)?.label ?? PROVIDER_NAMES[id])) || 'another model provider';

/** Why a catalog row cannot be chosen, in words an Admin can act on. The stored reason is never shown as-is. */
const modelUnavailableReason = (reason: string | null | undefined, provider: string): string =>
  !reason ? `Connect ${providerName(provider)} to use this`
    : /catalog sync/i.test(reason) ? `Check the ${providerName(provider)} connection in Admin → Models to use this`
      : /no longer listed/i.test(reason) ? `No longer offered by ${providerName(provider)}`
        : 'Not available right now';

const EFFORT_LABELS: Readonly<Record<string, string>> = { minimal: 'Minimal', low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Maximum' };
const effortLabel = (value: string): string => EFFORT_LABELS[value] ?? (value.charAt(0).toUpperCase() + value.slice(1)).replace(/[_-]+/g, ' ');

const STATUS_LABEL: Record<string, string> = { unverified: 'Not verified yet', verified: 'Verified', verified_scoped: 'Verified for some models', invalid: 'Not accepted', revoked: 'Removed' };

/**
 * Can this key still be used at all?
 *
 * Nous Portal is the only provider this product offers (decision C55), so a row
 * for anything else is a key that was installed before that and can no longer
 * pay for a run. It is shown rather than hidden, because a credential that
 * still exists somewhere is a thing its owner should be told about.
 */
const usable = (key: MaskedProviderKey): boolean => PROVIDER_CHOICES.some((choice) => choice.id === key.provider);

/** "342 models synced · 2 Mar" — or nothing, for a provider that has no list. */
function syncLabel(key: MaskedProviderKey): string | null {
  if (key.synced_model_count === null) return null;
  const when = key.models_synced_at === null ? 'not updated yet' : `last updated ${new Date(key.models_synced_at).toLocaleDateString()}`;
  return `${key.synced_model_count} model${key.synced_model_count === 1 ? '' : 's'} synced · ${when}`;
}

function providerAccountLabel(key: MaskedProviderKey): string | null {
  if (key.credential_kind !== 'oauth_device_code') return null;
  const account = key.oauth_account;
  if (!account) return 'Nous account details unavailable';
  const identity = account.email ?? account.user_id ?? 'Nous account';
  const organization = account.organization_name ?? account.organization_slug;
  return organization ? `${identity} · ${organization}` : identity;
}

function ProviderKeysTab() {
  const state = useAppState();
  const adapter = useAdapter();
  const admin = useIsAdmin();
  const lists = useWorkspaceLists();
  const [dialog, setDialog] = useState<'add' | 'rotate' | 'remove' | null>(null);
  const [target, setTarget] = useState<MaskedProviderKey | null>(null);
  const [secret, setSecret] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [connectStatus, setConnectStatus] = useState<ProviderConnectStatus>({ kind: 'idle' });
  const [manualProviderFlow, setManualProviderFlow] = useState(false);
  const [connectKeyId, setConnectKeyId] = useState<string | null>(null);
  const [autoFocusKey, setAutoFocusKey] = useState(false);
  const keys = lists.providerKeys;
  const locked = state.ui.providerKeysLocked;

  const refreshKeys = (): void => adapter.invalidateList(LIST_KEYS.providerKeys);

  const revealConnectionStatus = (): void => {
    const url = adapter.auth.stepUpUrl(window.location.href, 'provider_key');
    if (url) {
      window.location.assign(url);
      return;
    }
    setNotice('This needs a recent sign-in. Sign in again to continue.');
  };

  const closeConnect = (): void => {
    setDialog(null);
    setSecret('');
    setConnectStatus({ kind: 'idle' });
    setConnectKeyId(null);
    setAutoFocusKey(false);
    setManualProviderFlow(false);
  };

  // On the way back from a recent-sign-in challenge, reopen the same flow and
  // wait for a deliberate confirmation. Plaintext is never persisted across
  // the redirect; an already-stored key can be retried by id without another
  // paste, while a not-yet-stored key is focused for the Admin to paste again.
  useEffect(() => {
    const intent = adapter.pendingStepUp();
    if (intent?.kind !== 'provider_key') return;
    setDialog('add');
    const hostedOAuth = intent.providerFlow === 'oauth';
    setManualProviderFlow(!hostedOAuth);
    setAutoFocusKey(!intent.keyId);
    setConnectStatus(
      hostedOAuth
        ? { kind: 'notice', message: 'Sign-in confirmed. Continue with Nous to approve this workspace.' }
        : intent.keyId
        ? { kind: 'pending', message: 'You signed in again. Confirm to check the saved key again; you do not need to paste it.' }
        : { kind: 'idle' },
    );
    setConnectKeyId(intent.keyId ?? null);
    adapter.clearStepUp();
  }, [adapter]);

  const connectFeedback = (status: string, reason: string, keyId: string, modelCount: number | null): void => {
    setSecret('');
    refreshKeys();
    if (status === 'verified' || status === 'verified_scoped') {
      setConnectStatus({ kind: 'connected', modelCount });
      return;
    }
    setConnectKeyId(keyId);
    if (status === 'invalid' || reason === 'rejected') {
      setConnectStatus({ kind: 'invalid', message: 'Nous Portal did not accept this key. Check the key in Nous Portal, then retry verification or close this dialog and rotate it.' });
      return;
    }
    const detail = reason === 'throttled'
      ? 'Nous Portal asked us to slow down.'
      : reason === 'forbidden'
        ? 'Nous Portal did not allow this verification attempt.'
        : 'Nous Portal could not be reached.';
    setConnectStatus({ kind: 'pending', message: `The key is saved securely, but it is not verified yet. ${detail} Try again; you do not need to paste it again.` });
  };

  const connect = async (): Promise<void> => {
    if (!secret.trim()) return;
    setManualProviderFlow(true);
    setConnectStatus({ kind: 'connecting' });
    try {
      const result = await adapter.rest.addProviderKey(state.workspace.id, { provider: DEFAULT_PROVIDER, key: secret.trim() });
      connectFeedback(result.verification.status, result.verification.reason, result.key.id, result.key.synced_model_count);
    } catch (caught) {
      const error = caught as { status?: number; reason?: string };
      if (error.status === 401 && error.reason === 'reauth_required') {
        storeStepUp({ kind: 'provider_key', providerFlow: 'api_key', returnTo: window.location.href });
        const url = adapter.auth.stepUpUrl(window.location.href, 'provider_key');
        if (url) {
          window.location.assign(url);
          return;
        }
        setConnectStatus({ kind: 'error', message: 'This needs a recent sign-in. Sign in again to continue.' });
        return;
      }
      const message = error.reason === 'bad_key'
        ? 'That does not look like a Nous Portal key. Copy the complete key from Nous Portal and try again.'
        : error.reason === 'key_exists'
          ? 'This workspace already has a Nous Portal key. Close this dialog and replace the existing key with Rotate.'
          : error.reason === 'not_admin'
            ? 'A workspace Admin must connect the Nous Portal key.'
            : 'The key could not be saved. Check your connection and try again.';
      setConnectStatus({ kind: 'error', message });
    }
  };

  const retryConnect = async (): Promise<void> => {
    if (!connectKeyId) return;
    setConnectStatus({ kind: 'retrying', message: 'Checking the saved key with Nous Portal…' });
    try {
      const result = await adapter.rest.verifyProviderKey(state.workspace.id, connectKeyId);
      connectFeedback(result.status, result.reason, result.key_id, result.synced?.count ?? null);
    } catch (caught) {
      const error = caught as { status?: number; reason?: string };
      if (error.status === 401 && error.reason === 'reauth_required') {
        storeStepUp({ kind: 'provider_key', keyId: connectKeyId, returnTo: window.location.href });
        const url = adapter.auth.stepUpUrl(window.location.href, 'provider_key');
        if (url) {
          window.location.assign(url);
          return;
        }
      }
      setConnectStatus({ kind: 'pending', message: 'The key is still saved securely, but the check did not finish. Try again shortly.' });
    }
  };

  const startOAuth = async (): Promise<void> => {
    const popup = window.open('about:blank', '_blank');
    if (popup) popup.opener = null;
    setManualProviderFlow(false);
    setConnectStatus({ kind: 'connecting' });
    try {
      const started = await adapter.rest.startNousOAuth(state.workspace.id);
      if (started.status === 'unavailable') {
        popup?.close();
        setManualProviderFlow(true);
        setConnectStatus({ kind: 'oauth_unavailable', message: 'Signing in with Nous is not available on this deployment. Paste a Nous Portal key below instead.' });
        return;
      }
      if (popup) popup.location.href = started.verification_uri;
      setConnectStatus({ kind: 'authorizing', userCode: started.user_code, verificationUri: started.verification_uri });
      let delay = started.poll_after_ms;
      while (Date.now() < new Date(started.expires_at).getTime()) {
        await new Promise((resolve) => window.setTimeout(resolve, delay));
        const polled = await adapter.rest.pollNousOAuth(state.workspace.id, started.session_id);
        if (polled.status === 'pending') { delay = polled.poll_after_ms; continue; }
        if (polled.status === 'connected') {
          popup?.close(); refreshKeys();
          setConnectStatus({ kind: 'connected', modelCount: polled.synced?.count ?? polled.key.synced_model_count });
          return;
        }
        popup?.close();
        setConnectStatus({ kind: 'error', message: polled.status === 'expired' ? 'Nous sign-in expired. Start again.' : 'Nous could not connect this workspace. Start again.' });
        return;
      }
      popup?.close();
      setConnectStatus({ kind: 'error', message: 'Nous sign-in expired. Start again.' });
    } catch (caught) {
      popup?.close();
      const error = caught as { status?: number; reason?: string };
      if (error.status === 401 && error.reason === 'reauth_required') {
        storeStepUp({ kind: 'provider_key', providerFlow: 'oauth', returnTo: window.location.href });
        const url = adapter.auth.stepUpUrl(window.location.href, 'provider_key');
        if (url) { window.location.assign(url); return; }
      }
      if (error.reason === 'oauth_not_configured') {
        setManualProviderFlow(true);
        setConnectStatus({ kind: 'oauth_unavailable', message: 'Signing in with Nous is not available on this deployment. Paste a Nous Portal key below instead.' });
      } else {
        setConnectStatus({ kind: 'error', message: 'Could not start Nous sign-in. Try again.' });
      }
    }
  };

  // Every other key mutation keeps its existing step-up boundary. Refreshing
  // invalidates the cached list so the next render reads the server's result.
  const guarded = async (run: () => Promise<unknown>, reason: 'provider_key' = 'provider_key'): Promise<void> => {
    try {
      await run();
      refreshKeys();
      setDialog(null);
      setSecret('');
    } catch (error) {
      const status = (error as { status?: number }).status;
      const code = (error as { reason?: string }).reason;
      if (status === 401 && code === 'reauth_required') {
        const url = adapter.auth.stepUpUrl(window.location.href, reason);
        if (url) {
          window.location.assign(url);
          return;
        }
        // Fake auth has no step-up route (see model/auth.ts): say so, rather
        // than looking like the key itself was refused.
        setNotice('This needs a recent sign-in. Sign in again to continue.');
        return;
      }
      setNotice(code === 'provider_rejected' ? 'Your Nous Portal key was rejected. Re-verify or rotate it.' : "Could not reach Nous Portal. We'll re-check shortly.");
    }
  };

  if (!admin) {
    return (
      <>
        <EmptyState icon="context" title={EMPTY.adminRequired} detail="Keys are never shown to a Member, not even masked values." />
      </>
    );
  }

  const connectButton = (
    <Button
      onClick={() => {
        setDialog('add');
        setTarget(null);
        setSecret('');
        setConnectStatus({ kind: 'idle' });
        setConnectKeyId(null);
        setAutoFocusKey(false);
        setManualProviderFlow(false);
        setNotice(null);
      }}
    >
      Connect Nous Portal
    </Button>
  );
  return (
    <>
      {/* With nothing connected, the button moves into the empty state. */}
      <AdminPageHeader title="Models" actions={!locked && keys.length > 0 ? connectButton : undefined} />
      {locked ? (
        <EmptyState
          icon="admission"
          title="Provider connection details are protected"
          detail="Your agents can keep using a saved Nous Portal connection in the background. Sign in again only to view or change connection settings."
          action={<Button onClick={revealConnectionStatus}>Sign in to manage</Button>}
        />
      ) : keys.length === 0 ? (
        <EmptyState icon="settings" title={EMPTY.providerKeys} action={connectButton} />
      ) : (
        <div className="col">
          {keys.map((key) => (
            <div className="list-row provider-key-row" key={key.id} style={{ minHeight: 96 }}>
              <Glass name="skill" size={28} className="row-icon" />
              <div className="row-id" style={{ width: 220 }}>
                <span className="t">{key.label}</span>
                <span className="s truncate" title={providerAccountLabel(key) ?? undefined}>
                  {providerName(key.provider)} · {key.credential_kind === 'oauth_device_code' ? 'Signed in with Nous' : `Key ending ${key.last4}`}
                  {providerAccountLabel(key) ? ` · ${providerAccountLabel(key)}` : ''}
                </span>
              </div>
              <div className="row-main">
                <span className="t">{usable(key) ? STATUS_LABEL[key.status] ?? 'Status unknown' : EMPTY.keyNotAllowed}</span>
                <span className="s">
                  {/* A Nous Portal key verifies against hundreds of models, so
                      the row says how many were synced and when, rather than
                      listing them (decision R7). */}
                  {syncLabel(key) ?? `${key.verified_models.length} model${key.verified_models.length === 1 ? '' : 's'}`} · added {new Date(key.created_at).toLocaleDateString()}
                  {key.rotated_at ? ` · replaced ${new Date(key.rotated_at).toLocaleDateString()}` : ''}
                </span>
              </div>
              {/* A key for a provider this deployment no longer offers keeps
                  its row and loses its buttons: the server answers 422
                  `provider_not_allowed` to verify and rotate (decision R12), so
                  offering them would be offering a refusal. Remove still works,
                  which is the only thing left worth doing to it. */}
              <div className="provider-key-actions">
                {usable(key) && (
                  <>
                  {key.provider === 'nous_portal' && (
                    <Button onClick={() => void guarded(() => adapter.rest.verifyProviderKey(state.workspace.id, key.id))}>Sync models</Button>
                  )}
                  <Button onClick={() => void guarded(() => adapter.rest.verifyProviderKey(state.workspace.id, key.id))}>{key.status === 'verified' || key.status === 'verified_scoped' ? 'Re-verify' : 'Verify'}</Button>
                  </>
                )}
                {key.credential_kind === 'api_key' && (
                  <Button
                    onClick={() => {
                      setTarget(key);
                      setDialog('rotate');
                    }}
                    disabled={!usable(key)}
                  >
                    Rotate
                  </Button>
                )}
                <Button danger
                  quiet
                  onClick={() => {
                    setTarget(key);
                    setDialog('remove');
                  }}
                >
                  Remove
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
      {notice && <p className="meta">{notice}</p>}

      <Dialog
        open={dialog === 'add'}
        title="Connect Nous Portal"
        onClose={closeConnect}
      >
        <ProviderConnect
          apiKey={secret}
          onApiKeyChange={(value) => {
            setSecret(value);
            if (connectStatus.kind === 'error') setConnectStatus({ kind: 'idle' });
          }}
          status={connectStatus}
          autoFocusKey={autoFocusKey}
          onConnect={() => void connect()}
          onRetry={() => void retryConnect()}
          onCancel={closeConnect}
          onDone={closeConnect}
          onOAuthStart={() => void startOAuth()}
          preferManual={manualProviderFlow}
        />
      </Dialog>

      <Dialog
        open={dialog === 'rotate'}
        title={`Rotate ${target?.label ?? ''}`}
        onClose={() => setDialog(null)}
        actions={
          <>
            <Button onClick={() => setDialog(null)}>Cancel</Button>
            <Button primary disabled={!secret.trim()} onClick={() => target && void guarded(() => adapter.rest.rotateProviderKey(state.workspace.id, target.id, secret.trim()))}>
              Rotate
            </Button>
          </>
        }
      >
        <label className="field">
          <span className="sr-only">New key</span>
          <input type="password" placeholder="Paste the new key" value={secret} onChange={(event) => setSecret(event.target.value)} autoComplete="off" />
        </label>
        <p className="meta">The new key replaces this one. Past usage still shows the old key.</p>
      </Dialog>

      <Dialog
        open={dialog === 'remove'}
        title={`Remove ${target?.label ?? ''}?`}
        onClose={() => setDialog(null)}
        actions={
          <>
            <Button onClick={() => setDialog(null)}>Keep</Button>
            <Button danger primary onClick={() => target && void guarded(() => adapter.rest.removeProviderKey(state.workspace.id, target.id))}>
              Remove
            </Button>
          </>
        }
      >
        <p>
          Your agents stop using {providerName(target?.provider)} until another key is connected. Work already in progress may stop.
        </p>
      </Dialog>
    </>
  );
}

/**
 * Usage.
 *
 * Three things, in this order: the sentence the server wrote, the numbers, and
 * the caps. `disclaimer` is rendered beside the total rather than in a
 * footnote, which is what `src/usage/aggregate.ts` asks for and why the string
 * is the server's rather than ours — a client that forgot it would be a client
 * quietly making a claim we cannot stand behind.
 *
 * One chart, model usage per day, as on Vercel's usage page. Cost per day and
 * per key are already the "By day" and "By key" lists below it, so they are not
 * drawn a second time. A range with one day has no shape to draw, so the chart
 * is left out rather than drawn as a flat line.
 */
function UsageTab() {
  const state = useAppState();
  const adapter = useAdapter();
  const [range, setRange] = useState<UsageRange>('7d');
  const [group, setGroup] = useState<'day' | 'session' | 'key'>('day');
  const [usage, setUsage] = useState<UsageReport | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!state.workspace.id) return;
    let live = true;
    setUsage(null);
    setError(null);
    void adapter.rest
      .usage(state.workspace.id, range)
      .then((report) => {
        if (live) setUsage(report);
      })
      .catch((caught: unknown) => {
        if (live) setError((caught as { reason?: string }).reason ?? 'http_error');
      });
    return () => {
      live = false;
    };
  }, [adapter, state.workspace.id, range]);

  const rows = useMemo(() => {
    if (!usage) return [] as { key: string; label: string; sub: string; cost: number }[];
    if (group === 'day')
      return usage.by_day.map((day) => ({
        key: day.day,
        label: formatUsageDay(day.day),
        sub: `${day.input_tokens.toLocaleString()} read · ${day.output_tokens.toLocaleString()} written · ${day.calls} request${day.calls === 1 ? '' : 's'}${day.errors ? ` · ${day.errors} failed` : ''}`,
        cost: day.cost_usd_estimate,
      }));
    if (group === 'session')
      return usage.by_session.map((row) => ({
        key: row.session_id ?? 'no-session',
        label: row.title ?? 'Untitled conversation',
        sub: `${row.total_tokens.toLocaleString()} used · ${row.runs} task${row.runs === 1 ? '' : 's'}${row.last_call_at ? ` · last used ${new Date(row.last_call_at).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}` : ''}`,
        cost: row.cost_usd_estimate,
      }));
    return usage.by_key.map((row) => ({
      key: row.key_id ?? `${row.provider}-deleted`,
      label: row.label ?? `${providerName(row.provider)} · removed key`,
      sub: `${row.total_tokens.toLocaleString()} used · ${row.calls} request${row.calls === 1 ? '' : 's'}${row.last4 ? ` · key ending ${row.last4}` : ''}${row.status ? ` · ${STATUS_LABEL[row.status] ?? 'Status unknown'}` : ''}`,
      cost: row.cost_usd_estimate,
    }));
  }, [usage, group]);

  return (
    <>
      <AdminPageHeader title="Usage" />
      <div className="row" style={{ gap: 16 }}>
        <Tabs
          tabs={[
            { id: 'today', label: 'Today' },
            { id: '7d', label: '7 days' },
            { id: '30d', label: '30 days' },
            { id: '90d', label: '90 days' },
          ]}
          value={range}
          onChange={(value) => setRange(value as UsageRange)}
          label="Usage range"
        />
      </div>
      {error && (
        <EmptyState
          icon="trace"
          title="Usage is unavailable"
          detail={error === 'contract_violation' ? 'Usage could not be shown. This is a problem on our side; try again later.' : 'Usage could not be loaded. Try again shortly.'}
        />
      )}
      {!usage && !error && <Skeleton rows={3} label="Loading usage" />}
      {usage && (
        <>
          <div className="stat-grid">
            <div className="stat">
              <span className="k">Model usage</span>
              <span className="v">{usage.totals.total_tokens.toLocaleString()}</span>
            </div>
            <div className="stat">
              <span className="k">Estimated cost</span>
              <span className="v">${usage.totals.cost_usd_estimate.toFixed(3)}</span>
            </div>
            <div className="stat">
              <span className="k">Requests</span>
              <span className="v">
                {usage.totals.calls.toLocaleString()}
                {usage.totals.errors ? ` · ${usage.totals.errors} failed` : ''}
              </span>
            </div>
          </div>
          <p className="meta">{usage.disclaimer}</p>
          {usage.caps.warn && (
            <Panel
              icon="admission"
              title="Close to the daily usage limit"
              subtitle={`${usage.caps.tokens_today.toLocaleString()} of ${usage.caps.daily_token_cap?.toLocaleString() ?? 'no limit'} used today · ${usage.caps.active_runs} of ${usage.caps.max_concurrent_runs} tasks running`}
            />
          )}
          {usage.by_day.length > 1 && (
            <div className="usage-card">
              <span className="meta">Model usage per day</span>
              <Sparkline values={usage.by_day.map((day) => day.total_tokens)} stroke="var(--accent, #4a86ff)" label={`Model usage per day over ${usage.by_day.length} days`} />
            </div>
          )}
          <Tabs
            tabs={[
              { id: 'day', label: 'By day' },
              { id: 'session', label: 'By conversation' },
              { id: 'key', label: 'By key' },
            ]}
            value={group}
            onChange={(value) => setGroup(value as 'day' | 'session' | 'key')}
            label="Usage grouping"
          />
          {rows.length === 0 ? (
            <EmptyState icon="trace" title="No usage yet" detail="Usage appears after the agent's first task." />
          ) : (
            <div className="col">
              {rows.map((row) => (
                <div className="list-row compact" key={row.key}>
                  <Glass name="trace" size={22} className="row-icon" />
                  <div className="row-main">
                    <span className="t">{row.label}</span>
                    <span className="s">{row.sub}</span>
                  </div>
                  <span className="meta">${row.cost.toFixed(3)}</span>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}

/** A report day (`YYYY-MM-DD`, already in the workspace's timezone) as "Sep 27". */
const formatUsageDay = (day: string): string => {
  const date = new Date(`${day}T00:00:00Z`);
  return Number.isNaN(date.getTime()) ? day : date.toLocaleDateString([], { month: 'short', day: 'numeric', timeZone: 'UTC' });
};

function Sparkline({ values, stroke, label }: { values: number[]; stroke: string; label: string }) {
  const max = Math.max(...values, 1);
  const width = 300;
  const height = 96;
  const step = values.length > 1 ? width / (values.length - 1) : width;
  const points = values.map((value, index) => `${(index * step).toFixed(1)},${(height - (value / max) * (height - 8) - 4).toFixed(1)}`);
  return (
    // Stretched to the card's width; the stroke keeps its weight when it is.
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" width="100%" height={height} role="img" aria-label={label} style={{ display: 'block' }}>
      <polyline points={points.join(' ')} fill="none" stroke={stroke} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

/**
 * Notification preferences.
 *
 * The shape is the server's: `{ notifications: { approvals, blocked, digest } }`
 * on the way in and `settingsView.notifications` on the way back. It used to
 * send `{ notify_approvals: true }`, which matches no field the server stores —
 * the route ignored it silently, and the toggles read `state.settings`, which
 * nothing ever populates, so every switch rendered off however many times it
 * had been pressed. The route answers 422 for an unknown key now, which is what
 * makes the old spelling impossible to leave in place.
 */
function NotificationsTab() {
  const state = useAppState();
  const adapter = useAdapter();
  const [ack, setAck] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<SettingsView | null>(null);

  useEffect(() => {
    if (!state.workspace.id) return;
    let live = true;
    void adapter.rest
      .settings(state.workspace.id)
      .then((next) => {
        if (live) setView(next);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [adapter, state.workspace.id]);

  const notifications = view?.notifications ?? { approvals: false, blocked: false, digest: false };
  const set = (key: 'approvals' | 'blocked' | 'digest', value: boolean): void => {
    setError(null);
    void adapter.rest
      .patchSettings(state.workspace.id, { notifications: { [key]: value } })
      .then((next) => {
        setView(next as SettingsView);
        setAck(true);
        setTimeout(() => setAck(false), 1400);
      })
      .catch(() => {
        setAck(false);
        setError('Could not save that. Try again.');
      });
  };
  return (
    <>
      <div className="row"><h2 className="section-title">Notification preferences</h2><span className="grow" /><span className="pill">Emails not turned on</span></div>
      <p className="meta">Hermes saves your choices, but this deployment does not send notification emails yet. The Inbox always shows what needs you.</p>
      {([
        ['approvals', 'Approval requests'],
        ['blocked', 'Blocked work'],
        ['digest', 'Daily digest'],
      ] as const).map(([key, label]) => (
        <div className="settings-row" key={key}>
          <span className="grow">{label}</span>
          <Toggle checked={notifications[key] === true} onChange={(value) => set(key, value)} label={label} />
        </div>
      ))}
      {error && <p className="meta" role="alert">{error}</p>}
      <div className="app-footer inline">
        <span className="meta">Preferences only · The Inbox stays on · No notification email is sent</span>
        <span className="grow" />
        <Ack show={ack} style={{ right: 0, top: -12, position: 'relative' }}>
          Preference saved
        </Ack>
      </div>
    </>
  );
}

/**
 * Data and privacy.
 *
 * The facts on this screen come from `GET /w/:ws/settings/data-privacy`: the
 * policy rows, retention table, erasure timing and per-provider warnings. The
 * client renames infrastructure nouns and codes into customer words
 * (docs/DESIGN.md) and writes the erasure and residency sentences from the
 * server's numbers; it never invents a retention period. The one
 * control is the attestation, and it is Admin plus step-up: whoever writes it
 * is asserting to a future auditor that a zero-retention arrangement or a DPA
 * exists.
 */
function privacyProviderLabel(provider: string): string {
  return providerName(provider);
}

function privacyErasureLabel(value: string): string {
  const labels: Record<string, string> = {
    redact_subject: 'Removed when a deletion request is processed',
    'redact_subject plus subject_key search': 'Removed with the related person’s data',
    'deleted by row': 'Deleted with the stored item',
    expires: 'Expires automatically',
    'expires on the bucket lifecycle rule': 'Expires automatically',
    'ids only, by rule': 'Holds no personal details; expires automatically',
    'ids only; redaction tested': 'Holds no personal details',
    'account deletion': 'Removed when the account is deleted',
  };
  const known = labels[value];
  if (known) return known;
  // Newer servers send plain words; anything that still looks like a code does not reach the screen.
  return /[_:]/u.test(value) || !/\s/u.test(value) ? 'Removed on request' : value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * The server's retention inventory, in customer words. The server still owns
 * which stores exist and how long each is kept; this only renames the
 * infrastructure nouns (docs/DESIGN.md). A store the map does not know keeps
 * the server's own name, which is prose rather than a code.
 */
const PRIVACY_STORES: Readonly<Record<string, string>> = {
  'Requests, notes and documents': 'Requests, notes and documents',
  'Turns, messages and stream events': 'Conversations and messages',
  'Uploads, extracted text and rendered documents': 'Uploaded files and generated documents',
  'Nightly backup copy': 'Nightly backup',
  'Workflow instance state': 'Background task records',
  'Database point-in-time history': 'Database recovery history',
  'Logs and error tracking': 'Logs and error reports',
  'Identity provider (WorkOS)': 'Sign-in provider (WorkOS)',
};
const PRIVACY_RETENTION: Readonly<Record<string, string>> = {
  'until tombstoned': 'Until deleted',
  'until deleted': 'Until deleted',
  '30 days after completion': '30 days after the task finishes',
  'authentication data only': 'Sign-in details only',
};
const privacyRetentionLabel = (value: string): string => PRIVACY_RETENTION[value] ?? value.charAt(0).toUpperCase() + value.slice(1);

/** What an Admin recorded about a provider's data terms. */
const DATA_TERMS: Readonly<Record<string, { label: string; sub: string }>> = {
  zdr: { label: 'Zero data retention', sub: 'Zero data retention is agreed with this provider' },
  dpa: { label: 'Data-processing agreement', sub: 'A data-processing agreement is signed' },
  synthetic_only: { label: 'Synthetic data only', sub: 'This key is for synthetic data only' },
  none: { label: 'Nothing claimed', sub: 'Nothing is claimed' },
};
const dataTermsLabel = (kind: unknown): string => (typeof kind === 'string' && DATA_TERMS[kind]?.label) || 'Recorded';

function PrivacyTab({ adminControls = false }: { adminControls?: boolean }) {
  const state = useAppState();
  const adapter = useAdapter();
  const admin = useIsAdmin() && adminControls;
  const [privacy, setPrivacy] = useState<DataPrivacy | null>(null);
  const [failed, setFailed] = useState(false);
  const [target, setTarget] = useState<DataPrivacy['keys'][number] | null>(null);
  const [kind, setKind] = useState('zdr');
  const [reference, setReference] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [reauthed, setReauthed] = useState(false);

  const load = (): void => {
    if (!state.workspace.id) return;
    void adapter.rest
      .dataPrivacy(state.workspace.id)
      .then((next) => {
        setPrivacy(next);
        setFailed(false);
      })
      .catch(() => setFailed(true));
  };
  useEffect(load, [adapter, state.workspace.id]);

  // On the way back from a step-up the pane says so and waits for a second,
  // deliberate click. The intent is read, never replayed.
  useEffect(() => {
    const intent = adapter.pendingStepUp();
    if (intent?.kind === 'provider_key') {
      setReauthed(true);
      adapter.clearStepUp();
    }
  }, [adapter]);

  const record = (): void => {
    if (!target) return;
    setNotice(null);
    void adapter.rest
      .setAttestation(state.workspace.id, target.key_id, { kind, reference: reference.trim() })
      .then(() => {
        setTarget(null);
        setReference('');
        setReauthed(false);
        load();
      })
      .catch((caught: unknown) => {
        const error = caught as { status?: number; reason?: string };
        if (error.status === 401 && error.reason === 'reauth_required') {
          storeStepUp({ kind: 'provider_key', keyId: target.key_id, returnTo: window.location.href });
          const url = adapter.auth.stepUpUrl(window.location.href, 'provider_key');
          if (url) window.location.assign(url);
          else setNotice('This needs a recent sign-in. Sign in again to continue.');
          return;
        }
        setNotice(error.reason === 'not_admin' ? EMPTY.adminRequired : 'Could not record the data terms. Try again.');
      });
  };

  return (
    <>
      {adminControls ? (
        <AdminPageHeader title="Data & privacy" />
      ) : (
        <div>
          <h2 className="section-title">Data and privacy</h2>
          <p className="meta">What Hermes keeps, for how long, and where.</p>
        </div>
      )}

      {failed && <EmptyState icon="context" title="Privacy details could not be loaded" detail="Try again shortly. Nothing here is shown from memory." />}
      {!privacy && !failed && <Skeleton rows={4} label="Loading retention facts" />}

      {privacy && (
        <>
          {privacy.policy.map((fact) => (
            <div className="kv" key={fact.id}>
              <span className="grow">{fact.id === 'jurisdiction' ? 'Data location' : fact.label}</span>
              <span className="meta" style={{ textAlign: 'right', maxWidth: 380 }}>
                {fact.id === 'jurisdiction' ? (fact.value === 'eu' ? 'European Union' : 'Standard') : fact.value}
              </span>
            </div>
          ))}

          <h2 className="section-title">Processors</h2>
          {privacy.keys.length === 0 && <EmptyState compact icon="trace" title="No provider is configured" detail="No prompt text leaves this workspace." />}
          {privacy.keys.map((key) => admin ? (
            <div className="col" key={key.key_id} style={{ gap: 8, padding: '14px 0', borderBottom: '1px solid var(--line)' }}>
              <div className="row">
                <div className="row-main">
                  <span className="t">
                    {key.label} · {providerName(key.provider)}
                  </span>
                  <span className="s">
                    Key ending {key.last4} · {STATUS_LABEL[key.status] ?? 'Status unknown'}
                    {key.verified_at ? ` · verified ${new Date(key.verified_at).toLocaleDateString()}` : ' · not verified yet'}
                  </span>
                </div>
                <span className="meta">{key.attested ? `Data terms: ${dataTermsLabel(key.attestation?.kind)}` : 'No data terms recorded'}</span>
                <Button
                  onClick={() => {
                    setTarget(key);
                    setKind(String(key.attestation?.kind ?? 'zdr'));
                    setReference(String(key.attestation?.reference ?? ''));
                    setNotice(null);
                  }}
                >
                  {key.attested ? 'Update data terms' : 'Record data terms'}
                </Button>
              </div>
              <span className="meta">{key.real_data_allowed ? 'Real applicant data is allowed on this key: an Admin recorded its data terms and the provider has no storage-location warning.' : 'Real applicant data is not allowed on this key. Use synthetic or consented data.'}</span>
              {key.warnings.map((warning) => (
                <p className="meta" key={warning} style={{ maxWidth: 720 }}>
                  {warning}
                </p>
              ))}
            </div>
          ) : (
            <div className="col" key={key.key_id} style={{ gap: 8, padding: '14px 0', borderBottom: '1px solid var(--line)' }}>
              <div className="row">
                <span className="grow">{privacyProviderLabel(key.provider)}</span>
                <span className="meta">{key.real_data_allowed ? 'Approved for real workspace data' : 'Synthetic or consented data only'}</span>
              </div>
              {key.warnings.map((warning) => <p className="meta" key={warning} style={{ maxWidth: 720 }}>{warning}</p>)}
            </div>
          ))}

          <h2 className="section-title">What is kept, and for how long</h2>
          <div className="col">
            {privacy.retention.map((fact) => (
              <div className="kv" key={fact.store}>
                <span className="grow">{PRIVACY_STORES[fact.store] ?? fact.store}</span>
                <span className="meta" style={{ textAlign: 'right', maxWidth: 420 }}>
                  {privacyRetentionLabel(fact.retention)} · {privacyErasureLabel(fact.erasure)}
                </span>
              </div>
            ))}
          </div>

          <h2 className="section-title">Erasure</h2>
          <div className="stat-grid">
            <div className="stat">
              <span className="k">Removed from Hermes</span>
              <span className="v">{privacy.erasure.tombstone === 'immediate' ? 'Right away' : 'Soon after you ask'}</span>
            </div>
            <div className="stat">
              <span className="k">Database recovery history</span>
              <span className="v">{privacy.erasure.point_in_time_history_days} days</span>
            </div>
            <div className="stat">
              <span className="k">Backup copy</span>
              <span className="v">{privacy.erasure.backup_retention_days} days</span>
            </div>
            <div className="stat">
              <span className="k">Complete after</span>
              <span className="v">{privacy.erasure.complete_after_days} days</span>
            </div>
          </div>

          <h2 className="section-title">Where the data is stored</h2>
          {(
            [
              ['Sign-in provider', privacy.residency.identity_provider],
              ['Database (Neon)', 'The region chosen when this workspace was created'],
              ['File storage (Cloudflare)', 'The region chosen when this workspace was created'],
              ['Processing (Cloudflare)', 'Wherever each request arrives; no region setting'],
            ] as const
          ).map(([label, value]) => (
            <div className="kv" key={label}>
              <span className="grow">{label}</span>
              <span className="meta" style={{ textAlign: 'right', maxWidth: 480 }}>
                {value}
              </span>
            </div>
          ))}
        </>
      )}

      <h2 className="section-title">Attribution</h2>
      <div className="kv">
        <span className="grow">Interface components</span>
        <span className="meta">
          <a href="/LICENSE.beautiful-ui">Beautiful UI · MIT</a>
        </span>
      </div>

      {adminControls && <Dialog
        open={!!target}
        title={`Data terms for ${target?.label ?? ''}`}
        onClose={() => setTarget(null)}
        actions={
          <>
            <Button onClick={() => setTarget(null)}>Cancel</Button>
            <Button primary onClick={record}>
              {reauthed ? 'Confirm and record' : 'Record'}
            </Button>
          </>
        }
      >
        {reauthed && <p className="meta">You signed in again. Confirm to continue.</p>}
        <div className="col" role="radiogroup" aria-label="Data terms" style={{ gap: 4 }}>
          {(['zdr', 'dpa', 'synthetic_only', 'none'] as const).map((value) => (
            <MenuItem key={value} checked={kind === value} sub={DATA_TERMS[value]!.sub} onClick={() => setKind(value)}>
              {DATA_TERMS[value]!.label}
            </MenuItem>
          ))}
        </div>
        <label className="field">
          <span className="sr-only">Reference</span>
          <input placeholder="Contract or ticket reference" value={reference} onChange={(event) => setReference(event.target.value)} />
        </label>
        <p className="meta">Recorded with your name and the time. It says how long the provider keeps data, not where it stores it, so it does not answer a storage-location warning.</p>
        {notice && <p className="meta" role="alert">{notice}</p>}
      </Dialog>}
    </>
  );
}
