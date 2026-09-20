-- A monitor's observation is not run progress. Keep missing-instance evidence
-- outside runs so recording it cannot refresh the runs_updated_at trigger.
CREATE TABLE IF NOT EXISTS run_sweep_observations (
  run_id                 uuid PRIMARY KEY REFERENCES runs (id) ON DELETE CASCADE,
  workspace_id           uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  attempt                integer NOT NULL CHECK (attempt > 0),
  workflow_instance_id   text,
  run_status             text NOT NULL,
  progress_at            timestamptz NOT NULL,
  first_missing_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE run_sweep_observations ENABLE ROW LEVEL SECURITY;
ALTER TABLE run_sweep_observations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON run_sweep_observations;
CREATE POLICY tenant_isolation ON run_sweep_observations
  USING (workspace_id = app_workspace_id()) WITH CHECK (workspace_id = app_workspace_id());

GRANT SELECT, INSERT, UPDATE, DELETE ON run_sweep_observations TO app;
REVOKE ALL ON run_sweep_observations FROM agent, PUBLIC;
