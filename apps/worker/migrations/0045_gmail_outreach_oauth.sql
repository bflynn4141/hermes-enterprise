-- Single-use OAuth state for a dedicated Gmail outreach sender. Credentials
-- live in outbound_email_accounts under the existing envelope-encryption
-- boundary; this table contains only a digest and expires quickly.

CREATE TABLE IF NOT EXISTS gmail_oauth_states (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  requested_by    uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  state_digest    text NOT NULL CHECK (state_digest ~ '^[0-9a-f]{64}$'),
  redirect_uri    text NOT NULL,
  expires_at      timestamptz NOT NULL,
  consumed_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT gmail_oauth_states_digest_unique UNIQUE (state_digest)
);
CREATE INDEX IF NOT EXISTS gmail_oauth_states_pending_idx
  ON gmail_oauth_states (workspace_id, requested_by, expires_at)
  WHERE consumed_at IS NULL;

ALTER TABLE gmail_oauth_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE gmail_oauth_states FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON gmail_oauth_states;
CREATE POLICY tenant_isolation ON gmail_oauth_states
  USING (workspace_id = app_workspace_id()) WITH CHECK (workspace_id = app_workspace_id());

GRANT SELECT, INSERT, UPDATE ON gmail_oauth_states TO app;
REVOKE ALL ON gmail_oauth_states FROM agent;

ALTER TABLE events DROP CONSTRAINT IF EXISTS events_kind_check;
ALTER TABLE events ADD CONSTRAINT events_kind_check CHECK (kind IN (
  'decision.recorded', 'request.created', 'effect.assigned', 'effect.executed', 'effect.cancelled',
  'document.created', 'document.versioned', 'member.invited', 'member.joined', 'member.role_changed',
  'member.removed', 'agent.joined', 'instruction.saved', 'instruction.proposed', 'context.set', 'settings.changed',
  'session.shared', 'session.unshared', 'provider_key.added', 'provider_key.verified',
  'provider_key.revoked', 'workspace.created', 'workspace.deletion_scheduled', 'subject.redacted',
  'run.errored', 'usage.cap_warning', 'workspace.deletion_cancelled', 'workspace.deleted',
  'provider_key.attested', 'provider_key.rewrapped', 'validator.failed',
  'approval.proposed', 'approval.vote_recorded', 'approval.revised', 'approval.routed',
  'approval.finalized', 'approval.expired', 'slack.connected', 'slack.disconnected',
  'slack.credential_rewrapped', 'run.retried', 'run.retry_cancelled',
  'gmail.connected', 'outbound_email.sent'
));
