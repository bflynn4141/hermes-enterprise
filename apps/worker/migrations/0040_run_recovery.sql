-- Recovery is app-owned admission, never an instruction to replay tool effects.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS recovery_next_at timestamptz;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS recovery_not_before timestamptz;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS recovery_cancelled boolean NOT NULL DEFAULT false;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS recovery_blocked_reason text;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS recovery_input text;
-- Preserve attempt/model provenance before changing the current attempt.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS recovery_history jsonb NOT NULL DEFAULT '[]'::jsonb;

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
  'slack.credential_rewrapped', 'run.retried', 'run.retry_cancelled'
));
