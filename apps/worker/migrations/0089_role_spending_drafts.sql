-- Financial proposals only: each save is an immutable audit revision. No
-- executable policy or provider authority can be stored in this table.
CREATE TABLE IF NOT EXISTS role_spending_drafts (
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  -- Deliberately no FK to workspace_roles: audit survives deleting a custom
  -- role. The insert trigger verifies the live, tenant-scoped role instead.
  role_id uuid NOT NULL,
  role_name text NOT NULL CHECK (char_length(role_name) BETWEEN 1 AND 80),
  revision integer NOT NULL CHECK (revision > 0),
  policy jsonb NOT NULL CHECK (
    jsonb_typeof(policy) = 'object' AND policy @> '{"version":1,"chain_id":8453,"asset":"USDC","decimals":6,"token_address":"0x833589fcd6edb6e08f4c7c32d4f71b54bda02913"}'::jsonb
    AND NOT (policy ?| ARRAY['active', 'provider_policy_id', 'enforcement'])
  ),
  requested_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, role_id, revision)
);
ALTER TABLE role_spending_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE role_spending_drafts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON role_spending_drafts;
CREATE POLICY tenant_isolation ON role_spending_drafts
  USING (workspace_id = app_workspace_id()) WITH CHECK (workspace_id = app_workspace_id());
GRANT SELECT, INSERT ON role_spending_drafts TO app;
REVOKE UPDATE, DELETE ON role_spending_drafts FROM app;
REVOKE ALL ON role_spending_drafts FROM agent;

CREATE OR REPLACE FUNCTION role_spending_draft_role_exists()
  RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  PERFORM 1 FROM workspace_roles WHERE workspace_id = NEW.workspace_id AND id = NEW.role_id FOR SHARE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'spending draft needs a role in this workspace' USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS role_spending_draft_role_exists ON role_spending_drafts;
CREATE TRIGGER role_spending_draft_role_exists BEFORE INSERT ON role_spending_drafts
  FOR EACH ROW EXECUTE FUNCTION role_spending_draft_role_exists();
