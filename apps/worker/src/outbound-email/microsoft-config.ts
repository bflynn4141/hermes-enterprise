import type { Env } from '../env.js';

/**
 * Delegated Graph permission to send as the signed-in mailbox (C99). Graph
 * reports granted scopes without its resource prefix, so checks compare the
 * bare name.
 */
export const MICROSOFT_SEND_SCOPE = 'Mail.Send' as const;
const GRAPH = 'https://graph.microsoft.com/';
/** Mail.Send to send, User.Read to learn the address, offline_access for a refresh token. */
export const MICROSOFT_SCOPES = `${GRAPH}${MICROSOFT_SEND_SCOPE} ${GRAPH}User.Read offline_access openid email`;

export interface MicrosoftConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly stateSecret: string;
  readonly redirectUri: string;
  /** `organizations` (work and school accounts) unless a single tenant is pinned. */
  readonly tenant: string;
}

export function microsoftConfig(env: Env): MicrosoftConfig | null {
  if (env.MICROSOFT_MAIL_ENABLED !== '1') return null;
  const clientId = env.MICROSOFT_CLIENT_ID?.trim();
  const clientSecret = env.MICROSOFT_CLIENT_SECRET?.trim();
  const stateSecret = env.MICROSOFT_STATE_SECRET?.trim();
  const redirectUri = env.MICROSOFT_REDIRECT_URI?.trim();
  const tenant = env.MICROSOFT_TENANT?.trim() || 'organizations';
  if (!clientId || !clientSecret || !stateSecret || stateSecret.length < 32 || !redirectUri) return null;
  // A tenant is a GUID or a domain; anything else would be spliced into the login URL.
  if (!/^[a-z0-9.-]{1,253}$/iu.test(tenant)) return null;
  let parsed: URL;
  try { parsed = new URL(redirectUri); } catch { return null; }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) return null;
  return { clientId, clientSecret, stateSecret, redirectUri: parsed.toString(), tenant };
}

export const microsoftTokenUrl = (config: MicrosoftConfig): string =>
  `https://login.microsoftonline.com/${encodeURIComponent(config.tenant)}/oauth2/v2.0/token`;

export function microsoftAuthorizeUrl(config: MicrosoftConfig, state: string): string {
  const url = new URL(`https://login.microsoftonline.com/${encodeURIComponent(config.tenant)}/oauth2/v2.0/authorize`);
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('response_mode', 'query');
  url.searchParams.set('scope', MICROSOFT_SCOPES);
  // Always ask which mailbox: the person connecting is often signed in as themselves, not the sender.
  url.searchParams.set('prompt', 'select_account');
  url.searchParams.set('state', state);
  return url.toString();
}

export function microsoftFetcher(env: Env): typeof fetch {
  if (!env.MICROSOFT_FETCHER) return globalThis.fetch;
  return (input, init) => env.MICROSOFT_FETCHER!.fetch(new Request(input, init));
}
