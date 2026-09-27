import { type TenantWork } from '../routes/tenant.js';
import { RouteError } from '../routes/errors.js';

/** Content access is not administrative configuration authority. A governed
 * agent is private to its active owner/principal; only explicitly workspace
 * scoped agents are shared. Missing/revoked bindings never imply sharing. No GET repairs
 * ownership or creates a grant. Both bindings must agree when both exist. */
export async function requireAgentContextAccess(work: TenantWork, agentId: string): Promise<void> {
  if (!(await hasAgentContextAccess(work, agentId))) throw new RouteError('No accessible agent context', 'not_found', 404);
}

/**
 * The rule as SQL over `agents a`, with the workspace in `$1` and the viewer
 * in `$2`. One copy, so the single check and the set query cannot drift.
 */
const CONTEXT_ACCESS_PREDICATE = `
        EXISTS (SELECT 1 FROM members m WHERE m.workspace_id=$1 AND m.user_id=$2 AND m.status='active')
        AND (a.context_scope='workspace'
          OR EXISTS (SELECT 1 FROM agent_owners ao WHERE ao.workspace_id=a.workspace_id AND ao.agent_id=a.id)
          OR EXISTS (SELECT 1 FROM enterprise_team_agents ta WHERE ta.workspace_id=a.workspace_id AND ta.agent_id=a.id))
        AND NOT EXISTS (
          SELECT 1 FROM agent_owners ao JOIN members m ON m.workspace_id=ao.workspace_id AND m.id=ao.member_id
           WHERE ao.workspace_id=a.workspace_id AND ao.agent_id=a.id
             AND (m.user_id<>$2 OR m.status<>'active'))
        AND NOT EXISTS (
          SELECT 1 FROM enterprise_team_agents ta
           WHERE ta.workspace_id=a.workspace_id AND ta.agent_id=a.id AND ta.principal_user_id<>$2)`;

/** The same rule as `requireAgentContextAccess`, as an answer instead of a refusal. */
export async function hasAgentContextAccess(work: TenantWork, agentId: string): Promise<boolean> {
  const result = await work.tx.query(
    `SELECT a.id FROM agents a
      WHERE a.workspace_id=$1 AND a.id=$3 AND ${CONTEXT_ACCESS_PREDICATE}`,
    [work.workspaceId, work.userId, agentId],
  );
  return result.rows.length > 0;
}

/**
 * Every agent in the workspace whose own work this viewer may read, in one
 * query. The Admin directory uses it instead of asking once per agent.
 */
export async function agentsWithContextAccess(work: TenantWork): Promise<Set<string>> {
  const result = await work.tx.query<{ id: string }>(
    `SELECT a.id FROM agents a WHERE a.workspace_id=$1 AND ${CONTEXT_ACCESS_PREDICATE}`,
    [work.workspaceId, work.userId],
  );
  return new Set(result.rows.map((row) => row.id));
}
