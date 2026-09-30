-- 0081: an interrupted email send is uncertain, never resent (Quest audit H1).
--
-- The send job commits `sending` before it calls the provider. A job revived
-- after that point cannot know whether the provider accepted the message, so
-- it marks the row `ambiguous` and writes this audit kind instead of sending
-- again. Nothing else changes: `ambiguous` is already an outbox state.

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
  'outbound_email.ambiguous'
));
