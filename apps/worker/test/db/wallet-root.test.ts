import { beforeAll, describe, expect, it } from 'vitest';
import type { WalletOverview, WalletRoot, WalletRootChallenge } from '@hermes/shared';
import type { Env } from '../../src/env.js';
import { ALLOWED_ORIGIN, asUser, makeEnv } from './harness.js';
import { seedWorkspace, setTenant, withClient, type Fixture } from './helpers.js';
import { ageSession } from './m4-fixtures.js';

const PARENT = '11111111-2222-4333-8444-555555555555';
const b64url = (text: string) => btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const hex = (bytes: Uint8Array) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const fromB64url = (v: string) => Uint8Array.from(atob(v.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(v.length / 4) * 4, '=')), (c) => c.charCodeAt(0));

/**
 * An in-process Turnkey: it keeps sub-organizations by name, answers the
 * queries the custody check reads, and can be told to misbehave.
 */
class FakeTurnkey {
  orgs = new Map<string, { id: string; rootUserIds: string[]; users: { userId: string; apiKeys: unknown[]; authenticators: { credentialId: string }[] }[]; threshold: number }>();
  requests: { path: string; body: Record<string, unknown>; stamped: boolean }[] = [];
  mode: 'ok' | 'reject' | 'drop_after_create' | 'drop_before_create' | 'hermes_root' = 'ok';
  fetcher: Fetcher = { fetch: async (request: Request) => {
    const path = new URL(request.url).pathname;
    const body = await request.json() as Record<string, unknown>;
    this.requests.push({ path, body, stamped: Boolean(request.headers.get('X-Stamp')) });
    if (path === '/public/v1/submit/create_sub_organization') {
      if (this.mode === 'drop_before_create') throw new TypeError('network');
      if (this.mode === 'reject') return Response.json({ activity: { id: 'act-r', status: 'ACTIVITY_STATUS_REJECTED' } });
      const p = body.parameters as { subOrganizationName: string; rootUsers: { authenticators: { attestation: { credentialId: string } }[] }[] };
      const id = crypto.randomUUID(), rootUserId = crypto.randomUUID();
      // Turnkey may echo the credential id as padded standard base64.
      const credential = btoa(atob(p.rootUsers[0]!.authenticators[0]!.attestation.credentialId.replace(/-/g, '+').replace(/_/g, '/')));
      const users = [{ userId: rootUserId, apiKeys: [] as unknown[], authenticators: [{ credentialId: credential }] }];
      if (this.mode === 'hermes_root') users.push({ userId: 'hermes', apiKeys: [{}], authenticators: [] });
      this.orgs.set(p.subOrganizationName, { id, rootUserIds: this.mode === 'hermes_root' ? [rootUserId, 'hermes'] : [rootUserId], users, threshold: 1 });
      if (this.mode === 'drop_after_create') throw new TypeError('network');
      return Response.json({ activity: { id: 'act-1', status: 'ACTIVITY_STATUS_COMPLETED',
        result: { createSubOrganizationResultV8: { subOrganizationId: id, rootUserIds: [rootUserId] } } } });
    }
    if (path === '/public/v1/query/list_suborgs') {
      const org = this.orgs.get(String(body.filterValue));
      return Response.json({ organizationIds: org ? [org.id] : [] });
    }
    const org = [...this.orgs.values()].find((o) => o.id === body.organizationId);
    if (!org) return Response.json({ code: 5 }, { status: 404 });
    if (path === '/public/v1/query/get_organization_configs') return Response.json({ configs: { quorum: { threshold: org.threshold, userIds: org.rootUserIds } } });
    if (path === '/public/v1/query/list_users') return Response.json({ users: org.users });
    return Response.json({ code: 12 }, { status: 404 });
  } } as Fetcher;
}

let key: { publicKey: string; privateKey: string };
beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey) as JsonWebKey;
  const y = fromB64url(jwk.y!);
  key = { publicKey: ((y[31]! & 1) ? '03' : '02') + hex(fromB64url(jwk.x!)), privateKey: hex(fromB64url(jwk.d!)) };
});

const envFor = (turnkey: FakeTurnkey, overrides: Partial<Env> = {}) => makeEnv({
  TURNKEY_WALLETS_ENABLED: '1', TURNKEY_PROVISIONING_ENABLED: '1', TURNKEY_PARENT_ORG_ID: PARENT,
  TURNKEY_API_PUBLIC_KEY: key.publicKey, TURNKEY_API_PRIVATE_KEY: key.privateKey,
  TURNKEY_PASSKEY_RP_ID: 'localhost', TURNKEY_FETCHER: turnkey.fetcher, ...overrides,
}).env;

const challenge = (env: Env, fx: Fixture, user = fx.adminId) =>
  asUser(env, user, `/w/${fx.workspaceId}/wallets/root/challenge`, { method: 'POST', body: {} });
function attestation(forChallenge: string, over: Record<string, unknown> = {}) {
  return {
    credential_id: 'Y3JlZGVudGlhbC0xMjM0NTY3OA',
    client_data_json: b64url(JSON.stringify({ type: 'webauthn.create', challenge: forChallenge, origin: ALLOWED_ORIGIN, ...over })),
    attestation_object: 'o2NmbXRkbm9uZQ',
    transports: ['internal'],
  };
}
const submit = (env: Env, fx: Fixture, setupId: string, att: unknown, user = fx.adminId) =>
  asUser(env, user, `/w/${fx.workspaceId}/wallets/root`, { method: 'POST', body: { setup_id: setupId, attestation: att } });
const reconcile = (env: Env, fx: Fixture) => asUser(env, fx.adminId, `/w/${fx.workspaceId}/wallets/root/reconcile`, { method: 'POST', body: {} });
const overview = async (env: Env, fx: Fixture, user = fx.adminId) =>
  (await (await asUser(env, user, `/w/${fx.workspaceId}/wallets`)).json() as WalletOverview).root;
async function begin(env: Env, fx: Fixture): Promise<WalletRootChallenge> {
  const response = await challenge(env, fx);
  expect(response.status).toBe(201);
  return await response.json() as WalletRootChallenge;
}
/** Direct SQL as the owner still passes row-level security, so it runs inside the workspace. */
const asOwner = <T>(fx: Fixture, sql: string, params: unknown[]) => withClient('owner', async (c) => {
  await c.query('BEGIN'); await setTenant(c, fx.workspaceId, fx.adminId);
  const result = await c.query<T & Record<string, unknown>>(sql, params);
  await c.query('COMMIT');
  return result;
});
const setupState = async (fx: Fixture) =>
  (await asOwner<{ state: string }>(fx, 'SELECT state FROM wallet_root_setups WHERE workspace_id=$1 ORDER BY created_at DESC LIMIT 1', [fx.workspaceId])).rows[0]?.state;

describe('workspace wallet root setup', () => {
  it("makes the Admin's passkey the only root and verifies it by read-back", async () => {
    const fx = await seedWorkspace(); const turnkey = new FakeTurnkey(); const env = envFor(turnkey);
    expect(await overview(env, fx)).toMatchObject({ status: 'not_started', available: true });
    const started = await begin(env, fx);
    expect(started).toMatchObject({ rp_id: 'localhost' });
    const response = await submit(env, fx, started.setup_id, attestation(started.challenge));
    expect(response.status).toBe(200);
    const root = await response.json() as WalletRoot;
    expect(root).toMatchObject({ status: 'verified', available: true });
    expect(root.owner_name).toBeTruthy();
    expect(root.verified_at).toBeTruthy();
    expect(await overview(env, fx, fx.memberId)).toMatchObject({ status: 'verified' });
    const create = turnkey.requests.find((r) => r.path.endsWith('create_sub_organization'))!;
    expect(create.stamped).toBe(true);
    expect(create.body).toMatchObject({ organizationId: PARENT });
    expect(JSON.stringify(create.body)).not.toContain(key.publicKey);
    // One root per workspace: a second setup is refused.
    expect((await challenge(env, fx)).status).toBe(409);
  });

  it('refuses members, stale sign-ins, disabled deployments, and passkeys made for another challenge or origin', async () => {
    const fx = await seedWorkspace(); const turnkey = new FakeTurnkey(); const env = envFor(turnkey);
    expect((await challenge(envFor(turnkey, { TURNKEY_PROVISIONING_ENABLED: undefined }), fx)).status).toBe(503);
    expect((await challenge(env, fx, fx.memberId)).status).toBe(403);
    const started = await begin(env, fx);
    expect((await submit(env, fx, started.setup_id, attestation('x'.repeat(43)))).status).toBe(400);
    expect((await submit(env, fx, started.setup_id, attestation(started.challenge, { origin: 'https://evil.example' }))).status).toBe(400);
    expect((await submit(env, fx, started.setup_id, attestation(started.challenge, { type: 'webauthn.get' }))).status).toBe(400);
    expect((await submit(env, fx, started.setup_id, attestation(started.challenge), fx.memberId)).status).toBe(403);
    await ageSession(fx.adminId, 10);
    expect((await submit(env, fx, started.setup_id, attestation(started.challenge))).status).toBe(401);
    expect(turnkey.requests).toHaveLength(0);
    expect(await setupState(fx)).toBe('challenged');
  });

  it('never reuses or accepts an expired challenge, or one from another workspace', async () => {
    const fx = await seedWorkspace(); const other = await seedWorkspace(); const turnkey = new FakeTurnkey(); const env = envFor(turnkey);
    const started = await begin(env, fx);
    expect((await submit(env, other, started.setup_id, attestation(started.challenge), other.adminId)).status).toBe(400);
    expect((await asOwner(fx, "UPDATE wallet_root_setups SET expires_at = now() - interval '1 minute' WHERE id=$1", [started.setup_id])).rowCount).toBe(1);
    expect((await submit(env, fx, started.setup_id, attestation(started.challenge))).status).toBe(400);
    const fresh = await begin(env, fx);
    expect((await submit(env, fx, fresh.setup_id, attestation(fresh.challenge))).status).toBe(200);
    expect((await submit(env, fx, fresh.setup_id, attestation(fresh.challenge))).status).toBe(400);
    expect(turnkey.requests.filter((r) => r.path.endsWith('create_sub_organization'))).toHaveLength(1);
  });

  it('lets a new attempt start after Turnkey refuses', async () => {
    const fx = await seedWorkspace(); const turnkey = new FakeTurnkey(); const env = envFor(turnkey);
    turnkey.mode = 'reject';
    const started = await begin(env, fx);
    expect(await (await submit(env, fx, started.setup_id, attestation(started.challenge))).json()).toMatchObject({ status: 'not_started' });
    expect(await setupState(fx)).toBe('rejected');
    turnkey.mode = 'ok';
    const retry = await begin(env, fx);
    expect(await (await submit(env, fx, retry.setup_id, attestation(retry.challenge))).json()).toMatchObject({ status: 'verified' });
  });

  it('reconciles an unanswered create by name instead of creating a second organization', async () => {
    const fx = await seedWorkspace(); const turnkey = new FakeTurnkey(); const env = envFor(turnkey);
    turnkey.mode = 'drop_after_create';
    const started = await begin(env, fx);
    expect(await (await submit(env, fx, started.setup_id, attestation(started.challenge))).json()).toMatchObject({ status: 'needs_reconciliation' });
    expect((await challenge(env, fx)).status).toBe(409);
    turnkey.mode = 'ok';
    expect(await (await reconcile(env, fx)).json()).toMatchObject({ status: 'verified' });
    expect(turnkey.orgs.size).toBe(1);
    expect(turnkey.requests.filter((r) => r.path.endsWith('create_sub_organization'))).toHaveLength(1);
  });

  it('treats "not found" as not created only after the grace period', async () => {
    const fx = await seedWorkspace(); const turnkey = new FakeTurnkey(); const env = envFor(turnkey);
    turnkey.mode = 'drop_before_create';
    const started = await begin(env, fx);
    await submit(env, fx, started.setup_id, attestation(started.challenge));
    expect(await (await reconcile(env, fx)).json()).toMatchObject({ status: 'needs_reconciliation' });
    expect((await asOwner(fx, "UPDATE wallet_root_setups SET updated_at = now() - interval '5 minutes' WHERE id=$1", [started.setup_id])).rowCount).toBe(1);
    expect(await (await reconcile(env, fx)).json()).toMatchObject({ status: 'not_started' });
    expect(await setupState(fx)).toBe('rejected');
  });

  it('recovers a setup whose request died after Turnkey created the organization', async () => {
    const fx = await seedWorkspace(); const turnkey = new FakeTurnkey(); const env = envFor(turnkey);
    const started = await begin(env, fx);
    await submit(env, fx, started.setup_id, attestation(started.challenge));
    // Simulate the Worker dying between Turnkey's answer and recording it.
    await asOwner(fx, "UPDATE wallet_root_setups SET state='submitting', provider_org_id=NULL, provider_root_user_id=NULL WHERE id=$1", [started.setup_id]);
    await asOwner(fx, "UPDATE workspace_wallet_config SET status='creating_root', root_member_id=NULL, root_verified_at=NULL, provider_org_id=NULL WHERE workspace_id=$1", [fx.workspaceId]);
    expect(await overview(env, fx)).toMatchObject({ status: 'in_progress' });
    // Still inside its own request window: not ours to decide yet.
    expect(await (await reconcile(env, fx)).json()).toMatchObject({ status: 'in_progress' });
    await asOwner(fx, "UPDATE wallet_root_setups SET updated_at = now() - interval '5 minutes' WHERE id=$1", [started.setup_id]);
    expect(await (await reconcile(env, fx)).json()).toMatchObject({ status: 'verified' });
    expect(turnkey.orgs.size).toBe(1);
  });

  it('never marks a sub-organization ready when anyone besides the passkey holder is root', async () => {
    const fx = await seedWorkspace(); const turnkey = new FakeTurnkey(); const env = envFor(turnkey);
    turnkey.mode = 'hermes_root';
    const started = await begin(env, fx);
    const root = await (await submit(env, fx, started.setup_id, attestation(started.challenge))).json() as WalletRoot;
    expect(root).toMatchObject({ status: 'needs_attention', owner_name: null, verified_at: null });
    expect((await challenge(env, fx)).status).toBe(409);
  });

  it('keeps setup rows tenant-isolated and out of the agent role', async () => {
    const fx = await seedWorkspace(); const other = await seedWorkspace(); const env = envFor(new FakeTurnkey());
    await begin(env, fx);
    await withClient('app', async (c) => {
      await c.query('BEGIN');
      await c.query("SELECT set_config('app.workspace_id', $1, true)", [other.workspaceId]);
      expect((await c.query('SELECT id FROM wallet_root_setups WHERE workspace_id=$1', [fx.workspaceId])).rows).toEqual([]);
      await c.query('ROLLBACK');
    });
    await withClient('agent', async (c) => {
      await expect(c.query('SELECT id FROM wallet_root_setups')).rejects.toMatchObject({ code: '42501' });
    });
  });
});
