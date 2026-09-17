-- 0031_agentcash_people_screening.sql
-- Allow one paid, read-only person-search source. The runtime performs the
-- payment, while the Worker imports only a run-bound, sanitized response.

ALTER TABLE partner_screening_runs
  DROP CONSTRAINT IF EXISTS partner_screening_runs_source_check;
ALTER TABLE partner_screening_runs
  ADD CONSTRAINT partner_screening_runs_source_check
  CHECK (source IN ('github', 'agentcash_people'));

ALTER TABLE partner_screening_runs
  DROP CONSTRAINT IF EXISTS partner_screening_runs_authentication_check;
ALTER TABLE partner_screening_runs
  ADD CONSTRAINT partner_screening_runs_authentication_check
  CHECK (authentication IN ('authenticated', 'unauthenticated', 'wallet'));

ALTER TABLE partner_screening_runs
  ADD COLUMN IF NOT EXISTS monetary_cost_usd numeric(6,2) NOT NULL DEFAULT 0;
ALTER TABLE partner_screening_runs
  DROP CONSTRAINT IF EXISTS partner_screening_runs_monetary_cost_check;
ALTER TABLE partner_screening_runs
  ADD CONSTRAINT partner_screening_runs_monetary_cost_check
  CHECK (monetary_cost_usd >= 0 AND monetary_cost_usd <= 0.20);

ALTER TABLE partner_source_artifacts
  DROP CONSTRAINT IF EXISTS partner_source_artifacts_source_check;
ALTER TABLE partner_source_artifacts
  ADD CONSTRAINT partner_source_artifacts_source_check
  CHECK (source IN ('github', 'agentcash_people'));
ALTER TABLE partner_source_artifacts
  DROP CONSTRAINT IF EXISTS partner_source_artifacts_kind_check;
ALTER TABLE partner_source_artifacts
  ADD CONSTRAINT partner_source_artifacts_kind_check
  CHECK (kind IN ('search_result', 'organization_profile', 'repository_snapshot', 'person_profile'));

ALTER TABLE partner_candidates
  DROP CONSTRAINT IF EXISTS partner_candidates_source_check;
ALTER TABLE partner_candidates
  ADD CONSTRAINT partner_candidates_source_check
  CHECK (source IN ('github', 'agentcash_people'));
