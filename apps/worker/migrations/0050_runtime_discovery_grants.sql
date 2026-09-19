-- A warm Hermes profile gets one narrowly-scoped credential before it is
-- claimable.  The credential can read only its exact skill/tool manifest until
-- invitation acceptance atomically promotes the same digest onto a ready
-- runtime binding.  Plaintext bearer values are never persisted.

CREATE TABLE IF NOT EXISTS runtime_discovery_grants (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  agent_id               uuid NOT NULL,
  created_by             uuid REFERENCES users (id) ON DELETE SET NULL,
  credential_digest      bytea NOT NULL CHECK (octet_length(credential_digest) = 32),
  role_template_key      text NOT NULL CHECK (role_template_key = 'partnerships-agent'),
  skill_key              text NOT NULL CHECK (skill_key = 'partner-program-screening'),
  skill_version          text NOT NULL CHECK (skill_version = '1.7.0'),
  runtime_name           text NOT NULL CHECK (runtime_name = 'enterprise_bridge:partner-program-screening'),
  artifact_digest        text NOT NULL CHECK (artifact_digest = 'sha256:9f124ce44aa318b13e9f8ccfd92072d8b3ba6a22030eaad31cfafbfda3a1e2a9'),
  assignment_id          uuid REFERENCES enterprise_skill_assignments (id) ON DELETE RESTRICT,
  assignment_revision    integer CHECK (assignment_revision > 0),
  config_digest          text NOT NULL CHECK (config_digest ~ '^sha256:[0-9a-f]{64}$'),
  grant_revision         integer NOT NULL DEFAULT 1 CHECK (grant_revision > 0),
  linked_capacity_id     uuid,
  -- Prepared grants expire. Linking a verified warm profile clears this field;
  -- the bearer then lives only until quarantine, retirement or assignment.
  expires_at             timestamptz,
  revoked_at             timestamptz,
  consumed_at            timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT runtime_discovery_grants_assignment_pair CHECK (
    (assignment_id IS NULL AND assignment_revision IS NULL)
    OR (assignment_id IS NOT NULL AND assignment_revision IS NOT NULL)
  ),
  CONSTRAINT runtime_discovery_grants_lifecycle CHECK (
    NOT (revoked_at IS NOT NULL AND consumed_at IS NOT NULL)
  ),
  CONSTRAINT runtime_discovery_grants_expiry CHECK (
    (linked_capacity_id IS NULL AND expires_at IS NOT NULL)
    OR linked_capacity_id IS NOT NULL
  ),
  CONSTRAINT runtime_discovery_grants_workspace_id_unique UNIQUE (workspace_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS runtime_discovery_grants_active_agent_idx
  ON runtime_discovery_grants (workspace_id, agent_id)
  WHERE revoked_at IS NULL AND consumed_at IS NULL;
CREATE INDEX IF NOT EXISTS runtime_discovery_grants_capacity_idx
  ON runtime_discovery_grants (workspace_id, linked_capacity_id)
  WHERE revoked_at IS NULL AND consumed_at IS NULL;
DROP TRIGGER IF EXISTS runtime_discovery_grants_updated_at ON runtime_discovery_grants;
CREATE TRIGGER runtime_discovery_grants_updated_at BEFORE UPDATE ON runtime_discovery_grants
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE hermes_cloud_capacity
  ADD COLUMN IF NOT EXISTS discovery_grant_id uuid;
CREATE UNIQUE INDEX IF NOT EXISTS hermes_cloud_capacity_discovery_grant_idx
  ON hermes_cloud_capacity (workspace_id, discovery_grant_id)
  WHERE discovery_grant_id IS NOT NULL;
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid='hermes_cloud_capacity'::regclass
       AND conname='hermes_cloud_capacity_workspace_id_unique'
  ) THEN
    ALTER TABLE hermes_cloud_capacity
      ADD CONSTRAINT hermes_cloud_capacity_workspace_id_unique UNIQUE (workspace_id, id);
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid='hermes_cloud_capacity'::regclass
       AND conname='hermes_cloud_capacity_discovery_grant_fk'
  ) THEN
    ALTER TABLE hermes_cloud_capacity
      ADD CONSTRAINT hermes_cloud_capacity_discovery_grant_fk
      FOREIGN KEY (workspace_id, discovery_grant_id)
      REFERENCES runtime_discovery_grants (workspace_id, id) ON DELETE RESTRICT;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid='runtime_discovery_grants'::regclass
       AND conname='runtime_discovery_grants_capacity_fk'
  ) THEN
    ALTER TABLE runtime_discovery_grants
      ADD CONSTRAINT runtime_discovery_grants_capacity_fk
      FOREIGN KEY (workspace_id, linked_capacity_id)
      REFERENCES hermes_cloud_capacity (workspace_id, id) ON DELETE RESTRICT;
  END IF;
END $$;

ALTER TABLE agent_runtime_bindings
  ADD COLUMN IF NOT EXISTS runtime_credential_digest bytea;
ALTER TABLE agent_runtime_bindings
  ADD COLUMN IF NOT EXISTS runtime_auth_mode text NOT NULL DEFAULT 'legacy_hmac';
ALTER TABLE agent_runtime_bindings DROP CONSTRAINT IF EXISTS agent_runtime_bindings_auth_mode_check;
ALTER TABLE agent_runtime_bindings ADD CONSTRAINT agent_runtime_bindings_auth_mode_check CHECK (
  (runtime_auth_mode = 'legacy_hmac' AND runtime_credential_digest IS NULL)
  OR (runtime_auth_mode = 'token_digest' AND runtime_credential_digest IS NOT NULL
      AND octet_length(runtime_credential_digest) = 32)
);

ALTER TABLE runtime_discovery_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE runtime_discovery_grants FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON runtime_discovery_grants;
CREATE POLICY tenant_isolation ON runtime_discovery_grants
  USING (workspace_id = app_workspace_id()) WITH CHECK (workspace_id = app_workspace_id());

GRANT SELECT, INSERT, UPDATE ON runtime_discovery_grants TO app;
REVOKE ALL ON runtime_discovery_grants FROM agent;
REVOKE DELETE ON runtime_discovery_grants FROM app;
GRANT SELECT (runtime_credential_digest, runtime_auth_mode), UPDATE (runtime_credential_digest, runtime_auth_mode) ON agent_runtime_bindings TO app;
GRANT SELECT (discovery_grant_id), UPDATE (discovery_grant_id) ON hermes_cloud_capacity TO app;
