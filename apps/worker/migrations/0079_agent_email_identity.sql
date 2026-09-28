-- 0079: every agent has its own email address (decision C100).
--
-- Until now an Admin gave a role an address and chose the agent that reads it
-- (C98). Now each agent gets one address of its own, created with the agent,
-- and approved replies go out from it (Cloudflare Email Service). Admins
-- configure roles; an agent's role decides who reviews its mail.
--
--   email_inboxes.kind    'agent' is an agent's own address, one per agent;
--                         'role' is an address an Admin created under C98,
--                         kept working as it was.
--   email_inboxes.role_slug  for an agent's address, follows the agent's
--                         team (enterprise_team_agents) through a trigger, so
--                         moving an agent to Finance moves who reviews its
--                         mail. Null while the agent has no role: then only
--                         its owner reviews.
--   outbound_email_outbox.sender_inbox_id  an approved reply sent as the
--                         agent's own address rather than a connected mailbox.
--
-- Existing addresses: the oldest address per agent becomes that agent's own,
-- so nothing anyone forwards to stops working.

ALTER TABLE email_inboxes ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'role';
ALTER TABLE email_inboxes DROP CONSTRAINT IF EXISTS email_inboxes_kind_check;
ALTER TABLE email_inboxes ADD CONSTRAINT email_inboxes_kind_check CHECK (kind IN ('role', 'agent'));
ALTER TABLE email_inboxes ALTER COLUMN role_slug DROP NOT NULL;
ALTER TABLE email_inboxes DROP CONSTRAINT IF EXISTS email_inboxes_role_required;
ALTER TABLE email_inboxes ADD CONSTRAINT email_inboxes_role_required CHECK (kind = 'agent' OR role_slug IS NOT NULL);

-- The role an agent works in: its team's slug, when a workspace role of that slug exists.
CREATE OR REPLACE FUNCTION agent_team_role_slug(target_workspace_id uuid, target_agent_id uuid) RETURNS text
LANGUAGE sql STABLE AS $fn$
  SELECT t.slug
    FROM enterprise_team_agents ta
    JOIN enterprise_teams t ON t.workspace_id = ta.workspace_id AND t.id = ta.team_id
    JOIN workspace_roles r ON r.workspace_id = t.workspace_id AND r.slug = t.slug
   WHERE ta.workspace_id = target_workspace_id AND ta.agent_id = target_agent_id
   LIMIT 1
$fn$;
GRANT EXECUTE ON FUNCTION agent_team_role_slug(uuid, uuid) TO app;

CREATE OR REPLACE FUNCTION agent_inbox_role_follow() RETURNS trigger
LANGUAGE plpgsql AS $fn$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    UPDATE email_inboxes SET role_slug = agent_team_role_slug(OLD.workspace_id, OLD.agent_id)
     WHERE workspace_id = OLD.workspace_id AND agent_id = OLD.agent_id AND kind = 'agent';
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    UPDATE email_inboxes SET role_slug = agent_team_role_slug(NEW.workspace_id, NEW.agent_id)
     WHERE workspace_id = NEW.workspace_id AND agent_id = NEW.agent_id AND kind = 'agent';
  END IF;
  RETURN NULL;
END
$fn$;
DROP TRIGGER IF EXISTS enterprise_team_agents_inbox_role ON enterprise_team_agents;
CREATE TRIGGER enterprise_team_agents_inbox_role AFTER INSERT OR UPDATE OR DELETE ON enterprise_team_agents
  FOR EACH ROW EXECUTE FUNCTION agent_inbox_role_follow();

-- Backfill across workspaces: RLS is forced for the owner too (0072 pattern).
ALTER TABLE email_inboxes NO FORCE ROW LEVEL SECURITY;
ALTER TABLE enterprise_team_agents NO FORCE ROW LEVEL SECURITY;
ALTER TABLE enterprise_teams NO FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_roles NO FORCE ROW LEVEL SECURITY;
UPDATE email_inboxes SET kind = 'agent'
 WHERE id IN (SELECT DISTINCT ON (workspace_id, agent_id) id FROM email_inboxes
               ORDER BY workspace_id, agent_id, created_at, id);
-- An agent with a role reviews by that role; one without keeps the role its
-- address was created for, so nobody loses sight of mail they reviewed.
UPDATE email_inboxes SET role_slug = COALESCE(agent_team_role_slug(workspace_id, agent_id), role_slug)
 WHERE kind = 'agent';
ALTER TABLE workspace_roles FORCE ROW LEVEL SECURITY;
ALTER TABLE enterprise_teams FORCE ROW LEVEL SECURITY;
ALTER TABLE enterprise_team_agents FORCE ROW LEVEL SECURITY;
ALTER TABLE email_inboxes FORCE ROW LEVEL SECURITY;

CREATE UNIQUE INDEX IF NOT EXISTS email_inboxes_one_per_agent
  ON email_inboxes (workspace_id, agent_id) WHERE kind = 'agent';

ALTER TABLE outbound_email_outbox
  ADD COLUMN IF NOT EXISTS sender_inbox_id uuid REFERENCES email_inboxes (id) ON DELETE SET NULL;
