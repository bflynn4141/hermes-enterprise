-- Legacy Partner Program agents can already have an ownership row whose
-- member is now inactive or is no longer an admin. The proactive scheduler
-- deliberately admits only active admin-owned agents, so repair those rows to
-- the best active admin in the workspace. Prefer the workspace creator, then
-- an admin who already owns a writable session for the agent, then the oldest
-- active admin membership.

WITH replacements AS (
  SELECT a.workspace_id,
         a.id AS agent_id,
         (
           SELECT m.id
             FROM members m
             JOIN workspaces w ON w.id = a.workspace_id
            WHERE m.workspace_id = a.workspace_id
              AND m.status = 'active'
              AND m.role = 'admin'
            ORDER BY (m.user_id = w.created_by) DESC,
                     EXISTS (
                       SELECT 1
                         FROM sessions s
                        WHERE s.workspace_id = a.workspace_id
                          AND s.agent_id = a.id
                          AND s.owner_id = m.user_id
                          AND NOT s.archived
                          AND NOT s.read_only
                     ) DESC,
                     m.joined_at,
                     m.id
            LIMIT 1
         ) AS member_id
    FROM agents a
   WHERE lower(trim(COALESCE(a.responsibility, ''))) = 'partner program'
)
INSERT INTO agent_owners AS existing (workspace_id, agent_id, member_id)
SELECT workspace_id, agent_id, member_id
  FROM replacements
 WHERE member_id IS NOT NULL
ON CONFLICT (agent_id) DO UPDATE
SET workspace_id = EXCLUDED.workspace_id,
    member_id = EXCLUDED.member_id
WHERE NOT EXISTS (
  SELECT 1
    FROM members current_owner
   WHERE current_owner.workspace_id = existing.workspace_id
     AND current_owner.id = existing.member_id
     AND current_owner.status = 'active'
     AND current_owner.role = 'admin'
);
