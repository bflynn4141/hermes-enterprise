// History, Members, Library and Settings.
//
// History reads `events` rows — the demo's fabricated local event log is gone,
// along with `eventTime()` and `uid('evt')`. Members read the WorkOS mirror.
// Settings carries Provider keys, Usage and the data-and-privacy page, and the
// one control in the product with no undo behind a confirmation and a step-up.
//
// Four library components are adopted here (plan 10b): `FilterTable` over
// History, `RecordsTable` over Members, `InsightCards` over the usage report
// and `FineTuneCard` over the two integer caps. Each is given real rows and
// real callbacks; none of them is given a demo fixture.
import { useEffect, useMemo, useState, type JSX, type ReactNode } from 'react';
import { FilterTable, FineTuneCard, InsightCards, RecordsTable } from '@hermes/motion-components';
import { CTX, LIB, MEMBERS, REQ, SETTINGS, type DataPrivacy, type DocumentEntity, type EventRow, type MaskedProviderKey, type MemberEntity, type SettingsView, type UsageRange, type UsageReport } from '@hermes/shared';
import { useAdapter, useAppState, useDispatch, useEntity, useIsAdmin, useNav } from '../store-context.js';
import { Glass, Icon, KIND_ICON } from '../ui/icons.js';
import { Ack, Avatar, Button, Dialog, EmptyState, MenuItem, Panel, Skeleton, Tabs, Toggle } from '../ui/primitives.js';
import { EMPTY, LIBRARY_TABS, SETTINGS_TABS } from '../../model/constants.js';
import { catalogRows, memberCounts, requestStatusLabel } from '../selectors.js';
import { storeStepUp } from '../../model/auth.js';
import { useWorkspaceLists } from './lists.js';
import { DocumentView } from './Inbox.js';

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
 * Members, with `RecordsTable` over the rows (plan 10b).
 *
 * The table's columns are the library's and the values in them are this
 * workspace's: the strength column ("Evidence coverage") reads the membership
 * status, the links column reads the address WorkOS holds, and the optional
 * calculation column — which a person adds by hand and which the library fills
 * from `reviewGap` when no model is wired — is given each member's recorded
 * reviewer roles. Nothing on this screen is generated; there is no
 * `onCalculate`, because there is no route that would answer one, and a column
 * that invented an answer would be worse than a column that has none.
 *
 * Opening a row opens the same Manage dialog the old list opened.
 */
const memberStrength = (member: MemberEntity): 'strong' | 'weak' | 'veryweak' | 'none' =>
  member.status === 'active' ? 'strong' : member.status === 'invited' ? 'weak' : member.status === 'expired' ? 'veryweak' : 'none';

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
  const counts = memberCounts(state);
  const all = lists.members;
  const list = tab === 'all' ? all : all.filter((member) => member.status !== 'active');
  const person = manage ? all.find((member) => member.id === manage) ?? null : null;
  const isYou = person?.user_id === state.user.id;

  const records = useMemo(
    () =>
      list.map((member) => ({
        id: member.id,
        name: member.user_id === state.user.id ? `${member.name} · You` : member.name,
        tags: [member.role === 'admin' ? 'Admin' : 'Member', member.status],
        last: member.joined_at ? new Date(member.joined_at).toLocaleDateString() : 'No contact',
        strength: memberStrength(member),
        website: member.email,
        reviewGap: member.reviewer_roles.length ? `${member.reviewer_roles.join(', ')} reviewer` : 'No reviewer role',
      })),
    [list, state.user.id],
  );

  return (
    <div className="scroll">
      <div className="app-body">
        <div className="row" style={{ height: 42 }}>
          <h1 className="display-32">Members</h1>
          <span className="grow" />
          <span className="meta">
            {counts.joined} joined · {counts.invited} invited
          </span>
          {admin && <Button onClick={() => setInvite(true)}>Invite member</Button>}
        </div>
        <Tabs
          tabs={[
            { id: 'all', label: 'All members' },
            { id: 'invites', label: 'Invitations' },
          ]}
          value={tab}
          onChange={setTab}
          label="Member views"
        />
        {list.length === 0 ? (
          <EmptyState icon="people" title={tab === 'all' ? 'No members yet' : EMPTY.invitations} />
        ) : (
          <div className="hermes-ui table-host">
            <RecordsTable rows={records} {...(admin ? { onOpenRow: (row: { id: string }) => setManage(row.id) } : {})} />
          </div>
        )}
        {!admin && <p className="meta">Read-only. Roles and removals are an Admin&apos;s.</p>}
        <Ack show={!!ack} style={{ right: 0, top: -12, position: 'relative' }}>
          Saved
        </Ack>
        <Dialog
          open={invite}
          title="Invite member"
          onClose={() => setInvite(false)}
          actions={
            <>
              <Button onClick={() => setInvite(false)}>Cancel</Button>
              <Button
                primary
                disabled={!/^[\w.+-]+@[\w-]+\.[\w.-]+$/.test(email)}
                onClick={() => {
                  void adapter.rest
                    .invite(state.workspace.id, { email, role: 'member' })
                    .then(() => {
                      adapter.invalidateList('invitations');
                      adapter.invalidateList('members');
                    })
                    .catch(() => undefined);
                  setEmail('');
                  setInvite(false);
                  setTab('invites');
                }}
              >
                Invite
              </Button>
            </>
          }
        >
          <label className="field">
            <span className="sr-only">Work email</span>
            <input type="email" placeholder="name@example.com" value={email} onChange={(event) => setEmail(event.target.value)} />
          </label>
          <p className="meta">The invitation is recorded now; the email is sent by the identity provider.</p>
        </Dialog>
        <Dialog
          open={!!person}
          title={person?.name ?? ''}
          onClose={() => {
            setManage(null);
            setConfirmRemove(false);
          }}
          actions={
            confirmRemove ? (
              <>
                <Button onClick={() => setConfirmRemove(false)}>Keep</Button>
                <Button
                  primary
                  onClick={() => {
                    if (person)
                      void adapter.rest
                        .removeMember(state.workspace.id, person.id)
                        .then(() => adapter.invalidateList('members'))
                        .catch(() => undefined);
                    setManage(null);
                    setConfirmRemove(false);
                  }}
                >
                  Remove
                </Button>
              </>
            ) : (
              <Button onClick={() => setManage(null)}>Done</Button>
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
                    sub={role === 'admin' ? 'Manages members, keys and decisions' : 'Works with agents; cannot decide'}
                    onClick={() => {
                      if (!person) return;
                      void adapter.rest
                        .setMemberRole(state.workspace.id, person.id, role)
                        .then(() => adapter.invalidateList('members'))
                        .catch(() => undefined);
                      setAck(person.id);
                      setTimeout(() => setAck(null), 1600);
                    }}
                  >
                    {role === 'admin' ? 'Admin' : 'Member'}
                  </MenuItem>
                ))}
              </div>
              <div className="row">
                <span className="meta grow">Role changes apply to this workspace only and are recorded in History.</span>
                <Button link onClick={() => setConfirmRemove(true)}>
                  Remove…
                </Button>
              </div>
            </>
          )}
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
        {/* The two that stay. M6 owns both, and neither has a route yet. */}
        {view === 'connections' && <EmptyState icon="context" title={EMPTY.libraryUnavailable} detail="Connections are managed outside the pilot." />}
        {view === 'intelligence' && <EmptyState icon="skill" title={EMPTY.libraryUnavailable} detail="Shared Intelligence proposals are reviewed by a human; the pilot does not publish them." />}
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
  if (lists.skills.length === 0) return <EmptyState icon="skill" title="No shared skills yet" />;
  return (
    <div className="col">
      {lists.skills.map((skill) => (
        <div className="list-row" key={skill.id} style={{ minHeight: 112 }}>
          <Glass name="skill" size={32} className="row-icon" />
          <div className="row-main">
            <span className="t">
              {skill.name} · {skill.version}
            </span>
            <span className="s">
              {skill.description} · Shared by {skill.shared_by}
            </span>
          </div>
          <span style={{ position: 'relative' }}>
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
            <Ack show={ack} style={{ right: 0, top: -40 }}>
              Added
            </Ack>
          </span>
        </div>
      ))}
    </div>
  );
}

function LibraryDocuments() {
  const nav = useNav();
  const lists = useWorkspaceLists();
  const [query, setQuery] = useState('');
  const match = (text: string): boolean => text.toLowerCase().includes(query.toLowerCase());
  const documents = lists.documents.filter((doc) => match(doc.title));
  const drafts = lists.requests.filter((request) => request.kind !== 'application' && request.status === 'pending');

  return (
    <>
      <label className="search">
        <Icon name="search" />
        <input placeholder="Search documents" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search documents" />
      </label>
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
      <div className="app-body" style={{ minHeight: '100%' }}>
        <div className="row" style={{ height: 42 }}>
          <h1 className="display-32">Settings</h1>
        </div>
        <Tabs tabs={SETTINGS_TABS.map((tab) => ({ id: tab, label: tab }))} value={view} onChange={(next) => nav(SETTINGS(next))} label="Settings sections" />
        {view === 'Organization' && <OrganizationTab />}
        {view === 'Inbox rules' && <InboxRulesTab />}
        {view === 'Agents' && <AgentsTab />}
        {view === 'Provider keys' && <ProviderKeysTab />}
        {view === 'Usage' && <UsageTab />}
        {view === 'Notifications' && <NotificationsTab />}
        {view === 'Data and privacy' && <PrivacyTab />}
      </div>
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
          <span className="s">{state.agent.email}</span>
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
        <EmptyState icon="skill" title={EMPTY.noProvider} detail={EMPTY.providerKeys} action={<Button onClick={() => nav(SETTINGS('Provider keys'))}>Add a key</Button>} />
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
 * The providers a workspace can install a key for.
 *
 * OpenRouter is described differently on purpose: the other three bill a
 * vendor account and offer a fixed handful of models, and this one is a broker
 * whose verification also syncs several hundred rows into the model menu. An
 * Admin who does not know that will not understand why one key made the menu
 * long.
 */
const PROVIDER_CHOICES: readonly { id: string; label: string; note: string }[] = [
  { id: 'deepseek', label: 'DeepSeek', note: 'DeepSeek Flash. Keys are stored in the PRC — see Data and privacy.' },
  { id: 'anthropic', label: 'Anthropic', note: 'Claude models, billed to your Anthropic account.' },
  { id: 'openai', label: 'OpenAI', note: 'GPT models, billed to your OpenAI account.' },
  {
    id: 'openrouter',
    label: 'OpenRouter',
    note: 'One key, every model OpenRouter brokers. Verifying also syncs its model list into the chat model menu.',
  },
];

/** "342 models synced · 2 Mar" — or nothing, for a provider that has no list. */
function syncLabel(key: MaskedProviderKey): string | null {
  if (key.synced_model_count === null) return null;
  const when = key.models_synced_at === null ? 'never' : new Date(key.models_synced_at).toLocaleDateString();
  return `${key.synced_model_count} model${key.synced_model_count === 1 ? '' : 's'} synced · last sync ${when}`;
}

function ProviderKeysTab() {
  const state = useAppState();
  const adapter = useAdapter();
  const admin = useIsAdmin();
  const lists = useWorkspaceLists();
  const [dialog, setDialog] = useState<'add' | 'rotate' | 'remove' | null>(null);
  const [target, setTarget] = useState<MaskedProviderKey | null>(null);
  const [provider, setProvider] = useState('deepseek');
  const [label, setLabel] = useState('');
  const [secret, setSecret] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const keys = lists.providerKeys;

  // Every mutation is step-up gated; a 401 `reauth_required` redirects and the
  // dialog reopens in a confirm state on the way back.
  const guarded = async (run: () => Promise<unknown>, reason: 'provider_key' = 'provider_key'): Promise<void> => {
    try {
      await run();
      adapter.ensureList('provider-keys', async () => {
        const page = await adapter.rest.providerKeys(state.workspace.id);
        return { ids: page.keys.map((k) => k.id), cursor: null, total: page.keys.length, rows: page.keys.map((k) => ({ kind: 'provider_key' as const, id: k.id, data: k, version: 1 })) };
      });
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
      setNotice(code === 'provider_rejected' ? `Your ${provider} key was rejected. Re-verify or rotate it` : `Could not reach ${provider}. We'll re-check shortly.`);
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
        <Button
          onClick={() => {
            setDialog('add');
            setNotice(null);
          }}
        >
          Add a key
        </Button>
      </div>
      {keys.length === 0 ? (
        <EmptyState icon="key" title={EMPTY.providerKeys} />
      ) : (
        <div className="col">
          {keys.map((key) => (
            <div className="list-row" key={key.id} style={{ minHeight: 96 }}>
              <Glass name="skill" size={28} className="row-icon" />
              <div className="row-id" style={{ width: 220 }}>
                <span className="t">{key.label}</span>
                <span className="s">
                  {key.provider} · ····{key.last4}
                </span>
              </div>
              <div className="row-main">
                <span className="t">{STATUS_LABEL[key.status] ?? key.status}</span>
                <span className="s">
                  {/* An OpenRouter key verifies against hundreds of models, so
                      the row says how many were synced and when, rather than
                      listing them (decision R7). */}
                  {syncLabel(key) ?? `${key.verified_models.length} model${key.verified_models.length === 1 ? '' : 's'}`} · {key.fingerprint_prefix} · added {new Date(key.created_at).toLocaleDateString()}
                  {key.rotated_at ? ` · rotated ${new Date(key.rotated_at).toLocaleDateString()}` : ''}
                </span>
              </div>
              {key.provider === 'openrouter' && (
                <Button onClick={() => void guarded(() => adapter.rest.verifyProviderKey(state.workspace.id, key.id))}>Sync models</Button>
              )}
              <Button onClick={() => void guarded(() => adapter.rest.verifyProviderKey(state.workspace.id, key.id))}>{key.status === 'verified' || key.status === 'verified_scoped' ? 'Re-verify' : 'Verify'}</Button>
              <Button
                onClick={() => {
                  setTarget(key);
                  setDialog('rotate');
                }}
              >
                Rotate
              </Button>
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
        Plaintext is never echoed; only the last four characters are ever shown. DeepSeek keys carry the PRC-storage warning on Data and privacy; Anthropic and OpenAI rows show the recorded attestation there. An OpenRouter key is verified against its own key endpoint, and verifying it syncs that account's model list into the chat model menu.
      </p>

      <Dialog
        open={dialog === 'add'}
        title="Add a provider key"
        onClose={() => setDialog(null)}
        actions={
          <>
            <Button onClick={() => setDialog(null)}>Cancel</Button>
            <Button primary disabled={!secret.trim() || !label.trim()} onClick={() => void guarded(() => adapter.rest.addProviderKey(state.workspace.id, { provider, label: label.trim(), key: secret.trim() }))}>
              Add and verify
            </Button>
          </>
        }
      >
        <div className="col" role="radiogroup" aria-label="Provider" style={{ gap: 4 }}>
          {PROVIDER_CHOICES.map((item) => (
            <MenuItem key={item.id} checked={provider === item.id} sub={item.note} onClick={() => setProvider(item.id)}>
              {item.label}
            </MenuItem>
          ))}
        </div>
        <label className="field">
          <span className="sr-only">Label</span>
          <input placeholder="Label, e.g. Program key" value={label} onChange={(event) => setLabel(event.target.value)} />
        </label>
        <label className="field">
          <span className="sr-only">Key</span>
          <input type="password" placeholder="Paste the key" value={secret} onChange={(event) => setSecret(event.target.value)} autoComplete="off" />
        </label>
        <p className="meta">The key is encrypted at rest and never returned. You will be asked to re-authenticate first.</p>
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
 * Email notifications.
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
      <h2 className="section-title">Email notifications</h2>
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
        <span className="meta">Email only · The Inbox stays on</span>
        <span className="grow" />
        <Ack show={ack} style={{ right: 0, top: -12, position: 'relative' }}>
          Saved
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
