-- Workspace wallet root setup (C103). An Admin's passkey becomes the only root
-- of the workspace's Turnkey sub-organization. Each attempt is one row, so an
-- uncertain provider outcome is reconciled rather than retried into a second
-- sub-organization. Nothing here grants signing authority.

ALTER TABLE workspace_wallet_config DROP CONSTRAINT IF EXISTS workspace_wallet_config_status_check;
ALTER TABLE workspace_wallet_config ADD CONSTRAINT workspace_wallet_config_status_check CHECK (status IN (
  'awaiting_owner_enrollment',  -- enrollment requested; no provider organization
  'creating_root',              -- a setup attempt is talking to Turnkey
  'needs_reconciliation',       -- the provider outcome is unknown; check before retrying
  'root_verified',              -- read-back confirmed the Admin's passkey is the only root
  'needs_attention'             -- a sub-organization exists but failed the custody check
));
ALTER TABLE workspace_wallet_config
  ADD COLUMN IF NOT EXISTS provider_org_id text UNIQUE,
  ADD COLUMN IF NOT EXISTS root_member_id uuid,
  ADD COLUMN IF NOT EXISTS root_verified_at timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE workspace_wallet_config DROP CONSTRAINT IF EXISTS workspace_wallet_config_root_member_fk;
ALTER TABLE workspace_wallet_config ADD CONSTRAINT workspace_wallet_config_root_member_fk
  FOREIGN KEY (workspace_id, root_member_id) REFERENCES members(workspace_id, id);
ALTER TABLE workspace_wallet_config DROP CONSTRAINT IF EXISTS workspace_wallet_config_verified_shape;
ALTER TABLE workspace_wallet_config ADD CONSTRAINT workspace_wallet_config_verified_shape CHECK (
  status <> 'root_verified' OR (provider_org_id IS NOT NULL AND root_member_id IS NOT NULL AND root_verified_at IS NOT NULL));

CREATE TABLE IF NOT EXISTS wallet_root_setups (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspace_wallet_config(workspace_id) ON DELETE CASCADE,
  member_id uuid NOT NULL,
  -- The WebAuthn challenge (32 random bytes, base64url). Single use.
  challenge text NOT NULL UNIQUE CHECK (challenge ~ '^[A-Za-z0-9_-]{43}$'),
  state text NOT NULL DEFAULT 'challenged' CHECK (state IN (
    'challenged',   -- challenge issued; waiting for the browser's passkey
    'submitting',   -- create request sent to Turnkey
    'ambiguous',    -- no definite answer; reconcile by the sub-organization name
    'rejected',     -- Turnkey refused; nothing was created, a new attempt may start
    'created',      -- sub-organization exists; custody not yet verified
    'verified',     -- custody verified by read-back
    'unverified'    -- custody check failed; never becomes ready
  )),
  -- Deterministic and unique so an uncertain create can be found again.
  suborg_name text NOT NULL UNIQUE CHECK (suborg_name ~ '^hermes-ws-[0-9a-f-]{36}-[0-9a-f-]{36}$'),
  credential_id text CHECK (credential_id ~ '^[A-Za-z0-9_-]+$' AND char_length(credential_id) BETWEEN 16 AND 1366),
  provider_org_id text,
  provider_root_user_id text,
  provider_activity_id text,
  failure_code text CHECK (failure_code ~ '^[a-z0-9_]{1,64}$'),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  FOREIGN KEY (workspace_id, member_id) REFERENCES members(workspace_id, id)
);
-- At most one attempt per workspace may be in flight or done at a time.
CREATE UNIQUE INDEX IF NOT EXISTS wallet_root_setup_open ON wallet_root_setups(workspace_id)
  WHERE state IN ('submitting', 'ambiguous', 'created', 'verified', 'unverified');

ALTER TABLE wallet_root_setups ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallet_root_setups FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON wallet_root_setups;
CREATE POLICY tenant_isolation ON wallet_root_setups
  USING (workspace_id = app_workspace_id()) WITH CHECK (workspace_id = app_workspace_id());
GRANT SELECT, INSERT ON wallet_root_setups TO app;
GRANT UPDATE (state, credential_id, provider_org_id, provider_root_user_id, provider_activity_id, failure_code, updated_at)
  ON wallet_root_setups TO app;
REVOKE ALL ON wallet_root_setups FROM agent;
GRANT UPDATE (status, provider_org_id, root_member_id, root_verified_at, updated_at) ON workspace_wallet_config TO app;
