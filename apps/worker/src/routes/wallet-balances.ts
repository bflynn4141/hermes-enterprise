// Wallet balances (C103). Lists the verified wallet addresses a person may see
// (Admins: all; members: their own and their agents') with their Base balances,
// read from Turnkey with the parent's read access. No database transaction is
// open while Turnkey answers. An address Turnkey can't read now is reported as
// unavailable, never as zero.
import type { Context } from 'hono';
import { sumUsd, walletBalancesSchema, type WalletBalanceAccount } from '@hermes/shared';
import type { Env } from '../env.js';
import { inWorkspace } from './tenant.js';
import { turnkeySetupConfig } from '../wallets/turnkey-config.js';
import { readBaseBalances } from '../wallets/turnkey-client.js';

type AccountRow = {
  principal_id: string; kind: 'workspace' | 'member' | 'agent'; member_id: string | null; agent_id: string | null;
  label: string | null; address: string;
};

/** Reads balances for at most this many addresses per request, a few at a time. */
const MAX_ACCOUNTS = 100;
const CONCURRENCY = 6;

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

export async function listWalletBalances(c: Context<{ Bindings: Env }>): Promise<Response> {
  const config = turnkeySetupConfig(c.env);
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

  const accounts: WalletBalanceAccount[] = config && visible.orgId
    ? await mapLimited(visible.rows, CONCURRENCY, async (row) => {
      const base = { principal_id: row.principal_id, kind: row.kind, member_id: row.member_id, agent_id: row.agent_id,
        label: row.label ?? (row.kind === 'agent' ? 'Agent' : 'Member'), address: row.address.toLowerCase() };
      try {
        const balances = await readBaseBalances(config.turnkey, visible.orgId!, row.address);
        const assets = balances.map((b) => ({ symbol: b.symbol, name: b.name, decimals: b.decimals, amount: b.balance, usd: b.usd }));
        return { ...base, status: 'ok' as const, usd: sumUsd(assets.map((a) => a.usd)) ?? '0.00', assets };
      } catch {
        return { ...base, status: 'unavailable' as const, usd: null, assets: [] };
      }
    })
    : [];
  const readable = accounts.filter((a) => a.status === 'ok');
  c.header('Cache-Control', 'no-store');
  return c.json(walletBalancesSchema.parse({
    available: Boolean(config && visible.orgId),
    network: 'Base',
    usd: readable.length ? sumUsd(readable.map((a) => a.usd)) : null,
    partial: readable.length < accounts.length,
    read_at: accounts.length ? new Date().toISOString() : null,
    accounts,
  }));
}
