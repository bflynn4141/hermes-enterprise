-- One explicitly requested Hermes creator/consultant discovery call may use
-- AgentCash Exa search across public LinkedIn and YouTube results. The fixed
-- $0.01 request is leased before payment and imported as sanitized evidence.

ALTER TABLE partner_screening_runs
  DROP CONSTRAINT IF EXISTS partner_screening_runs_source_check;
ALTER TABLE partner_screening_runs
  ADD CONSTRAINT partner_screening_runs_source_check
  CHECK (source IN ('github', 'agentcash_people', 'agentcash_creators'));

ALTER TABLE partner_source_artifacts
  DROP CONSTRAINT IF EXISTS partner_source_artifacts_source_check;
ALTER TABLE partner_source_artifacts
  ADD CONSTRAINT partner_source_artifacts_source_check
  CHECK (source IN ('github', 'agentcash_people', 'agentcash_creators'));
ALTER TABLE partner_source_artifacts
  DROP CONSTRAINT IF EXISTS partner_source_artifacts_kind_check;
ALTER TABLE partner_source_artifacts
  ADD CONSTRAINT partner_source_artifacts_kind_check
  CHECK (kind IN (
    'search_result', 'organization_profile', 'repository_snapshot',
    'person_profile', 'creator_profile', 'creator_content'
  ));

ALTER TABLE partner_candidates
  DROP CONSTRAINT IF EXISTS partner_candidates_source_check;
ALTER TABLE partner_candidates
  ADD CONSTRAINT partner_candidates_source_check
  CHECK (source IN ('github', 'agentcash_people', 'agentcash_creators'));

ALTER TABLE partner_screening_runs
  DROP CONSTRAINT IF EXISTS partner_screening_runs_agentcash_lease_check;
ALTER TABLE partner_screening_runs
  ADD CONSTRAINT partner_screening_runs_agentcash_lease_check
  CHECK (
    (source = 'github' AND agentcash_tool_call_id IS NULL)
    OR (source IN ('agentcash_people', 'agentcash_creators') AND (
      (api_requests_used = 0 AND agentcash_tool_call_id IS NULL)
      OR (api_requests_used = 1 AND agentcash_tool_call_id IS NOT NULL)
    ))
  );

ALTER TABLE partner_screening_runs
  DROP CONSTRAINT IF EXISTS partner_screening_runs_monetary_cost_check;
ALTER TABLE partner_screening_runs
  ADD CONSTRAINT partner_screening_runs_monetary_cost_check
  CHECK (monetary_cost_usd >= 0 AND monetary_cost_usd <= 0.15);
