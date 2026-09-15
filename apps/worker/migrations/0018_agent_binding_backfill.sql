-- 0017 added and populated agent_id, but its cross-workspace UPDATE ran as the
-- table owner while tenant tables have FORCE ROW LEVEL SECURITY. With no
-- app.workspace_id set, that correctly made every existing row invisible.
--
-- Temporarily removing FORCE lets the owner perform this data migration. RLS
-- stays enabled throughout, FORCE is restored in the same transaction, and a
-- failed statement rolls the whole change back.

ALTER TABLE sessions NO FORCE ROW LEVEL SECURITY;

UPDATE sessions s
   SET agent_id = (
     SELECT a.id FROM agents a
      WHERE a.workspace_id = s.workspace_id
      ORDER BY a.created_at
      LIMIT 1
   )
 WHERE s.agent_id IS NULL
   AND EXISTS (SELECT 1 FROM agents a WHERE a.workspace_id = s.workspace_id);

ALTER TABLE sessions FORCE ROW LEVEL SECURITY;

ALTER TABLE runs NO FORCE ROW LEVEL SECURITY;

UPDATE runs r
   SET agent_id = s.agent_id
  FROM sessions s
 WHERE s.id = r.session_id AND r.agent_id IS NULL AND s.agent_id IS NOT NULL;

ALTER TABLE runs FORCE ROW LEVEL SECURITY;

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

