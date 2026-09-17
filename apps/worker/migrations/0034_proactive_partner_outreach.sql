-- Give pre-approval-expansion agents the deterministic owner that newer
-- creation paths already write. Proactive work is admitted only for an active
-- admin owner, so a legacy Iris without this row otherwise stays invisible to
-- the scheduler forever.

INSERT INTO agent_owners (workspace_id, agent_id, member_id)
SELECT a.workspace_id, a.id, m.id
  FROM agents a
  JOIN workspaces w ON w.id = a.workspace_id
  JOIN members m
    ON m.workspace_id = a.workspace_id
   AND m.user_id = w.created_by
   AND m.role = 'admin'
   AND m.status = 'active'
  LEFT JOIN agent_owners ao ON ao.agent_id = a.id
 WHERE ao.agent_id IS NULL
ON CONFLICT (agent_id) DO NOTHING;
