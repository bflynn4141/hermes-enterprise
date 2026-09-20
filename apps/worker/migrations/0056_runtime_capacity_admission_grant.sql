-- Runtime admission resolves an agent's ready binding under the `agent` role.
-- It needs only enough capacity state to reject an assigned profile that has
-- been quarantined. Keep pool inventory, credentials and every mutation
-- app-owned; forced tenant RLS still limits these three columns to the current
-- workspace.

GRANT SELECT (workspace_id, assigned_agent_id, state)
  ON hermes_cloud_capacity TO agent;
