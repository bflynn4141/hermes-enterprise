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
import { HISTORY, INBOX, LIB, OV, REQ, type DocumentEntity, type EffectEntity, type RequestEntity } from '@hermes/shared';
import { useAdapter, useAppState, useDispatch, useEntity, useIsAdmin, useNav } from '../store-context.js';
import { Glass, Icon, KIND_ICON } from '../ui/icons.js';
import { Ack, Avatar, Button, Dialog, EmptyState, Panel, Skeleton, Tabs, fmtMoney } from '../ui/primitives.js';
import { EMPTY } from '../../model/constants.js';
import { requestStatusLabel } from '../selectors.js';
import { useWorkspaceLists } from './lists.js';

export function InboxList() {
  const state = useAppState();
  const dispatch = useDispatch();
  const nav = useNav();
  const lists = useWorkspaceLists();
  const tab = state.ui.inboxTab;
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState('all');

  const list = useMemo(
    () =>
      lists.requests
        .filter((request) => (tab === 'resolved' ? request.status !== 'pending' : request.status === 'pending'))
        .filter((request) => kind === 'all' || (kind === 'applications' ? request.kind === 'application' : request.kind !== 'application'))
        .filter((request) => `${request.label} ${request.subject ?? ''}`.toLowerCase().includes(query.toLowerCase())),
    [lists.requests, tab, kind, query],
  );

  return (
    <div className="scroll">
      <div className="app-body">
        <div className="row" style={{ height: 42 }}>
          <h1 className="display-32">Inbox</h1>
        </div>
        <Tabs
          tabs={[
            { id: 'needs-review', label: 'Needs review' },
            { id: 'resolved', label: 'Resolved' },
            { id: 'rules', label: 'Rules' },
          ]}
          value={tab}
          onChange={(value) => dispatch({ type: 'nav/tab', key: 'inboxTab', value })}
          label="Inbox views"
        />
        {tab === 'rules' ? (
          <>
            <Panel icon="admission" title="Manual review" subtitle="These requests always need a human decision. Automation follows approved rules; it cannot bypass them." />
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
          </>
        ) : (
          <>
            <div className="row" style={{ gap: 16 }}>
              <label className="search grow">
                <Icon name="search" />
                <input placeholder="Search requests" value={query} onChange={(event) => setQuery(event.target.value)} aria-label="Search requests" />
              </label>
              <select className="btn" aria-label="Request type" value={kind} onChange={(event) => setKind(event.target.value)} style={{ background: 'var(--app)', appearance: 'none' }}>
                <option value="all">All types</option>
                <option value="applications">Applications</option>
                <option value="documents">Documents</option>
              </select>
            </div>
            <div className="col" role="list" aria-label={tab === 'resolved' ? 'Resolved requests' : 'Requests needing review'}>
              <AnimatePresence initial={false}>
                {list.map((request) => (
                  <motion.div key={request.id} role="listitem" layout initial={false} exit={{ opacity: 0, height: 0, overflow: 'hidden', transition: { duration: 0.18 } }} transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}>
                    <div className="list-row">
                      <Glass name={KIND_ICON[request.kind] ?? 'context'} size={32} className="row-icon" />
                      <div className="row-id">
                        <span className="t">{request.subject ?? request.label}</span>
                        <span className="s">{request.kind === 'application' ? 'Application' : request.label}</span>
                      </div>
                      <div className="row-main">
                        <span className="t">{request.kind === 'application' ? 'Program admission' : request.kind === 'invoice' ? 'Create invoice' : 'Create agreement'}</span>
                        <span className="s">{requestStatusLabel(request)}</span>
                      </div>
                      <Button link={request.status !== 'pending'} onClick={() => nav(REQ(request.id))}>
                        {request.status === 'pending' ? 'Review →' : 'Open →'}
                      </Button>
                    </div>
                  </motion.div>
                ))}
              </AnimatePresence>
              {list.length === 0 && !lists.loading && (
                <EmptyState
                  icon={tab === 'resolved' ? 'trace' : 'admission'}
                  title={tab === 'resolved' ? EMPTY.inboxResolved : EMPTY.inbox}
                  detail={tab === 'resolved' ? 'Completed reviews appear here.' : `${state.counts.decisions} decisions are in History.`}
                  action={<Button onClick={() => nav(tab === 'resolved' ? INBOX : HISTORY())}>{tab === 'resolved' ? 'Needs review' : 'View History'}</Button>}
                />
              )}
              {list.length === 0 && lists.loading && <Skeleton rows={3} label="Loading requests" />}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function RequestReview({ id }: { id: string | null }) {
  const record = useEntity<RequestEntity>('request', id);
  if (record.state === 'loading') {
    return (
      <div className="scroll">
        <div className="app-body">
          <Skeleton rows={5} label="Loading the request" />
        </div>
      </div>
    );
  }
  if (record.state === 'missing' || !record.data) {
    return (
      <div className="scroll">
        <div className="app-body">
          <EmptyState icon="admission" title={EMPTY.requestMissing} detail="It may have been redacted, or it belongs to another workspace." />
        </div>
      </div>
    );
  }
  const request = record.data;
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
  const payload = request.payload as { score?: number; role?: string; breakdown?: [string, number, number][]; benefits?: string[] };
  const [source, setSource] = useState<{ name: string; note: string } | null>(null);
  const [report, setReport] = useState(false);

  return (
    <>
      <div className="app-pane-body" style={{ paddingBottom: 0, gap: 18, minHeight: 0 }}>
        <div className="scroll">
          <div className="col" style={{ gap: 18, paddingBottom: 18 }}>
            <div className="row" style={{ gap: 14 }}>
              <Glass name="admission" size={40} />
              <div className="col grow" style={{ gap: 3 }}>
                <h1 className="display-32">{request.subject ?? request.label}</h1>
                <span className="meta">{request.title}</span>
              </div>
              <Avatar person={{ name: state.user.name }} />
              <span className="meta">{state.user.name} · Reviewer</span>
            </div>
            <div className="panel score-panel">
              <div className="col" style={{ gap: 3 }}>
                <span className="score">{payload.score ?? 0} / 100</span>
                <span className="meta">Proposed rubric</span>
              </div>
              <span className="grow" />
              <div className="col" style={{ alignItems: 'flex-end', gap: 4 }}>
                <span>{payload.role}</span>
                <span className="meta">Awaiting review</span>
              </div>
            </div>
            {payload.breakdown && (
              <div className="stat-grid">
                {payload.breakdown.map(([label, got, total]) => (
                  <div className="stat" key={label}>
                    <span className="k">{label}</span>
                    <span className="v">
                      {got} / {total}
                    </span>
                  </div>
                ))}
              </div>
            )}
            <div className="row">
              <h2 className="section-title">Claims & sources</h2>
              <span className="grow" />
              <Button link onClick={() => setReport(true)}>
                Full report →
              </Button>
            </div>
            <div className="col">
              {request.sources.map((item) => (
                <div className="list-row compact" key={item.id}>
                  <Glass name="context" size={22} className="row-icon" />
                  <div className="row-main">
                    <span className="t">{item.name}</span>
                    <span className="s">{item.note}</span>
                  </div>
                  <Button link onClick={() => setSource(item)}>
                    Open →
                  </Button>
                </div>
              ))}
            </div>
            {request.missing.length > 0 && (
              <div className="panel missing-panel plain" style={{ backgroundImage: 'var(--panel)' }}>
                <div className="col" style={{ gap: 6 }}>
                  <span className="k">Missing evidence</span>
                  <span className="v">{request.missing.join(' · ')}</span>
                </div>
              </div>
            )}
            {payload.benefits && (
              <div className="col" style={{ gap: 6 }}>
                <span>{payload.role}</span>
                <span className="meta">{payload.benefits.join(' · ')}</span>
              </div>
            )}
            {request.note && (
              <div className="note-block">
                <span className="k">Review note · Saved · Not sent</span>
                <span className="t">{request.note}</span>
              </div>
            )}
          </div>
        </div>
        <DecisionFooter request={request} title="Admit this role; queue access." detail="Active after grants are confirmed. No message sent." approveLabel="Admit" declineLabel="Decline" />
      </div>
      <Dialog open={report} title="Claims and evidence" onClose={() => setReport(false)} actions={<Button onClick={() => setReport(false)}>Back to review</Button>}>
        <p className="meta">Proposed rubric · Applicant-provided sources. Customer outcomes are not independently verified.</p>
        {(payload.breakdown ?? []).map(([label, got, total]) => (
          <div key={label} className="col" style={{ gap: 4, padding: '10px 0', borderBottom: '1px solid var(--line)' }}>
            <span>{label}</span>
            <span className="meta">
              {got} of {total}
            </span>
          </div>
        ))}
      </Dialog>
      <Dialog open={!!source} title={source?.name ?? ''} onClose={() => setSource(null)} actions={<Button onClick={() => setSource(null)}>Close</Button>}>
        <p>{source?.note}</p>
        <p className="meta">Applicant-supplied source. External links are not opened by the client.</p>
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
  const [mode, setMode] = useState<'preview' | 'pdf'>('preview');
  const [zoom, setZoom] = useState(100);
  const [line, setLine] = useState<string | null>(null);
  const [ack, setAck] = useState(false);
  const payload = request.payload as {
    number?: string;
    total_minor?: number;
    issued?: string;
    due?: string;
    lines?: { id: string; label: string; short: string; qty: number; amount_minor: number; date: string }[];
    sections?: [string, string][];
  };
  const selected = payload.lines?.find((row) => row.id === line) ?? null;

  return (
    <div className="app-pane-body" style={{ paddingBottom: 0, gap: 18, minHeight: 0 }}>
      <div className="row" style={{ gap: 14 }}>
        <div className="col grow" style={{ gap: 3 }}>
          <h1 className="display-32">{request.title}</h1>
          <span className="meta">
            {request.subject} · {payload.number}
          </span>
        </div>
        <span className="meta">{requestStatusLabel(request)}</span>
      </div>
      <div className="doc-frame">
        <div className="doc-toolbar">
          <span>{payload.number}.pdf</span>
          <span className="seg" role="group" aria-label="Document view">
            <button type="button" aria-pressed={mode === 'preview'} onClick={() => setMode('preview')}>
              Preview
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
        {mode === 'pdf' ? (
          <div className="col grow" style={{ minHeight: 0, gap: 8, padding: 24 }}>
            {doc?.pdf_status === 'ready' && doc.pdf_url ? (
              <iframe className="pdf-embed" src={`${doc.pdf_url}#toolbar=0&navpanes=0&view=FitH`} title={`${payload.number}.pdf`} />
            ) : doc?.pdf_status === 'failed' ? (
              <EmptyState icon="invoice" title={EMPTY.pdfFailed(doc.pdf_error ?? 'unknown')} action={<Button onClick={() => adapter.ensure('document', doc.id)}>Retry</Button>} />
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
                      <span className="doc-meta">{payload.number} · Draft preview</span>
                    </div>
                  </div>
                  <div className="row doc-rule" style={{ gap: 24, padding: '12px 0', fontSize: 14, color: '#000' }}>
                    <span style={{ width: 208 }}>Issued · {payload.issued}</span>
                    <span style={{ width: 208 }}>Due · {payload.due}</span>
                  </div>
                  <div className="doc-head-row">
                    <span className="c1" style={{ flex: 1 }}>
                      Services delivered
                    </span>
                    <span style={{ width: 80, textAlign: 'right' }}>Qty</span>
                    <span style={{ width: 140, textAlign: 'right' }}>Amount · USD</span>
                  </div>
                  {(payload.lines ?? []).map((row) => (
                    <button type="button" key={row.id} className="doc-line" aria-pressed={line === row.id} onClick={() => setLine(line === row.id ? null : row.id)}>
                      <span className="c1">{row.label}</span>
                      <span className="c2">{row.qty}</span>
                      <span className="c3">{(row.amount_minor / 100).toFixed(2)}</span>
                    </button>
                  ))}
                  <div className="doc-total">
                    <span className="k">Total</span>
                    <span className="v">{fmtMoney(payload.total_minor ?? 0)}</span>
                  </div>
                  <div className="doc-foot">
                    <span>Not sent · No money moved</span>
                    <span>{payload.number} · 1 / 1</span>
                  </div>
                </>
              ) : (
                <>
                  <div className="row doc-rule" style={{ justifyContent: 'space-between', paddingBottom: 18, alignItems: 'center' }}>
                    <div className="col" style={{ gap: 6 }}>
                      <span className="doc-h">Services Agreement</span>
                      <span className="doc-meta">{payload.number} · Draft v1</span>
                    </div>
                  </div>
                  {(payload.sections ?? []).map(([heading, text]) => (
                    <div className="col" key={heading} style={{ gap: 6 }}>
                      <span className="doc-sec-h">{heading}</span>
                      <p>{text}</p>
                    </div>
                  ))}
                  <div className="doc-foot" style={{ borderTop: 0 }}>
                    <span>Both parties unsigned · Nothing sent</span>
                    <span>{payload.number} · v1 · 1 / 1</span>
                  </div>
                </>
              )}
            </div>
          </div>
        )}
      </div>
      {selected && (
        <div className="line-select-bar">
          <span>
            Selected line: {selected.label} · {fmtMoney(selected.amount_minor)}
          </span>
          <span className="grow" />
          <span style={{ position: 'relative' }}>
            <Button
              small
              onClick={() => {
                if (!state.activeSessionId) return;
                adapter.applyCommand(state.activeSessionId, { type: 'chat/prompt', text: `About ${selected.label} (${fmtMoney(selected.amount_minor)}) on ${payload.number}: ` });
                setAck(true);
                setTimeout(() => setAck(false), 1600);
              }}
            >
              Ask about this line
            </Button>
            <Ack show={ack} style={{ right: 0, top: -40 }}>
              Added to the composer
            </Ack>
          </span>
          <Button small quiet onClick={() => setLine(null)}>
            Clear
          </Button>
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
          title={request.kind === 'invoice' ? 'Create this invoice in Library.' : 'Create this draft in Library.'}
          detail={request.kind === 'invoice' ? 'No email sent. No money moved.' : 'Both parties unsigned. Nothing sent.'}
          approveLabel={request.kind === 'invoice' ? 'Create invoice' : 'Create draft'}
          declineLabel="Decline"
        />
      )}
    </div>
  );
}

/** The receipt: what was decided, and what is still pending as an effect. */
export function Receipt({ request }: { request: RequestEntity }) {
  const state = useAppState();
  const adapter = useAdapter();
  const nav = useNav();
  const [effects, setEffects] = useState<EffectEntity[]>([]);
  const declined = request.status === 'declined';

  useEffect(() => {
    if (!state.workspace.id) return;
    void adapter.rest
      .listEffects(state.workspace.id, request.id)
      .then((page) => setEffects(page.items))
      .catch(() => setEffects([]));
  }, [adapter, state.workspace.id, request.id]);

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
        <div className="col">
          {effects.length === 0 && <div className="meta" style={{ padding: '12px 0' }}>Nothing else is required.</div>}
          {effects.map((effect) => (
            <div className="list-row compact" key={effect.id}>
              <Glass name="context" size={22} className="row-icon" />
              <div className="row-main">
                <span className="t">{effect.label}</span>
                <span className="s">
                  {effect.status === 'unavailable' ? `Unavailable · ${effect.reason ?? 'no integration in the pilot'}` : `${effect.status} · needs ${effect.required_role}`}
                </span>
              </div>
            </div>
          ))}
        </div>
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
