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
import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { HISTORY, INBOX, LIB, OV, REQ, type DocumentEntity, type EffectEntity, type Ref, type RequestEntity } from '@hermes/shared';
import { SelectionActions } from '@hermes/motion-components';
import { useAdapter, useAppState, useDispatch, useEntity, useIsAdmin, useNav } from '../store-context.js';
import { storeStepUp } from '../../model/auth.js';
import { Glass, Icon, KIND_ICON } from '../ui/icons.js';
import { Ack, Avatar, Button, Dialog, EmptyState, Panel, Skeleton, Tabs, fmtMoney } from '../ui/primitives.js';
import { EMPTY } from '../../model/constants.js';
import { requestStatusLabel } from '../selectors.js';
import { useWorkspaceLists } from './lists.js';
import {
  ApprovalRequest,
  approvalActionLabel,
  approvalIcon,
  approvalPreview,
  approvalReviewerLabel,
  approvalTypeLabel,
  matchesReviewerFilter,
} from './Approval.js';

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
  if (request.kind === 'approval') return approvalTypeLabel(request);
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
  if (request.kind === 'approval') return approvalPreview(request);
  const parties = Array.isArray(payload.parties)
    ? payload.parties.map((party) => text(record(party).name)).filter((party): party is string => !!party)
    : [];
  return `${parties.slice(0, 2).join(' ↔ ') || request.subject || 'Agreement'} · ${text(payload.version_label) ?? 'Unsigned'}`;
}

function requestAction(request: RequestEntity): string {
  if (request.status !== 'pending') return requestStatusLabel(request);
  if (request.kind === 'application') return 'Review applicant';
  if (request.kind === 'invoice') return 'Review invoice';
  if (request.kind === 'approval') return request.approval?.pending_for_viewer ? approvalActionLabel(request) : approvalReviewerLabel(request);
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
  const reducedMotion = useReducedMotion();
  const lists = useWorkspaceLists();
  const tab = state.ui.inboxTab;
  const filters = state.ui.app.filters;
  const approvalDemo = record(state.settings.flags).approval_demo === true;
  const query = filters?.query ?? '';
  const kind = filters?.kind ?? 'all';
  const reviewer = filters?.reviewer ?? 'for_me';
  const filtered = query.length > 0 || kind !== 'all' || reviewer !== 'for_me';
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
        .filter((request) => activeTab === 'resolved' || matchesReviewerFilter(request, reviewer))
        .filter((request) => kind === 'all' || (kind === 'documents' ? request.kind === 'invoice' || request.kind === 'agreement' : request.kind === kind))
        .filter((request) => `${request.label} ${request.subject ?? ''}`.toLowerCase().includes(query.toLowerCase())),
    [lists.requests, activeTab, kind, query, reviewer],
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
            {approvalDemo && <span className="approval-demo-tools"><span className="pill illustrative">Illustrative demo</span><Button link onClick={() => window.location.reload()} aria-label="Reset approval demo">Reset</Button></span>}
            <label className="search grow">
              <Icon name="search" />
              <input placeholder="Search requests" value={query} maxLength={200} onChange={(event) => setFilters({ query: event.target.value })} aria-label="Search requests" />
            </label>
            {activeTab === 'needs-review' && (
              <span className="reviewer-filter" role="group" aria-label="Reviewer">
                {([
                  ['for_me', 'For me'],
                  ['waiting', 'Waiting on others'],
                  ['all', 'All'],
                ] as const).map(([value, label]) => (
                  <button key={value} type="button" aria-pressed={reviewer === value} onClick={() => setFilters({ reviewer: value })}>{label}</button>
                ))}
              </span>
            )}
            <select className="btn" aria-label="Request type" value={kind} onChange={(event) => setFilters({ kind: event.target.value as NonNullable<Ref['filters']>['kind'] })}>
              <option value="all">All types</option>
              <option value="application">Applications</option>
              <option value="documents">Documents</option>
              <option value="invoice">Invoices</option>
              <option value="agreement">Signatures</option>
              <option value="approval">Approvals</option>
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
                    exit={reducedMotion ? { opacity: 0 } : { opacity: 0, height: 0, overflow: 'hidden', transition: { duration: 0.18 } }}
                    transition={reducedMotion ? { duration: 0 } : { duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
                  >
                    <Glass name={request.kind === 'approval' ? approvalIcon(request) : KIND_ICON[request.kind] ?? 'context'} size={30} className="inbox-item-icon" />
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
                  ? <Button onClick={() => setFilters({ query: '', kind: 'all', reviewer: 'for_me' })}>Clear filters</Button>
                  : <Button onClick={() => nav(activeTab === 'resolved' ? INBOX : HISTORY())}>{activeTab === 'resolved' ? 'Needs review' : 'View History'}</Button>}
              />
            )}
            {list.length === 0 && lists.loading && <Skeleton rows={3} label="Loading requests" />}
          </div>
          {selectedId && (
            <motion.div
              className="inbox-detail"
              key={selectedId}
              initial={reducedMotion ? false : { opacity: 0, x: 8 }}
              animate={{ opacity: 1, x: 0 }}
              transition={reducedMotion ? { duration: 0 } : { duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
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
  if (request.kind === 'approval') return <ApprovalRequest request={request} />;
  if (request.status !== 'pending') return <Receipt request={request} />;
  return request.kind === 'application' ? <ApplicationView request={request} /> : <DocumentView request={request} />;
}

/** Shared decision footer. The only place in the client that calls `decide`. */
function DecisionFooter({ request, title, detail, approveLabel, declineLabel, approveNote }: { request: RequestEntity; title: string; detail: string; approveLabel: string; declineLabel: string; approveNote?: string }) {
  const adapter = useAdapter();
  const state = useAppState();
  const dispatch = useDispatch();
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
      const result = await adapter.decide(request.id, decision, decision === 'approve' ? approveNote : undefined);
      if (result === 'reauth_required') return;
      if (decision === 'approve' && approveNote && state.workspace.id) {
        try {
          const saved = await adapter.rest.addRequestNote(state.workspace.id, request.id, { body: approveNote });
          dispatch({ type: 'entity/upsert', kind: 'request', id: saved.id, version: saved.version, data: saved });
        } catch {
          // The decision is already durable. The resolved document deliberately
          // offers the same authorization control so this partial success is
          // recoverable without replaying the decision.
          setError('Approved, but the authorization record was not saved. Open the resolved item to retry.');
        }
      }
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
type DocumentStage = 'review' | 'prepare' | 'confirm';

function DocumentSteps({ kind, stage, onChange }: { kind: 'invoice' | 'agreement'; stage: DocumentStage; onChange: (stage: DocumentStage) => void }) {
  const labels = kind === 'invoice'
    ? { review: 'Review invoice', prepare: 'Payment', confirm: 'Confirm' }
    : { review: 'Review agreement', prepare: 'Signature', confirm: 'Confirm' };
  const order: DocumentStage[] = ['review', 'prepare', 'confirm'];
  const active = order.indexOf(stage);
  return (
    <ol className="document-steps" aria-label={kind === 'invoice' ? 'Invoice approval steps' : 'Signature approval steps'}>
      {order.map((item, index) => (
        <li key={item} data-state={index < active ? 'complete' : index === active ? 'current' : 'upcoming'}>
          <button type="button" onClick={() => onChange(item)} aria-current={index === active ? 'step' : undefined}>
            <span className="document-step-index">{index < active ? <Icon name="check" size={13} /> : index + 1}</span>
            <span>{labels[item]}</span>
          </button>
          {index < order.length - 1 && <span className="document-step-line" aria-hidden="true" />}
        </li>
      ))}
    </ol>
  );
}

export function DocumentView({
  request,
  document: doc,
  readOnly,
  embedded,
  onAuthorizationChange,
}: {
  request: RequestEntity;
  document?: DocumentEntity | null;
  readOnly?: boolean;
  embedded?: boolean;
  onAuthorizationChange?: (saved: boolean) => void;
}) {
  const adapter = useAdapter();
  const state = useAppState();
  const dispatch = useDispatch();
  const nav = useNav();
  const reducedMotion = useReducedMotion();
  const noteHasAuthorization = request.kind === 'invoice'
    ? /^Payment authorization\b/i.test(request.note ?? '')
    : /^Electronic signature authorization\b/i.test(request.note ?? '');
  const [mode, setMode] = useState<'preview' | 'render' | 'pdf'>('preview');
  const [stage, setStage] = useState<DocumentStage>(readOnly ? 'prepare' : 'review');
  const [zoom, setZoom] = useState(100);
  const [line, setLine] = useState<string | null>(null);
  const [ack, setAck] = useState(false);
  const [paymentAuthorized, setPaymentAuthorized] = useState(noteHasAuthorization);
  const [signatureName, setSignatureName] = useState(state.user.name);
  const [signatureConsent, setSignatureConsent] = useState(noteHasAuthorization);
  const [authorizationSaved, setAuthorizationSaved] = useState(noteHasAuthorization);
  const [authorizationBusy, setAuthorizationBusy] = useState(false);
  const [authorizationError, setAuthorizationError] = useState<string | null>(null);
  const signatureRef = useRef<HTMLDivElement>(null);
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
  const isInvoice = request.kind === 'invoice';
  const isDemo = /\b(demo|fictional|illustrative)\b/i.test(`${request.label} ${text(payload.notes) ?? ''}`);
  const bankReady = isDemo;
  const prepareReady = isInvoice ? bankReady && paymentAuthorized : signatureName.trim().length >= 2 && signatureConsent;
  const approvalNote = isInvoice
    ? `Payment authorization prepared for ${fmtMoney(totalMinor)} from ${isDemo ? 'demo Operating account ending 4242' : 'the selected bank connection'} to ${payeeName}. Bank execution remains pending.`
    : `Electronic signature authorization recorded for ${signatureName.trim()} on ${number} ${versionLabel}. Signature-provider execution remains pending.`;

  useEffect(() => {
    if (!noteHasAuthorization) return;
    setAuthorizationSaved(true);
    setPaymentAuthorized(true);
    setSignatureConsent(true);
    onAuthorizationChange?.(true);
  }, [noteHasAuthorization, onAuthorizationChange]);

  useEffect(() => {
    if (readOnly || stage !== 'prepare' || isInvoice) return;
    signatureRef.current?.scrollIntoView({ block: 'center', behavior: reducedMotion ? 'auto' : 'smooth' });
  }, [isInvoice, readOnly, reducedMotion, stage]);

  const advance = (): void => {
    if (stage === 'review') setStage('prepare');
    else if (stage === 'prepare' && prepareReady) setStage('confirm');
  };

  const saveAuthorization = async (): Promise<void> => {
    if (!prepareReady || authorizationSaved || !state.workspace.id) return;
    setAuthorizationBusy(true);
    setAuthorizationError(null);
    try {
      const saved = await adapter.rest.addRequestNote(state.workspace.id, request.id, { body: approvalNote });
      dispatch({ type: 'entity/upsert', kind: 'request', id: saved.id, version: saved.version, data: saved });
      setAuthorizationSaved(true);
      onAuthorizationChange?.(true);
      adapter.ensure('request', request.id);
    } catch {
      setAuthorizationError('Could not save this authorization. Try again.');
    } finally {
      setAuthorizationBusy(false);
    }
  };

  return (
    <div className={`app-pane-body request-pane${embedded ? ' embedded-document-view' : ''}`}>
      {!embedded && (
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
      )}
      {!readOnly && (
        <DocumentSteps
          kind={isInvoice ? 'invoice' : 'agreement'}
          stage={stage}
          onChange={(next) => {
            setStage(next);
            if (!isInvoice && next === 'prepare') setMode('preview');
          }}
        />
      )}
      <AnimatePresence mode="wait" initial={false}>
        {stage === 'prepare' && isInvoice && (
          <motion.section
            key="payment-setup"
            className="panel document-action-card"
            aria-labelledby="payment-setup-heading"
            initial={reducedMotion ? false : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
            transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
          >
            <div className="document-action-heading">
              <Glass name="invoice" size={30} />
              <div className="col grow" style={{ gap: 3 }}>
                <h2 className="section-title" id="payment-setup-heading">Payment authorization</h2>
                <span className="meta">Choose where the transfer will come from.</span>
              </div>
              <span className="pill">{isDemo ? 'Demo connection' : 'Bank required'}</span>
            </div>
            <div className="payment-account" data-ready={bankReady ? 'true' : 'false'}>
              <span className="payment-account-icon"><Icon name="card" size={18} /></span>
              <span className="col grow" style={{ gap: 2 }}>
                <strong>{isDemo ? 'Operating account · ••4242' : 'Connect a bank account'}</strong>
                <span className="meta">{isDemo ? 'Prototype bank API · funds are not connected' : 'A provider connection is required before money can move.'}</span>
              </span>
              {bankReady && <Icon name="check" size={16} className="payment-ready-check" />}
            </div>
            <div className="payment-facts">
              <span><small>To</small><strong>{payeeName}</strong></span>
              <span><small>Amount</small><strong>{fmtMoney(totalMinor)}</strong></span>
              <span><small>Timing</small><strong>After final approval</strong></span>
            </div>
            <label className="authorization-check">
              <input type="checkbox" checked={paymentAuthorized} disabled={!bankReady || authorizationSaved} onChange={(event) => setPaymentAuthorized(event.target.checked)} />
              <span>I authorize this payment instruction. The bank transfer remains a separate audited action.</span>
            </label>
          </motion.section>
        )}
        {stage === 'confirm' && (
          <motion.section
            key="document-confirm"
            className="panel document-confirm-card"
            aria-labelledby="document-confirm-heading"
            initial={reducedMotion ? false : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reducedMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
            transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
          >
            <Glass name={isInvoice ? 'invoice' : 'agreement'} size={32} />
            <div className="col grow" style={{ gap: 5 }}>
              <span className="evidence-kicker" id="document-confirm-heading">Ready for final approval</span>
              <strong>{isInvoice ? `${fmtMoney(totalMinor)} to ${payeeName}` : `${signatureName.trim()} · ${number} ${versionLabel}`}</strong>
              <span className="meta">
                {isInvoice
                  ? 'Creates the invoice and payment instruction. The provider executes the transfer separately.'
                  : 'Records your signature authorization. The provider applies and sends the signature separately.'}
              </span>
            </div>
            <Icon name="shield" size={20} className="document-confirm-shield" />
          </motion.section>
        )}
      </AnimatePresence>
      <div className="doc-frame">
        <div className="doc-toolbar">
          <span>{number}.pdf</span>
          <span className="seg" role="group" aria-label="Document view">
            <button type="button" aria-pressed={mode === 'preview'} onClick={() => setMode('preview')}>
              Full document
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
                  <div className="row doc-rule" style={{ gap: 24, padding: '12px 0', fontSize: 11.2, color: '#000' }}>
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
                  <div
                    className="signature-preview signature-field"
                    data-active={stage === 'prepare' ? 'true' : 'false'}
                    ref={signatureRef}
                  >
                    <div className="signature-field-heading">
                      <span className="doc-label">Nous Research signature</span>
                      <span className="signature-state">{authorizationSaved ? 'Authorized' : signatureConsent ? 'Prepared' : 'Unsigned'}</span>
                    </div>
                    {stage === 'prepare' || signatureConsent ? (
                      <>
                        <input
                          className="signature-name-input"
                          aria-label="Full legal name"
                          value={signatureName}
                          maxLength={120}
                          placeholder="Full legal name"
                          disabled={authorizationSaved}
                          onChange={(event) => setSignatureName(event.target.value)}
                        />
                        <span className="signature-render" aria-hidden="true">{signatureName.trim() || 'Sign here'}</span>
                        <label className="signature-consent">
                          <input type="checkbox" checked={signatureConsent} disabled={authorizationSaved} onChange={(event) => setSignatureConsent(event.target.checked)} />
                          <span>I agree to use this as my electronic signature for this document.</span>
                        </label>
                      </>
                    ) : (
                      <span>Review the agreement, then add your signature directly here.</span>
                    )}
                    <span className="signature-provider-note">Provider execution remains separate and audited.</span>
                  </div>
                  <div className="doc-foot" style={{ borderTop: 0 }}>
                    <span>{authorizationSaved ? 'Signature authorized · Provider pending' : signatureConsent ? 'Signature prepared · Not applied or sent' : 'Nothing signed · Nothing sent'}</span>
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
        <div className="app-footer document-authorization-footer" style={{ marginInline: embedded ? 0 : -28 }}>
          <div className="col grow" style={{ gap: 3 }}>
            <span className="f-title">
              {authorizationSaved
                ? isInvoice ? 'Payment authorized' : 'Signature authorized'
                : isInvoice ? 'Authorize this payment instruction' : 'Authorize your signature'}
            </span>
            <span className="f-sub">
              {authorizationError ?? (authorizationSaved
                ? 'Saved to the audit record. The connected provider still completes the external action.'
                : 'This records your intent in Hermes. It does not move money, apply a signature, or send the document.')}
            </span>
          </div>
          {authorizationSaved ? (
            <span className="authorization-saved"><Icon name="check" size={14} /> Saved</span>
          ) : (
            <Button primary disabled={!prepareReady || authorizationBusy} onClick={() => void saveAuthorization()}>
              {authorizationBusy ? 'Saving…' : isInvoice ? 'Save payment authorization' : 'Save signature authorization'}
            </Button>
          )}
          {!embedded && <Button onClick={() => nav(LIB('documents'))}>Open Library</Button>}
        </div>
      ) : stage !== 'confirm' ? (
        <div className="app-footer document-flow-footer" style={{ marginInline: -28 }}>
          <div className="col grow" style={{ gap: 3 }}>
            <span className="f-title">{stage === 'review' ? 'Review the complete document.' : isInvoice ? 'Authorize the payment instruction.' : 'Add your signature in the document.'}</span>
            <span className="f-sub">
              {stage === 'review'
                ? 'Nothing is approved, signed, sent, or paid yet.'
                : isInvoice
                  ? bankReady ? 'This prototype connection records approval; it cannot move funds.' : 'Connect a bank before continuing.'
                  : 'Your signature is prepared here and applied only by the signing provider.'}
            </span>
          </div>
          {stage === 'prepare' && <Button onClick={() => setStage('review')}>Back</Button>}
          <Button primary disabled={stage === 'prepare' && !prepareReady} onClick={advance}>
            {stage === 'review' ? (isInvoice ? 'Review payment' : 'Add signature') : 'Review authorization'}
          </Button>
        </div>
      ) : (
        <DecisionFooter
          request={request}
          title={isInvoice ? `Authorize ${fmtMoney(totalMinor)} payment.` : `Approve and sign ${number}.`}
          detail={isInvoice ? 'Creates the invoice and queues the bank payment. Transfer execution stays separate.' : 'Records your signature authorization and queues the signing provider. Nothing is sent yet.'}
          approveLabel={isInvoice ? 'Authorize payment' : 'Approve & sign'}
          declineLabel="Decline"
          approveNote={approvalNote}
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
  const documentRequest = request.kind === 'invoice' || request.kind === 'agreement';
  const requestHasAuthorization = request.kind === 'invoice'
    ? /^Payment authorization\b/i.test(request.note ?? '')
    : request.kind === 'agreement' && /^Electronic signature authorization\b/i.test(request.note ?? '');
  const [authorizationSaved, setAuthorizationSaved] = useState(requestHasAuthorization);

  const load = (): void => {
    if (!state.workspace.id) return;
    void adapter.rest
      .listEffects(state.workspace.id, request.id)
      .then((page) => setEffects(page.items))
      .catch(() => setEffects([]));
  };
  useEffect(load, [adapter, state.workspace.id, request.id]);

  useEffect(() => {
    if (requestHasAuthorization) setAuthorizationSaved(true);
  }, [requestHasAuthorization]);

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
        {!declined && documentRequest && (
          <section className="receipt-document" aria-labelledby="receipt-document-heading">
            <div className="receipt-document-heading">
              <div className="col" style={{ gap: 3 }}>
                <h2 className="section-title" id="receipt-document-heading">Complete document</h2>
                <span className="meta">Review the source and record the authorization in one place.</span>
              </div>
              <span className="pill">{request.kind === 'invoice' ? 'Payment' : 'Signature'}</span>
            </div>
            <DocumentView request={request} readOnly embedded onAuthorizationChange={setAuthorizationSaved} />
          </section>
        )}
        <h2 className="section-title">{documentRequest && !declined ? 'Provider actions' : 'What this implies'}</h2>
        {reauthed && <p className="meta">Re-authenticated — press Execute again to continue.</p>}
        <div className="col">
          {effects.length === 0 && <div className="meta" style={{ padding: '12px 0' }}>Nothing else is required.</div>}
          {effects.map((effect) => {
            const requiresDocumentAuthorization = effect.kind === 'payment' || effect.kind === 'signature';
            const waitingForAuthorization = requiresDocumentAuthorization && !authorizationSaved;
            return (
              <div className="list-row" key={effect.id} style={{ minHeight: 88 }}>
                <Glass name="context" size={22} className="row-icon" />
                <div className="row-main">
                  <span className="t">{effect.label}</span>
                  <span className="s">
                    {waitingForAuthorization
                      ? 'Waiting for the authorization above'
                      : effect.status === 'unavailable' ? 'Unavailable' : effect.status === 'cancelled' ? 'Cancelled' : `Pending · needs the ${effect.required_role} role`}
                    {effect.reason ? ` · ${effect.reason}` : ''}
                  </span>
                </div>
                {effect.status === 'pending' && (
                  <Button disabled={waitingForAuthorization || busy === effect.id} onClick={() => execute(effect)}>
                    {waitingForAuthorization ? 'Authorize above' : busy === effect.id ? 'Recording…' : 'Execute'}
                  </Button>
                )}
              </div>
            );
          })}
        </div>
        {effects.some((effect) => effect.status === 'unavailable') && (
          <p className="meta" style={{ maxWidth: 760 }}>
            Nothing was sent, paid, granted or signed. There is no integration behind these in the pilot, so the attempt is recorded against your name and the work is still yours to do.
          </p>
        )}
        {notice && <p className="meta" role="alert">{notice}</p>}
        {request.note && !documentRequest && (
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
