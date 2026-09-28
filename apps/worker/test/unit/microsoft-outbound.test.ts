// The Microsoft 365 sending account's config gate and Graph client (C99).
import { describe, expect, it } from 'vitest';
import type { Env } from '../../src/env.js';
import { GmailApiError } from '../../src/outbound-email/gmail-api.js';
import {
  exchangeMicrosoftCode, grantsMicrosoftSend, microsoftProfile, refreshMicrosoftToken, sendMicrosoftMessage,
} from '../../src/outbound-email/microsoft-api.js';
import { microsoftAuthorizeUrl, microsoftConfig, type MicrosoftConfig } from '../../src/outbound-email/microsoft-config.js';

const base = {
  MICROSOFT_MAIL_ENABLED: '1',
  MICROSOFT_CLIENT_ID: 'client',
  MICROSOFT_CLIENT_SECRET: 'secret',
  MICROSOFT_STATE_SECRET: 'x'.repeat(32),
  MICROSOFT_REDIRECT_URI: 'https://hermes.example/integrations/microsoft/oauth/callback',
};
const config: MicrosoftConfig = { clientId: 'client', clientSecret: 'secret', stateSecret: 'x'.repeat(32), redirectUri: base.MICROSOFT_REDIRECT_URI, tenant: 'organizations' };
const env = (overrides: Record<string, string | undefined> = {}): Env => ({ ...base, ...overrides }) as unknown as Env;

function fake(handler: (request: Request) => Response | Promise<Response>): { fetcher: typeof fetch; seen: Request[] } {
  const seen: Request[] = [];
  return { seen, fetcher: async (input, init) => { const request = new Request(input, init); seen.push(request.clone()); return handler(request); } };
}

describe('microsoftConfig', () => {
  it('is off unless enabled and complete', () => {
    expect(microsoftConfig(env())).toMatchObject({ clientId: 'client', tenant: 'organizations' });
    expect(microsoftConfig(env({ MICROSOFT_MAIL_ENABLED: '0' }))).toBeNull();
    expect(microsoftConfig(env({ MICROSOFT_CLIENT_SECRET: undefined }))).toBeNull();
    expect(microsoftConfig(env({ MICROSOFT_STATE_SECRET: 'short' }))).toBeNull();
    expect(microsoftConfig(env({ MICROSOFT_REDIRECT_URI: 'http://hermes.example/cb' }))).toBeNull();
    expect(microsoftConfig(env({ MICROSOFT_REDIRECT_URI: 'http://localhost:8787/cb' }))).not.toBeNull();
  });

  it('accepts a tenant id or domain and nothing that could reshape the login URL', () => {
    expect(microsoftConfig(env({ MICROSOFT_TENANT: 'contoso.onmicrosoft.com' }))?.tenant).toBe('contoso.onmicrosoft.com');
    expect(microsoftConfig(env({ MICROSOFT_TENANT: '../common/oauth2' }))).toBeNull();
    expect(microsoftConfig(env({ MICROSOFT_TENANT: 'evil.example?x=1' }))).toBeNull();
  });
});

describe('microsoftAuthorizeUrl', () => {
  it('asks for sending, the address and a refresh token, and always lets the Admin pick the mailbox', () => {
    const url = new URL(microsoftAuthorizeUrl(config, 'signed-state'));
    expect(url.origin + url.pathname).toBe('https://login.microsoftonline.com/organizations/oauth2/v2.0/authorize');
    const scopes = url.searchParams.get('scope')!.split(' ');
    expect(scopes).toEqual(expect.arrayContaining(['https://graph.microsoft.com/Mail.Send', 'https://graph.microsoft.com/User.Read', 'offline_access']));
    expect(scopes.some((scope) => /Mail\.Read|Mail\.ReadWrite/u.test(scope))).toBe(false);
    expect(url.searchParams.get('prompt')).toBe('select_account');
    expect(url.searchParams.get('state')).toBe('signed-state');
  });
});

describe('Microsoft tokens', () => {
  const token = (extra: Record<string, unknown> = {}) => Response.json({ access_token: 'a', expires_in: 3600, refresh_token: 'r', scope: 'Mail.Send User.Read', ...extra });

  it('recognises the send scope with or without the Graph prefix', () => {
    expect(grantsMicrosoftSend('https://graph.microsoft.com/Mail.Send openid')).toBe(true);
    expect(grantsMicrosoftSend('mail.send')).toBe(true);
    expect(grantsMicrosoftSend('Mail.Read User.Read')).toBe(false);
  });

  it('exchanges a code at the tenant endpoint', async () => {
    const { fetcher, seen } = fake(() => token());
    const bundle = await exchangeMicrosoftCode(config, 'code', fetcher);
    expect(bundle).toMatchObject({ access_token: 'a', refresh_token: 'r' });
    expect(seen[0]!.url).toBe('https://login.microsoftonline.com/organizations/oauth2/v2.0/token');
    const form = new URLSearchParams(await seen[0]!.text());
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('redirect_uri')).toBe(config.redirectUri);
  });

  it('refuses a grant without sending or without a refresh token', async () => {
    await expect(exchangeMicrosoftCode(config, 'code', fake(() => token({ scope: 'User.Read' })).fetcher)).rejects.toMatchObject({ message: 'microsoft_send_scope_missing' });
    await expect(exchangeMicrosoftCode(config, 'code', fake(() => token({ refresh_token: undefined })).fetcher)).rejects.toMatchObject({ message: 'microsoft_refresh_token_missing' });
  });

  it('keeps the rotated refresh token, and the old one when none comes back', async () => {
    const current = { access_token: 'old', refresh_token: 'r1', expires_at: new Date().toISOString(), scope: 'Mail.Send', token_type: 'Bearer' };
    expect((await refreshMicrosoftToken(config, current, fake(() => token({ refresh_token: 'r2' })).fetcher)).refresh_token).toBe('r2');
    expect((await refreshMicrosoftToken(config, current, fake(() => token({ refresh_token: undefined })).fetcher)).refresh_token).toBe('r1');
  });
});

describe('microsoftProfile', () => {
  it('uses the mailbox address, else a sign-in name that is an address', async () => {
    expect(await microsoftProfile('t', fake(() => Response.json({ mail: 'Ops@Contoso.com', userPrincipalName: 'x@y.z' })).fetcher)).toBe('ops@contoso.com');
    expect(await microsoftProfile('t', fake(() => Response.json({ mail: null, userPrincipalName: 'dana@contoso.com' })).fetcher)).toBe('dana@contoso.com');
  });

  it('refuses an account with no mailbox rather than guessing an address', async () => {
    await expect(microsoftProfile('t', fake(() => Response.json({ mail: null, userPrincipalName: 'guest_contoso.com#EXT#' })).fetcher))
      .rejects.toMatchObject({ message: 'microsoft_mailbox_missing' });
  });
});

describe('sendMicrosoftMessage', () => {
  const raw = Buffer.from('From: ops@contoso.com\r\nTo: a@b.c\r\nSubject: Hi\r\n\r\nBody', 'utf8').toString('base64url');

  it('posts the same message as standard base64 MIME and returns Graph\'s request id', async () => {
    const { fetcher, seen } = fake(() => new Response(null, { status: 202, headers: { 'request-id': 'req-1' } }));
    expect(await sendMicrosoftMessage('token', raw, fetcher)).toEqual({ id: 'req-1', threadId: null });
    expect(seen[0]!.url).toBe('https://graph.microsoft.com/v1.0/me/sendMail');
    expect(seen[0]!.headers.get('content-type')).toBe('text/plain');
    const body = await seen[0]!.text();
    expect(body).not.toMatch(/[-_]/u);
    expect(Buffer.from(body, 'base64').toString('utf8')).toContain('Subject: Hi');
  });

  it('marks throttling retryable and a rejection final', async () => {
    const throttled = await sendMicrosoftMessage('t', raw, fake(() => new Response(null, { status: 429 })).fetcher).catch((error: unknown) => error);
    expect(throttled).toBeInstanceOf(GmailApiError);
    expect(throttled).toMatchObject({ status: 429, retryable: true });
    const rejected = await sendMicrosoftMessage('t', raw, fake(() => new Response(null, { status: 400 })).fetcher).catch((error: unknown) => error);
    expect(rejected).toMatchObject({ status: 400, retryable: false });
  });
});
