import { describe, expect, it } from 'vitest';
import type { EmailSend } from '@hermes/shared';
import { uncertainLine } from './EmailSends.js';

const send = (via: EmailSend['via']): EmailSend => ({
  id: '00000000-0000-4000-8000-000000000001', authorization_revision: 1, recipient_name: 'Priya Raman',
  recipient_address: 'priya@northwind.example', sender_address: 'iris-abc123@in.example', via, state: 'ambiguous', sent_at: null, settled: null,
});

describe('uncertainLine', () => {
  it('asks the recipient about a send from an agent address, which has no Sent folder', () => {
    const line = uncertainLine(send('agent'), true);
    expect(line).toContain('ask Priya Raman whether it arrived');
    expect(line).not.toContain('Check the Sent folder');
  });

  it('points a mailbox send at that mailbox’s Sent folder, also for older servers', () => {
    expect(uncertainLine(send('account'), true)).toContain('Check the Sent folder of iris-abc123@in.example');
    expect(uncertainLine(send(undefined), true)).toContain('Check the Sent folder');
  });

  it('does not say “interrupted” when the provider may simply have failed to confirm', () => {
    expect(uncertainLine(send('agent'), false)).toBe('The provider didn’t confirm whether it was sent. Waiting for a reviewer to check.');
  });
});
