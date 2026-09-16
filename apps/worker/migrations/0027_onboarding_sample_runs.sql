-- 0026_onboarding_sample_runs.sql
-- Durable, explicitly simulated Partner Program onboarding runs.
--
-- These rows power the first-run walkthrough without a provider credential or
-- an intake integration. Progress is materialized from server time when the
-- client polls, so a refresh can resume from persisted state and can never
-- replay a web search or create a second Inbox request.

CREATE TABLE IF NOT EXISTS onboarding_sample_runs (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  agent_id         uuid NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  created_by       uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  session_id       uuid REFERENCES sessions (id) ON DELETE SET NULL,
  setup_attempt_id uuid NOT NULL,
  status           text NOT NULL DEFAULT 'running'
                     CHECK (status IN ('running', 'completed')),
  simulated        boolean NOT NULL DEFAULT true CHECK (simulated = true),
  started_at       timestamptz NOT NULL DEFAULT now(),
  completed_at     timestamptz,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT onboarding_sample_runs_attempt_key
    UNIQUE (workspace_id, agent_id, setup_attempt_id)
);
CREATE INDEX IF NOT EXISTS onboarding_sample_runs_workspace_idx
  ON onboarding_sample_runs (workspace_id, created_by, created_at DESC);

DROP TRIGGER IF EXISTS onboarding_sample_runs_updated_at ON onboarding_sample_runs;
CREATE TRIGGER onboarding_sample_runs_updated_at BEFORE UPDATE ON onboarding_sample_runs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS onboarding_sample_applications (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  run_id        uuid NOT NULL REFERENCES onboarding_sample_runs (id) ON DELETE CASCADE,
  sample_key    text NOT NULL CHECK (sample_key IN ('owen', 'leah')),
  display_name  text NOT NULL,
  state         text NOT NULL DEFAULT 'received'
                  CHECK (state IN ('received', 'researching', 'screened', 'needs_review')),
  payload       jsonb NOT NULL,
  request_id    uuid UNIQUE REFERENCES requests (id) ON DELETE SET NULL,
  received_at   timestamptz NOT NULL,
  researching_at timestamptz,
  screened_at   timestamptz,
  needs_review_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT onboarding_sample_applications_key UNIQUE (run_id, sample_key)
);
CREATE INDEX IF NOT EXISTS onboarding_sample_applications_run_idx
  ON onboarding_sample_applications (workspace_id, run_id, created_at);

DROP TRIGGER IF EXISTS onboarding_sample_applications_updated_at ON onboarding_sample_applications;
CREATE TRIGGER onboarding_sample_applications_updated_at BEFORE UPDATE ON onboarding_sample_applications
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS onboarding_sample_events (
  id             bigserial PRIMARY KEY,
  workspace_id   uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  run_id         uuid NOT NULL REFERENCES onboarding_sample_runs (id) ON DELETE CASCADE,
  application_id uuid REFERENCES onboarding_sample_applications (id) ON DELETE CASCADE,
  event_key      text NOT NULL,
  kind           text NOT NULL CHECK (kind IN (
                   'run.started', 'application.received', 'application.researching',
                   'application.screened', 'application.needs_review', 'run.completed'
                 )),
  state          text CHECK (state IS NULL OR state IN (
                   'received', 'researching', 'screened', 'needs_review'
                 )),
  request_id     uuid REFERENCES requests (id) ON DELETE SET NULL,
  detail         text NOT NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT onboarding_sample_events_key UNIQUE (run_id, event_key)
);
CREATE INDEX IF NOT EXISTS onboarding_sample_events_cursor_idx
  ON onboarding_sample_events (workspace_id, run_id, id);

-- Migration 0003 cannot protect tables that did not exist yet.
ALTER TABLE onboarding_sample_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE onboarding_sample_runs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON onboarding_sample_runs;
CREATE POLICY tenant_isolation ON onboarding_sample_runs
  USING (workspace_id = app_workspace_id())
  WITH CHECK (workspace_id = app_workspace_id());

ALTER TABLE onboarding_sample_applications ENABLE ROW LEVEL SECURITY;
ALTER TABLE onboarding_sample_applications FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON onboarding_sample_applications;
CREATE POLICY tenant_isolation ON onboarding_sample_applications
  USING (workspace_id = app_workspace_id())
  WITH CHECK (workspace_id = app_workspace_id());

ALTER TABLE onboarding_sample_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE onboarding_sample_events FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON onboarding_sample_events;
CREATE POLICY tenant_isolation ON onboarding_sample_events
  USING (workspace_id = app_workspace_id())
  WITH CHECK (workspace_id = app_workspace_id());

-- Only the browser-facing Worker advances the deterministic walkthrough. The
-- Hermes runtime cannot forge, amend or remove sample onboarding evidence.
GRANT SELECT, INSERT, UPDATE ON onboarding_sample_runs, onboarding_sample_applications TO app;
GRANT SELECT, INSERT ON onboarding_sample_events TO app;
GRANT USAGE, SELECT ON SEQUENCE onboarding_sample_events_id_seq TO app;
REVOKE ALL ON onboarding_sample_runs, onboarding_sample_applications, onboarding_sample_events FROM agent;
REVOKE UPDATE, DELETE ON onboarding_sample_events FROM app;

DROP TRIGGER IF EXISTS onboarding_sample_events_append_only ON onboarding_sample_events;
CREATE TRIGGER onboarding_sample_events_append_only
  BEFORE UPDATE OR DELETE ON onboarding_sample_events
  FOR EACH ROW EXECUTE FUNCTION refuse_mutation();
