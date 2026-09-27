-- 0076: role inboxes that receive forwarded email (decision C98).
--
-- A workspace gives a role an address such as partners-k3v9q2m7@in.example.
-- People forward or route mail there; Cloudflare Email Routing hands each
-- message to the Worker's email() handler, which stores it here, records what
-- the server verified about the sender, and asks the inbox's agent for
-- suggestions. The agent only ever proposes. Replies go through the existing
-- revision-bound outbox after a person approves them.
--
-- Four things:
--
--   email_inboxes            one row per role address, owned by one agent.
--   email_inbox_directory    address → workspace, for the email() handler,
--                            which has no URL to take a workspace from. Same
--                            directory pattern as 0014 and 0025: no RLS, no
--                            tenant data, SELECT for `app` only, kept by a
--                            trigger, so a paused or deleted inbox stops
--                            resolving at once.
--   inbound_email_messages   the received message, already sanitized. The
--                            content columns are immutable to `app`; only the
--                            triage status moves. Deleting the inbox deletes its
--                            messages: disconnecting removes the copies.
--   outbound_email_outbox    gains the threading headers of the message a reply
--                            answers, and a `simulated` state for environments
--                            whose executor mode is simulated (D12). Approval
--                            effects gain `simulated` for the same reason.

CREATE TABLE IF NOT EXISTS email_inboxes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  role_slug     text NOT NULL,
  agent_id      uuid NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  address       text NOT NULL CHECK (address = lower(address) AND address ~ '^[a-z0-9][a-z0-9._-]{2,63}@[a-z0-9.-]{3,253}$'),
  label         text NOT NULL CHECK (char_length(label) BETWEEN 1 AND 120),
  status        text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused')),
  created_by    uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT email_inboxes_address_key UNIQUE (address),
  CONSTRAINT email_inboxes_workspace_id_key UNIQUE (workspace_id, id),
  CONSTRAINT email_inboxes_role_fkey FOREIGN KEY (workspace_id, role_slug)
    REFERENCES workspace_roles (workspace_id, slug) ON UPDATE CASCADE
);
CREATE INDEX IF NOT EXISTS email_inboxes_workspace_idx ON email_inboxes (workspace_id, created_at);
DROP TRIGGER IF EXISTS email_inboxes_updated_at ON email_inboxes;
CREATE TRIGGER email_inboxes_updated_at BEFORE UPDATE ON email_inboxes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- `target_workspace_id`, not `workspace_id`, as in slack_installation_directory
-- (0025): a platform table must not look like a tenant table to 0003's check.
CREATE TABLE IF NOT EXISTS email_inbox_directory (
  address             text PRIMARY KEY,
  inbox_id            uuid NOT NULL UNIQUE REFERENCES email_inboxes (id) ON DELETE CASCADE,
  target_workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE
);

CREATE OR REPLACE FUNCTION email_inbox_directory_sync() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
  AS $$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      DELETE FROM email_inbox_directory WHERE inbox_id = OLD.id;
      RETURN OLD;
    END IF;
    DELETE FROM email_inbox_directory WHERE inbox_id = NEW.id;
    IF NEW.status = 'active' THEN
      INSERT INTO email_inbox_directory (address, inbox_id, target_workspace_id)
      VALUES (NEW.address, NEW.id, NEW.workspace_id)
      ON CONFLICT (address) DO UPDATE SET inbox_id = EXCLUDED.inbox_id,
                                          target_workspace_id = EXCLUDED.target_workspace_id;
    END IF;
    RETURN NEW;
  END $$;

DROP TRIGGER IF EXISTS email_inboxes_directory_sync ON email_inboxes;
CREATE TRIGGER email_inboxes_directory_sync AFTER INSERT OR UPDATE OR DELETE ON email_inboxes
  FOR EACH ROW EXECUTE FUNCTION email_inbox_directory_sync();

GRANT SELECT ON email_inbox_directory TO app;
REVOKE ALL ON email_inbox_directory FROM agent;

-- `lookup_address`, not `address`: an unqualified parameter named like a
-- column resolves to the column (see 0013), and the predicate would match
-- every row.
CREATE OR REPLACE FUNCTION hermes_email_inbox(lookup_address text)
  RETURNS TABLE (workspace_id uuid, inbox_id uuid)
  LANGUAGE sql
  STABLE
  AS $$
    SELECT d.target_workspace_id, d.inbox_id FROM email_inbox_directory d
     WHERE d.address = lower(lookup_address) LIMIT 1
  $$;
GRANT EXECUTE ON FUNCTION hermes_email_inbox(text) TO app;

CREATE TABLE IF NOT EXISTS inbound_email_messages (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  inbox_id        uuid NOT NULL,
  raw_sha256      text NOT NULL CHECK (raw_sha256 ~ '^[0-9a-f]{64}$'),
  raw_size        integer NOT NULL CHECK (raw_size >= 0),
  message_id      text CHECK (message_id IS NULL OR char_length(message_id) <= 998),
  in_reply_to     text CHECK (in_reply_to IS NULL OR char_length(in_reply_to) <= 998),
  references_header text CHECK (references_header IS NULL OR char_length(references_header) <= 8000),
  subject         text NOT NULL DEFAULT '' CHECK (char_length(subject) <= 998),
  from_address    text NOT NULL CHECK (from_address = lower(from_address) AND length(from_address) BETWEEN 3 AND 320),
  from_name       text CHECK (from_name IS NULL OR char_length(from_name) <= 200),
  to_addresses    text[] NOT NULL DEFAULT '{}',
  cc_addresses    text[] NOT NULL DEFAULT '{}',
  sender_facts    jsonb NOT NULL,
  body            jsonb NOT NULL,
  attachments     jsonb NOT NULL DEFAULT '[]'::jsonb,
  received_at     timestamptz NOT NULL DEFAULT now(),
  status          text NOT NULL DEFAULT 'received'
                  CHECK (status IN ('received', 'triaging', 'suggested', 'no_action', 'failed')),
  triage_run_id   uuid REFERENCES runs (id) ON DELETE SET NULL,
  triage_error    text CHECK (triage_error IS NULL OR char_length(triage_error) <= 500),
  request_ids     uuid[] NOT NULL DEFAULT '{}',
  CONSTRAINT inbound_email_messages_inbox_fkey FOREIGN KEY (workspace_id, inbox_id)
    REFERENCES email_inboxes (workspace_id, id) ON DELETE CASCADE,
  -- Cloudflare may deliver the same message twice; the second is a no-op.
  CONSTRAINT inbound_email_messages_raw_key UNIQUE (workspace_id, inbox_id, raw_sha256),
  CONSTRAINT inbound_email_messages_workspace_id_key UNIQUE (workspace_id, id)
);
CREATE INDEX IF NOT EXISTS inbound_email_messages_inbox_idx
  ON inbound_email_messages (workspace_id, inbox_id, received_at DESC);
CREATE INDEX IF NOT EXISTS inbound_email_messages_sender_idx
  ON inbound_email_messages (workspace_id, from_address);
CREATE UNIQUE INDEX IF NOT EXISTS inbound_email_messages_triage_run_key
  ON inbound_email_messages (triage_run_id) WHERE triage_run_id IS NOT NULL;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY['email_inboxes', 'inbound_email_messages'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (workspace_id = app_workspace_id()) WITH CHECK (workspace_id = app_workspace_id())',
      table_name
    );
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON email_inboxes TO app;
GRANT SELECT, INSERT ON inbound_email_messages TO app;
-- Only the triage bookkeeping moves after intake. The message a reviewer sees
-- is the message the agent read.
GRANT UPDATE (status, triage_run_id, triage_error, request_ids) ON inbound_email_messages TO app;
REVOKE ALL ON email_inboxes, inbound_email_messages FROM agent;

ALTER TABLE outbound_email_outbox
  ADD COLUMN IF NOT EXISTS inbound_message_id uuid,
  ADD COLUMN IF NOT EXISTS in_reply_to text CHECK (in_reply_to IS NULL OR char_length(in_reply_to) <= 998),
  ADD COLUMN IF NOT EXISTS references_header text CHECK (references_header IS NULL OR char_length(references_header) <= 8000);
DO $$ BEGIN
  ALTER TABLE outbound_email_outbox ADD CONSTRAINT outbound_email_outbox_inbound_message_fkey
    FOREIGN KEY (workspace_id, inbound_message_id)
    REFERENCES inbound_email_messages (workspace_id, id) ON DELETE SET NULL (inbound_message_id);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE outbound_email_outbox DROP CONSTRAINT IF EXISTS outbound_email_outbox_state_check;
ALTER TABLE outbound_email_outbox ADD CONSTRAINT outbound_email_outbox_state_check CHECK (state IN (
  'pending_connection', 'queued', 'sending', 'sent', 'simulated', 'failed', 'ambiguous', 'cancelled'
));

ALTER TABLE approval_requests DROP CONSTRAINT IF EXISTS approval_requests_effect_status_check;
ALTER TABLE approval_requests ADD CONSTRAINT approval_requests_effect_status_check CHECK (effect_status IN (
  'not_required', 'waiting', 'unavailable', 'executed', 'simulated', 'failed', 'cancelled'
));

-- The audit kinds this feature writes. Ids and kinds only, never addresses or
-- message text (CONVENTIONS: `events` rows hold ids and enum kinds).
ALTER TABLE events DROP CONSTRAINT IF EXISTS events_kind_check;
ALTER TABLE events ADD CONSTRAINT events_kind_check CHECK (kind IN (
  'decision.recorded', 'request.created', 'request.hidden', 'request.restored',
  'effect.assigned', 'effect.executed', 'effect.cancelled',
  'document.created', 'document.versioned', 'member.invited', 'member.joined', 'member.role_changed',
  'member.removed', 'agent.joined', 'instruction.saved', 'instruction.proposed', 'context.set', 'settings.changed',
  'session.shared', 'session.unshared', 'provider_key.added', 'provider_key.verified',
  'provider_key.revoked', 'workspace.created', 'workspace.deletion_scheduled', 'subject.redacted',
  'run.errored', 'usage.cap_warning', 'workspace.deletion_cancelled', 'workspace.deleted',
  'provider_key.attested', 'provider_key.rewrapped', 'validator.failed',
  'approval.proposed', 'approval.vote_recorded', 'approval.revised', 'approval.routed',
  'approval.finalized', 'approval.expired', 'slack.connected', 'slack.disconnected',
  'slack.credential_rewrapped', 'run.retried', 'run.retry_cancelled',
  'gmail.connected', 'outbound_email.sent', 'partner.invoice_received',
  'partner.invoice_corrected', 'partner.decision_acknowledged',
  'email_inbox.created', 'email_inbox.removed', 'inbound_email.received', 'outbound_email.simulated',
  'email_handoff.completed'
));

-- A run that reads a received email runs in `intake` mode: the suggestion
-- tools and nothing that can reach the outside world (engine/tools.ts,
-- INTAKE_TOOL_NAMES). Sessions keep their three modes; only the run differs.
ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_mode_check;
ALTER TABLE runs ADD CONSTRAINT runs_mode_check CHECK (mode IS NULL OR mode IN ('ask', 'plan', 'work', 'intake'));
