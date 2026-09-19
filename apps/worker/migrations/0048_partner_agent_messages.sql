-- A governed, durable bridge between Enterprise handoffs and Hermes Bot Mode.
-- The signed/scoped handoff remains authoritative; this row records the exact
-- Bot Mode-compatible turn delivered to the recipient agent session.

CREATE TABLE IF NOT EXISTS partner_agent_messages (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  handoff_id            uuid NOT NULL,
  direction             text NOT NULL CHECK (direction = 'handoff_to_finance'),
  protocol              text NOT NULL CHECK (protocol = 'hermes-bot-mode/v1'),
  sender_agent_id       uuid NOT NULL,
  recipient_agent_id    uuid NOT NULL,
  sender_profile        text NOT NULL CHECK (sender_profile ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  recipient_profile     text NOT NULL CHECK (recipient_profile ~ '^[a-z0-9][a-z0-9_-]{0,63}$'),
  sender_display        text NOT NULL CHECK (char_length(sender_display) BETWEEN 1 AND 64),
  recipient_display     text NOT NULL CHECK (char_length(recipient_display) BETWEEN 1 AND 64),
  body                  text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 8000),
  wire_text             text NOT NULL CHECK (char_length(wire_text) BETWEEN 1 AND 10000),
  status                text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'delivered', 'failed')),
  recipient_session_id  uuid,
  recipient_run_id      uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  delivered_at          timestamptz,
  CONSTRAINT partner_agent_messages_handoff_fk FOREIGN KEY (workspace_id, handoff_id)
    REFERENCES partner_handoffs (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT partner_agent_messages_sender_fk FOREIGN KEY (workspace_id, sender_agent_id)
    REFERENCES agents (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT partner_agent_messages_recipient_fk FOREIGN KEY (workspace_id, recipient_agent_id)
    REFERENCES agents (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT partner_agent_messages_session_fk FOREIGN KEY (workspace_id, recipient_session_id)
    REFERENCES sessions (workspace_id, id) ON DELETE SET NULL,
  CONSTRAINT partner_agent_messages_run_fk FOREIGN KEY (workspace_id, recipient_run_id)
    REFERENCES runs (workspace_id, id) ON DELETE SET NULL,
  CONSTRAINT partner_agent_messages_distinct_agents CHECK (sender_agent_id <> recipient_agent_id),
  CONSTRAINT partner_agent_messages_delivery_key UNIQUE (workspace_id, handoff_id, direction)
);
CREATE INDEX IF NOT EXISTS partner_agent_messages_recipient_idx
  ON partner_agent_messages (workspace_id, recipient_agent_id, status, created_at DESC);

ALTER TABLE partner_agent_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_agent_messages FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON partner_agent_messages;
CREATE POLICY tenant_isolation ON partner_agent_messages
  USING (workspace_id = app_workspace_id())
  WITH CHECK (workspace_id = app_workspace_id());

GRANT SELECT, INSERT, UPDATE ON partner_agent_messages TO app;
REVOKE ALL ON partner_agent_messages FROM agent;
