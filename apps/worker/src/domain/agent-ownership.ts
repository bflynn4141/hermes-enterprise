import type { Tx } from '../db/client.js';

/**
 * Verify the current member owns an agent, repairing only the legacy shape
 * where one active member already owns the agent's sole writable session.
 */
export async function ensureAgentOwner(
  tx: Tx,
  workspaceId: string,
  userId: string,
  agentId: string,
): Promise<boolean> {
  await tx.query(
    `INSERT INTO agent_owners (workspace_id, agent_id, member_id)
     SELECT $1, $2, m.id
       FROM members m
      WHERE m.workspace_id = $1 AND m.user_id = $3 AND m.status = 'active'
        AND EXISTS (
          SELECT 1 FROM sessions s
           WHERE s.workspace_id = $1 AND s.agent_id = $2 AND s.owner_id = $3
             AND NOT s.archived AND NOT s.read_only
        )
        AND NOT EXISTS (
          SELECT 1
            FROM sessions s
            JOIN members other
              ON other.workspace_id = s.workspace_id AND other.user_id = s.owner_id
           WHERE s.workspace_id = $1 AND s.agent_id = $2
             AND NOT s.archived AND NOT s.read_only AND other.status = 'active'
             AND other.user_id <> $3
        )
     ON CONFLICT (agent_id) DO NOTHING`,
    [workspaceId, agentId, userId],
  );
  const owned = await tx.query(
    `SELECT 1
       FROM agent_owners ao
       JOIN members m ON m.workspace_id = ao.workspace_id AND m.id = ao.member_id
      WHERE ao.workspace_id = $1 AND ao.agent_id = $2
        AND m.user_id = $3 AND m.status = 'active'`,
    [workspaceId, agentId, userId],
  );
  return owned.rowCount === 1;
}
