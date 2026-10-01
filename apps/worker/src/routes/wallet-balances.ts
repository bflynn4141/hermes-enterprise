// Wallet balances (C103). Lists the verified wallet addresses a person may see
// (Admins: all; members: their own and their agents') with their Base balances.
// Balances come from Zerion when ZERION_API_KEY is set, otherwise from Turnkey
// (whose balances API needs a paid plan). No database transaction is open while
// the provider answers. An address that can't be read now is reported as
// unavailable, never as zero.
import type { Context } from 'hono';
import { sumUsd, walletBalancesSchema, type WalletBalanceAccount } from '@hermes/shared';
import type { Env } from '../env.js';
import { inWorkspace } from './tenant.js';
import { turnkeySetupConfig } from '../wallets/turnkey-config.js';
import { readBaseBalances, type TurnkeyAssetBalance } from '../wallets/turnkey-client.js';
import { readZerionBaseBalances, zerionFetcher } from '../wallets/zerion.js';

type AccountRow = {
  principal_id: string; kind: 'workspace' | 'member' | 'agent'; member_id: string | null; agent_id: string | null;
  label: string | null; address: string;
};

/** Reads balances for at most this many addresses per request, a few at a time. */
const MAX_ACCOUNTS = 100;
/** Zerion's free key rate-limits parallel reads, so it goes one at a time. */
const CONCURRENCY = { zerion: 1, turnkey: 6 } as const;
/** Each wallet returns its most valuable tokens; the total still counts every token. */
const MAX_ASSETS = 50;

async function mapLimited<T, R>(items: readonly T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  }));
  return results;
}

/** The balance source for this deployment, or null when none is configured. */
type Reader = { concurrency: number; read: (orgId: string, address: string) => Promise<TurnkeyAssetBalance[]> };

function balanceReader(env: Env, config: ReturnType<typeof turnkeySetupConfig>): Reader | null {
  const zerionKey = env.ZERION_API_KEY?.trim();
  if (zerionKey) return { concurrency: CONCURRENCY.zerion, read: (_orgId, address) => readZerionBaseBalances(zerionKey, address, zerionFetcher(env)) };
  if (config) return { concurrency: CONCURRENCY.turnkey, read: (orgId, address) => readBaseBalances(config.turnkey, orgId, address) };
  return null;
}

/** Most valuable first; tokens without a price sort last, by symbol. */
function byValue(a: { usd: string | null; symbol: string }, b: { usd: string | null; symbol: string }): number {
  if (a.usd === null || b.usd === null) return a.usd === null && b.usd === null ? a.symbol.localeCompare(b.symbol) : a.usd === null ? 1 : -1;
  return Number(b.usd) - Number(a.usd) || a.symbol.localeCompare(b.symbol);
}

export async function listWalletBalances(c: Context<{ Bindings: Env }>): Promise<Response> {
  const config = turnkeySetupConfig(c.env);
  const read = balanceReader(c.env, config);
  const visible = await inWorkspace(c, async (work) => {
    if (!config) return { orgId: null, rows: [] as AccountRow[] };
    const { rows: configs } = await work.tx.query<{ provider_org_id: string | null }>(
      "SELECT provider_org_id FROM workspace_wallet_config WHERE workspace_id=$1 AND status='root_verified'", [work.workspaceId]);
    const orgId = configs[0]?.provider_org_id ?? null;
    if (!orgId) return { orgId: null, rows: [] as AccountRow[] };
    const { rows } = await work.tx.query<AccountRow>(
      `SELECT p.id AS principal_id, p.kind, p.member_id, p.agent_id, a.address,
         CASE p.kind WHEN 'workspace' THEN w.name WHEN 'member' THEN u.name ELSE ag.name END AS label
       FROM wallet_accounts a
       JOIN wallet_principals p ON p.workspace_id = a.workspace_id AND p.id = a.principal_id
       JOIN workspaces w ON w.id = p.workspace_id
       LEFT JOIN members m ON m.workspace_id = p.workspace_id AND m.id = p.member_id
       LEFT JOIN users u ON u.id = m.user_id
       LEFT JOIN agents ag ON ag.workspace_id = p.workspace_id AND ag.id = p.agent_id
       WHERE a.workspace_id = $1 AND a.chain_id = 8453 AND ($2::boolean OR
         (p.kind = 'member' AND m.user_id = $3 AND m.status = 'active') OR
         (p.kind = 'agent' AND EXISTS (SELECT 1 FROM agent_owners ao
           JOIN members owner ON owner.workspace_id = ao.workspace_id AND owner.id = ao.member_id
           WHERE ao.workspace_id = p.workspace_id AND ao.agent_id = p.agent_id AND owner.user_id = $3 AND owner.status = 'active')))
       ORDER BY CASE p.kind WHEN 'workspace' THEN 0 WHEN 'member' THEN 1 ELSE 2 END, label, a.verified_at, a.id
       LIMIT ${MAX_ACCOUNTS}`, [work.workspaceId, work.role === 'admin', work.userId]);
    return { orgId, rows };
  });

  const accounts: WalletBalanceAccount[] = read && visible.orgId
    ? await mapLimited(visible.rows, read.concurrency, async (row) => {
      const base = { principal_id: row.principal_id, kind: row.kind, member_id: row.member_id, agent_id: row.agent_id,
        label: row.label ?? (row.kind === 'agent' ? 'Agent' : 'Member'), address: row.address.toLowerCase() };
      try {
        const balances = await read.read(visible.orgId!, row.address);
        const all = balances.map((b) => ({ symbol: b.symbol, name: b.name, decimals: b.decimals, amount: b.balance, usd: b.usd })).sort(byValue);
        return { ...base, status: 'ok' as const, usd: sumUsd(all.map((a) => a.usd)) ?? '0.00',
          assets: all.slice(0, MAX_ASSETS), assets_omitted: Math.max(0, all.length - MAX_ASSETS) };
      } catch {
        return { ...base, status: 'unavailable' as const, usd: null, assets: [], assets_omitted: 0 };
      }
    })
    : [];
  const readable = accounts.filter((a) => a.status === 'ok');
  c.header('Cache-Control', 'no-store');
  return c.json(walletBalancesSchema.parse({
    available: Boolean(read && visible.orgId),
    network: 'Base',
    usd: readable.length ? sumUsd(readable.map((a) => a.usd)) : null,
    partial: readable.length < accounts.length,
    read_at: accounts.length ? new Date().toISOString() : null,
    accounts,
  }));
}
