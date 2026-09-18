-- Jev supplies bounded, advisory signals for Inbox ordering. Assessments are
-- append-only and revision-bound; the normalized model state and raw model
-- response are intentionally not retained.

CREATE TABLE IF NOT EXISTS request_triage_assessments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  request_id        uuid NOT NULL REFERENCES requests (id) ON DELETE CASCADE,
  request_version   integer NOT NULL CHECK (request_version >= 0),
  state_hash        text NOT NULL CHECK (state_hash ~ '^[0-9a-f]{64}$'),
  rubric_version    text NOT NULL,
  summary_version   text NOT NULL,
  provider          text NOT NULL DEFAULT 'cloudflare_workers_ai',
  model_id          text NOT NULL DEFAULT 'typesafe/jev',
  model_version     text,
  status            text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'complete', 'abstained', 'failed')),
  priority_score    numeric(5,2) CHECK (priority_score BETWEEN 0 AND 100),
  priority_band     text CHECK (priority_band IN ('urgent', 'high', 'normal', 'low')),
  confidence        numeric(5,4) CHECK (confidence BETWEEN 0 AND 1),
  signals           jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason_codes      jsonb NOT NULL DEFAULT '[]'::jsonb,
  failure_class     text,
  attempt_count     integer NOT NULL DEFAULT 0 CHECK (attempt_count >= 0),
  created_at        timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz,
  CONSTRAINT request_triage_assessments_revision_key
    UNIQUE (request_id, state_hash, rubric_version, model_id)
);

CREATE INDEX IF NOT EXISTS request_triage_assessments_current_idx
  ON request_triage_assessments (workspace_id, request_id, request_version, created_at DESC);

ALTER TABLE request_triage_assessments ENABLE ROW LEVEL SECURITY;
ALTER TABLE request_triage_assessments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON request_triage_assessments;
CREATE POLICY tenant_isolation ON request_triage_assessments
  USING (workspace_id = app_workspace_id()) WITH CHECK (workspace_id = app_workspace_id());

GRANT SELECT, INSERT, UPDATE ON request_triage_assessments TO app;
GRANT SELECT ON request_triage_assessments TO agent;
REVOKE INSERT, UPDATE, DELETE ON request_triage_assessments FROM agent;
REVOKE DELETE ON request_triage_assessments FROM app;
