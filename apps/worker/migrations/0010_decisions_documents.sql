-- 0010_decisions_documents.sql
-- What M4 needs that the M1 schema did not carry.
--
-- Three additions, and each one exists because a decision-time invariant had
-- nowhere to live:
--
--   1. `documents.pdf_status` / `pdf_error`. `render_status` answers "is there
--      a render?"; it cannot also answer "is there a PDF?", and in this build
--      those two have different answers. The HTML render is real; the PDF is
--      not, because `@react-pdf/renderer` reaches yoga-layout, which compiles
--      WebAssembly from a base64 string at runtime, and workerd refuses that
--      ("Wasm code generation disallowed by embedder" — the spike is recorded
--      in docs/DECISIONS.md, D-7). One column with two meanings would have made
--      the viewer say "Rendering failed" about a document that renders.
--
--   2. A `subject_id` for every request that names a subject. `redact_subject`
--      (0005) erases by `subject_id`, and the run engine writes only
--      `subject_key` — the hashed, normalised name. Without this, a data
--      subject access request would have a key and no way to reach the rows.
--      The id is derived from `(workspace_id, subject_key)` so it is stable
--      across runs and never collides across tenants, and a trigger fills it
--      so the path cannot be forgotten by a future writer.
--
--   3. Two indexes the M4 read paths need: effects by decision, documents by
--      request and version.

-- ---------------------------------------------------------------------------
-- 1. PDF state, separate from render state
-- ---------------------------------------------------------------------------

ALTER TABLE documents ADD COLUMN IF NOT EXISTS pdf_status text NOT NULL DEFAULT 'none';
ALTER TABLE documents ADD COLUMN IF NOT EXISTS pdf_error text;

-- Dropped and recreated rather than guarded, so the constraint's definition is
-- whatever this file says on every run and the fingerprint does not move.
ALTER TABLE documents DROP CONSTRAINT IF EXISTS documents_pdf_status_check;
ALTER TABLE documents ADD CONSTRAINT documents_pdf_status_check
  CHECK (pdf_status IN ('none', 'preparing', 'ready', 'unavailable', 'failed'));

-- ---------------------------------------------------------------------------
-- 2. A stable subject id, derived from the subject key
-- ---------------------------------------------------------------------------

-- md5 of the workspace and the key, cast to uuid: deterministic, tenant-scoped
-- and requiring no extension. It is an identifier, not a secret — `subject_key`
-- is already a hash of the applicant's email or name (engine/tools.ts) — so the
-- only property that matters is that the same person in the same workspace maps
-- to the same id every time.
CREATE OR REPLACE FUNCTION subject_id_for(target_workspace_id uuid, target_subject_key text)
  RETURNS uuid
  LANGUAGE sql IMMUTABLE
  AS $$ SELECT md5(target_workspace_id::text || ':' || target_subject_key)::uuid $$;

CREATE OR REPLACE FUNCTION requests_fill_subject_id() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF NEW.subject_id IS NULL AND NEW.subject_key IS NOT NULL THEN
      NEW.subject_id := subject_id_for(NEW.workspace_id, NEW.subject_key);
    END IF;
    RETURN NEW;
  END $$;

DROP TRIGGER IF EXISTS requests_subject_id ON requests;
CREATE TRIGGER requests_subject_id BEFORE INSERT ON requests
  FOR EACH ROW EXECUTE FUNCTION requests_fill_subject_id();

GRANT EXECUTE ON FUNCTION subject_id_for(uuid, text) TO app, agent;

-- No backfill statement: every statement in this file runs as `owner`, and
-- `owner` is NOBYPASSRLS like the other two roles, so an UPDATE here would
-- match zero rows in every workspace and look like success (the same reasoning
-- as 0008's closing note). Rows written before this migration keep a null
-- `subject_id`; the erasure route derives the id with `subject_id_for` and
-- matches on `subject_key` as well, so both generations are reachable.

-- ---------------------------------------------------------------------------
-- 3. Indexes the M4 read paths need
-- ---------------------------------------------------------------------------

CREATE INDEX IF NOT EXISTS effects_decision_idx ON effects (decision_id);
CREATE INDEX IF NOT EXISTS documents_request_idx ON documents (request_id, version DESC);
