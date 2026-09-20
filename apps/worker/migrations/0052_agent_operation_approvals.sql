-- Consent to one supported tool attempt is not a request decision or effect.
CREATE TABLE IF NOT EXISTS agent_operation_policies (
  agent_id uuid PRIMARY KEY REFERENCES agents(id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  revision integer NOT NULL DEFAULT 0 CHECK(revision >= 0),
  operations jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(operations)='object'),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS agent_operation_approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  tool_call_id text NOT NULL,
  operation_id text NOT NULL,
  tool_name text NOT NULL,
  arguments jsonb NOT NULL CHECK(jsonb_typeof(arguments)='object'),
  policy_revision integer NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','denied')),
  decided_by uuid REFERENCES users(id),
  decided_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(run_id, tool_call_id)
);
CREATE TABLE IF NOT EXISTS agent_operation_policy_revisions (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  revision integer NOT NULL CHECK(revision>0),
  operation_id text NOT NULL,
  require_human_approval boolean NOT NULL,
  changed_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY(agent_id,revision)
);
ALTER TABLE agent_operation_policy_revisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_operation_policy_revisions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent_operation_policy_revisions;
CREATE POLICY tenant_isolation ON agent_operation_policy_revisions USING(workspace_id=app_workspace_id()) WITH CHECK(workspace_id=app_workspace_id());
GRANT SELECT,INSERT ON agent_operation_policy_revisions TO app;
CREATE OR REPLACE FUNCTION guard_agent_operation_approval() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP='INSERT' THEN
    IF NEW.status <> 'pending' OR NEW.decided_by IS NOT NULL OR NEW.decided_at IS NOT NULL THEN RAISE EXCEPTION 'approval must begin pending'; END IF;
    IF NOT EXISTS(SELECT 1 FROM runs r WHERE r.id=NEW.run_id AND r.workspace_id=NEW.workspace_id AND r.agent_id=NEW.agent_id)
    THEN RAISE EXCEPTION 'approval run identity mismatch'; END IF;
  ELSE
    IF OLD.status <> 'pending' OR NEW.status NOT IN ('approved','denied') OR NEW.decided_by IS NULL OR NEW.decided_at IS NULL
      OR (to_jsonb(NEW)-'status'-'decided_by'-'decided_at') <> (to_jsonb(OLD)-'status'-'decided_by'-'decided_at')
    THEN RAISE EXCEPTION 'approval identity and final decision are immutable'; END IF;
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS agent_operation_approval_guard ON agent_operation_approvals;
CREATE TRIGGER agent_operation_approval_guard BEFORE INSERT OR UPDATE ON agent_operation_approvals FOR EACH ROW EXECUTE FUNCTION guard_agent_operation_approval();
ALTER TABLE agent_operation_policies ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_operation_policies FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent_operation_policies;
CREATE POLICY tenant_isolation ON agent_operation_policies USING(workspace_id=app_workspace_id()) WITH CHECK(workspace_id=app_workspace_id());
ALTER TABLE agent_operation_approvals ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_operation_approvals FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent_operation_approvals;
CREATE POLICY tenant_isolation ON agent_operation_approvals USING(workspace_id=app_workspace_id()) WITH CHECK(workspace_id=app_workspace_id());
GRANT SELECT,INSERT,UPDATE ON agent_operation_policies TO app;
GRANT SELECT ON agent_operation_policies TO agent;
GRANT SELECT,INSERT,UPDATE ON agent_operation_approvals TO app;
GRANT SELECT,INSERT ON agent_operation_approvals TO agent;
