import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useEffect, useState, type FormEvent } from 'react';
import {
  REQ,
  type HandoffDetail,
  type HandoffInMotionItem,
  type HandoffLane,
  type PartnerWorkflowSetup,
  type PartnerWorkflowViewV2,
} from '@hermes/shared';
import { RestError } from '../../model/rest.js';
import { useAdapter, useAppState, useNav } from '../store-context.js';
import { Glass, Icon } from '../ui/icons.js';
import { Button, EmptyState, Skeleton, Toggle } from '../ui/primitives.js';

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
          <h3>Roles</h3>
          <p>One person and one agent per team.</p>
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
        <span className="meta" />
        <Button primary type="submit" disabled={!valid || busy}>{busy ? 'Saving…' : 'Save'}</Button>
      </footer>
    </motion.form>
  );
}

/** "Partnerships · Maya Chen · Iris". Unassigned lanes just show the team. */
function laneLabel(lane: HandoffLane): string {
  return [lane.team.name, lane.person, lane.agent].filter(Boolean).join(' · ');
}

function laneReady(lane: HandoffLane): boolean {
  return lane.readiness.native_status === 'ready' && lane.readiness.assignment_state === 'active';
}

/** Whose turn it is, in a few words. The row's button says what to do. */
function turnCopy(item: HandoffInMotionItem, detail: HandoffDetail): string {
  const viewer = detail.handoff.viewer_role;
  const finance = detail.lanes.find((lane) => lane.team.slug === 'finance');
  const agent = finance?.agent ?? 'Finance';
  switch (item.stage) {
    case 'terms_recorded': return viewer === 'partnerships' ? 'Waiting on you' : 'Waiting on Partnerships';
    case 'finance_verifying': return `${agent} is preparing`;
    case 'invoice': return `${agent} is reviewing`;
    case 'decision': return viewer === 'finance' ? 'Waiting on you' : 'Waiting on Finance';
    case 'acknowledged': return 'Done';
  }
}

function InMotionRow({ item, detail }: { item: HandoffInMotionItem; detail: HandoffDetail }) {
  const adapter = useAdapter();
  const nav = useNav();
  const open = (): void => {
    if (!item.open_request_id) return;
    adapter.ensure('request', item.open_request_id, true);
    nav(REQ(item.open_request_id));
  };
  const current = item.stages.find((stage) => stage.state === 'current');
  return (
    <div className="list-row handoff-row">
      <Glass name={item.stage === 'terms_recorded' ? 'admission' : 'agreement'} size={32} className="row-icon" />
      <div className="row-main">
        <span className="t">{item.title}</span>
        <span className="s">{turnCopy(item, detail)}</span>
      </div>
      <ol className="handoff-track" aria-label={`${item.title}: ${current?.label ?? 'Done'}`}>
        {item.stages.map((stage) => (
          <li key={stage.key} data-state={stage.state} title={stage.label} aria-current={stage.state === 'current' ? 'step' : undefined}>
            <i aria-hidden="true" />
          </li>
        ))}
      </ol>
      {item.open_request_id && (
        <Button small primary onClick={open}>{item.stage === 'terms_recorded' ? 'Admit' : 'Review'}</Button>
      )}
    </div>
  );
}

export function PartnerWorkflow() {
  const state = useAppState();
  const adapter = useAdapter();
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

  const setupForm = form === 'setup' && (
    <WorkflowSetupForm key="setup" onClose={() => setForm(null)} onSaved={() => { setForm(null); setNotice('Roles saved.'); load(); }} />
  );
  const noticeRow = notice && (
    <div className="partner-notice" role="status"><span>{notice}</span><Button small onClick={() => setNotice(null)}>Dismiss</Button></div>
  );

  if (!detail) {
    const workflow = fallback!;
    return (
      <section className="partner-workflow" aria-label="Handoffs">
        <EmptyState
          icon="agreement"
          title="Partnerships → Finance"
          detail={workflow.actions.configure ? 'Bind both roles to turn this on.' : 'Not set up yet.'}
          action={workflow.actions.configure && form !== 'setup'
            ? <Button primary onClick={() => setForm('setup')}>Configure roles</Button>
            : undefined}
        />
        <AnimatePresence initial={false}>{setupForm}</AnimatePresence>
        {noticeRow}
      </section>
    );
  }

  const enabled = detail.handoff.admission_state === 'enabled';
  const ready = detail.lanes.length > 0 && detail.lanes.every(laneReady);
  const setAdmission = (next: boolean): void => {
    setAdmissionBusy(true);
    setAdmissionError(null);
    void adapter.rest.setPartnerWorkflowAdmission(state.workspace.id, { enabled: next })
      .then(() => {
        setNotice(next ? 'Handoff enabled.' : 'Handoff disabled.');
        load();
      })
      .catch((caught: unknown) => setAdmissionError(workflowError(caught)))
      .finally(() => setAdmissionBusy(false));
  };
  const status = enabled
    ? { label: 'Live', tone: 'pill-ok' }
    : ready ? { label: 'Off', tone: '' } : { label: 'Not ready', tone: 'pill-warn' };
  const [from, to] = detail.lanes;

  return (
    <section className="partner-workflow" aria-labelledby="handoffs-title">
      <div className="list-row handoff-chain">
        <Glass name="agreement" size={32} className="row-icon" />
        <div className="row-main">
          <h2 id="handoffs-title" className="t">{detail.handoff.name.split(' · ')[0]}</h2>
          {from && to && (
            <span className="s handoff-route">
              <span>{laneLabel(from)}</span>
              <Icon name="arrow" size={14} />
              <span>{laneLabel(to)}</span>
            </span>
          )}
        </div>
        {(!detail.actions.set_admission || !ready) && <span className={`pill ${status.tone}`}>{status.label}</span>}
        {detail.actions.set_admission && (
          <Toggle checked={enabled} disabled={admissionBusy || !detail.configured} label="Handoff live" onChange={setAdmission} />
        )}
        {detail.actions.configure && (
          <Button small onClick={() => setForm(form === 'setup' ? null : 'setup')}>{form === 'setup' ? 'Close' : 'Edit roles'}</Button>
        )}
      </div>

      {admissionError && <p className="partner-error" role="alert">{admissionError}</p>}
      <AnimatePresence initial={false}>{setupForm}</AnimatePresence>
      {noticeRow}

      {detail.handoff.viewer_role === 'unrelated'
        ? <EmptyState icon="context" title="No access" />
        : detail.in_motion.length === 0
          ? <EmptyState icon="admission" title="Nothing in motion" detail="Admitted partners show up here." />
          : detail.in_motion.map((item) => <InMotionRow key={item.id} item={item} detail={detail} />)}
    </section>
  );
}
