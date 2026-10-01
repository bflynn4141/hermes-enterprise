import { beforeAll, describe, expect, it } from 'vitest';
import type { WalletBalances } from '@hermes/shared';
import type { Env } from '../../src/env.js';
import { asUser, makeEnv } from './harness.js';
import { seedWorkspace, setTenant, withClient, type Fixture } from './helpers.js';

const PARENT = '99999999-2222-4333-8444-555555555555';
const ADMIN_ADDRESS = '0x1111111111111111111111111111111111111111';
const MEMBER_ADDRESS = '0x2222222222222222222222222222222222222222';

let key: { publicKey: string; privateKey: string };
beforeAll(async () => {
  const pair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']) as CryptoKeyPair;
  const jwk = await crypto.subtle.exportKey('jwk', pair.privateKey) as JsonWebKey;
  const bytes = (v: string) => Uint8Array.from(atob(v.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(v.length / 4) * 4, '=')), (c) => c.charCodeAt(0));
  const hex = (b: Uint8Array) => Array.from(b, (n) => n.toString(16).padStart(2, '0')).join('');
  key = { publicKey: ((bytes(jwk.y!)[31]! & 1) ? '03' : '02') + hex(bytes(jwk.x!)), privateKey: hex(bytes(jwk.d!)) };
});

/** Turnkey's balance query, per address; an address in `failing` answers 503. */
function fakeTurnkey(balances: Record<string, unknown[]>, failing: string[] = []) {
  const calls: { organizationId: unknown; address: unknown; caip2: unknown; stamped: boolean }[] = [];
  const fetcher = { fetch: async (request: Request) => {
    const body = await request.json() as Record<string, unknown>;
    if (!new URL(request.url).pathname.endsWith('/get_wallet_address_balances')) return Response.json({ code: 12 }, { status: 404 });
    calls.push({ organizationId: body.organizationId, address: body.address, caip2: body.caip2, stamped: Boolean(request.headers.get('X-Stamp')) });
    if (failing.includes(String(body.address))) return new Response('', { status: 503 });
    return Response.json({ balances: balances[String(body.address)] ?? [] });
  } } as Fetcher;
  return { fetcher, calls };
}

const envFor = (fetcher: Fetcher): Env => makeEnv({
  TURNKEY_WALLETS_ENABLED: '1', TURNKEY_PROVISIONING_ENABLED: '1', TURNKEY_PARENT_ORG_ID: PARENT,
  TURNKEY_API_PUBLIC_KEY: key.publicKey, TURNKEY_API_PRIVATE_KEY: key.privateKey,
  TURNKEY_PASSKEY_RP_ID: 'localhost', TURNKEY_FETCHER: fetcher,
}).env;

/** A workspace whose owner is verified, with one wallet for the Admin and one for the member. */
async function seedWallets(fx: Fixture, verified = true): Promise<string> {
  const org = crypto.randomUUID();
  await withClient('owner', async (c) => {
    await c.query('BEGIN'); await setTenant(c, fx.workspaceId, fx.adminId);
    const member = async (userId: string) => (await c.query<{ id: string }>(
      'SELECT id FROM members WHERE workspace_id=$1 AND user_id=$2', [fx.workspaceId, userId])).rows[0]!.id;
    const adminMember = await member(fx.adminId), plainMember = await member(fx.memberId);
    await c.query(verified
      ? `INSERT INTO workspace_wallet_config(workspace_id,status,provider_org_id,root_member_id,root_verified_at) VALUES ($1,'root_verified',$2,$3,now())`
      : `INSERT INTO workspace_wallet_config(workspace_id) VALUES ($1)`, verified ? [fx.workspaceId, org, adminMember] : [fx.workspaceId]);
    for (const [memberId, address] of [[adminMember, ADMIN_ADDRESS], [plainMember, MEMBER_ADDRESS]] as const) {
      const { rows } = await c.query<{ id: string }>(
        "INSERT INTO wallet_principals(workspace_id,kind,member_id) VALUES ($1,'member',$2) RETURNING id", [fx.workspaceId, memberId]);
      await c.query('INSERT INTO wallet_accounts(workspace_id,principal_id,chain_id,address,verified_at) VALUES ($1,$2,8453,$3,now())',
        [fx.workspaceId, rows[0]!.id, address]);
    }
    await c.query('COMMIT');
  });
  return org;
}

const usdc = (atomic: string, usd: string) => ({ symbol: 'USDC', name: 'USD Coin', decimals: 6, balance: atomic, display: { usd, crypto: '' } });
const eth = (atomic: string, usd: string) => ({ symbol: 'ETH', name: 'Ether', decimals: 18, balance: atomic, display: { usd, crypto: '' } });
const balancesOf = async (env: Env, fx: Fixture, user = fx.adminId) =>
  (await (await asUser(env, user, `/w/${fx.workspaceId}/wallets/balances`)).json()) as WalletBalances;

describe('wallet balances', () => {
  it('shows each verified wallet with its Base balances and an exact workspace total', async () => {
    const fx = await seedWorkspace(); const org = await seedWallets(fx);
    const turnkey = fakeTurnkey({ [ADMIN_ADDRESS]: [usdc('1250000000', '1250.00'), eth('500000000000000000', '1325.505')], [MEMBER_ADDRESS]: [usdc('10500000', '10.50')] });
    const result = await balancesOf(envFor(turnkey.fetcher), fx);
    expect(result).toMatchObject({ available: true, network: 'Base', usd: '2586.01', partial: false });
    const byAddress = [...result.accounts].sort((a, b) => a.address.localeCompare(b.address));
    expect(byAddress.map((a) => [a.address, a.status, a.usd])).toEqual([[ADMIN_ADDRESS, 'ok', '2575.51'], [MEMBER_ADDRESS, 'ok', '10.50']]);
    expect(byAddress[0]!.assets.map((a) => a.symbol)).toEqual(['ETH', 'USDC']);
    expect(byAddress[0]!.assets.find((a) => a.symbol === 'USDC')).toEqual({ symbol: 'USDC', name: 'USD Coin', decimals: 6, amount: '1250000000', usd: '1250.00' });
    // Read inside the workspace org on Base, with Hermes's (read-only) parent key.
    expect(turnkey.calls.every((call) => call.organizationId === org && call.caip2 === 'eip155:8453' && call.stamped)).toBe(true);
  });

  it('shows a member only their own wallet', async () => {
    const fx = await seedWorkspace(); await seedWallets(fx);
    const turnkey = fakeTurnkey({ [MEMBER_ADDRESS]: [usdc('10500000', '10.50')] });
    const result = await balancesOf(envFor(turnkey.fetcher), fx, fx.memberId);
    expect(result.accounts.map((a) => a.address)).toEqual([MEMBER_ADDRESS]);
    expect(turnkey.calls.map((c) => c.address)).toEqual([MEMBER_ADDRESS]);
    const other = await seedWorkspace();
    expect((await asUser(envFor(turnkey.fetcher), other.adminId, `/w/${fx.workspaceId}/wallets/balances`)).status).toBe(404);
  });

  it('marks an unreadable wallet unavailable instead of zero, and the total partial', async () => {
    const fx = await seedWorkspace(); await seedWallets(fx);
    const turnkey = fakeTurnkey({ [ADMIN_ADDRESS]: [usdc('5000000', '5.00')] }, [MEMBER_ADDRESS]);
    const result = await balancesOf(envFor(turnkey.fetcher), fx);
    expect(result).toMatchObject({ usd: '5.00', partial: true });
    expect(result.accounts.find((a) => a.address === MEMBER_ADDRESS)).toMatchObject({ status: 'unavailable', usd: null, assets: [] });
  });

  it('reads nothing until the owner is verified or when provider setup is off', async () => {
    const fx = await seedWorkspace(); await seedWallets(fx, false);
    const turnkey = fakeTurnkey({});
    expect(await balancesOf(envFor(turnkey.fetcher), fx)).toMatchObject({ available: false, usd: null, accounts: [] });
    const verified = await seedWorkspace(); await seedWallets(verified);
    const off = makeEnv({ TURNKEY_WALLETS_ENABLED: '1', TURNKEY_FETCHER: turnkey.fetcher }).env;
    expect(await balancesOf(off, verified)).toMatchObject({ available: false, accounts: [] });
    expect(turnkey.calls).toHaveLength(0);
  });

  it('reads from Zerion when its key is set, never calling Turnkey', async () => {
    const fx = await seedWorkspace(); await seedWallets(fx);
    const turnkey = fakeTurnkey({ [ADMIN_ADDRESS]: [usdc('1', '0.01')] });
    const zerionCalls: string[] = [];
    const zerion = { fetch: async (request: Request) => {
      const address = new URL(request.url).pathname.split('/')[3]!;
      zerionCalls.push(address);
      return Response.json({ data: address === ADMIN_ADDRESS ? [{ attributes: { quantity: { int: '2000000', decimals: 6 }, value: 2,
        fungible_info: { symbol: 'USDC', name: 'USD Coin' } }, relationships: { chain: { data: { id: 'base' } } } }] : [] });
    } } as Fetcher;
    const env = makeEnv({
      TURNKEY_WALLETS_ENABLED: '1', TURNKEY_PROVISIONING_ENABLED: '1', TURNKEY_PARENT_ORG_ID: PARENT,
      TURNKEY_API_PUBLIC_KEY: key.publicKey, TURNKEY_API_PRIVATE_KEY: key.privateKey, TURNKEY_PASSKEY_RP_ID: 'localhost',
      TURNKEY_FETCHER: turnkey.fetcher, ZERION_API_KEY: 'zk_test', ZERION_FETCHER: zerion,
    }).env;
    const result = await balancesOf(env, fx);
    expect(result).toMatchObject({ available: true, usd: '2.00', partial: false });
    expect(zerionCalls.sort()).toEqual([ADMIN_ADDRESS, MEMBER_ADDRESS]);
    expect(turnkey.calls).toHaveLength(0);
  });

  it('reads Zerion one wallet at a time and keeps the 50 most valuable tokens per wallet', async () => {
    const fx = await seedWorkspace(); await seedWallets(fx);
    let inFlight = 0, maxInFlight = 0;
    const many = Array.from({ length: 60 }, (_, i) => ({ attributes: { quantity: { int: '1000000', decimals: 6 }, value: i + 1,
      fungible_info: { symbol: `T${i}`, name: `Token ${i}` } }, relationships: { chain: { data: { id: 'base' } } } }));
    const zerion = { fetch: async () => {
      inFlight++; maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, 20));
      inFlight--;
      return Response.json({ data: many });
    } } as unknown as Fetcher;
    const env = makeEnv({ TURNKEY_WALLETS_ENABLED: '1', TURNKEY_PROVISIONING_ENABLED: '1', TURNKEY_PARENT_ORG_ID: PARENT,
      TURNKEY_API_PUBLIC_KEY: key.publicKey, TURNKEY_API_PRIVATE_KEY: key.privateKey, TURNKEY_PASSKEY_RP_ID: 'localhost',
      ZERION_API_KEY: 'zk_test', ZERION_FETCHER: zerion }).env;
    const result = await balancesOf(env, fx);
    expect(maxInFlight).toBe(1);
    const account = result.accounts[0]!;
    expect(account.assets).toHaveLength(50);
    expect(account.assets_omitted).toBe(10);
    expect(account.assets[0]!.symbol).toBe('T59');
    // 1 + 2 + ... + 60 = 1,830 dollars per wallet: the total counts every token, not just the 50 shown.
    expect(account.usd).toBe('1830.00');
    expect(result.usd).toBe('3660.00');
  });
});
