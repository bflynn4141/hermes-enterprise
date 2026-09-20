import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { asUser, makeEnv, ALLOWED_ORIGIN } from './harness.js';
import { seedWorkspace, setTenant, withClient } from './helpers.js';
import { CLOUD_ORIGIN, CLOUD_SCOPE, CLOUD_RESOURCE } from '../../src/hermes-cloud/management.js';

const env = () => makeEnv({ HERMES_CLOUD_MANAGEMENT_ENABLED: '1', HERMES_ENTERPRISE_PUBLIC_URL: 'https://enterprise.example', ALLOWED_ORIGINS: `${ALLOWED_ORIGIN},https://enterprise.example`,
  KEK_V1: Buffer.from(new Uint8Array(32).fill(7)).toString('base64') }).env;
const fixtureProvider = () => {
  let organization = 'cloud-acme';
  const methods: string[] = [];
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('oauth-protected-resource')) return Response.json({ resource: CLOUD_RESOURCE, authorization_servers: [CLOUD_ORIGIN], scopes_supported: [CLOUD_SCOPE], bearer_methods_supported: ['header'] });
    if (url.endsWith('oauth-authorization-server')) return Response.json({ issuer: CLOUD_ORIGIN, authorization_endpoint: `${CLOUD_ORIGIN}/oauth/authorize`, token_endpoint: `${CLOUD_ORIGIN}/api/oauth/token`, registration_endpoint: `${CLOUD_ORIGIN}/api/oauth/register`, scopes_supported: [CLOUD_SCOPE], code_challenge_methods_supported: ['S256'], grant_types_supported: ['authorization_code', 'refresh_token'], response_types_supported: ['code'], token_endpoint_auth_methods_supported: ['none'] });
    if (url.endsWith('/register')) return Response.json({ ...JSON.parse(String(init?.body)), client_id: 'fixture-cloud-client' });
    if (url.endsWith('/token')) return Response.json({ access_token: 'fixture-access-secret', refresh_token: 'fixture-refresh-secret', scope: CLOUD_SCOPE, token_type: 'Bearer', expires_in: 600 });
    if (url.endsWith('/account')) return Response.json({ organisation: { id: organization, name: 'Cloud Acme' } });
    if (url === CLOUD_RESOURCE) {
      const body = JSON.parse(String(init?.body)); methods.push(body.method);
      if (body.method === 'notifications/initialized') return new Response(null, { status: 202 });
      if (body.method === 'initialize') return Response.json({ jsonrpc: '2.0', id: body.id, result: { protocolVersion: '2025-03-26', capabilities: { tools: {} } } });
      if (body.method === 'tools/list') return Response.json({ jsonrpc: '2.0', id: body.id, result: { tools: [{ name: 'agent', inputSchema: {} }, { name: 'agents', inputSchema: {} }] } });
    }
    throw new Error('Unexpected provider call');
  });
  vi.stubGlobal('fetch', fetcher);
  return { methods, fetcher, changeOrganization: () => { organization = 'another-cloud-org'; } };
};

describe('Cloud connection database and HTTP flow', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('connects with encrypted credentials, one-use state, safe status, and no paid calls', async () => {
    const fx = await seedWorkspace(); const bindings = env(); const provider = fixtureProvider();
    const base = `/w/${fx.workspaceId}/cloud/connection`;
    const start = await asUser(bindings, fx.adminId, `${base}/start`, { method: 'POST' });
    expect(start.status).toBe(200);
    const authorize = new URL((await start.json() as { authorization_url: string }).authorization_url);
    const callback = `${base}/callback?state=${authorize.searchParams.get('state')}&code=fixture-code`;
    expect((await asUser(bindings, fx.memberId, callback)).status).toBe(403);
    const complete = await asUser(bindings, fx.adminId, callback);
    expect(complete.status).toBe(303);
    expect(complete.headers.get('location')).toContain('cloud=saved');
    const status = await asUser(bindings, fx.adminId, base);
    expect(await status.json()).toEqual({ available: true, status: 'connected', organization_name: 'Cloud Acme', automatic_setup_ready: false });
    expect((await asUser(bindings, fx.adminId, callback)).status).toBe(400);
    expect(provider.methods).toEqual(['initialize', 'notifications/initialized', 'tools/list']);
    await withClient('app', async c => {
      await c.query('BEGIN'); await setTenant(c, fx.workspaceId, fx.adminId);
      const result = await c.query('SELECT ciphertext FROM cloud_connections WHERE workspace_id=$1', [fx.workspaceId]);
      expect(result.rows[0].ciphertext.toString()).not.toContain('fixture-access-secret');
      const attempts = await c.query('SELECT status, ciphertext FROM cloud_connection_attempts WHERE workspace_id=$1', [fx.workspaceId]);
      expect(attempts.rows[0].status).toBe('complete');
      expect(attempts.rows[0].ciphertext.equals(Buffer.from([0]))).toBe(true);
      await c.query('COMMIT');
    });
    provider.changeOrganization();
    const retry = await asUser(bindings, fx.adminId, `${base}/start`, { method: 'POST' });
    const retryUrl = new URL((await retry.json() as { authorization_url: string }).authorization_url);
    const wrongOrg = await asUser(bindings, fx.adminId, `${base}/callback?state=${retryUrl.searchParams.get('state')}&code=fixture-retry`);
    expect(wrongOrg.headers.get('location')).toContain('cloud=failed');
    expect(await (await asUser(bindings, fx.adminId, base)).json()).toMatchObject({ status: 'connected', organization_name: 'Cloud Acme' });
  });
  it('enforces tenant isolation, agent secrecy, admin start, and disabled configuration', async () => {
    const first = await seedWorkspace(); const second = await seedWorkspace(); const bindings = env(); const provider = fixtureProvider();
    expect((await asUser(bindings, first.memberId, `/w/${first.workspaceId}/cloud/connection/start`, { method: 'POST' })).status).toBe(403);
    expect((await asUser({ ...bindings, HERMES_CLOUD_MANAGEMENT_ENABLED: '0' }, first.adminId, `/w/${first.workspaceId}/cloud/connection/start`, { method: 'POST' })).status).toBe(503);
    expect(provider.fetcher).not.toHaveBeenCalled();
    await withClient('app', async c => {
      await c.query('BEGIN'); await setTenant(c, first.workspaceId, first.adminId);
      await c.query(`INSERT INTO cloud_connections(id,workspace_id,initiated_by,status,ciphertext,iv,wrapped_dek,wrap_iv,kek_version)
        VALUES($1,$2,$3,'verification_required',$4,$4,$4,$4,1)`, [randomUUID(), first.workspaceId, first.adminId, Buffer.from([1])]);
      await setTenant(c, second.workspaceId, second.adminId);
      expect((await c.query('SELECT id FROM cloud_connections')).rows).toHaveLength(0);
      await c.query('COMMIT');
    });
    await withClient('agent', async c => {
      await c.query('BEGIN'); await setTenant(c, first.workspaceId, first.adminId);
      await expect(c.query('SELECT * FROM cloud_connections')).rejects.toMatchObject({ code: '42501' });
      await c.query('ROLLBACK');
    });
  });
});
