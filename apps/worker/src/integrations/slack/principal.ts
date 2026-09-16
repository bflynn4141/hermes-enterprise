import type { Tx } from '../../db/client.js';

export interface SlackAgentBinding {
  readonly user_id: string;
  readonly agent_id: string;
  readonly agent_name: string;
}

/**
 * Resolve the member's established agent without depending on onboarding's
 * optional ownership backfill. Explicit ownership wins; main's private setup
 * session is the compatibility binding for workspaces created before it.
 */
export async function resolveSlackAgent(
  tx: Tx,
  workspaceId: string,
  userId: string,
): Promise<SlackAgentBinding | null> {
  const { rows } = await tx.query<SlackAgentBinding>(
    `SELECT m.user_id, candidate.id AS agent_id, candidate.name AS agent_name
       FROM members m
       JOIN LATERAL (
         SELECT ranked.id, ranked.name
           FROM (
             SELECT a.id, a.name, 0 AS priority, a.created_at
              FROM agent_owners ao
               JOIN agents a ON a.workspace_id=ao.workspace_id AND a.id=ao.agent_id
              WHERE ao.workspace_id=m.workspace_id AND ao.member_id=m.id AND a.status='started'
             UNION ALL
             SELECT a.id, a.name, 1 AS priority, a.created_at
               FROM sessions s
               JOIN agents a ON a.workspace_id=s.workspace_id AND a.id=s.agent_id
              WHERE s.workspace_id=m.workspace_id AND s.owner_id=m.user_id AND a.status='started'
           ) ranked
          ORDER BY ranked.priority, ranked.created_at
          LIMIT 1
       ) candidate ON true
      WHERE m.workspace_id=$1 AND m.user_id=$2 AND m.status='active'`,
    [workspaceId, userId],
  );
  return rows[0] ?? null;
}

export async function resolveLinkedSlackPrincipal(
  tx: Tx,
  workspaceId: string,
  installationId: string,
  slackUserId: string,
): Promise<SlackAgentBinding | null> {
  const { rows } = await tx.query<{ user_id: string }>(
    `SELECT l.user_id
       FROM slack_user_links l
       JOIN members m ON m.workspace_id=l.workspace_id AND m.user_id=l.user_id AND m.status='active'
      WHERE l.workspace_id=$1 AND l.installation_id=$2 AND l.slack_user_id=$3
        AND l.revoked_at IS NULL`,
    [workspaceId, installationId, slackUserId],
  );
  const linked = rows[0];
  return linked ? resolveSlackAgent(tx, workspaceId, linked.user_id) : null;
}
