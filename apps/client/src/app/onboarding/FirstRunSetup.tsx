import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { useEffect, useMemo, useReducer, useState, type ReactNode } from 'react';
import { Glass, Icon } from '../ui/icons.js';
import {
  DEFAULT_BOUNDARIES,
  FIRST_RUN_STEPS,
  REVIEWER_OPTIONS,
  ROLE_OPTIONS,
  boundariesForRole,
  createFirstRunState,
  firstRunReducer,
  loopsForRole,
  selectedLoop,
  workingAgreement,
  type FirstRunAction,
  type FirstRunState,
  type FirstRunStep,
  type Reviewer,
  type RoleId,
  type WorkingAgreement,
} from './FirstRunSetup.model.js';

export type ProviderStatus = 'disconnected' | 'encrypting' | 'verifying' | 'syncing' | 'ready' | 'error';
export type SampleStatus = 'idle' | 'running' | 'complete' | 'error';

export interface FirstRunSetupProps {
  agentName?: string;
  ownerName?: string;
  state?: FirstRunState;
  initialState?: FirstRunState;
  providerStatus?: ProviderStatus;
  providerSlot?: ReactNode;
  sampleStatus?: SampleStatus;
  completedSampleStages?: readonly string[];
  onAgreementChange?: (agreement: WorkingAgreement) => void;
  onStateChange?: (state: FirstRunState, agreement: WorkingAgreement) => void;
  onReadyForTest?: (state: FirstRunState, agreement: WorkingAgreement) => void;
  onAction?: (action: FirstRunAction) => void;
  onRunSample?: () => void;
  onOpenSample?: () => void;
}

const STEP_LABELS: Record<FirstRunStep, string> = { role: 'Role', loop: 'Loop', boundaries: 'Boundaries', test: 'Test' };
const MOTION = { duration: 0.18, ease: [0.22, 1, 0.36, 1] as const };

export function FirstRunSetup({
  agentName = 'Iris',
  ownerName = 'Maya',
  state: controlledState,
  initialState,
  providerStatus = 'disconnected',
  providerSlot,
  sampleStatus = 'idle',
  completedSampleStages = [],
  onAgreementChange,
  onStateChange,
  onReadyForTest,
  onAction,
  onRunSample,
  onOpenSample,
}: FirstRunSetupProps) {
  const [internalState, internalDispatch] = useReducer(firstRunReducer, initialState ?? createFirstRunState());
  const state = controlledState ?? internalState;
  const agreement = useMemo(() => workingAgreement(state), [state]);

  useEffect(() => {
    onAgreementChange?.(agreement);
    onStateChange?.(state, agreement);
  }, [agreement, onAgreementChange, onStateChange, state]);

  const dispatch = (action: FirstRunAction): void => {
    if (!controlledState) internalDispatch(action);
    onAction?.(action);
    if (action.type === 'reviewers/confirm') {
      const next = firstRunReducer(state, action);
      onReadyForTest?.(next, workingAgreement(next));
    }
  };

  return (
    <section className="first-run-setup" aria-label={`Set up ${agentName}`}>
      <header className="first-run-header">
        <div className="first-run-title">
          <Glass name="iris" size={30} />
          <div>
            <h1>Set up {agentName}</h1>
            <p>Build one useful loop together</p>
          </div>
        </div>
        <FirstRunProgress current={state.step} />
      </header>

      <div className="first-run-grid">
        <FirstRunConversation
          state={state}
          onAction={dispatch}
          agentName={agentName}
          ownerName={ownerName}
          providerStatus={providerStatus}
          providerSlot={providerSlot}
          sampleStatus={sampleStatus}
          completedSampleStages={completedSampleStages}
          onRunSample={onRunSample}
          onOpenSample={onOpenSample}
        />
        <FirstRunWorkingAgreement state={state} agreement={agreement} />
      </div>
    </section>
  );
}

export interface FirstRunConversationProps {
  state: FirstRunState;
  onAction: (action: FirstRunAction) => void;
  agentName?: string;
  ownerName?: string;
  providerStatus?: ProviderStatus;
  providerSlot?: ReactNode;
  sampleStatus?: SampleStatus;
  completedSampleStages?: readonly string[];
  onRunSample?: () => void;
  onOpenSample?: () => void;
}

export function FirstRunConversation({
  state,
  onAction,
  agentName = 'Iris',
  ownerName = 'Maya',
  providerStatus = 'disconnected',
  providerSlot,
  sampleStatus = 'idle',
  completedSampleStages = [],
  onRunSample,
  onOpenSample,
}: FirstRunConversationProps) {
  const reduceMotion = useReducedMotion() ?? false;
  const [customRole, setCustomRole] = useState('');
  const loop = selectedLoop(state);
  const transition = reduceMotion ? { duration: 0.08 } : MOTION;
  return (
    <section className="first-run-conversation" aria-label={`Conversation with ${agentName}`}>
      <div className="first-run-conversation-meta">
        <span>{agentName}</span>
        <span className="first-run-deterministic">Setup guide</span>
      </div>
      <div className="first-run-transcript" role="log" aria-live="polite">
        <ConversationHistory state={state} agentName={agentName} ownerName={ownerName} />
        <AnimatePresence mode="wait" initial={false}>
          <motion.div
            key={`${state.step}:${state.loopId ?? ''}:${state.editingReviewers}:${providerStatus}:${sampleStatus}`}
            className="first-run-current"
            initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -4 }}
            transition={transition}
          >
            {state.step === 'role' ? (
              <RoleQuestion customRole={customRole} setCustomRole={setCustomRole} onSelect={(id, label) => onAction({ type: 'role/select', id, label })} onCustom={() => onAction({ type: 'role/custom', label: customRole })} />
            ) : null}
            {state.step === 'loop' ? (
              <LoopQuestion state={state} onSelect={(id) => onAction({ type: 'loop/select', id })} onConfirm={() => onAction({ type: 'loop/confirm' })} onAdjust={() => onAction({ type: 'loop/adjust' })} onBack={() => onAction({ type: 'step/back' })} />
            ) : null}
            {state.step === 'boundaries' ? (
              <BoundaryQuestion state={state} onEdit={() => onAction({ type: 'reviewers/edit' })} onChange={(id, reviewer) => onAction({ type: 'reviewers/change', id, reviewer })} onConfirm={() => onAction({ type: 'reviewers/confirm' })} onBack={() => onAction({ type: 'step/back' })} />
            ) : null}
            {state.step === 'test' ? (
              <TestQuestion
                providerStatus={providerStatus}
                providerSlot={providerSlot}
                sampleStatus={sampleStatus}
                completedSampleStages={completedSampleStages}
                stages={loop?.stages ?? []}
                onRunSample={onRunSample}
                onOpenSample={onOpenSample}
                onBack={() => onAction({ type: 'step/back' })}
              />
            ) : null}
          </motion.div>
        </AnimatePresence>
      </div>
    </section>
  );
}

export function FirstRunProgress({ current }: { current: FirstRunStep }) {
  const currentIndex = FIRST_RUN_STEPS.indexOf(current);
  return (
    <ol className="first-run-progress" aria-label="Setup progress">
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
  return (
    <div className="first-run-iris-message">
      <Glass name="iris" size={28} />
      <div className="first-run-message-copy">{children}</div>
    </div>
  );
}

function ConversationHistory({ state, agentName, ownerName }: { state: FirstRunState; agentName: string; ownerName: string }) {
  const loop = selectedLoop(state);
  return (
    <div className="first-run-history" aria-label="Earlier setup answers">
      {state.step !== 'role' ? (
        <>
          <IrisPrompt>Let’s set up the work you want me to repeat. What do you own?</IrisPrompt>
          <div className="first-run-user-message"><span>{ownerName}</span>{state.roleLabel}</div>
        </>
      ) : null}
      {state.loopConfirmed && loop ? (
        <>
          <IrisPrompt>Which loop should I run first?</IrisPrompt>
          <div className="first-run-user-message"><span>{ownerName}</span>{loop.label}</div>
        </>
      ) : null}
      {state.step === 'test' ? (
        <>
          <IrisPrompt>Should all four stop in your Inbox?</IrisPrompt>
          <div className="first-run-user-message"><span>{ownerName}</span>Yes, keep these review boundaries</div>
        </>
      ) : null}
      <span className="sr-only">{agentName} is guiding this setup before model access is connected.</span>
    </div>
  );
}

function RoleQuestion({ customRole, setCustomRole, onSelect, onCustom }: { customRole: string; setCustomRole: (value: string) => void; onSelect: (id: RoleId, label: string) => void; onCustom: () => void }) {
  const [showCustom, setShowCustom] = useState(false);
  return (
    <>
      <IrisPrompt>
        <p>Let’s set up the work you want me to repeat. What do you own?</p>
      </IrisPrompt>
      <div className="first-run-choices" aria-label="Choose your role">
        {ROLE_OPTIONS.filter((role) => role.id !== 'custom').map((role) => (
          <button key={role.id} type="button" className="first-run-choice" onClick={() => onSelect(role.id, role.label)}>
            {role.label}<Icon name="arrow" size={15} />
          </button>
        ))}
        <button type="button" className="first-run-choice" aria-expanded={showCustom} onClick={() => setShowCustom((shown) => !shown)}>
          Something else<Icon name={showCustom ? 'up' : 'plus'} size={15} />
        </button>
      </div>
      {showCustom ? (
        <form className="first-run-custom" onSubmit={(event) => { event.preventDefault(); onCustom(); }}>
          <label htmlFor="first-run-custom-role">Describe what you own</label>
          <div>
            <input id="first-run-custom-role" value={customRole} autoFocus placeholder="e.g. Community operations" onChange={(event) => setCustomRole(event.target.value)} />
            <button type="submit" disabled={!customRole.trim()}>Continue</button>
          </div>
        </form>
      ) : null}
    </>
  );
}

function LoopQuestion({ state, onSelect, onConfirm, onAdjust, onBack }: { state: FirstRunState; onSelect: (id: FirstRunState['loopId'] & {}) => void; onConfirm: () => void; onAdjust: () => void; onBack: () => void }) {
  const loop = selectedLoop(state);
  if (loop) {
    return (
      <>
        <IrisPrompt>
          <p>For each {state.loopId === 'screen-partners' ? 'application' : 'item'}, I can research the evidence and prepare a recommendation. You decide what happens next.</p>
        </IrisPrompt>
        <div className="first-run-loop-preview" aria-label="Proposed work loop">
          {loop.stages.map((stage, index) => <span key={stage}>{stage}{index < loop.stages.length - 1 ? <Icon name="arrow" size={14} /> : null}</span>)}
        </div>
        <div className="first-run-actions">
          <button type="button" className="first-run-primary" onClick={onConfirm}>Use this loop</button>
          <button type="button" className="first-run-secondary" onClick={onAdjust}>Adjust</button>
        </div>
      </>
    );
  }
  return (
    <>
      <IrisPrompt><p>Which loop should I run first?</p></IrisPrompt>
      <div className="first-run-choices" aria-label="Choose the first loop">
        {loopsForRole(state.roleId).map((option) => (
          <button key={option.id} type="button" className="first-run-choice" onClick={() => onSelect(option.id)}>{option.label}<Icon name="arrow" size={15} /></button>
        ))}
      </div>
      <button type="button" className="first-run-back" onClick={onBack}><Icon name="arrow" size={14} />Back</button>
    </>
  );
}

function BoundaryQuestion({ state, onEdit, onChange, onConfirm, onBack }: { state: FirstRunState; onEdit: () => void; onChange: (id: (typeof DEFAULT_BOUNDARIES)[number]['id'], reviewer: Reviewer) => void; onConfirm: () => void; onBack: () => void }) {
  const boundaries = boundariesForRole(state.roleId);
  return (
    <>
      <IrisPrompt><p>Should all four stop in your Inbox?</p></IrisPrompt>
      <div className="first-run-boundaries" aria-label="Review boundaries">
        {boundaries.map((boundary) => (
          <div className="first-run-boundary" key={boundary.id}>
            <span className="first-run-boundary-check"><Icon name="check" size={13} /></span>
            <span>{boundary.label}</span>
            {state.editingReviewers ? (
              <label>
                <span className="sr-only">Reviewer for {boundary.label}</span>
                <select value={state.reviewers[boundary.id]} onChange={(event) => onChange(boundary.id, event.target.value as Reviewer)}>
                  {REVIEWER_OPTIONS.map((reviewer) => <option key={reviewer}>{reviewer}</option>)}
                </select>
              </label>
            ) : <strong>{state.reviewers[boundary.id]}</strong>}
          </div>
        ))}
      </div>
      <p className="first-run-gap"><Icon name="info" size={15} />Program criteria and financial terms stay unset until you add real source material.</p>
      <div className="first-run-actions">
        <button type="button" className="first-run-primary" onClick={onConfirm}>{state.editingReviewers ? 'Save boundaries' : 'Yes'}</button>
        {!state.editingReviewers ? <button type="button" className="first-run-secondary" onClick={onEdit}>Change reviewers</button> : null}
      </div>
      <button type="button" className="first-run-back" onClick={onBack}><Icon name="arrow" size={14} />Back</button>
    </>
  );
}

function TestQuestion({ providerStatus, providerSlot, sampleStatus, completedSampleStages, stages, onRunSample, onOpenSample, onBack }: { providerStatus: ProviderStatus; providerSlot?: ReactNode; sampleStatus: SampleStatus; completedSampleStages: readonly string[]; stages: readonly string[]; onRunSample?: () => void; onOpenSample?: () => void; onBack: () => void }) {
  const providerReady = providerStatus === 'ready';
  return (
    <>
      <IrisPrompt>
        {providerReady ? <p>I’m ready. Want to see the loop with a sample application? Nothing will be sent or changed.</p> : <p>Connect Nous Portal, then we can run one safe sample. Nothing will be sent or changed.</p>}
      </IrisPrompt>
      {!providerReady ? (
        <div className="first-run-provider-slot" data-testid="first-run-provider-slot">
          {providerSlot ?? <DefaultProviderSlot status={providerStatus} />}
        </div>
      ) : null}
      {providerReady && sampleStatus === 'idle' ? (
        <button type="button" className="first-run-sample" onClick={onRunSample} disabled={!onRunSample}>
          <Glass name="admission" size={32} />
          <span><strong>Run sample application</strong><small>Uses sample data and creates no external effects</small></span>
          <Icon name="arrow" size={16} />
        </button>
      ) : null}
      {providerReady && sampleStatus === 'running' ? <SampleProgress stages={stages} completed={completedSampleStages} /> : null}
      {providerReady && sampleStatus === 'complete' ? (
        <div className="first-run-sample-complete" role="status">
          <span><Icon name="check" size={17} /></span>
          <div><strong>Sample brief is ready</strong><p>Sources, evidence and the approval consequence are waiting in Inbox.</p></div>
          <button type="button" onClick={onOpenSample} disabled={!onOpenSample}>Open sample</button>
        </div>
      ) : null}
      {sampleStatus === 'error' ? <p className="first-run-error" role="alert">The sample could not finish. Nothing was sent or changed. Try again when the provider is available.</p> : null}
      <button type="button" className="first-run-back" onClick={onBack}><Icon name="arrow" size={14} />Back</button>
    </>
  );
}

function DefaultProviderSlot({ status }: { status: ProviderStatus }) {
  const active = status === 'encrypting' ? 'Encrypting key…' : status === 'verifying' ? 'Verifying with Nous…' : status === 'syncing' ? 'Syncing models…' : null;
  return (
    <div className="first-run-provider-fallback">
      <span className="first-run-provider-icon"><Icon name="key" size={18} /></span>
      <div>
        <strong>Connect Nous Portal</strong>
        <p>{active ?? (status === 'error' ? 'Connection needs attention. Try verification again.' : 'Open Nous Portal to create a key, then connect it here.')}</p>
      </div>
      {active ? <span className="first-run-status">{active}</span> : <a href="https://portal.nousresearch.com/api-keys" target="_blank" rel="noreferrer">Open Nous Portal<Icon name="external" size={14} /></a>}
    </div>
  );
}

function SampleProgress({ stages, completed }: { stages: readonly string[]; completed: readonly string[] }) {
  return (
    <div className="first-run-sample-progress" aria-label="Sample progress">
      <span className="first-run-sample-label"><span className="first-run-live-dot" />Running safe sample</span>
      <ol>
        {stages.map((stage) => {
          const done = completed.includes(stage);
          return <li key={stage} className={done ? 'is-complete' : ''}>{done ? <Icon name="check" size={13} /> : <span />}{stage}</li>;
        })}
      </ol>
    </div>
  );
}

export interface FirstRunWorkingAgreementProps {
  state: FirstRunState;
  agreement?: WorkingAgreement;
}

export function FirstRunWorkingAgreement({ state, agreement: suppliedAgreement }: FirstRunWorkingAgreementProps) {
  const reduceMotion = useReducedMotion() ?? false;
  const agreement = suppliedAgreement ?? workingAgreement(state);
  const transition = reduceMotion ? { duration: 0.08 } : MOTION;
  const fields = [
    { id: 'goal', label: 'Goal', value: agreement.goal },
    { id: 'trigger', label: 'Trigger', value: agreement.trigger },
    { id: 'inputs', label: 'Inputs', value: agreement.inputs },
    { id: 'done', label: 'Done', value: agreement.done },
  ];
  return (
    <aside className="first-run-agreement" aria-label="Working agreement">
      <div className="first-run-agreement-heading">
        <div><Glass name="agreement" size={32} /><span><h2>Working agreement</h2><p>{agreement.readyForTest ? 'Ready for a safe test' : 'Updates as you answer'}</p></span></div>
        <span className={agreement.readyForTest ? 'is-ready' : ''}>{agreement.readyForTest ? 'Ready' : 'Draft'}</span>
      </div>
      <p className="first-run-mode"><Icon name="loop" size={16} /><span><strong>Work until review</strong>Iris gathers and organizes evidence, then stops where a person owns the decision.</span></p>
      <div className="first-run-agreement-fields">
        {fields.slice(0, 3).map((field) => <AgreementField key={field.id} {...field} transition={transition} />)}
        <motion.div layout className={`first-run-agreement-field first-run-agreement-loop ${agreement.stages.length ? 'is-filled' : ''}`} transition={transition}>
          <span>Loop</span>
          <AnimatePresence mode="wait" initial={false}>
            {agreement.stages.length ? (
              <motion.div key={agreement.stages.join(':')} className="first-run-agreement-stages" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={transition}>
                {agreement.stages.map((stage, index) => <span key={stage}>{stage}{index < agreement.stages.length - 1 ? <Icon name="arrow" size={12} /> : null}</span>)}
              </motion.div>
            ) : <motion.p key="empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={transition}>Set after you choose a loop</motion.p>}
          </AnimatePresence>
        </motion.div>
        <motion.div layout className={`first-run-agreement-field first-run-agreement-reviews ${agreement.reviews.length ? 'is-filled' : ''}`} transition={transition}>
          <span>Reviews</span>
          {agreement.reviews.length ? (
            <motion.ul layout initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={transition}>
              {agreement.reviews.map((review) => <li key={review.id}><Icon name="shield" size={13} /><span>{review.label}</span><strong>{review.reviewer}</strong></li>)}
            </motion.ul>
          ) : <p>Set after you confirm the loop</p>}
        </motion.div>
        <AgreementField {...fields[3]!} transition={transition} />
      </div>
      {state.loopId === 'screen-partners' ? <p className="first-run-source-gap"><Icon name="info" size={14} /><span><strong>Source gap</strong>Program criteria are not added yet. Iris will flag the gap instead of inventing criteria.</span></p> : null}
    </aside>
  );
}

function AgreementField({ label, value, transition }: { id?: string; label: string; value: string | null; transition: { duration: number; ease?: readonly [number, number, number, number] } }) {
  return (
    <motion.div layout className={`first-run-agreement-field ${value ? 'is-filled' : ''}`} transition={transition}>
      <span>{label}</span>
      <AnimatePresence mode="wait" initial={false}>
        <motion.p key={value ?? 'empty'} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={transition}>{value ?? 'Set after you answer'}</motion.p>
      </AnimatePresence>
    </motion.div>
  );
}

export { createFirstRunState, firstRunReducer, workingAgreement } from './FirstRunSetup.model.js';
export type { FirstRunAction, FirstRunState, FirstRunStep, WorkingAgreement } from './FirstRunSetup.model.js';
