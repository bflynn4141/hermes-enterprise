import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { NOUS_API_KEYS_URL, ProviderConnect, type ProviderConnectProps } from './ProviderConnect.js';

const render = (overrides: Partial<ProviderConnectProps> = {}): string => renderToStaticMarkup(
  <ProviderConnect
    apiKey=""
    onApiKeyChange={vi.fn()}
    status={{ kind: 'idle' }}
    onConnect={vi.fn()}
    onRetry={vi.fn()}
    onCancel={vi.fn()}
    onDone={vi.fn()}
    {...overrides}
  />,
);

describe('ProviderConnect', () => {
  it('explains the key handoff and labels the only secret field visibly', () => {
    const html = render();

    expect(html).toContain(`href="${NOUS_API_KEYS_URL}"`);
    expect(html).toContain('target="_blank"');
    expect(html).toContain('rel="noopener noreferrer"');
    expect(html).toContain('Continue with Nous opens the official API key page in a new tab');
    expect(html).toContain('Nous Portal API key');
    expect(html).toContain('Paste the secret key you copied from Nous Portal');
    expect(html).toContain('name="nous-api-key"');
    expect(html).toContain('aria-describedby=');
    expect(html).toContain('autoComplete="new-password"');
    expect(html).not.toContain('Connection name');
    expect(html).not.toContain('Program key');
  });

  it('keeps connection unavailable until a key is present and exposes busy state', () => {
    expect(render()).toMatch(/<button[^>]*disabled=""[^>]*>Connect and continue<\/button>/);

    const connecting = render({ apiKey: 'nous-test-key', status: { kind: 'connecting' } });
    expect(connecting).toContain('aria-busy="true"');
    expect(connecting).toContain('Connecting…');
    expect(connecting).toMatch(/<input[^>]*disabled=""/);
  });

  it('announces invalid and pending saved-key states without asking for another paste', () => {
    const invalid = render({ status: { kind: 'invalid', message: 'Nous Portal did not accept this key.' } });
    expect(invalid).toContain('role="alert"');
    expect(invalid).toContain('Nous Portal did not accept this key.');
    expect(invalid).toContain('Try verification again');
    expect(invalid).not.toContain('name="nous-api-key"');

    const pending = render({ status: { kind: 'pending', message: 'The key is encrypted and saved.' } });
    expect(pending).toContain('role="status"');
    expect(pending).toContain('The key is encrypted and saved.');
    expect(pending).not.toContain('name="nous-api-key"');
  });

  it('announces success with the synced model count', () => {
    const html = render({ status: { kind: 'connected', modelCount: 342 } });
    expect(html).toContain('role="status"');
    expect(html).toContain('Nous Portal connected');
    expect(html).toContain('342 models are ready for your agents.');
    expect(html).toContain('>Done</button>');
  });

  it('makes hosted Nous authorization the primary action when available', () => {
    const html = render({ onOAuthStart: vi.fn() });
    expect(html).toContain('Connect your Nous workspace');
    expect(html).toContain('Continue with Nous');
    expect(html).not.toContain('name="nous-api-key"');

    const waiting = render({ onOAuthStart: vi.fn(), status: { kind: 'authorizing', userCode: 'ABCD-1234', verificationUri: 'https://portal.nousresearch.com/device' } });
    expect(waiting).toContain('Waiting for approval…');
    expect(waiting).toContain('ABCD-1234');

    const resumed = render({ onOAuthStart: vi.fn(), status: { kind: 'notice', message: 'Sign-in confirmed. Continue with Nous to approve this workspace.' } });
    expect(resumed).toContain('role="status"');
    expect(resumed).toContain('Sign-in confirmed. Continue with Nous');
  });

  it('shows the manual key only as an honest unconfigured fallback', () => {
    const html = render({ onOAuthStart: vi.fn(), status: { kind: 'oauth_unavailable', message: 'Hosted sign-in is unavailable.' } });
    expect(html).toContain('Hosted sign-in is unavailable.');
    expect(html).toContain('Nous Portal API key');

    const invalidManual = render({
      onOAuthStart: vi.fn(),
      preferManual: true,
      status: { kind: 'invalid', message: 'Nous Portal did not accept this key.' },
    });
    expect(invalidManual).toContain('Nous Portal did not accept this key.');
    expect(invalidManual).toContain('Try verification again');
  });
});
