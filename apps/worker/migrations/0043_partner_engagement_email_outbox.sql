-- Durable partner engagement and approved-email outbox.
--
-- Discovery stays useful only if Iris can distinguish a new prospect from one
-- already drafted, declined or contacted. Sending also needs a transactionally
-- bound record of the exact approved revision before a provider is called.

CREATE TABLE IF NOT EXISTS partner_engagements (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  agent_id            uuid NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  candidate_id        uuid NOT NULL REFERENCES partner_candidates (id) ON DELETE CASCADE,
  request_id          uuid NOT NULL REFERENCES requests (id) ON DELETE CASCADE,
  stage               text NOT NULL CHECK (stage IN (
                        'draft_pending', 'send_pending', 'draft_approved',
                        'pending_connection', 'queued', 'sent', 'replied',
                        'declined', 'changes_requested', 'suppressed'
                      )),
  last_outreach_at    timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT partner_engagements_candidate_unique
    UNIQUE (workspace_id, agent_id, candidate_id),
  CONSTRAINT partner_engagements_request_unique UNIQUE (workspace_id, request_id)
);
CREATE INDEX IF NOT EXISTS partner_engagements_stage_idx
  ON partner_engagements (workspace_id, agent_id, stage, updated_at DESC);
DROP TRIGGER IF EXISTS partner_engagements_updated_at ON partner_engagements;
CREATE TRIGGER partner_engagements_updated_at BEFORE UPDATE ON partner_engagements
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS outbound_email_accounts (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  provider            text NOT NULL CHECK (provider = 'gmail'),
  address             text NOT NULL CHECK (address = lower(address) AND length(address) BETWEEN 3 AND 320),
  status              text NOT NULL DEFAULT 'disconnected'
                        CHECK (status IN ('disconnected', 'connected', 'error', 'revoked')),
  ciphertext          bytea,
  iv                  bytea,
  wrapped_dek         bytea,
  wrap_iv             bytea,
  kek_version         integer,
  scope               text,
  token_expires_at    timestamptz,
  watch_expires_at    timestamptz,
  history_id          text,
  connected_by        uuid REFERENCES users (id) ON DELETE SET NULL,
  last_error          text,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outbound_email_accounts_workspace_address UNIQUE (workspace_id, address),
  CONSTRAINT outbound_email_accounts_secret_shape CHECK (
    status <> 'connected' OR (
      ciphertext IS NOT NULL AND iv IS NOT NULL AND wrapped_dek IS NOT NULL
      AND wrap_iv IS NOT NULL AND kek_version IS NOT NULL
    )
  )
);
DROP TRIGGER IF EXISTS outbound_email_accounts_updated_at ON outbound_email_accounts;
CREATE TRIGGER outbound_email_accounts_updated_at BEFORE UPDATE ON outbound_email_accounts
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS outbound_email_outbox (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id           uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  request_id             uuid NOT NULL REFERENCES requests (id) ON DELETE CASCADE,
  authorization_revision integer NOT NULL CHECK (authorization_revision > 0),
  authorization_hash     text NOT NULL CHECK (authorization_hash ~ '^sha256:[0-9a-f]{64}$'),
  candidate_id           uuid REFERENCES partner_candidates (id) ON DELETE SET NULL,
  account_id             uuid REFERENCES outbound_email_accounts (id) ON DELETE SET NULL,
  recipient_index        integer NOT NULL CHECK (recipient_index >= 0),
  sender_address         text NOT NULL CHECK (sender_address = lower(sender_address)),
  recipient_name         text NOT NULL,
  recipient_address      text NOT NULL CHECK (recipient_address = lower(recipient_address)),
  subject                text NOT NULL,
  body                   text NOT NULL,
  state                  text NOT NULL CHECK (state IN (
                           'pending_connection', 'queued', 'sending',
                           'sent', 'failed', 'ambiguous', 'cancelled'
                         )),
  provider_draft_id      text,
  provider_message_id    text,
  provider_thread_id     text,
  provider_response      jsonb,
  attempt_count          integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  last_error             text,
  sent_at                timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT outbound_email_outbox_exact_revision UNIQUE (
    workspace_id, request_id, authorization_revision, authorization_hash, recipient_index
  )
);
CREATE INDEX IF NOT EXISTS outbound_email_outbox_state_idx
  ON outbound_email_outbox (workspace_id, state, created_at);
DROP TRIGGER IF EXISTS outbound_email_outbox_updated_at ON outbound_email_outbox;
CREATE TRIGGER outbound_email_outbox_updated_at BEFORE UPDATE ON outbound_email_outbox
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS contact_suppressions (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  address             text NOT NULL CHECK (address = lower(address) AND length(address) BETWEEN 3 AND 320),
  reason              text NOT NULL CHECK (reason IN ('unsubscribe', 'bounce', 'complaint', 'manual')),
  source_message_id   text,
  created_by          uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT contact_suppressions_workspace_address UNIQUE (workspace_id, address)
);

ALTER TABLE partner_engagements ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_engagements FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON partner_engagements;
CREATE POLICY tenant_isolation ON partner_engagements
  USING (workspace_id = app_workspace_id()) WITH CHECK (workspace_id = app_workspace_id());

ALTER TABLE outbound_email_accounts ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbound_email_accounts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON outbound_email_accounts;
CREATE POLICY tenant_isolation ON outbound_email_accounts
  USING (workspace_id = app_workspace_id()) WITH CHECK (workspace_id = app_workspace_id());

ALTER TABLE outbound_email_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbound_email_outbox FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON outbound_email_outbox;
CREATE POLICY tenant_isolation ON outbound_email_outbox
  USING (workspace_id = app_workspace_id()) WITH CHECK (workspace_id = app_workspace_id());

ALTER TABLE contact_suppressions ENABLE ROW LEVEL SECURITY;
ALTER TABLE contact_suppressions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON contact_suppressions;
CREATE POLICY tenant_isolation ON contact_suppressions
  USING (workspace_id = app_workspace_id()) WITH CHECK (workspace_id = app_workspace_id());

GRANT SELECT, INSERT, UPDATE ON partner_engagements TO app;
GRANT SELECT ON partner_engagements TO agent;
REVOKE INSERT, UPDATE, DELETE ON partner_engagements FROM agent;

GRANT SELECT, INSERT, UPDATE ON outbound_email_accounts, outbound_email_outbox TO app;
GRANT SELECT, INSERT, DELETE ON contact_suppressions TO app;
REVOKE ALL ON outbound_email_accounts, outbound_email_outbox, contact_suppressions FROM agent;
