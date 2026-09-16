-- 0027_partner_screening.sql
-- Read-only public-source ingestion for the Partner Program agent.
--
-- Source collection and agent judgment are deliberately separate. The app
-- role writes sanitized GitHub organization/repository snapshots here. The
-- agent role may read them, then its existing propose_request tool may create
-- a pending Inbox application for human review. Neither role gains a contact,
-- admission, message, payment, signature, or generic external-write ability.

CREATE TABLE IF NOT EXISTS partner_screening_runs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  agent_id              uuid NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  created_by            uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  idempotency_key       text NOT NULL,
  status                text NOT NULL DEFAULT 'running'
                          CHECK (status IN ('running', 'completed', 'failed')),
  source                 text NOT NULL CHECK (source = 'github'),
  authentication        text NOT NULL CHECK (authentication IN ('authenticated', 'unauthenticated')),
  config_snapshot       jsonb NOT NULL,
  api_requests_max      integer NOT NULL CHECK (api_requests_max BETWEEN 1 AND 30),
  api_requests_used     integer NOT NULL DEFAULT 0 CHECK (api_requests_used BETWEEN 0 AND 30),
  rate_limits           jsonb NOT NULL DEFAULT '[]'::jsonb,
  candidates_discovered integer NOT NULL DEFAULT 0 CHECK (candidates_discovered BETWEEN 0 AND 10),
  error_code            text,
  error_detail          text,
  started_at            timestamptz NOT NULL DEFAULT now(),
  completed_at          timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT partner_screening_runs_idempotency
    UNIQUE (workspace_id, agent_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS partner_screening_runs_workspace_idx
  ON partner_screening_runs (workspace_id, agent_id, created_at DESC);
DROP TRIGGER IF EXISTS partner_screening_runs_updated_at ON partner_screening_runs;
CREATE TRIGGER partner_screening_runs_updated_at BEFORE UPDATE ON partner_screening_runs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS partner_source_artifacts (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  run_id            uuid NOT NULL REFERENCES partner_screening_runs (id) ON DELETE CASCADE,
  source            text NOT NULL CHECK (source = 'github'),
  artifact_key      text NOT NULL,
  kind              text NOT NULL CHECK (kind IN ('search_result', 'organization_profile', 'repository_snapshot')),
  source_url        text NOT NULL,
  source_updated_at timestamptz,
  fetched_at        timestamptz NOT NULL,
  sha256            text NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
  content           jsonb NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT partner_source_artifacts_run_key UNIQUE (run_id, artifact_key)
);
CREATE INDEX IF NOT EXISTS partner_source_artifacts_run_idx
  ON partner_source_artifacts (workspace_id, run_id, created_at);

CREATE TABLE IF NOT EXISTS partner_candidates (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  agent_id              uuid NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  source                 text NOT NULL CHECK (source = 'github'),
  source_key             text NOT NULL,
  display_name           text NOT NULL,
  profile_url            text NOT NULL,
  deterministic_priority integer NOT NULL CHECK (deterministic_priority BETWEEN 0 AND 100),
  priority_breakdown     jsonb NOT NULL,
  confidence             text NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  evidence_gaps          text[] NOT NULL DEFAULT '{}',
  source_updated_at      timestamptz,
  latest_run_id          uuid NOT NULL REFERENCES partner_screening_runs (id) ON DELETE RESTRICT,
  first_seen_at          timestamptz NOT NULL,
  last_seen_at           timestamptz NOT NULL,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT partner_candidates_source_key UNIQUE (workspace_id, agent_id, source, source_key)
);
CREATE INDEX IF NOT EXISTS partner_candidates_agent_idx
  ON partner_candidates (workspace_id, agent_id, deterministic_priority DESC, last_seen_at DESC);
DROP TRIGGER IF EXISTS partner_candidates_updated_at ON partner_candidates;
CREATE TRIGGER partner_candidates_updated_at BEFORE UPDATE ON partner_candidates
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS partner_screening_run_candidates (
  workspace_id          uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  run_id                uuid NOT NULL REFERENCES partner_screening_runs (id) ON DELETE CASCADE,
  candidate_id          uuid NOT NULL REFERENCES partner_candidates (id) ON DELETE CASCADE,
  deterministic_priority integer NOT NULL CHECK (deterministic_priority BETWEEN 0 AND 100),
  priority_breakdown    jsonb NOT NULL,
  confidence            text NOT NULL CHECK (confidence IN ('high', 'medium', 'low')),
  evidence_gaps         text[] NOT NULL DEFAULT '{}',
  artifact_ids          uuid[] NOT NULL DEFAULT '{}',
  created_at            timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (run_id, candidate_id)
);
CREATE INDEX IF NOT EXISTS partner_screening_run_candidates_candidate_idx
  ON partner_screening_run_candidates (workspace_id, candidate_id, created_at DESC);

-- One discovered organization can have at most one Inbox request. This key is
-- used only when Iris copies a connector candidate_id into application.discovery.
CREATE UNIQUE INDEX IF NOT EXISTS requests_partner_candidate_key
  ON requests (workspace_id, subject_key)
  WHERE subject_key LIKE 'partner-candidate:%';

ALTER TABLE partner_screening_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_screening_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON partner_screening_runs;
CREATE POLICY tenant_isolation ON partner_screening_runs
  USING (workspace_id = app_workspace_id()) WITH CHECK (workspace_id = app_workspace_id());

ALTER TABLE partner_source_artifacts ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_source_artifacts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON partner_source_artifacts;
CREATE POLICY tenant_isolation ON partner_source_artifacts
  USING (workspace_id = app_workspace_id()) WITH CHECK (workspace_id = app_workspace_id());

ALTER TABLE partner_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_candidates FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON partner_candidates;
CREATE POLICY tenant_isolation ON partner_candidates
  USING (workspace_id = app_workspace_id()) WITH CHECK (workspace_id = app_workspace_id());

ALTER TABLE partner_screening_run_candidates ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_screening_run_candidates FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON partner_screening_run_candidates;
CREATE POLICY tenant_isolation ON partner_screening_run_candidates
  USING (workspace_id = app_workspace_id()) WITH CHECK (workspace_id = app_workspace_id());

GRANT SELECT, INSERT, UPDATE ON partner_screening_runs, partner_candidates TO app;
GRANT SELECT, INSERT ON partner_source_artifacts, partner_screening_run_candidates TO app;
GRANT SELECT ON partner_screening_runs, partner_source_artifacts, partner_candidates,
  partner_screening_run_candidates TO agent;

REVOKE INSERT, UPDATE, DELETE ON partner_screening_runs, partner_source_artifacts,
  partner_candidates, partner_screening_run_candidates FROM agent;
REVOKE UPDATE, DELETE ON partner_source_artifacts, partner_screening_run_candidates FROM app;

DROP TRIGGER IF EXISTS partner_source_artifacts_append_only ON partner_source_artifacts;
CREATE TRIGGER partner_source_artifacts_append_only
  BEFORE UPDATE OR DELETE ON partner_source_artifacts
  FOR EACH ROW EXECUTE FUNCTION refuse_mutation();
DROP TRIGGER IF EXISTS partner_screening_run_candidates_append_only ON partner_screening_run_candidates;
CREATE TRIGGER partner_screening_run_candidates_append_only
  BEFORE UPDATE OR DELETE ON partner_screening_run_candidates
  FOR EACH ROW EXECUTE FUNCTION refuse_mutation();
