import { z } from 'zod';
import { GmailApiError, type GmailTokenBundle } from './gmail-api.js';
import { MICROSOFT_SCOPES, MICROSOFT_SEND_SCOPE, microsoftTokenUrl, type MicrosoftConfig } from './microsoft-config.js';

// Microsoft Graph for the sending account (C99). The token bundle and error
// type are the Gmail ones: the store, the send job and the retry rules treat a
// provider failure the same way whichever provider it came from.

const tokenSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  refresh_token: z.string().min(1).optional(),
  scope: z.string().default(''),
  token_type: z.string().default('Bearer'),
});
const profileSchema = z.object({ mail: z.string().nullable().optional(), userPrincipalName: z.string().nullable().optional() });
const ADDRESS = /^[^\s@<>()"]{1,64}@[^\s@<>()"]{1,255}$/u;

/** Whether a token response granted sending, however Graph spelled the scope. */
export function grantsMicrosoftSend(scope: string): boolean {
  return scope.split(/\s+/u).some((granted) => granted.replace(/^https:\/\/graph\.microsoft\.com\//iu, '').toLowerCase() === MICROSOFT_SEND_SCOPE.toLowerCase());
}

async function tokenRequest(config: MicrosoftConfig, body: URLSearchParams, fetcher: typeof fetch): Promise<z.infer<typeof tokenSchema>> {
  const response = await fetcher(microsoftTokenUrl(config), {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!response.ok) throw new GmailApiError('microsoft_oauth_exchange_failed', response.status, response.status >= 500 || response.status === 429);
  return tokenSchema.parse(await response.json());
}

export async function exchangeMicrosoftCode(config: MicrosoftConfig, code: string, fetcher: typeof fetch = fetch): Promise<GmailTokenBundle> {
  const token = await tokenRequest(config, new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    grant_type: 'authorization_code',
    redirect_uri: config.redirectUri,
    scope: MICROSOFT_SCOPES,
  }), fetcher);
  if (!token.refresh_token) throw new GmailApiError('microsoft_refresh_token_missing', 409, false);
  if (!grantsMicrosoftSend(token.scope)) throw new GmailApiError('microsoft_send_scope_missing', 409, false);
  return {
    access_token: token.access_token,
    refresh_token: token.refresh_token,
    expires_at: new Date(Date.now() + token.expires_in * 1000).toISOString(),
    scope: token.scope,
    token_type: token.token_type,
  };
}

/** Microsoft rotates refresh tokens: the new one replaces the old whenever it comes back. */
export async function refreshMicrosoftToken(
  config: MicrosoftConfig,
  current: GmailTokenBundle,
  fetcher: typeof fetch = fetch,
): Promise<GmailTokenBundle> {
  const token = await tokenRequest(config, new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: current.refresh_token,
    grant_type: 'refresh_token',
    scope: MICROSOFT_SCOPES,
  }), fetcher);
  return {
    access_token: token.access_token,
    refresh_token: token.refresh_token ?? current.refresh_token,
    expires_at: new Date(Date.now() + token.expires_in * 1000).toISOString(),
    scope: token.scope || current.scope,
    token_type: token.token_type,
  };
}

/** The mailbox's own address: `mail`, else the sign-in name when that is an address. */
export async function microsoftProfile(accessToken: string, fetcher: typeof fetch = fetch): Promise<string> {
  const response = await fetcher('https://graph.microsoft.com/v1.0/me?$select=mail,userPrincipalName', {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  if (!response.ok) throw new GmailApiError('microsoft_profile_failed', response.status, response.status >= 500 || response.status === 429);
  const profile = profileSchema.parse(await response.json());
  const address = [profile.mail, profile.userPrincipalName].find((value): value is string => typeof value === 'string' && ADDRESS.test(value.trim()));
  // An account with no mailbox (a guest, or a sign-in with no Exchange licence) cannot send.
  if (!address) throw new GmailApiError('microsoft_mailbox_missing', 409, false);
  return address.trim().toLowerCase();
}

/**
 * Send the exact approved message. Graph takes the same RFC 5322 bytes Gmail
 * does, as standard base64 in a text/plain body, and answers 202 with no body;
 * its request id is the only reference it gives.
 */
export async function sendMicrosoftMessage(
  accessToken: string,
  rawBase64Url: string,
  fetcher: typeof fetch = fetch,
): Promise<{ id: string | null; threadId: null }> {
  const standard = Buffer.from(rawBase64Url, 'base64url').toString('base64');
  const response = await fetcher('https://graph.microsoft.com/v1.0/me/sendMail', {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'text/plain' },
    body: standard,
  });
  if (response.status !== 202) throw new GmailApiError('microsoft_send_failed', response.status, response.status >= 500 || response.status === 429);
  return { id: response.headers.get('request-id'), threadId: null };
}
