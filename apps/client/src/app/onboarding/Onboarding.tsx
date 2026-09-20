// Onboarding: two routes, create-workspace and join-workspace.
//
// The demo's identity step is trimmed — WorkOS owns who you are, and asking
// again would be theatre. What is left is what the product needs and the
// database records: a workspace name and the agent's name and instructions.
// The create call persists those fields with a saved instruction version and
// the deterministic setup conversation before the shell opens.
//
// The presenter, the intro slides and the "one week later" interstitial are not
// ported: they were the demo's narration, not the product.
import { useEffect, useState } from 'react';
import type { InvitationPreview } from '@hermes/shared';
import { createRest } from '../../model/rest.js';
import { createAuth } from '../../model/auth.js';
import { Glass, Icon } from '../ui/icons.js';
import { Button, EmptyState, Skeleton } from '../ui/primitives.js';
import { SHELL_PREFIX } from '../../model/routes.js';

const STEPS = [
  ['workspace', 'Workspace'],
  ['agent', 'Your agent'],
  ['context', 'Add context'],
  ['approvals', 'Approvals'],
] as const;

type StepId = (typeof STEPS)[number][0];

const APPROVAL_GATES = [
  { icon: 'loop', title: 'Plans & coordination', detail: 'Plans, budgets and team handoffs', reviewer: 'Workspace admin' },
  { icon: 'context', title: 'Access & records', detail: 'Access, data sharing and record changes', reviewer: 'Workspace admin' },
  { icon: 'inbox', title: 'External communication', detail: 'Messages, documents and signatures', reviewer: 'Workspace admin' },
  { icon: 'invoice', title: 'Money movement', detail: 'Invoices, payments and spend changes', reviewer: 'Admin + Finance' },
  { icon: 'settings', title: 'Agent & team changes', detail: 'Admissions, roles and agent configuration', reviewer: 'Workspace admin' },
  { icon: 'skill', title: 'Shared learning', detail: 'Skills, deliverables and policy exceptions', reviewer: 'Workspace admin' },
] as const;

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

export function Onboarding({ route, token, fetchImpl }: { route: 'create-workspace' | 'join-workspace'; token: string | null; fetchImpl?: typeof fetch }) {
  const auth = createAuth();
  const rest = createRest({ auth, ...(fetchImpl ? { fetchImpl } : {}) });
  const [step, setStep] = useState<StepId>('workspace');
  const [name, setName] = useState('');
  const [agent, setAgent] = useState('Iris');
  const [instructions, setInstructions] = useState('Role\nDiscover and screen partner prospects against the program criteria.\n\nEvery cycle\nPrepare an evidence report and ask for a decision.\n\nAsk first\nAdmissions, documents, sending, payment and signature.');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (route === 'join-workspace') {
    return <JoinWorkspace token={token} rest={rest} auth={auth} />;
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
      .createWorkspace({
        name: name.trim(),
        agent: { name: agent.trim(), instructions: instructions.trim() },
      })
      .then((boot) => window.location.assign(`/${SHELL_PREFIX}/${boot.workspace.id}`))
      .catch((caught: unknown) => {
        const reason = (caught as { reason?: string }).reason;
        setError(
          reason === 'email_unverified'
            ? 'Verify your email address before creating a workspace. An invitation sent from an unverified address is a phishing primitive, so the server refuses it.'
              : reason === 'rate_limited'
                ? 'Three workspaces a day, per person. Try again tomorrow.'
              : reason === 'bad_name'
                ? 'A workspace needs a name of 2 to 80 characters.'
                : reason === 'bad_agent_name'
                  ? 'The agent needs a name of 1 to 80 characters.'
                  : reason === 'bad_instructions'
                    ? 'Add instructions of up to 8,000 characters.'
                : 'Could not create the workspace. Try again.',
        );
        setBusy(false);
      });
  };

  return (
    <div className={step === 'approvals' ? 'portal onboarding-approval-portal' : 'portal'}>
      <header className="portal-header">
        <div className="pl">
          <Glass name="iris" size={30} />
          <span>Hermes</span>
        </div>
      </header>
      <Stepper step={step} />
      <div className={step === 'approvals' ? 'portal-body wide onboarding-approval-body' : 'portal-body'}>
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
              Sources can be stored in Agent Context or attached to a message. {agent} receives only the sources selected for that work; nothing is imported automatically during setup.
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
            <div className="onboarding-approval-heading">
              <h1 className="portal-title">Review boundaries</h1>
              <span className="onboarding-protected"><Icon name="shield" size={15} /> Human review required</span>
            </div>
            <div className="onboarding-approval-flow" aria-label="How an approval works">
              <div className="onboarding-approval-step">
                <span className="onboarding-approval-icon"><Glass name="iris" size={34} /></span>
                <strong>Iris prepares</strong>
              </div>
              <Icon name="arrow" size={18} className="onboarding-flow-arrow" />
              <div className="onboarding-approval-step">
                <span className="onboarding-approval-icon"><Glass name="inbox" size={32} /></span>
                <strong>A reviewer decides</strong>
              </div>
              <Icon name="arrow" size={18} className="onboarding-flow-arrow" />
              <div className="onboarding-approval-step">
                <span className="onboarding-approval-icon"><Icon name="check" size={20} /></span>
                <strong>The outcome is recorded</strong>
              </div>
            </div>
            <div className="onboarding-approval-grid">
              {APPROVAL_GATES.map((gate) => (
                <article className="onboarding-approval-card" key={gate.title}>
                  <span className="onboarding-approval-icon"><Glass name={gate.icon} size={31} /></span>
                  <div className="col grow onboarding-approval-copy">
                    <strong>{gate.title}</strong>
                    <span>{gate.detail}</span>
                    <span className="onboarding-reviewer"><Icon name="users" size={13} /> {gate.reviewer}</span>
                  </div>
                </article>
              ))}
            </div>
            <p className="meta onboarding-approval-note">Add finance or specialist reviewers later. Approval and execution remain separate: unsupported external actions stay pending.</p>
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

/**
 * Accepting an invitation, through the route that exists.
 *
 * This used to hand the token to `/auth/login` and hope: there was no accept
 * route, so an invitation could only be honoured by WorkOS mirroring the
 * membership on the way back, which does not happen in `AUTH_MODE=fake` at
 * all. `POST /invitations/:token/accept` is that route now (server decision
 * F2), and it answers with the whole workspace from inside the transaction
 * that admitted them — so the shell is one navigation away and there is no
 * window in which they are a member of a workspace that reads as missing.
 *
 * The token says which invitation; the session says who. A 401 means nobody is
 * signed in yet, and the honest move is to sign in and come back rather than
 * to post the token again.
 */
function JoinWorkspace({ token, rest, auth }: { token: string | null; rest: ReturnType<typeof createRest>; auth: ReturnType<typeof createAuth> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [me, setMe] = useState<{ email: string } | null>(null);
  const [checked, setChecked] = useState(false);
  const [preview, setPreview] = useState<InvitationPreview | null>(null);
  const [refusal, setRefusal] = useState<string | null>(null);

  // What this link joins, from the token-scoped read. The same token that
  // will be accepted, so an unknown or withdrawn one is refused here with the
  // words the accept would have used, before anyone clicks.
  useEffect(() => {
    if (!token) return;
    let live = true;
    void rest
      .previewInvitation(token)
      .then((found) => {
        if (live) setPreview(found);
      })
      .catch((caught: unknown) => {
        if (!live) return;
        const failure = caught as { status?: number; reason?: string };
        if (failure.reason === 'invitation_email_mismatch') setRefusal(MISMATCH);
        else if (failure.reason === 'invitation_unavailable') setRefusal(UNAVAILABLE);
        else if (failure.reason === 'email_unverified') setRefusal(UNVERIFIED);
        // Anything else (offline, a 500) leaves the page nameless but usable:
        // the accept itself is the authority and will say what is wrong.
      });
    return () => {
      live = false;
    };
  }, [rest, token]);

  // Who is signed in, if anyone. `GET /auth/session` with no `?ws` answers
  // that without naming a workspace (server decision F7); a 404 means signed
  // in but in no workspace yet, which is exactly the person this screen is for.
  useEffect(() => {
    let live = true;
    void rest
      .authWorkspaces()
      .then((session) => {
        if (live) setMe({ email: session.user.email });
      })
      .catch(() => undefined)
      .finally(() => {
        if (live) setChecked(true);
      });
    return () => {
      live = false;
    };
  }, [rest]);

  const accept = (): void => {
    if (!token) return;
    setBusy(true);
    setError(null);
    void rest
      .acceptInvitation(token)
      .then((boot) => window.location.assign(`/${SHELL_PREFIX}/${boot.workspace.id}`))
      .catch((caught: unknown) => {
        const failure = caught as { status?: number; reason?: string };
        if (failure.status === 401) {
          window.location.assign(auth.signInUrl(window.location.href));
          return;
        }
        setError(
          failure.reason === 'invitation_email_mismatch'
            ? MISMATCH
            : failure.reason === 'invitation_unavailable'
              ? UNAVAILABLE
              : failure.reason === 'email_unverified'
                ? UNVERIFIED
                : 'Could not accept this invitation. Try again.',
        );
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
      <div className="portal-body" style={{ alignItems: 'center', paddingTop: 100, width: 560, gap: 24 }}>
        <h1 style={{ font: '500 35.2px/38.4px var(--font-display)', textAlign: 'center' }}>
          {preview ? `Join ${preview.workspace.name}` : 'Join a workspace'}
        </h1>
        {!checked ? (
          <Skeleton rows={2} label="Checking your session" />
        ) : !token ? (
          <EmptyState icon="context" title="This link is missing its invitation token" detail="Ask whoever invited you to send it again." />
        ) : refusal ? (
          <p className="meta" role="alert" style={{ textAlign: 'center' }}>
            {refusal}
          </p>
        ) : (
          <>
            {preview && (
              <p className="join-invitation-summary">
                {preview.invited_by ? `${preview.invited_by} invited you` : 'You were invited'} to join as {invitationRoleLabel(preview)}.
                {' '}The invitation is open until {new Date(preview.expires_at).toLocaleDateString()}.
              </p>
            )}
            <p className="meta" style={{ textAlign: 'center' }}>
              Accepting this invitation adds you to the workspace with the role it was sent with. A Member works with agents and reads every request; only an Admin records a decision.
            </p>
            {me && <p className="meta">Signed in as {me.email}. The invitation has to have been sent to this address.</p>}
            {error && (
              <p className="meta" role="alert" style={{ textAlign: 'center' }}>
                {error}
              </p>
            )}
            <button type="button" className="portal-btn" style={{ width: 320 }} disabled={busy} onClick={accept}>
              {busy ? 'Accepting…' : 'Accept invitation'}
            </button>
          </>
        )}
      </div>
    </div>
  );
}

const MISMATCH = 'This invitation was sent to a different address. A forwarded link does not admit whoever opens it; ask for one addressed to you.';
const UNAVAILABLE = 'This invitation is not open. It may have been withdrawn, already accepted, or expired — ask for a new one.';
const UNVERIFIED = 'Verify your email address before accepting an invitation. An unverified address is not an identity, so it cannot be the one the invitation is matched on.';

/** "a Finance member", "a Partnerships member", "an Admin", "a Member". */
export function invitationRoleLabel(invitation: { role: 'admin' | 'member'; role_template_key: string | null }): string {
  if (invitation.role_template_key === 'finance-agent') return 'a Finance member';
  if (invitation.role_template_key === 'partnerships-agent') return 'a Partnerships member';
  return invitation.role === 'admin' ? 'an Admin' : 'a Member';
}

export function SignIn({ returnTo }: { returnTo: string | null }) {
  const auth = createAuth();
  return (
    <div className="portal">
      <div className="portal-body" style={{ alignItems: 'center', paddingTop: 140, width: 480, gap: 20 }}>
        <Glass name="iris" size={56} />
        <h1 style={{ font: '500 32px/35.2px var(--font-display)' }}>Sign in to Hermes</h1>
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
