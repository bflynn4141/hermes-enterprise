// /w/:ws/roles — the workspace's roles and who holds them (decision C92).
//
// Admin only, like reviewer roles on the member list: who holds Finance is who
// may decide partner invoices and confirm payments. Every write needs a recent
// sign-in, the bar `PATCH /members/:id` already sets for changing a role, and
// nobody changes their own roles, for the same reason that route gives.
import type { Context } from 'hono';
import {
  workspaceRoleCreateSchema,
  workspaceRoleListSchema,
  workspaceRoleMembersSchema,
  workspaceRolePatchSchema,
  workspaceRoleSchema,
} from '@hermes/shared';
import type { Env } from '../env.js';
import { requireCsrf, requireOrigin, requireStepUp } from '../auth.js';
import { listRoles, loadRole, setRoleHolders, slugForRoleName } from '../domain/roles.js';
import { publishEvents } from '../jobs.js';
import { RouteError } from './errors.js';
import { inWorkspace, jsonBody, pathUuid, type TenantWork } from './tenant.js';

function parse<T>(schema: { safeParse: (value: unknown) => { success: true; data: T } | { success: false } }, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw new RouteError('that is not a valid role change', 'bad_role', 422);
  return parsed.data;
}

async function requireRole(work: TenantWork, roleId: string) {
  const role = await loadRole(work.tx, work.workspaceId, roleId);
  if (!role) throw new RouteError('no such role', 'unknown_role', 404);
  return role;
}

/** Two roles called "Access reviewer" would be told apart only by a hidden slug. */
async function refuseDuplicateName(work: TenantWork, name: string, exceptId?: string): Promise<void> {
  const { rows } = await work.tx.query(
    `SELECT 1 FROM workspace_roles WHERE workspace_id = $1 AND lower(name) = lower($2) AND id IS DISTINCT FROM $3::uuid`,
    [work.workspaceId, name, exceptId ?? null],
  );
  if (rows.length > 0) throw new RouteError('a role with that name already exists', 'role_exists', 409);
}

async function audit(work: TenantWork): Promise<void> {
  await work.tx.query(
    `INSERT INTO events (workspace_id, actor_type, actor_user_id, kind) VALUES ($1, 'user', $2, 'settings.changed')`,
    [work.workspaceId, work.userId],
  );
  work.jobs.push(...(await publishEvents(work.tx, work.workspaceId, [
    { kind: 'entity.updated', payload: { entity: 'workspace_roles', id: work.workspaceId, reason: 'roles_changed' } },
  ])));
}

export async function listWorkspaceRoles(c: Context<{ Bindings: Env }>): Promise<Response> {
  const body = await inWorkspace(c, async (work) => {
    work.requireAdmin('viewing roles');
    return { items: await listRoles(work.tx, work.workspaceId) };
  });
  c.header('Cache-Control', 'no-store');
  return c.json(workspaceRoleListSchema.parse(body));
}

export async function createWorkspaceRole(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: false });
  requireCsrf(c);
  const input = parse(workspaceRoleCreateSchema, await jsonBody<unknown>(c));
  const role = await inWorkspace(c, async (work) => {
    work.requireAdmin('adding a role');
    requireStepUp(work.session);
    const slug = slugForRoleName(input.name);
    if (!slug) throw new RouteError('a role name needs a letter to start with', 'bad_role_name', 422);
    await refuseDuplicateName(work, input.name);
    const inserted = await work.tx.query<{ id: string }>(
      `INSERT INTO workspace_roles (workspace_id, slug, name, description)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (workspace_id, slug) DO NOTHING
       RETURNING id`,
      [work.workspaceId, slug, input.name, input.description],
    );
    const id = inserted.rows[0]?.id;
    if (!id) throw new RouteError('a role with that name already exists', 'role_exists', 409);
    await audit(work);
    return requireRole(work, id);
  });
  c.header('Cache-Control', 'no-store');
  return c.json(workspaceRoleSchema.parse(role), 201);
}

export async function patchWorkspaceRole(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: false });
  requireCsrf(c);
  const roleId = pathUuid(c, 'id');
  const input = parse(workspaceRolePatchSchema, await jsonBody<unknown>(c));
  const role = await inWorkspace(c, async (work) => {
    work.requireAdmin('changing a role');
    requireStepUp(work.session);
    const current = await requireRole(work, roleId);
    // A built-in role's name is how the handoff lanes and effects describe it;
    // renaming one waits until lanes are general (piece 5).
    if (current.builtin && input.name !== undefined && input.name !== current.name) {
      throw new RouteError('built-in roles keep their name', 'builtin_role_name', 422);
    }
    if (input.name !== undefined) await refuseDuplicateName(work, input.name, roleId);
    await work.tx.query(
      `UPDATE workspace_roles SET name = COALESCE($3, name), description = COALESCE($4, description)
        WHERE workspace_id = $1 AND id = $2`,
      [work.workspaceId, roleId, input.name ?? null, input.description ?? null],
    );
    await audit(work);
    return requireRole(work, roleId);
  });
  c.header('Cache-Control', 'no-store');
  return c.json(workspaceRoleSchema.parse(role));
}

export async function putWorkspaceRoleMembers(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: false });
  requireCsrf(c);
  const roleId = pathUuid(c, 'id');
  const input = parse(workspaceRoleMembersSchema, await jsonBody<unknown>(c));
  const role = await inWorkspace(c, async (work) => {
    work.requireAdmin('changing who holds a role');
    requireStepUp(work.session);
    const current = await requireRole(work, roleId);
    const active = await work.tx.query<{ user_id: string }>(
      `SELECT user_id FROM members WHERE workspace_id = $1 AND status = 'active' AND user_id = ANY ($2::uuid[])`,
      [work.workspaceId, [...new Set(input.user_ids)]],
    );
    if (active.rows.length !== new Set(input.user_ids).size) {
      throw new RouteError('only active members can hold a role', 'unknown_member', 422);
    }
    const { added, removed } = await setRoleHolders(work.tx, work.workspaceId, current.slug, input.user_ids);
    if (added.includes(work.userId) || removed.includes(work.userId)) {
      throw new RouteError('another Admin changes your own roles', 'self_change', 409);
    }
    const changed = [...added, ...removed];
    if (changed.length > 0) {
      await work.tx.query(
        `INSERT INTO events (workspace_id, actor_type, actor_user_id, kind, member_id)
         SELECT $1, 'user', $2, 'member.role_changed', m.id
           FROM members m WHERE m.workspace_id = $1 AND m.user_id = ANY ($3::uuid[])`,
        [work.workspaceId, work.userId, changed],
      );
      await audit(work);
    }
    return requireRole(work, roleId);
  });
  c.header('Cache-Control', 'no-store');
  return c.json(workspaceRoleSchema.parse(role));
}

export async function deleteWorkspaceRole(c: Context<{ Bindings: Env }>): Promise<Response> {
  requireOrigin(c, { required: false });
  requireCsrf(c);
  const roleId = pathUuid(c, 'id');
  await inWorkspace(c, async (work) => {
    work.requireAdmin('removing a role');
    requireStepUp(work.session);
    const current = await requireRole(work, roleId);
    if (current.builtin) throw new RouteError('built-in roles cannot be removed', 'builtin_role', 422);
    if (current.members.length > 0) throw new RouteError('someone still holds this role', 'role_in_use', 409);
    const routed = await work.tx.query<{ route_key: string }>(
      `SELECT route_key FROM approval_route_rules WHERE workspace_id = $1 AND $2 = ANY (roles)`,
      [work.workspaceId, current.slug],
    );
    if (routed.rows.length > 0) {
      throw new RouteError('approvals still go to this role; change them in Approvals first', 'role_routed', 409);
    }
    // A pending invitation's copy of the slug goes with the role.
    await work.tx.query(
      `UPDATE invitations SET role_slugs = array_remove(role_slugs, $2)
        WHERE workspace_id = $1 AND status = 'pending' AND $2 = ANY (role_slugs)`,
      [work.workspaceId, current.slug],
    );
    // Removed members keep their old row; their copy of the slug goes with the role.
    await work.tx.query(
      `UPDATE members SET reviewer_roles = array_remove(reviewer_roles, $2)
        WHERE workspace_id = $1 AND status <> 'active' AND $2 = ANY (reviewer_roles)`,
      [work.workspaceId, current.slug],
    );
    await work.tx.query(`DELETE FROM workspace_roles WHERE workspace_id = $1 AND id = $2`, [work.workspaceId, roleId]);
    await audit(work);
  });
  c.header('Cache-Control', 'no-store');
  return c.body(null, 204);
}
