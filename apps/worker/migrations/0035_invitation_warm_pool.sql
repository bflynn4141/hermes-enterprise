-- A delivered production-demo invitation is backed by one real, verified
-- Hermes Cloud instance. JIT provisioning remains future pool-refiller
-- infrastructure and is not part of invitation acceptance or onboarding.

ALTER TABLE invitations ADD COLUMN IF NOT EXISTS delivery_status text NOT NULL DEFAULT 'not_required';
ALTER TABLE invitations DROP CONSTRAINT IF EXISTS invitations_delivery_status_check;
ALTER TABLE invitations ADD CONSTRAINT invitations_delivery_status_check
  CHECK (delivery_status IN ('not_required', 'queued', 'sending', 'delivered', 'failed'));
ALTER TABLE invitations ADD COLUMN IF NOT EXISTS delivery_error text;

CREATE TABLE IF NOT EXISTS hermes_cloud_capacity (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id             uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  cloud_agent_id           text NOT NULL,
  instance_name            text NOT NULL,
  dashboard_url            text,
  connector_url            text NOT NULL UNIQUE,
  state                    text NOT NULL DEFAULT 'available'
                             CHECK (state IN ('available', 'reserved', 'assigning', 'assigned', 'quarantined')),
  reserved_invitation_id   uuid UNIQUE REFERENCES invitations (id) ON DELETE SET NULL,
  assigned_agent_id        uuid UNIQUE REFERENCES agents (id) ON DELETE RESTRICT,
  ciphertext               bytea NOT NULL,
  iv                       bytea NOT NULL,
  wrapped_dek              bytea NOT NULL,
  wrap_iv                  bytea NOT NULL,
  kek_version              integer NOT NULL CHECK (kek_version > 0),
  plugin_version           text NOT NULL,
  agentcash_enabled        boolean NOT NULL DEFAULT false,
  agentcash_wallet_present boolean NOT NULL DEFAULT false,
  native_cron_disabled     boolean NOT NULL DEFAULT false,
  readiness_checked_at     timestamptz NOT NULL,
  last_health_checked_at   timestamptz NOT NULL,
  assigned_at              timestamptz,
  quarantined_at           timestamptz,
  quarantine_reason        text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, cloud_agent_id),
  UNIQUE (workspace_id, instance_name),
  CONSTRAINT hermes_cloud_capacity_usable_check CHECK (
    state = 'quarantined'
    OR (agentcash_enabled AND agentcash_wallet_present AND native_cron_disabled)
  ),
  CONSTRAINT hermes_cloud_capacity_assignment_check CHECK (
    (state = 'available' AND reserved_invitation_id IS NULL AND assigned_agent_id IS NULL)
    OR (state = 'reserved' AND reserved_invitation_id IS NOT NULL AND assigned_agent_id IS NULL)
    OR (state IN ('assigning', 'assigned') AND reserved_invitation_id IS NOT NULL AND assigned_agent_id IS NOT NULL)
    OR state = 'quarantined'
  )
);
CREATE INDEX IF NOT EXISTS hermes_cloud_capacity_available_idx
  ON hermes_cloud_capacity (workspace_id, readiness_checked_at, created_at)
  WHERE state = 'available';
CREATE INDEX IF NOT EXISTS hermes_cloud_capacity_state_idx
  ON hermes_cloud_capacity (workspace_id, state, updated_at);
DROP TRIGGER IF EXISTS hermes_cloud_capacity_updated_at ON hermes_cloud_capacity;
CREATE TRIGGER hermes_cloud_capacity_updated_at BEFORE UPDATE ON hermes_cloud_capacity
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Inbox setup work is a first-class persisted record, not an illustrative
-- application or document disguised as one.
ALTER TABLE requests DROP CONSTRAINT IF EXISTS requests_kind_check;
ALTER TABLE requests ADD CONSTRAINT requests_kind_check
  CHECK (kind IN ('application', 'invoice', 'agreement', 'task', 'approval'));

ALTER TABLE hermes_cloud_capacity ENABLE ROW LEVEL SECURITY;
ALTER TABLE hermes_cloud_capacity FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON hermes_cloud_capacity;
CREATE POLICY tenant_isolation ON hermes_cloud_capacity
  USING (workspace_id = app_workspace_id()) WITH CHECK (workspace_id = app_workspace_id());

GRANT SELECT, INSERT, UPDATE ON hermes_cloud_capacity TO app;
REVOKE ALL ON hermes_cloud_capacity FROM agent;
REVOKE DELETE ON hermes_cloud_capacity FROM app;
