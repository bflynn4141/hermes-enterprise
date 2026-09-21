import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useEffect, useState, type FormEvent } from 'react';
import {
  REQ,
  type HandoffDetail,
  type HandoffInMotionItem,
  type PartnerWorkflowSetup,
  type PartnerWorkflowViewV2,
} from '@hermes/shared';
import { RestError } from '../../model/rest.js';
import { useAdapter, useAppState, useNav } from '../store-context.js';
import { Glass } from '../ui/icons.js';
import { Button, EmptyState, Skeleton } from '../ui/primitives.js';

function workflowError(error: unknown): string {
  if (!(error instanceof RestError)) return 'Could not complete that action.';
  if (error.reason === 'workflow_readiness_incomplete') {
    return 'The native profiles did not match. The handoff remains disabled.';
  }
  return error.message || 'Could not complete that action.';
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
      <header>
        <div>
          <h3>Configure roles</h3>
          <p>Bind two employees to two dedicated agents.</p>
        </div>
        <Button small onClick={onClose}>Close</Button>
      </header>
      <div className="partner-form-grid">
        <label><span>Partnerships employee</span><input required value={partnershipsUser} onChange={(event) => setPartnershipsUser(event.target.value)} /></label>
        <label><span>Partnerships agent</span><input required value={partnershipsAgent} onChange={(event) => setPartnershipsAgent(event.target.value)} /></label>
        <label><span>Finance employee</span><input required value={financeUser} onChange={(event) => setFinanceUser(event.target.value)} /></label>
        <label><span>Finance agent</span><input required value={financeAgent} onChange={(event) => setFinanceAgent(event.target.value)} /></label>
      </div>
      {error && <p className="partner-error" role="alert">{error}</p>}
      <footer>
        <span className="meta">Schedules stay off until readiness passes.</span>
        <Button primary type="submit" disabled={!valid || busy}>{busy ? 'Saving…' : 'Save'}</Button>
      </footer>
    </motion.form>
  );
}

function admissionStatusCopy(detail: HandoffDetail): { label: string; tone: 'ok' | 'warn' } {
  if (detail.handoff.admission_state === 'enabled') {
    const when = detail.handoff.enabled_at
      ? new Date(detail.handoff.enabled_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      : null;
    return { label: when ? `Live · ${when}` : 'Live', tone: 'ok' };
  }
  return { label: 'Not admitted', tone: 'warn' };
}

function primaryAction(detail: HandoffDetail): { label: string; action: 'admission' | 'inbox' | null } {
  if (detail.actions.set_admission && detail.handoff.admission_state !== 'enabled') return { label: 'Enable', action: 'admission' };
  if (detail.handoff.viewer_role === 'unrelated') return { label: '', action: null };
  return { label: 'Open Inbox', action: 'inbox' };
}

function progressState(state: HandoffInMotionItem['stages'][number]['state']): 'complete' | 'current' | 'waiting' {
  if (state === 'done') return 'complete';
  if (state === 'current') return 'current';
  return 'waiting';
}

function InMotionRow({ item }: { item: HandoffInMotionItem }) {
  const adapter = useAdapter();
  const nav = useNav();
  const open = (): void => {
    if (!item.open_request_id) return;
    adapter.ensure('request', item.open_request_id, true);
    nav(REQ(item.open_request_id));
  };
  const actionLabel = item.stage === 'terms_recorded' ? 'Admit' : 'Review';
  return (
    <div className="list-row tall">
      <Glass name={item.stage === 'terms_recorded' ? 'people' : 'invoice'} size={32} className="row-icon" />
      <div className="row-main">
        <span className="t">{item.title}</span>
        <span className="s">{item.subtitle}</span>
        <ol className="partner-progress" aria-label={`${item.title} progress`}>
          {item.stages.map((stage) => (
            <li key={stage.key} data-state={progressState(stage.state)} aria-current={stage.state === 'current' ? 'step' : undefined}>
              <i aria-hidden="true" /><span>{stage.label}</span>
            </li>
          ))}
        </ol>
      </div>
      {item.open_request_id && (
        <Button small primary onClick={open}>{actionLabel}</Button>
      )}
    </div>
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
  if (error || !workflowView) {
    return (
      <div className="error-block">
        <span className="t">Could not load handoffs</span>
        <span className="s">{error}</span>
        <Button small onClick={load}>Try again</Button>
      </div>
    );
  }

  const updateAdmission = (): void => {
    if (!detail) return;
    const enabled = detail.handoff.admission_state !== 'enabled';
    setAdmissionBusy(true);
    setAdmissionError(null);
    void adapter.rest.setPartnerWorkflowAdmission(state.workspace.id, { enabled })
      .then(() => {
        setNotice(enabled ? 'Handoff enabled.' : 'Handoff disabled.');
        load();
      })
      .catch((caught: unknown) => setAdmissionError(workflowError(caught)))
      .finally(() => setAdmissionBusy(false));
  };

  if (!detail) {
    const workflow = fallback!;
    return (
      <section className="partner-workflow" aria-labelledby="partner-workflow-title">
        <header className="partner-workflow-heading">
          <div>
            <h2 id="partner-workflow-title" className="section-title">Contractor agreements</h2>
            <p>Configure both employee role templates to create this handoff.</p>
          </div>
        </header>
        {workflow.actions.configure && (
          <div className="partner-actions">
            <Button onClick={() => setForm(form === 'setup' ? null : 'setup')}>{form === 'setup' ? 'Close' : 'Configure roles'}</Button>
          </div>
        )}
        <AnimatePresence initial={false}>
          {form === 'setup' && <WorkflowSetupForm key="setup" onClose={() => setForm(null)} onSaved={() => { setForm(null); setNotice('Roles saved.'); load(); }} />}
        </AnimatePresence>
        {notice && <div className="partner-notice" role="status"><span>{notice}</span><Button small onClick={() => setNotice(null)}>Dismiss</Button></div>}
      </section>
    );
  }

  const status = admissionStatusCopy(detail);
  const primary = primaryAction(detail);
  const roleLabel = detail.handoff.viewer_role === 'unrelated'
    ? 'No access'
    : detail.handoff.viewer_role === 'admin'
      ? 'Admin'
      : detail.handoff.viewer_role === 'finance' ? 'Finance' : 'Partnerships';
  const inboxKind = detail.handoff.viewer_role === 'finance' ? 'agreement' : 'application';

  return (
    <section className="partner-workflow" aria-labelledby="handoffs-title">
      <header className="partner-workflow-heading">
        <div>
          <h2 id="handoffs-title" className="section-title">Contractor agreements</h2>
          <p>Partnerships admits · Finance reviews the agreement</p>
        </div>
        <div className="partner-heading-status">
          <span className={`pill ${status.tone === 'ok' ? 'pill-ok' : 'pill-warn'}`}>
            <i className="handoffs-status-dot" aria-hidden="true" />{status.label}
          </span>
          <span className="pill">{roleLabel}</span>
        </div>
      </header>

      <div className="partner-actions">
        {primary.action === 'admission' && (
          <Button primary disabled={admissionBusy || !detail.configured} onClick={updateAdmission}>
            {admissionBusy ? 'Verifying…' : primary.label}
          </Button>
        )}
        {primary.action === 'inbox' && (
          <Button primary onClick={() => nav({ section: 'inbox', view: 'list', filters: { status: 'pending', kind: inboxKind } })}>
            {primary.label}
          </Button>
        )}
        {detail.actions.configure && (
          <Button onClick={() => setForm(form === 'setup' ? null : 'setup')}>{form === 'setup' ? 'Close' : 'Edit roles'}</Button>
        )}
        {detail.actions.set_admission && detail.handoff.admission_state === 'enabled' && (
          <Button disabled={admissionBusy} onClick={updateAdmission}>{admissionBusy ? '…' : 'Disable'}</Button>
        )}
      </div>

      {detail.handoff.viewer_role === 'unrelated' ? (
        <EmptyState icon="context" title="No access" detail="This handoff is for Partnerships and Finance only." />
      ) : (
        <div className="col">
          {detail.lanes.map((lane) => {
            const ready = lane.readiness.native_status === 'ready' && lane.readiness.assignment_state === 'active';
            return (
              <div key={lane.team.slug} className="list-row">
                <Glass name={lane.team.slug === 'finance' ? 'invoice' : 'people'} size={32} className="row-icon" />
                <div className="row-main">
                  <span className="t">{lane.team.name}</span>
                  <span className="s">
                    {lane.person && lane.agent ? `${lane.person} · ${lane.agent}` : 'Unassigned'}
                    {lane.skill ? ` · ${lane.skill}` : ''}
                  </span>
                </div>
                <span className={`pill ${ready ? 'pill-ok' : 'pill-warn'}`}>{ready ? 'Ready' : 'Not ready'}</span>
              </div>
            );
          })}

          {detail.crossing.length > 0 && (
            <p className="partner-workflow-route" aria-label="What crosses">
              <strong>Crosses</strong>
              {detail.crossing.map((item, index) => (
                <span key={item.key}>{index > 0 ? ' → ' : ' '}{item.label}</span>
              ))}
            </p>
          )}

          {admissionError && <p className="partner-error" role="alert">{admissionError}</p>}
          <AnimatePresence initial={false}>
            {form === 'setup' && <WorkflowSetupForm key="setup" onClose={() => setForm(null)} onSaved={() => { setForm(null); setNotice('Roles saved.'); load(); }} />}
          </AnimatePresence>
          {notice && <div className="partner-notice" role="status"><span>{notice}</span><Button small onClick={() => setNotice(null)}>Dismiss</Button></div>}

          <div className="partner-work-list">
            <header>
              <h3>In motion</h3>
              <span className="meta">
                {detail.counts.in_motion === 0
                  ? 'Nothing yet'
                  : `${detail.counts.waiting_on_viewer} waiting on you`}
              </span>
            </header>
            {detail.in_motion.length === 0
              ? <EmptyState icon="people" title="Nothing in motion" detail="Admitted partners appear here for Finance review." />
              : detail.in_motion.map((item) => <InMotionRow key={item.id} item={item} />)}
          </div>
        </div>
      )}
    </section>
  );
}
