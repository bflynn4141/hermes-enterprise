import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useEffect, useState, type FormEvent } from 'react';
import {
  REQ,
  type HandoffDetail,
  type HandoffInMotionItem,
  type PartnerHandoffResult,
  type PartnerWorkflowSetup,
  type PartnerWorkflowViewV2,
} from '@hermes/shared';
import { RestError } from '../../model/rest.js';
import { useAdapter, useAppState, useNav } from '../store-context.js';
import { Button, EmptyState, Skeleton } from '../ui/primitives.js';

function workflowError(error: unknown): string {
  if (!(error instanceof RestError)) return 'The server did not complete that action. Try again.';
  switch (error.reason) {
    case 'workflow_readiness_incomplete':
      return 'The native profiles did not match the reviewed role bindings, versions, tools, and provider attestations. The workflow remains disabled.';
    case 'workflow_not_configured':
      return 'Configure both employee role templates before enabling this handoff.';
    default:
      return error.message || 'The server did not complete that action. Try again.';
  }
}

function WorkflowSetupForm({ onClose, onSaved }: { onClose: () => void; onSaved: (view: PartnerWorkflowViewV2) => void }) {
  const adapter = useAdapter();
  const state = useAppState();
  const reduce = useReducedMotion();
  const [partnershipsUser, setPartnershipsUser] = useState(state.user.id);
  const [partnershipsAgent, setPartnershipsAgent] = useState(state.agent.id ?? '');
  const [financeUser, setFinanceUser] = useState('');
  const [financeAgent, setFinanceAgent] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const valid = Boolean(partnershipsUser && partnershipsAgent && financeUser && financeAgent && partnershipsUser !== financeUser && partnershipsAgent !== financeAgent);
  const submit = (event: FormEvent): void => {
    event.preventDefault();
    if (!valid) return;
    const body: PartnerWorkflowSetup = {
      partnerships: { principal_user_id: partnershipsUser.trim(), agent_id: partnershipsAgent.trim() },
      finance: { principal_user_id: financeUser.trim(), agent_id: financeAgent.trim() },
    };
    setBusy(true);
    setError(null);
    void adapter.rest.configurePartnerWorkflow(state.workspace.id, body)
      .then(onSaved)
      .catch((caught: unknown) => setError(workflowError(caught)))
      .finally(() => setBusy(false));
  };
  return (
    <motion.form className="partner-workflow-form" aria-label="Configure employee roles" onSubmit={submit} initial={{ opacity: 0, y: reduce ? 0 : -4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: .16, ease: [0.22, 1, 0.36, 1] }}>
      <header><div><h3>Configure two employee profiles</h3><p>Bind two existing users to two dedicated native Hermes profiles. Saving role assignments does not make a missing skill, tool, or provider ready.</p></div><Button small onClick={onClose}>Close</Button></header>
      <div className="partner-form-grid">
        <label><span>Partnerships employee user ID</span><input required value={partnershipsUser} onChange={(event) => setPartnershipsUser(event.target.value)} /></label>
        <label><span>Partnerships Hermes agent ID</span><input required value={partnershipsAgent} onChange={(event) => setPartnershipsAgent(event.target.value)} /></label>
        <label><span>Finance employee user ID</span><input required value={financeUser} onChange={(event) => setFinanceUser(event.target.value)} placeholder="Existing WorkOS user UUID" /></label>
        <label><span>Finance Hermes agent ID</span><input required value={financeAgent} onChange={(event) => setFinanceAgent(event.target.value)} placeholder="Dedicated native profile UUID" /></label>
      </div>
      {!valid && financeUser && financeAgent && (partnershipsUser === financeUser || partnershipsAgent === financeAgent) && <p className="partner-error" role="alert">Each role needs a distinct employee and a distinct Hermes agent.</p>}
      {error && <p className="partner-error" role="alert">{error}</p>}
      <footer><span className="meta">New schedules remain off. Readiness is checked from the native profiles after saving.</span><Button primary type="submit" disabled={!valid || busy}>{busy ? 'Saving roles…' : 'Save role assignments'}</Button></footer>
    </motion.form>
  );
}

function ownerLabel(step: HandoffDetail['steps'][number], lanes: HandoffDetail['lanes']): string {
  const lane = lanes.find((item) => item.team.slug === step.owner.team_slug);
  const person = lane?.person ?? (step.owner.team_slug === 'partnerships' ? 'Partnerships' : 'Finance');
  if (step.owner.return_team_slug) return `${step.owner.team_slug === 'finance' ? 'Finance' : 'Partnerships'} → ${step.owner.return_team_slug === 'partnerships' ? 'Partnerships' : 'Finance'}`;
  if (step.owner.kind === 'agent') return `${lane?.team.name ?? 'Finance'} · ${lane?.agent ?? 'Agent'}`;
  return `${lane?.team.name ?? person} · ${person}`;
}

function admissionStatusCopy(detail: HandoffDetail): { label: string; tone: 'ok' | 'warn' } {
  if (detail.handoff.admission_state === 'enabled') {
    const when = detail.handoff.enabled_at ? new Date(detail.handoff.enabled_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : 'recently';
    return { label: `Live · admitted ${when}`, tone: 'ok' };
  }
  const financeReady = detail.lanes.find((lane) => lane.team.slug === 'finance')?.readiness.native_status === 'ready';
  return { label: financeReady ? 'Not admitted · enable when ready' : 'Not admitted · Finance seat missing', tone: 'warn' };
}

function primaryAction(detail: HandoffDetail): { label: string; action: 'admission' | 'applicants' | 'agreements' | null } {
  if (detail.actions.set_admission && detail.handoff.admission_state !== 'enabled') return { label: 'Verify and enable', action: 'admission' };
  if (detail.handoff.viewer_role === 'finance' || detail.actions.view_finance_review) {
    return { label: 'Review agreements in Inbox', action: 'agreements' };
  }
  if (detail.handoff.viewer_role === 'partnerships' || detail.handoff.viewer_role === 'admin') {
    return { label: 'Review applicants in Inbox', action: 'applicants' };
  }
  return { label: '', action: null };
}

function EvidenceSource({ title, source }: { title: string; source: PartnerHandoffResult['source_versions']['engagement'] }) {
  return (
    <section>
      <span className="partner-card-kicker">{title}</span>
      <h4>{source.name}</h4>
      <p className="meta">{source.author_name ? `${source.author_name} · ` : ''}{new Date(source.created_at).toLocaleString()}</p>
      <blockquote>{source.excerpt}</blockquote>
    </section>
  );
}

function InMotionRow({
  item,
  detail,
}: {
  item: HandoffInMotionItem;
  detail: HandoffDetail;
}) {
  const adapter = useAdapter();
  const state = useAppState();
  const nav = useNav();
  const [expanded, setExpanded] = useState(false);
  const [result, setResult] = useState<PartnerHandoffResult | null>(null);
  const handoff = item.handoff;
  const showEvidence = (): void => {
    if (!handoff) return;
    setExpanded((open) => !open);
    if (!result) void adapter.rest.partnerHandoffResult(state.workspace.id, handoff.id).then(setResult).catch(() => undefined);
  };
  return (
    <article className="handoffs-motion-row" id={handoff ? `handoff-${handoff.id}` : undefined}>
      <div className="handoffs-motion-copy">
        <strong>{item.title}</strong>
        <span>{item.subtitle}</span>
      </div>
      <ol className="handoffs-stage-strip" aria-label={`Progress for ${item.title}`}>
        {item.stages.map((stage) => (
          <li key={stage.key} data-state={stage.state} aria-current={stage.state === 'current' ? 'step' : undefined}>
            <i aria-hidden="true" /><span>{stage.label}</span>
          </li>
        ))}
      </ol>
      <div className="handoffs-motion-actions">
        {handoff && <Button small onClick={showEvidence} aria-expanded={expanded}>{expanded ? 'Hide evidence' : 'View evidence'}</Button>}
        {handoff?.request_id && detail.actions.view_finance_review && (
          <Button small primary onClick={() => { adapter.ensure('request', handoff.request_id!, true); nav(REQ(handoff.request_id!)); }}>Open Finance decision</Button>
        )}
      </div>
      {expanded && handoff && result && (
        <div className="partner-handoff-evidence">
          <div className="partner-evidence-grid">
            <EvidenceSource title="Agreement source" source={result.source_versions.engagement} />
            <EvidenceSource title="Supporting source" source={result.source_versions.invoice} />
          </div>
        </div>
      )}
    </article>
  );
}

export function PartnerWorkflow() {
  const state = useAppState();
  const adapter = useAdapter();
  const nav = useNav();
  const [detail, setDetail] = useState<HandoffDetail | null>(null);
  const [fallback, setFallback] = useState<PartnerWorkflowViewV2 | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<'setup' | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [admissionBusy, setAdmissionBusy] = useState(false);
  const [admissionError, setAdmissionError] = useState<string | null>(null);
  const lastStreamMessage = state.connection.workspace.lastMessageAt;

  const load = (): void => {
    setError(null);
    void adapter.rest.listHandoffs(state.workspace.id)
      .then(async (items) => {
        if (items[0]) {
          const next = await adapter.rest.getHandoff(state.workspace.id, items[0].id);
          setDetail(next);
          setFallback(null);
          return;
        }
        const legacy = await adapter.rest.partnerWorkflow(state.workspace.id);
        setFallback(legacy);
        setDetail(null);
      })
      .catch((caught: unknown) => setError(workflowError(caught)))
      .finally(() => setLoading(false));
  };

  useEffect(load, [adapter.rest, state.workspace.id]);
  useEffect(() => {
    if (!lastStreamMessage) return;
    const timer = window.setTimeout(load, 140);
    return () => window.clearTimeout(timer);
  }, [lastStreamMessage]);

  const workflowView = detail ?? fallback;
  if (loading) return <Skeleton rows={4} label="Loading handoffs" />;
  if (error || !workflowView) return <div className="error-block"><span className="t">Could not load handoffs</span><span className="s">{error}</span><Button small onClick={load}>Try again</Button></div>;

  const openInbox = (kind: 'application' | 'agreement'): void => {
    nav({ section: 'inbox', view: 'list', filters: { status: 'pending', kind } });
  };

  const updateAdmission = (): void => {
    if (!detail) return;
    const enabled = detail.handoff.admission_state !== 'enabled';
    setAdmissionBusy(true);
    setAdmissionError(null);
    void adapter.rest.setPartnerWorkflowAdmission(state.workspace.id, { enabled })
      .then(() => {
        setNotice(enabled
          ? 'Contractor agreements is enabled for new governed work.'
          : 'New governed contractor work is disabled. Existing Inbox items remain available.');
        load();
      })
      .catch((caught: unknown) => setAdmissionError(workflowError(caught)))
      .finally(() => setAdmissionBusy(false));
  };

  if (!detail) {
    const workflow = fallback!;
    return (
      <section className="handoffs-page partner-workflow" aria-labelledby="partner-workflow-title">
        <header className="handoffs-header">
          <div>
            <h2 id="partner-workflow-title">Contractor agreements · Partnerships → Finance</h2>
            <p>Configure both employee role templates to create this handoff.</p>
          </div>
        </header>
        {workflow.actions.configure && (
          <>
            <Button onClick={() => setForm(form === 'setup' ? null : 'setup')}>{form === 'setup' ? 'Close setup' : 'Configure roles'}</Button>
            <AnimatePresence initial={false}>
              {form === 'setup' && <WorkflowSetupForm key="setup" onClose={() => setForm(null)} onSaved={() => { setForm(null); setNotice('Role assignments saved.'); load(); }} />}
            </AnimatePresence>
          </>
        )}
        {notice && <div className="partner-notice" role="status"><span>{notice}</span><Button small onClick={() => setNotice(null)}>Dismiss</Button></div>}
      </section>
    );
  }

  const status = admissionStatusCopy(detail);
  const primary = primaryAction(detail);
  const roleLabel = detail.handoff.viewer_role === 'unrelated'
    ? 'No handoff access'
    : detail.handoff.viewer_role === 'admin'
      ? 'Admin view'
      : `You are ${detail.handoff.viewer_role === 'finance' ? 'Finance' : 'Partnerships'}`;

  return (
    <section className="handoffs-page partner-workflow" aria-labelledby="handoffs-title">
      <header className="handoffs-header">
        <div>
          <h2 id="handoffs-title">{detail.handoff.name}</h2>
          <p>{detail.handoff.description}</p>
        </div>
        <div className="handoffs-header-actions">
          <span className={`pill ${status.tone === 'ok' ? 'pill-ok' : 'pill-warn'}`}><i className="handoffs-status-dot" aria-hidden="true" />{status.label}</span>
          <span className="pill">{roleLabel}</span>
          {primary.action === 'admission' && (
            <Button primary disabled={admissionBusy || !detail.configured} onClick={updateAdmission}>{admissionBusy ? 'Verifying profiles…' : primary.label}</Button>
          )}
          {primary.action === 'applicants' && <Button primary onClick={() => openInbox('application')}>{primary.label}</Button>}
          {primary.action === 'agreements' && <Button primary onClick={() => openInbox('agreement')}>{primary.label}</Button>}
          {primary.action === 'applicants' && (
            <Button onClick={() => openInbox('agreement')}>Open agreements</Button>
          )}
          {detail.actions.configure && <Button onClick={() => setForm(form === 'setup' ? null : 'setup')}>{form === 'setup' ? 'Close setup' : 'Edit role bindings'}</Button>}
          {detail.actions.set_admission && detail.handoff.admission_state === 'enabled' && (
            <Button disabled={admissionBusy} onClick={updateAdmission}>{admissionBusy ? 'Disabling…' : 'Disable handoff'}</Button>
          )}
        </div>
      </header>

      {detail.handoff.viewer_role === 'unrelated' ? (
        <EmptyState icon="context" title="No Partnerships or Finance work assigned" detail="Your workspace membership does not grant access to these private handoffs." />
      ) : (
        <>
          <div className="handoffs-lanes">
            {detail.lanes.map((lane) => {
              const ready = lane.readiness.native_status === 'ready' && lane.readiness.assignment_state === 'active';
              return (
                <article key={lane.team.slug} className="handoffs-lane-card" data-ready={ready}>
                  <header><h3>{lane.team.name}</h3><span className={`handoffs-ready-dot${ready ? ' is-ready' : ''}`}>{ready ? 'Ready' : 'Not ready'}</span></header>
                  <dl>
                    <div><dt>Person</dt><dd><span>{lane.person ?? '—'}</span><small>{lane.notes[0]}</small></dd></div>
                    <div><dt>Agent</dt><dd><span>{lane.agent ?? '—'}</span><small>{lane.notes[1]}</small></dd></div>
                    <div><dt>Skill</dt><dd><span>{lane.skill ?? '—'}</span><small>{lane.notes[2]} · {lane.notes[3]}</small></dd></div>
                  </dl>
                </article>
              );
            })}
            <div className="handoffs-crossing" aria-label="Only this crosses">
              <strong>Only this crosses</strong>
              {detail.crossing.map((item) => (
                <p key={item.key}>{item.direction === 'return' ? '← ' : ''}{item.label}{item.direction === 'forward' ? ' →' : ''}</p>
              ))}
            </div>
          </div>

          <section className="handoffs-steps" aria-labelledby="handoffs-steps-title">
            <header><h3 id="handoffs-steps-title">How one contractor agreement moves</h3><span className="meta">People decide · agents prepare · nothing is paid, signed or sent</span></header>
            <ol>
              {detail.steps.map((step) => (
                <li key={step.index}>
                  <span className="handoffs-step-index">{step.index}</span>
                  <span className="handoffs-step-owner">{ownerLabel(step, detail.lanes)}</span>
                  <span className="handoffs-step-text">{step.label}</span>
                  <span className="handoffs-step-note">{step.note}</span>
                </li>
              ))}
            </ol>
          </section>

          {admissionError && <p className="partner-error" role="alert">{admissionError}</p>}
          <AnimatePresence initial={false}>
            {form === 'setup' && <WorkflowSetupForm key="setup" onClose={() => setForm(null)} onSaved={() => { setForm(null); setNotice('Role assignments saved.'); load(); }} />}
          </AnimatePresence>
          {notice && <div className="partner-notice" role="status"><span>{notice}</span><Button small onClick={() => setNotice(null)}>Dismiss</Button></div>}

          <section className="handoffs-motion" aria-labelledby="handoffs-motion-title">
            <header>
              <h3 id="handoffs-motion-title">In motion</h3>
              <span className="meta">
                {detail.counts.in_motion === 0
                  ? 'Nothing yet · admit an applicant, then send the contractor agreement to Finance'
                  : `${detail.counts.in_motion} in motion · ${detail.counts.waiting_on_viewer} waiting on you`}
              </span>
            </header>
            {detail.in_motion.length === 0
              ? <EmptyState icon="people" title="Nothing in motion yet" detail="Admit an applicant in Inbox. After admission, Finance reviews the independent contractor agreement there." />
              : detail.in_motion.map((item) => (
                <InMotionRow key={item.id} item={item} detail={detail} />
              ))}
          </section>
        </>
      )}
    </section>
  );
}
