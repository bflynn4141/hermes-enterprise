-- Capture instructions at admission, including the legacy agent-text fallback.
-- Every run writer uses this boundary; retrying an existing run keeps its text.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS instruction_snapshot text;

CREATE OR REPLACE FUNCTION capture_run_instructions() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  selected_agent uuid;
  selected_version uuid;
  selected_body text;
BEGIN
  SELECT COALESCE(NEW.agent_id,s.agent_id) INTO selected_agent
    FROM sessions s WHERE s.id=NEW.session_id AND s.workspace_id=NEW.workspace_id;
  SELECT iv.id,iv.body INTO selected_version,selected_body
    FROM instruction_versions iv
   WHERE iv.workspace_id=NEW.workspace_id AND iv.agent_id=selected_agent
     AND iv.status='saved'
     AND (NEW.instruction_version_id IS NULL OR iv.id=NEW.instruction_version_id)
   ORDER BY iv.saved_at DESC NULLS LAST,iv.created_at DESC,iv.id DESC LIMIT 1;
  IF NEW.instruction_version_id IS NOT NULL AND selected_version IS NULL THEN
    RAISE EXCEPTION 'invalid run instruction version' USING ERRCODE='23514';
  END IF;
  IF selected_body IS NULL THEN
    SELECT a.instructions_active INTO selected_body FROM agents a
     WHERE a.id=selected_agent AND a.workspace_id=NEW.workspace_id;
  END IF;
  NEW.instruction_version_id := selected_version;
  NEW.instruction_snapshot := COALESCE(selected_body,'');
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS run_instruction_snapshot ON runs;
CREATE TRIGGER run_instruction_snapshot BEFORE INSERT ON runs
FOR EACH ROW EXECUTE FUNCTION capture_run_instructions();
