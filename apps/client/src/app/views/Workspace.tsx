// History, Members, Library and Settings.
//
// History reads `events` rows — the demo's fabricated local event log is gone,
// along with `eventTime()` and `uid('evt')`. Members read the WorkOS mirror.
// Settings gains the two new tabs the plan added: Provider keys (§9) and Usage.
import { useEffect, useMemo, useState } from 'react';
import { InsightCards } from '@hermes/motion-components';
import { CTX, LIB, MEMBERS, REQ, SETTINGS, type DocumentEntity, type MaskedProviderKey, type UsageResponse } from '@hermes/shared';
import { useAdapter, useAppState, useDispatch, useEntity, useIsAdmin, useNav } from '../store-context.js';
import { Glass, Icon, KIND_ICON } from '../ui/icons.js';
import { Ack, Avatar, Button, Dialog, EmptyState, MenuItem, Panel, Skeleton, Tabs, Toggle } from '../ui/primitives.js';
import { EMPTY, LIBRARY_TABS, SETTINGS_TABS } from '../../model/constants.js';
import { catalogRows, memberCounts, requestStatusLabel } from '../selectors.js';
import { useWorkspaceLists } from './lists.js';
import { DocumentView } from './Inbox.js';

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
        <div className="col" role="list">
          {events.length === 0 && <EmptyState icon="trace" title={emptyCopy} />}
          {events.map((event) => (
            <div className="list-row tall" role="listitem" key={event.id}>
              <span className="time">{new Date(event.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
              <div className="row-main">
                <span className="t">{event.text}</span>
                <span className="s">{event.detail}</span>
              </div>
              <span className="meta">{event.actor_name}</span>
              {event.ref || event.request_id ? (
                <Button link onClick={() => nav(event.ref ?? REQ(event.request_id!))}>
                  Open →
                </Button>
              ) : (
                <span style={{ width: 62 }} />
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
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
  const counts = memberCounts(state);
  const all = lists.members;
  const list = tab === 'all' ? all : all.filter((member) => member.status !== 'active');
  const person = manage ? all.find((member) => member.id === manage) ?? null : null;
  const isYou = person?.user_id === state.user.id;

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
        <div className="col" role="list">
          {list.length === 0 && <EmptyState icon="people" title={tab === 'all' ? 'No members yet' : EMPTY.invitations} />}
          {list.map((member) => (
            <div className="list-row members-row" role="listitem" key={member.id} style={{ minHeight: 84 }}>
              <Avatar person={{ name: member.name }} size={40} />
              <span className="t" style={{ width: 300, fontSize: 18 }}>
                {member.name}
                {member.user_id === state.user.id && <span className="meta"> · You</span>}
              </span>
              <span className="meta grow">
                {member.role === 'admin' ? 'Admin' : 'Member'} · {member.status}
                {member.reviewer_roles.length ? ` · ${member.reviewer_roles.join(', ')} reviewer` : ''}
              </span>
              {admin && (
                <span style={{ position: 'relative' }}>
                  <Button onClick={() => setManage(member.id)}>Manage</Button>
                  <Ack show={ack === member.id} style={{ right: 0, top: -40 }}>
                    Saved
                  </Ack>
                </span>
              )}
            </div>
          ))}
        </div>
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
                  void adapter.rest.invite(state.workspace.id, { email, role: 'member' }).then((row) => adapter.ensure('invitation', row.id)).catch(() => undefined);
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
                    if (person) void adapter.rest.removeMember(state.workspace.id, person.id).catch(() => undefined);
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
                      void adapter.rest.setMemberRole(state.workspace.id, person.id, role).catch(() => undefined);
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
                {doc.pdf_status === 'preparing' ? ` · ${EMPTY.pdfPreparing}` : doc.pdf_status === 'failed' ? ` · ${EMPTY.pdfFailed(doc.pdf_error ?? 'unknown')}` : ''}
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

function OrganizationTab() {
  const state = useAppState();
  const nav = useNav();
  const counts = memberCounts(state);
  return (
    <>
      {[
        ['Workspace', state.workspace.name],
        ['Your role', state.user.role === 'admin' ? 'Admin' : 'Member'],
        ['Signed in as', state.user.email || '—'],
        ['Jurisdiction', state.workspace.jurisdiction ?? 'default'],
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
 * Agents: the durable defaults. A catalog row is enabled only when a verified
 * key exists for its provider, so this screen and the composer agree by
 * construction.
 */
function AgentsTab() {
  const state = useAppState();
  const adapter = useAdapter();
  const admin = useIsAdmin();
  const nav = useNav();
  const catalog = catalogRows(state);
  const [ack, setAck] = useState(false);
  const settings = state.settings as { default_model_id?: string; default_effort?: string | null; default_runtime?: string; daily_token_cap?: number | null; max_concurrent_runs?: number };
  const current = catalog.find((row) => row.model_id === settings.default_model_id);

  const save = (patch: Record<string, unknown>): void => {
    void adapter.rest.patchSettings(state.workspace.id, patch).catch(() => undefined);
    setAck(true);
    setTimeout(() => setAck(false), 1600);
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
              checked={settings.default_model_id === row.model_id}
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
              <button key={value} type="button" role="radio" aria-checked={settings.default_effort === value} disabled={!admin} onClick={() => save({ default_effort: value })}>
                {value}
              </button>
            ))}
          </div>
        ) : (
          <span className="meta">Not available for this model</span>
        )}
      </div>
      <div className="kv">
        <span className="grow">Daily token cap</span>
        <span className="meta">{settings.daily_token_cap?.toLocaleString() ?? 'None'}</span>
      </div>
      <div className="kv">
        <span className="grow">Concurrent runs</span>
        <span className="meta">{settings.max_concurrent_runs ?? 1}</span>
      </div>
      <p className="meta">Durable defaults live here and are recorded in History. A per-session choice applies only to that session's next turn. Caps are enforced server-side.</p>
      {/* TODO(plan §10b, M5a): `FineTuneCard` replaces these rows once the sliders map to the integer columns. */}
    </>
  );
}

const STATUS_LABEL: Record<string, string> = { unverified: 'Unverified', verified: 'Verified', verified_scoped: 'Verified (scoped)', invalid: 'Invalid', revoked: 'Revoked' };

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
        window.location.assign(adapter.auth.stepUpUrl(window.location.href, reason));
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
                  {key.verified_models.length} model{key.verified_models.length === 1 ? '' : 's'} · {key.fingerprint_prefix} · added {new Date(key.created_at).toLocaleDateString()}
                  {key.rotated_at ? ` · rotated ${new Date(key.rotated_at).toLocaleDateString()}` : ''}
                </span>
              </div>
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
        Plaintext is never echoed; only the last four characters are ever shown. DeepSeek keys carry the PRC-storage warning on Data and privacy; Anthropic and OpenAI rows show the recorded attestation there.
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
          {['deepseek', 'anthropic', 'openai'].map((item) => (
            <MenuItem key={item} checked={provider === item} onClick={() => setProvider(item)}>
              {item}
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

function UsageTab() {
  const state = useAppState();
  const adapter = useAdapter();
  const [group, setGroup] = useState<'day' | 'session' | 'key'>('day');
  const [usage, setUsage] = useState<UsageResponse | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!state.workspace.id) return;
    const to = new Date().toISOString().slice(0, 10);
    const from = new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10);
    setUsage(null);
    setError(false);
    void adapter.rest
      .usage(state.workspace.id, from, to, group)
      .then(setUsage)
      .catch(() => setError(true));
  }, [adapter, state.workspace.id, group]);

  const capWarning = usage?.daily_token_cap ? usage.tokens_today / usage.daily_token_cap >= 0.8 : false;

  return (
    <>
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
      {error && <EmptyState icon="trace" title="Usage is unavailable" detail="The usage route did not answer. Try again shortly." />}
      {!usage && !error && <Skeleton rows={3} label="Loading usage" />}
      {usage && usage.rows.length === 0 && <EmptyState icon="trace" title="No usage yet" detail="Usage appears after the first run." />}
      {usage && usage.rows.length > 0 && (
        <>
          {capWarning && (
            <Panel
              icon="admission"
              title="Approaching the daily token cap"
              subtitle={`${usage.tokens_today.toLocaleString()} of ${usage.daily_token_cap?.toLocaleString()} tokens today`}
            />
          )}
          <div className="hermes-ui">
            <InsightCards />
          </div>
          <div className="col">
            {usage.rows.map((row) => (
              <div className="list-row compact" key={row.key}>
                <Glass name="trace" size={22} className="row-icon" />
                <div className="row-main">
                  <span className="t">{row.label}</span>
                  <span className="s">
                    {row.input_tokens.toLocaleString()} in · {row.output_tokens.toLocaleString()} out{row.model_id ? ` · ${row.model_id}` : ''}
                  </span>
                </div>
                <span className="meta">${row.estimated_cost_usd.toFixed(3)}</span>
              </div>
            ))}
          </div>
        </>
      )}
      <p className="meta">Estimated — billed by your provider. Prices carry the date they were last verified against the vendor's own pricing page.</p>
    </>
  );
}

function NotificationsTab() {
  const state = useAppState();
  const adapter = useAdapter();
  const [ack, setAck] = useState(false);
  const settings = state.settings as Record<string, unknown>;
  const set = (key: string, value: boolean): void => {
    void adapter.rest.patchSettings(state.workspace.id, { [key]: value }).catch(() => undefined);
    setAck(true);
    setTimeout(() => setAck(false), 1400);
  };
  return (
    <>
      <h2 className="section-title">Email notifications</h2>
      {[
        ['notify_approvals', 'Approval requests'],
        ['notify_blocked', 'Blocked work'],
        ['notify_digest', 'Daily digest'],
      ].map(([key, label]) => (
        <div className="settings-row" key={key}>
          <span className="grow">{label}</span>
          <Toggle checked={settings[key!] === true} onChange={(value) => set(key!, value)} label={label!} />
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

function PrivacyTab() {
  const state = useAppState();
  const keys = useWorkspaceLists().providerKeys;
  const providers = [...new Set(keys.map((key) => key.provider))];
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
      <h2 className="section-title">Processors</h2>
      {providers.length === 0 && <div className="meta" style={{ padding: '12px 0' }}>No provider is configured, so no prompt text leaves this workspace.</div>}
      {providers.map((provider) => (
        <div className="kv" key={provider}>
          <span className="grow">{provider}</span>
          <span className="meta" style={{ textAlign: 'right', maxWidth: 420 }}>
            {provider === 'deepseek'
              ? 'Prompts and completions are processed and may be stored in the PRC. Do not send personal data you cannot send there.'
              : 'Zero-retention attestation recorded for API traffic; retention facts are per key and re-checked weekly.'}
          </span>
        </div>
      ))}
      <h2 className="section-title">Attribution</h2>
      <div className="kv">
        <span className="grow">Interface components</span>
        <span className="meta">
          <a href="/LICENSE.beautiful-ui">Beautiful UI · MIT</a>
        </span>
      </div>
    </>
  );
}
