// Admin-authored financial proposals. Append-only revisions and audit commit
// together; no provider operation, owner authorization, or payment is implied.
import type { Context } from 'hono';
import {
  ROLE_SPENDING_FREE_TIER, roleSpendingDraftInputSchema, roleSpendingDraftSchema,
  type RoleSpendingPolicy,
} from '@hermes/shared';
import type { Env } from '../env.js';
import { requireCsrf, requireOrigin, requireStepUp } from '../auth.js';
import { publishEvents } from '../jobs.js';
import { planRoleSpendingPolicies } from '../wallets/role-spending.js';
import { inWorkspace, jsonBody, pathUuid, RouteError, type TenantWork } from './tenant.js';

interface SavedDraft {
  revision: number;
  policy: RoleSpendingPolicy;
  created_at: Date | string;
  requested_by: string;
}
async function requireRole(work: TenantWork, roleId: string, lock = false): Promise<string> {
  const { rows } = await work.tx.query<{ name: string }>(
    `SELECT name FROM workspace_roles WHERE workspace_id = $1 AND id = $2${lock ? ' FOR UPDATE' : ''}`,
    [work.workspaceId, roleId]);
  if (!rows[0]) throw new RouteError('no such role', 'unknown_role', 404);
  return rows[0].name;
}
async function latest(work: TenantWork, roleId: string): Promise<SavedDraft | undefined> {
  const { rows } = await work.tx.query<SavedDraft>(
    `SELECT revision, policy, created_at, requested_by FROM role_spending_drafts
      WHERE workspace_id = $1 AND role_id = $2 ORDER BY revision DESC LIMIT 1`,
    [work.workspaceId, roleId]);
  return rows[0];
}
function response(roleId: string, saved: SavedDraft | undefined) {
  const plan = planRoleSpendingPolicies({
    drafts: saved ? [{ role_id: roleId, policy: saved.policy }] : [],
    existing_policy_count: null, provider_state_verified: false, abi_verified: false,
    signature_usage_verified: false, bindings: [],
  });
  return roleSpendingDraftSchema.parse({
    role_id: roleId, revision: saved?.revision ?? 0, policy: saved?.policy ?? null,
    state: 'draft_only', enforcement: 'none', provider_activation_available: false,
    updated_at: saved ? new Date(saved.created_at).toISOString() : null,
    updated_by: saved?.requested_by ?? null, free_tier: ROLE_SPENDING_FREE_TIER,
    activation_blockers: plan.activation_blockers,
  });
}
export async function getRoleSpendingDraft(c: Context<{ Bindings: Env }>): Promise<Response> {
  const roleId = pathUuid(c, 'id');
  const result = await inWorkspace(c, async (work) => {
    work.requireAdmin('viewing spending policy drafts');
    await requireRole(work, roleId);
    return response(roleId, await latest(work, roleId));
  });
  c.header('Cache-Control', 'no-store');
  return c.json(result);
}
export async function putRoleSpendingDraft(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: false });
  requireCsrf(c);
  const roleId = pathUuid(c, 'id');
  const parsed = roleSpendingDraftInputSchema.safeParse(await jsonBody<unknown>(c));
  if (!parsed.success) throw new RouteError('choose a valid Base USDC spending policy draft', 'bad_spending_policy', 422);
  const result = await inWorkspace(c, async (work) => {
    work.requireAdmin('saving spending policy drafts');
    requireStepUp(work.session);
    // Serializes even the first revision and prevents deletion during the save.
    const roleName = await requireRole(work, roleId, true);
    const current = await latest(work, roleId);
    if ((current?.revision ?? 0) !== parsed.data.expected_revision) {
      throw new RouteError('this spending draft changed; reload before saving', 'revision_conflict', 409);
    }
    const { rows } = await work.tx.query<SavedDraft>(
      `INSERT INTO role_spending_drafts(workspace_id, role_id, role_name, revision, policy, requested_by)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6) RETURNING revision, policy, created_at, requested_by`,
      [work.workspaceId, roleId, roleName, parsed.data.expected_revision + 1, JSON.stringify(parsed.data.policy), work.userId]);
    await work.tx.query(
      `INSERT INTO events(workspace_id, actor_type, actor_user_id, kind) VALUES ($1, 'user', $2, 'settings.changed')`,
      [work.workspaceId, work.userId]);
    work.jobs.push(...await publishEvents(work.tx, work.workspaceId, [
      { kind: 'entity.updated', payload: { entity: 'workspace_roles', id: roleId, reason: 'spending_policy_draft_changed' } },
    ]));
    return response(roleId, rows[0]);
  });
  c.header('Cache-Control', 'no-store');
  return c.json(result);
}
