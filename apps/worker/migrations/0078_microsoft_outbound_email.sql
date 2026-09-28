-- 0078: a Microsoft 365 / Outlook sending account beside Gmail (decision C99).
--
-- An approved email goes out from the workspace's connected sending account.
-- Until now that could only be Gmail. A Microsoft account is the same kind of
-- row: one per address, its token sealed under the same envelope boundary
-- (0043), and the outbox still matches an approved email to an account by the
-- exact sender address the approval named, so a person can never approve one
-- sender and have mail leave from another.
--
-- The single-use OAuth state table (0045) records which provider a state was
-- issued for, so a Google callback cannot consume a Microsoft state or the
-- reverse. Its name stays; a migration never renames a table another release
-- still reads.

ALTER TABLE outbound_email_accounts DROP CONSTRAINT IF EXISTS outbound_email_accounts_provider_check;
ALTER TABLE outbound_email_accounts ADD CONSTRAINT outbound_email_accounts_provider_check
  CHECK (provider IN ('gmail', 'microsoft'));

ALTER TABLE gmail_oauth_states
  ADD COLUMN IF NOT EXISTS provider text NOT NULL DEFAULT 'gmail';
ALTER TABLE gmail_oauth_states DROP CONSTRAINT IF EXISTS gmail_oauth_states_provider_check;
ALTER TABLE gmail_oauth_states ADD CONSTRAINT gmail_oauth_states_provider_check
  CHECK (provider IN ('gmail', 'microsoft'));

-- The audit kind connecting a Microsoft sending account writes.
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
  'email_handoff.completed', 'email_triage.retried', 'microsoft_mail.connected'
));
