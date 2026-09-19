import type { Env } from '../env.js';

export const GMAIL_SEND_SCOPE = 'https://www.googleapis.com/auth/gmail.send' as const;

export interface GmailConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly stateSecret: string;
  readonly redirectUri: string;
}

export function gmailConfig(env: Env): GmailConfig | null {
  if (env.GMAIL_OUTREACH_ENABLED !== '1') return null;
  const clientId = env.GMAIL_CLIENT_ID?.trim();
  const clientSecret = env.GMAIL_CLIENT_SECRET?.trim();
  const stateSecret = env.GMAIL_STATE_SECRET?.trim();
  const redirectUri = env.GMAIL_REDIRECT_URI?.trim();
  if (!clientId || !clientSecret || !stateSecret || stateSecret.length < 32 || !redirectUri) return null;
  let parsed: URL;
  try { parsed = new URL(redirectUri); } catch { return null; }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) return null;
  return { clientId, clientSecret, stateSecret, redirectUri: parsed.toString() };
}

export function gmailAuthorizeUrl(config: GmailConfig, state: string): string {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', `${GMAIL_SEND_SCOPE} openid email`);
  url.searchParams.set('access_type', 'offline');
  url.searchParams.set('include_granted_scopes', 'true');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('state', state);
  return url.toString();
}

export function gmailFetcher(env: Env): typeof fetch {
  if (!env.GMAIL_FETCHER) return globalThis.fetch;
  return (input, init) => env.GMAIL_FETCHER!.fetch(new Request(input, init));
}
