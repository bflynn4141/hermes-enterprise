// Workspace roles (migration 0072, decision C92).
//
// A role is a named responsibility; holding one is its slug in
// `members.reviewer_roles`, which every existing authority check already
// reads. This module is the one place that reads the catalog and changes who
// holds what, so the member trigger and these functions agree.
import { MAX_ROLES_PER_MEMBER, type WorkspaceRole } from '@hermes/shared';
import type { Tx } from '../db/client.js';
import { RouteError } from '../routes/errors.js';

interface RoleRow {
  id: string;
  slug: string;
  name: string;
  description: string;
  builtin: boolean;
  agent_template_key: 'partnerships-agent' | 'finance-agent' | null;
}

interface HolderRow {
  slug: string;
  user_id: string;
  name: string;
}

interface LaneAgentRow {
  slug: string;
  agent_id: string;
  agent_name: string;
  user_id: string;
  principal_name: string;
}

const ROLE_COLUMNS = `r.id, r.slug, r.name, r.description, r.builtin, r.agent_template_key`;

/** Every role with its holders and lane agents, built-ins first. */
export async function listRoles(tx: Tx, workspaceId: string, roleId?: string): Promise<WorkspaceRole[]> {
  const roles = await tx.query<RoleRow>(
    `SELECT ${ROLE_COLUMNS} FROM workspace_roles r
      WHERE r.workspace_id = $1${roleId ? ' AND r.id = $2' : ''}
      ORDER BY r.builtin DESC,
               array_position(ARRAY['partnerships','finance','access','legal','shared_intelligence_reviewer'], r.slug),
               r.created_at, r.name`,
    roleId ? [workspaceId, roleId] : [workspaceId],
  );
  if (roles.rows.length === 0) return [];
  const holders = await tx.query<HolderRow>(
    `SELECT role.slug, m.user_id, COALESCE(NULLIF(u.name, ''), u.email) AS name
       FROM members m
       JOIN users u ON u.id = m.user_id
       CROSS JOIN LATERAL unnest(m.reviewer_roles) AS role(slug)
      WHERE m.workspace_id = $1 AND m.status = 'active'
      ORDER BY name`,
    [workspaceId],
  );
  const lanes = await tx.query<LaneAgentRow>(
    `SELECT t.slug, a.id AS agent_id, a.name AS agent_name, eta.principal_user_id AS user_id,
            COALESCE(NULLIF(u.name, ''), u.email) AS principal_name
       FROM enterprise_team_agents eta
       JOIN enterprise_teams t ON t.workspace_id = eta.workspace_id AND t.id = eta.team_id
       JOIN agents a ON a.workspace_id = eta.workspace_id AND a.id = eta.agent_id
       JOIN users u ON u.id = eta.principal_user_id
      WHERE eta.workspace_id = $1
      ORDER BY a.name`,
    [workspaceId],
  );
  return roles.rows.map((role) => ({
    id: role.id,
    slug: role.slug,
    name: role.name,
    description: role.description,
    builtin: role.builtin,
    agent_template: role.agent_template_key,
    members: holders.rows
      .filter((holder) => holder.slug === role.slug)
      .map((holder) => ({ user_id: holder.user_id, name: holder.name.slice(0, 200) })),
    agents: lanes.rows
      .filter((lane) => lane.slug === role.slug)
      .map((lane) => ({
        agent_id: lane.agent_id,
        name: lane.agent_name.slice(0, 200),
        principal: { user_id: lane.user_id, name: lane.principal_name.slice(0, 200) },
      })),
  }));
}

export async function loadRole(tx: Tx, workspaceId: string, roleId: string): Promise<WorkspaceRole | null> {
  return (await listRoles(tx, workspaceId, roleId))[0] ?? null;
}

/** The slugs this workspace has, for validating a member's roles. */
export async function roleSlugs(tx: Tx, workspaceId: string): Promise<Set<string>> {
  const { rows } = await tx.query<{ slug: string }>(
    `SELECT slug FROM workspace_roles WHERE workspace_id = $1`,
    [workspaceId],
  );
  return new Set(rows.map((row) => row.slug));
}

/** A role slug from its display name: "Partner Success" becomes `partner-success`. */
export function slugForRoleName(name: string): string | null {
  const slug = name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32).replace(/-+$/, '');
  return /^[a-z][a-z0-9_-]{0,31}$/.test(slug) ? slug : null;
}

/** Adds a role to one active member; holding it twice is holding it once. */
export async function grantRole(tx: Tx, workspaceId: string, userId: string, slug: string): Promise<void> {
  await tx.query(
    `UPDATE members
        SET reviewer_roles = ARRAY(SELECT DISTINCT unnest(reviewer_roles || ARRAY[$3]::text[]))
      WHERE workspace_id = $1 AND user_id = $2 AND status = 'active' AND NOT ($3 = ANY (reviewer_roles))`,
    [workspaceId, userId, slug],
  );
}

/** The built-in role whose agents use this template, e.g. `finance-agent` → `finance`. */
export async function roleSlugForTemplate(tx: Tx, workspaceId: string, templateKey: string): Promise<string | null> {
  const { rows } = await tx.query<{ slug: string }>(
    `SELECT slug FROM workspace_roles
      WHERE workspace_id = $1 AND agent_template_key = $2 AND builtin
      ORDER BY created_at LIMIT 1`,
    [workspaceId, templateKey],
  );
  return rows[0]?.slug ?? null;
}

/**
 * Makes exactly `userIds` hold the role. Returns the users whose membership
 * changed, so the caller can refuse a change that includes the viewer.
 */
export async function setRoleHolders(
  tx: Tx,
  workspaceId: string,
  slug: string,
  userIds: readonly string[],
): Promise<{ added: string[]; removed: string[] }> {
  const wanted = new Set(userIds);
  const { rows } = await tx.query<{ user_id: string; holds: boolean; held: number }>(
    `SELECT user_id, $2 = ANY (reviewer_roles) AS holds, cardinality(reviewer_roles) AS held
       FROM members WHERE workspace_id = $1 AND status = 'active'
       FOR UPDATE`,
    [workspaceId, slug],
  );
  const added = rows.filter((row) => !row.holds && wanted.has(row.user_id)).map((row) => row.user_id);
  if (rows.some((row) => !row.holds && wanted.has(row.user_id) && row.held >= MAX_ROLES_PER_MEMBER)) {
    throw new RouteError(`a person holds at most ${MAX_ROLES_PER_MEMBER} roles`, 'too_many_roles', 422);
  }
  const removed = rows.filter((row) => row.holds && !wanted.has(row.user_id)).map((row) => row.user_id);
  if (added.length > 0) {
    await tx.query(
      `UPDATE members SET reviewer_roles = reviewer_roles || ARRAY[$2]::text[]
        WHERE workspace_id = $1 AND user_id = ANY ($3::uuid[])`,
      [workspaceId, slug, added],
    );
  }
  if (removed.length > 0) {
    await tx.query(
      `UPDATE members SET reviewer_roles = array_remove(reviewer_roles, $2)
        WHERE workspace_id = $1 AND user_id = ANY ($3::uuid[])`,
      [workspaceId, slug, removed],
    );
  }
  return { added, removed };
}
