-- 0071: two approval-safety fixes from the roles-and-agents plan (piece 0).
--
-- 1. `effects.approvals_required` has said a payment needs two Finance holders
--    since 0002, but Execute never counted anyone: one press executed it. Each
--    distinct holder's press is now one row here, and the effect runs only when
--    the rows reach `approvals_required`. The primary key makes a second press
--    by the same person a no-op rather than a second vote.
-- 2. Agreements named "Nous Research" as the first party whatever the
--    workspace was. `legal_name` is the party name documents use; null means
--    the workspace name.

CREATE TABLE IF NOT EXISTS effect_confirmations (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  effect_id    uuid NOT NULL REFERENCES effects (id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (effect_id, user_id)
);
CREATE INDEX IF NOT EXISTS effect_confirmations_workspace_idx ON effect_confirmations (workspace_id, effect_id);

ALTER TABLE effect_confirmations ENABLE ROW LEVEL SECURITY;
ALTER TABLE effect_confirmations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON effect_confirmations;
CREATE POLICY tenant_isolation ON effect_confirmations
  USING (workspace_id = app_workspace_id())
  WITH CHECK (workspace_id = app_workspace_id());

-- Confirmations are an audit record: written once, never edited.
GRANT SELECT, INSERT ON effect_confirmations TO app;
REVOKE ALL ON effect_confirmations FROM agent;

ALTER TABLE workspace_settings
  ADD COLUMN IF NOT EXISTS legal_name text
  CHECK (legal_name IS NULL OR char_length(legal_name) BETWEEN 1 AND 200);
