-- 0025_nous_oauth.sql
-- Workspace-managed Nous Portal OAuth credentials.
--
-- Nous inference uses the Portal's RFC 8628 device authorization contract.
-- The short-lived device code and the resulting rotating refresh-token bundle
-- are envelope encrypted. Only redacted lifecycle metadata is projected.

ALTER TABLE workspace_provider_keys
  ADD COLUMN IF NOT EXISTS credential_kind text NOT NULL DEFAULT 'api_key',
  ADD COLUMN IF NOT EXISTS oauth_client_id text,
  ADD COLUMN IF NOT EXISTS oauth_scope text,
  ADD COLUMN IF NOT EXISTS oauth_expires_at timestamptz;

ALTER TABLE workspace_provider_keys
  DROP CONSTRAINT IF EXISTS workspace_provider_keys_credential_kind_check;
ALTER TABLE workspace_provider_keys
  ADD CONSTRAINT workspace_provider_keys_credential_kind_check
  CHECK (credential_kind IN ('api_key', 'oauth_device_code'));

CREATE TABLE IF NOT EXISTS provider_oauth_sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  provider text NOT NULL CHECK (provider = 'nous_portal'),
  connection_id uuid REFERENCES workspace_provider_keys (id) ON DELETE SET NULL,
  initiated_by uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  client_id text NOT NULL,
  scope text NOT NULL,
  portal_base_url text NOT NULL,
  verification_uri text NOT NULL,
  user_code text NOT NULL,
  ciphertext bytea NOT NULL,
  iv bytea NOT NULL,
  wrapped_dek bytea NOT NULL,
  wrap_iv bytea NOT NULL,
  kek_version integer NOT NULL,
  poll_interval_seconds integer NOT NULL CHECK (poll_interval_seconds BETWEEN 1 AND 30),
  next_poll_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'connected', 'expired', 'failed', 'cancelled')),
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS provider_oauth_sessions_pending
  ON provider_oauth_sessions (workspace_id, provider)
  WHERE status = 'pending';

DROP TRIGGER IF EXISTS provider_oauth_sessions_updated_at ON provider_oauth_sessions;
CREATE TRIGGER provider_oauth_sessions_updated_at BEFORE UPDATE ON provider_oauth_sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE provider_oauth_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE provider_oauth_sessions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON provider_oauth_sessions;
CREATE POLICY tenant_isolation ON provider_oauth_sessions
  USING (workspace_id = app_workspace_id())
  WITH CHECK (workspace_id = app_workspace_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON provider_oauth_sessions TO app;

-- The runtime can rotate only an OAuth row's encrypted token envelope and its
-- redacted expiry metadata. RLS still binds the row to app.workspace_id.
GRANT UPDATE (ciphertext, iv, wrapped_dek, wrap_iv, kek_version, fingerprint, oauth_expires_at, status, updated_at)
  ON workspace_provider_keys TO agent;
