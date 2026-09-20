import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CloudConnection } from '../app/views/CloudConnection.js';
import { cloudConnectionErrorMessage, cloudConnectionPresentation, cloudConnectionStatusSchema, type CloudConnectionStatus } from './cloud-connection.js';

const connected: CloudConnectionStatus = { status: 'connected', organization_name: 'Acme', automatic_setup_ready: false };

describe('Cloud connection user contract', () => {
  it('rejects credential-bearing and unknown responses', () => {
    expect(cloudConnectionStatusSchema.safeParse(connected).success).toBe(true);
    expect(cloudConnectionStatusSchema.safeParse({ ...connected, access_token: 'private' }).success).toBe(false);
    expect(cloudConnectionStatusSchema.safeParse({ ...connected, status: 'ready' }).success).toBe(false);
  });

  it('requires both a verified connection and setup readiness before claiming automatic setup', () => {
    expect(cloudConnectionPresentation(connected).description).toContain('still needs verification');
    expect(cloudConnectionPresentation({ ...connected, automatic_setup_ready: true }).description).toBe('Automatic agent setup is ready.');
    for (const status of ['not_connected', 'connecting', 'reconnect_required', 'verification_required'] as const) {
      expect(cloudConnectionPresentation({ ...connected, status, automatic_setup_ready: true }).description).not.toBe('Automatic agent setup is ready.');
    }
  });

  it('exposes only verified organization names and disables unavailable or busy connection actions', () => {
    const render = (status: CloudConnectionStatus, available = true, busy = false) => renderToStaticMarkup(createElement(CloudConnection, { status, available, busy, error: null, onConnect: () => {} }));
    expect(render(connected)).toContain('Acme');
    expect(render({ ...connected, status: 'verification_required' })).not.toContain('Acme');
    expect(render({ ...connected, status: 'not_connected' }, false)).toContain('disabled=""');
    expect(render({ ...connected, status: 'not_connected' }, true, true)).toContain('disabled=""');
    expect(render({ ...connected, status: 'connecting' })).toContain('Connect again');
    expect(render(connected)).not.toContain('<button');
  });

  it('does not surface unknown provider errors or credentials', () => {
    expect(cloudConnectionErrorMessage('provider_secret=private')).toBe('Cloud could not be connected. Please try again.');
    expect(cloudConnectionErrorMessage('cloud_organization_mismatch')).toContain('could not be verified');
  });
});
