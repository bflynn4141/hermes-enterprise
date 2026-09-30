-- 0082: a person settles an uncertain email send (Quest audit H1, follows 0081).
--
-- After checking the mailbox, a reviewer says the email was sent or was not.
-- "Sent" records it as sent on the reviewer's word. "Not sent" cancels the
-- row and reopens the approval, so the email's reviewers approve it again
-- before anything goes out; the first approval was spent on the attempt.
-- Who settled it and when stays on the row next to the provider's own fields.

ALTER TABLE outbound_email_outbox
  ADD COLUMN IF NOT EXISTS settled_outcome text,
  ADD COLUMN IF NOT EXISTS settled_by uuid REFERENCES users (id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS settled_at timestamptz;
ALTER TABLE outbound_email_outbox DROP CONSTRAINT IF EXISTS outbound_email_outbox_settled_check;
ALTER TABLE outbound_email_outbox ADD CONSTRAINT outbound_email_outbox_settled_check CHECK (
  (settled_outcome IS NULL AND settled_at IS NULL)
  OR (settled_outcome = 'sent' AND state = 'sent' AND settled_at IS NOT NULL)
  OR (settled_outcome = 'not_sent' AND state = 'cancelled' AND settled_at IS NOT NULL)
);

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
  'email_handoff.completed', 'email_triage.retried', 'microsoft_mail.connected',
  'outbound_email.ambiguous', 'outbound_email.settled_sent', 'outbound_email.settled_not_sent'
));
