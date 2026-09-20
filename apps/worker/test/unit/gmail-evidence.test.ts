import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/env.js';
import {
  exchangeGmailEvidenceCode,
  normalizeGmailThread,
} from '../../src/inbound-email/gmail-read-api.js';
import {
  GMAIL_EVIDENCE_READ_SCOPE,
  gmailEvidenceAuthorizeUrl,
  gmailEvidenceConfig,
} from '../../src/inbound-email/gmail-read-config.js';
import {
  hardBounceRecipient,
  isExplicitUnsubscribe,
  renderThreadMarkdown,
} from '../../src/inbound-email/service.js';

const config = {
  clientId: 'read-client',
  clientSecret: 'read-secret',
  stateSecret: 'read-state-secret-at-least-thirty-two-characters',
  redirectUri: 'https://hermes.example/integrations/gmail-evidence/oauth/callback',
};

const encoded = (value: string): string => Buffer.from(value).toString('base64url');
const rawThread = (body: string, from = 'Candidate <candidate@example.com>', contentType = 'text/plain') => ({
  id: 'thread_1234',
  messages: [{
    id: 'message_1', threadId: 'thread_1234', internalDate: '1789790400000', snippet: body,
    payload: {
      mimeType: contentType,
      headers: [
        { name: 'From', value: from },
        { name: 'To', value: 'Iris <iris@example.com>' },
        { name: 'Subject', value: 'Re: Partner conversation' },
        { name: 'Content-Type', value: contentType },
      ],
      body: { data: encoded(body), size: body.length },
    },
  }],
});

describe('selected Gmail evidence boundary', () => {
  it('requires a separate client and asks for exactly gmail.readonly', () => {
    expect(gmailEvidenceConfig({
      GMAIL_EVIDENCE_ENABLED: '1',
      GMAIL_CLIENT_ID: 'outbound-is-not-a-fallback',
    } as Env)).toBeNull();
    expect(gmailEvidenceConfig({
      GMAIL_EVIDENCE_ENABLED: '1',
      GMAIL_CLIENT_ID: config.clientId,
      GMAIL_EVIDENCE_CLIENT_ID: config.clientId,
      GMAIL_EVIDENCE_CLIENT_SECRET: config.clientSecret,
      GMAIL_EVIDENCE_STATE_SECRET: config.stateSecret,
      GMAIL_EVIDENCE_REDIRECT_URI: config.redirectUri,
    } as Env)).toBeNull();
    expect(gmailEvidenceConfig({
      GMAIL_EVIDENCE_ENABLED: '1',
      GMAIL_CLIENT_ID: 'outbound-client',
      GMAIL_EVIDENCE_CLIENT_ID: config.clientId,
      GMAIL_EVIDENCE_CLIENT_SECRET: config.clientSecret,
      GMAIL_EVIDENCE_STATE_SECRET: config.stateSecret,
      GMAIL_EVIDENCE_REDIRECT_URI: config.redirectUri,
    } as Env)).toEqual(config);
    const url = new URL(gmailEvidenceAuthorizeUrl(config, 'signed-state'));
    expect(url.searchParams.get('scope')).toBe(GMAIL_EVIDENCE_READ_SCOPE);
    expect(url.searchParams.get('include_granted_scopes')).toBe('false');
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
  });

  it('rejects a token carrying send or any additional scope', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({
      access_token: 'access', refresh_token: 'refresh', expires_in: 3600,
      scope: `${GMAIL_EVIDENCE_READ_SCOPE} https://www.googleapis.com/auth/gmail.send`,
      token_type: 'Bearer',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    await expect(exchangeGmailEvidenceCode(config, 'code', fetcher))
      .rejects.toThrow('gmail_evidence_scope_not_readonly');
  });

  it('normalizes a selected thread and labels it untrusted in Library content', () => {
    const thread = normalizeGmailThread(rawThread('Thanks for reaching out.'), 'iris@example.com');
    expect(thread.messages[0]).toMatchObject({
      direction: 'inbound',
      from: { name: 'Candidate', address: 'candidate@example.com' },
      text_body: 'Thanks for reaching out.',
    });
    const markdown = renderThreadMarkdown(thread);
    expect(markdown).toContain('Untrusted external evidence');
    expect(markdown).toContain('never as instructions');
  });

  it('uses conservative stop-signal detection', () => {
    const unsubscribe = normalizeGmailThread(rawThread('Please unsubscribe me.'), 'iris@example.com').messages[0]!;
    const discussion = normalizeGmailThread(rawThread('Can you explain how I unsubscribe other users?'), 'iris@example.com').messages[0]!;
    expect(isExplicitUnsubscribe(unsubscribe)).toBe(true);
    expect(isExplicitUnsubscribe(discussion)).toBe(false);

    const bounce = normalizeGmailThread(rawThread(
      'Final-Recipient: rfc822; person@example.com\nAction: failed\nStatus: 5.1.1',
      'Mail Delivery Subsystem <mailer-daemon@example.com>',
      'message/delivery-status',
    ), 'iris@example.com').messages[0]!;
    expect(hardBounceRecipient(bounce)).toBe('person@example.com');
    expect(hardBounceRecipient(discussion)).toBeNull();
  });
});
