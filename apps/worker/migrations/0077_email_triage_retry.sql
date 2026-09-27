-- 0077: retrying a received email's triage (decision C98).
--
-- An intake run can fail for reasons that heal, most often the model provider
-- rate-limiting the agent. Until now the message then read `failed` for good:
-- the triage job had already done its one job, and a second run for the same
-- message would have been refused as a duplicate turn.
--
-- `triage_attempt` numbers each try. The triage job's key and the run's client
-- turn id both carry it, so a retry is a fresh job and a fresh run while a
-- repeated click or Cron pass for the same attempt stays a no-op. The app role
-- already updates status, triage_run_id and triage_error (0076); it gains only
-- this counter. Content columns stay immutable.

ALTER TABLE inbound_email_messages
  ADD COLUMN IF NOT EXISTS triage_attempt integer NOT NULL DEFAULT 1;
ALTER TABLE inbound_email_messages DROP CONSTRAINT IF EXISTS inbound_email_messages_triage_attempt_check;
ALTER TABLE inbound_email_messages ADD CONSTRAINT inbound_email_messages_triage_attempt_check
  CHECK (triage_attempt BETWEEN 1 AND 1000);

GRANT UPDATE (triage_attempt) ON inbound_email_messages TO app;

-- The audit kind a retry writes, by a person or by the automatic backoff.
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
  'email_handoff.completed', 'email_triage.retried'
));
