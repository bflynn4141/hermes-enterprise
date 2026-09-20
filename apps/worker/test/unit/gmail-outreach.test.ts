import { describe, expect, it, vi } from 'vitest';
import type { Env } from '../../src/env.js';
import {
  exchangeGmailCode,
  gmailProfile,
  rawGmailMessage,
  sendGmailMessage,
} from '../../src/outbound-email/gmail-api.js';
import { GMAIL_SEND_SCOPE, gmailAuthorizeUrl, gmailConfig } from '../../src/outbound-email/gmail-config.js';
import { signGmailOAuthState, verifyGmailOAuthState } from '../../src/outbound-email/gmail-security.js';

const config = {
  clientId: 'client-id',
  clientSecret: 'client-secret',
  stateSecret: 'state-secret-at-least-thirty-two-characters',
  redirectUri: 'https://hermes.example/integrations/gmail/oauth/callback',
};

describe('Gmail outreach boundary', () => {
  it('requires an explicit deployment gate and builds least-privilege offline OAuth', () => {
    expect(gmailConfig({ GMAIL_OUTREACH_ENABLED: '0' } as Env)).toBeNull();
    expect(gmailConfig({
      GMAIL_OUTREACH_ENABLED: '1',
      GMAIL_CLIENT_ID: config.clientId,
      GMAIL_CLIENT_SECRET: config.clientSecret,
      GMAIL_STATE_SECRET: config.stateSecret,
      GMAIL_REDIRECT_URI: config.redirectUri,
    } as Env)).toEqual(config);

    const url = new URL(gmailAuthorizeUrl(config, 'signed-state'));
    expect(url.origin).toBe('https://accounts.google.com');
    expect(url.searchParams.get('scope')?.split(' ')).toEqual(expect.arrayContaining([GMAIL_SEND_SCOPE, 'openid', 'email']));
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
  });

  it('signs a short-lived state bound to one workspace and rejects tampering', async () => {
    const payload = {
      v: 1 as const,
      workspace_id: '11111111-1111-4111-8111-111111111111',
      user_id: '22222222-2222-4222-8222-222222222222',
      nonce: 'nonce',
      expires_at: 1_800,
      redirect_uri: config.redirectUri,
    };
    const state = await signGmailOAuthState(payload, config.stateSecret);
    expect(await verifyGmailOAuthState(state, config.stateSecret, 1_000)).toEqual(payload);
    expect(await verifyGmailOAuthState(`${state}x`, config.stateSecret, 1_000)).toBeNull();
    expect(await verifyGmailOAuthState(state, config.stateSecret, 1_801)).toBeNull();
  });

  it('requires a refresh token and verified connected identity', async () => {
    const fetcher = vi.fn<typeof fetch>()
      .mockResolvedValueOnce(new Response(JSON.stringify({
        access_token: 'access', refresh_token: 'refresh', expires_in: 3600,
        scope: `${GMAIL_SEND_SCOPE} openid email`, token_type: 'Bearer',
      }), { status: 200, headers: { 'content-type': 'application/json' } }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ email: 'IRIS@EXAMPLE.COM', email_verified: true }), {
        status: 200, headers: { 'content-type': 'application/json' },
      }));
    const token = await exchangeGmailCode(config, 'code', fetcher);
    expect(token).toMatchObject({ access_token: 'access', refresh_token: 'refresh' });
    expect(await gmailProfile(token.access_token, fetcher)).toBe('iris@example.com');
    expect(fetcher.mock.calls[0]?.[0]).toBe('https://oauth2.googleapis.com/token');
  });

  it('encodes all reviewed headers and sends the exact MIME payload', async () => {
    const raw = rawGmailMessage({
      senderAddress: 'iris@example.com',
      recipientName: 'Candidate\r\nBcc: attacker@example.com',
      recipientAddress: 'candidate@example.com',
      subject: 'Partner invitation\r\nBcc: attacker@example.com',
      body: 'Hello,\nThis is the reviewed message.',
    });
    const decoded = Buffer.from(raw, 'base64url').toString('utf8');
    expect(decoded).toContain('From: iris@example.com');
    expect(decoded).toContain('To: =?UTF-8?B?');
    expect(decoded).toContain('Subject: =?UTF-8?B?');
    expect(decoded).not.toContain('\r\nBcc: attacker@example.com');

    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(
      JSON.stringify({ id: 'gmail-message-1', threadId: 'gmail-thread-1' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    await expect(sendGmailMessage('access', raw, fetcher)).resolves.toEqual({
      id: 'gmail-message-1', threadId: 'gmail-thread-1',
    });
    expect(JSON.parse(String(fetcher.mock.calls[0]?.[1]?.body))).toEqual({ raw });
  });
});
