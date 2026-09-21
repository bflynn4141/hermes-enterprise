-- Handoff becomes a first-class workspace object. Admission authority moves to
-- the handoffs row; partner_workflow_settings stays as a compatibility mirror.

CREATE TABLE IF NOT EXISTS handoffs (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id         uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  key                  text NOT NULL CHECK (char_length(key) BETWEEN 1 AND 64),
  name                 text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  description          text NOT NULL CHECK (char_length(description) BETWEEN 1 AND 1000),
  from_team_id         uuid NOT NULL,
  to_team_id           uuid NOT NULL,
  crossing             jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(crossing) = 'array'),
  steps                jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(steps) = 'array'),
  admission_state      text NOT NULL DEFAULT 'disabled'
                       CHECK (admission_state IN ('disabled', 'enabled')),
  enabled_by           uuid REFERENCES users (id) ON DELETE SET NULL,
  enabled_at           timestamptz,
  readiness            jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(readiness) = 'object'),
  readiness_checked_at timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT handoffs_workspace_key UNIQUE (workspace_id, key),
  CONSTRAINT handoffs_workspace_id_key UNIQUE (workspace_id, id),
  CONSTRAINT handoffs_from_team_fk FOREIGN KEY (workspace_id, from_team_id)
    REFERENCES enterprise_teams (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT handoffs_to_team_fk FOREIGN KEY (workspace_id, to_team_id)
    REFERENCES enterprise_teams (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT handoffs_distinct_teams CHECK (from_team_id <> to_team_id)
);
CREATE INDEX IF NOT EXISTS handoffs_workspace_idx ON handoffs (workspace_id, key);
DROP TRIGGER IF EXISTS handoffs_updated_at ON handoffs;
CREATE TRIGGER handoffs_updated_at BEFORE UPDATE ON handoffs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE partner_workflow_settings
  ADD COLUMN IF NOT EXISTS handoff_id uuid;
ALTER TABLE partner_handoffs
  ADD COLUMN IF NOT EXISTS handoff_id uuid;

DO $$ BEGIN
  ALTER TABLE partner_workflow_settings ADD CONSTRAINT partner_workflow_settings_handoff_fk
    FOREIGN KEY (workspace_id, handoff_id) REFERENCES handoffs (workspace_id, id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN
  ALTER TABLE partner_handoffs ADD CONSTRAINT partner_handoffs_definition_handoff_fk
    FOREIGN KEY (workspace_id, handoff_id) REFERENCES handoffs (workspace_id, id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

INSERT INTO handoffs
  (workspace_id, key, name, description, from_team_id, to_team_id, crossing, steps,
   admission_state, enabled_by, enabled_at, readiness, readiness_checked_at)
SELECT
  pws.workspace_id,
  'partner-invoices',
  'Partner invoices · Partnerships → Finance',
  'One governed invoice handoff. Private team context stays private; only authorized terms, confirmed invoice fields, and the final acknowledgment cross teams.',
  partnerships.id,
  finance.id,
  '[
    {"key":"authorized_terms","label":"Authorized terms","direction":"forward"},
    {"key":"confirmed_invoice","label":"Confirmed invoice fields","direction":"forward"},
    {"key":"final_acknowledgment","label":"Final acknowledgment","direction":"return"}
  ]'::jsonb,
  '[
    {"index":1,"owner":{"team_slug":"partnerships","kind":"person"},"label":"Records agreed terms with the source document","note":"Creates a proposal for Finance"},
    {"index":2,"owner":{"team_slug":"finance","kind":"person"},"label":"Verifies the terms and authorizes one invoice","note":"Human decision in Inbox"},
    {"index":3,"owner":{"team_slug":"partnerships","kind":"person"},"label":"Submits the received invoice with confirmed fields","note":"Immutable intake"},
    {"index":4,"owner":{"team_slug":"finance","kind":"agent"},"label":"Checks the invoice against the authorized terms and flags gaps","note":"Evidence only · cannot approve"},
    {"index":5,"owner":{"team_slug":"finance","kind":"person"},"label":"Approves or declines","note":"Human decision in Inbox"},
    {"index":6,"owner":{"team_slug":"finance","kind":"person","return_team_slug":"partnerships"},"label":"One acknowledgment returns: invoice draft saved, or declined","note":"No payment, email or signature"}
  ]'::jsonb,
  pws.admission_state,
  pws.enabled_by,
  pws.enabled_at,
  pws.readiness,
  pws.readiness_checked_at
FROM partner_workflow_settings pws
JOIN enterprise_teams partnerships
  ON partnerships.workspace_id = pws.workspace_id AND partnerships.slug = 'partnerships'
JOIN enterprise_teams finance
  ON finance.workspace_id = pws.workspace_id AND finance.slug = 'finance'
ON CONFLICT (workspace_id, key) DO NOTHING;

UPDATE partner_workflow_settings pws
   SET handoff_id = h.id
  FROM handoffs h
 WHERE h.workspace_id = pws.workspace_id AND h.key = 'partner-invoices';

UPDATE partner_handoffs ph
   SET handoff_id = h.id
  FROM handoffs h
 WHERE h.workspace_id = ph.workspace_id AND h.key = 'partner-invoices';

CREATE OR REPLACE FUNCTION sync_handoff_admission_to_settings()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO partner_workflow_settings
    (workspace_id, admission_state, enabled_by, enabled_at, readiness, readiness_checked_at, handoff_id)
  VALUES
    (NEW.workspace_id, NEW.admission_state, NEW.enabled_by, NEW.enabled_at,
     NEW.readiness, NEW.readiness_checked_at, NEW.id)
  ON CONFLICT (workspace_id) DO UPDATE
    SET admission_state = EXCLUDED.admission_state,
        enabled_by = EXCLUDED.enabled_by,
        enabled_at = EXCLUDED.enabled_at,
        readiness = EXCLUDED.readiness,
        readiness_checked_at = EXCLUDED.readiness_checked_at,
        handoff_id = EXCLUDED.handoff_id;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS handoffs_sync_settings ON handoffs;
CREATE TRIGGER handoffs_sync_settings AFTER INSERT OR UPDATE OF
  admission_state, enabled_by, enabled_at, readiness, readiness_checked_at
  ON handoffs FOR EACH ROW EXECUTE FUNCTION sync_handoff_admission_to_settings();

ALTER TABLE handoffs ENABLE ROW LEVEL SECURITY;
ALTER TABLE handoffs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON handoffs;
CREATE POLICY tenant_isolation ON handoffs
  USING (workspace_id = app_workspace_id())
  WITH CHECK (workspace_id = app_workspace_id());

GRANT SELECT, INSERT, UPDATE ON handoffs TO app;
REVOKE ALL ON handoffs FROM agent;
