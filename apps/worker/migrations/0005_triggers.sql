-- 0005_triggers.sql
-- The rules a grant cannot express.
--
-- REVOKE stops a role. It does not stop the table's owner, and it cannot say
-- "only while the request is still pending". These triggers close both gaps.

-- ---------------------------------------------------------------------------
-- Append-only audit and outbox
-- ---------------------------------------------------------------------------

-- An audit trail that can be edited is a record of what someone last wanted it
-- to say. Erasure goes through `redact_subject`, which rewrites the *subject*
-- rows, never the audit rows, because the audit rows hold ids and enum kinds
-- only and are therefore already free of personal text.
CREATE OR REPLACE FUNCTION refuse_mutation() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    RAISE EXCEPTION '% is append-only: % is refused', TG_TABLE_NAME, TG_OP
      USING ERRCODE = 'restrict_violation';
  END $$;

DROP TRIGGER IF EXISTS events_append_only ON events;
CREATE TRIGGER events_append_only BEFORE UPDATE OR DELETE ON events
  FOR EACH ROW EXECUTE FUNCTION refuse_mutation();

DROP TRIGGER IF EXISTS stream_events_append_only ON stream_events;
CREATE TRIGGER stream_events_append_only BEFORE UPDATE ON stream_events
  FOR EACH ROW EXECUTE FUNCTION refuse_mutation();

-- ---------------------------------------------------------------------------
-- What the agent role may publish
-- ---------------------------------------------------------------------------

-- The outbox is one table, so INSERT on it would otherwise let the run engine
-- publish `decision.recorded` and make the client render a receipt for a
-- decision nobody made. The client believes the outbox; so the outbox has to be
-- the thing that refuses.
CREATE OR REPLACE FUNCTION stream_events_agent_kind_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF current_user = 'agent'
       AND NEW.kind NOT LIKE 'message.%'
       AND NEW.kind NOT LIKE 'run.%' THEN
      RAISE EXCEPTION 'the agent role may publish message.* and run.* only, not %', NEW.kind
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END $$;

DROP TRIGGER IF EXISTS stream_events_agent_kind ON stream_events;
CREATE TRIGGER stream_events_agent_kind BEFORE INSERT ON stream_events
  FOR EACH ROW EXECUTE FUNCTION stream_events_agent_kind_guard();

-- ---------------------------------------------------------------------------
-- A tool may version a document only while the request is still pending
-- ---------------------------------------------------------------------------

-- Once a human has decided, the approved content is fixed: a new version after
-- the decision would mean the signature, the payment or the send applied to
-- text the approver never read. A post-decision version is a guarded human
-- command instead, and it cancels the pending effects and re-renders.
CREATE OR REPLACE FUNCTION documents_pending_only_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  DECLARE
    request_status text;
  BEGIN
    IF current_user <> 'agent' THEN
      RETURN NEW;
    END IF;
    SELECT status INTO request_status FROM requests WHERE id = NEW.request_id;
    IF request_status IS DISTINCT FROM 'pending' THEN
      RAISE EXCEPTION 'the agent role may write a document version only while the request is pending (request is %)',
        coalesce(request_status, 'missing')
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END $$;

DROP TRIGGER IF EXISTS documents_pending_only ON documents;
CREATE TRIGGER documents_pending_only BEFORE INSERT ON documents
  FOR EACH ROW EXECUTE FUNCTION documents_pending_only_guard();

-- ---------------------------------------------------------------------------
-- A workspace always keeps one Admin
-- ---------------------------------------------------------------------------

-- Nobody can lock a workspace out of its own decisions: with no Admin, no
-- request could ever be decided again, and the Inbox would fill forever.
CREATE OR REPLACE FUNCTION members_keep_one_admin() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  DECLARE
    remaining integer;
    target_workspace uuid;
  BEGIN
    target_workspace := COALESCE(OLD.workspace_id, NEW.workspace_id);

    SELECT count(*) INTO remaining
    FROM members m
    WHERE m.workspace_id = target_workspace
      AND m.role = 'admin'
      AND m.status = 'active'
      AND m.id <> OLD.id;

    IF TG_OP = 'UPDATE' AND NEW.role = 'admin' AND NEW.status = 'active' THEN
      remaining := remaining + 1;
    END IF;

    IF OLD.role = 'admin' AND OLD.status = 'active' AND remaining = 0 THEN
      RAISE EXCEPTION 'a workspace must keep at least one active Admin'
        USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
  END $$;

DROP TRIGGER IF EXISTS members_last_admin ON members;
CREATE TRIGGER members_last_admin BEFORE UPDATE OR DELETE ON members
  FOR EACH ROW EXECUTE FUNCTION members_keep_one_admin();

-- ---------------------------------------------------------------------------
-- Erasure
-- ---------------------------------------------------------------------------

-- A data subject access request has to reach every store holding applicant
-- text. In Postgres that is the request payload, the notes, the run turns and
-- the transcript. SECURITY DEFINER so the `app` role can run it without
-- holding UPDATE on those columns itself; the procedure writes its own audit
-- row, so an erasure is as auditable as a decision.
CREATE OR REPLACE FUNCTION redact_subject(target_subject_id uuid, target_workspace_id uuid)
  RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
  AS $$
  DECLARE
    touched integer := 0;
    n integer;
  BEGIN
    IF target_subject_id IS NULL OR target_workspace_id IS NULL THEN
      RAISE EXCEPTION 'redact_subject needs both a subject and a workspace';
    END IF;

    UPDATE requests
       SET payload = jsonb_build_object('kind', kind, 'redacted', true),
           label = 'Deleted applicant',
           subject_key = NULL
     WHERE workspace_id = target_workspace_id AND subject_id = target_subject_id;
    GET DIAGNOSTICS n = ROW_COUNT; touched := touched + n;

    UPDATE request_notes rn
       SET body = '[redacted]'
      FROM requests r
     WHERE rn.request_id = r.id
       AND r.workspace_id = target_workspace_id
       AND r.subject_id = target_subject_id;
    GET DIAGNOSTICS n = ROW_COUNT; touched := touched + n;

    UPDATE run_turns
       SET provider_message = jsonb_build_object('redacted', true)
     WHERE workspace_id = target_workspace_id AND subject_id = target_subject_id;
    GET DIAGNOSTICS n = ROW_COUNT; touched := touched + n;

    INSERT INTO events (workspace_id, actor_type, kind, subject_id)
    VALUES (target_workspace_id, 'system', 'subject.redacted', target_subject_id);

    RETURN touched;
  END $$;

REVOKE ALL ON FUNCTION redact_subject(uuid, uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION redact_subject(uuid, uuid) TO app;
