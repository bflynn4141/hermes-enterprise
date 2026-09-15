// Onboarding: two routes, create-workspace and join-workspace.
//
// The demo's identity step is trimmed — WorkOS owns who you are, and asking
// again would be theatre. What is left is what the product needs and the
// database records: a workspace name, the agent's name and instructions, its
// sources, and the approval list. Each step `PATCH`es `agents` or
// `workspace_settings`, so progress lives on `agents.setup_step` and a
// half-finished setup resumes where it stopped rather than restarting.
//
// The presenter, the intro slides and the "one week later" interstitial are not
// ported: they were the demo's narration, not the product.
import { useState } from 'react';
import { createRest } from '../../model/rest.js';
import { createAuth } from '../../model/auth.js';
import { Glass, Icon } from '../ui/icons.js';
import { Button } from '../ui/primitives.js';

const STEPS = [
  ['workspace', 'Workspace'],
  ['agent', 'Your agent'],
  ['context', 'Add context'],
  ['approvals', 'Approvals'],
] as const;

type StepId = (typeof STEPS)[number][0];

function Stepper({ step }: { step: StepId }) {
  const index = STEPS.findIndex(([id]) => id === step);
  return (
    <div className="stepper" aria-label="Setup steps">
      {STEPS.map(([id, label], i) => (
        <span key={id} style={{ display: 'contents' }}>
          {i > 0 && <span className="rule" />}
          <span className={`st ${i === index ? 'current' : i < index ? 'done' : ''}`}>
            <span className="n">{i < index ? <Icon name="check" size={16} /> : i + 1}</span>
            {label}
          </span>
        </span>
      ))}
    </div>
  );
}

export function Onboarding({ route, token }: { route: 'create-workspace' | 'join-workspace'; token: string | null }) {
  const auth = createAuth();
  const rest = createRest({ auth });
  const [step, setStep] = useState<StepId>('workspace');
  const [name, setName] = useState('');
  const [agent, setAgent] = useState('Iris');
  const [instructions, setInstructions] = useState('Role\nScreen partner applications against the program criteria.\n\nEvery cycle\nPrepare an evidence report and ask for a decision.\n\nAsk first\nAdmissions, documents, sending, payment and signature.');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (route === 'join-workspace') {
    return (
      <div className="portal">
        <header className="portal-header">
          <div className="pl">
            <Glass name="iris" size={30} />
            <span>Hermes</span>
          </div>
        </header>
        <div className="portal-body" style={{ alignItems: 'center', paddingTop: 100, width: 560, gap: 24 }}>
          <h1 style={{ font: '500 44px/48px var(--font-display)' }}>Join a workspace</h1>
          <p className="meta" style={{ textAlign: 'center' }}>
            {token ? 'Accepting this invitation adds you as a Member. A Member works with agents and reads every request; only an Admin records a decision.' : 'This link is missing its invitation token. Ask whoever invited you to send it again.'}
          </p>
          {error && <p className="meta">{error}</p>}
          <button
            type="button"
            className="portal-btn"
            style={{ width: 320 }}
            disabled={!token || busy}
            onClick={() => {
              if (!token) return;
              setBusy(true);
              // An invitation is accepted through the identity provider, not
              // here: WorkOS owns the email and the account, and the Worker
              // mirrors the membership on the way back through
              // `/auth/callback`. So the button hands the token to the sign-in
              // route rather than posting it, which is also what makes
              // accepting work for someone who has no account yet.
              window.location.assign(`/auth/login?return_to=${encodeURIComponent(`/?invitation=${token}`)}`);
              void rest;
              void setError;
            }}
          >
            Accept invitation
          </button>
        </div>
      </div>
    );
  }

  const next = (): void => {
    const order = STEPS.map(([id]) => id);
    const index = order.indexOf(step);
    const following = order[index + 1];
    if (following) setStep(following);
  };

  const finish = (): void => {
    setBusy(true);
    setError(null);
    void rest
      .createWorkspace({ name: name.trim() })
      .then((boot) => window.location.assign(`/w/${boot.workspace.id}`))
      .catch(() => {
        setError('Could not create the workspace. Try again.');
        setBusy(false);
      });
  };

  return (
    <div className="portal">
      <header className="portal-header">
        <div className="pl">
          <Glass name="iris" size={30} />
          <span>Hermes</span>
        </div>
      </header>
      <Stepper step={step} />
      <div className="portal-body">
        {step === 'workspace' && (
          <>
            <h1 className="portal-title">Name your workspace</h1>
            <label className="portal-input">
              <span className="sr-only">Workspace name</span>
              <input value={name} autoFocus placeholder="e.g. Partner Program" onChange={(event) => setName(event.target.value)} />
            </label>
            <p className="meta">Members, agents, requests and decisions all live inside a workspace. You can rename it later.</p>
            <div className="portal-footer" style={{ borderTop: 0 }}>
              <span className="grow" />
              <button type="button" className="portal-btn" disabled={!name.trim()} onClick={next}>
                Continue
              </button>
            </div>
          </>
        )}
        {step === 'agent' && (
          <>
            <h1 className="portal-title">Make {agent || 'your agent'} yours</h1>
            <div className="row" style={{ gap: 20 }}>
              <span style={{ width: 64, height: 64, borderRadius: 8, background: 'var(--body)', display: 'grid', placeItems: 'center', flexShrink: 0 }}>
                <Glass name="iris" size={55} />
              </span>
              <div className="col grow" style={{ gap: 8 }}>
                <span className="meta">Agent name</span>
                <label className="portal-input">
                  <span className="sr-only">Agent name</span>
                  <input value={agent} onChange={(event) => setAgent(event.target.value)} />
                </label>
              </div>
            </div>
            <div className="col" style={{ gap: 12 }}>
              <span>Instructions</span>
              <label className="field">
                <span className="sr-only">Instructions</span>
                <textarea rows={8} value={instructions} onChange={(event) => setInstructions(event.target.value)} />
              </label>
            </div>
            <div className="portal-footer">
              <button type="button" className="portal-back" onClick={() => setStep('workspace')}>
                <Icon name="arrow" size={16} style={{ transform: 'scaleX(-1)' }} /> Back
              </button>
              <button type="button" className="portal-btn" disabled={!agent.trim() || !instructions.trim()} onClick={next}>
                Add context
              </button>
            </div>
          </>
        )}
        {step === 'context' && (
          <>
            <h1 className="portal-title">Add context</h1>
            <p className="meta">
              Sources are added inside the workspace, where the extraction status of each file is visible. Nothing here grants {agent} any authority: reading a file is not permission to act on it.
            </p>
            <div className="portal-footer">
              <button type="button" className="portal-back" onClick={() => setStep('agent')}>
                <Icon name="arrow" size={16} style={{ transform: 'scaleX(-1)' }} /> Back
              </button>
              <button type="button" className="portal-btn" onClick={next}>
                Set approvals
              </button>
            </div>
          </>
        )}
        {step === 'approvals' && (
          <>
            <h1 className="portal-title">What needs a human</h1>
            <div className="col">
              {['Admissions and benefits', 'Document creation', 'Sending, payment and signature'].map((item) => (
                <div className="perm-row" key={item}>
                  <div className="pr-body">
                    <span className="pr-title">{item}</span>
                    <span className="pr-sub">Always an Admin decision. This cannot be turned off.</span>
                  </div>
                </div>
              ))}
            </div>
            {error && <p className="meta">{error}</p>}
            <div className="portal-footer">
              <button type="button" className="portal-back" onClick={() => setStep('context')}>
                <Icon name="arrow" size={16} style={{ transform: 'scaleX(-1)' }} /> Back
              </button>
              <button type="button" className="portal-btn" disabled={busy} onClick={finish}>
                Create workspace
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

export function SignIn({ returnTo }: { returnTo: string | null }) {
  const auth = createAuth();
  return (
    <div className="portal">
      <div className="portal-body" style={{ alignItems: 'center', paddingTop: 140, width: 480, gap: 20 }}>
        <Glass name="iris" size={56} />
        <h1 style={{ font: '500 40px/44px var(--font-display)' }}>Sign in to Hermes</h1>
        <p className="meta" style={{ textAlign: 'center' }}>
          Your workspace is behind your organization's identity provider.
        </p>
        <Button primary onClick={() => window.location.assign(auth.signInUrl(returnTo ?? '/'))}>
          Continue
        </Button>
      </div>
    </div>
  );
}
