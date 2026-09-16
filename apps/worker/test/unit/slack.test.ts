import { describe, expect, it } from 'vitest';
import type { Env } from '../../src/env.js';
import { callSlackWebApi, exchangeSlackCode, SlackApiError } from '../../src/integrations/slack/api.js';
import { SLACK_BOT_EVENTS, SLACK_BOT_SCOPES, slackAuthorizeUrl, slackConfig, slackInstallKey } from '../../src/integrations/slack/config.js';
import { signSlackOAuthState, verifySlackOAuthState, verifySlackRequest } from '../../src/integrations/slack/security.js';

const hmac = async (secret: string, value: string): Promise<string> => {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const bytes = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(value)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
};

describe('Slack request and OAuth boundaries', () => {
  it('verifies the raw request body and refuses replays older than five minutes', async () => {
    const secret = 'fixture-signing-secret';
    const now = 1_800_000_000;
    const body = JSON.stringify({ type: 'event_callback', event_id: 'Ev-fixture' });
    const signature = await hmac(secret, `v0:${now}:${body}`);
    const headers = new Headers({
      'x-slack-request-timestamp': String(now),
      'x-slack-signature': `v0=${signature}`,
    });
    await expect(verifySlackRequest(headers, body, secret, now)).resolves.toEqual({ ok: true, timestamp: now });
    await expect(verifySlackRequest(headers, `${body} `, secret, now)).resolves.toEqual({ ok: false, reason: 'bad_signature' });
    await expect(verifySlackRequest(headers, body, secret, now + 301)).resolves.toEqual({ ok: false, reason: 'stale_request' });
  });

  it('binds signed OAuth state to workspace, caller, expiry and redirect URI', async () => {
    const payload = {
      v: 1 as const,
      workspace_id: '11111111-1111-4111-8111-111111111111',
      user_id: '22222222-2222-4222-8222-222222222222',
      nonce: 'fixture-nonce',
      expires_at: 1_800_000_600,
      redirect_uri: 'https://hermes.example/integrations/slack/oauth/callback',
    };
    const state = await signSlackOAuthState(payload, 'fixture-state-secret');
    await expect(verifySlackOAuthState(state, 'fixture-state-secret', 1_800_000_000)).resolves.toEqual(payload);
    await expect(verifySlackOAuthState(`${state}x`, 'fixture-state-secret', 1_800_000_000)).resolves.toBeNull();
    await expect(verifySlackOAuthState(state, 'fixture-state-secret', 1_800_000_601)).resolves.toBeNull();
  });
});

describe('Slack app configuration and API contracts', () => {
  const env = {
    SLACK_ENABLED: '1',
    SLACK_CLIENT_ID: 'fixture-client',
    SLACK_CLIENT_SECRET: 'fixture-secret',
    SLACK_SIGNING_SECRET: 'fixture-signing',
    SLACK_STATE_SECRET: 'fixture-state',
    SLACK_REDIRECT_URI: 'https://hermes.example/integrations/slack/oauth/callback',
  } as unknown as Env;

  it('fails closed when incomplete and emits the least-privilege manifest surface', () => {
    expect(slackConfig({ ...env, SLACK_SIGNING_SECRET: '' })).toBeNull();
    const config = slackConfig(env)!;
    const url = new URL(slackAuthorizeUrl(config, 'signed-state'));
    expect(url.origin).toBe('https://slack.com');
    expect(url.searchParams.get('scope')?.split(',')).toEqual([...SLACK_BOT_SCOPES]);
    expect(SLACK_BOT_EVENTS).toEqual(['app_mention', 'message.im']);
    expect(slackInstallKey({ isEnterpriseInstall: false, teamId: 'T1' })).toBe('team:T1');
    expect(slackInstallKey({ isEnterpriseInstall: true, enterpriseId: 'E1' })).toBe('enterprise:E1');
  });

  it('normalizes OAuth grants and preserves Slack retry guidance', async () => {
    const config = slackConfig(env)!;
    const exchange = await exchangeSlackCode(config, 'fixture-code', async () => new Response(JSON.stringify({
      ok: true,
      app_id: 'A1',
      access_token: 'fixture-access-token',
      refresh_token: 'fixture-refresh-token',
      expires_in: 43_200,
      token_type: 'bot',
      scope: SLACK_BOT_SCOPES.join(','),
      bot_user_id: 'U-BOT',
      authed_user: { id: 'U-HUMAN' },
      team: { id: 'T1', name: 'Fixture' },
      is_enterprise_install: false,
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    expect(exchange.team?.id).toBe('T1');
    expect(exchange.scope).toEqual([...SLACK_BOT_SCOPES]);
    expect(exchange.token.refresh_token).toBe('fixture-refresh-token');

    const rejected = callSlackWebApi('chat.postMessage', 'fixture-token', { channel: 'C1', text: 'hello' }, async () =>
      new Response(JSON.stringify({ ok: false, error: 'ratelimited' }), {
        status: 429,
        headers: { 'content-type': 'application/json', 'retry-after': '47' },
      }));
    await expect(rejected).rejects.toMatchObject({ code: 'ratelimited', retryAfterSeconds: 47 } satisfies Partial<SlackApiError>);
  });
});
