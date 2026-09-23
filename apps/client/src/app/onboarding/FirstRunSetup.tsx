import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useMemo, useReducer, type ReactNode } from 'react';
import { Glass, Icon } from '../ui/icons.js';
import {
  DEFAULT_BOUNDARIES,
  FIRST_RUN_STEPS,
  REVIEWER_OPTIONS,
  createFirstRunState,
  firstRunReducer,
  workingAgreement,
  type FirstRunAction,
  type FirstRunState,
  type FirstRunStep,
  type Reviewer,
  type WorkingAgreement,
} from './FirstRunSetup.model.js';

export type IrisReadyStatus = 'idle' | 'getting_ready' | 'retrying' | 'ready';

export interface FirstRunSetupProps {
  agentName?: string;
  state?: FirstRunState;
  initialState?: FirstRunState;
  setupError?: string | null;
  irisStatus?: IrisReadyStatus;
  onStateChange?: (state: FirstRunState, agreement: WorkingAgreement) => void;
  onAction?: (action: FirstRunAction) => void;
  onOpenInbox?: () => void;
}

const STEP_LABELS: Record<FirstRunStep, string> = {
  intro: 'Meet your agent', criteria: 'Criteria', boundaries: 'Review', ready: 'Inbox',
};
const MOTION = { duration: 0.18, ease: [0.22, 1, 0.36, 1] as const };

export function FirstRunSetup({
  agentName = 'Iris', state: controlledState, initialState, setupError,
  irisStatus = 'idle', onStateChange, onAction, onOpenInbox,
}: FirstRunSetupProps) {
  const [internal, dispatchInternal] = useReducer(firstRunReducer, initialState ?? createFirstRunState());
  const state = controlledState ?? internal;
  const agreement = useMemo(() => workingAgreement(state), [state]);
  const dispatch = (action: FirstRunAction): void => {
    const next = firstRunReducer(state, action);
    if (!controlledState) dispatchInternal(action);
    onAction?.(action);
    onStateChange?.(next, workingAgreement(next));
  };
  return (
    <section className="first-run-setup" aria-label={`Activate ${agentName}`}>
      <header className="first-run-header">
        <div className="first-run-title"><Glass name="iris" size={30} /><div><h1>Activate {agentName}</h1><p>Partner Program</p></div></div>
        <FirstRunProgress current={state.step} />
      </header>
      <div className="first-run-grid">
        <FirstRunConversation
          state={state} onAction={dispatch} agentName={agentName}
          setupError={setupError} irisStatus={irisStatus} onOpenInbox={onOpenInbox}
        />
        <FirstRunWorkingAgreement state={state} agreement={agreement} />
      </div>
    </section>
  );
}

export function FirstRunProgress({ current }: { current: FirstRunStep }) {
  const currentIndex = FIRST_RUN_STEPS.indexOf(current);
  return (
    <ol className="first-run-progress" aria-label="Activation progress">
      {FIRST_RUN_STEPS.map((step, index) => (
        <li key={step} className={index === currentIndex ? 'is-current' : index < currentIndex ? 'is-complete' : ''} aria-current={index === currentIndex ? 'step' : undefined}>
          <span className="first-run-step-dot">{index < currentIndex ? <Icon name="check" size={13} /> : index + 1}</span>
          <span>{STEP_LABELS[step]}</span>
        </li>
      ))}
    </ol>
  );
}

function IrisPrompt({ children }: { children: ReactNode }) {
  return <div className="first-run-iris-message"><Glass name="iris" size={28} /><div className="first-run-message-copy">{children}</div></div>;
}

export function FirstRunConversation({
  state, onAction, agentName = 'Iris', setupError, irisStatus = 'idle', onOpenInbox,
}: {
  state: FirstRunState;
  onAction: (action: FirstRunAction) => void;
  agentName?: string;
  setupError?: string | null;
  irisStatus?: IrisReadyStatus;
  onOpenInbox?: () => void;
}) {
  const reduceMotion = useReducedMotion() ?? false;
  const transition = reduceMotion ? { duration: 0.08 } : MOTION;
  return (
    <section className="first-run-conversation" aria-label={`Activation with ${agentName}`}>
      <div className="first-run-conversation-meta"><span>{agentName}</span><span className="first-run-deterministic">Activation guide</span></div>
      <div className="first-run-transcript" role="log" aria-live="polite">
        <AnimatePresence mode="wait" initial={false}>
          <motion.div key={`${state.step}:${state.editingReviewers}:${irisStatus}`} className="first-run-current"
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -4 }} transition={transition}>
            {state.step === 'intro' && <Intro agentName={agentName} onContinue={() => onAction({ type: 'intro/continue' })} />}
            {state.step === 'criteria' && <Criteria agentName={agentName} state={state} onAction={onAction} />}
            {state.step === 'boundaries' && <Boundaries state={state} error={setupError} onAction={onAction} />}
            {state.step === 'ready' && <Ready agentName={agentName} status={irisStatus} onOpenInbox={onOpenInbox} onBack={() => onAction({ type: 'step/back' })} />}
          </motion.div>
        </AnimatePresence>
      </div>
    </section>
  );
}

function Intro({ agentName, onContinue }: { agentName: string; onContinue: () => void }) {
  return <>
    <IrisPrompt>
      <p>Your organization has assigned you {agentName}. Let’s configure your first Partner Program workflow.</p>
      <p>I can research and screen professional evidence. You stay in control of every decision, message, access change, agreement, and payment.</p>
    </IrisPrompt>
    <div className="first-run-actions"><button type="button" className="first-run-primary" onClick={onContinue}>Continue</button></div>
  </>;
}

function Criteria({ agentName, state, onAction }: { agentName: string; state: FirstRunState; onAction: (action: FirstRunAction) => void }) {
  return <>
    <IrisPrompt><p>What should count as a strong Partner Program prospect?</p></IrisPrompt>
    <form className="first-run-custom" onSubmit={(event) => { event.preventDefault(); onAction({ type: 'criteria/confirm' }); }}>
      <label htmlFor="partner-criteria">Partner criteria</label>
      <textarea id="partner-criteria" rows={7} value={state.partnerCriteria}
        onChange={(event) => onAction({ type: 'criteria/change', value: event.target.value })} />
      <p className="first-run-gap"><Icon name="info" size={15} />You can refine industries, stages, locations, signals, and exclusions with {agentName} from Inbox.</p>
      <div className="first-run-actions"><button type="submit" className="first-run-primary" disabled={state.partnerCriteria.trim().length < 10}>Use these criteria</button></div>
    </form>
    <button type="button" className="first-run-back" onClick={() => onAction({ type: 'step/back' })}><Icon name="arrow" size={14} />Back</button>
  </>;
}

function Boundaries({ state, error, onAction }: { state: FirstRunState; error?: string | null; onAction: (action: FirstRunAction) => void }) {
  return <>
    <IrisPrompt><p>Confirm where I stop. Your first AgentCash search will also require a separate approval in Inbox and is capped at $0.15.</p></IrisPrompt>
    <div className="first-run-boundaries" aria-label="Human review boundaries">
      {DEFAULT_BOUNDARIES.map((boundary) => <div className="first-run-boundary" key={boundary.id}>
        <span className="first-run-boundary-check"><Icon name="check" size={13} /></span><span>{boundary.label}</span>
        {state.editingReviewers ? <label><span className="sr-only">Reviewer for {boundary.label}</span>
          <select value={state.reviewers[boundary.id]} onChange={(event) => onAction({ type: 'reviewers/change', id: boundary.id, reviewer: event.target.value as Reviewer })}>
            {REVIEWER_OPTIONS.map((reviewer) => <option key={reviewer}>{reviewer}</option>)}
          </select></label> : <strong>{state.reviewers[boundary.id]}</strong>}
      </div>)}
    </div>
    {error ? <div className="first-run-error" role="alert"><span>{error}</span></div> : null}
    <div className="first-run-actions">
      <button type="button" className="first-run-primary" onClick={() => onAction({ type: 'reviewers/confirm' })}>{state.editingReviewers ? 'Save and continue' : 'Confirm and continue'}</button>
      {!state.editingReviewers ? <button type="button" className="first-run-secondary" onClick={() => onAction({ type: 'reviewers/edit' })}>Change reviewers</button> : null}
    </div>
    <button type="button" className="first-run-back" onClick={() => onAction({ type: 'step/back' })}><Icon name="arrow" size={14} />Back</button>
  </>;
}

function Ready({ agentName, status, onOpenInbox, onBack }: { agentName: string; status: IrisReadyStatus; onOpenInbox?: () => void; onBack: () => void }) {
  const ready = status === 'ready' || status === 'idle';
  return <>
    <IrisPrompt>{ready
      ? <p>Your working agreement is saved. {agentName} is ready, and your first tasks are waiting in Inbox.</p>
      : status === 'retrying'
        ? <p>{agentName} is taking longer than expected. Your answers are saved and setup is retrying safely.</p>
        : <p>Your working agreement is saved. Getting {agentName} ready.</p>}
    </IrisPrompt>
    {!ready ? <div className="first-run-sample-progress" role="status" aria-live="polite"><span className="first-run-sample-label"><span className="first-run-live-dot" />Getting {agentName} ready</span></div> : null}
    {ready ? <div className="first-run-sample-complete" role="status"><span><Icon name="check" size={17} /></span><div><strong>Ready to work</strong><p>Review your partner-criteria task and approve the first capped search when you choose.</p></div><button type="button" onClick={onOpenInbox}>Open Inbox</button></div> : null}
    <button type="button" className="first-run-back" onClick={onBack}><Icon name="arrow" size={14} />Back</button>
  </>;
}

export function FirstRunWorkingAgreement({ state, agreement: supplied }: { state: FirstRunState; agreement?: WorkingAgreement }) {
  const agreement = supplied ?? workingAgreement(state);
  return <aside className="first-run-agreement" aria-label="Working agreement">
    <div className="first-run-agreement-heading"><div><Glass name="agreement" size={32} /><span><h2>Working agreement</h2><p>Partner Program</p></span></div><span className={agreement.readyForWork ? 'is-ready' : ''}>{agreement.readyForWork ? 'Saved' : 'Draft'}</span></div>
    <p className="first-run-mode"><Icon name="loop" size={16} /><span><strong>Work until review</strong>The agent gathers evidence, then stops where a person owns the decision.</span></p>
    <div className="first-run-agreement-fields">
      {[['Goal', agreement.goal], ['Trigger', agreement.trigger], ['Criteria', agreement.inputs], ['Done', agreement.done]].map(([label, value]) => <div className="first-run-agreement-field is-filled" key={label}><span>{label}</span><p>{value}</p></div>)}
      <div className="first-run-agreement-field first-run-agreement-loop is-filled"><span>Loop</span><div className="first-run-agreement-stages">{agreement.stages.map((stage, index) => <span key={stage}>{stage}{index < agreement.stages.length - 1 ? <Icon name="arrow" size={12} /> : null}</span>)}</div></div>
      <div className="first-run-agreement-field first-run-agreement-reviews is-filled"><span>Reviews</span><ul>{agreement.reviews.map((review) => <li key={review.id}><Icon name="shield" size={13} /><span>{review.label}</span><strong>{review.reviewer}</strong></li>)}</ul></div>
    </div>
  </aside>;
}

export { createFirstRunState, firstRunReducer, workingAgreement } from './FirstRunSetup.model.js';
export type { FirstRunAction, FirstRunState, FirstRunStep, Reviewer, WorkingAgreement } from './FirstRunSetup.model.js';
