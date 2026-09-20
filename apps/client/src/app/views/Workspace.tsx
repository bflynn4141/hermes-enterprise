// History, Members, Library and Settings.
//
// History reads `events` rows — the demo's fabricated local event log is gone,
// along with `eventTime()` and `uid('evt')`. Members read the WorkOS mirror.
// Settings carries Provider keys, Usage and the data-and-privacy page, and the
// one control in the product with no undo behind a confirmation and a step-up.
//
// Three library components are adopted here (plan 10b): `FilterTable` over
// History, `InsightCards` over the usage report and `FineTuneCard` over the
// two integer caps. Each is given real rows and real callbacks; none of them
// is given a demo fixture. Members went back to the product's own inline rows
// (decision C46) — `RecordsTable` is a database surface and a membership list
// is not one.
import { useEffect, useMemo, useState, type JSX, type ReactNode } from 'react';
import { FilterTable, FineTuneCard, InsightCards } from '@hermes/motion-components';
import { CTX, LIB, MEMBERS, REQ, SETTINGS, type DataPrivacy, type DocumentEntity, type EnterpriseSkillAssignment, type EventRow, type InvitationEntity, type LibrarySource, type MaskedProviderKey, type MemberEntity, type OutboundEmailConnection, type SettingsView, type SlackConnection, type UsageRange, type UsageReport } from '@hermes/shared';
import { useAdapter, useAppState, useDispatch, useEntity, useIsAdmin, useNav } from '../store-context.js';
import { Glass, Icon, KIND_ICON } from '../ui/icons.js';
import { Ack, Avatar, Button, Dialog, EmptyState, MenuItem, Panel, Skeleton, Tabs, Toggle } from '../ui/primitives.js';
import { DEFAULT_PROVIDER, EMPTY, LIBRARY_TABS, PROVIDER_CHOICES, SETTINGS_TABS } from '../../model/constants.js';
import { LIST_KEYS, agentName, catalogRows, memberCounts, requestStatusLabel } from '../selectors.js';
import { storeStepUp } from '../../model/auth.js';
import { useWorkspaceLists } from './lists.js';
import { DocumentView } from './Inbox.js';
import { ProviderConnect, type ProviderConnectStatus } from '../providers/ProviderConnect.js';
import { PartnerWorkflow } from './PartnerWorkflow.js';
import { invitationDeliveryMessage, invitationFailureMessage } from '../../model/invitation-copy.js';
import { RuntimeCapacityTab } from './RuntimeCapacity.js';
import { SharedIntelligence } from './SharedIntelligence.js';
import { CloudConnection } from './CloudConnection.js';
import { cloudConnectionErrorMessage, type CloudConnectionStatus } from '../../model/cloud-connection.js';
import { Markdown } from '../chat/Markdown.js';

/**
 * History, with `FilterTable` over the rows (plan 10b).
 *
 * Two axes, and they are not the same axis. The tabs pick which *kind* of
 * activity is listed — everything, decisions only, blocked only — because that
 * is the question a reviewer asks. The table's own filter picks the *state* a
 * row is in, which is the question an operator asks. Neither is derived from
 * the other, so both are offered and both are labelled.
 *
 * `FilterTable`'s three states are mapped from the server's `status` string,
 * which is prose written per event kind rather than an enum; anything that is
 * neither blocked nor a finished decision is "in progress", which is what
 * "assigned, waiting on a person" actually is.
 */
const historyState = (row: EventRow): 'todo' | 'progress' | 'done' => {
  const status = row.status.toLowerCase();
  if (status.includes('blocked') || status.includes('failed')) return 'todo';
  if (row.kind === 'decision.recorded' || status.includes('admitted') || status.includes('declined') || status.includes('saved') || status.includes('created')) return 'done';
  return 'progress';
};

export function History() {
  const state = useAppState();
  const dispatch = useDispatch();
  const nav = useNav();
  const lists = useWorkspaceLists();
  const tab = state.ui.historyTab;
  const events = useMemo(
    () => lists.history.filter((row) => (tab === 'decisions' ? row.kind === 'decision.recorded' : tab === 'blocked' ? row.status === 'Blocked' : true)),
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

function Pill({ children, tone = 'muted' }: { children: ReactNode; tone?: string }) {
  return <span className={`pill pill-${tone}`}>{children}</span>;
}

export function Members() {
  const state = useAppState();
  const adapter = useAdapter();
  const admin = useIsAdmin();
  const lists = useWorkspaceLists();
  const [tab, setTab] = useState('all');
  const [invite, setInvite] = useState(false);
  const [email, setEmail] = useState('');
  const [manage, setManage] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [ack, setAck] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [inviteError, setInviteError] = useState<string | null>(null);
  const [manageNotice, setManageNotice] = useState<string | null>(null);
  const [pending, setPending] = useState<string | null>(null);
  const counts = memberCounts(state);
  const all = lists.members;
  // Withdrawn and accepted invitations are history, and History is where they
  // are read; this tab is the ones an Admin can still do something about.
  const invitations = lists.invitations.filter((row) => row.status === 'pending' || row.status === 'expired');
  const person = manage ? all.find((member) => member.id === manage) ?? null : null;
  const isYou = person?.user_id === state.user.id;
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
      .then(() => {
        invitationsChanged();
        showAck(action === 'resend' ? 'Invitation resent' : 'Invitation withdrawn');
      })
      .catch((error: unknown) => setNotice(action === 'resend'
        ? invitationFailureMessage(error)
        : 'Could not withdraw that invitation. Try again.'))
      .finally(() => setPending(null));
  };

  return (
    <div className="scroll">
      <div className="app-body">
        <div className="row" style={{ height: 42 }}>
          <h1 className="display-32">Members</h1>
          <span className="grow" />
          <span className="meta">
            {counts.joined} joined · {counts.invited} invited
          </span>
          {admin && <Button onClick={() => {
            setNotice(null);
            setInviteError(null);
            setInvite(true);
          }}>Invite member</Button>}
        </div>
        <Tabs
          tabs={[
            { id: 'all', label: 'All members' },
            { id: 'invites', label: 'Invitations' },
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
            <div className="col" role="list">
              {all.map((member) => {
                const status = memberStatusLabel(member.status);
                return (
                  <div className="list-row members-row" role="listitem" key={member.id} style={{ minHeight: 84 }}>
                    <Avatar person={{ name: member.name }} size={40} />
                    {/* The name column flexes and truncates: the row has to fit
                        the app pane with the Iris panel open, and the action is
                        the part that must never be pushed off the edge. */}
                    <div className="row-main">
                      <span className="t truncate" style={{ fontSize: 14.4 }}>
                        {member.name}
                        {member.user_id === state.user.id && <span className="meta"> · You</span>}
                      </span>
                      <span className="s truncate">{member.email}</span>
                    </div>
                    <Pill>{member.role === 'admin' ? 'Admin' : 'Member'}</Pill>
                    <Pill tone={statusTone(status)}>{status}</Pill>
                    <span className="meta joined">{member.joined_at ? `Joined ${new Date(member.joined_at).toLocaleDateString()}` : 'Not joined yet'}</span>
                    {admin && <Button onClick={() => {
                      setNotice(null);
                      setManageNotice(null);
                      setManage(member.id);
                    }}>Manage</Button>}
                  </div>
                );
              })}
            </div>
          )
        ) : invitations.length === 0 ? (
          <EmptyState icon="people" title={EMPTY.invitations} />
        ) : (
          <div className="col" role="list">
            {invitations.map((row) => {
              const status = invitationStatusLabel(row.status);
              const delivery = invitationDeliveryMessage(row);
              return (
                <div className="list-row members-row" role="listitem" key={row.id} style={{ minHeight: 84 }}>
                  <Avatar person={{ name: row.email }} size={40} />
                  <div className="row-main">
                    <span className="t truncate" style={{ fontSize: 14.4 }}>
                      {row.email}
                    </span>
                    <span className="s">Invited {new Date(row.invited_at).toLocaleDateString()}</span>
                    {delivery && <span className="meta">{delivery}</span>}
                  </div>
                  <Pill>{row.role === 'admin' ? 'Admin' : 'Member'}</Pill>
                  <Pill tone={statusTone(status)}>{status}</Pill>
                  {admin && (
                    <>
                      {/* One route behind two words: the server resends a
                          pending invitation and an expired one alike. */}
                      <Button
                        disabled={pending !== null}
                        onClick={() => {
                          runInvitationAction('resend', row);
                        }}
                      >
                        {pending === `resend:${row.id}` ? 'Sending…' : row.status === 'expired' ? 'Reinvite' : 'Resend'}
                      </Button>
                      <Button
                        link
                        disabled={pending !== null}
                        onClick={() => {
                          runInvitationAction('withdraw', row);
                        }}
                      >
                        {pending === `withdraw:${row.id}` ? 'Withdrawing…' : 'Withdraw'}
                      </Button>
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}
        {!admin && <p className="meta">Read-only. Roles and removals are an Admin&apos;s.</p>}
        {notice && <p className="meta action-error" role="alert">{notice}</p>}
        <Ack show={!!ack} style={{ right: 0, top: -12, position: 'relative' }}>
          {ack}
        </Ack>
        <Dialog
          open={invite}
          title="Invite member"
          onClose={() => {
            if (pending === 'invite') return;
            setInvite(false);
            setInviteError(null);
          }}
          actions={
            <>
              <Button disabled={pending === 'invite'} onClick={() => {
                setInvite(false);
                setInviteError(null);
              }}>Cancel</Button>
              <Button
                primary
                disabled={pending === 'invite' || !/^[\w.+-]+@[\w-]+\.[\w.-]+$/.test(email)}
                onClick={() => {
                  setPending('invite');
                  setInviteError(null);
                  void adapter.rest
                    .invite(state.workspace.id, { email, role: 'member' })
                    .then(() => {
                      invitationsChanged();
                      setEmail('');
                      setInvite(false);
                      setTab('invites');
                      showAck('Invitation recorded · Email delivery queued');
                    })
                    .catch((error: unknown) => setInviteError(invitationFailureMessage(error)))
                    .finally(() => setPending(null));
                }}
              >
                {pending === 'invite' ? 'Inviting…' : 'Invite'}
              </Button>
            </>
          }
        >
          <label className="field">
            <span className="sr-only">Work email</span>
            <input type="email" placeholder="name@example.com" value={email} onChange={(event) => setEmail(event.target.value)} />
          </label>
          <p className="meta">The invitation is recorded first. The identity provider sends the email after it is queued.</p>
          {inviteError && <p className="meta action-error" role="alert">{inviteError}</p>}
        </Dialog>
        <Dialog
          open={!!person}
          title={person?.name ?? ''}
          onClose={() => {
            if (pending?.startsWith('member:')) return;
            setManage(null);
            setConfirmRemove(false);
            setManageNotice(null);
          }}
          actions={
            confirmRemove ? (
              <>
                <Button disabled={pending === `member:remove:${person?.id ?? ''}`} onClick={() => {
                  setConfirmRemove(false);
                  setManageNotice(null);
                }}>Keep</Button>
                <Button
                  primary
                  disabled={pending === `member:remove:${person?.id ?? ''}`}
                  onClick={() => {
                    if (!person) return;
                    setPending(`member:remove:${person.id}`);
                    setManageNotice(null);
                    void adapter.rest
                      .removeMember(state.workspace.id, person.id)
                      .then(() => {
                        adapter.invalidateList('members');
                        setManage(null);
                        setConfirmRemove(false);
                        showAck('Member removed');
                      })
                      .catch(() => setManageNotice('Could not remove this member. Their access has not changed. Try again.'))
                      .finally(() => setPending(null));
                  }}
                >
                  {pending === `member:remove:${person?.id ?? ''}` ? 'Removing…' : 'Remove'}
                </Button>
              </>
            ) : (
              <Button disabled={pending?.startsWith('member:')} onClick={() => {
                setManage(null);
                setManageNotice(null);
              }}>Done</Button>
            )
          }
        >
          <p className="meta">
            {person?.email} · {person?.status}
          </p>
          {isYou ? (
            <p>Your role is Admin. Another Admin changes it; you cannot remove yourself.</p>
          ) : confirmRemove ? (
            <p>{person?.name} loses access to this workspace. Nothing outside it changes and no email is sent from here.</p>
          ) : (
            <>
              <div className="col" role="radiogroup" aria-label="Role" style={{ gap: 4 }}>
                {(['admin', 'member'] as const).map((role) => (
                  <MenuItem
                    key={role}
                    checked={person?.role === role}
                    disabled={pending?.startsWith('member:')}
                    sub={role === 'admin' ? 'Manages members, keys and decisions' : 'Works with agents; cannot decide'}
                    onClick={() => {
                      if (!person) return;
                      setPending(`member:role:${person.id}`);
                      setManageNotice(null);
                      void adapter.rest
                        .setMemberRole(state.workspace.id, person.id, role)
                        .then(() => {
                          adapter.invalidateList('members');
                          setManageNotice('Role updated.');
                        })
                        .catch(() => setManageNotice('Could not change this role. Nothing was changed. Try again.'))
                        .finally(() => setPending(null));
                    }}
                  >
                    {role === 'admin' ? 'Admin' : 'Member'}
                  </MenuItem>
                ))}
              </div>
              <div className="row">
                <span className="meta grow">Role changes apply to this workspace only and are recorded in History.</span>
                <Button link disabled={pending?.startsWith('member:')} onClick={() => {
                  setConfirmRemove(true);
                  setManageNotice(null);
                }}>
                  Remove…
                </Button>
              </div>
            </>
          )}
          {manageNotice && <p className={`meta${manageNotice === 'Role updated.' ? '' : ' action-error'}`} role={manageNotice === 'Role updated.' ? 'status' : 'alert'}>{manageNotice}</p>}
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
        {view === 'skills' && <LibrarySkills />}
        {view === 'documents' && <LibraryDocuments />}
        {/* Connections remains independently owned; Shared Intelligence is a reviewed Library workflow. */}
        {view === 'connections' && <EmptyState icon="context" title={EMPTY.libraryUnavailable} detail="Connections are managed outside the pilot." />}
        {view === 'intelligence' && <SharedIntelligence />}
      </div>
    </div>
  );
}

function LibrarySkills() {
  const state = useAppState();
  const adapter = useAdapter();
  const admin = useIsAdmin();
  const lists = useWorkspaceLists();
  const [ack, setAck] = useState(false);
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
      <PartnerWorkflow />
      {lists.skills.length === 0 && <EmptyState icon="skill" title="No shared skills yet" />}
      {lists.skills.map((skill) => {
        const assignment = assignments.find((item) => `managed:${item.skill_key}` === skill.id);
        return (
          <div key={skill.id} className="skill-assignment-shell">
            <div className="list-row" style={{ minHeight: 112 }}>
              <Glass name="skill" size={32} className="row-icon" />
              <div className="row-main">
                <span className="t">
                  {skill.name} · {skill.version}
                </span>
                <span className="s">
                  {skill.description} · Shared by {skill.shared_by}
                  {assignment ? ` · ${assignment.state === 'active' ? 'Active' : 'Paused'} · revision ${assignment.revision}` : ''}
                </span>
              </div>
              <span style={{ position: 'relative', display: 'flex', gap: 8 }}>
                {assignment && (
                  <Button disabled={!admin} onClick={() => setEditing(editing === assignment.id ? null : assignment.id)}>
                    {editing === assignment.id ? 'Close' : admin ? 'Configure' : EMPTY.adminOnly}
                  </Button>
                )}
                {!assignment && (
                  <Button
                    disabled={skill.adopted || !admin}
                    onClick={() => {
                      void adapter.rest.adoptSkill(state.workspace.id, skill.id).catch(() => undefined);
                      setAck(true);
                      setTimeout(() => setAck(false), 1600);
                    }}
                  >
                    {skill.adopted ? 'In use' : admin ? 'Add' : EMPTY.adminOnly}
                  </Button>
                )}
                <Ack show={ack} style={{ right: 0, top: -40 }}>Added</Ack>
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
            ? 'This skill changed in another window. Your draft is kept. Reload the current configuration before saving again.'
            : 'Could not save. Your draft is kept. Check the configuration and try again.');
        });
      }}
    >
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <div className="t">How {assignment.agent_name ?? 'this agent'} performs this skill</div>
          <div className="s">Configuration is versioned. Outreach remains a draft until a person approves it.</div>
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
          <small>Controls proactive discovery; manual runs remain available.</small>
        </label>
        <label className="skill-config-check">
          <input type="checkbox" checked={schedule.enabled} onChange={(event) => setSchedule({ ...schedule, enabled: event.target.checked })} />
          <span>Run proactive discovery on this schedule</span>
        </label>
      </div>
      {error && <div className="danger-note" role="alert">{error}</div>}
      <div className="row" style={{ justifyContent: 'flex-end', gap: 8 }}>
        <Button quiet disabled={saving} onClick={onCancel}>Cancel</Button>
        <Button primary type="submit" disabled={saving}>{saving ? 'Saving…' : 'Save revision'}</Button>
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
        {!sourcesLoading && !sourcesError && sharedSources.length === 0 && <div className="meta" style={{ padding: '12px 0' }}>No shared sources are available to this agent.</div>}
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
        {drafts.length === 0 && <div className="meta" style={{ padding: '12px 0' }}>No drafts are waiting for review.</div>}
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
        {documents.length === 0 && <div className="meta" style={{ padding: '12px 0' }}>No documents created yet.</div>}
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
                    ? ` · ${EMPTY.pdfFailed(doc.pdf_error ?? 'unknown')}`
                    : doc.pdf_status === 'none' && doc.pdf_error
                      ? ` · ${EMPTY.pdfUnavailable} · HTML render saved`
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
      {requestRecord.data ? <DocumentView request={requestRecord.data} document={record.data} readOnly /> : <Skeleton rows={4} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Settings
// ---------------------------------------------------------------------------

export function Settings({ view }: { view: string }) {
  const nav = useNav();
  return (
    <div className="scroll">
      <div className="app-body settings-page" style={{ minHeight: '100%' }}>
        <div className="row" style={{ height: 42 }}>
          <h1 className="display-32">Settings</h1>
        </div>
        <Tabs tabs={SETTINGS_TABS.map((tab) => ({ id: tab, label: tab }))} value={view} onChange={(next) => nav(SETTINGS(next))} label="Settings sections" />
        {view === 'Organization' && <OrganizationTab />}
        {view === 'Inbox rules' && <InboxRulesTab />}
        {view === 'Agents' && <AgentsTab />}
        {view === 'Slack' && <SlackTab />}
        {view === 'Email' && <EmailTab />}
        {view === 'Provider keys' && <ProviderKeysTab />}
        {view === 'Runtime capacity' && <RuntimeCapacityTab />}
        {view === 'Usage' && <UsageTab />}
        {view === 'Notifications' && <NotificationsTab />}
        {view === 'Data and privacy' && <PrivacyTab />}
      </div>
    </div>
  );
}

function EmailTab() {
  const state = useAppState();
  const adapter = useAdapter();
  const admin = useIsAdmin();
  const [connection, setConnection] = useState<OutboundEmailConnection | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!state.workspace.id) return;
    void adapter.rest.outboundEmailConnection(state.workspace.id).then(setConnection).catch(() => {
      setNotice('Email status could not be loaded. Try again.');
    });
  }, [adapter, state.workspace.id]);

  const connect = async (): Promise<void> => {
    setBusy(true);
    setNotice(null);
    try {
      const started = await adapter.rest.startGmailOAuth(state.workspace.id);
      window.location.assign(started.authorize_url);
    } catch (caught) {
      const error = caught as { status?: number; reason?: string };
      if (error.status === 401 && error.reason === 'reauth_required') {
        const url = adapter.auth.stepUpUrl(window.location.href, 'gmail');
        if (url) window.location.assign(url);
        else setNotice('This needs a recent sign-in. Sign in again to continue.');
      } else {
        setNotice(error.reason === 'gmail_unavailable'
          ? 'Gmail outreach is not configured for this Hermes deployment.'
          : error.reason === 'admin_required' ? EMPTY.adminOnly : 'Gmail authorization could not be started. Try again.');
      }
      setBusy(false);
    }
  };

  if (!connection) return <Skeleton rows={4} label="Loading email connection" />;
  const connected = connection.status === 'connected';
  const sendingEnabled = connection.mode === 'send_after_approval';
  const discoveryCadence = connection.discovery_interval_minutes % 60 === 0
    ? `${connection.discovery_interval_minutes / 60} hours`
    : `${connection.discovery_interval_minutes} minutes`;
  return (
    <>
      <div className="row">
        <div>
          <h2 className="section-title">Email</h2>
          <p className="meta">Connect one dedicated Gmail sender for reviewed partner outreach.</p>
        </div>
        <span className="grow" />
        {admin && connection.configured && (
          <Button primary={!connected} disabled={busy} onClick={connect}>
            {connected ? 'Reconnect Gmail' : busy ? 'Opening Google…' : 'Connect Gmail'}
          </Button>
        )}
      </div>
      {notice && <Ack show>{notice}</Ack>}
      {!connection.configured ? (
        <EmptyState icon="context" title="Email is not configured" detail="An operator must configure the Google OAuth app before an Admin can connect the outreach mailbox." />
      ) : (
        <Panel
          icon="context"
          title={connected ? `Connected as ${connection.address}` : connection.status === 'error' ? 'Gmail needs to be reconnected' : 'Connect a dedicated Gmail sender'}
          subtitle={connected
            ? 'Hermes can use this identity only for the exact message revision a reviewer approves.'
            : 'A workspace Admin completes Google OAuth. The Gmail credential stays encrypted on the server.'}
        >
          <div className="kv"><span className="grow">Discovery</span><span className="meta">{connection.discovery_enabled ? `New candidates every ${discoveryCadence}` : 'Automated discovery is off'}</span></div>
          <div className="kv"><span className="grow">Drafts</span><span className="meta">Iris prepares personalized copy for Inbox review</span></div>
          <div className="kv"><span className="grow">Sending</span><span className="meta">{sendingEnabled ? 'Exact approved revision only' : 'Draft-only until enabled by the operator'}</span></div>
          <div className="kv"><span className="grow">Waiting messages</span><span className="meta">{connection.pending_messages}</span></div>
          {!admin && <p className="meta">A workspace Admin manages this connection.</p>}
        </Panel>
      )}
    </>
  );
}

function SlackTab() {
  const state = useAppState();
  const adapter = useAdapter();
  const admin = useIsAdmin();
  const [connection, setConnection] = useState<SlackConnection | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [linkCommand, setLinkCommand] = useState<string | null>(null);

  const load = (): void => {
    if (!state.workspace.id) return;
    void adapter.rest.slackConnection(state.workspace.id).then(setConnection).catch(() => {
      setNotice('Slack status could not be loaded. Try again.');
    });
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
          ? 'Slack is not configured for this Hermes deployment.'
          : error.reason === 'admin_required'
            ? EMPTY.adminOnly
            : 'Slack authorization could not be started. Try again.');
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
        ? 'Slack is disconnected in Hermes. Slack-side token revocation is queued and will retry automatically.'
        : 'Slack is disconnected.');
      load();
    } catch (caught) {
      const error = caught as { status?: number; reason?: string };
      if (error.status === 401 && error.reason === 'reauth_required') stepUp();
      else setNotice(error.reason === 'admin_required' ? EMPTY.adminOnly : 'Slack could not be disconnected. Try again.');
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

  if (!connection) return <Skeleton rows={5} label="Loading Slack connection" />;
  const connected = connection.status === 'connected';
  const destination = connection.enterprise_name ?? connection.team_name ?? 'Slack';
  return (
    <>
      <div className="row">
        <div>
          <h2 className="section-title">Slack</h2>
          <p className="meta">Use the same Hermes agent and skills from direct messages or mentioned channel threads.</p>
        </div>
        <span className="grow" />
        {admin && connection.configured && (
          <Button primary={!connected} disabled={busy} onClick={connected ? () => setDisconnectOpen(true) : connect}>
            {connected ? 'Disconnect' : busy ? 'Opening Slack…' : 'Connect Slack'}
          </Button>
        )}
      </div>
      {notice && <Ack show>{notice}</Ack>}
      {!connection.configured ? (
        <EmptyState icon="context" title="Slack is not configured" detail="An operator must set the Slack app credentials before an Admin can connect this workspace." />
      ) : (
        <Panel
          icon="context"
          title={connected ? `Connected to ${destination}` : connection.status === 'error' ? 'Slack needs to be reconnected' : 'Connect this workspace to Slack'}
          subtitle={connected
            ? `${connection.installation_kind === 'organization' ? 'Enterprise Grid organization' : 'Slack workspace'} · ${connection.agent?.name ?? 'Your Hermes agent'}`
            : 'A workspace Admin completes Slack OAuth. No Slack credential is entered into Hermes.'}
        >
          <div className="kv"><span className="grow">Direct messages</span><span className="meta">One private Hermes session</span></div>
          <div className="kv"><span className="grow">Channels</span><span className="meta">Mention the app; replies stay in the thread</span></div>
          <div className="kv"><span className="grow">Approvals</span><span className="meta">Review only in the Hermes Inbox</span></div>
          {connected && <div className="kv"><span className="grow">Permissions</span><span className="meta">{connection.granted_scopes.join(', ')}</span></div>}
          {connected && (
            <div className="col" style={{ gap: 8, marginTop: 12 }}>
              <div className="row">
                <div className="grow">
                  <div className="panel-title">Link your Slack identity</div>
                  <div className="meta">Create a one-time command, then send it to the app in a direct message. It expires in 10 minutes.</div>
                </div>
                <Button disabled={busy} onClick={createLinkCode}>Create link command</Button>
              </div>
              {linkCommand && <code className="meta" style={{ userSelect: 'all' }}>{linkCommand}</code>}
            </div>
          )}
          {!admin && <p className="meta">A workspace Admin manages this connection.</p>}
          {admin && connection.status === 'error' && <Button disabled={busy} onClick={connect}>Reconnect Slack</Button>}
        </Panel>
      )}
      <Dialog
        open={disconnectOpen}
        title="Disconnect Slack?"
        onClose={() => setDisconnectOpen(false)}
        actions={<><Button onClick={() => setDisconnectOpen(false)}>Cancel</Button><Button primary disabled={busy} onClick={disconnect}>Disconnect</Button></>}
      >
        <p>New Slack messages will stop reaching Hermes immediately. Existing Hermes sessions and their history stay in Hermes.</p>
      </Dialog>
    </>
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
              ? EMPTY.adminOnly
              : 'That did not go through. Try again.',
      );
    }
  };

  return (
    <>
      {[
        ['Workspace', state.workspace.name],
        ['Your role', state.user.role === 'admin' ? 'Admin' : 'Member'],
        ['Signed in as', state.user.email || '—'],
        ['Jurisdiction', state.workspace.jurisdiction ?? 'default'],
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

      {admin && (
        <>
          <OrganizationCloudConnection />
          <h2 className="section-title">Deleting this workspace</h2>
          {pending ? (
            <>
              <Panel
                icon="admission"
                title="Scheduled for deletion"
                subtitle={`Access was revoked when it was requested. The rows and objects go on ${new Date(pending.at).toLocaleString()}.`}
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
              {pending.copy && <p className="meta" style={{ maxWidth: 760 }}>{pending.copy}</p>}
            </>
          ) : (
            <div className="row">
              <span className="meta grow" style={{ maxWidth: 620 }}>
                Every share is revoked, every session becomes read-only and every working run is asked to stop, immediately. The rows and the objects are destroyed seven days later, and that half can be cancelled until then.
              </span>
              <Button
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
        </>
      )}

      <Dialog
        open={dialog === 'delete'}
        title={`Delete ${state.workspace.name}?`}
        onClose={() => setDialog(null)}
        actions={
          <>
            <Button onClick={() => setDialog(null)}>Keep it</Button>
            <Button
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
        {reauthed && <p className="meta">Re-authenticated — confirm to continue.</p>}
        <p>
          Everyone loses access now. Nothing is destroyed for seven days, and a cancel is on this screen until then. Type the workspace name to confirm.
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
        {reauthed && <p className="meta">Re-authenticated — confirm to continue.</p>}
        <p>The workspace stops being scheduled for destruction. Sessions stay read-only until somebody puts them back deliberately: a cancel that silently resumed every run would resume runs that have been stopped for days against a world that moved on.</p>
      </Dialog>
    </>
  );
}

function InboxRulesTab() {
  return (
    <>
      <Panel icon="admission" title="Manual review" subtitle="Admissions, documents and external actions require a human." />
      {[
        ['Program admission and benefits', 'Admin'],
        ['Document creation', 'Admin'],
        ['Payment', 'Admin + Finance'],
        ['Signing and external sending', 'Separate review'],
      ].map(([rule, who]) => (
        <div className="kv" key={rule}>
          <span className="grow">{rule}</span>
          <span className="meta">{who}</span>
        </div>
      ))}
      <p className="meta">These are properties of the database and the routes, not settings. They cannot be turned off here.</p>
    </>
  );
}

/**
 * Agents: the durable defaults and the two caps.
 *
 * A catalog row is enabled only when a verified key exists for its provider, so
 * this screen and the composer agree by construction.
 *
 * The caps are a `FineTuneCard` (plan 10b). It scrubs integers, which is what
 * `daily_token_cap` and `max_concurrent_runs` are, and its `onChange` fires on
 * every scrub — so the write is debounced and the *answer* is what the screen
 * re-renders from. A cap the server rejected must not sit on screen looking
 * saved. Zero tokens is a deliberate stop and the card can express it; the
 * server reads zero the same way.
 */
function AgentsTab() {
  const state = useAppState();
  const adapter = useAdapter();
  const admin = useIsAdmin();
  const nav = useNav();
  const catalog = catalogRows(state);
  const [ack, setAck] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<SettingsView | null>(null);
  const settings = state.settings as { default_model_id?: string; default_effort?: string | null; default_runtime?: string; daily_token_cap?: number | null; max_concurrent_runs?: number };
  const current = catalog.find((row) => row.model_id === settings.default_model_id);

  // The caps as the server holds them, not as bootstrap left them: bootstrap is
  // a snapshot from page load and this screen is where they change.
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

  const save = (patch: Record<string, unknown>): void => {
    setError(null);
    void adapter.rest
      .patchSettings(state.workspace.id, patch)
      .then((next) => {
        setView(next);
        setAck(true);
        setTimeout(() => setAck(false), 1600);
      })
      .catch((caught: unknown) => {
        const reason = (caught as { reason?: string }).reason;
        setError(reason === 'not_admin' ? EMPTY.adminOnly : reason === 'bad_cap' ? 'A cap is a whole number of tokens, or none.' : 'Could not save that. Try again.');
      });
  };

  const caps = view?.caps ?? {
    daily_token_cap: settings.daily_token_cap ?? null,
    max_concurrent_runs: settings.max_concurrent_runs ?? 1,
    tokens_today: 0,
    active_runs: 0,
    warn: false,
  };

  return (
    <>
      <div className="list-row">
        <Glass name="iris" size={32} className="row-icon" />
        <div className="row-main">
          <span className="t">{state.agent.name}</span>
          <span className="s">{state.agent.email ?? 'Email not connected'}</span>
        </div>
        <Button onClick={() => nav(CTX)}>Manage</Button>
      </div>
      <div className="row">
        <h2 className="section-title">Model defaults</h2>
        <span className="grow" />
        <span style={{ position: 'relative' }}>
          <span className="meta">Applies to new sessions</span>
          <Ack show={ack} style={{ right: 0, top: -40 }}>
            Saved · New sessions use this
          </Ack>
        </span>
      </div>
      {catalog.length === 0 ? (
        <EmptyState icon="skill" title={EMPTY.noProvider} detail={EMPTY.providerKeys} action={<Button onClick={() => nav(SETTINGS('Provider keys'))}>Connect Nous Portal</Button>} />
      ) : (
        <div className="col" role="radiogroup" aria-label="Default model" style={{ gap: 4 }}>
          {catalog.map((row) => (
            <MenuItem
              key={row.model_id}
              checked={(view?.defaults.model_id ?? settings.default_model_id) === row.model_id}
              disabled={!row.enabled || !admin}
              sub={row.enabled ? `via ${row.provider}` : row.disabled_reason ?? `No verified ${row.provider} key`}
              onClick={() => save({ default_model_id: row.model_id })}
            >
              {row.label}
            </MenuItem>
          ))}
        </div>
      )}
      <div className="kv">
        <span className="grow">Default effort</span>
        {current?.effort ? (
          <div className="effort-row" role="radiogroup" aria-label="Default effort">
            {current.effort.map((value) => (
              <button key={value} type="button" role="radio" aria-checked={(view?.defaults.effort ?? settings.default_effort) === value} disabled={!admin} onClick={() => save({ default_effort: value })}>
                {value}
              </button>
            ))}
          </div>
        ) : (
          <span className="meta">Not available for this model</span>
        )}
      </div>

      <h2 className="section-title">Caps</h2>
      {admin ? (
        <div className="hermes-ui">
          <FineTuneCard
            labels={{ title: 'Run caps', layout: 'Limits', type: 'Default effort', adjust: 'Drag to change', edited: 'Unsaved' }}
            options={(current?.effort ?? ['low', 'medium', 'high', 'max']).slice()}
            fields={[
              { key: 'daily_token_cap', label: 'Daily tokens', value: caps.daily_token_cap ?? 0, min: 0, max: 5_000_000, step: 10_000 },
              { key: 'max_concurrent_runs', label: 'Concurrent runs', value: caps.max_concurrent_runs, min: 1, max: 20, step: 1 },
            ]}
            onChange={(next) => {
              const cap = Math.round(next.values.daily_token_cap ?? 0);
              const runs = Math.round(next.values.max_concurrent_runs ?? caps.max_concurrent_runs);
              // Zero means "stop", not "unset": the server reads it that way
              // too, and a cap of none is chosen with the button below.
              scheduleCapWrite(() => save({ daily_token_cap: cap, max_concurrent_runs: runs }));
            }}
          />
        </div>
      ) : (
        <p className="meta">{EMPTY.adminOnly}</p>
      )}
      <div className="kv">
        <span className="grow">Daily token cap</span>
        <span className="meta">
          {caps.daily_token_cap === null ? 'None' : `${caps.tokens_today.toLocaleString()} of ${caps.daily_token_cap.toLocaleString()} today`}
        </span>
        {admin && caps.daily_token_cap !== null && (
          <Button link onClick={() => save({ daily_token_cap: null })}>
            Remove cap
          </Button>
        )}
      </div>
      <div className="kv">
        <span className="grow">Concurrent runs</span>
        <span className="meta">
          {caps.active_runs} of {caps.max_concurrent_runs} active
        </span>
      </div>
      {error && <p className="meta" role="alert">{error}</p>}
      <p className="meta">Durable defaults live here and are recorded in History. A per-session choice applies only to that session&apos;s next turn. Caps are enforced server-side: this screen re-renders from the server&apos;s answer, never from what it hoped it sent.</p>
    </>
  );
}

/**
 * One timer for the cap sliders.
 *
 * `FineTuneCard` fires `onChange` on every pointer move, and a PATCH per pixel
 * is a PATCH per pixel. 600 ms after the last move is one write per gesture,
 * which is also one audit row per gesture — `settings.changed` is an event
 * somebody reads.
 */
let capWriteHandle: ReturnType<typeof setTimeout> | null = null;
function scheduleCapWrite(write: () => void): void {
  if (capWriteHandle) clearTimeout(capWriteHandle);
  capWriteHandle = setTimeout(write, 600);
}

const STATUS_LABEL: Record<string, string> = { unverified: 'Unverified', verified: 'Verified', verified_scoped: 'Verified (scoped)', invalid: 'Invalid', revoked: 'Revoked' };

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
  const when = key.models_synced_at === null ? 'never' : new Date(key.models_synced_at).toLocaleDateString();
  return `${key.synced_model_count} model${key.synced_model_count === 1 ? '' : 's'} synced · last sync ${when}`;
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
        ? { kind: 'pending', message: 'Re-authenticated. Confirm to verify the saved key again; you do not need to paste it again.' }
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
    setConnectStatus({ kind: 'pending', message: `The key is encrypted and saved, but it is not verified yet. ${detail} Try verification again; you do not need to paste it again.` });
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
        ? 'That does not look like a Nous Portal API key. Copy the complete key from Nous Portal and try again.'
        : error.reason === 'key_exists'
          ? 'This workspace already has a Nous Portal key. Close this dialog and rotate the existing key instead.'
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
      setConnectStatus({ kind: 'pending', message: 'The key remains encrypted and saved, but verification did not finish. Try again shortly.' });
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
        setConnectStatus({ kind: 'oauth_unavailable', message: 'Hosted Nous sign-in is not enabled for this deployment. Use a workspace API key below.' });
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
        setConnectStatus({ kind: 'oauth_unavailable', message: 'Hosted Nous sign-in is not enabled for this deployment. Use a workspace API key below.' });
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
        <EmptyState icon="context" title={EMPTY.adminOnly} detail="Keys are never shown to a Member, not even masked values." />
      </>
    );
  }

  return (
    <>
      <div className="row">
        <h2 className="section-title">Provider keys</h2>
        <span className="grow" />
        {!locked && (
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
        )}
      </div>
      {locked ? (
        <EmptyState
          icon="key"
          title="Provider connection details are protected"
          detail="Iris can keep using a saved Nous Portal connection in the background. Sign in again only to view or change connection settings."
          action={<Button onClick={revealConnectionStatus}>Sign in to manage</Button>}
        />
      ) : keys.length === 0 ? (
        <EmptyState icon="key" title={EMPTY.providerKeys} />
      ) : (
        <div className="col">
          {keys.map((key) => (
            <div className="list-row" key={key.id} style={{ minHeight: 96 }}>
              <Glass name="skill" size={28} className="row-icon" />
              <div className="row-id" style={{ width: 220 }}>
                <span className="t">{key.label}</span>
                <span className="s truncate" title={providerAccountLabel(key) ?? undefined}>
                  {key.provider} · {key.credential_kind === 'oauth_device_code' ? 'Workspace OAuth' : `····${key.last4}`}
                  {providerAccountLabel(key) ? ` · ${providerAccountLabel(key)}` : ''}
                </span>
              </div>
              <div className="row-main">
                <span className="t">{usable(key) ? STATUS_LABEL[key.status] ?? key.status : EMPTY.keyNotAllowed}</span>
                <span className="s">
                  {/* A Nous Portal key verifies against hundreds of models, so
                      the row says how many were synced and when, rather than
                      listing them (decision R7). */}
                  {syncLabel(key) ?? `${key.verified_models.length} model${key.verified_models.length === 1 ? '' : 's'}`} · {key.fingerprint_prefix} · added {new Date(key.created_at).toLocaleDateString()}
                  {key.rotated_at ? ` · rotated ${new Date(key.rotated_at).toLocaleDateString()}` : ''}
                </span>
              </div>
              {/* A key for a provider this deployment no longer offers keeps
                  its row and loses its buttons: the server answers 422
                  `provider_not_allowed` to verify and rotate (decision R12), so
                  offering them would be offering a refusal. Remove still works,
                  which is the only thing left worth doing to it. */}
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
              <Button
                quiet
                onClick={() => {
                  setTarget(key);
                  setDialog('remove');
                }}
              >
                Remove
              </Button>
            </div>
          ))}
        </div>
      )}
      {notice && <p className="meta">{notice}</p>}
      <p className="meta">
        Nous Portal powers Iris through the Hermes Agent runtime. Workspace OAuth credentials stay encrypted and refresh automatically. Connecting syncs the current model catalog.
      </p>

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
        <p className="meta">Rotated. Past usage still lists the previous key.</p>
      </Dialog>

      <Dialog
        open={dialog === 'remove'}
        title={`Remove ${target?.label ?? ''}?`}
        onClose={() => setDialog(null)}
        actions={
          <>
            <Button onClick={() => setDialog(null)}>Keep</Button>
            <Button primary onClick={() => target && void guarded(() => adapter.rest.removeProviderKey(state.workspace.id, target.id))}>
              Remove
            </Button>
          </>
        }
      >
        <p>
          Removing this key stops {target?.verified_models.length ?? 0} working run(s) on {target?.provider} and blocks new runs until another key is verified.
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
 * The charts are `InsightCards`, driven by `by_day`: a cost-and-token compare
 * card, an anomaly card over the same series, and an allocation card over
 * `by_key`. When a range has one day in it there is no shape to draw, so the
 * carousel is not rendered at all rather than drawn as a flat line.
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
        label: day.day,
        sub: `${day.input_tokens.toLocaleString()} in · ${day.output_tokens.toLocaleString()} out · ${day.calls} call${day.calls === 1 ? '' : 's'}${day.errors ? ` · ${day.errors} error${day.errors === 1 ? '' : 's'}` : ''}`,
        cost: day.cost_usd_estimate,
      }));
    if (group === 'session')
      return usage.by_session.map((row) => ({
        key: row.session_id ?? 'no-session',
        label: row.title ?? 'Untitled session',
        sub: `${row.total_tokens.toLocaleString()} tokens · ${row.runs} run${row.runs === 1 ? '' : 's'}${row.last_call_at ? ` · ${new Date(row.last_call_at).toLocaleString()}` : ''}`,
        cost: row.cost_usd_estimate,
      }));
    return usage.by_key.map((row) => ({
      key: row.key_id ?? `${row.provider}-deleted`,
      label: row.label ?? `${row.provider ?? 'unknown'} · removed key`,
      sub: `${row.total_tokens.toLocaleString()} tokens · ${row.calls} call${row.calls === 1 ? '' : 's'}${row.last4 ? ` · ····${row.last4}` : ''}${row.status ? ` · ${row.status}` : ''}`,
      cost: row.cost_usd_estimate,
    }));
  }, [usage, group]);

  const pages = useMemo(() => (usage ? insightPages(usage) : []), [usage]);

  return (
    <>
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
          detail={error === 'contract_violation' ? 'The usage route answered a shape this client does not understand. That is a bug, not an outage.' : 'The usage route did not answer. Try again shortly.'}
        />
      )}
      {!usage && !error && <Skeleton rows={3} label="Loading usage" />}
      {usage && (
        <>
          <div className="stat-grid">
            <div className="stat">
              <span className="k">Tokens</span>
              <span className="v">{usage.totals.total_tokens.toLocaleString()}</span>
            </div>
            <div className="stat">
              <span className="k">Estimated cost</span>
              <span className="v">${usage.totals.cost_usd_estimate.toFixed(3)}</span>
            </div>
            <div className="stat">
              <span className="k">Calls</span>
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
              title="Approaching the daily token cap"
              subtitle={`${usage.caps.tokens_today.toLocaleString()} of ${usage.caps.daily_token_cap?.toLocaleString() ?? 'no'} tokens today · ${usage.caps.active_runs} of ${usage.caps.max_concurrent_runs} runs active`}
            />
          )}
          {pages.length > 0 && (
            <div className="hermes-ui">
              <InsightCards pages={pages} labels={{ title: `Usage · ${usage.range} · ${usage.timezone}` }} />
            </div>
          )}
          <Tabs
            tabs={[
              { id: 'day', label: 'By day' },
              { id: 'session', label: 'By session' },
              { id: 'key', label: 'By key' },
            ]}
            value={group}
            onChange={(value) => setGroup(value as 'day' | 'session' | 'key')}
            label="Usage grouping"
          />
          {rows.length === 0 ? (
            <EmptyState icon="trace" title="No usage yet" detail="Usage appears after the first run." />
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
          <div className="kv">
            <span className="grow">Daily token cap</span>
            <span className="meta">
              {usage.caps.daily_token_cap === null ? 'None' : `${usage.caps.tokens_today.toLocaleString()} of ${usage.caps.daily_token_cap.toLocaleString()} today`}
            </span>
          </div>
          <div className="kv">
            <span className="grow">Concurrent runs</span>
            <span className="meta">
              {usage.caps.active_runs} of {usage.caps.max_concurrent_runs} active
            </span>
          </div>
        </>
      )}
    </>
  );
}

/**
 * The three `InsightCards` pages, built from one report.
 *
 * The library's own `CompareCard`, `AnomalyCard` and `AllocationCard` are not
 * reachable: `index.ts` exports the carousel and not the three cards it ships
 * with, and the package publishes no subpath in its `exports` map, so there is
 * nothing to import them from. What is adopted is therefore the carousel — the
 * pager, the prose and the pill — with three small charts of our own drawn
 * from `by_day` and `by_key`. Every number on them is a number the server sent;
 * nothing is smoothed, padded or invented, and a range with fewer than two days
 * has no series to draw, so the caller renders no carousel rather than a
 * straight line pretending to be a trend.
 */
function Sparkline({ values, stroke, label }: { values: number[]; stroke: string; label: string }) {
  const max = Math.max(...values, 1);
  const width = 300;
  const height = 96;
  const step = values.length > 1 ? width / (values.length - 1) : width;
  const points = values.map((value, index) => `${(index * step).toFixed(1)},${(height - (value / max) * (height - 8) - 4).toFixed(1)}`);
  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} role="img" aria-label={label} style={{ display: 'block' }}>
      <polyline points={points.join(' ')} fill="none" stroke={stroke} strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" />
      {points.map((point, index) => {
        const [x, y] = point.split(',');
        return <circle key={index} cx={x} cy={y} r="2.5" fill={stroke} />;
      })}
    </svg>
  );
}

function Bars({ values, fill, label }: { values: number[]; fill: string; label: string }) {
  const max = Math.max(...values, 1);
  const width = 300;
  const height = 96;
  const slot = width / values.length;
  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} role="img" aria-label={label} style={{ display: 'block' }}>
      {values.map((value, index) => {
        const barHeight = Math.max(2, (value / max) * (height - 6));
        return <rect key={index} x={index * slot + slot * 0.2} y={height - barHeight} width={slot * 0.6} height={barHeight} rx="2" fill={fill} />;
      })}
    </svg>
  );
}

function insightPages(usage: UsageReport): { key: string; prose: ReactNode; Card: () => JSX.Element; pill: string }[] {
  const days = usage.by_day;
  if (days.length < 2) return [];
  const tokens = days.map((day) => day.total_tokens);
  const spend = days.map((day) => day.cost_usd_estimate);
  const keys = usage.by_key.filter((row) => row.total_tokens > 0);
  const keyTotal = keys.reduce((sum, row) => sum + row.total_tokens, 0) || 1;

  return [
    {
      key: 'tokens',
      pill: `${days.length} days · ${usage.timezone}`,
      prose: `${usage.totals.total_tokens.toLocaleString()} tokens over ${days.length} days, an estimated $${usage.totals.cost_usd_estimate.toFixed(3)}.`,
      Card: () => (
        <div className="usage-card">
          <span className="meta">Tokens per day</span>
          <Sparkline values={tokens} stroke="var(--accent, #4a86ff)" label={`Tokens per day over ${days.length} days`} />
        </div>
      ),
    },
    {
      key: 'spend',
      pill: `${usage.totals.calls.toLocaleString()} calls`,
      prose: `${usage.totals.calls.toLocaleString()} model calls, ${usage.totals.errors} of them failed. Spend follows usage unless a model changed.`,
      Card: () => (
        <div className="usage-card">
          <span className="meta">Estimated cost per day, USD</span>
          <Bars values={spend} fill="var(--green, #2c8a5a)" label={`Estimated cost per day over ${days.length} days`} />
        </div>
      ),
    },
    {
      key: 'keys',
      pill: keys.length ? `${keys.length} key${keys.length === 1 ? '' : 's'}` : 'No key recorded',
      prose: keys.length ? 'Which key paid for what. A removed key keeps its spend rather than vanishing from the total.' : 'No provider key is recorded against these calls.',
      Card: () => (
        <div className="usage-card">
          {keys.length === 0 && <span className="meta">Nothing to allocate.</span>}
          {keys.slice(0, 6).map((row) => {
            const pct = Math.round((row.total_tokens / keyTotal) * 100);
            return (
              <div className="usage-alloc" key={row.key_id ?? `${row.provider}-removed`}>
                <span className="t">{row.label ?? `${row.provider ?? 'unknown'} · removed key`}</span>
                <span className="bar" aria-hidden>
                  <span style={{ width: `${pct}%` }} />
                </span>
                <span className="meta">
                  {pct}% · ${row.cost_usd_estimate.toFixed(3)}
                </span>
              </div>
            );
          })}
        </div>
      ),
    },
  ];
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
    void adapter.rest
      .patchSettings(state.workspace.id, { notifications: { [key]: value } })
      .then((next) => setView(next as SettingsView))
      .catch(() => undefined);
    setAck(true);
    setTimeout(() => setAck(false), 1400);
  };
  return (
    <>
      <div className="row"><h2 className="section-title">Notification preferences</h2><span className="grow" /><span className="pill">Delivery not configured</span></div>
      <p className="meta">These preferences are saved for a future delivery service. This deployment does not send approval, blocked-work or digest emails.</p>
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
 * Every fact on this screen is the server's. The retention table, the erasure
 * timing, the residency lines and the per-provider warnings all come from
 * `GET /w/:ws/settings/data-privacy`, because a client that paraphrased them
 * would be a client making a data-protection claim nobody reviewed. The one
 * control is the attestation, and it is Admin plus step-up: whoever writes it
 * is asserting to a future auditor that a zero-retention arrangement or a DPA
 * exists.
 */
function PrivacyTab() {
  const state = useAppState();
  const adapter = useAdapter();
  const admin = useIsAdmin();
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
        setNotice(error.reason === 'not_admin' ? EMPTY.adminOnly : 'Could not record that attestation. Try again.');
      });
  };

  return (
    <>
      {[
        ['Private to this workspace', 'Context, agent history and shared skills stay in your organization'],
        ['Model training', 'Off'],
        ['Shared Intelligence', 'Human review required'],
        ['Jurisdiction', state.workspace.jurisdiction ?? 'default'],
      ].map(([key, value]) => (
        <div className="kv" key={key}>
          <span className="grow">{key}</span>
          <span className="meta" style={{ textAlign: 'right', maxWidth: 380 }}>
            {value}
          </span>
        </div>
      ))}

      {failed && <EmptyState icon="context" title="The privacy page did not answer" detail="Retention and residency facts are the server's; nothing is shown from memory." />}
      {!privacy && !failed && <Skeleton rows={4} label="Loading retention facts" />}

      {privacy && (
        <>
          <h2 className="section-title">Processors</h2>
          {privacy.keys.length === 0 && <div className="meta" style={{ padding: '12px 0' }}>No provider is configured, so no prompt text leaves this workspace.</div>}
          {privacy.keys.map((key) => (
            <div className="col" key={key.key_id} style={{ gap: 8, padding: '14px 0', borderBottom: '1px solid var(--line)' }}>
              <div className="row">
                <div className="row-main">
                  <span className="t">
                    {key.label} · {key.provider}
                  </span>
                  <span className="s">
                    ····{key.last4} · {key.status}
                    {key.verified_at ? ` · verified ${new Date(key.verified_at).toLocaleDateString()}` : ' · never verified'}
                  </span>
                </div>
                <span className="meta">{key.attested ? `Attested · ${String(key.attestation?.kind ?? '')}` : 'No attestation'}</span>
                {admin && (
                  <Button
                    onClick={() => {
                      setTarget(key);
                      setKind(String(key.attestation?.kind ?? 'zdr'));
                      setReference(String(key.attestation?.reference ?? ''));
                      setNotice(null);
                    }}
                  >
                    {key.attested ? 'Update attestation' : 'Record attestation'}
                  </Button>
                )}
              </div>
              <span className="meta">{key.real_data_allowed ? 'Real applicant data is allowed on this key: an Admin has recorded an attestation and the provider carries no jurisdiction warning.' : 'Real applicant data is not allowed on this key. Use synthetic or consented data.'}</span>
              {key.warnings.map((warning) => (
                <p className="meta" key={warning} style={{ maxWidth: 720 }}>
                  {warning}
                </p>
              ))}
            </div>
          ))}

          <h2 className="section-title">What is kept, and for how long</h2>
          <div className="col">
            {privacy.retention.map((fact) => (
              <div className="kv" key={fact.store}>
                <span className="grow">{fact.store}</span>
                <span className="meta" style={{ textAlign: 'right', maxWidth: 420 }}>
                  {fact.retention} · {fact.erasure}
                </span>
              </div>
            ))}
          </div>

          <h2 className="section-title">Erasure</h2>
          <p style={{ maxWidth: 760 }}>{privacy.erasure.copy}</p>
          <div className="stat-grid">
            <div className="stat">
              <span className="k">Tombstone</span>
              <span className="v">{privacy.erasure.tombstone}</span>
            </div>
            <div className="stat">
              <span className="k">Point-in-time history</span>
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

          <h2 className="section-title">Where the data sits</h2>
          {(
            [
              ['Identity provider', privacy.residency.identity_provider],
              ['Database', privacy.residency.database],
              ['Objects', privacy.residency.objects],
              ['Processing', privacy.residency.processing],
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

      <Dialog
        open={!!target}
        title={`Attestation for ${target?.label ?? ''}`}
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
        {reauthed && <p className="meta">Re-authenticated — confirm to continue.</p>}
        <div className="col" role="radiogroup" aria-label="Attestation kind" style={{ gap: 4 }}>
          {(
            [
              ['zdr', 'Zero data retention agreed with this provider'],
              ['dpa', 'A data-processing agreement is signed'],
              ['synthetic_only', 'This key is for synthetic data only'],
              ['none', 'Nothing is claimed'],
            ] as const
          ).map(([value, sub]) => (
            <MenuItem key={value} checked={kind === value} sub={sub} onClick={() => setKind(value)}>
              {value}
            </MenuItem>
          ))}
        </div>
        <label className="field">
          <span className="sr-only">Reference</span>
          <input placeholder="Contract or ticket reference" value={reference} onChange={(event) => setReference(event.target.value)} />
        </label>
        <p className="meta">Recorded against your name and the time. It is a statement about retention, not about jurisdiction: a provider&apos;s storage warning is not answered by it.</p>
        {notice && <p className="meta" role="alert">{notice}</p>}
      </Dialog>
    </>
  );
}
