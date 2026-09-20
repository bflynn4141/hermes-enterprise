-- 0060: selected Gmail threads as governed, immutable evidence.
--
-- This is intentionally separate from outbound_email_accounts. A gmail.send
-- grant is not read authority, and a gmail.readonly grant is never considered
-- a sender. The application exposes no mailbox search/list endpoint: an Admin
-- must choose one provider thread id for each import.

CREATE UNIQUE INDEX IF NOT EXISTS outbound_email_outbox_workspace_id_id_key
  ON outbound_email_outbox (workspace_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS library_source_versions_workspace_source_id_key
  ON library_source_versions (workspace_id, source_id, id);

CREATE TABLE IF NOT EXISTS gmail_evidence_accounts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  provider          text NOT NULL DEFAULT 'gmail' CHECK (provider = 'gmail'),
  address           text NOT NULL CHECK (address = lower(address) AND length(address) BETWEEN 3 AND 320),
  status            text NOT NULL DEFAULT 'connected'
                    CHECK (status IN ('connected', 'error', 'revoked')),
  ciphertext        bytea NOT NULL,
  iv                bytea NOT NULL,
  wrapped_dek       bytea NOT NULL,
  wrap_iv           bytea NOT NULL,
  kek_version       integer NOT NULL,
  scope             text NOT NULL CHECK (scope = 'https://www.googleapis.com/auth/gmail.readonly'),
  token_expires_at  timestamptz NOT NULL,
  connected_by      uuid REFERENCES users (id) ON DELETE SET NULL,
  last_error        text,
  connected_at      timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT gmail_evidence_accounts_workspace_address_key UNIQUE (workspace_id, address),
  CONSTRAINT gmail_evidence_accounts_workspace_id_key UNIQUE (workspace_id, id)
);
DROP TRIGGER IF EXISTS gmail_evidence_accounts_updated_at ON gmail_evidence_accounts;
CREATE TRIGGER gmail_evidence_accounts_updated_at BEFORE UPDATE ON gmail_evidence_accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS gmail_evidence_oauth_states (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  requested_by    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  state_digest    text NOT NULL CHECK (state_digest ~ '^[0-9a-f]{64}$'),
  redirect_uri    text NOT NULL,
  expires_at      timestamptz NOT NULL,
  consumed_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT gmail_evidence_oauth_states_digest_key UNIQUE (state_digest)
);
CREATE INDEX IF NOT EXISTS gmail_evidence_oauth_states_pending_idx
  ON gmail_evidence_oauth_states (workspace_id, requested_by, expires_at)
  WHERE consumed_at IS NULL;

CREATE TABLE IF NOT EXISTS mailbox_thread_snapshots (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  account_id            uuid NOT NULL,
  team_id               uuid NOT NULL,
  library_source_id     uuid NOT NULL,
  library_version_id    uuid NOT NULL,
  provider              text NOT NULL CHECK (provider = 'gmail'),
  provider_thread_id    text NOT NULL CHECK (length(provider_thread_id) BETWEEN 1 AND 256),
  title                 text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  message_count         integer NOT NULL CHECK (message_count BETWEEN 1 AND 250),
  normalized_sha256     text NOT NULL CHECK (normalized_sha256 ~ '^[0-9a-f]{64}$'),
  normalized_thread     jsonb NOT NULL CHECK (jsonb_typeof(normalized_thread) = 'object'),
  imported_by           uuid REFERENCES users (id) ON DELETE SET NULL,
  imported_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT mailbox_thread_snapshots_account_fk FOREIGN KEY (workspace_id, account_id)
    REFERENCES gmail_evidence_accounts (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT mailbox_thread_snapshots_team_fk FOREIGN KEY (workspace_id, team_id)
    REFERENCES enterprise_teams (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT mailbox_thread_snapshots_source_fk FOREIGN KEY (workspace_id, library_source_id)
    REFERENCES library_sources (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT mailbox_thread_snapshots_version_fk
    FOREIGN KEY (workspace_id, library_source_id, library_version_id)
    REFERENCES library_source_versions (workspace_id, source_id, id) ON DELETE RESTRICT,
  CONSTRAINT mailbox_thread_snapshots_exact_key UNIQUE
    (workspace_id, account_id, team_id, provider_thread_id, normalized_sha256),
  CONSTRAINT mailbox_thread_snapshots_workspace_id_key UNIQUE (workspace_id, id),
  CONSTRAINT mailbox_thread_snapshots_evidence_binding_key UNIQUE
    (workspace_id, id, library_source_id, library_version_id, normalized_sha256),
  CONSTRAINT mailbox_thread_snapshots_library_version_key UNIQUE (library_version_id)
);
CREATE INDEX IF NOT EXISTS mailbox_thread_snapshots_thread_idx
  ON mailbox_thread_snapshots (workspace_id, account_id, provider_thread_id, imported_at DESC);

CREATE TABLE IF NOT EXISTS inbound_email_events (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  snapshot_id         uuid NOT NULL,
  provider_message_id text NOT NULL CHECK (length(provider_message_id) BETWEEN 1 AND 256),
  kind                text NOT NULL CHECK (kind IN ('reply', 'bounce', 'unsubscribe')),
  contact_address     text NOT NULL CHECK (contact_address = lower(contact_address)),
  linked_outbox_id    uuid,
  evidence            jsonb NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
  recorded_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT inbound_email_events_snapshot_fk FOREIGN KEY (workspace_id, snapshot_id)
    REFERENCES mailbox_thread_snapshots (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT inbound_email_events_outbox_fk FOREIGN KEY (workspace_id, linked_outbox_id)
    REFERENCES outbound_email_outbox (workspace_id, id) ON DELETE SET NULL,
  CONSTRAINT inbound_email_events_exact_key UNIQUE
    (workspace_id, snapshot_id, provider_message_id, kind, contact_address)
);
CREATE INDEX IF NOT EXISTS inbound_email_events_contact_idx
  ON inbound_email_events (workspace_id, contact_address, recorded_at DESC);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'gmail_evidence_accounts', 'gmail_evidence_oauth_states',
    'mailbox_thread_snapshots', 'inbound_email_events'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (workspace_id = app_workspace_id()) WITH CHECK (workspace_id = app_workspace_id())',
      table_name
    );
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON gmail_evidence_accounts, gmail_evidence_oauth_states TO app;
GRANT SELECT, INSERT ON mailbox_thread_snapshots, inbound_email_events TO app;
-- The app role can publish immutable versions and explicit team grants only
-- through tenant-scoped routes. Existing immutability triggers still refuse
-- mutation of source versions.
GRANT INSERT ON library_sources, library_source_versions, library_source_team_grants TO app;
REVOKE DELETE ON gmail_evidence_accounts, gmail_evidence_oauth_states FROM app;
REVOKE UPDATE, DELETE ON mailbox_thread_snapshots, inbound_email_events FROM app;
REVOKE ALL ON gmail_evidence_accounts, gmail_evidence_oauth_states,
  mailbox_thread_snapshots, inbound_email_events FROM agent;

DROP TRIGGER IF EXISTS mailbox_thread_snapshots_append_only ON mailbox_thread_snapshots;
CREATE TRIGGER mailbox_thread_snapshots_append_only BEFORE UPDATE OR DELETE ON mailbox_thread_snapshots
  FOR EACH ROW EXECUTE FUNCTION refuse_mutation();
DROP TRIGGER IF EXISTS inbound_email_events_append_only ON inbound_email_events;
CREATE TRIGGER inbound_email_events_append_only BEFORE UPDATE OR DELETE ON inbound_email_events
  FOR EACH ROW EXECUTE FUNCTION refuse_mutation();
