-- Management credentials are not inference keys and are never runtime-readable.
CREATE TABLE IF NOT EXISTS cloud_connections (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL UNIQUE REFERENCES workspaces(id) ON DELETE CASCADE,
  initiated_by uuid NOT NULL REFERENCES users(id),
  status text NOT NULL CHECK (status IN ('verification_required','connected','reconnect_required')),
  organization_id text,
  organization_name text,
  ciphertext bytea NOT NULL,
  iv bytea NOT NULL,
  wrapped_dek bytea NOT NULL,
  wrap_iv bytea NOT NULL,
  kek_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS cloud_connection_attempts (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  initiated_by uuid NOT NULL REFERENCES users(id),
  state_hash text NOT NULL UNIQUE,
  status text NOT NULL CHECK (status IN ('pending','consumed','complete','failed','cancelled')),
  ciphertext bytea NOT NULL,
  iv bytea NOT NULL,
  wrapped_dek bytea NOT NULL,
  wrap_iv bytea NOT NULL,
  kek_version integer NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS cloud_connection_attempts_active
  ON cloud_connection_attempts(workspace_id) WHERE status IN ('pending','consumed');
ALTER TABLE cloud_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_connections FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON cloud_connections;
CREATE POLICY tenant_isolation ON cloud_connections USING (workspace_id=app_workspace_id()) WITH CHECK (workspace_id=app_workspace_id());
ALTER TABLE cloud_connection_attempts ENABLE ROW LEVEL SECURITY;
ALTER TABLE cloud_connection_attempts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON cloud_connection_attempts;
CREATE POLICY tenant_isolation ON cloud_connection_attempts USING (workspace_id=app_workspace_id()) WITH CHECK (workspace_id=app_workspace_id());
GRANT SELECT, INSERT, UPDATE ON cloud_connections, cloud_connection_attempts TO app;
REVOKE ALL ON cloud_connections, cloud_connection_attempts FROM agent;
