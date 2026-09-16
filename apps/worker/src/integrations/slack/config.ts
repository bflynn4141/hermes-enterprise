import type { Env } from '../../env.js';

export const SLACK_BOT_SCOPES = ['app_mentions:read', 'chat:write', 'im:history'] as const;
export const SLACK_BOT_EVENTS = ['app_mention', 'message.im'] as const;

export interface SlackConfig {
  readonly clientId: string;
  readonly clientSecret: string;
  readonly signingSecret: string;
  readonly stateSecret: string;
  readonly redirectUri: string;
}

export function slackConfig(env: Env): SlackConfig | null {
  if (env.SLACK_ENABLED !== '1') return null;
  const clientId = env.SLACK_CLIENT_ID?.trim();
  const clientSecret = env.SLACK_CLIENT_SECRET?.trim();
  const signingSecret = env.SLACK_SIGNING_SECRET?.trim();
  const stateSecret = env.SLACK_STATE_SECRET?.trim();
  const redirectUri = env.SLACK_REDIRECT_URI?.trim();
  if (!clientId || !clientSecret || !signingSecret || !stateSecret || !redirectUri) return null;
  let parsed: URL;
  try {
    parsed = new URL(redirectUri);
  } catch {
    return null;
  }
  const local = parsed.hostname === 'localhost' || parsed.hostname === '127.0.0.1' || parsed.hostname === '[::1]';
  if (parsed.protocol !== 'https:' && !(local && parsed.protocol === 'http:')) return null;
  return { clientId, clientSecret, signingSecret, stateSecret, redirectUri: parsed.toString() };
}

export function slackInstallKey(input: {
  readonly isEnterpriseInstall: boolean;
  readonly enterpriseId?: string | null;
  readonly teamId?: string | null;
}): string | null {
  if (input.isEnterpriseInstall && input.enterpriseId) return `enterprise:${input.enterpriseId}`;
  if (!input.isEnterpriseInstall && input.teamId) return `team:${input.teamId}`;
  return null;
}

export function slackAuthorizeUrl(config: SlackConfig, state: string): string {
  const url = new URL('https://slack.com/oauth/v2/authorize');
  url.searchParams.set('client_id', config.clientId);
  url.searchParams.set('scope', SLACK_BOT_SCOPES.join(','));
  url.searchParams.set('redirect_uri', config.redirectUri);
  url.searchParams.set('state', state);
  return url.toString();
}
