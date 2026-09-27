import { describe, expect, it } from 'vitest';
import type { SenderFacts } from '@hermes/shared';
import { emailCautions, linkDestination, trustLine } from './EmailMessage.js';
import { emailTurn } from '../chat/Transcript.js';

const facts = (overrides: Partial<SenderFacts> = {}): SenderFacts => ({
  address: 'priya@northwlnd-analytics.example',
  name: 'Priya Raman',
  domain: 'northwlnd-analytics.example',
  relationship: 'new_sender',
  authentication: { spf: 'fail', dkim: 'fail', dmarc: 'fail', authserv_id: 'mx.cloudflare.net' },
  reply_to: 'accounts@payments-desk.example',
  warnings: [],
  ...overrides,
});

describe('email words', () => {
  it('says who sent it in one line, without the names of mail checks', () => {
    expect(trustLine(facts()).text).toBe('Sender not confirmed · First email from this address');
    expect(trustLine(facts({ relationship: 'known_contact', authentication: { spf: 'pass', dkim: 'pass', dmarc: 'pass', authserv_id: null } })).text)
      .toBe("Verified sender · You've emailed before");
  });

  it('writes each caution from its code and the stored facts, once, never from the server text', () => {
    const cautions = emailCautions(facts({
      warnings: [
        { code: 'authentication_failed', severity: 'caution', detail: 'dmarc=fail, spf=fail, dkim=fail' },
        { code: 'reply_to_differs', severity: 'caution', detail: 'old wording' },
        { code: 'reply_to_differs', severity: 'caution', detail: 'duplicate' },
        { code: 'remote_images_blocked', severity: 'info', detail: '2 remote images' },
      ],
    }));
    expect(cautions.map((caution) => caution.code)).toEqual(['authentication_failed', 'reply_to_differs']);
    expect(cautions[0]?.text).toContain('couldn\'t confirm this email came from northwlnd-analytics.example');
    expect(cautions[1]?.text).toContain('accounts@payments-desk.example');
    expect(cautions.map((caution) => caution.text).join(' ')).not.toMatch(/dmarc|spf|dkim/iu);
  });

  it('shows where a link goes without the scheme', () => {
    expect(linkDestination('https://northwind.example/recaps/september')).toBe('northwind.example/recaps/september');
    expect(linkDestination('https://northwind.example/')).toBe('northwind.example');
  });
});

describe('email turns in the conversation', () => {
  it('reads a new email card', () => {
    expect(emailTurn({ kind: 'email', text: 'New email from Priya Raman: Invoice', blocks: [{ type: 'card', title: 'Priya Raman <priya@northwind.example>', subtitle: 'Invoice' }] }))
      .toEqual({ from: 'Priya Raman <priya@northwind.example>', subject: 'Invoice' });
  });

  it('reads only the sender and subject from a turn stored before the card existed', () => {
    const legacy = [
      'A new email arrived at the Partnerships inbox (partnerships-x@in.example), which you handle for the Partnerships team.',
      '',
      'What the server verified about the sender (you cannot change these):',
      '- From: Jordan Lee <jordan@fieldday.example>, a first-time sender.',
      '- Domain checks: DMARC pass, SPF pass, DKIM pass.',
      '',
      '<<<EMAIL-ABC',
      'Subject: Speaker slot at the October summit',
      '',
      'Body',
      'EMAIL-ABC>>>',
    ].join('\n');
    expect(emailTurn({ kind: null, text: legacy, blocks: [] })).toEqual({ from: 'Jordan Lee <jordan@fieldday.example>', subject: 'Speaker slot at the October summit' });
    expect(emailTurn({ kind: null, text: 'Hello Iris', blocks: [] })).toBeNull();
  });
});
