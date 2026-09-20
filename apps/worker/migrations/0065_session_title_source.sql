-- 0065_session_title_source.sql
-- The session's name is the server's to keep.
--
-- Until now a session was named twice from the client: the first six words of
-- the first turn, and then, when a run finished, the object it produced
-- ("Ada Ling · application"). The second rename needed the session's focus to
-- point at the request, and the focus is only written while the app follows
-- Iris. A workspace that opens in the activation flow pins the pane, so its
-- first session kept its provisional name forever.
--
-- Both names are now written by the server: the turn route on the first turn,
-- the engine when a run completes with a proposed request. The column records
-- who named the row so a person's own rename is never overwritten, which was
-- previously client-only knowledge and lost on reload.
ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS title_source text NOT NULL DEFAULT 'default'
    CHECK (title_source IN ('default', 'turn', 'run', 'manual'));

-- Existing rows carry no provenance. Anything that is not still the
-- placeholder is treated as somebody's: refining a title a person may have set
-- weeks ago is the failure mode worth avoiding.
UPDATE sessions SET title_source = 'manual' WHERE title <> 'New session';

-- The agent role may now publish `entity.updated` about a session, but only a
-- session one of its runs belongs to. The shape mirrors the request rule from
-- 0013: the payload names a row, in this workspace, that a run wrote against.
CREATE OR REPLACE FUNCTION stream_events_agent_may_publish(kind text, workspace uuid, payload jsonb)
  RETURNS boolean
  LANGUAGE plpgsql
  STABLE
  AS $$
  DECLARE
    candidate text;
    about_session boolean := false;
  BEGIN
    IF kind = 'request.created' THEN
      candidate := payload ->> 'request_id';
    ELSIF kind = 'entity.updated' AND payload ->> 'entity_type' = 'request' THEN
      candidate := payload ->> 'entity_id';
    ELSIF kind = 'entity.updated' AND payload ->> 'entity_type' = 'session' THEN
      candidate := payload ->> 'entity_id';
      about_session := true;
    ELSE
      RETURN false;
    END IF;

    IF candidate IS NULL
       OR candidate !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
      RETURN false;
    END IF;

    IF about_session THEN
      RETURN EXISTS (
        SELECT 1 FROM runs r
         WHERE r.session_id = candidate::uuid
           AND r.workspace_id = workspace
      );
    END IF;

    RETURN EXISTS (
      SELECT 1 FROM requests r
       WHERE r.id = candidate::uuid
         AND r.workspace_id = workspace
         AND r.run_id IS NOT NULL
    );
  END $$;

-- A row inserted with a real title and no provenance was named by whoever
-- inserted it: a person through POST /sessions, or a seed. The same rule as
-- the backfill above, kept in one place so no insert path can forget it.
CREATE OR REPLACE FUNCTION sessions_title_source_default() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF NEW.title_source = 'default' AND NEW.title <> 'New session' THEN
      NEW.title_source := 'manual';
    END IF;
    RETURN NEW;
  END $$;

DROP TRIGGER IF EXISTS sessions_title_source_default ON sessions;
CREATE TRIGGER sessions_title_source_default
  BEFORE INSERT ON sessions
  FOR EACH ROW EXECUTE FUNCTION sessions_title_source_default();
