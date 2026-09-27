-- 0074: amount thresholds on approval rules (C94) and decisions that need
-- more than one person (C95).
--
-- 1. An invoice or a payment may use a second rule above an amount. That rule
--    is a second row for the same route, `band = 'over'`, carrying the amount
--    and currency it starts above. The base row keeps `band = 'base'` and no
--    amount, so every existing row reads exactly as before.
-- 2. `one_from_each`: with two or more people, at least one must come from each
--    group the rule names. Only meaningful with two or more people.
-- 3. Decisions may need several people now. Each eligible person's approval is
--    a row in `decision_confirmations`; the decision is recorded (one row in
--    `decisions`, as always) by the press that completes the count. The primary
--    key makes a second press by the same person a no-op, as with
--    `effect_confirmations` (0071).
--
-- The roles-exist trigger and the role-delete guard from 0073 already cover the
-- new rows: both read `approval_route_rules.roles` for every row of a workspace.

ALTER TABLE approval_route_rules
  ADD COLUMN IF NOT EXISTS band text NOT NULL DEFAULT 'base',
  ADD COLUMN IF NOT EXISTS over_minor bigint NULL,
  ADD COLUMN IF NOT EXISTS over_currency text NULL,
  ADD COLUMN IF NOT EXISTS one_from_each boolean NOT NULL DEFAULT false;

-- One row per band, not per route.
ALTER TABLE approval_route_rules DROP CONSTRAINT IF EXISTS approval_route_rules_pkey;
ALTER TABLE approval_route_rules ADD CONSTRAINT approval_route_rules_pkey PRIMARY KEY (workspace_id, route_key, band);

-- A decision may need several people now (C95).
ALTER TABLE approval_route_rules DROP CONSTRAINT IF EXISTS approval_route_rules_decision_single;

ALTER TABLE approval_route_rules DROP CONSTRAINT IF EXISTS approval_route_rules_band_check;
ALTER TABLE approval_route_rules ADD CONSTRAINT approval_route_rules_band_check
  CHECK (band IN ('base', 'over'));

ALTER TABLE approval_route_rules DROP CONSTRAINT IF EXISTS approval_route_rules_over_currency_check;
ALTER TABLE approval_route_rules ADD CONSTRAINT approval_route_rules_over_currency_check
  CHECK (over_currency IS NULL OR over_currency ~ '^[A-Z]{3}$');

-- Only invoices and payments carry an amount; the base band never has one.
ALTER TABLE approval_route_rules DROP CONSTRAINT IF EXISTS approval_route_rules_band_amount;
ALTER TABLE approval_route_rules ADD CONSTRAINT approval_route_rules_band_amount CHECK (
  (band = 'base' AND over_minor IS NULL AND over_currency IS NULL)
  OR (band = 'over' AND over_minor > 0 AND over_currency IS NOT NULL AND route_key IN ('invoice', 'payment'))
);

ALTER TABLE approval_route_rules DROP CONSTRAINT IF EXISTS approval_route_rules_one_from_each_people;
ALTER TABLE approval_route_rules ADD CONSTRAINT approval_route_rules_one_from_each_people
  CHECK (NOT one_from_each OR approvals_required >= 2);

CREATE TABLE IF NOT EXISTS decision_confirmations (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  request_id   uuid NOT NULL REFERENCES requests (id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (request_id, user_id)
);
CREATE INDEX IF NOT EXISTS decision_confirmations_workspace_idx ON decision_confirmations (workspace_id, request_id);

ALTER TABLE decision_confirmations ENABLE ROW LEVEL SECURITY;
ALTER TABLE decision_confirmations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON decision_confirmations;
CREATE POLICY tenant_isolation ON decision_confirmations
  USING (workspace_id = app_workspace_id())
  WITH CHECK (workspace_id = app_workspace_id());

-- An audit record, like effect_confirmations: written once, never edited, and
-- never by the agent role (invariant 2).
GRANT SELECT, INSERT ON decision_confirmations TO app;
REVOKE ALL ON decision_confirmations FROM agent;
