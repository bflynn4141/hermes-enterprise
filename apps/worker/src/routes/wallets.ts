import type { Context } from 'hono';
import { walletEnrollmentInputSchema, walletOverviewSchema, walletRecordSchema } from '@hermes/shared';
import type { Env } from '../env.js';
import { requireCsrf, requireOrigin, requireStepUp } from '../auth.js';
import { inWorkspace, jsonBody, RouteError, type TenantWork } from './tenant.js';

// Provider custody is intentionally absent: recording intent is not creating a
// wallet, and an application Admin is not a Turnkey root owner.
async function records(work: TenantWork) {
  const { rows } = await work.tx.query(
    `SELECT p.id, p.kind, p.member_id, p.agent_id,
       CASE p.kind WHEN 'workspace' THEN w.name WHEN 'member' THEN u.name ELSE a.name END AS label,
       e.state AS status, NULL AS address, p.created_at
     FROM wallet_principals p
     JOIN wallet_enrollment_operations e ON e.workspace_id = p.workspace_id AND e.principal_id = p.id
     JOIN workspaces w ON w.id = p.workspace_id
     LEFT JOIN members m ON m.workspace_id = p.workspace_id AND m.id = p.member_id
     LEFT JOIN users u ON u.id = m.user_id
     LEFT JOIN agents a ON a.workspace_id = p.workspace_id AND a.id = p.agent_id
     WHERE p.workspace_id = $1 AND ($2::boolean OR
       (p.kind = 'member' AND m.user_id = $3 AND m.status = 'active') OR
       (p.kind = 'agent' AND EXISTS (SELECT 1 FROM agent_owners ao
         JOIN members owner ON owner.workspace_id = ao.workspace_id AND owner.id = ao.member_id
         WHERE ao.workspace_id = p.workspace_id AND ao.agent_id = p.agent_id AND owner.user_id = $3 AND owner.status = 'active')))
     ORDER BY p.created_at, p.id`, [work.workspaceId, work.role === 'admin', work.userId],
  );
  return rows.map((row) => walletRecordSchema.parse({ ...row, label: row.label ?? 'Member', created_at: new Date(row.created_at).toISOString() }));
}
export async function listWallets(c: Context<{ Bindings: Env }>): Promise<Response> {
  const result = await inWorkspace(c, async (work) => {
    const enabled = c.env.TURNKEY_WALLETS_ENABLED === '1';
    const items = enabled ? await records(work) : [];
    return { enabled, chain_id: 8453, asset: 'USDC', can_manage: work.role === 'admin',
      setup_status: items.length ? 'awaiting_owner_enrollment' : 'not_configured', items };
  });
  c.header('Cache-Control', 'no-store');
  return c.json(walletOverviewSchema.parse(result));
}
export async function requestWalletEnrollment(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: false });
  requireCsrf(c);
  const parsed = walletEnrollmentInputSchema.safeParse(await jsonBody<unknown>(c));
  if (!parsed.success) throw new RouteError('choose a workspace, member, or agent wallet', 'bad_wallet_enrollment', 422);
  const input = parsed.data;
  const result = await inWorkspace(c, async (work) => {
    work.requireAdmin('requesting wallet setup');
    requireStepUp(work.session);
    if (c.env.TURNKEY_WALLETS_ENABLED !== '1') throw new RouteError('wallet setup is not enabled', 'wallets_unavailable', 503);
    // Serializes both the initial config and principal idempotency, including
    // concurrent requests. No provider call happens while holding this lock.
    await work.tx.query('SELECT id FROM workspaces WHERE id = $1 FOR UPDATE', [work.workspaceId]);
    const memberId = input.kind === 'member' ? input.member_id : null;
    const agentId = input.kind === 'agent' ? input.agent_id : null;
    if (memberId) {
      const member = await work.tx.query("SELECT id FROM members WHERE workspace_id = $1 AND id = $2 AND status = 'active' FOR SHARE", [work.workspaceId, memberId]);
      if (!member.rows.length) throw new RouteError('no active member in this workspace', 'unknown_member', 404);
    }
    if (agentId) {
      const agent = await work.tx.query(`SELECT a.id FROM agents a JOIN agent_owners ao ON ao.workspace_id = a.workspace_id AND ao.agent_id = a.id JOIN members owner ON owner.workspace_id = ao.workspace_id AND owner.id = ao.member_id WHERE a.workspace_id = $1 AND a.id = $2 AND owner.status = 'active' FOR SHARE OF a, ao, owner`, [work.workspaceId, agentId]);
      if (!agent.rows.length) throw new RouteError('no agent with an active owner in this workspace', 'unknown_agent', 404);
    }
    await work.tx.query('INSERT INTO workspace_wallet_config(workspace_id) VALUES ($1) ON CONFLICT DO NOTHING', [work.workspaceId]);
    const existing = await work.tx.query<{ id: string }>(
      'SELECT id FROM wallet_principals WHERE workspace_id = $1 AND kind = $2 AND member_id IS NOT DISTINCT FROM $3::uuid AND agent_id IS NOT DISTINCT FROM $4::uuid',
      [work.workspaceId, input.kind, memberId, agentId]);
    let id = existing.rows[0]?.id;
    if (!id) {
      const inserted = await work.tx.query<{ id: string }>(
        'INSERT INTO wallet_principals(workspace_id,kind,member_id,agent_id) VALUES ($1,$2,$3,$4) RETURNING id',
        [work.workspaceId, input.kind, memberId, agentId]);
      id = inserted.rows[0]!.id;
      await work.tx.query('INSERT INTO wallet_enrollment_operations(workspace_id,principal_id,requested_by) VALUES ($1,$2,$3)', [work.workspaceId, id, work.userId]);
      await work.tx.query("INSERT INTO events(workspace_id,actor_type,actor_user_id,kind) VALUES ($1,'user',$2,'settings.changed')", [work.workspaceId, work.userId]);
    }
    return (await records(work)).find((record) => record.id === id)!;
  });
  c.header('Cache-Control', 'no-store');
  return c.json(walletRecordSchema.parse(result), 202);
}
