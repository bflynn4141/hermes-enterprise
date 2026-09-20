import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Hono } from 'hono';
import type { Env } from '../../src/env.js';

const mocks = vi.hoisted(() => ({
  query: vi.fn(), requireAdmin: vi.fn(), inWorkspace: vi.fn(),
  requireOrigin: vi.fn(), requireCsrf: vi.fn(), requireStepUp: vi.fn(), consumeRate: vi.fn(),
  openSecret: vi.fn(), sealSecret: vi.fn(), discover: vi.fn(), register: vi.fn(), authorization: vi.fn(),
  exchange: vi.fn(), inspect: vi.fn(), account: vi.fn(),
}));
vi.mock('../../src/routes/tenant.js', () => ({
  inWorkspace: mocks.inWorkspace,
  RouteError: class extends Error {
    constructor(message: string, readonly reason: string, readonly status = 400) { super(message); }
  },
}));
vi.mock('../../src/auth.js', () => ({ requireOrigin: mocks.requireOrigin, requireCsrf: mocks.requireCsrf, requireStepUp: mocks.requireStepUp }));
vi.mock('../../src/auth/rate-limit.js', () => ({ consumeRate: mocks.consumeRate }));
vi.mock('../../src/keys/envelope.js', () => ({ openSecret: mocks.openSecret, sealSecret: mocks.sealSecret }));
vi.mock('../../src/hermes-cloud/management.js', () => ({
  CLOUD_ORIGIN: 'https://portal.nousresearch.com', discoverCloudOAuth: mocks.discover,
  registerCloudClient: mocks.register, makeCloudAuthorizationUrl: mocks.authorization,
  exchangeCloudCode: mocks.exchange, inspectCloudTools: mocks.inspect, inspectCloudOrganization: mocks.account,
}));

import { completeCloudConnection, getCloudConnection, startCloudConnection } from '../../src/routes/cloud-connection.js';

const workspaceId = '11111111-1111-4111-8111-111111111111';
const attemptId = '22222222-2222-4222-8222-222222222222';
const state = 's'.repeat(43);
const env = { HERMES_CLOUD_MANAGEMENT_ENABLED: '1', HERMES_ENTERPRISE_PUBLIC_URL: 'https://hermes.test', ALLOWED_ORIGINS: 'https://hermes.test' } as Env;
const secret = { clientId: 'client-private', redirectUri: `https://hermes.test/w/${workspaceId}/cloud/connection/callback`, verifier: 'pkce-private', sid: 'session-private' };
let attempt: { id: string; initiated_by: string; status: string; expires_at: Date; ciphertext: Uint8Array; iv: Uint8Array; wrapped_dek: Uint8Array; wrap_iv: Uint8Array; kek_version: number } | null;
let connection: Record<string, unknown> | null;
let work: { tx: { query: typeof mocks.query }; workspaceId: string; userId: string; session: { sid: string }; jobs: string[]; requireAdmin: typeof mocks.requireAdmin };

function app() {
  const server = new Hono<{ Bindings: Env }>();
  server.onError((error, c) => c.json({ reason: (error as { reason?: string }).reason ?? 'test_error' }, (error as { status?: 400 }).status ?? 500));
  server.get('/w/:ws/cloud/connection', getCloudConnection);
  server.post('/w/:ws/cloud/connection', startCloudConnection);
  server.get('/w/:ws/cloud/connection/callback', completeCloudConnection);
  return server;
}
function request(path = '', method = 'GET', bindings = env) {
  return app().request(`https://hermes.test/w/${workspaceId}/cloud/connection${path}`, { method }, bindings);
}
const callback = () => request(`/callback?state=${state}&code=code-private`);

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('fetch', vi.fn(() => { throw new Error('Unexpected network or paid call'); }));
  attempt = { id: attemptId, initiated_by: 'user-1', status: 'pending', expires_at: new Date(Date.now() + 60_000), ciphertext: new Uint8Array([1]), iv: new Uint8Array([2]), wrapped_dek: new Uint8Array([3]), wrap_iv: new Uint8Array([4]), kek_version: 1 };
  connection = null;
  work = { tx: { query: mocks.query }, workspaceId, userId: 'user-1', session: { sid: secret.sid }, jobs: [], requireAdmin: mocks.requireAdmin };
  mocks.inWorkspace.mockImplementation(async (_context, operation) => operation(work));
  mocks.query.mockImplementation(async (sql: string) => {
    if (sql.includes('SELECT * FROM cloud_connection_attempts')) return { rows: attempt ? [attempt] : [] };
    if (sql.includes('SELECT id FROM cloud_connection_attempts')) return { rows: attempt?.status === 'consumed' ? [{ id: attempt.id }] : [] };
    if (sql.includes("SET status='consumed'")) { if (attempt) attempt.status = 'consumed'; }
    if (sql.includes("SET status='complete'")) { if (attempt) attempt.status = 'complete'; }
    if (sql.includes('SELECT status FROM cloud_connection_attempts')) return { rows: [] };
    if (sql.includes('FROM cloud_connections')) return { rows: connection ? [connection] : [] };
    return { rows: [], rowCount: 1 };
  });
  mocks.openSecret.mockResolvedValue(JSON.stringify(secret));
  mocks.sealSecret.mockResolvedValue({ ciphertext: new Uint8Array([8]), iv: new Uint8Array([9]), wrappedDek: new Uint8Array([10]), wrapIv: new Uint8Array([11]), kekVersion: 1 });
  mocks.discover.mockResolvedValue({});
  mocks.register.mockResolvedValue(secret.clientId);
  mocks.authorization.mockResolvedValue('https://portal.nousresearch.com/oauth/authorize?state=public');
  mocks.exchange.mockResolvedValue({ accessToken: 'access-private', refreshToken: 'refresh-private', scope: 'mcp:manage_agents' });
  mocks.inspect.mockResolvedValue({ tools: [] });
  mocks.account.mockResolvedValue({ id: 'org-1', name: 'Acme' });
});
afterEach(() => vi.unstubAllGlobals());

describe('Cloud connection route boundaries', () => {
  it('projects only public connection data and never claims automatic setup is ready', async () => {
    connection = { status: 'connected', organization_name: 'Acme', organization_id: 'private-org-id', ciphertext: 'private-cipher', accessToken: 'access-private' };
    const response = await request();
    expect(await response.json()).toEqual({ status: 'connected', organization_name: 'Acme', automatic_setup_ready: false, available: true });
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(mocks.requireAdmin).toHaveBeenCalled();
  });

  it.each(['get', 'start', 'callback'])('requires admin before %s external work', async operation => {
    mocks.requireAdmin.mockImplementation(() => { throw Object.assign(new Error('Admin required'), { reason: 'admin_required', status: 403 }); });
    const response = operation === 'get' ? await request() : operation === 'start' ? await request('', 'POST') : await callback();
    expect(response.status).toBe(403);
    expect(mocks.discover).not.toHaveBeenCalled();
    expect(mocks.exchange).not.toHaveBeenCalled();
    expect(mocks.query).not.toHaveBeenCalled();
  });

  it('requires origin, CSRF and step-up before starting and rechecks step-up after registration', async () => {
    const response = await request('', 'POST');
    expect(response.status).toBe(200);
    expect(mocks.requireOrigin).toHaveBeenCalledWith(expect.anything(), { required: true });
    expect(mocks.requireCsrf).toHaveBeenCalledOnce();
    expect(mocks.requireStepUp).toHaveBeenCalledTimes(2);
    expect(mocks.consumeRate).toHaveBeenCalledOnce();
    const sql = mocks.query.mock.calls.map(([statement]) => statement).join('\n');
    expect(sql).toContain("ciphertext=decode('00','hex')");
    expect(sql).not.toContain('\u0000');
    const inserted = mocks.query.mock.calls.find(([statement]) => statement.includes('INSERT INTO cloud_connection_attempts'))!;
    expect(inserted[1][3]).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(inserted[1])).not.toContain('pkce-private');
    expect(mocks.sealSecret).toHaveBeenCalledWith(
      env,
      { workspaceId, keyId: expect.any(String), namespace: 'hermes/cloud-oauth-attempt/v1' },
      expect.stringContaining('"clientId":"client-private"'),
    );
  });

  it('does not initiate OAuth when step-up is rejected or Cloud is disabled', async () => {
    mocks.requireStepUp.mockImplementation(() => { throw Object.assign(new Error('Sign in'), { status: 403 }); });
    expect((await request('', 'POST')).status).toBe(403);
    mocks.requireStepUp.mockReset();
    expect((await request('', 'POST', { ...env, HERMES_CLOUD_MANAGEMENT_ENABLED: '0' })).status).toBe(503);
    expect(mocks.discover).not.toHaveBeenCalled();
  });

  it.each(['missing', 'expired', 'consumed', 'different_user', 'different_session'])('rejects %s callback before code redemption', async condition => {
    if (condition === 'missing') attempt = null;
    if (condition === 'expired') attempt!.expires_at = new Date(Date.now() - 1);
    if (condition === 'consumed') attempt!.status = 'consumed';
    if (condition === 'different_user') attempt!.initiated_by = 'other-user';
    if (condition === 'different_session') work.session.sid = 'other-session';
    const response = await callback();
    expect([400, 403]).toContain(response.status);
    expect(await response.json()).toEqual({ reason: 'cloud_connection_expired' });
    expect(mocks.exchange).not.toHaveBeenCalled();
    expect(mocks.inspect).not.toHaveBeenCalled();
  });

  it('rejects malformed state before opening a workspace transaction', async () => {
    expect((await request('/callback?state=invalid&code=secret')).status).toBe(400);
    expect(mocks.inWorkspace).not.toHaveBeenCalled();
  });

  it('redeems a callback once, seals the grant and performs only account/schema inspection', async () => {
    const response = await callback();
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toContain('cloud=saved');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(mocks.exchange).toHaveBeenCalledOnce();
    expect(mocks.inspect).toHaveBeenCalledOnce();
    expect(mocks.account).toHaveBeenCalledOnce();
    expect(mocks.openSecret).toHaveBeenCalledWith(
      env,
      { workspaceId, keyId: attemptId, namespace: 'hermes/cloud-oauth-attempt/v1' },
      expect.any(Object),
    );
    expect(mocks.sealSecret).toHaveBeenCalledWith(
      env,
      { workspaceId, keyId: attemptId, namespace: 'hermes/cloud-management-grant/v1' },
      expect.stringContaining('access-private'),
    );
    expect(fetch).not.toHaveBeenCalled();
    const clientResponse = JSON.stringify([...response.headers]) + await response.text();
    for (const token of ['access-private', 'refresh-private', 'pkce-private', 'code-private']) expect(clientResponse).not.toContain(token);
    const sqlArguments = JSON.stringify(mocks.query.mock.calls);
    expect(sqlArguments).not.toContain('access-private');
    expect(sqlArguments).not.toContain('refresh-private');
    expect((await callback()).status).toBe(400);
    expect(mocks.exchange).toHaveBeenCalledOnce();
  });

  it('handles provider rejection without exchanging a code or exposing its error', async () => {
    const response = await request(`/callback?state=${state}&error=access_denied&error_description=private-provider-data`);
    expect(response.status).toBe(303);
    expect(response.headers.get('location')).toContain('cloud=failed');
    expect(response.headers.get('location')).not.toContain('private-provider-data');
    expect(mocks.exchange).not.toHaveBeenCalled();
    expect(mocks.inspect).not.toHaveBeenCalled();
  });

  it.each(['missing', 'mismatched', 'tools_unverified'])('preserves the existing billed organization when replacement is %s', async condition => {
    connection = { status: 'connected', organization_id: 'org-1', organization_name: 'Acme' };
    if (condition === 'missing') mocks.account.mockResolvedValue(null);
    if (condition === 'mismatched') mocks.account.mockResolvedValue({ id: 'other-org', name: 'Other' });
    if (condition === 'tools_unverified') mocks.inspect.mockRejectedValue(new Error('private-provider-data'));
    const response = await callback();
    expect(response.headers.get('location')).toContain('cloud=failed');
    expect(mocks.sealSecret).not.toHaveBeenCalled();
    expect(mocks.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO cloud_connections'))).toBe(false);
    expect(mocks.query.mock.calls.some(([sql]) => sql.includes("SET status='connected'"))).toBe(false);
  });

  it('stores a first connection as unverified when organization inspection is unavailable', async () => {
    mocks.account.mockRejectedValue(new Error('private-provider-data'));
    const response = await callback();
    expect(response.headers.get('location')).toContain('cloud=saved');
    expect(mocks.query.mock.calls.some(([sql]) => sql.includes('INSERT INTO cloud_connections'))).toBe(true);
    expect(mocks.query.mock.calls.some(([sql]) => sql.includes("SET status='connected'"))).toBe(false);
  });
});
