import type { Env } from '../env.js';

export const GMAIL_EVIDENCE_READ_SCOPE = 'https://www.googleapis.com/auth/gmail.readonly' as const;

export interface GmailEvidenceConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly stateSecret: string;
  readonly redirectUri: string;
}

/** A dedicated OAuth client is required so an existing gmail.send grant can
 * never be widened or mistaken for mailbox-read consent. */
export function gmailEvidenceConfig(env: Env): GmailEvidenceConfig | null {
  if (env.GMAIL_EVIDENCE_ENABLED !== '1') return null;
  const clientId = env.GMAIL_EVIDENCE_CLIENT_ID?.trim();
  const clientSecret = env.GMAIL_EVIDENCE_CLIENT_SECRET?.trim();
  const stateSecret = env.GMAIL_EVIDENCE_STATE_SECRET?.trim();
  const redirectUri = env.GMAIL_EVIDENCE_REDIRECT_URI?.trim();
  if (!clientId || !clientSecret || !stateSecret || stateSecret.length < 32 || !redirectUri) return null;
  // Separate variables are not enough: reusing the outbound OAuth client can
  // cause Google to coalesce consent and makes the operational boundary false.
  if (env.GMAIL_CLIENT_ID?.trim() === clientId) return null;
  let parsed: URL;
  try { parsed = new URL(redirectUri); } catch { return null; }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
  if (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) return null;
  return { clientId, clientSecret, stateSecret, redirectUri: parsed.toString() };
}

export function gmailEvidenceAuthorizeUrl(config: GmailEvidenceConfig, state: string): string {
  const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', GMAIL_EVIDENCE_READ_SCOPE);
  url.searchParams.set('access_type', 'offline');
  // Do not fold grants from another Google OAuth flow into this token.
  url.searchParams.set('include_granted_scopes', 'false');
  url.searchParams.set('prompt', 'consent');
  url.searchParams.set('state', state);
  return url.toString();
}

export function gmailEvidenceFetcher(env: Env): typeof fetch {
  if (!env.GMAIL_EVIDENCE_FETCHER) return globalThis.fetch;
  return (input, init) => env.GMAIL_EVIDENCE_FETCHER!.fetch(new Request(input, init));
}
