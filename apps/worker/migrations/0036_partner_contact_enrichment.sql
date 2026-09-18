-- One shortlisted person per Hermes run may receive bounded professional
-- contact enrichment and email verification. Raw provider responses are never
-- stored: contact_data contains only professional emails, phones with type,
-- and trusted public social profile URLs.

CREATE TABLE IF NOT EXISTS partner_contact_enrichments (
  id                              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id                    uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  agent_id                        uuid NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  candidate_id                    uuid NOT NULL REFERENCES partner_candidates (id) ON DELETE CASCADE,
  run_id                          uuid NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  runtime_run_id                  text NOT NULL CHECK (runtime_run_id ~ '^run_[0-9a-f]{32}$'),
  status                          text NOT NULL DEFAULT 'enrichment_reserved'
                                  CHECK (status IN (
                                    'enrichment_reserved', 'enriched', 'verification_reserved',
                                    'verification_pending', 'completed', 'failed'
                                  )),
  pending_kind                    text CHECK (pending_kind IN ('enrichment', 'verification', 'verification_poll')),
  pending_tool_call_id            text,
  enrichment_tool_call_id         text,
  verification_tool_call_id       text,
  verification_poll_count         integer NOT NULL DEFAULT 0
                                  CHECK (verification_poll_count BETWEEN 0 AND 5),
  contact_data                    jsonb NOT NULL DEFAULT '{"professional_emails":[],"phones":[],"social_profiles":[]}'::jsonb,
  preferred_email                 text,
  verification_status             text CHECK (verification_status IN (
                                    'valid', 'invalid', 'accept_all', 'webmail', 'disposable', 'unknown'
                                  )),
  verification_score              numeric(5,2) CHECK (verification_score BETWEEN 0 AND 100),
  verification_checks             jsonb NOT NULL DEFAULT '{}'::jsonb,
  draft_eligible                  boolean NOT NULL DEFAULT false,
  verification_job_id             text,
  verification_poll_url           text,
  verification_retry_after_seconds integer CHECK (verification_retry_after_seconds BETWEEN 1 AND 300),
  monetary_cost_usd               numeric(6,2) NOT NULL DEFAULT 0
                                  CHECK (monetary_cost_usd >= 0 AND monetary_cost_usd <= 0.08),
  fetched_at                      timestamptz,
  verified_at                     timestamptz,
  created_at                      timestamptz NOT NULL DEFAULT now(),
  updated_at                      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT partner_contact_enrichments_run_key UNIQUE (workspace_id, run_id),
  CONSTRAINT partner_contact_enrichments_pending_check CHECK (
    (pending_kind IS NULL AND pending_tool_call_id IS NULL)
    OR (pending_kind IS NOT NULL AND pending_tool_call_id IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS partner_contact_enrichments_candidate_idx
  ON partner_contact_enrichments (workspace_id, agent_id, candidate_id, updated_at DESC);
DROP TRIGGER IF EXISTS partner_contact_enrichments_updated_at ON partner_contact_enrichments;
CREATE TRIGGER partner_contact_enrichments_updated_at BEFORE UPDATE ON partner_contact_enrichments
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE partner_contact_enrichments ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_contact_enrichments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON partner_contact_enrichments;
CREATE POLICY tenant_isolation ON partner_contact_enrichments
  USING (workspace_id = app_workspace_id()) WITH CHECK (workspace_id = app_workspace_id());

GRANT SELECT, INSERT, UPDATE ON partner_contact_enrichments TO app;
GRANT SELECT ON partner_contact_enrichments TO agent;
REVOKE INSERT, UPDATE, DELETE ON partner_contact_enrichments FROM agent;
REVOKE DELETE ON partner_contact_enrichments FROM app;
