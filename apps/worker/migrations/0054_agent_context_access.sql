-- Absence of ownership is not evidence of a public resource. Existing and new
-- agents fail closed unless they have a live binding or explicit shared scope.
ALTER TABLE agents ADD COLUMN IF NOT EXISTS context_scope text NOT NULL DEFAULT 'private'
  CHECK (context_scope IN ('private','workspace'));

CREATE OR REPLACE FUNCTION make_bound_agent_context_private() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  UPDATE agents SET context_scope='private' WHERE workspace_id=NEW.workspace_id AND id=NEW.agent_id;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS agent_owner_private_context ON agent_owners;
CREATE TRIGGER agent_owner_private_context AFTER INSERT OR UPDATE ON agent_owners
FOR EACH ROW EXECUTE FUNCTION make_bound_agent_context_private();
DROP TRIGGER IF EXISTS team_agent_private_context ON enterprise_team_agents;
CREATE TRIGGER team_agent_private_context AFTER INSERT OR UPDATE ON enterprise_team_agents
FOR EACH ROW EXECUTE FUNCTION make_bound_agent_context_private();
