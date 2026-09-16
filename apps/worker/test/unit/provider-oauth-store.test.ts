import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveKey, sealKey } from '../../src/keys/index.js';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const KEY = '22222222-2222-4222-8222-222222222222';
const env = { KEK_V1: btoa(String.fromCharCode(...new Uint8Array(32).fill(7))) };

async function oauthRow() {
  const credential = {
    access_token: 'expired-access', refresh_token: 'old-rotating-refresh', client_id: 'enterprise-hermes',
    scope: 'inference:invoke', token_type: 'Bearer', portal_base_url: 'https://portal.nousresearch.com',
    inference_base_url: 'https://inference-api.nousresearch.com/v1',
    expires_at: new Date(Date.now() - 60_000).toISOString(),
  };
  const sealed = await sealKey(env, { workspaceId: WORKSPACE, keyId: KEY }, JSON.stringify(credential));
  return {
    id: KEY, provider: 'nous_portal', status: 'verified', credential_kind: 'oauth_device_code',
    ciphertext: sealed.ciphertext, iv: sealed.iv, wrapped_dek: sealed.wrappedDek,
    wrap_iv: sealed.wrapIv, kek_version: sealed.kekVersion,
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('OAuth runtime credential resolution', () => {
  it('refreshes an expiring access token and persists the rotated bundle before returning it', async () => {
    const row = await oauthRow();
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [row], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    const send = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('x-nous-refresh-token')).toBe('old-rotating-refresh');
      expect(String(init?.body)).not.toContain('old-rotating-refresh');
      return Response.json({ access_token: 'fresh-access', refresh_token: 'new-rotating-refresh', expires_in: 3600, scope: 'inference:invoke' });
    });
    vi.stubGlobal('fetch', send);
    await expect(resolveKey({ query } as never, env, WORKSPACE, 'nous_portal')).resolves.toMatchObject({ apiKey: 'fresh-access' });
    expect(query).toHaveBeenCalledTimes(2);
    expect(String(query.mock.calls[1]?.[0])).toContain('SET ciphertext=');
  });

  it('quarantines a terminal refresh failure instead of replaying a rotated token', async () => {
    const row = await oauthRow();
    const query = vi.fn()
      .mockResolvedValueOnce({ rows: [row], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 1 });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'invalid_grant' }, { status: 400 })));
    await expect(resolveKey({ query } as never, env, WORKSPACE, 'nous_portal')).resolves.toMatchObject({ status: 'invalid', apiKey: '' });
    expect(String(query.mock.calls[1]?.[0])).toContain("status='invalid'");
  });

  it('does not quarantine a transient refresh failure', async () => {
    const row = await oauthRow();
    const query = vi.fn().mockResolvedValueOnce({ rows: [row], rowCount: 1 });
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: 'rate_limited' }, { status: 429 })));
    await expect(resolveKey({ query } as never, env, WORKSPACE, 'nous_portal')).rejects.toMatchObject({ reason: 'key_invalid' });
    expect(query).toHaveBeenCalledTimes(1);
  });
});
