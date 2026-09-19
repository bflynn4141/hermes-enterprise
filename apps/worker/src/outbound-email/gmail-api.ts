import { z } from 'zod';
import { GMAIL_SEND_SCOPE, type GmailConfig } from './gmail-config.js';

const tokenSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().default(GMAIL_SEND_SCOPE),
  token_type: z.string().default('Bearer'),
});
const profileSchema = z.object({ email: z.string().email(), email_verified: z.boolean().optional() });
const messageSchema = z.object({ id: z.string().min(1), threadId: z.string().min(1).optional() });

export interface GmailTokenBundle {
  readonly access_token: string;
  readonly refresh_token: string;
  readonly expires_at: string;
  readonly scope: string;
  readonly token_type: string;
}

export class GmailApiError extends Error {
  constructor(message: string, readonly status: number, readonly retryable: boolean) {
    super(message);
    this.name = 'GmailApiError';
  }
}

async function tokenRequest(body: URLSearchParams, fetcher: typeof fetch): Promise<z.infer<typeof tokenSchema>> {
  const response = await fetcher('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!response.ok) throw new GmailApiError('gmail_oauth_exchange_failed', response.status, response.status >= 500 || response.status === 429);
  return tokenSchema.parse(await response.json());
}

export async function exchangeGmailCode(config: GmailConfig, code: string, fetcher: typeof fetch = fetch): Promise<GmailTokenBundle> {
  const token = await tokenRequest(new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: config.redirectUri,
  }), fetcher);
  if (!token.refresh_token) throw new GmailApiError('gmail_refresh_token_missing', 409, false);
  const scopes = new Set(token.scope.split(/\s+/u));
  if (!scopes.has(GMAIL_SEND_SCOPE)) throw new GmailApiError('gmail_send_scope_missing', 409, false);
  return {
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    expires_at: new Date(Date.now() + token.expires_in * 1000).toISOString(),
    scope: token.scope,
    token_type: token.token_type,
  };
}

export async function refreshGmailToken(
  config: GmailConfig,
  current: GmailTokenBundle,
  fetcher: typeof fetch = fetch,
): Promise<GmailTokenBundle> {
  const token = await tokenRequest(new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: current.refresh_token,
    grant_type: 'refresh_token',
  }), fetcher);
  return {
    access_token: token.access_token,
    refresh_token: token.refresh_token ?? current.refresh_token,
    expires_at: new Date(Date.now() + token.expires_in * 1000).toISOString(),
    scope: token.scope || current.scope,
    token_type: token.token_type,
  };
}

export async function gmailProfile(accessToken: string, fetcher: typeof fetch = fetch): Promise<string> {
  const response = await fetcher('https://openidconnect.googleapis.com/v1/userinfo', {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new GmailApiError('gmail_profile_failed', response.status, response.status >= 500 || response.status === 429);
  const profile = profileSchema.parse(await response.json());
  if (profile.email_verified === false) throw new GmailApiError('gmail_email_unverified', 409, false);
  return profile.email.toLowerCase();
}

function encodedWord(value: string): string {
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function mailbox(name: string, address: string): string {
  return `${encodedWord(name)} <${address}>`;
}

/** Build the exact plain-text RFC 5322 message reviewed in the approval. */
export function rawGmailMessage(input: {
  senderName?: string;
  senderAddress: string;
  recipientName: string;
  recipientAddress: string;
  subject: string;
  body: string;
}): string {
  const body = Buffer.from(input.body.replace(/\r?\n/g, '\r\n'), 'utf8').toString('base64').replace(/(.{76})/g, '$1\r\n');
  const message = [
    `From: ${input.senderName ? mailbox(input.senderName, input.senderAddress) : input.senderAddress}`,
    `To: ${mailbox(input.recipientName, input.recipientAddress)}`,
    `Subject: ${encodedWord(input.subject)}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    body,
  ].join('\r\n');
  return Buffer.from(message, 'utf8').toString('base64url');
}

export async function sendGmailMessage(
  accessToken: string,
  raw: string,
  fetcher: typeof fetch = fetch,
): Promise<{ id: string; threadId: string | null }> {
  const response = await fetcher('https://gmail.googleapis.com/gmail/v1/users/me/messages/send', {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ raw }),
  });
  if (!response.ok) throw new GmailApiError('gmail_send_failed', response.status, response.status >= 500 || response.status === 429);
  const sent = messageSchema.parse(await response.json());
  return { id: sent.id, threadId: sent.threadId ?? null };
}
