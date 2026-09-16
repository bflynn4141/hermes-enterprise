import { useId } from 'react';
import { Button } from '../ui/primitives.js';
import { Icon } from '../ui/icons.js';

export const NOUS_API_KEYS_URL = 'https://portal.nousresearch.com/api-keys';

export type ProviderConnectStatus =
  | { kind: 'idle' }
  | { kind: 'connecting' }
  | { kind: 'retrying'; message: string }
  | { kind: 'connected'; modelCount: number | null }
  | { kind: 'invalid'; message: string }
  | { kind: 'pending'; message: string }
  | { kind: 'error'; message: string };

export interface ProviderConnectProps {
  apiKey: string;
  onApiKeyChange: (value: string) => void;
  status: ProviderConnectStatus;
  onConnect: () => void;
  onRetry?: () => void;
  onCancel?: () => void;
  onDone?: () => void;
  /** Focus the secret field after a recent-sign-in round trip. */
  autoFocusKey?: boolean;
  connectLabel?: string;
}

/**
 * The provider-specific part of the connection flow.
 *
 * It deliberately owns no API or navigation state, so Settings and first-run
 * onboarding can use the same truthful handoff while choosing their own shell,
 * recent-sign-in behavior and completion destination. The secret stays in the
 * caller's memory only and is never read from the clipboard.
 */
export function ProviderConnect({
  apiKey,
  onApiKeyChange,
  status,
  onConnect,
  onRetry,
  onCancel,
  onDone,
  autoFocusKey = false,
  connectLabel = 'Connect and continue',
}: ProviderConnectProps) {
  const fieldId = useId();
  const helpId = `${fieldId}-help`;
  const busy = status.kind === 'connecting' || status.kind === 'retrying';
  const stored = status.kind === 'invalid' || status.kind === 'pending' || status.kind === 'retrying';

  if (status.kind === 'connected') {
    return (
      <div className="provider-connect provider-connect-complete" role="status" aria-live="polite">
        <span className="provider-connect-success-icon" aria-hidden="true"><Icon name="check" size={20} /></span>
        <div className="col provider-connect-success-copy">
          <strong>Nous Portal connected</strong>
          <span>
            {status.modelCount === null
              ? 'Iris can now use the models available to this workspace.'
              : `${status.modelCount} model${status.modelCount === 1 ? '' : 's'} ${status.modelCount === 1 ? 'is' : 'are'} ready for Iris.`}
          </span>
        </div>
        {onDone && <Button primary onClick={onDone}>Done</Button>}
      </div>
    );
  }

  return (
    <div className="provider-connect" aria-busy={busy}>
      <p className="provider-connect-intro">
        Continue with Nous opens the official API key page in a new tab. Create a key there, copy it, then return here. Hermes connects only after you paste and save that key.
      </p>

      <section className="provider-connect-step" aria-labelledby={`${fieldId}-create-title`}>
        <span className="provider-connect-step-number" aria-hidden="true">1</span>
        <div className="col provider-connect-step-copy">
          <strong id={`${fieldId}-create-title`}>Create an API key in Nous Portal</strong>
          <span>Sign in to Nous, create a key, and copy it. No Nous account access is granted to Hermes.</span>
          <a className="btn primary provider-connect-portal-link" href={NOUS_API_KEYS_URL} target="_blank" rel="noopener noreferrer">
            Continue with Nous <Icon name="external" size={16} />
          </a>
        </div>
      </section>

      <section className="provider-connect-step" aria-labelledby={`${fieldId}-paste-title`}>
        <span className="provider-connect-step-number" aria-hidden="true">2</span>
        <div className="col provider-connect-step-copy">
          <strong id={`${fieldId}-paste-title`}>Paste the key here</strong>
          {stored ? (
            <p className={`provider-connect-feedback ${status.kind === 'invalid' ? 'is-error' : ''}`} role={status.kind === 'invalid' ? 'alert' : 'status'}>
              {status.message}
            </p>
          ) : (
            <label className="provider-connect-field" htmlFor={fieldId}>
              <span className="provider-connect-field-label">Nous Portal API key</span>
              <span className="field">
                <input
                  id={fieldId}
                  name="nous-api-key"
                  type="password"
                  value={apiKey}
                  placeholder="Paste your Nous Portal API key"
                  aria-describedby={helpId}
                  autoComplete="new-password"
                  autoCapitalize="none"
                  spellCheck={false}
                  disabled={busy}
                  autoFocus={autoFocusKey}
                  data-dialog-initial-focus={autoFocusKey ? 'true' : undefined}
                  onChange={(event) => onApiKeyChange(event.target.value)}
                />
              </span>
              <span className="provider-connect-field-help" id={helpId}>
                Paste the secret key you copied from Nous Portal. This workspace will list the connection as “Nous Portal.”
              </span>
            </label>
          )}
        </div>
      </section>

      {status.kind === 'error' && <p className="provider-connect-feedback is-error" role="alert">{status.message}</p>}

      <div className="provider-connect-security">
        <Icon name="shield" size={17} />
        <span>Encrypted for this workspace and never shown again. Connecting verifies the key with one minimal model request, then syncs the model menu.</span>
      </div>
      <p className="provider-connect-admin-note">Only workspace Admins can connect a key. A recent sign-in is required before it is saved.</p>

      <div className="provider-connect-actions">
        {onCancel && <Button onClick={onCancel}>{stored ? 'Close' : 'Cancel'}</Button>}
        {stored ? (
          onRetry && <Button primary disabled={busy} onClick={onRetry}>{busy ? 'Checking…' : 'Try verification again'}</Button>
        ) : (
          <Button primary disabled={busy || !apiKey.trim()} onClick={onConnect}>{busy ? 'Connecting…' : connectLabel}</Button>
        )}
      </div>
    </div>
  );
}
