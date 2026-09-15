// The Inbox: the list, the review pane, the document viewer and the receipt.
//
// This is the screen the whole product is arranged around, so three rules are
// visible in the code:
//   * the decision goes through `POST /w/:ws/requests/:id/decisions` and
//     nothing else. There is no `request/decide` reducer case to fall back on;
//   * a Member sees the request and the evidence and, where the Admin has
//     controls, the words "Admin decision required" — not a disabled button
//     that implies the seat is the problem;
//   * a 401 `reauth_required` stores the intent, redirects, and on return
//     re-renders in a "Re-authenticated — confirm to continue" state that
//     requires a second, deliberate click. The client never auto-replays a
//     decision.
import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { HISTORY, INBOX, LIB, OV, REQ, type DocumentEntity, type EffectEntity, type Ref, type RequestEntity } from '@hermes/shared';
import { SelectionActions } from '@hermes/motion-components';
import { useAdapter, useAppState, useDispatch, useEntity, useIsAdmin, useNav } from '../store-context.js';
import { storeStepUp } from '../../model/auth.js';
import { Glass, Icon, KIND_ICON } from '../ui/icons.js';
import { Ack, Avatar, Button, Dialog, EmptyState, Panel, Skeleton, Tabs, fmtMoney } from '../ui/primitives.js';
import { EMPTY } from '../../model/constants.js';
import { requestStatusLabel } from '../selectors.js';
import { useWorkspaceLists } from './lists.js';

type RequestPayload = Record<string, unknown>;

const record = (value: unknown): RequestPayload =>
  value && typeof value === 'object' && !Array.isArray(value) ? (value as RequestPayload) : {};
const text = (value: unknown): string | null => (typeof value === 'string' && value.length > 0 ? value : null);

type ApplicantSource = { id: string; name: string; note: string; url: string | null };
type SourceKind = 'linkedin' | 'github' | 'youtube' | 'x' | 'web';

function titleCaseLabel(value: string): string {
  return value
    .trim()
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function sourceKind(source: Pick<ApplicantSource, 'name' | 'url'>): SourceKind {
  const haystack = `${source.name} ${source.url ?? ''}`.toLowerCase();
  if (haystack.includes('linkedin')) return 'linkedin';
  if (haystack.includes('github')) return 'github';
  if (haystack.includes('youtube')) return 'youtube';
  if (/\b(x\.com|twitter|x profile)\b/.test(haystack)) return 'x';
  return 'web';
}

function SourceMark({ source, size = 26 }: { source: ApplicantSource; size?: number }) {
  const kind = sourceKind(source);
  return (
    <span className={`source-mark source-mark-${kind}`} style={{ width: size, height: size }} aria-hidden="true">
      <svg viewBox="0 0 24 24" width={Math.round(size * .58)} height={Math.round(size * .58)}>
        {kind === 'linkedin' && <path d="M5.2 3.8A2.2 2.2 0 1 1 5.2 8a2.2 2.2 0 0 1 0-4.3ZM3.4 9.5H7V21H3.4Zm5.8 0h3.4v1.6h.1c.5-.9 1.7-2 3.5-2 3.7 0 4.4 2.4 4.4 5.6V21H17v-5.6c0-1.3 0-3-1.9-3s-2.2 1.4-2.2 2.9V21H9.2Z" />}
        {kind === 'github' && <path d="M12 2.4a9.8 9.8 0 0 0-3.1 19.1c.5.1.7-.2.7-.5v-1.9c-2.8.6-3.4-1.2-3.4-1.2-.5-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 0 1.6 1 1.6 1 .9 1.5 2.4 1.1 3 .8.1-.6.4-1.1.7-1.4-2.2-.3-4.6-1.1-4.6-4.8 0-1.1.4-1.9 1-2.6-.1-.3-.4-1.3.1-2.6 0 0 .8-.3 2.7 1a9.2 9.2 0 0 1 4.9 0c1.9-1.3 2.7-1 2.7-1 .5 1.3.2 2.3.1 2.6.6.7 1 1.5 1 2.6 0 3.8-2.3 4.6-4.6 4.8.4.3.7.9.7 1.8V21c0 .3.2.6.7.5A9.8 9.8 0 0 0 12 2.4Z" />}
        {kind === 'youtube' && <path d="M21.2 7.2a2.8 2.8 0 0 0-2-2C17.5 4.7 12 4.7 12 4.7s-5.5 0-7.2.5a2.8 2.8 0 0 0-2 2A29 29 0 0 0 2.3 12a29 29 0 0 0 .5 4.8 2.8 2.8 0 0 0 2 2c1.7.5 7.2.5 7.2.5s5.5 0 7.2-.5a2.8 2.8 0 0 0 2-2 29 29 0 0 0 .5-4.8 29 29 0 0 0-.5-4.8ZM10 15.2V8.8l5.4 3.2Z" />}
        {kind === 'x' && <path d="M4 3h4.7l4.2 5.6L17.8 3H20l-6.1 7.1L20.5 21h-4.7l-4.6-6.1L5.9 21H3.6l6.6-7.6Zm3.6 1.8 9.1 14.4h1.7L9.3 4.8Z" />}
        {kind === 'web' && <><circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="1.8" /><path d="M3.5 12h17M12 3c2.2 2.4 3.3 5.4 3.3 9S14.2 18.6 12 21M12 3C9.8 5.4 8.7 8.4 8.7 12s1.1 6.6 3.3 9" fill="none" stroke="currentColor" strokeWidth="1.5" /></>}
      </svg>
    </span>
  );
}

function requestType(request: RequestEntity): string {
  if (request.kind === 'application') return 'Application';
  if (request.kind === 'invoice') return 'Invoice';
  return 'Signature';
}

function requestPreview(request: RequestEntity): string {
  const payload = record(request.payload);
  if (request.kind === 'application') {
    const maximum = typeof payload.score_max === 'number' ? payload.score_max : 100;
    const score = typeof payload.score === 'number' ? payload.score : 0;
    return `${text(payload.proposed_role) ?? text(payload.role) ?? 'Partner applicant'} · ${score}/${maximum}`;
  }
  if (request.kind === 'invoice') {
    const payee = text(record(payload.payee).name) ?? request.subject ?? 'Invoice';
    const amount = typeof payload.total_minor === 'number' ? fmtMoney(payload.total_minor) : null;
    return [payee, amount].filter(Boolean).join(' · ');
  }
  const parties = Array.isArray(payload.parties)
    ? payload.parties.map((party) => text(record(party).name)).filter((party): party is string => !!party)
    : [];
  return `${parties.slice(0, 2).join(' ↔ ') || request.subject || 'Agreement'} · ${text(payload.version_label) ?? 'Unsigned'}`;
}

function requestAction(request: RequestEntity): string {
  if (request.status !== 'pending') return requestStatusLabel(request);
  if (request.kind === 'application') return 'Review applicant';
  if (request.kind === 'invoice') return 'Review invoice';
  return 'Review for signature';
}

function shortDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? '' : date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

export function InboxList() {
  return <InboxSurface selectedId={null} />;
}

export function RequestReview({ id }: { id: string | null }) {
  return <InboxSurface selectedId={id} />;
}

function InboxSurface({ selectedId }: { selectedId: string | null }) {
  const state = useAppState();
  const dispatch = useDispatch();
  const nav = useNav();
  const lists = useWorkspaceLists();
  const tab = state.ui.inboxTab;
  const filters = state.ui.app.filters;
  const query = filters?.query ?? '';
  const kind = filters?.kind ?? 'all';
  const filtered = query.length > 0 || kind !== 'all';
  const selected = lists.requests.find((request) => request.id === selectedId) ?? null;
  const activeTab = selected
    ? selected.status === 'pending' ? 'needs-review' : 'resolved'
    : tab;
  const setFilters = (patch: NonNullable<Ref['filters']>): void => {
    nav({ section: 'inbox', view: 'list', filters: { ...filters, ...patch } });
  };

  const list = useMemo(
    () =>
      lists.requests
        .filter((request) => (activeTab === 'resolved' ? request.status !== 'pending' : request.status === 'pending'))
        .filter((request) => kind === 'all' || (kind === 'documents' ? request.kind !== 'application' : request.kind === kind))
        .filter((request) => `${request.label} ${request.subject ?? ''}`.toLowerCase().includes(query.toLowerCase())),
    [lists.requests, activeTab, kind, query],
  );
  const listLabel = activeTab === 'resolved' ? 'Resolved requests' : 'Requests needing review';
  const backRef: Ref = { section: 'inbox', view: 'list', filters };

  return (
    <div className="inbox-surface" data-detail={selectedId ? 'true' : 'false'}>
      <div className="inbox-topbar">
        <div className="inbox-title-row">
          <h1 className="display-32">Inbox</h1>
          {activeTab !== 'rules' && <span className="inbox-count">{list.length}</span>}
        </div>
        <Tabs
          tabs={[
            { id: 'needs-review', label: 'Needs review' },
            { id: 'resolved', label: 'Resolved' },
            { id: 'rules', label: 'Rules' },
          ]}
          value={activeTab}
          onChange={(value) => dispatch({ type: 'nav/tab', key: 'inboxTab', value })}
          label="Inbox views"
        />
        {activeTab !== 'rules' && (
          <div className="inbox-tools">
            <label className="search grow">
              <Icon name="search" />
              <input placeholder="Search requests" value={query} maxLength={200} onChange={(event) => setFilters({ query: event.target.value })} aria-label="Search requests" />
            </label>
            <select className="btn" aria-label="Request type" value={kind} onChange={(event) => setFilters({ kind: event.target.value as NonNullable<Ref['filters']>['kind'] })}>
              <option value="all">All types</option>
              <option value="application">Applications</option>
              <option value="documents">Documents</option>
              <option value="invoice">Invoices</option>
              <option value="agreement">Signatures</option>
            </select>
          </div>
        )}
      </div>
      {activeTab === 'rules' ? (
        <div className="scroll">
          <div className="app-body inbox-rules">
            <Panel icon="admission" title="Manual review" subtitle="A person decides these requests. Approved rules can handle routine work, but cannot bypass named reviewers." />
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
          </div>
        </div>
      ) : (
        <div className="inbox-columns">
          <div className="inbox-master scroll" role="list" aria-label={listLabel}>
            <AnimatePresence initial={false}>
              {list.map((request) => {
                const isSelected = request.id === selectedId;
                return (
                  <motion.button
                    type="button"
                    key={request.id}
                    role="listitem"
                    className="inbox-item"
                    aria-current={isSelected ? 'true' : undefined}
                    onClick={() => nav(REQ(request.id, { filters }))}
                    layout
                    initial={false}
                    exit={{ opacity: 0, height: 0, overflow: 'hidden', transition: { duration: 0.18 } }}
                    transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
                  >
                    <Glass name={KIND_ICON[request.kind] ?? 'context'} size={30} className="inbox-item-icon" />
                    <span className="inbox-item-body">
                      <span className="inbox-item-line">
                        <span className="inbox-item-subject">{request.subject ?? request.label}</span>
                        <span className="inbox-item-date">{shortDate(request.created_at)}</span>
                      </span>
                      <span className="inbox-item-preview">{requestPreview(request)}</span>
                      <span className="inbox-item-meta">
                        <span>{requestType(request)}</span>
                        <span aria-hidden="true">·</span>
                        <span>{requestAction(request)}</span>
                      </span>
                    </span>
                  </motion.button>
                );
              })}
            </AnimatePresence>
            {list.length === 0 && !lists.loading && (
              <EmptyState
                icon={activeTab === 'resolved' ? 'trace' : 'admission'}
                title={filtered ? 'No matching requests' : activeTab === 'resolved' ? EMPTY.inboxResolved : EMPTY.inbox}
                detail={filtered ? 'Try a different search or request type.' : activeTab === 'resolved' ? 'Completed reviews appear here.' : `${state.counts.decisions} decisions are in History.`}
                action={filtered
                  ? <Button onClick={() => setFilters({ query: '', kind: 'all' })}>Clear filters</Button>
                  : <Button onClick={() => nav(activeTab === 'resolved' ? INBOX : HISTORY())}>{activeTab === 'resolved' ? 'Needs review' : 'View History'}</Button>}
              />
            )}
            {list.length === 0 && lists.loading && <Skeleton rows={3} label="Loading requests" />}
          </div>
          {selectedId && (
            <motion.div
              className="inbox-detail"
              key={selectedId}
              initial={{ opacity: 0, x: 8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
            >
              <div className="inbox-detail-nav">
                <Button link onClick={() => nav(backRef)} aria-label="Back to Inbox">
                  <Icon name="arrow" size={16} className="back-arrow" /> Inbox
                </Button>
                <span className="grow" />
                {selected && <span className="pill">{requestType(selected)}</span>}
              </div>
              <RequestDetail id={selectedId} />
            </motion.div>
          )}
        </div>
      )}
    </div>
  );
}

function RequestDetail({ id }: { id: string | null }) {
  const entity = useEntity<RequestEntity>('request', id);
  if (entity.state === 'loading') {
    return (
      <div className="scroll"><div className="app-body"><Skeleton rows={5} label="Loading the request" /></div></div>
    );
  }
  if (entity.state === 'unavailable') {
    return (
      <div className="scroll"><div className="app-body"><EmptyState icon="admission" title="This server does not serve requests" detail="The client is newer than the Worker it is talking to. Nothing was deleted." /></div></div>
    );
  }
  if (entity.state === 'missing' || !entity.data) {
    return (
      <div className="scroll"><div className="app-body"><EmptyState icon="admission" title={EMPTY.requestMissing} detail="It may have been redacted, or it belongs to another workspace." /></div></div>
    );
  }
  const request = entity.data;
  if (request.status !== 'pending') return <Receipt request={request} />;
  return request.kind === 'application' ? <ApplicationView request={request} /> : <DocumentView request={request} />;
}

/** Shared decision footer. The only place in the client that calls `decide`. */
function DecisionFooter({ request, title, detail, approveLabel, declineLabel }: { request: RequestEntity; title: string; detail: string; approveLabel: string; declineLabel: string }) {
  const adapter = useAdapter();
  const admin = useIsAdmin();
  const [confirmDecline, setConfirmDecline] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reauthed, setReauthed] = useState(false);

  // On return from a step-up redirect the pane re-renders in a confirm state.
  // The intent is read, never replayed.
  useEffect(() => {
    const intent = adapter.pendingStepUp();
    if (intent?.kind === 'decision' && intent.requestId === request.id) {
      setReauthed(true);
      adapter.clearStepUp();
    }
  }, [adapter, request.id]);

  if (!admin) {
    return (
      <div className="app-footer" style={{ marginInline: -28 }}>
        <div className="col grow" style={{ gap: 3 }}>
          <span className="f-title">{EMPTY.adminOnly}</span>
          <span className="f-sub">You can read the request and its evidence. An Admin records the decision.</span>
        </div>
      </div>
    );
  }

  const decide = async (decision: 'approve' | 'decline'): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const result = await adapter.decide(request.id, decision);
      if (result === 'reauth_required') return;
      adapter.ensure('request', request.id);
    } catch (caught) {
      const reason = (caught as { reason?: string }).reason;
      setError(reason === 'already_decided' ? 'Already decided' : reason === 'not_admin' ? EMPTY.adminOnly : 'Could not record the decision. Try again.');
    } finally {
      setBusy(false);
      setConfirmDecline(false);
    }
  };

  return (
    <>
      <div className="app-footer" style={{ marginInline: -28 }}>
        <div className="col grow" style={{ gap: 3 }}>
          <span className="f-title">{reauthed ? 'Re-authenticated — confirm to continue' : title}</span>
          <span className="f-sub">{error ?? detail}</span>
        </div>
        <Button disabled={busy} onClick={() => setConfirmDecline(true)}>
          {declineLabel}
        </Button>
        <Button primary disabled={busy} onClick={() => void decide('approve')}>
          {approveLabel}
        </Button>
      </div>
      <Dialog
        open={confirmDecline}
        title={`Decline ${request.subject ?? request.label}?`}
        onClose={() => setConfirmDecline(false)}
        actions={
          <>
            <Button onClick={() => setConfirmDecline(false)}>Keep reviewing</Button>
            <Button primary onClick={() => void decide('decline')}>
              Decline
            </Button>
          </>
        }
      >
        <p>No message is sent. The decision is recorded in History.</p>
      </Dialog>
    </>
  );
}

function ApplicationView({ request }: { request: RequestEntity }) {
  const state = useAppState();
  const payload = record(request.payload);
  const applicant = record(payload.applicant);
  const name = text(applicant.name) ?? request.subject ?? request.label;
  const firstName = name.split(' ')[0] ?? 'applicant';
  const role = text(payload.proposed_role) ?? text(payload.role) ?? request.title ?? 'Partner applicant';
  const email = text(applicant.email);
  const score = typeof payload.score === 'number' ? payload.score : 0;
  const scoreMax = typeof payload.score_max === 'number' ? payload.score_max : 100;
  const payloadSources = Array.isArray(payload.sources)
    ? payload.sources.flatMap((item) => {
        const source = record(item);
        const id = text(source.id);
        const sourceName = text(source.name);
        if (!id || !sourceName) return [];
        return [{ id, name: sourceName, note: text(source.note) ?? '', url: text(source.url) }];
      })
    : [];
  const sources: ApplicantSource[] = payloadSources.length > 0
    ? payloadSources
    : request.sources.map((source) => ({ ...source, url: null }));
  const criteria = Array.isArray(payload.criteria)
    ? payload.criteria.flatMap((item) => {
        const criterion = record(item);
        const label = text(criterion.label);
        if (!label) return [];
        return [{
          label: titleCaseLabel(label),
          points: typeof criterion.points === 'number' ? criterion.points : 0,
          maximum: typeof criterion.points_max === 'number' ? criterion.points_max : 0,
          evidence: text(criterion.evidence),
          sourceIds: Array.isArray(criterion.source_ids)
            ? criterion.source_ids.filter((id): id is string => typeof id === 'string')
            : [],
        }];
      })
    : Array.isArray(payload.breakdown)
      ? payload.breakdown.flatMap((item) => Array.isArray(item) && typeof item[0] === 'string' && typeof item[1] === 'number' && typeof item[2] === 'number'
        ? [{ label: titleCaseLabel(item[0]), points: item[1], maximum: item[2], evidence: null, sourceIds: [] }]
        : [])
      : [];
  const benefits = Array.isArray(payload.benefits) ? payload.benefits.filter((item): item is string => typeof item === 'string') : [];
  const strongest = [...criteria]
    .filter((criterion) => criterion.evidence)
    .sort((a, b) => (b.maximum > 0 ? b.points / b.maximum : 0) - (a.maximum > 0 ? a.points / a.maximum : 0))[0];
  const takeaway = strongest?.evidence ?? null;
  const isDemo = /\b(demo|fictional|illustrative)\b/i.test(request.label)
    || sources.some((source) => /\b(demo|fictional|illustrative)\b/i.test(source.note));
  const [source, setSource] = useState<ApplicantSource | null>(null);
  const [report, setReport] = useState(false);

  return (
    <>
      <div className="app-pane-body request-pane">
        <div className="scroll request-scroll">
          <div className="col request-content">
            <div className="application-heading">
              <Avatar person={{ name }} size={40} />
              <div className="col grow" style={{ gap: 3 }}>
                <h1 className="display-32">{name}</h1>
                <span className="meta">{[role, email].filter(Boolean).join(' · ')}</span>
              </div>
              <div className="application-score" aria-label={`${score} out of ${scoreMax}`}>
                <strong>{score}</strong><span>/ {scoreMax}</span>
              </div>
            </div>

            <div className="panel application-summary">
              <Glass name="iris" size={30} />
              <div className="col grow" style={{ gap: 3 }}>
                <span>Iris screened this application</span>
                <span className="meta">{sources.length > 0 ? `${sources.length} sources used` : 'No linked sources'}</span>
              </div>
              {sources.length > 0 && (
                <span className="source-stack" aria-label={`${sources.length} sources used by Iris`}>
                  {sources.slice(0, 4).map((item) => <SourceMark key={item.id} source={item} size={24} />)}
                </span>
              )}
              <Avatar person={{ name: state.user.name }} />
            </div>

            {criteria.length > 0 && (
              <section className="application-criteria" aria-labelledby="criteria-heading">
                <div className="row">
                  <h2 className="section-title" id="criteria-heading">Screening</h2>
                  <span className="grow" />
                  <Button link onClick={() => setReport(true)}>Full report →</Button>
                </div>
                <div className="criteria-list">
                  {criteria.map((criterion) => {
                    const fraction = criterion.maximum > 0 ? Math.max(0, Math.min(1, criterion.points / criterion.maximum)) : 0;
                    return (
                      <div className="criterion-row" key={criterion.label}>
                        <div className="col grow" style={{ gap: 5 }}>
                          <div className="row">
                            <span className="criterion-label">{criterion.label}</span>
                            <span className="grow" />
                            <span className="meta">{criterion.points}/{criterion.maximum}</span>
                          </div>
                          <span className="criterion-track" aria-hidden="true"><span style={{ width: `${fraction * 100}%` }} /></span>
                          {criterion.evidence && <span className="meta criterion-evidence">{criterion.evidence}</span>}
                          {criterion.sourceIds.length > 0 && (
                            <span className="criterion-sources" aria-label={`${criterion.sourceIds.length} cited source${criterion.sourceIds.length === 1 ? '' : 's'}`}>
                              {criterion.sourceIds.flatMap((sourceId) => {
                                const item = sources.find((candidate) => candidate.id === sourceId);
                                return item ? [<SourceMark key={item.id} source={item} size={18} />] : [];
                              })}
                            </span>
                          )}
                        </div>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            {sources.length > 0 && (
              <section className="source-section" aria-labelledby="sources-heading">
                <div className="row">
                  <h2 className="section-title" id="sources-heading">Sources used</h2>
                  <span className="grow" />
                  <span className="meta">{isDemo ? 'Illustrative' : 'Cited by Iris'}</span>
                </div>
                <div className="source-grid" role="list">
                  {sources.map((item) => (
                    <button type="button" className="source-card" role="listitem" key={item.id} onClick={() => setSource(item)}>
                      <SourceMark source={item} size={30} />
                      <span className="source-card-name">{item.name}</span>
                      <Icon name="check" size={14} className="source-used-check" />
                    </button>
                  ))}
                </div>
              </section>
            )}

            {takeaway && (
              <section className="panel evidence-highlight" aria-labelledby="takeaway-heading">
                <Glass name="context" size={32} />
                <div className="col grow" style={{ gap: 5 }}>
                  <span className="evidence-kicker" id="takeaway-heading">Main takeaway</span>
                  <strong>{takeaway}</strong>
                  <span className="meta">
                    {sources.length > 0
                      ? `${sources.length} ${isDemo ? 'illustrative sources' : 'sources cited by Iris'}`
                      : 'No linked source supports this takeaway yet'}
                  </span>
                </div>
                {sources.length > 0 && (
                  <span className="source-stack evidence-source-stack" aria-hidden="true">
                    {sources.slice(0, 4).map((item) => <SourceMark key={item.id} source={item} size={22} />)}
                  </span>
                )}
              </section>
            )}

            {request.missing.length > 0 && (
              <div className="panel missing-panel plain" style={{ backgroundImage: 'var(--panel)' }}>
                <div className="col" style={{ gap: 6 }}>
                  <span className="k">Missing evidence</span>
                  <span className="v">{request.missing.join(' · ')}</span>
                </div>
              </div>
            )}
            {benefits.length > 0 && <p className="meta">Proposed benefits · {benefits.join(' · ')}</p>}
            {request.note && (
              <div className="note-block">
                <span className="k">Review note · Saved · Not sent</span>
                <span className="t">{request.note}</span>
              </div>
            )}
          </div>
        </div>
        <DecisionFooter
          request={request}
          title={`Admit ${firstName} to the Partner Program.`}
          detail="Role and access require separate approval. No message is sent."
          approveLabel={`Admit ${firstName}`}
          declineLabel="Decline"
        />
      </div>
      <Dialog open={report} title={`${name} · screening report`} onClose={() => setReport(false)} actions={<Button onClick={() => setReport(false)}>Back to review</Button>}>
        <p className="meta">Iris mapped each cited signal to the review criteria. Gaps stay visible.</p>
        {criteria.map((criterion) => (
          <div key={criterion.label} className="col report-criterion">
            <div className="row"><span>{criterion.label}</span><span className="grow" /><span>{criterion.points}/{criterion.maximum}</span></div>
            {criterion.evidence && <span className="meta">{criterion.evidence}</span>}
          </div>
        ))}
      </Dialog>
      <Dialog open={!!source} title={source?.name ?? ''} onClose={() => setSource(null)} actions={<Button onClick={() => setSource(null)}>Close</Button>}>
        <p>{source?.note}</p>
        <p className="meta">{isDemo ? 'Illustrative source for this local demo.' : 'Source cited by Iris. Open-link verification is not available in this client yet.'}</p>
      </Dialog>
    </>
  );
}

/**
 * The document viewer. The preview is rendered from `documents.payload`; the
 * PDF tab shows the server-rendered file when it exists, "PDF is being
 * prepared" while the render job runs, and the failure reason with a Retry when
 * it does not.
 */
export function DocumentView({ request, document: doc, readOnly }: { request: RequestEntity; document?: DocumentEntity | null; readOnly?: boolean }) {
  const adapter = useAdapter();
  const state = useAppState();
  const nav = useNav();
  const [mode, setMode] = useState<'preview' | 'render' | 'pdf'>('preview');
  const [zoom, setZoom] = useState(100);
  const [line, setLine] = useState<string | null>(null);
  const [ack, setAck] = useState(false);
  const payload = record(request.payload);
  const number = text(payload.number) ?? request.label;
  const currency = text(payload.currency) ?? 'USD';
  const payer = record(payload.payer);
  const payee = record(payload.payee);
  const payloadParties = Array.isArray(payload.parties) ? payload.parties.map(record) : [];
  const parties = payloadParties.length > 0
    ? payloadParties
    : [{ name: state.workspace.name }, { name: request.subject ?? request.label }];
  const payeeName = text(payee.name) ?? request.subject ?? request.label;
  const payerName = text(payer.name) ?? state.workspace.name;
  const issueDate = text(payload.issue_date) ?? text(payload.issued) ?? '—';
  const dueDate = text(payload.due_date) ?? text(payload.due) ?? '—';
  const versionLabel = text(payload.version_label) ?? 'v1';
  const totalMinor = typeof payload.total_minor === 'number' ? payload.total_minor : 0;
  const lines = Array.isArray(payload.lines)
    ? payload.lines.flatMap((item) => {
        const row = record(item);
        const id = text(row.id);
        const label = text(row.label);
        if (!id || !label || typeof row.qty !== 'number' || typeof row.amount_minor !== 'number') return [];
        return [{ id, label, qty: row.qty, amount_minor: row.amount_minor, date: text(row.date) ?? 'No service date' }];
      })
    : [];
  const sections = Array.isArray(payload.sections)
    ? payload.sections.flatMap((item) => {
        if (Array.isArray(item) && typeof item[0] === 'string' && typeof item[1] === 'string') return [{ heading: item[0], body: item[1] }];
        const section = record(item);
        const heading = text(section.heading);
        const body = text(section.body);
        return heading && body ? [{ heading, body }] : [];
      })
    : [];
  const selected = lines.find((row) => row.id === line) ?? null;

  return (
    <div className="app-pane-body request-pane">
      <div className="row" style={{ gap: 14 }}>
        <Glass name={request.kind === 'invoice' ? 'invoice' : 'agreement'} size={38} />
        <div className="col grow" style={{ gap: 3 }}>
          <h1 className="display-32">{request.kind === 'invoice' ? `Invoice ${number}` : 'Services agreement'}</h1>
          <span className="meta">
            {request.kind === 'invoice'
              ? [payeeName, fmtMoney(totalMinor), currency].filter(Boolean).join(' · ')
              : [parties.map((party) => text(party.name)).filter(Boolean).join(' ↔ '), versionLabel].filter(Boolean).join(' · ')}
          </span>
        </div>
        <span className="pill">{request.kind === 'invoice' ? 'Invoice approval' : 'Signature approval'}</span>
      </div>
      <div className="doc-frame">
        <div className="doc-toolbar">
          <span>{number}.pdf</span>
          <span className="seg" role="group" aria-label="Document view">
            <button type="button" aria-pressed={mode === 'preview'} onClick={() => setMode('preview')}>
              Preview
            </button>
            <button type="button" aria-pressed={mode === 'render'} onClick={() => setMode('render')} disabled={!doc}>
              HTML render
            </button>
            <button type="button" aria-pressed={mode === 'pdf'} onClick={() => setMode('pdf')}>
              PDF
            </button>
          </span>
          <span className="grow" />
          <span>1 / 1</span>
          <button type="button" className="text-btn" aria-label="Zoom" onClick={() => setZoom((value) => (value === 100 ? 115 : 100))}>
            {zoom}%
          </button>
        </div>
        {mode === 'render' ? (
          <div className="col grow" style={{ minHeight: 0, gap: 8, padding: 0 }}>
            {doc ? (
              // The saved render, served by `GET /w/:ws/documents/:id/render`
              // as `text/html` under this workspace's key. Sandboxed with no
              // `allow-scripts` and no `allow-same-origin`: it is a document
              // the product produced, and it still does not get to run.
              <iframe
                className="pdf-embed"
                sandbox=""
                src={`/w/${state.workspace.id}/documents/${doc.id}/render`}
                title={`${doc.title} · saved render`}
              />
            ) : (
              <EmptyState icon="invoice" title="No saved render yet" detail="A render is written when the document is created." />
            )}
          </div>
        ) : mode === 'pdf' ? (
          <div className="col grow" style={{ minHeight: 0, gap: 8, padding: 24 }}>
            {doc?.pdf_status === 'ready' && doc.pdf_url ? (
              <iframe className="pdf-embed" src={`${doc.pdf_url}#toolbar=0&navpanes=0&view=FitH`} title={`${number}.pdf`} />
            ) : doc?.pdf_status === 'failed' ? (
              <EmptyState icon="invoice" title={EMPTY.pdfFailed(doc.pdf_error ?? 'unknown')} action={<Button onClick={() => adapter.ensure('document', doc.id)}>Retry</Button>} />
            ) : doc?.pdf_status === 'none' && doc.pdf_error ? (
              // The honest one. `none` with a reason means there is no renderer
              // in this build and nobody is preparing anything.
              <EmptyState
                icon="invoice"
                title={EMPTY.pdfUnavailable}
                detail={doc.pdf_error}
                action={<Button onClick={() => setMode('render')}>Open the HTML render</Button>}
              />
            ) : (
              <EmptyState icon="invoice" title={EMPTY.pdfPreparing} detail="The preview below is the same content." />
            )}
          </div>
        ) : (
          <div className="doc-scroll">
            <div className="doc-page" style={{ zoom: zoom / 100 }}>
              {request.kind === 'invoice' ? (
                <>
                  <div className="row doc-rule" style={{ justifyContent: 'space-between', paddingBottom: 18, alignItems: 'center' }}>
                    <div className="col" style={{ gap: 6 }}>
                      <span className="doc-h">Invoice</span>
                      <span className="doc-meta">{number} · Review copy</span>
                    </div>
                  </div>
                  <div className="doc-parties">
                    <div className="col"><span className="doc-label">From</span><strong>{payeeName}</strong><span>{text(payee.email)}</span></div>
                    <span className="doc-arrow">→</span>
                    <div className="col"><span className="doc-label">Bill to</span><strong>{payerName}</strong><span>{text(payer.email)}</span></div>
                  </div>
                  <div className="row doc-rule" style={{ gap: 24, padding: '12px 0', fontSize: 14, color: '#000' }}>
                    <span style={{ width: 208 }}>Issued · {issueDate}</span>
                    <span style={{ width: 208 }}>Due · {dueDate}</span>
                  </div>
                  <div className="doc-head-row">
                    <span className="c1" style={{ flex: 1 }}>
                      Services delivered
                    </span>
                    <span style={{ width: 80, textAlign: 'right' }}>Qty</span>
                    <span style={{ width: 140, textAlign: 'right' }}>Amount · {currency}</span>
                  </div>
                  {lines.map((row) => (
                    <button type="button" key={row.id} className="doc-line" aria-pressed={line === row.id} onClick={() => setLine(line === row.id ? null : row.id)}>
                      <span className="c1">{row.label}</span>
                      <span className="c2">{row.qty}</span>
                      <span className="c3">{(row.amount_minor / 100).toFixed(2)}</span>
                    </button>
                  ))}
                  <div className="doc-total">
                    <span className="k">Total</span>
                    <span className="v">{fmtMoney(totalMinor)}</span>
                  </div>
                  <div className="doc-foot">
                    <span>Not sent · No money moved</span>
                    <span>{number} · 1 / 1</span>
                  </div>
                </>
              ) : (
                <>
                  <div className="row doc-rule" style={{ justifyContent: 'space-between', paddingBottom: 18, alignItems: 'center' }}>
                    <div className="col" style={{ gap: 6 }}>
                      <span className="doc-h">Services Agreement</span>
                      <span className="doc-meta">{number} · {versionLabel} · Unsigned</span>
                    </div>
                  </div>
                  {parties.length > 0 && (
                    <div className="doc-parties">
                      {parties.slice(0, 2).map((party, index) => (
                        <div className="col" key={`${text(party.name) ?? 'party'}-${index}`}>
                          <span className="doc-label">{index === 0 ? 'Prepared for' : 'Counterparty'}</span>
                          <strong>{text(party.name) ?? '—'}</strong>
                          <span>{text(party.email)}</span>
                        </div>
                      ))}
                    </div>
                  )}
                  {sections.map((section) => (
                    <div className="col" key={section.heading} style={{ gap: 6 }}>
                      <span className="doc-sec-h">{section.heading}</span>
                      <p>{section.body}</p>
                    </div>
                  ))}
                  <div className="signature-preview">
                    <span className="doc-label">Signature status</span>
                    <span>Unsigned · approval queues the signature step</span>
                  </div>
                  <div className="doc-foot" style={{ borderTop: 0 }}>
                    <span>Nothing signed · Nothing sent</span>
                    <span>{number} · {versionLabel} · 1 / 1</span>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>
      {selected && (
        // `SelectionActions` over the selected invoice line (plan 10b).
        //
        // Every string it shows is composed here, locally, from the line the
        // person clicked: `onRequestEdit` never reaches a model, which is why
        // it is supplied at all — without it the component streams its own
        // demo rewrite, and a fabricated sentence on an invoice is exactly the
        // thing this product must not do. Keeping the draft puts it in the
        // composer, where the person still has to press send.
        <div className="hermes-ui selection-host">
          <SelectionActions
            text={{
              lead: `Selected line on ${number}:`,
              original: `${selected.label} · ${selected.qty} × ${fmtMoney(selected.amount_minor)}`,
              rewrite: `About ${selected.label} (${fmtMoney(selected.amount_minor)}) on ${number}: `,
            }}
            labels={{ keep: 'Add to the composer', discard: 'Clear', placeholder: 'Ask about this line' }}
            explanation={`This line is ${selected.label}, ${selected.qty} × ${fmtMoney(selected.amount_minor)}, dated ${selected.date}. It is read from the document payload; nothing here was generated.`}
            actions={{
              primary: [
                { id: 'Ask', icon: <Icon name="search" size={14} />, action: 'Ask', busyLabel: 'Composing' },
                { id: 'Explain', icon: <Icon name="check" size={14} />, action: 'Explain' },
              ],
              more: [],
            }}
            onRequestEdit={async (action) =>
              action === 'Explain'
                ? `${selected.label}: ${selected.qty} × ${fmtMoney(selected.amount_minor)} on ${selected.date}.`
                : `About ${selected.label} (${fmtMoney(selected.amount_minor)}) on ${number}: `
            }
            onKeep={(text) => {
              if (!state.activeSessionId) return;
              adapter.applyCommand(state.activeSessionId, { type: 'chat/prompt', text });
              setAck(true);
              setTimeout(() => setAck(false), 1600);
            }}
            onDiscard={() => setLine(null)}
          />
          <Ack show={ack} style={{ right: 0, top: -12, position: 'relative' }}>
            Added to the composer
          </Ack>
        </div>
      )}
      {readOnly ? (
        <div className="app-footer" style={{ marginInline: -28 }}>
          <div className="col grow" style={{ gap: 3 }}>
            <span className="f-title">Saved document</span>
            <span className="f-sub">Reopening it cannot create it again.</span>
          </div>
          <Button onClick={() => nav(LIB('documents'))}>Open Library</Button>
        </div>
      ) : (
        <DecisionFooter
          request={request}
          title={request.kind === 'invoice' ? `Approve invoice ${number}.` : `Approve ${number} for signature.`}
          detail={request.kind === 'invoice' ? 'Creates the invoice. No email is sent and no money moves.' : 'Saves this version and queues signature. Nothing is signed or sent.'}
          approveLabel={request.kind === 'invoice' ? 'Approve invoice' : 'Approve for signature'}
          declineLabel="Decline"
        />
      )}
    </div>
  );
}

/**
 * The receipt: what was decided, and what is still pending as an effect.
 *
 * The effects list is the most important honest surface in the product. There
 * is no executor in this repository — no SMTP client, no payment provider, no
 * signature provider — so pressing Execute records an attempt, writes
 * `unavailable`, and says in the server's own words that nothing was sent,
 * paid, granted or signed. The copy is the server's `reason` string rather than
 * ours, because that sentence is the thing being relied on and it should have
 * one author.
 *
 * Execute needs the reviewer role the effect names, and step-up. A second press
 * finds the row already `unavailable` and is answered with it rather than
 * appending a second audit row.
 */
export function Receipt({ request }: { request: RequestEntity }) {
  const state = useAppState();
  const adapter = useAdapter();
  const nav = useNav();
  const [effects, setEffects] = useState<EffectEntity[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reauthed, setReauthed] = useState(false);
  const declined = request.status === 'declined';

  const load = (): void => {
    if (!state.workspace.id) return;
    void adapter.rest
      .listEffects(state.workspace.id, request.id)
      .then((page) => setEffects(page.items))
      .catch(() => setEffects([]));
  };
  useEffect(load, [adapter, state.workspace.id, request.id]);

  // Back from a step-up: say so, and wait for a second, deliberate click.
  useEffect(() => {
    const intent = adapter.pendingStepUp();
    if (intent?.kind === 'effect' && intent.requestId === request.id) {
      setReauthed(true);
      adapter.clearStepUp();
    }
  }, [adapter, request.id]);

  const execute = (effect: EffectEntity): void => {
    setBusy(effect.id);
    setNotice(null);
    void adapter.rest
      .executeEffect(state.workspace.id, effect.id)
      .then((row) => {
        setEffects((current) => current.map((item) => (item.id === row.id ? row : item)));
        setReauthed(false);
      })
      .catch((caught: unknown) => {
        const error = caught as { status?: number; reason?: string };
        if (error.status === 401 && error.reason === 'reauth_required') {
          storeStepUp({ kind: 'effect', requestId: request.id, returnTo: window.location.href });
          const url = adapter.auth.stepUpUrl(window.location.href, 'provider_key');
          if (url) window.location.assign(url);
          else setNotice('This needs a recent sign-in. Sign in again to continue.');
          return;
        }
        setNotice(
          error.reason === 'role_required'
            ? `Executing this needs the ${effect.required_role} role.`
            : error.reason === 'effect_cancelled'
              ? 'A later version of this document cancelled that effect.'
              : 'Could not record that attempt. Try again.',
        );
      })
      .finally(() => setBusy(null));
  };

  const title = declined ? `${request.subject ?? request.label} · Declined` : requestStatusLabel(request).split(' · ')[0]!;
  const sub = requestStatusLabel(request).split(' · ').slice(1).join(' · ');

  return (
    <div className="scroll">
      <div className="col" style={{ gap: 18, paddingBottom: 18 }}>
        <div className="row" style={{ gap: 14 }}>
          <Glass name={KIND_ICON[request.kind] ?? 'context'} size={40} />
          <div className="col grow" style={{ gap: 3 }}>
            <h1 className="display-32">{request.subject ?? request.label}</h1>
            <span className="meta">{request.title}</span>
          </div>
          <Avatar person={{ name: request.decided_by_name ?? state.user.name }} />
          <span className="meta">{request.decided_by_name ?? state.user.name} · Reviewer</span>
        </div>
        <Panel selected icon={KIND_ICON[request.kind] ?? 'context'} title={title} subtitle={sub} right={<span className="meta">{request.decided_at ? new Date(request.decided_at).toLocaleString() : ''}</span>} />
        <h2 className="section-title">What this implies</h2>
        {reauthed && <p className="meta">Re-authenticated — press Execute again to continue.</p>}
        <div className="col">
          {effects.length === 0 && <div className="meta" style={{ padding: '12px 0' }}>Nothing else is required.</div>}
          {effects.map((effect) => (
            <div className="list-row" key={effect.id} style={{ minHeight: 88 }}>
              <Glass name="context" size={22} className="row-icon" />
              <div className="row-main">
                <span className="t">{effect.label}</span>
                <span className="s">
                  {effect.status === 'unavailable' ? 'Unavailable' : effect.status === 'cancelled' ? 'Cancelled' : `Pending · needs the ${effect.required_role} role`}
                  {effect.reason ? ` · ${effect.reason}` : ''}
                </span>
              </div>
              {effect.status === 'pending' && (
                <Button disabled={busy === effect.id} onClick={() => execute(effect)}>
                  {busy === effect.id ? 'Recording…' : 'Execute'}
                </Button>
              )}
            </div>
          ))}
        </div>
        {effects.some((effect) => effect.status === 'unavailable') && (
          <p className="meta" style={{ maxWidth: 760 }}>
            Nothing was sent, paid, granted or signed. There is no integration behind these in the pilot, so the attempt is recorded against your name and the work is still yours to do.
          </p>
        )}
        {notice && <p className="meta" role="alert">{notice}</p>}
        {request.note && (
          <div className="note-block">
            <span className="k">Review note · Not sent</span>
            <span className="t">{request.note}</span>
          </div>
        )}
        <div className="row" style={{ paddingTop: 8 }}>
          <Button primary onClick={() => nav(OV)}>
            Back to overview
          </Button>
          <Button onClick={() => nav(HISTORY())}>Open History</Button>
        </div>
        <p className="meta">Recorded decision. Downstream execution — access grants, payment, signing, sending — stays separate and pending.</p>
      </div>
    </div>
  );
}
