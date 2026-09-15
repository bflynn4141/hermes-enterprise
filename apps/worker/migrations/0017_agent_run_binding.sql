-- Bind every conversation and run to the agent that owns the work.
--
-- Nullable during the expand phase so the previous Worker can still insert a
-- row during a rolling deploy. The new Worker always writes the value, and all
-- existing rows are backfilled from the workspace's current agent. Readers
-- coalesce through the session while the migration is in that mixed state.

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS agent_id uuid REFERENCES agents (id) ON DELETE RESTRICT;

UPDATE sessions s
   SET agent_id = (
     SELECT a.id FROM agents a
      WHERE a.workspace_id = s.workspace_id
      ORDER BY a.created_at
      LIMIT 1
   )
 WHERE s.agent_id IS NULL;

CREATE INDEX IF NOT EXISTS sessions_agent_idx
  ON sessions (workspace_id, agent_id, last_activity_at DESC);

-- Keep an old Worker safe during a rolling deploy: it does not send agent_id.
-- The fallback is deterministic for today's one-agent workspace; the new
-- Worker sends an explicit id and never depends on it.
CREATE OR REPLACE FUNCTION bind_session_agent() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
BEGIN
  IF NEW.agent_id IS NULL THEN
    SELECT id INTO NEW.agent_id
      FROM agents
     WHERE workspace_id = NEW.workspace_id
     ORDER BY created_at
     LIMIT 1;
  END IF;
  IF NEW.agent_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM agents WHERE id = NEW.agent_id AND workspace_id = NEW.workspace_id
  ) THEN
    RAISE EXCEPTION 'session agent must belong to its workspace' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS sessions_bind_agent ON sessions;
CREATE TRIGGER sessions_bind_agent BEFORE INSERT OR UPDATE OF workspace_id, agent_id ON sessions
  FOR EACH ROW EXECUTE FUNCTION bind_session_agent();

ALTER TABLE runs ADD COLUMN IF NOT EXISTS agent_id uuid REFERENCES agents (id) ON DELETE RESTRICT;

UPDATE runs r
   SET agent_id = s.agent_id
  FROM sessions s
 WHERE s.id = r.session_id AND r.agent_id IS NULL;

CREATE INDEX IF NOT EXISTS runs_agent_idx
  ON runs (workspace_id, agent_id, started_at DESC);

CREATE OR REPLACE FUNCTION bind_run_agent() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
DECLARE
  bound_agent uuid;
BEGIN
  SELECT agent_id INTO bound_agent
    FROM sessions
   WHERE id = NEW.session_id AND workspace_id = NEW.workspace_id;
  IF NEW.agent_id IS NULL THEN
    NEW.agent_id := bound_agent;
  END IF;
  IF bound_agent IS NULL OR NEW.agent_id IS DISTINCT FROM bound_agent THEN
    RAISE EXCEPTION 'run agent must match its session agent' USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS runs_bind_agent ON runs;
CREATE TRIGGER runs_bind_agent BEFORE INSERT OR UPDATE OF workspace_id, session_id, agent_id ON runs
  FOR EACH ROW EXECUTE FUNCTION bind_run_agent();
