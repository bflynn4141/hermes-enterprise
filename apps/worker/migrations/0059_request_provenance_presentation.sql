-- 0059_request_provenance_presentation.sql
-- Honest request origin plus reversible, per-member Inbox organization.
--
-- Origin is intentionally separate from model-authored request payloads. Every
-- request receives an immutable `unknown` row, then only database relations
-- that already carry explicit provenance may refine it to sample/operational.
-- Titles, names and model guesses never classify a record.
--
-- Hiding is presentation state for one member. It does not update the request,
-- approval, audience, decision or workflow, and another reviewer cannot see or
-- change it. A restore keeps the prior reason and an audit event.

CREATE TABLE IF NOT EXISTS request_provenance (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  request_id   uuid PRIMARY KEY REFERENCES requests (id) ON DELETE CASCADE,
  kind         text NOT NULL DEFAULT 'unknown'
                 CHECK (kind IN ('operational', 'sample', 'test', 'unknown')),
  source       text NOT NULL DEFAULT 'not_recorded'
                 CHECK (char_length(source) BETWEEN 1 AND 80),
  recorded_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT request_provenance_request_fk
    FOREIGN KEY (workspace_id, request_id) REFERENCES requests (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS request_provenance_workspace_kind_idx
  ON request_provenance (workspace_id, kind, request_id);

CREATE TABLE IF NOT EXISTS request_presentations (
  workspace_id  uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  request_id    uuid NOT NULL REFERENCES requests (id) ON DELETE CASCADE,
  user_id       uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  hidden_at     timestamptz,
  hidden_reason text CHECK (hidden_reason IS NULL OR char_length(hidden_reason) BETWEEN 5 AND 500),
  restored_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (request_id, user_id),
  CONSTRAINT request_presentations_request_fk
    FOREIGN KEY (workspace_id, request_id) REFERENCES requests (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS request_presentations_active_idx
  ON request_presentations (workspace_id, user_id, request_id) WHERE hidden_at IS NOT NULL;

-- Backfill every historical request as unknown first. The two updates below
-- refine only rows linked by explicit, server-owned provenance relations.
INSERT INTO request_provenance (workspace_id, request_id, kind, source)
SELECT workspace_id, id, 'unknown', 'legacy_unclassified' FROM requests
ON CONFLICT (request_id) DO NOTHING;

UPDATE request_provenance provenance
   SET kind='sample', source='onboarding_sample_run', recorded_at=now()
  FROM onboarding_sample_applications sample
 WHERE sample.workspace_id=provenance.workspace_id
   AND sample.request_id=provenance.request_id;

UPDATE request_provenance provenance
   SET kind=CASE handoff.input_provenance WHEN 'customer' THEN 'operational' ELSE 'sample' END,
       source=CASE handoff.input_provenance WHEN 'customer' THEN 'partner_workflow_customer' ELSE 'partner_workflow_sample' END,
       recorded_at=now()
  FROM partner_workflow_executions execution
  JOIN partner_handoffs handoff
    ON handoff.workspace_id=execution.workspace_id AND handoff.id=execution.handoff_id
 WHERE execution.workspace_id=provenance.workspace_id
   AND execution.request_id=provenance.request_id
   AND handoff.input_provenance IN ('sample', 'customer');

UPDATE request_provenance provenance
   SET kind=CASE source_authorization.input_provenance WHEN 'customer' THEN 'operational' ELSE 'sample' END,
       source=CASE source_authorization.input_provenance WHEN 'customer' THEN 'partner_workflow_customer' ELSE 'partner_workflow_sample' END,
       recorded_at=now()
  FROM partner_engagement_authorizations source_authorization
 WHERE source_authorization.workspace_id=provenance.workspace_id
   AND source_authorization.approval_request_id=provenance.request_id;

ALTER TABLE request_provenance ENABLE ROW LEVEL SECURITY;
ALTER TABLE request_provenance FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON request_provenance;
CREATE POLICY tenant_isolation ON request_provenance
  USING (workspace_id=app_workspace_id()) WITH CHECK (workspace_id=app_workspace_id());

ALTER TABLE request_presentations ENABLE ROW LEVEL SECURITY;
ALTER TABLE request_presentations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON request_presentations;
CREATE POLICY tenant_isolation ON request_presentations
  USING (workspace_id=app_workspace_id() AND user_id=app_user_id())
  WITH CHECK (workspace_id=app_workspace_id() AND user_id=app_user_id());

GRANT SELECT ON request_provenance TO app;
GRANT SELECT, INSERT, UPDATE ON request_presentations TO app;
REVOKE ALL ON request_provenance, request_presentations FROM agent;

CREATE OR REPLACE FUNCTION record_unknown_request_provenance() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  INSERT INTO request_provenance (workspace_id, request_id, kind, source)
  VALUES (NEW.workspace_id, NEW.id, 'unknown', 'not_recorded')
  ON CONFLICT (request_id) DO NOTHING;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS requests_record_provenance ON requests;
CREATE TRIGGER requests_record_provenance
  AFTER INSERT ON requests FOR EACH ROW EXECUTE FUNCTION record_unknown_request_provenance();

CREATE OR REPLACE FUNCTION record_onboarding_sample_provenance() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  IF NEW.request_id IS NOT NULL THEN
    INSERT INTO request_provenance (workspace_id, request_id, kind, source, recorded_at)
    VALUES (NEW.workspace_id, NEW.request_id, 'sample', 'onboarding_sample_run', now())
    ON CONFLICT (request_id) DO UPDATE
      SET kind='sample', source='onboarding_sample_run', recorded_at=now();
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS onboarding_sample_request_provenance ON onboarding_sample_applications;
CREATE TRIGGER onboarding_sample_request_provenance
  AFTER INSERT OR UPDATE OF request_id ON onboarding_sample_applications
  FOR EACH ROW EXECUTE FUNCTION record_onboarding_sample_provenance();

CREATE OR REPLACE FUNCTION record_partner_handoff_request_provenance() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE explicit_kind text;
BEGIN
  IF NEW.request_id IS NULL THEN RETURN NEW; END IF;
  SELECT input_provenance INTO explicit_kind
    FROM partner_handoffs
   WHERE workspace_id=NEW.workspace_id AND id=NEW.handoff_id;
  IF explicit_kind IN ('sample', 'customer') THEN
    INSERT INTO request_provenance (workspace_id, request_id, kind, source, recorded_at)
    VALUES (
      NEW.workspace_id,
      NEW.request_id,
      CASE explicit_kind WHEN 'customer' THEN 'operational' ELSE 'sample' END,
      CASE explicit_kind WHEN 'customer' THEN 'partner_workflow_customer' ELSE 'partner_workflow_sample' END,
      now()
    )
    ON CONFLICT (request_id) DO UPDATE SET
      kind=EXCLUDED.kind, source=EXCLUDED.source, recorded_at=now();
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS partner_handoff_request_provenance ON partner_workflow_executions;
CREATE TRIGGER partner_handoff_request_provenance
  AFTER INSERT OR UPDATE OF request_id ON partner_workflow_executions
  FOR EACH ROW EXECUTE FUNCTION record_partner_handoff_request_provenance();

CREATE OR REPLACE FUNCTION record_partner_engagement_request_provenance() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
BEGIN
  INSERT INTO request_provenance (workspace_id, request_id, kind, source, recorded_at)
  VALUES (
    NEW.workspace_id,
    NEW.approval_request_id,
    CASE NEW.input_provenance WHEN 'customer' THEN 'operational' ELSE 'sample' END,
    CASE NEW.input_provenance WHEN 'customer' THEN 'partner_workflow_customer' ELSE 'partner_workflow_sample' END,
    now()
  )
  ON CONFLICT (request_id) DO UPDATE SET
    kind=EXCLUDED.kind, source=EXCLUDED.source, recorded_at=now();
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS partner_engagement_request_provenance ON partner_engagement_authorizations;
CREATE TRIGGER partner_engagement_request_provenance
  AFTER INSERT ON partner_engagement_authorizations
  FOR EACH ROW EXECUTE FUNCTION record_partner_engagement_request_provenance();

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
  'partner.invoice_corrected', 'partner.decision_acknowledged'
));
