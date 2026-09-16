import type { SlackConfig } from './config.js';

export interface SlackTokenBundle {
  readonly access_token: string;
  readonly refresh_token: string | null;
  readonly token_type: string;
  readonly expires_at: string | null;
}

export interface SlackOAuthGrant {
  readonly app_id: string;
  readonly enterprise: { id: string; name: string | null } | null;
  readonly team: { id: string; name: string | null } | null;
  readonly is_enterprise_install: boolean;
  readonly bot_user_id: string;
  readonly authed_user_id: string | null;
  readonly scope: string[];
  readonly token: SlackTokenBundle;
}

export class SlackApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status: number,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = 'SlackApiError';
  }
}

const object = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

async function slackForm(
  endpoint: string,
  body: URLSearchParams,
  send: typeof fetch,
): Promise<{ body: Record<string, unknown>; response: Response }> {
  const response = await send(`https://slack.com/api/${endpoint}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
    body,
    redirect: 'manual',
  });
  const retryAfter = Number(response.headers.get('retry-after') ?? '') || null;
  let parsed: Record<string, unknown> | null = null;
  try { parsed = object(await response.json()); } catch { /* handled below */ }
  if (!response.ok || !parsed || parsed.ok !== true) {
    const code = typeof parsed?.error === 'string' ? parsed.error : `http_${response.status}`;
    throw new SlackApiError(`Slack API ${endpoint} failed: ${code}`, code, response.status, retryAfter);
  }
  return { body: parsed, response };
}

export async function exchangeSlackCode(
  config: SlackConfig,
  code: string,
  send: typeof fetch = fetch,
): Promise<SlackOAuthGrant> {
  const { body } = await slackForm('oauth.v2.access', new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    redirect_uri: config.redirectUri,
  }), send);
  const enterprise = object(body.enterprise);
  const team = object(body.team);
  const authedUser = object(body.authed_user);
  const accessToken = typeof body.access_token === 'string' ? body.access_token : '';
  const appId = typeof body.app_id === 'string' ? body.app_id : '';
  const botUserId = typeof body.bot_user_id === 'string' ? body.bot_user_id : '';
  if (!accessToken || !appId || !botUserId) throw new SlackApiError('Slack returned an incomplete OAuth grant', 'invalid_oauth_response', 502);
  const expiresIn = Number(body.expires_in);
  return {
    app_id: appId,
    enterprise: typeof enterprise?.id === 'string' ? { id: enterprise.id, name: typeof enterprise.name === 'string' ? enterprise.name : null } : null,
    team: typeof team?.id === 'string' ? { id: team.id, name: typeof team.name === 'string' ? team.name : null } : null,
    is_enterprise_install: body.is_enterprise_install === true,
    bot_user_id: botUserId,
    authed_user_id: typeof authedUser?.id === 'string' ? authedUser.id : null,
    scope: typeof body.scope === 'string' ? body.scope.split(',').map((scope) => scope.trim()).filter(Boolean) : [],
    token: {
      access_token: accessToken,
      refresh_token: typeof body.refresh_token === 'string' ? body.refresh_token : null,
      token_type: typeof body.token_type === 'string' ? body.token_type : 'bot',
      expires_at: Number.isFinite(expiresIn) && expiresIn > 0 ? new Date(Date.now() + expiresIn * 1000).toISOString() : null,
    },
  };
}

export async function refreshSlackToken(
  config: SlackConfig,
  refreshToken: string,
  send: typeof fetch = fetch,
): Promise<SlackTokenBundle> {
  const { body } = await slackForm('oauth.v2.access', new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
  }), send);
  const expiresIn = Number(body.expires_in);
  if (typeof body.access_token !== 'string' || typeof body.refresh_token !== 'string' || !Number.isFinite(expiresIn)) {
    throw new SlackApiError('Slack returned an incomplete rotated token', 'invalid_refresh_response', 502);
  }
  return {
    access_token: body.access_token,
    refresh_token: body.refresh_token,
    token_type: typeof body.token_type === 'string' ? body.token_type : 'bot',
    expires_at: new Date(Date.now() + expiresIn * 1000).toISOString(),
  };
}

export async function callSlackWebApi(
  method: string,
  accessToken: string,
  payload: Record<string, unknown>,
  send: typeof fetch = fetch,
): Promise<Record<string, unknown>> {
  const response = await send(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json; charset=utf-8', accept: 'application/json' },
    body: JSON.stringify(payload),
    redirect: 'manual',
  });
  const retryAfter = Number(response.headers.get('retry-after') ?? '') || null;
  let body: Record<string, unknown> | null = null;
  try { body = object(await response.json()); } catch { /* handled below */ }
  if (!response.ok || !body || body.ok !== true) {
    const code = typeof body?.error === 'string' ? body.error : `http_${response.status}`;
    throw new SlackApiError(`Slack API ${method} failed: ${code}`, code, response.status, retryAfter);
  }
  return body;
}
