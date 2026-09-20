-- Rotate paid partner discovery through new result pages without granting the
-- model control over pagination or allowing another paid call in the same run.

CREATE TABLE IF NOT EXISTS partner_discovery_cursors (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  agent_id        uuid NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  source          text NOT NULL CHECK (source = 'agentcash_people'),
  next_offset     integer NOT NULL DEFAULT 0 CHECK (next_offset BETWEEN 0 AND 10000),
  search_after    text CHECK (search_after IS NULL OR length(search_after) BETWEEN 1 AND 2048),
  page_size       integer NOT NULL CHECK (page_size BETWEEN 1 AND 10),
  last_run_id     uuid REFERENCES partner_screening_runs (id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT partner_discovery_cursors_agent_source_unique
    UNIQUE (workspace_id, agent_id, source)
);

DROP TRIGGER IF EXISTS partner_discovery_cursors_updated_at ON partner_discovery_cursors;
CREATE TRIGGER partner_discovery_cursors_updated_at BEFORE UPDATE ON partner_discovery_cursors
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE partner_discovery_cursors ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_discovery_cursors FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON partner_discovery_cursors;
CREATE POLICY tenant_isolation ON partner_discovery_cursors
  USING (workspace_id = app_workspace_id()) WITH CHECK (workspace_id = app_workspace_id());

GRANT SELECT, INSERT, UPDATE ON partner_discovery_cursors TO app;
REVOKE ALL ON partner_discovery_cursors FROM agent;
