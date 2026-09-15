-- 0018 removed FORCE from the target tables, but its subqueries still read
-- `agents` and `sessions` through their own forced tenant policies. Make the
-- complete backfill join visible to the table owner for this transaction.

ALTER TABLE agents NO FORCE ROW LEVEL SECURITY;
ALTER TABLE sessions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE runs NO FORCE ROW LEVEL SECURITY;

UPDATE sessions s
   SET agent_id = (
     SELECT a.id FROM agents a
      WHERE a.workspace_id = s.workspace_id
      ORDER BY a.created_at
      LIMIT 1
   )
 WHERE s.agent_id IS NULL
   AND EXISTS (SELECT 1 FROM agents a WHERE a.workspace_id = s.workspace_id);

UPDATE runs r
   SET agent_id = s.agent_id
  FROM sessions s
 WHERE s.id = r.session_id AND r.agent_id IS NULL AND s.agent_id IS NOT NULL;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM sessions s
     WHERE s.agent_id IS NULL
       AND EXISTS (SELECT 1 FROM agents a WHERE a.workspace_id = s.workspace_id)
  ) THEN
    RAISE EXCEPTION 'session agent backfill is incomplete';
  END IF;
  IF EXISTS (
    SELECT 1 FROM runs r
    JOIN sessions s ON s.id = r.session_id
    WHERE r.agent_id IS NULL AND s.agent_id IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'run agent backfill is incomplete';
  END IF;
END $$;

ALTER TABLE agents FORCE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
ALTER TABLE runs FORCE ROW LEVEL SECURITY;
