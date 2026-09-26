-- 0072: workspace roles as data (roles-and-agents plan, piece 2; decision C92).
--
-- A role is a named responsibility in one workspace: Partnerships, Finance,
-- Access reviewer, or one an Admin adds. Holding a role is what a reviewer tag
-- used to be, so membership stays where the tags were: role slugs in
-- `members.reviewer_roles`. Every existing check (effects, the Finance decision
-- rule, approval policy role selectors) reads that column unchanged; what is
-- new is that each slug must name a role in this table.
--
-- `enterprise_teams` is not this table. It is the handoff lane (one person and
-- one agent per side), and several readers treat a team row's existence as
-- "the workflow is set up". Lanes now reference their role by slug; making
-- lanes general is piece 5.

CREATE TABLE IF NOT EXISTS workspace_roles (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  slug               text NOT NULL CHECK (slug ~ '^[a-z][a-z0-9_-]{0,47}$'),
  name               text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 80),
  description        text NOT NULL DEFAULT '' CHECK (char_length(description) <= 500),
  builtin            boolean NOT NULL DEFAULT false,
  -- The agent setup this role's agents get. The skills behind it are a vetted
  -- catalog the runtime attests, so the values live in code.
  agent_template_key text CHECK (agent_template_key IS NULL OR agent_template_key IN ('partnerships-agent', 'finance-agent')),
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT workspace_roles_workspace_slug_key UNIQUE (workspace_id, slug),
  CONSTRAINT workspace_roles_workspace_id_key UNIQUE (workspace_id, id)
);
DROP TRIGGER IF EXISTS workspace_roles_updated_at ON workspace_roles;
CREATE TRIGGER workspace_roles_updated_at BEFORE UPDATE ON workspace_roles
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE workspace_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_roles FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON workspace_roles;
CREATE POLICY tenant_isolation ON workspace_roles
  USING (workspace_id = app_workspace_id())
  WITH CHECK (workspace_id = app_workspace_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON workspace_roles TO app;
REVOKE ALL ON workspace_roles FROM agent;

-- The roles every workspace starts with. Their slugs are referenced in code
-- (EFFECT_REQUIREMENTS, domain/finance-decidable.ts, shared intelligence).
CREATE OR REPLACE FUNCTION seed_builtin_workspace_roles(target_workspace_id uuid)
  RETURNS void
  LANGUAGE sql
AS $$
  INSERT INTO workspace_roles (workspace_id, slug, name, description, builtin, agent_template_key) VALUES
    (target_workspace_id, 'partnerships', 'Partnerships',
     'Screens partner applicants, gathers evidence, and hands confirmed work to Finance.', true, 'partnerships-agent'),
    (target_workspace_id, 'finance', 'Finance',
     'Reviews invoices and agreements handed over from Partnerships, and confirms payments.', true, 'finance-agent'),
    (target_workspace_id, 'access', 'Access reviewer',
     'Confirms access grants for admitted partners.', true, NULL),
    (target_workspace_id, 'legal', 'Legal',
     'Reviews agreements before they are signed.', true, NULL),
    (target_workspace_id, 'shared_intelligence_reviewer', 'Shared Intelligence reviewer',
     'Approves what agents may publish to Shared Intelligence.', true, NULL)
  ON CONFLICT (workspace_id, slug) DO NOTHING;
$$;

-- Workspace creation sets the new workspace as the tenant before inserting it
-- (routes/workspaces.ts), so the seed passes row-level security as `app`.
CREATE OR REPLACE FUNCTION seed_workspace_roles_on_create()
  RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM seed_builtin_workspace_roles(NEW.id);
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS workspaces_seed_roles ON workspaces;
CREATE TRIGGER workspaces_seed_roles AFTER INSERT ON workspaces
  FOR EACH ROW EXECUTE FUNCTION seed_workspace_roles_on_create();

-- Existing workspaces. All three roles are NOBYPASSRLS, so the backfill lifts
-- FORCE for its own statements and restores it, as 0055 did.
ALTER TABLE workspaces NO FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_roles NO FORCE ROW LEVEL SECURITY;
ALTER TABLE members NO FORCE ROW LEVEL SECURITY;
ALTER TABLE enterprise_teams NO FORCE ROW LEVEL SECURITY;
ALTER TABLE enterprise_team_agents NO FORCE ROW LEVEL SECURITY;
DO $backfill$
DECLARE ws record;
BEGIN
  FOR ws IN SELECT id FROM workspaces LOOP
    PERFORM seed_builtin_workspace_roles(ws.id);
  END LOOP;

  -- Tags were free text. Lowercase them, and keep each distinct valid one as
  -- a custom role so nobody silently loses what they held.
  UPDATE members
     SET reviewer_roles = ARRAY(SELECT DISTINCT lower(tag) FROM unnest(reviewer_roles) tag
                                 WHERE lower(tag) ~ '^[a-z][a-z0-9_-]{0,47}$')
   WHERE reviewer_roles IS DISTINCT FROM
         ARRAY(SELECT DISTINCT lower(tag) FROM unnest(reviewer_roles) tag
                WHERE lower(tag) ~ '^[a-z][a-z0-9_-]{0,47}$');
  INSERT INTO workspace_roles (workspace_id, slug, name)
  SELECT DISTINCT m.workspace_id, tag, left(initcap(replace(replace(tag, '_', ' '), '-', ' ')), 80)
    FROM members m, unnest(m.reviewer_roles) tag
  ON CONFLICT (workspace_id, slug) DO NOTHING;

  -- A person bound to a lane holds that lane's role. Finance principals already
  -- carried the tag; Partnerships principals did not.
  UPDATE members m
     SET reviewer_roles = m.reviewer_roles || t.slug
    FROM enterprise_team_agents eta
    JOIN enterprise_teams t ON t.workspace_id = eta.workspace_id AND t.id = eta.team_id
   WHERE m.workspace_id = eta.workspace_id AND m.user_id = eta.principal_user_id
     AND NOT (t.slug = ANY (m.reviewer_roles));
END
$backfill$;
ALTER TABLE enterprise_team_agents FORCE ROW LEVEL SECURITY;
ALTER TABLE enterprise_teams FORCE ROW LEVEL SECURITY;
ALTER TABLE members FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_roles FORCE ROW LEVEL SECURITY;
ALTER TABLE workspaces FORCE ROW LEVEL SECURITY;

-- A lane is a role's lane. NO ACTION rather than RESTRICT: it is checked at
-- the end of the statement, so deleting a whole workspace, which cascades to
-- both tables in no particular order, is not refused halfway.
DO $$ BEGIN
  ALTER TABLE enterprise_teams ADD CONSTRAINT enterprise_teams_role_fk
    FOREIGN KEY (workspace_id, slug) REFERENCES workspace_roles (workspace_id, slug);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Nobody holds a role that does not exist.
CREATE OR REPLACE FUNCTION members_roles_exist()
  RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE missing text;
BEGIN
  SELECT tag INTO missing
    FROM unnest(COALESCE(NEW.reviewer_roles, '{}'::text[])) tag
   WHERE NOT EXISTS (SELECT 1 FROM workspace_roles r WHERE r.workspace_id = NEW.workspace_id AND r.slug = tag)
   LIMIT 1;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'no role % in this workspace', missing USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS members_roles_exist ON members;
CREATE TRIGGER members_roles_exist BEFORE INSERT OR UPDATE OF reviewer_roles ON members
  FOR EACH ROW EXECUTE FUNCTION members_roles_exist();

-- ...and no role is deleted while somebody holds it.
CREATE OR REPLACE FUNCTION workspace_roles_unheld_on_delete()
  RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  -- A workspace being deleted takes its roles and members with it.
  IF NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.id = OLD.workspace_id) THEN
    RETURN OLD;
  END IF;
  IF EXISTS (SELECT 1 FROM members m WHERE m.workspace_id = OLD.workspace_id AND OLD.slug = ANY (m.reviewer_roles)) THEN
    RAISE EXCEPTION 'role % is still held', OLD.slug USING ERRCODE = '23503';
  END IF;
  RETURN OLD;
END
$$;
DROP TRIGGER IF EXISTS workspace_roles_unheld_on_delete ON workspace_roles;
CREATE TRIGGER workspace_roles_unheld_on_delete BEFORE DELETE ON workspace_roles
  FOR EACH ROW EXECUTE FUNCTION workspace_roles_unheld_on_delete();
