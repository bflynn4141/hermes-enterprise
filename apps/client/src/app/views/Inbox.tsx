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
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { CTX, HISTORY, INBOX, LIB, OV, REQ, type AgentFile, type Attachment, type DocumentEntity, type EffectEntity, type PartnerHandoffResult, type Ref, type RequestEntity } from '@hermes/shared';
import { SelectionActions } from '@hermes/motion-components';
import { useAdapter, useAppState, useDispatch, useEntity, useNav } from '../store-context.js';
import { storeStepUp } from '../../model/auth.js';
import { entityData } from '../../model/store.js';
import { Glass, Icon, KIND_ICON } from '../ui/icons.js';
import { Ack, Avatar, Button, Dialog, EmptyState, Panel, Skeleton, Tabs, fmtMoney } from '../ui/primitives.js';
import { EMPTY } from '../../model/constants.js';
import './legacy-documents.css';
import { requestActionLabel } from '../approval-copy.js';
import { agentName, requestStatusLabel } from '../selectors.js';
import { useWorkspaceLists } from './lists.js';
import { useFreshIds } from '../fresh.js';
import { takeInboxHighlight } from '../deep-link.js';
import { InputProvenanceBadge } from '../input-provenance.js';
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
  if (request.kind === 'task') return 'Setup task';
  if (request.kind === 'approval') return approvalTypeLabel(request);
  return 'Signature';
}

function requestPreview(request: RequestEntity): string {
  if (request.decision_summary?.primary) return request.decision_summary.primary;
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
  if (request.kind === 'task') return text(payload.description) ?? 'Continue Partner Program setup';
  const parties = Array.isArray(payload.parties)
    ? payload.parties.map((party) => text(record(party).name)).filter((party): party is string => !!party)
    : [];
  return `${parties.slice(0, 2).join(' ↔ ') || request.subject || 'Agreement'} · ${text(payload.version_label) ?? 'Unsigned'}`;
}

const PRIORITY_ORDER = { urgent: 0, high: 1, normal: 2, low: 3, assessing: 4 } as const;
const REASON_LABELS: Record<string, string> = {
  expires_within_4h: 'Expires soon',
  expires_within_24h: 'Due today',
  sensitive_authorization: 'Sensitive access',
  human_triage_recommended: 'Needs context',
  deadline: 'Deadline',
  impact: 'Material impact',
  blocker: 'Blocking work',
  risk: 'Risk',
  goal: 'Goal relevance',
  routine: 'Routine',
};

function approvalThreshold(request: RequestEntity): string | null {
  if (request.kind === 'task') return null;
  const requirement = request.decision_summary?.approval_requirement;
  if (!requirement) return null;
  if (request.status !== 'pending') return `${requirement.completed_steps}/${requirement.total_steps} steps complete`;
  if (requirement.current.length) return requirement.current.map((step) => `${step.approvals_recorded}/${step.quorum} ${step.label}`).join(' · ');
  return requirement.remaining_approvals === 1 ? '1 approval required' : `${requirement.remaining_approvals} approvals required`;
}

function requestAction(request: RequestEntity): string {
  if (request.status !== 'pending') return requestStatusLabel(request);
  if (request.kind === 'application') return 'Review applicant';
  if (request.kind === 'invoice' || request.kind === 'agreement') return requestActionLabel(request);
  if (request.kind === 'approval') return request.approval?.pending_for_viewer ? approvalActionLabel(request) : approvalReviewerLabel(request);
  if (request.kind === 'task') return 'Work with Iris';
  return 'Review request';
}

const REVIEWER_SEGMENTS: readonly [NonNullable<NonNullable<Ref['filters']>['reviewer']>, string][] = [
  ['for_me', 'For me'],
  ['waiting', 'Waiting on others'],
  ['all', 'All'],
];

const PROVENANCE_LABELS: Record<RequestEntity['provenance']['kind'], string> = {
  operational: 'Operational',
  sample: 'Sample',
  test: 'Test',
  unknown: 'Origin not recorded',
};

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
  const provenance = filters?.provenance ?? 'all';
  const visibility = filters?.visibility ?? 'active';
  const filtered = query.length > 0 || kind !== 'all' || reviewer !== 'for_me' || provenance !== 'all' || visibility !== 'active';
  const selected = lists.requests.find((request) => request.id === selectedId) ?? null;
  // Rows the workspace gained while the Inbox was open slide in; the ones a
  // tab, a filter or the page load produced do not. Tracked on the whole
  // workspace list rather than the filtered one for exactly that reason.
  const fresh = useFreshIds(`${state.workspace.id}:${lists.loading ? 'loading' : 'ready'}`, lists.requests.map((request) => request.id));
  // A receipt or a run's Open link sent us here: rise the selected row's bar
  // once. `takeInboxHighlight` answers once per request, so a re-render or a
  // later ordinary click of the same row does not repeat it.
  const [highlighted, setHighlighted] = useState<string | null>(null);
  useEffect(() => {
    if (!selectedId || !takeInboxHighlight(selectedId)) return;
    setHighlighted(selectedId);
    const timer = window.setTimeout(() => setHighlighted(null), 400);
    return () => window.clearTimeout(timer);
  }, [selectedId]);
  const activeTab = selected
    ? selected.status === 'pending' ? 'needs-review' : 'resolved'
    : tab;
  const sort = filters?.sort ?? (activeTab === 'resolved' ? 'recent' : 'priority');
  const setFilters = (patch: NonNullable<Ref['filters']>): void => {
    nav({ section: 'inbox', view: 'list', filters: { ...filters, ...patch } });
  };

  const list = useMemo(
    () => {
      const visible = lists.requests
        .filter((request) => (activeTab === 'resolved' ? request.status !== 'pending' : request.status === 'pending'))
        .filter((request) => activeTab === 'resolved' || matchesReviewerFilter(request, reviewer))
        .filter((request) => visibility === 'all' || request.presentation.hidden === (visibility === 'hidden'))
        .filter((request) => provenance === 'all' || request.provenance.kind === provenance)
        .filter((request) => kind === 'all' || (kind === 'documents' ? request.kind === 'invoice' || request.kind === 'agreement' : request.kind === kind))
        .filter((request) => `${request.label} ${request.subject ?? ''}`.toLowerCase().includes(query.toLowerCase()));
      return visible.sort((a, b) => sort === 'recent'
        ? Date.parse(b.created_at) - Date.parse(a.created_at)
        : PRIORITY_ORDER[a.triage?.band ?? 'assessing'] - PRIORITY_ORDER[b.triage?.band ?? 'assessing']
          || Number(Boolean(b.approval?.pending_for_viewer)) - Number(Boolean(a.approval?.pending_for_viewer))
          || (b.triage?.score ?? -1) - (a.triage?.score ?? -1)
          || Date.parse(a.created_at) - Date.parse(b.created_at));
    },
    [lists.requests, activeTab, kind, provenance, query, reviewer, sort, visibility],
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
            <span className="inbox-sort" role="group" aria-label="Sort requests">
              <button type="button" aria-pressed={sort === 'priority'} onClick={() => setFilters({ sort: 'priority' })}>Priority</button>
              <button type="button" aria-pressed={sort === 'recent'} onClick={() => setFilters({ sort: 'recent' })}>Recent</button>
            </span>
            <label className="search grow">
              <Icon name="search" />
              <input placeholder="Search requests" value={query} maxLength={200} onChange={(event) => setFilters({ query: event.target.value })} aria-label="Search requests" />
            </label>
            {activeTab === 'needs-review' && (
              <span className="inbox-sort reviewer-filter" role="group" aria-label="Reviewer">
                {REVIEWER_SEGMENTS.map(([value, label]) => {
                  const count = value === 'for_me' ? state.counts.pendingForMe ?? state.counts.inbox : value === 'waiting' ? state.counts.pendingForOthers ?? 0 : 0;
                  return <button type="button" key={value} aria-pressed={reviewer === value} onClick={() => setFilters({ reviewer: value })}>{label}{count > 0 && <span className="seg-count">{count}</span>}</button>;
                })}
              </span>
            )}
            <select className="btn" aria-label="Request type" value={kind} onChange={(event) => setFilters({ kind: event.target.value as NonNullable<Ref['filters']>['kind'] })}>
              <option value="all">All types</option>
              <option value="application">Applications</option>
              <option value="documents">Documents</option>
              <option value="invoice">Invoices</option>
              <option value="agreement">Signatures</option>
              <option value="task">Tasks</option>
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
                    data-highlight={highlighted === request.id || undefined}
                    layout
                    initial={!reducedMotion && fresh.has(request.id) ? { opacity: 0, y: -6 } : false}
                    animate={{ opacity: 1, y: 0 }}
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
                      <span className="inbox-item-signals">
                        <span className={`provenance-chip provenance-${request.provenance.kind}`}>{PROVENANCE_LABELS[request.provenance.kind]}</span>
                        {request.presentation.hidden && <span className="provenance-chip">Hidden from my Inbox</span>}
                        {request.triage?.status === 'complete' ? (
                          <span className={`priority-chip priority-${request.triage.band}`}>{request.triage.band}</span>
                        ) : (!request.triage || request.triage.status === 'pending') && activeTab === 'needs-review' && sort === 'priority' ? (
                          <motion.span className="priority-chip priority-assessing" aria-label="Assessing priority" animate={reducedMotion ? undefined : { opacity: [0.5, 1, 0.5] }} transition={{ duration: 1.5, repeat: Infinity }}>Assessing</motion.span>
                        ) : activeTab === 'needs-review' && sort === 'priority' ? (
                          <span className="priority-chip priority-assessing">Unranked</span>
                        ) : null}
                        {request.triage?.reason_codes.slice(0, 2).map((reason) => <span className="reason-chip" key={reason}>{REASON_LABELS[reason] ?? titleCaseLabel(reason)}</span>)}
                      </span>
                      <span className="inbox-item-meta">
                        <span>{requestType(request)}</span>
                        <span aria-hidden="true">·</span>
                        <span>{requestAction(request)}</span>
                        {approvalThreshold(request) && <><span aria-hidden="true">·</span><span>{approvalThreshold(request)}</span></>}
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
                detail={filtered ? 'Try a different search, reviewer, or request type.' : activeTab === 'resolved' ? 'Completed reviews appear here.' : state.counts.decisions ? `${state.counts.decisions} decisions are in History.` : undefined}
                action={filtered
                  ? <Button onClick={() => setFilters({ query: '', kind: 'all', reviewer: 'for_me', provenance: 'all', visibility: 'active' })}>Clear filters</Button>
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
                {selected && <><span className={`pill provenance-${selected.provenance.kind}`}>{PROVENANCE_LABELS[selected.provenance.kind]}</span><span className="pill">{requestType(selected)}</span><RequestPresentationAction request={selected} /></>}
              </div>
              <RequestDetail id={selectedId} />
            </motion.div>
          )}
        </div>
      )}
    </div>
  );
}

function RequestPresentationAction({ request }: { request: RequestEntity }) {
  const state = useAppState();
  const adapter = useAdapter();
  const dispatch = useDispatch();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const required = request.status === 'pending' && request.kind !== 'task'
    && request.decision_summary?.approval_requirement.pending_for_viewer === true;

  const apply = async (hidden: boolean): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const next = await adapter.rest.patchRequestPresentation(
        state.workspace.id,
        request.id,
        { hidden, ...(hidden ? { reason } : {}) },
      );
      dispatch({ type: 'entity/upsert', kind: 'request', id: next.id, version: next.version, data: next });
      const delta = hidden ? -1 : 1;
      if (request.status === 'pending') {
        dispatch({ type: 'counts/set', patch: {
          inbox: Math.max(0, state.counts.inbox + delta),
          ...(matchesReviewerFilter(request, 'for_me')
            ? { pendingForMe: Math.max(0, (state.counts.pendingForMe ?? state.counts.inbox) + delta) }
            : {}),
          ...(matchesReviewerFilter(request, 'waiting')
            ? { pendingForOthers: Math.max(0, (state.counts.pendingForOthers ?? 0) + delta) }
            : {}),
        } });
      }
      setOpen(false);
      setReason('');
    } catch (caught) {
      const code = (caught as { reason?: string }).reason;
      setError(code === 'required_review_cannot_be_hidden'
        ? 'Decide or route this required review before hiding it.'
        : code === 'hide_reason_required'
          ? 'Add a short reason so this organization choice remains auditable.'
          : 'Could not change this Inbox view. Try again.');
    } finally {
      setBusy(false);
    }
  };

  if (request.presentation.hidden) {
    return <span className="presentation-action"><Button link disabled={busy} onClick={() => void apply(false)}>{busy ? 'Restoring…' : 'Restore'}</Button>{error && <span className="meta" role="alert">{error}</span>}</span>;
  }
  return <>
    <Button link disabled={required || busy} onClick={() => setOpen(true)}>{required ? 'Required review' : 'Hide'}</Button>
    <Dialog open={open} title="Hide from your Inbox?" onClose={() => !busy && setOpen(false)} actions={<>
      <Button disabled={busy} onClick={() => setOpen(false)}>Cancel</Button>
      <Button primary disabled={busy || reason.trim().length < 5} onClick={() => void apply(true)}>{busy ? 'Hiding…' : 'Hide from my Inbox'}</Button>
    </>}>
      <p>Only your Inbox view changes. The request, workflow, audit history and other reviewers stay unchanged.</p>
      <label className="field"><span>Reason</span><textarea rows={3} maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} placeholder="Why are you organizing this for later?" /></label>
      {error && <p className="meta" role="alert">{error}</p>}
    </Dialog>
  </>;
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
  if (request.kind === 'task') return <TaskView request={request} />;
  if (request.status !== 'pending') return <Receipt request={request} />;
  return request.kind === 'application' ? <ApplicationView request={request} /> : <DocumentView request={request} />;
}

function TaskView({ request }: { request: RequestEntity }) {
  const nav = useNav();
  const adapter = useAdapter();
  const payload = record(request.payload);
  const openIris = (): void => {
    const sessionId = text(payload.session_id);
    if (sessionId) void adapter.activateSession(sessionId).catch(() => undefined);
    nav(CTX);
  };
  return <div className="scroll"><div className="app-body">
    <div className="detail-head"><span><Glass name="context" size={38} /></span><div><h1 className="display-32">{request.label}</h1><p className="meta">Partner Program Iris</p></div></div>
    <Panel selected icon="context" title="Define the evidence Iris should look for" subtitle={text(payload.description) ?? 'Add target industries, stages, geographies, signals, exclusions, and source material.'} />
    <div className="app-footer" style={{ marginInline: -28 }}><div className="col grow" style={{ gap: 3 }}><span className="f-title">No search starts from this task</span><span className="f-sub">The separate $0.15 approval in Inbox is the only action that can start the paid search.</span></div><Button onClick={openIris}>{text(payload.action_label) ?? 'Work with Iris'}</Button></div>
  </div></div>;
}

/** Shared decision footer. The only place in the client that calls `decide`. */
function DecisionFooter({ request, title, detail, approveLabel, declineLabel }: { request: RequestEntity; title: string; detail: string; approveLabel: string; declineLabel: string }) {
  const adapter = useAdapter();
  const eligible = request.decision_summary?.approval_requirement.pending_for_viewer === true;
  const financeScoped = request.decision_summary?.approval_requirement.current[0]?.label === 'Finance reviewer';
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

  if (!eligible) {
    return (
      <div className="app-footer" style={{ marginInline: -28 }}>
        <div className="col grow" style={{ gap: 3 }}>
          <span className="f-title">{financeScoped ? 'The assigned Finance reviewer records this decision' : EMPTY.adminOnly}</span>
          <span className="f-sub">You can read the request and its evidence.</span>
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
      if (reason === 'stale_request' || reason === 'review_binding_required') {
        adapter.ensure('request', request.id);
        setError('This draft needs a fresh review. Review the latest version before deciding again.');
      } else {
        setError(reason === 'already_decided' ? 'Already decided' : reason === 'not_admin' ? EMPTY.adminOnly : 'Could not record the decision. Try again.');
      }
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
  const screeningAgent = agentName(state);
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
                <span>{screeningAgent} screened this application</span>
                <span className="meta">{sources.length > 0 ? `${sources.length} sources used` : 'No linked sources'}</span>
              </div>
              {sources.length > 0 && (
                <span className="source-stack" aria-label={`${sources.length} sources used by ${screeningAgent}`}>
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
        <p className="meta">{isDemo ? 'Illustrative source for this local demo.' : 'Source cited by Iris. Check it against the original before you decide.'}</p>
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
/** Amounts retain the invoice currency at every decision and document surface. */
function documentMoney(minor: number | null, currency: string | null): string {
  if (minor === null) return 'Not supplied';
  if (!currency || !/^[A-Z]{3}$/.test(currency)) return `${(minor / 100).toLocaleString('en-US', { minimumFractionDigits: 2 })} · Currency not supplied`;
  try {
    return new Intl.NumberFormat('en-US', { style: 'currency', currency, currencyDisplay: 'code', minimumFractionDigits: 2 }).format(minor / 100);
  } catch {
    return `${currency} ${(minor / 100).toFixed(2)}`;
  }
}

const documentSourceIds = (value: unknown): string[] => Array.isArray(value)
  ? value.filter((id): id is string => typeof id === 'string' && id.length > 0)
  : [];

// A draft cites sources by id. Show the person the thing, not the id: a saved
// Library document links to itself, an agent source links to Context, an
// upload shows its file name. Anything the cache cannot resolve is reported
// once, because a list of opaque uuids tells a reviewer nothing.
function DocumentSources({ ids }: { ids: readonly string[] }) {
  const state = useAppState();
  const nav = useNav();
  const resolved = ids.flatMap((id): { id: string; label: string; ref: Ref | null }[] => {
    const doc = entityData<DocumentEntity>(state, 'document', id);
    if (doc) return [{ id, label: doc.title, ref: LIB('documents', doc.id) }];
    const file = entityData<AgentFile>(state, 'agent_file', id);
    if (file) return [{ id, label: file.name, ref: CTX }];
    const attachment = entityData<Attachment>(state, 'attachment', id);
    return attachment ? [{ id, label: attachment.name, ref: null }] : [];
  });
  return (
    <ul className="legacy-source-list">
      {resolved.map(({ id, label, ref }) => <li key={id}>{ref ? <Button link onClick={() => nav(ref)}>{label}</Button> : <span>{label}</span>}</li>)}
      {resolved.length < ids.length && <li className="meta">Source no longer available</li>}
    </ul>
  );
}

const sourceCount = (count: number): string => `${count} source${count === 1 ? '' : 's'}`;

function PartnerResultEvidence({ handoffId, fallback }: { handoffId: string; fallback: ReactNode }) {
  const adapter = useAdapter();
  const state = useAppState();
  const [result, setResult] = useState<PartnerHandoffResult | null>(null);
  const [failed, setFailed] = useState(false);
  const load = (): void => {
    setFailed(false);
    void adapter.rest.partnerHandoffResult(state.workspace.id, handoffId)
      .then(setResult)
      .catch(() => setFailed(true));
  };
  useEffect(load, [adapter.rest, state.workspace.id, handoffId]);

  if (failed) return <><div className="partner-evidence-unavailable"><p>Authorized workflow evidence is unavailable for this account or changed after review.</p><Button small onClick={load}>Try again</Button></div>{fallback}</>;
  if (!result) return fallback || <Skeleton rows={3} label="Loading authorized workflow evidence" />;
  const explanation = result.outcome.agent_explanation === 'completed'
    ? 'Finance agent explanation ready'
    : result.outcome.agent_explanation === 'failed' || result.outcome.agent_explanation === 'stopped'
      ? 'Agent explanation unavailable'
      : result.outcome.agent_explanation === 'running' ? 'Finance agent is reviewing' : 'Finance agent review queued';
  return (
    <div className="partner-result-evidence">
      <p className="partner-provenance-summary"><InputProvenanceBadge value={result.input_provenance} /><span>{result.input_provenance === 'sample' ? 'Use this decision for demonstration only.' : result.input_provenance === 'customer' ? 'This review uses customer-provided input.' : 'Historical provenance is unavailable; this is not labeled as customer data.'}</span></p>
      <details className="legacy-disclosure">
        <summary>Authorized workflow evidence ({result.checks.length} checks)</summary>
        <p className="meta">{explanation} · Human decision {result.outcome.human_decision.replaceAll('_', ' ')}</p>
        <ul className="partner-result-checks">
          {result.checks.map((check) => <li key={check.code} data-state={check.status}><strong>{check.code.replaceAll('_', ' ')}</strong><span>{check.message}</span></li>)}
        </ul>
        <div className="partner-evidence-grid">
          {([
            ['Authorized engagement source', result.source_versions.engagement],
            ['Confirmed invoice source', result.source_versions.invoice],
          ] as const).map(([label, source]) => (
            <section key={label}>
              <span className="partner-card-kicker">{label}</span>
              <h4>{source.name}</h4>
              <p className="meta">{source.author_name ? `${source.author_name} · ` : ''}<time dateTime={source.created_at}>{new Date(source.created_at).toLocaleString()}</time></p>
              <blockquote>{source.excerpt}</blockquote>
            </section>
          ))}
        </div>
      </details>
    </div>
  );
}

function documentReviewerSummary(request: RequestEntity, financeScoped: boolean, resolved: boolean): string {
  const requirement = request.decision_summary?.approval_requirement;
  if (resolved) {
    const completed = requirement?.completed_steps ?? 1;
    const total = requirement?.total_steps ?? 1;
    return financeScoped
      ? `${completed} of ${total} Finance review${total === 1 ? '' : ' steps'}`
      : `${completed} of ${total} Admin approval${total === 1 ? '' : ' steps'}`;
  }
  const current = requirement?.current[0];
  if (current) {
    const label = current.label === 'Finance reviewer'
      ? `Finance review${current.quorum === 1 ? '' : 's'}`
      : current.label === 'Workspace Admin'
        ? `Admin approval${current.quorum === 1 ? '' : 's'}`
        : current.label;
    return `${current.approvals_recorded} of ${current.quorum} ${label}`;
  }
  const remaining = requirement?.remaining_approvals ?? 1;
  return financeScoped
    ? `0 of ${remaining} Finance review${remaining === 1 ? '' : 's'}`
    : `0 of ${remaining} Admin approval${remaining === 1 ? '' : 's'}`;
}

export function DocumentView({
  request,
  document: doc,
  readOnly,
  embedded,
  effects = [],
}: {
  request: RequestEntity;
  document?: DocumentEntity | null;
  readOnly?: boolean;
  embedded?: boolean;
  effects?: EffectEntity[];
}) {
  const adapter = useAdapter();
  const state = useAppState();
  const nav = useNav();
  const eligible = request.decision_summary?.approval_requirement.pending_for_viewer === true;
  const [mode, setMode] = useState<'preview' | 'render' | 'pdf'>('preview');
  const [line, setLine] = useState<string | null>(null);
  const [ack, setAck] = useState(false);
  // Library can show an older saved version. Always review the supplied document,
  // rather than silently replacing its content with the request's latest payload.
  const payload = record(doc?.payload ?? request.payload);
  const isInvoice = request.kind === 'invoice';
  const number = text(payload.number) ?? request.label;
  const currency = text(payload.currency);
  const payer = record(payload.payer);
  const payee = record(payload.payee);
  const parties = Array.isArray(payload.parties) ? payload.parties.map(record) : [];
  const payeeName = text(payee.name) ?? request.subject ?? 'Not supplied';
  const payerName = text(payer.name) ?? 'Not supplied';
  const issueDate = text(payload.issue_date) ?? text(payload.issued);
  const dueDate = text(payload.due_date) ?? text(payload.due);
  const workPeriod = record(payload.work_period);
  const effectiveDates = record(payload.effective_dates);
  const versionLabel = text(payload.version_label) ?? (doc ? `v${doc.version}` : 'Version not supplied');
  const totalMinor = typeof payload.total_minor === 'number' ? payload.total_minor : null;
  const amount = documentMoney(totalMinor, currency);
  const lines = Array.isArray(payload.lines)
    ? payload.lines.flatMap((item) => {
        const row = record(item);
        const id = text(row.id);
        const label = text(row.label);
        if (!id || !label || typeof row.qty !== 'number' || typeof row.amount_minor !== 'number') return [];
        return [{ id, label, qty: row.qty, amount_minor: row.amount_minor, date: text(row.date), sourceIds: documentSourceIds(row.source_ids) }];
      })
    : [];
  const sections = Array.isArray(payload.sections)
    ? payload.sections.flatMap((item, index) => {
        if (Array.isArray(item) && typeof item[0] === 'string' && typeof item[1] === 'string') {
          return [{ id: `section-${index}`, heading: item[0], body: item[1], sourceIds: [] as string[] }];
        }
        const section = record(item);
        const heading = text(section.heading);
        const body = text(section.body);
        return heading && body ? [{ id: text(section.id) ?? `section-${index}`, heading, body, sourceIds: documentSourceIds(section.source_ids) }] : [];
      })
    : [];
  const sourceIds = [...new Set([...lines.flatMap((item) => item.sourceIds), ...sections.flatMap((item) => item.sourceIds)])];
  const workflowProvenance = record(payload.workflow_provenance);
  const handoffId = text(workflowProvenance.handoff_id);
  const financeScoped = request.decision_summary?.approval_requirement.current.some((step) => step.label === 'Finance reviewer') === true
    || Object.keys(workflowProvenance).length > 0;
  const sharedPartner = record(workflowProvenance.shared_partner);
  const workflowSessions = Array.isArray(workflowProvenance.source_sessions)
    ? workflowProvenance.source_sessions.flatMap((item) => {
        const source = record(item);
        const role = source.role === 'partnerships' || source.role === 'finance' ? source.role : null;
        const sessionId = text(source.session_id);
        const excerpt = text(source.excerpt);
        const agentName = text(source.agent_name);
        return role && sessionId && excerpt && agentName ? [{ role, sessionId, excerpt, agentName, simulated: source.simulated === true }] : [];
      })
    : [];
  const selected = lines.find((row) => row.id === line) ?? null;
  const scope = sections.find((section) => /scope|purpose|services/i.test(section.heading)) ?? sections[0];
  const saved = Boolean(doc) || request.status === 'created' || request.status === 'drafted';
  const declined = request.status === 'declined';
  const resolved = request.status !== 'pending';
  const readonly = Boolean(readOnly || resolved);
  const status = declined ? 'Declined' : saved ? isInvoice ? 'Saved in Library' : 'Saved unsigned' : request.status === 'withdrawn' ? 'Withdrawn' : 'Draft awaiting approval';
  const consequence = isInvoice ? 'Saves the invoice in Library. No payment or email is sent.' : 'Saves an unsigned agreement in Library. Nothing is signed or sent.';
  const decisionLabel = requestActionLabel(request);
  const reviewerSummary = documentReviewerSummary(request, financeScoped, resolved);
  const legacyWorkflowEvidence = workflowSessions.length === 0 ? <p className="meta">No source messages linked.</p> : (
    <details className="legacy-disclosure">
      <summary>Workflow evidence ({workflowSessions.length} sources)</summary>
      {text(sharedPartner.name) && <p className="meta">
        {text(sharedPartner.name)} · Engagement {text(sharedPartner.engagement_reference) ?? 'reference not supplied'}
      </p>}
      <ul>
        {workflowSessions.map((source) => (
          <li key={`${source.role}:${source.sessionId}`}>
            <strong>{source.role === 'partnerships' ? 'Partnerships' : 'Finance'} · {source.agentName}</strong>
            {source.simulated && <span className="pill illustrative">Simulated</span>}
            <p>{source.excerpt}</p>
            {source.role === 'finance'
              ? <a href={`/workspace/${state.workspace.id}/s/${source.sessionId}`}>Open Finance review session</a>
              : <span className="meta">Shared excerpt only · Full Partnerships session remains private.</span>}
          </li>
        ))}
      </ul>
    </details>
  );

  return (
    <div className={`legacy-document-view${embedded ? ' embedded-document-view' : ''}`}>
      <div className="legacy-document-scroll">
        <section className="legacy-decision" aria-labelledby={`document-decision-${request.id}`}>
          <h1 id={`document-decision-${request.id}`}>{readonly ? status : 'Your decision'}</h1>
          <h2>{isInvoice ? `Invoice from ${payeeName}` : `Agreement ${number}`}</h2>
          <span className="meta">{isInvoice ? number : versionLabel}</span>
          <dl className="legacy-document-facts">
            {isInvoice ? <>
              <div><dt>Amount</dt><dd>{amount}</dd></div>
              <div><dt>Bill to</dt><dd>{payerName}</dd></div>
              <div><dt>Issued</dt><dd>{issueDate ?? 'Not supplied'}</dd></div>
              <div><dt>Due</dt><dd>{dueDate ?? 'Not supplied'}</dd></div>
              {(text(workPeriod.from) || text(workPeriod.to)) && <div><dt>Work period</dt><dd>{text(workPeriod.from) ?? 'Not supplied'} – {text(workPeriod.to) ?? 'Not supplied'}</dd></div>}
            </> : <>
              <div className="legacy-fact-wide"><dt>Parties</dt><dd>{parties.length ? parties.map((party, index) => <span key={index}>{text(party.name) ?? 'Name not supplied'}</span>) : 'Not supplied'}</dd></div>
              {(text(effectiveDates.from) || text(effectiveDates.to)) && <div><dt>Effective dates</dt><dd>{text(effectiveDates.from) ?? 'Not supplied'} – {text(effectiveDates.to) ?? 'Not supplied'}</dd></div>}
              {totalMinor !== null && <div><dt>Amount</dt><dd>{amount}</dd></div>}
            </>}
          </dl>
          {!resolved && <p className="legacy-reviewer"><span>{reviewerSummary}</span><span>{eligible && !readOnly ? 'You can approve' : eligible ? 'Approve from Inbox' : financeScoped ? 'Finance reviewer required' : 'Admin required'}</span></p>}
          {resolved && <p className="legacy-reviewer"><span>{saved ? reviewerSummary : declined ? 'Draft declined' : 'No approval recorded'}</span>{request.decided_by_name && <span>{request.decided_by_name}</span>}</p>}
        </section>

        <section className="legacy-context" aria-labelledby={`document-purpose-${request.id}`}>
          <h2 id={`document-purpose-${request.id}`}>What is this for?</h2>
          {isInvoice ? lines.length ? <ul>{lines.slice(0, 3).map((item) => <li key={item.id}><span>{item.label}</span><span className="meta">{item.qty} × {documentMoney(item.amount_minor, currency)}{item.date ? ` · ${item.date}` : ''}</span></li>)}</ul> : <p>No service details supplied.</p> : scope ? <p className="legacy-excerpt">{scope.body}</p> : <p>No scope supplied.</p>}
          {isInvoice && lines.length > 3 && <p className="meta">{lines.length - 3} more line items in the full document below.</p>}
          {isInvoice && text(payload.notes) && <p className="legacy-excerpt">{text(payload.notes)}</p>}
        </section>

        <section className="legacy-context" aria-labelledby={`document-sources-${request.id}`}>
          <h2 id={`document-sources-${request.id}`}>Related messages &amp; documents</h2>
          {handoffId ? <PartnerResultEvidence handoffId={handoffId} fallback={legacyWorkflowEvidence} /> : legacyWorkflowEvidence}
          {sourceIds.length > 0 && <details className="legacy-disclosure">
            <summary>{sourceCount(sourceIds.length)} cited by this draft</summary>
            <DocumentSources ids={sourceIds} />
          </details>}
          {request.sources.length > 0 && <details className="legacy-disclosure">
            <summary>Stored citations ({request.sources.length})</summary>
            <p className="meta">Citations supplied with this draft.</p>
            <ul>{request.sources.map((source) => <li key={source.id}><strong>{source.name}</strong>{source.note && <p>{source.note}</p>}</li>)}</ul>
          </details>}
          {request.missing.length > 0 && <ul className="legacy-missing">{request.missing.map((item) => <li key={item}>{item}</li>)}</ul>}
        </section>

        <details className="legacy-disclosure legacy-full-document" open>
          <summary>Full document</summary>
          <div className="doc-frame">
            <div className="doc-toolbar">
              <span>{number}{!isInvoice ? ` · ${versionLabel}` : ''}</span>
              {doc && <span className="seg" role="group" aria-label="Document view">
                <button type="button" aria-pressed={mode === 'preview'} onClick={() => setMode('preview')}>Preview</button>
                <button type="button" aria-pressed={mode === 'render'} onClick={() => setMode('render')}>HTML render</button>
                <button type="button" aria-pressed={mode === 'pdf'} onClick={() => setMode('pdf')}>PDF</button>
              </span>}
            </div>
            {mode === 'render' && doc ? <iframe className="pdf-embed" sandbox="" src={`/w/${state.workspace.id}/documents/${doc.id}/render`} title={`${doc.title} · saved render`} />
              : mode === 'pdf' && doc ? doc.pdf_status === 'ready' && doc.pdf_url ? <iframe className="pdf-embed" src={`${doc.pdf_url}#toolbar=0&navpanes=0&view=FitH`} title={`${number}.pdf`} />
                : <EmptyState icon="invoice" title={doc.pdf_status === 'failed' ? 'PDF could not be prepared' : doc.pdf_status === 'none' ? 'PDF unavailable' : 'PDF is being prepared'} detail={doc.pdf_error ?? 'The document preview is available.'} action={<Button onClick={() => setMode('preview')}>View preview</Button>} />
              : <div className="doc-page">
                <div className="legacy-document-heading"><h3>{isInvoice ? 'Invoice' : 'Agreement'}</h3><span>{number} · {isInvoice ? 'Review copy' : `${versionLabel} · Unsigned`}</span></div>
                <div className="doc-parties">
                  {isInvoice ? <>
                    <div className="col"><span className="doc-label">From</span><strong>{payeeName}</strong>{text(payee.email) && <span>{text(payee.email)}</span>}{text(payee.address) && <span>{text(payee.address)}</span>}</div>
                    <div className="col"><span className="doc-label">Bill to</span><strong>{payerName}</strong>{text(payer.email) && <span>{text(payer.email)}</span>}{text(payer.address) && <span>{text(payer.address)}</span>}</div>
                  </> : parties.map((party, index) => <div className="col" key={index}><span className="doc-label">Party {index + 1}</span><strong>{text(party.name) ?? 'Not supplied'}</strong>{text(party.email) && <span>{text(party.email)}</span>}{text(party.address) && <span>{text(party.address)}</span>}</div>)}
                </div>
                {isInvoice ? <>
                  <p>Issued · {issueDate ?? 'Not supplied'}<br />Due · {dueDate ?? 'Not supplied'}</p>
                  <div className="legacy-invoice-lines">
                    <div className="legacy-line-head"><span>Description</span><span>Qty</span><span>Line total</span></div>
                    {lines.map((item) => <button type="button" key={item.id} className="legacy-invoice-line" aria-pressed={line === item.id} onClick={() => setLine(line === item.id ? null : item.id)}><span>{item.label}{item.date && <small>{item.date}</small>}</span><span>{item.qty}</span><span>{documentMoney(item.qty * item.amount_minor, currency)}</span></button>)}
                  </div>
                  <div className="doc-total"><span className="k">Total</span><span className="v">{amount}</span></div>
                  {text(payload.notes) && <p>{text(payload.notes)}</p>}
                </> : <>
                  {(text(effectiveDates.from) || text(effectiveDates.to)) && <p>Effective · {text(effectiveDates.from) ?? 'Not supplied'} – {text(effectiveDates.to) ?? 'Not supplied'}</p>}
                  {totalMinor !== null && <p>Amount · {amount}</p>}
                  {sections.map((section) => <section className="legacy-agreement-section" key={section.id}><h4>{section.heading}</h4><p>{section.body}</p>{section.sourceIds.length > 0 && <details className="legacy-section-sources"><summary>{sourceCount(section.sourceIds.length)}</summary><DocumentSources ids={section.sourceIds} /></details>}</section>)}
                </>}
                <div className="doc-foot"><span>{isInvoice ? 'Not sent · No money moved' : 'Unsigned · Not sent'}</span><span>{number}</span></div>
              </div>}
          </div>
        </details>
        {selected && <div className="hermes-ui selection-host">
          <SelectionActions
            text={{ lead: `Selected line on ${number}:`, original: `${selected.label} · ${selected.qty} × ${documentMoney(selected.amount_minor, currency)}`, rewrite: `About ${selected.label} on ${number}: ` }}
            labels={{ keep: 'Add to the composer', discard: 'Clear', placeholder: 'Ask about this line' }}
            explanation={`${selected.label}: ${selected.qty} × ${documentMoney(selected.amount_minor, currency)}${selected.date ? `, dated ${selected.date}` : ''}. Read from the document payload.`}
            actions={{ primary: [{ id: 'Ask', icon: <Icon name="search" size={14} />, action: 'Ask', busyLabel: 'Composing' }], more: [] }}
            onRequestEdit={async () => `About ${selected.label} on ${number}: `}
            onKeep={(value) => { if (state.activeSessionId) { adapter.applyCommand(state.activeSessionId, { type: 'chat/prompt', text: value }); setAck(true); } }}
            onDiscard={() => { setLine(null); setAck(false); }}
          />
          {selected.sourceIds.length > 0 && <><p className="meta">{sourceCount(selected.sourceIds.length)} for this line</p><DocumentSources ids={selected.sourceIds} /></>}
          <Ack show={ack}>Added to the composer</Ack>
        </div>}
        {request.note && <details className="legacy-disclosure"><summary>Review note</summary><p className="legacy-excerpt">{request.note}</p><p className="meta">Internal note. This does not record a payment or an applied signature.</p></details>}
        <details className="legacy-disclosure">
          <summary>History</summary>
          <dl className="legacy-document-facts"><div><dt>Requested</dt><dd><time dateTime={request.created_at}>{new Date(request.created_at).toLocaleString()}</time></dd></div>
            {request.decided_at && <div><dt>{declined ? 'Declined' : 'Approved'}</dt><dd>{request.decided_by_name ?? 'Admin'} · <time dateTime={request.decided_at}>{new Date(request.decided_at).toLocaleString()}</time></dd></div>}
          </dl>
          <Button link onClick={() => nav(HISTORY())}>Open workspace History</Button>
        </details>
        {readonly && saved && !declined && <details className="legacy-disclosure"><summary>Downstream actions unavailable</summary><p className="meta">{isInvoice ? 'Payment and email execution are unavailable. No money was moved or email sent.' : 'Signing and email execution are unavailable. No signature was applied or email sent.'}</p>{effects.length > 0 && <ul>{effects.map((effect) => <li key={effect.id}><span>{effect.label}</span><span className="meta">{effect.status === 'cancelled' ? 'Cancelled' : 'Not executed'}</span></li>)}</ul>}</details>}
      </div>
      {readonly ? <div className="app-footer legacy-document-footer"><div className="col grow"><span className="f-title">{status}</span><span className="f-sub">{resolved && !saved ? 'No document was approved, signed, paid or sent.' : saved ? isInvoice ? 'Invoice saved. No payment or email is sent.' : 'Agreement saved unsigned. Nothing is signed or sent.' : consequence}</span></div><Button onClick={() => nav(LIB('documents'))}>Open Library</Button></div>
        : <DecisionFooter request={request} title={decisionLabel} detail={consequence} approveLabel={decisionLabel} declineLabel="Decline" />}
    </div>
  );
}

/** Honesty copy shown whenever a legacy effect is pending or already unavailable. */
export const LEGACY_EFFECT_HONESTY =
  'Legacy effects have no executor here. Recording an attempt does not send mail, move money, grant access, or apply a signature. Approved email delivery uses a separate governed outbox when configured; this record is not a delivery receipt.';

/** Status line for a legacy ledger effect — never implies an external action completed. */
export function legacyEffectStatusLabel(effect: EffectEntity): string {
  const base =
    effect.status === 'unavailable'
      ? 'Unavailable · nothing sent, paid, granted or signed'
      : effect.status === 'cancelled'
        ? 'Cancelled'
        : `Pending · no executor · needs the ${effect.required_role} role`;
  return effect.reason ? `${base} · ${effect.reason}` : base;
}

/**
 * Presentational list for legacy effects on a receipt. Kept separate from data
 * loading so tests can assert honesty without waiting on effects.
 */
export function LegacyEffectsPanel({
  effects,
  busy = null,
  reauthed = false,
  notice = null,
  onRecordAttempt,
}: {
  effects: readonly EffectEntity[];
  busy?: string | null;
  reauthed?: boolean;
  notice?: string | null;
  onRecordAttempt?: (effect: EffectEntity) => void;
}) {
  const showsHonesty = effects.some((effect) => effect.status === 'pending' || effect.status === 'unavailable');
  return (
    <>
      {reauthed && <p className="meta">Re-authenticated — press Record attempt again to continue.</p>}
      {showsHonesty && (
        <p className="meta" style={{ maxWidth: 760 }} data-testid="legacy-effect-honesty">
          {LEGACY_EFFECT_HONESTY}
        </p>
      )}
      <div className="col">
        {effects.length === 0 && <div className="meta" style={{ padding: '12px 0' }}>Nothing else is required.</div>}
        {effects.map((effect) => (
          <div className="list-row" key={effect.id} style={{ minHeight: 88 }}>
            <Glass name="context" size={22} className="row-icon" />
            <div className="row-main">
              <span className="t">{effect.label}</span>
              <span className="s">{legacyEffectStatusLabel(effect)}</span>
            </div>
            {effect.status === 'pending' && (
              <Button disabled={busy === effect.id} onClick={() => onRecordAttempt?.(effect)}>
                {busy === effect.id ? 'Recording…' : 'Record attempt'}
              </Button>
            )}
          </div>
        ))}
      </div>
      {notice && <p className="meta" role="alert">{notice}</p>}
    </>
  );
}

/**
 * The receipt: what was decided, and what is still pending as an effect.
 *
 * Legacy ledger effects do not execute. Approved communications can use a
 * separate governed outbox when configured, but "Record attempt" here only
 * records an unavailable attempt and says in the server's own words what
 * remains undone. The copy is the server's `reason` string because that
 * sentence is relied on and should have one author.
 *
 * Recording an attempt needs the reviewer role the effect names, and step-up.
 * A second press finds the row already `unavailable` and is answered with it
 * rather than appending a second audit row.
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

  const recordAttempt = (effect: EffectEntity): void => {
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
            ? `Recording this attempt needs the ${effect.required_role} role.`
            : error.reason === 'effect_cancelled'
              ? 'A later version of this document cancelled that effect.'
              : 'Could not record that attempt. Try again.',
        );
      })
      .finally(() => setBusy(null));
  };

  if (documentRequest) return <DocumentView request={request} readOnly effects={effects} />;

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
        <LegacyEffectsPanel
          effects={effects}
          busy={busy}
          reauthed={reauthed}
          notice={notice}
          onRecordAttempt={recordAttempt}
        />
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
