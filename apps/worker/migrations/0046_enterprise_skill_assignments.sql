-- Hermes Enterprise keeps the procedure in a normal, versioned Hermes skill.
-- This table binds that skill to one agent's reviewed, non-secret operating
-- policy. It deliberately does not duplicate SKILL.md or plugin code.

CREATE TABLE IF NOT EXISTS enterprise_skill_assignments (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  agent_id              uuid NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  skill_key             text NOT NULL CHECK (skill_key ~ '^[a-z][a-z0-9-]{1,119}$'),
  skill_version         text NOT NULL CHECK (length(skill_version) BETWEEN 1 AND 32),
  state                 text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'paused')),
  config                jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(config) = 'object'),
  capability_grants     text[] NOT NULL DEFAULT '{}',
  schedule              jsonb NOT NULL DEFAULT '{"enabled":true,"interval_minutes":360}'::jsonb
                         CHECK (jsonb_typeof(schedule) = 'object'),
  approval_policy       jsonb NOT NULL DEFAULT '{"human_review_required":true}'::jsonb
                         CHECK (jsonb_typeof(approval_policy) = 'object'),
  revision              integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  assigned_by           uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT enterprise_skill_assignments_agent_key UNIQUE (workspace_id, agent_id, skill_key)
);
CREATE INDEX IF NOT EXISTS enterprise_skill_assignments_workspace_state_idx
  ON enterprise_skill_assignments (workspace_id, state, agent_id);

CREATE TABLE IF NOT EXISTS enterprise_skill_assignment_revisions (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  assignment_id         uuid NOT NULL REFERENCES enterprise_skill_assignments (id) ON DELETE CASCADE,
  workspace_id          uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  revision              integer NOT NULL CHECK (revision > 0),
  skill_version         text NOT NULL,
  state                 text NOT NULL CHECK (state IN ('active', 'paused')),
  config                jsonb NOT NULL CHECK (jsonb_typeof(config) = 'object'),
  capability_grants     text[] NOT NULL DEFAULT '{}',
  schedule              jsonb NOT NULL CHECK (jsonb_typeof(schedule) = 'object'),
  approval_policy       jsonb NOT NULL CHECK (jsonb_typeof(approval_policy) = 'object'),
  changed_by            uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT enterprise_skill_assignment_revisions_key UNIQUE (assignment_id, revision)
);
CREATE INDEX IF NOT EXISTS enterprise_skill_assignment_revisions_workspace_idx
  ON enterprise_skill_assignment_revisions (workspace_id, assignment_id, revision DESC);

CREATE OR REPLACE FUNCTION enforce_enterprise_skill_assignment_revision()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.workspace_id <> OLD.workspace_id OR NEW.agent_id <> OLD.agent_id OR NEW.skill_key <> OLD.skill_key THEN
    RAISE EXCEPTION 'enterprise skill assignment identity is immutable';
  END IF;
  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'enterprise skill assignment revision must increase by one';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS enterprise_skill_assignment_revision_guard ON enterprise_skill_assignments;
CREATE TRIGGER enterprise_skill_assignment_revision_guard
  BEFORE UPDATE ON enterprise_skill_assignments
  FOR EACH ROW EXECUTE FUNCTION enforce_enterprise_skill_assignment_revision();

CREATE OR REPLACE FUNCTION capture_enterprise_skill_assignment_revision()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO enterprise_skill_assignment_revisions
    (assignment_id, workspace_id, revision, skill_version, state, config,
     capability_grants, schedule, approval_policy, changed_by)
  VALUES
    (NEW.id, NEW.workspace_id, NEW.revision, NEW.skill_version, NEW.state, NEW.config,
     NEW.capability_grants, NEW.schedule, NEW.approval_policy,
     COALESCE(
       (SELECT id FROM users WHERE id = NULLIF(current_setting('app.user_id', true), '')::uuid),
       NEW.assigned_by
     ));
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS enterprise_skill_assignment_revision_capture ON enterprise_skill_assignments;
CREATE TRIGGER enterprise_skill_assignment_revision_capture
  AFTER INSERT OR UPDATE ON enterprise_skill_assignments
  FOR EACH ROW EXECUTE FUNCTION capture_enterprise_skill_assignment_revision();

ALTER TABLE enterprise_skill_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE enterprise_skill_assignments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON enterprise_skill_assignments;
CREATE POLICY tenant_isolation ON enterprise_skill_assignments
  USING (workspace_id = app_workspace_id()) WITH CHECK (workspace_id = app_workspace_id());

ALTER TABLE enterprise_skill_assignment_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE enterprise_skill_assignment_revisions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON enterprise_skill_assignment_revisions;
CREATE POLICY tenant_isolation ON enterprise_skill_assignment_revisions
  USING (workspace_id = app_workspace_id()) WITH CHECK (workspace_id = app_workspace_id());

GRANT SELECT, INSERT, UPDATE ON enterprise_skill_assignments TO app;
GRANT SELECT, INSERT ON enterprise_skill_assignment_revisions TO app;
GRANT SELECT ON enterprise_skill_assignments, enterprise_skill_assignment_revisions TO agent;
REVOKE INSERT, UPDATE, DELETE ON enterprise_skill_assignments FROM agent;
REVOKE INSERT, UPDATE, DELETE ON enterprise_skill_assignment_revisions FROM agent;
