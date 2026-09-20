-- Human notes are settings; run snapshots never change when settings change.
CREATE TABLE IF NOT EXISTS agent_context_notes (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
 agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
 title text NOT NULL CHECK (length(title) BETWEEN 1 AND 120),
 text text NOT NULL CHECK (length(text) BETWEEN 1 AND 2000),
 revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
 author_id uuid REFERENCES users(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE agent_context_notes ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_context_notes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON agent_context_notes;
CREATE POLICY tenant_isolation ON agent_context_notes USING (workspace_id=app_workspace_id()) WITH CHECK (workspace_id=app_workspace_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON agent_context_notes TO app;
GRANT SELECT ON agent_context_notes TO agent;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS context_snapshot jsonb;
CREATE OR REPLACE FUNCTION capture_run_context_notes() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.context_snapshot IS NULL THEN
  SELECT jsonb_build_object('notes',COALESCE(jsonb_agg(jsonb_build_object('id',id,'title',title,'text',text,'revision',revision,'author_id',author_id) ORDER BY created_at,id),'[]'::jsonb),'sources','[]'::jsonb)
    INTO NEW.context_snapshot FROM agent_context_notes WHERE workspace_id=NEW.workspace_id AND agent_id=NEW.agent_id;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS runs_capture_context ON runs;
CREATE TRIGGER runs_capture_context BEFORE INSERT ON runs FOR EACH ROW EXECUTE FUNCTION capture_run_context_notes();
