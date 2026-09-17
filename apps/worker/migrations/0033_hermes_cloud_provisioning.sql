-- 0033_hermes_cloud_provisioning.sql
-- Invitation acceptance creates the member and their draft Iris immediately.
-- Completing first-run setup then queues a durable Hermes Cloud provisioning
-- job. Runtime credentials are envelope-encrypted and are not considered
-- usable until the reviewed Enterprise bridge proves its readiness.

ALTER TABLE agents DROP CONSTRAINT IF EXISTS agents_status_check;
ALTER TABLE agents ADD CONSTRAINT agents_status_check
  CHECK (status IN ('draft', 'provisioning', 'started'));

CREATE TABLE IF NOT EXISTS agent_provisioning (
  workspace_id      uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  agent_id          uuid PRIMARY KEY REFERENCES agents (id) ON DELETE CASCADE,
  status            text NOT NULL DEFAULT 'awaiting_onboarding'
                      CHECK (status IN (
                        'awaiting_onboarding', 'queued', 'creating',
                        'awaiting_bootstrap', 'verifying', 'ready', 'failed'
                      )),
  cloud_agent_id    text,
  instance_name     text NOT NULL,
  dashboard_url     text,
  region            text NOT NULL DEFAULT 'sjc',
  model             text NOT NULL DEFAULT 'z-ai/glm-5.2',
  size              text NOT NULL DEFAULT 'medium',
  attempts          integer NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  error_code        text,
  error_detail      text,
  requested_at      timestamptz,
  cloud_created_at  timestamptz,
  ready_at          timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (cloud_agent_id),
  UNIQUE (workspace_id, instance_name)
);
CREATE INDEX IF NOT EXISTS agent_provisioning_workspace_idx
  ON agent_provisioning (workspace_id, status, created_at);
DROP TRIGGER IF EXISTS agent_provisioning_updated_at ON agent_provisioning;
CREATE TRIGGER agent_provisioning_updated_at BEFORE UPDATE ON agent_provisioning
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS agent_runtime_bindings (
  workspace_id      uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  agent_id          uuid PRIMARY KEY REFERENCES agents (id) ON DELETE CASCADE,
  profile           text NOT NULL,
  base_url          text,
  transport         text NOT NULL DEFAULT 'dashboard_connector'
                      CHECK (transport IN ('native', 'dashboard_connector')),
  assignment        text NOT NULL DEFAULT 'provisioned'
                      CHECK (assignment IN ('fixed', 'invitee_pool', 'provisioned')),
  agentcash         boolean NOT NULL DEFAULT false,
  ciphertext        bytea NOT NULL,
  iv                bytea NOT NULL,
  wrapped_dek       bytea NOT NULL,
  wrap_iv           bytea NOT NULL,
  kek_version       integer NOT NULL CHECK (kek_version > 0),
  ready_at          timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
DROP TRIGGER IF EXISTS agent_runtime_bindings_updated_at ON agent_runtime_bindings;
CREATE TRIGGER agent_runtime_bindings_updated_at BEFORE UPDATE ON agent_runtime_bindings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE agent_provisioning ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_provisioning FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent_provisioning;
CREATE POLICY tenant_isolation ON agent_provisioning
  USING (workspace_id = app_workspace_id()) WITH CHECK (workspace_id = app_workspace_id());

ALTER TABLE agent_runtime_bindings ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_runtime_bindings FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent_runtime_bindings;
CREATE POLICY tenant_isolation ON agent_runtime_bindings
  USING (workspace_id = app_workspace_id()) WITH CHECK (workspace_id = app_workspace_id());

GRANT SELECT, INSERT, UPDATE ON agent_provisioning, agent_runtime_bindings TO app;
GRANT SELECT ON agent_provisioning, agent_runtime_bindings TO agent;
REVOKE DELETE ON agent_provisioning, agent_runtime_bindings FROM app, agent;
REVOKE INSERT, UPDATE ON agent_provisioning, agent_runtime_bindings FROM agent;
