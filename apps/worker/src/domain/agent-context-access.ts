import { type TenantWork } from '../routes/tenant.js';
import { RouteError } from '../routes/errors.js';

/** Content access is not administrative configuration authority. A governed
 * agent is private to its active owner/principal; only explicitly workspace
 * scoped agents are shared. Missing/revoked bindings never imply sharing. No GET repairs
 * ownership or creates a grant. Both bindings must agree when both exist. */
export async function requireAgentContextAccess(work: TenantWork, agentId: string): Promise<void> {
  const result = await work.tx.query(
    `SELECT a.id FROM agents a
      WHERE a.workspace_id=$1 AND a.id=$2
        AND EXISTS (SELECT 1 FROM members m WHERE m.workspace_id=$1 AND m.user_id=$3 AND m.status='active')
        AND (a.context_scope='workspace'
          OR EXISTS (SELECT 1 FROM agent_owners ao WHERE ao.workspace_id=a.workspace_id AND ao.agent_id=a.id)
          OR EXISTS (SELECT 1 FROM enterprise_team_agents ta WHERE ta.workspace_id=a.workspace_id AND ta.agent_id=a.id))
        AND NOT EXISTS (
          SELECT 1 FROM agent_owners ao JOIN members m ON m.workspace_id=ao.workspace_id AND m.id=ao.member_id
           WHERE ao.workspace_id=a.workspace_id AND ao.agent_id=a.id
             AND (m.user_id<>$3 OR m.status<>'active'))
        AND NOT EXISTS (
          SELECT 1 FROM enterprise_team_agents ta
           WHERE ta.workspace_id=a.workspace_id AND ta.agent_id=a.id AND ta.principal_user_id<>$3)`,
    [work.workspaceId, agentId, work.userId],
  );
  if (!result.rows[0]) throw new RouteError('No accessible agent context', 'not_found', 404);
}
