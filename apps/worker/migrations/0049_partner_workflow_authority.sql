-- Exact engagement authority, immutable invoice intake, correction lineage,
-- orthogonal outcomes and a minimal return acknowledgment. New admission is
-- disabled by default; historical rows stay readable during rollout.

INSERT INTO enterprise_skill_artifacts (skill_key, skill_version, digest, manifest) VALUES
  ('partner-program-screening', '1.8.0',
   'sha256:281bbfff95d40e202c3ced5d1cb30ebf432868bee100d0c2a647faa40757a9e5',
   '{"runtime_name":"enterprise_bridge:partner-program-screening-v1-8","role_template":"partnerships-agent","required_capabilities":["partner.discovery.read","partner.review.prepare","partner.outreach.draft","partner.records.qualification.write","partner.handoff.publish"]}'::jsonb),
  ('partner-invoice-review', '1.0.1',
   'sha256:bdb13d70f7a603f92eb47fc2d1c057c82f26658e61df8cf357790f23875753e4',
   '{"runtime_name":"enterprise_bridge:partner-invoice-review","role_template":"finance-agent","required_capabilities":["partner.shared.read","partner.invoice.read","partner.invoice.review.prepare"]}'::jsonb)
ON CONFLICT (skill_key, skill_version) DO NOTHING;

CREATE TABLE IF NOT EXISTS partner_workflow_settings (
  workspace_id    uuid PRIMARY KEY REFERENCES workspaces (id) ON DELETE CASCADE,
  admission_state text NOT NULL DEFAULT 'disabled'
                  CHECK (admission_state IN ('disabled', 'enabled')),
  enabled_by      uuid REFERENCES users (id) ON DELETE SET NULL,
  enabled_at      timestamptz,
  readiness       jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(readiness) = 'object'),
  readiness_checked_at timestamptz,
  updated_at      timestamptz NOT NULL DEFAULT now()
);
DROP TRIGGER IF EXISTS partner_workflow_settings_updated_at ON partner_workflow_settings;
CREATE TRIGGER partner_workflow_settings_updated_at BEFORE UPDATE ON partner_workflow_settings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS partner_record_revisions (
  workspace_id      uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  record_id         uuid NOT NULL,
  revision          integer NOT NULL CHECK (revision > 0),
  data              jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  evidence_ids      text[] NOT NULL DEFAULT '{}',
  source_session_id uuid NOT NULL,
  source_run_id     uuid NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (record_id, revision),
  CONSTRAINT partner_record_revisions_record_fk FOREIGN KEY (workspace_id, record_id)
    REFERENCES partner_records (workspace_id, id) ON DELETE CASCADE
);
CREATE OR REPLACE FUNCTION capture_partner_record_revision()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO partner_record_revisions
    (workspace_id,record_id,revision,data,evidence_ids,source_session_id,source_run_id,created_at)
  VALUES
    (NEW.workspace_id,NEW.id,NEW.revision,NEW.data,NEW.evidence_ids,
     NEW.source_session_id,NEW.source_run_id,COALESCE(NEW.updated_at,NEW.created_at,now()))
  ON CONFLICT (record_id,revision) DO NOTHING;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS partner_records_capture_revision ON partner_records;
CREATE TRIGGER partner_records_capture_revision AFTER INSERT OR UPDATE ON partner_records
  FOR EACH ROW EXECUTE FUNCTION capture_partner_record_revision();
INSERT INTO partner_record_revisions
  (workspace_id,record_id,revision,data,evidence_ids,source_session_id,source_run_id,created_at)
SELECT workspace_id,id,revision,data,evidence_ids,source_session_id,source_run_id,updated_at
  FROM partner_records
ON CONFLICT (record_id,revision) DO NOTHING;

-- A correction is a new immutable source assertion for the same invoice
-- identity. The source session/run therefore advance with the row revision;
-- tenant/team/owner/kind/partner/idempotency remain immutable.
CREATE OR REPLACE FUNCTION enforce_partner_record_revision()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.workspace_id <> OLD.workspace_id OR NEW.team_id <> OLD.team_id
     OR NEW.owner_agent_id <> OLD.owner_agent_id OR NEW.kind <> OLD.kind
     OR NEW.partner_id <> OLD.partner_id OR NEW.idempotency_key <> OLD.idempotency_key THEN
    RAISE EXCEPTION 'partner record identity is immutable';
  END IF;
  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'partner record revision must increase by one';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;

CREATE TABLE IF NOT EXISTS partner_engagement_authorizations (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id               uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  approval_request_id        uuid NOT NULL REFERENCES requests (id) ON DELETE RESTRICT,
  authorization_revision     integer NOT NULL CHECK (authorization_revision > 0),
  authorization_hash         text NOT NULL CHECK (authorization_hash ~ '^sha256:[0-9a-f]{64}$'),
  input_provenance           text NOT NULL CHECK (input_provenance IN ('sample','customer')),
  reviewer_user_id           uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  engagement_record_id       uuid,
  partner_id                 uuid NOT NULL,
  partner_name               text NOT NULL CHECK (char_length(partner_name) BETWEEN 1 AND 200),
  engagement_reference       text NOT NULL CHECK (char_length(engagement_reference) BETWEEN 1 AND 200),
  purpose                    text NOT NULL CHECK (char_length(purpose) BETWEEN 1 AND 1000),
  currency                   text NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  authorized_total_minor     integer NOT NULL CHECK (authorized_total_minor BETWEEN 0 AND 1000000000),
  valid_from                 date NOT NULL,
  valid_until                date NOT NULL,
  one_invoice                boolean NOT NULL CHECK (one_invoice),
  permitted_evidence_excerpt text NOT NULL CHECK (char_length(permitted_evidence_excerpt) BETWEEN 1 AND 2000),
  source_attachment_id       uuid NOT NULL REFERENCES attachments (id) ON DELETE RESTRICT,
  source_sha256              text NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  source_name                text NOT NULL CHECK (char_length(source_name) BETWEEN 1 AND 255),
  source_created_at          timestamptz NOT NULL,
  source_author_name         text,
  source_session_id          uuid NOT NULL,
  source_run_id              uuid NOT NULL,
  status                     text NOT NULL DEFAULT 'pending'
                             CHECK (status IN ('pending','authorized','declined','withdrawn','revoked','expired','superseded','consumed')),
  consumed_handoff_id        uuid,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  authorized_at              timestamptz,
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT partner_engagement_authorizations_dates CHECK (valid_until >= valid_from),
  CONSTRAINT partner_engagement_authorizations_approval_key UNIQUE
    (workspace_id, approval_request_id, authorization_revision, authorization_hash),
  CONSTRAINT partner_engagement_authorizations_reference_key UNIQUE
    (workspace_id, partner_id, engagement_reference, authorization_hash),
  CONSTRAINT partner_engagement_authorizations_record_fk FOREIGN KEY (workspace_id, engagement_record_id)
    REFERENCES partner_records (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT partner_engagement_authorizations_source_session_fk FOREIGN KEY (workspace_id, source_session_id)
    REFERENCES sessions (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT partner_engagement_authorizations_source_run_fk FOREIGN KEY (workspace_id, source_run_id)
    REFERENCES runs (workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS partner_engagement_authorizations_record_idx
  ON partner_engagement_authorizations (workspace_id, engagement_record_id, status);
DROP TRIGGER IF EXISTS partner_engagement_authorizations_updated_at ON partner_engagement_authorizations;
CREATE TRIGGER partner_engagement_authorizations_updated_at BEFORE UPDATE ON partner_engagement_authorizations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE partner_handoffs
  ADD COLUMN IF NOT EXISTS revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  ADD COLUMN IF NOT EXISTS lineage_root_id uuid,
  ADD COLUMN IF NOT EXISTS supersedes_handoff_id uuid,
  ADD COLUMN IF NOT EXISTS superseded_by_handoff_id uuid,
  ADD COLUMN IF NOT EXISTS payload_hash text CHECK (payload_hash IS NULL OR payload_hash ~ '^sha256:[0-9a-f]{64}$'),
  ADD COLUMN IF NOT EXISTS input_provenance text
    CHECK (input_provenance IS NULL OR input_provenance IN ('sample','customer')),
  ADD COLUMN IF NOT EXISTS delivery_status text NOT NULL DEFAULT 'queued'
    CHECK (delivery_status IN ('queued','delivered','failed')),
  ADD COLUMN IF NOT EXISTS validation_status text NOT NULL DEFAULT 'queued'
    CHECK (validation_status IN ('queued','checking','passed','needs_information','stale','failed')),
  ADD COLUMN IF NOT EXISTS agent_explanation_status text NOT NULL DEFAULT 'queued'
    CHECK (agent_explanation_status IN ('queued','running','completed','failed','stopped')),
  ADD COLUMN IF NOT EXISTS human_decision_status text NOT NULL DEFAULT 'not_ready'
    CHECK (human_decision_status IN ('not_ready','pending','approved','declined','superseded')),
  ADD COLUMN IF NOT EXISTS acknowledgment_status text NOT NULL DEFAULT 'pending'
    CHECK (acknowledgment_status IN ('pending','delivered')),
  ADD COLUMN IF NOT EXISTS checks jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(checks) = 'array');
DO $$ BEGIN
  ALTER TABLE partner_handoffs ADD CONSTRAINT partner_handoffs_lineage_root_fk
    FOREIGN KEY (workspace_id, lineage_root_id) REFERENCES partner_handoffs (workspace_id, id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE partner_handoffs ADD CONSTRAINT partner_handoffs_supersedes_fk
    FOREIGN KEY (workspace_id, supersedes_handoff_id) REFERENCES partner_handoffs (workspace_id, id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE partner_handoffs ADD CONSTRAINT partner_handoffs_superseded_by_fk
    FOREIGN KEY (workspace_id, superseded_by_handoff_id) REFERENCES partner_handoffs (workspace_id, id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE partner_engagement_authorizations ADD CONSTRAINT partner_engagement_authorizations_consumed_handoff_fk
    FOREIGN KEY (workspace_id, consumed_handoff_id) REFERENCES partner_handoffs (workspace_id, id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE UNIQUE INDEX IF NOT EXISTS partner_handoffs_one_successor
  ON partner_handoffs (workspace_id, supersedes_handoff_id)
  WHERE supersedes_handoff_id IS NOT NULL;

-- Project already-finished historical handoffs into the additive dimensions.
-- Their caller-authored fields remain historical/read-only; no new admission
-- or authority is inferred from this projection.
UPDATE partner_handoffs
   SET delivery_status = CASE WHEN status='failed' THEN 'failed' ELSE 'delivered' END,
       validation_status = CASE status
         WHEN 'completed' THEN 'passed' WHEN 'needs_information' THEN 'needs_information'
         WHEN 'stale' THEN 'stale' WHEN 'failed' THEN 'failed' ELSE validation_status END,
       agent_explanation_status = CASE WHEN status IN ('completed','needs_information','stale') THEN 'completed'
                                       WHEN status='failed' THEN 'failed' ELSE agent_explanation_status END,
       human_decision_status = CASE WHEN status='completed' THEN 'pending' ELSE 'not_ready' END
 WHERE status IN ('completed','needs_information','stale','failed');

CREATE OR REPLACE FUNCTION project_partner_handoff_run_outcome(target_run_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE final_status text;
BEGIN
  SELECT status INTO final_status
    FROM runs
   WHERE workspace_id=app_workspace_id() AND id=target_run_id
     AND status IN ('completed','stopped','error')
   FOR SHARE;
  IF final_status IS NULL THEN RETURN; END IF;
  UPDATE partner_handoffs h
     SET agent_explanation_status=CASE final_status
       WHEN 'completed' THEN 'completed' WHEN 'stopped' THEN 'stopped' ELSE 'failed' END
    FROM partner_workflow_executions execution
   WHERE execution.workspace_id=app_workspace_id() AND execution.finance_run_id=target_run_id
     AND h.workspace_id=execution.workspace_id AND h.id=execution.handoff_id
     AND h.agent_explanation_status IN ('queued','running');
END
$$;
REVOKE ALL ON FUNCTION project_partner_handoff_run_outcome(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION project_partner_handoff_run_outcome(uuid) TO app,agent;

CREATE TABLE IF NOT EXISTS partner_invoice_intakes (
  id                              uuid PRIMARY KEY,
  workspace_id                    uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  handoff_id                      uuid NOT NULL,
  payload_hash                    text NOT NULL CHECK (payload_hash ~ '^sha256:[0-9a-f]{64}$'),
  input_provenance                text NOT NULL CHECK (input_provenance IN ('sample','customer')),
  engagement_record_id            uuid NOT NULL,
  expected_engagement_revision    integer NOT NULL CHECK (expected_engagement_revision > 0),
  expected_authorization_hash     text NOT NULL CHECK (expected_authorization_hash ~ '^sha256:[0-9a-f]{64}$'),
  invoice_source_attachment_id    uuid NOT NULL REFERENCES attachments (id) ON DELETE RESTRICT,
  invoice_source_sha256           text NOT NULL CHECK (invoice_source_sha256 ~ '^[0-9a-f]{64}$'),
  invoice_source_name             text NOT NULL CHECK (char_length(invoice_source_name) BETWEEN 1 AND 255),
  invoice_source_created_at       timestamptz NOT NULL,
  invoice_source_author_name      text,
  invoice_source_excerpt          text NOT NULL CHECK (char_length(invoice_source_excerpt) BETWEEN 1 AND 2000),
  invoice_payload                 jsonb NOT NULL CHECK (jsonb_typeof(invoice_payload) = 'object'),
  requested_by                    uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  source_session_id               uuid NOT NULL,
  source_run_id                   uuid NOT NULL,
  idempotency_key                 text NOT NULL,
  created_at                      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT partner_invoice_intakes_handoff_fk FOREIGN KEY (workspace_id, handoff_id)
    REFERENCES partner_handoffs (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT partner_invoice_intakes_engagement_fk FOREIGN KEY (workspace_id, engagement_record_id)
    REFERENCES partner_records (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT partner_invoice_intakes_source_session_fk FOREIGN KEY (workspace_id, source_session_id)
    REFERENCES sessions (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT partner_invoice_intakes_source_run_fk FOREIGN KEY (workspace_id, source_run_id)
    REFERENCES runs (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT partner_invoice_intakes_idempotency_key UNIQUE (workspace_id, requested_by, idempotency_key),
  CONSTRAINT partner_invoice_intakes_handoff_key UNIQUE (workspace_id, handoff_id)
);

CREATE OR REPLACE FUNCTION prevent_partner_invoice_intake_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'confirmed invoice intake is immutable';
END
$$;
DROP TRIGGER IF EXISTS partner_invoice_intakes_immutable ON partner_invoice_intakes;
CREATE TRIGGER partner_invoice_intakes_immutable BEFORE UPDATE OR DELETE ON partner_invoice_intakes
  FOR EACH ROW EXECUTE FUNCTION prevent_partner_invoice_intake_change();

CREATE TABLE IF NOT EXISTS partner_decision_acknowledgments (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id             uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  handoff_id               uuid NOT NULL,
  decision_id              uuid NOT NULL REFERENCES decisions (id) ON DELETE RESTRICT,
  partner_id               uuid NOT NULL,
  partner_name             text NOT NULL CHECK (char_length(partner_name) BETWEEN 1 AND 200),
  engagement_reference     text NOT NULL CHECK (char_length(engagement_reference) BETWEEN 1 AND 200),
  outcome                  text NOT NULL CHECK (outcome IN ('invoice_draft_saved','declined')),
  result_code              text NOT NULL CHECK (result_code IN ('approved','declined')),
  finance_reviewer_display text NOT NULL CHECK (char_length(finance_reviewer_display) BETWEEN 1 AND 120),
  recorded_at              timestamptz NOT NULL,
  delivery_status          text NOT NULL DEFAULT 'pending' CHECK (delivery_status IN ('pending','delivered')),
  delivered_at             timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT partner_decision_acknowledgments_handoff_fk FOREIGN KEY (workspace_id, handoff_id)
    REFERENCES partner_handoffs (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT partner_decision_acknowledgments_decision_key UNIQUE (workspace_id, decision_id),
  CONSTRAINT partner_decision_acknowledgments_handoff_key UNIQUE (workspace_id, handoff_id)
);
CREATE INDEX IF NOT EXISTS partner_decision_acknowledgments_delivery_idx
  ON partner_decision_acknowledgments (workspace_id, delivery_status, created_at);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'partner_workflow_settings', 'partner_record_revisions', 'partner_engagement_authorizations',
    'partner_invoice_intakes', 'partner_decision_acknowledgments'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (workspace_id = app_workspace_id()) WITH CHECK (workspace_id = app_workspace_id())',
      table_name
    );
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON partner_workflow_settings,
  partner_engagement_authorizations, partner_decision_acknowledgments TO app;
GRANT SELECT, INSERT ON partner_invoice_intakes, partner_record_revisions TO app;
REVOKE ALL ON partner_workflow_settings, partner_engagement_authorizations,
  partner_record_revisions, partner_invoice_intakes, partner_decision_acknowledgments FROM agent;

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
  'gmail.connected', 'outbound_email.sent', 'partner.invoice_received',
  'partner.invoice_corrected', 'partner.decision_acknowledged'
));
