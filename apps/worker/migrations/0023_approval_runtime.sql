-- Durable approval continuations and hard runtime-budget reservations.
--
-- The agent may record an intent while its proposal is still pending. Only the
-- app role (the human decision path) may activate/cancel that intent or attach
-- the reviewed budget. The model proxy reserves through SECURITY DEFINER
-- functions: the agent role never receives UPDATE on the budget tables.

CREATE TABLE IF NOT EXISTS approval_continuations (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id             uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  request_id               uuid NOT NULL REFERENCES requests (id) ON DELETE CASCADE,
  authorization_revision   integer NOT NULL CHECK (authorization_revision >= 1),
  authorization_hash       text NOT NULL CHECK (authorization_hash ~ '^sha256:[0-9a-f]{64}$'),
  agent_id                  uuid NOT NULL REFERENCES agents (id) ON DELETE RESTRICT,
  runtime_profile           text NOT NULL,
  session_id                uuid NOT NULL REFERENCES sessions (id) ON DELETE RESTRICT,
  source_run_id             uuid REFERENCES runs (id) ON DELETE SET NULL,
  source_tool_call_id       text,
  continuation_payload     jsonb NOT NULL CHECK (jsonb_typeof(continuation_payload) = 'object'),
  dependency_request_ids   uuid[] NOT NULL DEFAULT '{}',
  state                     text NOT NULL DEFAULT 'pending_authorization'
    CHECK (state IN (
      'pending_authorization', 'blocked_profile', 'blocked_dependencies', 'ready', 'admitted',
      'completed', 'declined', 'changes_requested', 'expired', 'superseded', 'cancelled', 'failed'
    )),
  expires_at                timestamptz NOT NULL,
  admitted_run_id           uuid REFERENCES runs (id) ON DELETE SET NULL,
  blocked_reason            text,
  created_at                timestamptz NOT NULL DEFAULT now(),
  updated_at                timestamptz NOT NULL DEFAULT now(),
  admitted_at               timestamptz,
  CONSTRAINT approval_continuations_revision UNIQUE (request_id, authorization_revision),
  CONSTRAINT approval_continuations_profile_matches_agent
    CHECK (runtime_profile = 'agent-' || agent_id::text),
  CONSTRAINT approval_continuations_admission_shape CHECK (
    (state = 'admitted' AND admitted_run_id IS NOT NULL AND admitted_at IS NOT NULL)
    OR state <> 'admitted'
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS approval_continuations_source_call_key
  ON approval_continuations (source_run_id, source_tool_call_id)
  WHERE source_run_id IS NOT NULL AND source_tool_call_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS approval_continuations_admitted_run_key
  ON approval_continuations (admitted_run_id) WHERE admitted_run_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS approval_continuations_request_idx
  ON approval_continuations (workspace_id, request_id, authorization_revision DESC);
CREATE INDEX IF NOT EXISTS approval_continuations_ready_idx
  ON approval_continuations (workspace_id, state, updated_at)
  WHERE state IN ('ready', 'blocked_profile', 'blocked_dependencies');

ALTER TABLE approval_requests DROP CONSTRAINT IF EXISTS approval_requests_continuation_fk;
ALTER TABLE approval_requests ADD CONSTRAINT approval_requests_continuation_fk
  FOREIGN KEY (continuation_id) REFERENCES approval_continuations (id) ON DELETE SET NULL;

DROP TRIGGER IF EXISTS approval_continuations_updated_at ON approval_continuations;
CREATE TRIGGER approval_continuations_updated_at BEFORE UPDATE ON approval_continuations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS approval_runtime_budgets (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id               uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  continuation_id            uuid NOT NULL UNIQUE REFERENCES approval_continuations (id) ON DELETE CASCADE,
  request_id                 uuid NOT NULL REFERENCES requests (id) ON DELETE CASCADE,
  authorization_revision     integer NOT NULL CHECK (authorization_revision >= 1),
  authorization_hash         text NOT NULL CHECK (authorization_hash ~ '^sha256:[0-9a-f]{64}$'),
  model_id                   text NOT NULL REFERENCES catalog (model_id),
  currency                   text NOT NULL DEFAULT 'USD' CHECK (currency = 'USD'),
  cost_cap_usd               numeric(14, 8) NOT NULL CHECK (cost_cap_usd >= 0),
  total_token_cap            bigint NOT NULL CHECK (total_token_cap > 0),
  call_cap                   integer NOT NULL CHECK (call_cap > 0),
  max_output_tokens_per_call integer NOT NULL CHECK (max_output_tokens_per_call > 0),
  max_parallel_calls         integer NOT NULL DEFAULT 1 CHECK (max_parallel_calls > 0),
  retry_cap                  integer NOT NULL DEFAULT 0 CHECK (retry_cap >= 0),
  reserved_cost_usd          numeric(14, 8) NOT NULL DEFAULT 0 CHECK (reserved_cost_usd >= 0),
  actual_cost_usd            numeric(14, 8) NOT NULL DEFAULT 0 CHECK (actual_cost_usd >= 0),
  reserved_tokens            bigint NOT NULL DEFAULT 0 CHECK (reserved_tokens >= 0),
  actual_tokens              bigint NOT NULL DEFAULT 0 CHECK (actual_tokens >= 0),
  calls_reserved             integer NOT NULL DEFAULT 0 CHECK (calls_reserved >= 0),
  calls_reconciled           integer NOT NULL DEFAULT 0 CHECK (calls_reconciled >= 0),
  state                      text NOT NULL DEFAULT 'active'
    CHECK (state IN ('active', 'exhausted', 'closed', 'cancelled')),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT approval_runtime_budgets_revision UNIQUE (request_id, authorization_revision),
  CONSTRAINT approval_runtime_budgets_binding CHECK (length(authorization_hash) = 71)
);
CREATE INDEX IF NOT EXISTS approval_runtime_budgets_request_idx
  ON approval_runtime_budgets (workspace_id, request_id, authorization_revision DESC);

DROP TRIGGER IF EXISTS approval_runtime_budgets_updated_at ON approval_runtime_budgets;
CREATE TRIGGER approval_runtime_budgets_updated_at BEFORE UPDATE ON approval_runtime_budgets
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS approval_model_reservations (
  id                         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id               uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  budget_id                  uuid NOT NULL REFERENCES approval_runtime_budgets (id) ON DELETE CASCADE,
  run_id                     uuid NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  model_id                   text NOT NULL REFERENCES catalog (model_id),
  input_token_bound          bigint NOT NULL CHECK (input_token_bound >= 0),
  output_token_bound         integer NOT NULL CHECK (output_token_bound > 0),
  reserved_cost_usd          numeric(14, 8) NOT NULL CHECK (reserved_cost_usd >= 0),
  actual_input_tokens        bigint,
  actual_output_tokens       bigint,
  actual_cached_input_tokens bigint,
  actual_cost_usd            numeric(14, 8),
  status                     text NOT NULL DEFAULT 'reserved'
    CHECK (status IN ('reserved', 'completed', 'rejected', 'unresolved', 'cancelled')),
  created_at                 timestamptz NOT NULL DEFAULT now(),
  reconciled_at              timestamptz
);
CREATE INDEX IF NOT EXISTS approval_model_reservations_budget_idx
  ON approval_model_reservations (budget_id, status, created_at);
CREATE INDEX IF NOT EXISTS approval_model_reservations_run_idx
  ON approval_model_reservations (workspace_id, run_id, created_at);

-- These tables were added after 0003 generated the tenant policies, so apply
-- the same fail-closed policy explicitly. hermes_tenant_tables() discovers
-- them automatically for the drift tests and future migrations.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'approval_continuations',
    'approval_runtime_budgets',
    'approval_model_reservations'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (workspace_id = app_workspace_id()) WITH CHECK (workspace_id = app_workspace_id())',
      t
    );
  END LOOP;
END $$;

-- A model can only create a pending continuation for its own current run. It
-- cannot activate it, alter a reviewed revision or swap the profile/session.
CREATE OR REPLACE FUNCTION approval_continuation_agent_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  DECLARE
    source_workspace uuid;
    source_agent uuid;
    source_session uuid;
    source_status text;
    target_session_agent uuid;
    approval_payload jsonb;
    request_status text;
    approval_dependencies uuid[];
  BEGIN
    IF current_user <> 'agent' THEN
      RETURN NEW;
    END IF;
    IF NEW.state <> 'pending_authorization' OR NEW.admitted_run_id IS NOT NULL THEN
      RAISE EXCEPTION 'agent may only create a pending approval continuation'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    SELECT workspace_id, agent_id, session_id, status
      INTO source_workspace, source_agent, source_session, source_status
      FROM runs WHERE id = NEW.source_run_id;
    SELECT s.agent_id INTO target_session_agent
      FROM sessions s WHERE s.id = NEW.session_id AND s.workspace_id = NEW.workspace_id;
    SELECT r.payload, r.status INTO approval_payload, request_status
      FROM requests r WHERE r.id = NEW.request_id AND r.workspace_id = NEW.workspace_id AND r.kind = 'approval';
    SELECT COALESCE(array_agg(value::uuid ORDER BY ordinal), '{}')
      INTO approval_dependencies
      FROM jsonb_array_elements_text(
        COALESCE(approval_payload #> '{context,source,dependent_request_ids}', '[]'::jsonb)
      ) WITH ORDINALITY AS dependency(value, ordinal);
    IF source_workspace IS DISTINCT FROM NEW.workspace_id
       OR source_status NOT IN ('working', 'waiting')
       OR NEW.source_tool_call_id IS NULL
       OR target_session_agent IS DISTINCT FROM NEW.agent_id
       OR request_status IS DISTINCT FROM 'pending'
       OR approval_payload #>> '{context,requester,agent_id}' IS DISTINCT FROM source_agent::text
       OR approval_payload #>> '{context,source,run_id}' IS DISTINCT FROM NEW.source_run_id::text
       OR approval_payload #>> '{context,source,session_id}' IS DISTINCT FROM source_session::text
       OR (approval_payload #>> '{authorization,revision}')::integer IS DISTINCT FROM NEW.authorization_revision
       OR approval_payload #>> '{authorization,hash}' IS DISTINCT FROM NEW.authorization_hash
       OR (approval_payload #>> '{authorization,expires_at}')::timestamptz IS DISTINCT FROM NEW.expires_at
       OR approval_dependencies IS DISTINCT FROM NEW.dependency_request_ids
       OR NEW.continuation_payload IS DISTINCT FROM jsonb_build_object(
         'target_agent_id', NEW.agent_id,
         'target_session_id', NEW.session_id
       )
       OR (
         NEW.agent_id IS DISTINCT FROM source_agent
         AND NOT EXISTS (
           SELECT 1 FROM jsonb_array_elements_text(approval_payload #> '{context,target_agent_ids}') AS target(id)
           WHERE target.id = NEW.agent_id::text
         )
       ) THEN
      RAISE EXCEPTION 'approval continuation must be bound to the active proposing run'
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END $$;

DROP TRIGGER IF EXISTS approval_continuation_agent_insert ON approval_continuations;
CREATE TRIGGER approval_continuation_agent_insert BEFORE INSERT ON approval_continuations
  FOR EACH ROW EXECUTE FUNCTION approval_continuation_agent_guard();

-- Reserve before a cost-incurring model call. The function locks the reviewed
-- budget, verifies the admitted run/revision/profile binding is still live,
-- and refuses calls that do not fit. Error strings are stable reason codes the
-- bridge maps to bounded API errors; no reviewed payload text is exposed.
CREATE OR REPLACE FUNCTION reserve_approval_model_budget(
  target_run_id uuid,
  target_model_id text,
  target_input_token_bound bigint,
  target_output_token_bound integer,
  target_reserved_cost_usd numeric
) RETURNS TABLE (reservation_id uuid, budget_id uuid)
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
  AS $$
  DECLARE
    b approval_runtime_budgets%ROWTYPE;
    c approval_continuations%ROWTYPE;
    r runs%ROWTYPE;
    active_reservations integer;
    token_bound bigint;
    new_id uuid;
  BEGIN
    IF target_input_token_bound < 0 OR target_output_token_bound <= 0 OR target_reserved_cost_usd < 0 THEN
      RAISE EXCEPTION 'approval_budget_invalid_bound';
    END IF;

    SELECT * INTO r FROM runs
      WHERE id = target_run_id AND workspace_id = app_workspace_id()
      FOR UPDATE;
    IF NOT FOUND OR r.status <> 'working' OR r.stop_requested OR r.runtime_kind <> 'hermes' THEN
      RAISE EXCEPTION 'approval_budget_run_inactive';
    END IF;

    SELECT * INTO c FROM approval_continuations
      WHERE admitted_run_id = target_run_id AND workspace_id = app_workspace_id()
      FOR UPDATE;
    IF NOT FOUND OR c.state <> 'admitted' OR c.expires_at <= now()
       OR c.agent_id IS DISTINCT FROM r.agent_id
       OR c.session_id IS DISTINCT FROM r.session_id
       OR c.runtime_profile IS DISTINCT FROM r.runtime_profile THEN
      RAISE EXCEPTION 'approval_budget_authorization_stale';
    END IF;
    IF NOT EXISTS (
      SELECT 1 FROM approval_requests ar
       WHERE ar.workspace_id = app_workspace_id()
         AND ar.request_id = c.request_id
         AND ar.status = 'approved'
         AND ar.authorization_revision = c.authorization_revision
         AND ar.authorization_hash = c.authorization_hash
         AND ar.work_status = 'admitted'
         AND ar.continuation_id = c.id
    ) THEN
      RAISE EXCEPTION 'approval_budget_authorization_stale';
    END IF;

    SELECT * INTO b FROM approval_runtime_budgets
      WHERE continuation_id = c.id AND workspace_id = app_workspace_id()
      FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'approval_budget_missing';
    END IF;
    IF b.authorization_revision <> c.authorization_revision
       OR b.authorization_hash <> c.authorization_hash THEN
      RAISE EXCEPTION 'approval_budget_authorization_stale';
    END IF;
    IF b.state <> 'active' THEN
      RAISE EXCEPTION 'approval_budget_exhausted';
    END IF;
    IF b.model_id <> target_model_id OR r.model_id <> target_model_id THEN
      RAISE EXCEPTION 'approval_budget_model_mismatch';
    END IF;
    IF target_output_token_bound > b.max_output_tokens_per_call THEN
      RAISE EXCEPTION 'approval_budget_output_bound_exceeded';
    END IF;

    SELECT count(*)::integer INTO active_reservations
      FROM approval_model_reservations x
      WHERE x.budget_id = b.id AND x.status = 'reserved';
    IF active_reservations >= b.max_parallel_calls THEN
      RAISE EXCEPTION 'approval_budget_parallel_limit';
    END IF;
    IF b.calls_reserved >= b.call_cap THEN
      RAISE EXCEPTION 'approval_budget_call_limit';
    END IF;

    token_bound := target_input_token_bound + target_output_token_bound;
    IF b.actual_tokens + b.reserved_tokens + token_bound > b.total_token_cap THEN
      RAISE EXCEPTION 'approval_budget_token_limit';
    END IF;
    IF b.actual_cost_usd + b.reserved_cost_usd + target_reserved_cost_usd > b.cost_cap_usd THEN
      RAISE EXCEPTION 'approval_budget_cost_limit';
    END IF;

    INSERT INTO approval_model_reservations (
      workspace_id, budget_id, run_id, model_id, input_token_bound,
      output_token_bound, reserved_cost_usd
    ) VALUES (
      app_workspace_id(), b.id, target_run_id, target_model_id,
      target_input_token_bound, target_output_token_bound, target_reserved_cost_usd
    ) RETURNING id INTO new_id;

    UPDATE approval_runtime_budgets
      SET reserved_cost_usd = reserved_cost_usd + target_reserved_cost_usd,
          reserved_tokens = reserved_tokens + token_bound,
          calls_reserved = calls_reserved + 1,
          state = CASE WHEN calls_reserved + 1 >= call_cap THEN 'exhausted' ELSE state END
      WHERE id = b.id;

    RETURN QUERY SELECT new_id, b.id;
  END $$;

-- Reconcile exactly once. When the provider accepted a call but no trustworthy
-- usage was returned (disconnect/cancel), `unresolved` consumes the reservation
-- upper bound rather than silently releasing money that may have been billed.
CREATE OR REPLACE FUNCTION reconcile_approval_model_budget(
  target_reservation_id uuid,
  resolution text,
  target_input_tokens bigint DEFAULT NULL,
  target_output_tokens bigint DEFAULT NULL,
  target_cached_input_tokens bigint DEFAULT NULL,
  target_actual_cost_usd numeric DEFAULT NULL
) RETURNS boolean
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
  AS $$
  DECLARE
    x approval_model_reservations%ROWTYPE;
    b approval_runtime_budgets%ROWTYPE;
    consumed_cost numeric;
    consumed_tokens bigint;
  BEGIN
    IF resolution NOT IN ('completed', 'rejected', 'unresolved', 'cancelled') THEN
      RAISE EXCEPTION 'approval_budget_invalid_resolution';
    END IF;
    SELECT * INTO x FROM approval_model_reservations
      WHERE id = target_reservation_id AND workspace_id = app_workspace_id()
      FOR UPDATE;
    IF NOT FOUND THEN
      RETURN false;
    END IF;
    IF x.status <> 'reserved' THEN
      RETURN true;
    END IF;
    SELECT * INTO b FROM approval_runtime_budgets WHERE id = x.budget_id FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'approval_budget_missing';
    END IF;

    IF resolution = 'completed' THEN
      IF target_input_tokens IS NULL OR target_output_tokens IS NULL
         OR target_cached_input_tokens IS NULL OR target_actual_cost_usd IS NULL
         OR target_input_tokens < 0 OR target_output_tokens < 0
         OR target_cached_input_tokens < 0 OR target_actual_cost_usd < 0 THEN
        RAISE EXCEPTION 'approval_budget_invalid_actual_usage';
      END IF;
      consumed_cost := target_actual_cost_usd;
      consumed_tokens := target_input_tokens + target_output_tokens;
    ELSIF resolution IN ('rejected', 'cancelled') THEN
      consumed_cost := 0;
      consumed_tokens := 0;
    ELSE
      consumed_cost := x.reserved_cost_usd;
      consumed_tokens := x.input_token_bound + x.output_token_bound;
    END IF;

    UPDATE approval_model_reservations
      SET status = resolution,
          actual_input_tokens = target_input_tokens,
          actual_output_tokens = target_output_tokens,
          actual_cached_input_tokens = target_cached_input_tokens,
          actual_cost_usd = consumed_cost,
          reconciled_at = now()
      WHERE id = x.id;

    UPDATE approval_runtime_budgets
      SET reserved_cost_usd = greatest(0, reserved_cost_usd - x.reserved_cost_usd),
          reserved_tokens = greatest(0, reserved_tokens - (x.input_token_bound + x.output_token_bound)),
          actual_cost_usd = actual_cost_usd + consumed_cost,
          actual_tokens = actual_tokens + consumed_tokens,
          calls_reconciled = calls_reconciled + 1,
          state = CASE
            WHEN state IN ('closed', 'cancelled') THEN state
            WHEN actual_cost_usd + consumed_cost >= cost_cap_usd
              OR actual_tokens + consumed_tokens >= total_token_cap
              OR calls_reserved >= call_cap THEN 'exhausted'
            ELSE 'active'
          END
      WHERE id = b.id;
    RETURN true;
  END $$;

-- Project the terminal enterprise run into the human-visible work state. The
-- agent role may call this function but cannot choose the outcome: the
-- SECURITY DEFINER body locks and reads the already-persisted run status,
-- continuation revision and hard budget before deriving every update.
CREATE OR REPLACE FUNCTION project_approval_continuation_outcome(
  target_run_id uuid
) RETURNS text
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
  AS $$
  DECLARE
    r runs%ROWTYPE;
    c approval_continuations%ROWTYPE;
    b approval_runtime_budgets%ROWTYPE;
    can_retry boolean;
    outcome_reason text;
  BEGIN
    SELECT * INTO r FROM runs
      WHERE id = target_run_id AND workspace_id = app_workspace_id()
      FOR UPDATE;
    IF NOT FOUND THEN RETURN 'not_linked'; END IF;

    SELECT * INTO c FROM approval_continuations
      WHERE admitted_run_id = r.id AND workspace_id = app_workspace_id()
      FOR UPDATE;
    IF NOT FOUND THEN RETURN 'not_linked'; END IF;
    IF c.state <> 'admitted' THEN RETURN c.state; END IF;
    IF r.status NOT IN ('completed', 'stopped', 'error') THEN RETURN 'run_not_terminal'; END IF;

    SELECT * INTO b FROM approval_runtime_budgets
      WHERE continuation_id = c.id AND workspace_id = app_workspace_id()
      FOR UPDATE;
    IF NOT FOUND THEN
      RAISE EXCEPTION 'approval_budget_missing';
    END IF;

    IF r.status = 'error' THEN
      can_retry := c.expires_at > now()
        AND b.state = 'active'
        AND r.attempt < b.retry_cap + 1;
      outcome_reason := CASE
        WHEN can_retry THEN 'run_error_retry_available'
        WHEN c.expires_at <= now() THEN 'approval_retry_authorization_expired'
        WHEN b.state <> 'active' THEN 'approval_retry_budget_exhausted'
        ELSE 'approval_retry_limit'
      END;
      UPDATE approval_requests ar
        SET work_status = CASE WHEN can_retry THEN 'admitted' ELSE 'cancelled' END,
            work_reason = outcome_reason
        WHERE ar.request_id = c.request_id
          AND ar.authorization_revision = c.authorization_revision
          AND ar.authorization_hash = c.authorization_hash;
      IF NOT can_retry THEN
        UPDATE approval_continuations
          SET state = 'failed', blocked_reason = outcome_reason
          WHERE id = c.id;
        UPDATE approval_runtime_budgets SET state = 'cancelled' WHERE id = b.id;
      END IF;
      RETURN outcome_reason;
    END IF;

    UPDATE approval_continuations
      SET state = CASE WHEN r.status = 'completed' THEN 'completed' ELSE 'cancelled' END,
          blocked_reason = CASE WHEN r.status = 'stopped' THEN 'continuation_run_stopped' ELSE NULL END
      WHERE id = c.id;
    UPDATE approval_requests ar
      SET work_status = CASE WHEN r.status = 'completed' THEN 'completed' ELSE 'cancelled' END,
          work_reason = CASE WHEN r.status = 'stopped' THEN 'continuation_run_stopped' ELSE NULL END
      WHERE ar.request_id = c.request_id
        AND ar.authorization_revision = c.authorization_revision
        AND ar.authorization_hash = c.authorization_hash;
    UPDATE approval_runtime_budgets
      SET state = CASE WHEN r.status = 'completed' THEN 'closed' ELSE 'cancelled' END
      WHERE id = b.id;
    RETURN r.status;
  END $$;

REVOKE ALL ON FUNCTION reserve_approval_model_budget(uuid, text, bigint, integer, numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION reconcile_approval_model_budget(uuid, text, bigint, bigint, bigint, numeric) FROM PUBLIC;
REVOKE ALL ON FUNCTION project_approval_continuation_outcome(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reserve_approval_model_budget(uuid, text, bigint, integer, numeric) TO app, agent;
GRANT EXECUTE ON FUNCTION reconcile_approval_model_budget(uuid, text, bigint, bigint, bigint, numeric) TO app, agent;
GRANT EXECUTE ON FUNCTION project_approval_continuation_outcome(uuid) TO app, agent;

GRANT SELECT, INSERT, UPDATE ON approval_continuations TO app;
GRANT SELECT, INSERT, UPDATE ON approval_runtime_budgets, approval_model_reservations TO app;
GRANT SELECT, INSERT ON approval_continuations TO agent;
GRANT SELECT ON approval_runtime_budgets, approval_model_reservations TO agent;
REVOKE UPDATE, DELETE ON approval_continuations FROM agent;
REVOKE INSERT, UPDATE, DELETE ON approval_runtime_budgets, approval_model_reservations FROM agent;
