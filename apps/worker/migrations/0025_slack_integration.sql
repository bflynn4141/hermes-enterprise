-- 0025_slack_integration.sql
-- Slack is an authenticated transport into the existing workspace agent. It
-- owns no skills, tool permissions or approval authority.

CREATE TABLE IF NOT EXISTS slack_oauth_states (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  requested_by    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  state_digest    text NOT NULL CHECK (state_digest ~ '^[0-9a-f]{64}$'),
  redirect_uri    text NOT NULL,
  expires_at      timestamptz NOT NULL,
  consumed_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT slack_oauth_states_digest UNIQUE (state_digest)
);
CREATE INDEX IF NOT EXISTS slack_oauth_states_workspace_idx
  ON slack_oauth_states (workspace_id, expires_at DESC);

CREATE TABLE IF NOT EXISTS slack_installations (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id               uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  installed_by               uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  slack_install_key          text NOT NULL,
  slack_app_id               text NOT NULL,
  slack_enterprise_id        text,
  slack_enterprise_name      text,
  slack_team_id              text,
  slack_team_name            text,
  is_enterprise_install      boolean NOT NULL DEFAULT false,
  slack_bot_user_id          text NOT NULL,
  slack_authed_user_id       text,
  granted_scopes             text[] NOT NULL DEFAULT '{}',
  ciphertext                 bytea NOT NULL,
  iv                         bytea NOT NULL,
  wrapped_dek                bytea NOT NULL,
  wrap_iv                    bytea NOT NULL,
  kek_version                integer NOT NULL,
  token_expires_at           timestamptz,
  status                     text NOT NULL DEFAULT 'connected'
                               CHECK (status IN ('connected', 'error', 'revoked')),
  last_error_code            text,
  remote_revocation_pending  boolean NOT NULL DEFAULT false,
  connected_at               timestamptz NOT NULL DEFAULT now(),
  revoked_at                 timestamptz,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT slack_install_key_shape CHECK (
    slack_install_key LIKE 'team:%' OR slack_install_key LIKE 'enterprise:%'
  ),
  CONSTRAINT slack_install_target CHECK (
    (is_enterprise_install AND slack_enterprise_id IS NOT NULL)
    OR (NOT is_enterprise_install AND slack_team_id IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS slack_installations_one_active_workspace
  ON slack_installations (workspace_id) WHERE status <> 'revoked';
CREATE UNIQUE INDEX IF NOT EXISTS slack_installations_one_active_target
  ON slack_installations (slack_install_key) WHERE status <> 'revoked';
CREATE INDEX IF NOT EXISTS slack_installations_workspace_idx
  ON slack_installations (workspace_id, connected_at DESC);
DROP TRIGGER IF EXISTS slack_installations_updated_at ON slack_installations;
CREATE TRIGGER slack_installations_updated_at BEFORE UPDATE ON slack_installations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Minimal cross-tenant routing data. It contains no token, Slack content or
-- member identity: the signed event gives an installation key, this answers
-- which RLS tenant transaction may inspect the full row.
CREATE TABLE IF NOT EXISTS slack_installation_directory (
  slack_install_key    text PRIMARY KEY,
  target_workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  installation_id     uuid NOT NULL UNIQUE REFERENCES slack_installations (id) ON DELETE CASCADE,
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE OR REPLACE FUNCTION slack_installation_directory_sync() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
  AS $$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      DELETE FROM slack_installation_directory WHERE installation_id = OLD.id;
      RETURN OLD;
    END IF;
    IF NEW.status = 'revoked' THEN
      DELETE FROM slack_installation_directory WHERE installation_id = NEW.id;
      RETURN NEW;
    END IF;
    INSERT INTO slack_installation_directory (slack_install_key, target_workspace_id, installation_id, updated_at)
    VALUES (NEW.slack_install_key, NEW.workspace_id, NEW.id, now())
    ON CONFLICT (slack_install_key) DO UPDATE
      SET target_workspace_id = EXCLUDED.target_workspace_id,
          installation_id = EXCLUDED.installation_id,
          updated_at = now();
    RETURN NEW;
  END $$;
DROP TRIGGER IF EXISTS slack_installations_directory_sync ON slack_installations;
CREATE TRIGGER slack_installations_directory_sync
  AFTER INSERT OR UPDATE OR DELETE ON slack_installations
  FOR EACH ROW EXECUTE FUNCTION slack_installation_directory_sync();

CREATE TABLE IF NOT EXISTS slack_user_links (
  workspace_id    uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  installation_id uuid NOT NULL REFERENCES slack_installations (id) ON DELETE CASCADE,
  slack_user_id   text NOT NULL,
  user_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  linked_by       uuid REFERENCES users (id) ON DELETE SET NULL,
  revoked_at      timestamptz,
  linked_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (installation_id, slack_user_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS slack_user_links_member_key
  ON slack_user_links (installation_id, user_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS slack_link_codes (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id           uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  installation_id        uuid NOT NULL REFERENCES slack_installations (id) ON DELETE CASCADE,
  user_id                 uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  code_digest             text NOT NULL UNIQUE CHECK (code_digest ~ '^[0-9a-f]{64}$'),
  expires_at              timestamptz NOT NULL,
  consumed_by_slack_user  text,
  consumed_at             timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS slack_link_codes_workspace_idx
  ON slack_link_codes (workspace_id, user_id, expires_at DESC);

CREATE TABLE IF NOT EXISTS slack_conversations (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  installation_id  uuid NOT NULL REFERENCES slack_installations (id) ON DELETE CASCADE,
  slack_channel_id text NOT NULL,
  conversation_key text NOT NULL,
  conversation_kind text NOT NULL CHECK (conversation_kind IN ('direct_message', 'channel_thread')),
  agent_id         uuid NOT NULL REFERENCES agents (id) ON DELETE RESTRICT,
  session_id       uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  owner_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT slack_conversations_key UNIQUE (installation_id, slack_channel_id, conversation_key)
);
CREATE INDEX IF NOT EXISTS slack_conversations_session_idx
  ON slack_conversations (workspace_id, session_id);
DROP TRIGGER IF EXISTS slack_conversations_updated_at ON slack_conversations;
CREATE TRIGGER slack_conversations_updated_at BEFORE UPDATE ON slack_conversations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS slack_events (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  installation_id  uuid NOT NULL REFERENCES slack_installations (id) ON DELETE CASCADE,
  slack_event_id   text NOT NULL,
  event_type       text NOT NULL,
  payload_sha256   text NOT NULL CHECK (payload_sha256 ~ '^[0-9a-f]{64}$'),
  retry_num        integer,
  status           text NOT NULL DEFAULT 'received'
                     CHECK (status IN ('received', 'ignored', 'unlinked', 'submitted', 'failed')),
  run_id           uuid REFERENCES runs (id) ON DELETE SET NULL,
  error_code       text,
  received_at      timestamptz NOT NULL DEFAULT now(),
  processed_at     timestamptz,
  CONSTRAINT slack_events_idempotency UNIQUE (slack_event_id)
);

CREATE TABLE IF NOT EXISTS slack_run_deliveries (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  installation_id     uuid NOT NULL REFERENCES slack_installations (id) ON DELETE CASCADE,
  source_event_id     uuid NOT NULL UNIQUE REFERENCES slack_events (id) ON DELETE CASCADE,
  run_id              uuid NOT NULL UNIQUE REFERENCES runs (id) ON DELETE CASCADE,
  slack_channel_id    text NOT NULL,
  slack_thread_ts     text NOT NULL,
  status              text NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending', 'queued', 'sent', 'failed', 'cancelled')),
  slack_message_ts    text,
  attempts            integer NOT NULL DEFAULT 0,
  last_error_code     text,
  approval_notified_at timestamptz,
  approval_client_msg_id uuid NOT NULL DEFAULT gen_random_uuid(),
  delivered_at        timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
DROP TRIGGER IF EXISTS slack_run_deliveries_updated_at ON slack_run_deliveries;
CREATE TRIGGER slack_run_deliveries_updated_at BEFORE UPDATE ON slack_run_deliveries
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'slack_oauth_states', 'slack_installations', 'slack_user_links', 'slack_link_codes',
    'slack_conversations', 'slack_events', 'slack_run_deliveries'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (workspace_id = app_workspace_id()) WITH CHECK (workspace_id = app_workspace_id())',
      t
    );
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON
  slack_oauth_states, slack_installations, slack_user_links, slack_link_codes, slack_conversations,
  slack_events, slack_run_deliveries
TO app;
GRANT SELECT ON slack_installation_directory TO app;
REVOKE ALL ON slack_oauth_states, slack_installations, slack_user_links, slack_link_codes,
  slack_conversations, slack_events, slack_run_deliveries, slack_installation_directory
FROM agent;

-- Restate the dynamic tenant list with the intentionally platform-wide Slack
-- pointer excluded. Its target rows remain protected by forced RLS.
CREATE OR REPLACE FUNCTION hermes_tenant_tables() RETURNS TABLE (table_name text)
  LANGUAGE sql STABLE
  AS $$
    SELECT c.relname::text
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND (
        c.relname = 'workspaces'
        OR EXISTS (
          SELECT 1 FROM pg_attribute a
          WHERE a.attrelid = c.oid AND a.attname = 'workspace_id' AND a.attnum > 0 AND NOT a.attisdropped
        )
      )
      AND c.relname NOT IN (
        'rate_counters', 'workspace_directory', 'job_ready',
        'platform_counters', 'validator_runs', 'member_directory',
        'invitation_directory', 'share_directory', 'slack_installation_directory'
      )
  $$;

ALTER TABLE slack_installation_directory DISABLE ROW LEVEL SECURITY;
ALTER TABLE slack_installation_directory NO FORCE ROW LEVEL SECURITY;

ALTER TABLE events DROP CONSTRAINT IF EXISTS events_kind_check;
ALTER TABLE events ADD CONSTRAINT events_kind_check CHECK (kind IN (
  'decision.recorded', 'request.created', 'effect.assigned', 'effect.executed', 'effect.cancelled',
  'document.created', 'document.versioned', 'member.invited', 'member.joined', 'member.role_changed',
  'member.removed', 'instruction.saved', 'instruction.proposed', 'context.set', 'settings.changed',
  'session.shared', 'session.unshared', 'provider_key.added', 'provider_key.verified',
  'provider_key.revoked', 'workspace.created', 'workspace.deletion_scheduled', 'subject.redacted',
  'run.errored', 'usage.cap_warning', 'workspace.deletion_cancelled', 'workspace.deleted',
  'provider_key.attested', 'provider_key.rewrapped', 'validator.failed',
  'approval.proposed', 'approval.vote_recorded', 'approval.revised', 'approval.routed',
  'approval.finalized', 'approval.expired', 'slack.connected', 'slack.disconnected',
  'slack.credential_rewrapped'
));
