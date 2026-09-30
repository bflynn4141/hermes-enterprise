-- One free GitHub responsibility on an existing immutable skill assignment.
-- Checks own the source allowance and frozen change evidence, independently
-- of the model run. Retry never grants a second source/model allowance.
CREATE TABLE IF NOT EXISTS partner_watch_checks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  owner_user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  assignment_id uuid NOT NULL REFERENCES enterprise_skill_assignments(id) ON DELETE RESTRICT,
  assignment_revision integer NOT NULL CHECK (assignment_revision > 0),
  screening_run_id uuid NOT NULL UNIQUE REFERENCES partner_screening_runs(id) ON DELETE RESTRICT,
  source_id text NOT NULL CHECK (source_id ~ '^(query|url):[0-9]$'),
  source_scope_sha256 text NOT NULL CHECK (source_scope_sha256 ~ '^[0-9a-f]{64}$'),
  max_api_requests integer NOT NULL CHECK (max_api_requests BETWEEN 1 AND 30),
  api_requests_used integer NOT NULL DEFAULT 0 CHECK (api_requests_used BETWEEN 0 AND 30),
  max_cost_usd_per_run numeric(8,6) NOT NULL CHECK (max_cost_usd_per_run BETWEEN 0.01 AND 0.25),
  max_cost_usd_per_day numeric(8,6) NOT NULL CHECK (max_cost_usd_per_day BETWEEN 0.01 AND 1),
  max_model_calls integer NOT NULL CHECK (max_model_calls BETWEEN 1 AND 8),
  status text NOT NULL DEFAULT 'checking' CHECK (status IN ('checking','baseline','unchanged','changed','failed','cancelled')),
  candidate_fingerprints jsonb NOT NULL DEFAULT '{}'::jsonb,
  changed_candidate_ids uuid[] NOT NULL DEFAULT '{}',
  selected_candidate_id uuid REFERENCES partner_candidates(id) ON DELETE RESTRICT,
  previous_screening_run_id uuid REFERENCES partner_screening_runs(id) ON DELETE RESTRICT,
  change_summary jsonb NOT NULL DEFAULT '[]'::jsonb,
  run_id uuid UNIQUE REFERENCES runs(id) ON DELETE RESTRICT,
  review_id uuid UNIQUE REFERENCES requests(id) ON DELETE RESTRICT,
  error_code text,
  checked_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  cancelled_at timestamptz,
  CHECK (max_cost_usd_per_day >= max_cost_usd_per_run),
  CHECK (api_requests_used <= max_api_requests)
);
CREATE INDEX IF NOT EXISTS partner_watch_checks_agent_idx
  ON partner_watch_checks(workspace_id,agent_id,checked_at DESC);
ALTER TABLE partner_watch_checks ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_watch_checks FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON partner_watch_checks;
CREATE POLICY tenant_isolation ON partner_watch_checks
  USING (workspace_id=app_workspace_id()) WITH CHECK (workspace_id=app_workspace_id());
GRANT SELECT,INSERT,UPDATE ON partner_watch_checks TO app;
GRANT SELECT ON partner_watch_checks TO agent;
REVOKE INSERT,UPDATE,DELETE ON partner_watch_checks FROM agent;
REVOKE DELETE ON partner_watch_checks FROM app;

CREATE OR REPLACE FUNCTION guard_partner_watch_check() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF ROW(NEW.workspace_id,NEW.agent_id,NEW.owner_user_id,NEW.assignment_id,NEW.assignment_revision,
         NEW.screening_run_id,NEW.source_id,NEW.source_scope_sha256,NEW.max_api_requests,
         NEW.max_cost_usd_per_run,NEW.max_cost_usd_per_day,NEW.max_model_calls,NEW.checked_at)
     IS DISTINCT FROM
     ROW(OLD.workspace_id,OLD.agent_id,OLD.owner_user_id,OLD.assignment_id,OLD.assignment_revision,
         OLD.screening_run_id,OLD.source_id,OLD.source_scope_sha256,OLD.max_api_requests,
         OLD.max_cost_usd_per_run,OLD.max_cost_usd_per_day,OLD.max_model_calls,OLD.checked_at)
     OR NEW.api_requests_used < OLD.api_requests_used
     OR (OLD.status <> 'checking' AND ROW(NEW.status,NEW.candidate_fingerprints,NEW.changed_candidate_ids,NEW.selected_candidate_id,NEW.previous_screening_run_id,NEW.change_summary)
       IS DISTINCT FROM ROW(OLD.status,OLD.candidate_fingerprints,OLD.changed_candidate_ids,OLD.selected_candidate_id,OLD.previous_screening_run_id,OLD.change_summary))
     OR (OLD.run_id IS NOT NULL AND NEW.run_id IS DISTINCT FROM OLD.run_id)
     OR (OLD.review_id IS NOT NULL AND NEW.review_id IS DISTINCT FROM OLD.review_id) THEN
    RAISE EXCEPTION 'partner watch inputs and outcomes are immutable';
  END IF;
  IF OLD.cancelled_at IS NOT NULL AND NEW.cancelled_at IS DISTINCT FROM OLD.cancelled_at THEN
    RAISE EXCEPTION 'watch cancellation is immutable';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS partner_watch_check_guard ON partner_watch_checks;
CREATE TRIGGER partner_watch_check_guard BEFORE UPDATE ON partner_watch_checks
  FOR EACH ROW EXECUTE FUNCTION guard_partner_watch_check();

-- Read-only, tenant-scoped gate shared by source, model, tool and retry paths.
-- Presence of a check identifies watch work even after it loses authority.
CREATE OR REPLACE FUNCTION partner_watch_check_authorized(check_id uuid) RETURNS boolean
LANGUAGE sql STABLE AS $$
  SELECT EXISTS (
    SELECT 1 FROM partner_watch_checks c
    JOIN enterprise_skill_assignments a ON a.workspace_id=c.workspace_id AND a.id=c.assignment_id AND a.agent_id=c.agent_id
    JOIN agents agent ON agent.workspace_id=c.workspace_id AND agent.id=c.agent_id
    JOIN members m ON m.workspace_id=c.workspace_id AND m.user_id=c.owner_user_id AND m.status='active'
    WHERE c.id=check_id AND c.workspace_id=app_workspace_id()
      AND c.cancelled_at IS NULL
      AND a.revision=c.assignment_revision AND a.state='active' AND a.removed_at IS NULL
      AND a.skill_key='partner-program-screening' AND a.config->>'source'='github'
      AND a.config#>>'{github_watch,enabled}'='true' AND a.schedule->>'enabled'='true'
      AND agent.status='started'
      AND EXISTS (SELECT 1 FROM agent_owners o WHERE o.workspace_id=c.workspace_id AND o.agent_id=c.agent_id AND o.member_id=m.id)
      AND NOT EXISTS (SELECT 1 FROM agent_owners o WHERE o.workspace_id=c.workspace_id AND o.agent_id=c.agent_id AND o.member_id<>m.id)
      AND NOT EXISTS (SELECT 1 FROM enterprise_team_agents t WHERE t.workspace_id=c.workspace_id AND t.agent_id=c.agent_id AND t.principal_user_id<>c.owner_user_id)
  )
$$;
REVOKE ALL ON FUNCTION partner_watch_check_authorized(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION partner_watch_check_authorized(uuid) TO app,agent;
