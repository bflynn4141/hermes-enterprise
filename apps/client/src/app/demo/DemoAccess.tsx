// `/demo` — the public Hermes Enterprise Demo landing page.
//
// Anyone can read the write-up and share links. Requesting a Member invitation
// needs a work email and the passcode the recruiter forwarded. There is no
// separate password gate: the passcode only protects the invite action.
import { useState, type FormEvent } from 'react';
import {
  DEMO_ACCESS_EMAIL_MAX,
  DEMO_ACCESS_PASSCODE_MAX,
  demoAccessResponseSchema,
  type DemoAccessErrorReason,
} from '@hermes/shared';
import { Glass } from '../ui/icons.js';
import { createAuth } from '../../model/auth.js';

type ErrorReason = DemoAccessErrorReason | 'demo_access_not_configured' | 'unavailable';

type FormPhase =
  | { kind: 'idle' }
  | { kind: 'submitting' }
  | { kind: 'invited'; email: string }
  | { kind: 'already_member'; email: string }
  | { kind: 'error'; reason: ErrorReason };

const ERROR_COPY: Record<ErrorReason, string> = {
  bad_email: 'Enter the work email address the invitation should go to.',
  bad_passcode: 'Enter the passcode you were sent.',
  demo_passcode_invalid: 'That passcode is not right.',
  demo_domain_not_allowed: 'This demo is open to work addresses only.',
  rate_limited: 'Too many requests for this address or from this connection. Try again in an hour.',
  demo_access_not_configured: 'Request access is not available right now. Ask the person who shared this link.',
  unavailable: 'Request access is not available right now. Ask the person who shared this link.',
};

/**
 * Share links the host can paste before sending the page out. Empty until the
 * demo workspace has seeded sessions and real `/shared/...` URLs.
 */
const SHARE_LINKS: ReadonlyArray<{ href: string; label: string; note: string }> = [
  // { href: '/shared/…', label: 'A partner screening turn', note: 'Read-only. No account needed.' },
];

export function DemoAccess({ fetchImpl }: { fetchImpl?: typeof fetch } = {}) {
  const auth = createAuth();
  const [email, setEmail] = useState('');
  const [passcode, setPasscode] = useState('');
  const [phase, setPhase] = useState<FormPhase>({ kind: 'idle' });
  const request = fetchImpl ?? fetch;

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (phase.kind === 'submitting') return;
    setPhase({ kind: 'submitting' });
    void (async () => {
      try {
        const response = await request('/demo/request-access', {
          method: 'POST',
          credentials: 'include',
          headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, passcode }),
        });
        const json: unknown = await response.json().catch(() => null);
        if (response.ok) {
          const parsed = demoAccessResponseSchema.safeParse(json);
          if (!parsed.success) {
            setPhase({ kind: 'error', reason: 'unavailable' });
            return;
          }
          if (parsed.data.status === 'invited') {
            setPhase({ kind: 'invited', email: parsed.data.email });
            return;
          }
          if (parsed.data.status === 'already_member') {
            setPhase({ kind: 'already_member', email: parsed.data.email });
            return;
          }
          setPhase({ kind: 'error', reason: 'demo_access_not_configured' });
          return;
        }
        const reason = typeof json === 'object' && json && 'reason' in json && typeof (json as { reason: unknown }).reason === 'string'
          ? (json as { reason: string }).reason
          : 'unavailable';
        setPhase({
          kind: 'error',
          reason: (reason in ERROR_COPY ? reason : 'unavailable') as ErrorReason,
        });
      } catch {
        setPhase({ kind: 'error', reason: 'unavailable' });
      }
    })();
  };

  return (
    <div className="portal demo-access">
      <header className="portal-header">
        <div className="pl">
          <Glass name="iris" size={30} />
          <span>Hermes Enterprise Demo</span>
        </div>
      </header>
      <div className="portal-body demo-access-body">
        <p className="demo-access-eyebrow">Hermes Enterprise Demo</p>
        <h1 className="portal-title">See how a named team runs Iris under review</h1>
        <p className="demo-access-lede">
          {/* WRITE-UP PLACEHOLDER — replace in your own voice before sending to Nous.
              Two or three sentences: what Hermes Enterprise is, what is real vs stubbed,
              and what they should try first once invited. */}
          Hermes Enterprise is a workspace where every agent action is a named human&apos;s
          decision. This staging deployment is the live demo: seeded sessions, shared
          read-only links below, and a Member invite when you have the passcode.
        </p>

        <section className="demo-access-shares" aria-label="Read-only sessions">
          <h2 className="demo-access-section-title">Look without an account</h2>
          {SHARE_LINKS.length === 0 ? (
            <p className="meta">
              Share links will appear here once the demo workspace has a few seeded sessions.
              Ask the host for `/shared/…` URLs in the meantime.
            </p>
          ) : (
            <ul className="demo-access-share-list">
              {SHARE_LINKS.map((link) => (
                <li key={link.href}>
                  <a href={link.href}>{link.label}</a>
                  <span className="meta">{link.note}</span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="demo-access-request" aria-label="Request access">
          <h2 className="demo-access-section-title">Request a Member invite</h2>
          <p className="meta">
            Enter your work email and the passcode from the recruiter. We send a real invitation
            to that address; the invite link is what signs you into the demo workspace.
          </p>

          {phase.kind === 'invited' ? (
            <div className="demo-access-result" role="status">
              <strong>Check your inbox</strong>
              <p className="meta">
                An invitation is on its way to {phase.email}. Open it, sign up with that same
                address, and you land in the demo as a Member.
              </p>
            </div>
          ) : phase.kind === 'already_member' ? (
            <div className="demo-access-result" role="status">
              <strong>{phase.email} is already a member</strong>
              <p className="meta">Sign in with that address to open the demo workspace.</p>
              <button
                type="button"
                className="portal-btn"
                onClick={() => window.location.assign(auth.signInUrl('/'))}
              >
                Sign in
              </button>
            </div>
          ) : (
            <form className="demo-access-form" onSubmit={submit}>
              <label className="portal-input">
                <span className="sr-only">Work email</span>
                <input
                  type="email"
                  name="email"
                  autoComplete="email"
                  required
                  maxLength={DEMO_ACCESS_EMAIL_MAX}
                  placeholder="you@company.com"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                />
              </label>
              <label className="portal-input">
                <span className="sr-only">Passcode</span>
                <input
                  type="password"
                  name="passcode"
                  autoComplete="off"
                  required
                  maxLength={DEMO_ACCESS_PASSCODE_MAX}
                  placeholder="Passcode"
                  value={passcode}
                  onChange={(event) => setPasscode(event.target.value)}
                />
              </label>
              {phase.kind === 'error' && (
                <p className="meta demo-access-error" role="alert">
                  {ERROR_COPY[phase.reason]}
                </p>
              )}
              <button type="submit" className="portal-btn" disabled={phase.kind === 'submitting'}>
                {phase.kind === 'submitting' ? 'Requesting…' : 'Request access'}
              </button>
            </form>
          )}
        </section>
      </div>
    </div>
  );
}
