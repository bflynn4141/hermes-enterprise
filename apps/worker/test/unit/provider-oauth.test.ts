import { describe, expect, it, vi } from 'vitest';
import { pollDeviceToken, requestDeviceCode } from '../../src/routes/provider-oauth.js';

const cfg = { clientId: 'enterprise-hermes', portalBaseUrl: 'https://portal.nousresearch.com', scope: 'inference:invoke' };

describe('Nous inference OAuth contract', () => {
  it('starts only the official device authorization grant and refuses foreign verification redirects', async () => {
    const seen: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    const send = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push([input, init]);
      return Response.json({
      device_code: 'device-secret-value', user_code: 'ABCD-1234',
      verification_uri: 'https://portal.nousresearch.com/device',
      verification_uri_complete: 'https://portal.nousresearch.com/device?code=ABCD-1234',
      expires_in: 600, interval: 5,
      });
    });
    const result = await requestDeviceCode(cfg, send as typeof fetch);
    expect(result.user_code).toBe('ABCD-1234');
    const [url, init] = seen[0]!;
    expect(url).toBe('https://portal.nousresearch.com/api/oauth/device/code');
    expect(String(init?.body)).toContain('scope=inference%3Ainvoke');
    expect(init?.redirect).toBe('manual');

    const hostile = vi.fn(async () => Response.json({
      device_code: 'device-secret-value', user_code: 'ABCD-1234',
      verification_uri: 'https://evil.example/device', verification_uri_complete: 'https://evil.example/device',
      expires_in: 600, interval: 5,
    }));
    await expect(requestDeviceCode(cfg, hostile as typeof fetch)).rejects.toMatchObject({ reason: 'oauth_upstream_invalid' });
  });

  it('polls with the RFC 8628 grant and accepts only inference-scoped rotating credentials', async () => {
    const pending = vi.fn(async () => Response.json({ error: 'authorization_pending' }, { status: 400 }));
    await expect(pollDeviceToken(cfg, 'device-secret-value', pending as typeof fetch)).resolves.toEqual({ kind: 'pending' });

    const seen: Array<[RequestInfo | URL, RequestInit | undefined]> = [];
    const approved = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      seen.push([input, init]);
      return Response.json({
      access_token: 'access-token', refresh_token: 'rotating-refresh-token',
      scope: 'inference:invoke', token_type: 'Bearer', expires_in: 3600,
      inference_base_url: 'https://inference-api.nousresearch.com/v1',
      });
    });
    const result = await pollDeviceToken(cfg, 'device-secret-value', approved as typeof fetch);
    expect(result.kind).toBe('connected');
    const [, init] = seen[0]!;
    expect(String(init?.body)).toContain('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Adevice_code');
    expect(String(init?.body)).toContain('device_code=device-secret-value');

    const wrongScope = vi.fn(async () => Response.json({ access_token: 'access', refresh_token: 'refresh', scope: 'agent_dashboard:access', expires_in: 3600 }));
    await expect(pollDeviceToken(cfg, 'device-secret-value', wrongScope as typeof fetch)).resolves.toEqual({ kind: 'failed', reason: 'oauth_scope_invalid' });
  });
});
