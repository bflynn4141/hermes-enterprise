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
import { Button, EmptyState, Skeleton } from '../ui/primitives.js';

function workflowError(error: unknown): string {
  if (!(error instanceof RestError)) return 'Could not complete that action.';
  if (error.reason === 'workflow_readiness_incomplete') {
    return 'Profiles did not match. Still disabled.';
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
      <header><div><h3>Roles</h3></div><Button small onClick={onClose}>Close</Button></header>
      <div className="partner-form-grid">
        <label><span>Partnerships user</span><input required value={partnershipsUser} onChange={(event) => setPartnershipsUser(event.target.value)} /></label>
        <label><span>Partnerships agent</span><input required value={partnershipsAgent} onChange={(event) => setPartnershipsAgent(event.target.value)} /></label>
        <label><span>Finance user</span><input required value={financeUser} onChange={(event) => setFinanceUser(event.target.value)} /></label>
        <label><span>Finance agent</span><input required value={financeAgent} onChange={(event) => setFinanceAgent(event.target.value)} /></label>
      </div>
      {error && <p className="partner-error" role="alert">{error}</p>}
      <footer><Button primary type="submit" disabled={!valid || busy}>{busy ? 'Saving…' : 'Save'}</Button></footer>
    </motion.form>
  );
}

function admissionStatusCopy(detail: HandoffDetail): { label: string; tone: 'ok' | 'warn' } {
  if (detail.handoff.admission_state === 'enabled') return { label: 'Live', tone: 'ok' };
  return { label: 'Off', tone: 'warn' };
}

function primaryAction(detail: HandoffDetail): { label: string; action: 'admission' | 'inbox' | null } {
  if (detail.actions.set_admission && detail.handoff.admission_state !== 'enabled') return { label: 'Enable', action: 'admission' };
  if (detail.handoff.viewer_role === 'finance' || detail.actions.view_finance_review) return { label: 'Inbox', action: 'inbox' };
  if (detail.handoff.viewer_role === 'partnerships' || detail.handoff.viewer_role === 'admin') return { label: 'Inbox', action: 'inbox' };
  return { label: '', action: null };
}

function InMotionRow({ item }: { item: HandoffInMotionItem }) {
  const adapter = useAdapter();
  const nav = useNav();
  const open = (): void => {
    if (!item.open_request_id) return;
    adapter.ensure('request', item.open_request_id, true);
    nav(REQ(item.open_request_id));
  };
  return (
    <article className="handoffs-motion-row">
      <div className="handoffs-motion-copy">
        <strong>{item.title}</strong>
        <span>{item.subtitle}</span>
      </div>
      <ol className="handoffs-stage-strip" aria-label={item.title}>
        {item.stages.map((stage) => (
          <li key={stage.key} data-state={stage.state} aria-current={stage.state === 'current' ? 'step' : undefined}>
            <i aria-hidden="true" /><span>{stage.label}</span>
          </li>
        ))}
      </ol>
      <div className="handoffs-motion-actions">
        {item.open_request_id && (
          <Button small primary onClick={open}>{item.stage === 'terms_recorded' ? 'Admit' : 'Review'}</Button>
        )}
      </div>
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
  if (error || !workflowView) return <div className="error-block"><span className="t">Could not load</span><Button small onClick={load}>Retry</Button></div>;

  const updateAdmission = (): void => {
    if (!detail) return;
    const enabled = detail.handoff.admission_state !== 'enabled';
    setAdmissionBusy(true);
    setAdmissionError(null);
    void adapter.rest.setPartnerWorkflowAdmission(state.workspace.id, { enabled })
      .then(() => {
        setNotice(enabled ? 'Enabled' : 'Disabled');
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
            <h2 id="partner-workflow-title">Contractor agreements</h2>
          </div>
        </header>
        {workflow.actions.configure && (
          <>
            <Button onClick={() => setForm(form === 'setup' ? null : 'setup')}>{form === 'setup' ? 'Close' : 'Configure'}</Button>
            <AnimatePresence initial={false}>
              {form === 'setup' && <WorkflowSetupForm key="setup" onClose={() => setForm(null)} onSaved={() => { setForm(null); setNotice('Saved'); load(); }} />}
            </AnimatePresence>
          </>
        )}
        {notice && <div className="partner-notice" role="status"><span>{notice}</span><Button small onClick={() => setNotice(null)}>OK</Button></div>}
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

  return (
    <section className="handoffs-page partner-workflow" aria-labelledby="handoffs-title">
      <header className="handoffs-header">
        <div>
          <h2 id="handoffs-title">Contractor agreements</h2>
        </div>
        <div className="handoffs-header-actions">
          <span className={`pill ${status.tone === 'ok' ? 'pill-ok' : 'pill-warn'}`}>{status.label}</span>
          <span className="pill">{roleLabel}</span>
          {primary.action === 'admission' && (
            <Button primary disabled={admissionBusy || !detail.configured} onClick={updateAdmission}>{admissionBusy ? '…' : primary.label}</Button>
          )}
          {primary.action === 'inbox' && (
            <Button primary onClick={() => nav({
              section: 'inbox',
              view: 'list',
              filters: { status: 'pending', kind: detail.handoff.viewer_role === 'finance' ? 'agreement' : 'application' },
            })}>{primary.label}</Button>
          )}
          {detail.actions.configure && <Button onClick={() => setForm(form === 'setup' ? null : 'setup')}>{form === 'setup' ? 'Close' : 'Roles'}</Button>}
          {detail.actions.set_admission && detail.handoff.admission_state === 'enabled' && (
            <Button disabled={admissionBusy} onClick={updateAdmission}>{admissionBusy ? '…' : 'Disable'}</Button>
          )}
        </div>
      </header>

      {detail.handoff.viewer_role === 'unrelated' ? (
        <EmptyState icon="context" title="No access" detail="" />
      ) : (
        <>
          <div className="handoffs-lanes">
            {detail.lanes.map((lane) => {
              const ready = lane.readiness.native_status === 'ready' && lane.readiness.assignment_state === 'active';
              return (
                <article key={lane.team.slug} className="handoffs-lane-card" data-ready={ready}>
                  <header>
                    <h3>{lane.team.name}</h3>
                    <span className={`handoffs-ready-dot${ready ? ' is-ready' : ''}`}>{ready ? 'Ready' : '—'}</span>
                  </header>
                  <p className="meta">{[lane.person, lane.agent].filter(Boolean).join(' · ') || '—'}</p>
                </article>
              );
            })}
          </div>

          {admissionError && <p className="partner-error" role="alert">{admissionError}</p>}
          <AnimatePresence initial={false}>
            {form === 'setup' && <WorkflowSetupForm key="setup" onClose={() => setForm(null)} onSaved={() => { setForm(null); setNotice('Saved'); load(); }} />}
          </AnimatePresence>
          {notice && <div className="partner-notice" role="status"><span>{notice}</span><Button small onClick={() => setNotice(null)}>OK</Button></div>}

          <section className="handoffs-motion" aria-labelledby="handoffs-motion-title">
            <header>
              <h3 id="handoffs-motion-title">In motion</h3>
            </header>
            {detail.in_motion.length === 0
              ? <EmptyState icon="people" title="Nothing yet" detail="" />
              : detail.in_motion.map((item) => (
                <InMotionRow key={item.id} item={item} />
              ))}
          </section>
        </>
      )}
    </section>
  );
}
