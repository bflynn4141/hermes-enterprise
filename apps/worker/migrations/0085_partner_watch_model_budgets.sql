-- Reservations survive runtime retries. A lost response cannot refund its cap.
-- All daily admission for one workspace/agent serializes on the same UTC-day
-- advisory lock, including checks created after an assignment/owner change.
CREATE TABLE IF NOT EXISTS partner_watch_model_reservations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  check_id uuid NOT NULL REFERENCES partner_watch_checks(id) ON DELETE RESTRICT,
  run_id uuid NOT NULL REFERENCES runs(id) ON DELETE RESTRICT,
  run_attempt integer NOT NULL CHECK (run_attempt > 0),
  model_id text NOT NULL REFERENCES catalog(model_id),
  budget_day date NOT NULL,
  input_token_bound bigint NOT NULL CHECK (input_token_bound >= 0),
  output_token_bound integer NOT NULL CHECK (output_token_bound BETWEEN 1 AND 2048),
  input_price numeric NOT NULL CHECK (input_price >= 0 AND input_price < 'Infinity'::numeric),
  output_price numeric NOT NULL CHECK (output_price >= 0 AND output_price < 'Infinity'::numeric),
  cached_input_price numeric NOT NULL CHECK (cached_input_price >= 0 AND cached_input_price < 'Infinity'::numeric),
  pricing_verified_on date NOT NULL,
  reserved_cost_usd numeric(14,8) NOT NULL CHECK (reserved_cost_usd >= 0),
  consumed_cost_usd numeric(14,8),
  status text NOT NULL DEFAULT 'reserved' CHECK (status IN ('reserved','completed','rejected','unresolved','cancelled')),
  input_tokens bigint,
  output_tokens integer,
  cached_input_tokens bigint,
  created_at timestamptz NOT NULL DEFAULT now(),
  settled_at timestamptz,
  CHECK (consumed_cost_usd IS NULL OR (consumed_cost_usd >= 0 AND consumed_cost_usd <= reserved_cost_usd))
);
CREATE INDEX IF NOT EXISTS partner_watch_model_reservations_day_idx ON partner_watch_model_reservations(workspace_id,agent_id,budget_day);
CREATE INDEX IF NOT EXISTS partner_watch_model_reservations_check_idx ON partner_watch_model_reservations(check_id);
ALTER TABLE partner_watch_model_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE partner_watch_model_reservations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON partner_watch_model_reservations;
CREATE POLICY tenant_isolation ON partner_watch_model_reservations
  USING (workspace_id=app_workspace_id()) WITH CHECK (workspace_id=app_workspace_id());
GRANT SELECT ON partner_watch_model_reservations TO app,agent;
REVOKE INSERT,UPDATE,DELETE ON partner_watch_model_reservations FROM app,agent;

CREATE OR REPLACE FUNCTION reserve_partner_watch_model_budget(
  target_run_id uuid, target_model_id text, target_input_token_bound bigint,
  target_output_token_bound integer, target_reserved_cost_usd numeric, target_run_attempt integer
) RETURNS TABLE (reservation_id uuid, budget_id uuid)
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE
  c partner_watch_checks%ROWTYPE;
  r runs%ROWTYPE;
  m catalog%ROWTYPE;
  day date := (now() AT TIME ZONE 'UTC')::date;
  input_rate numeric; output_rate numeric; cached_rate numeric; cost numeric;
  spent_run numeric; spent_day numeric; calls integer; new_id uuid;
BEGIN
  IF target_input_token_bound IS NULL OR target_input_token_bound < 0
     OR target_output_token_bound IS NULL OR target_output_token_bound NOT BETWEEN 1 AND 2048
     OR target_reserved_cost_usd IS NULL OR target_reserved_cost_usd < 0
     OR target_reserved_cost_usd >= 'Infinity'::numeric OR target_run_attempt IS NULL THEN
    RAISE EXCEPTION 'partner_watch_budget_invalid_bound';
  END IF;
  SELECT * INTO c FROM partner_watch_checks WHERE run_id=target_run_id AND workspace_id=app_workspace_id();
  IF NOT FOUND THEN RAISE EXCEPTION 'partner_watch_budget_missing'; END IF;
  PERFORM pg_advisory_xact_lock(hashtextextended('partner-watch:' || c.workspace_id || ':' || c.agent_id || ':' || day,0));
  SELECT * INTO r FROM runs WHERE id=target_run_id AND workspace_id=c.workspace_id FOR UPDATE;
  IF NOT FOUND OR r.status<>'working' OR r.stop_requested OR r.runtime_kind<>'hermes'
     OR r.attempt<>target_run_attempt OR r.runtime_attempt IS DISTINCT FROM r.attempt
     OR r.agent_id IS DISTINCT FROM c.agent_id THEN
    RAISE EXCEPTION 'partner_watch_budget_run_inactive';
  END IF;
  IF c.status<>'changed' OR NOT partner_watch_check_authorized(c.id) THEN
    RAISE EXCEPTION 'partner_watch_budget_authorization_stale';
  END IF;
  IF r.model_id IS DISTINCT FROM target_model_id THEN RAISE EXCEPTION 'partner_watch_budget_model_mismatch'; END IF;
  SELECT * INTO m FROM catalog WHERE model_id=target_model_id AND disabled_reason IS NULL AND supports_tools;
  IF NOT FOUND OR m.pricing_verified_on IS NULL OR m.pricing_verified_on > CURRENT_DATE
     OR m.context_length IS NULL OR target_input_token_bound > m.context_length-target_output_token_bound
     OR COALESCE(m.pricing_per_million->>'input','') !~ '^[0-9]+([.][0-9]+)?$'
     OR COALESCE(m.pricing_per_million->>'output','') !~ '^[0-9]+([.][0-9]+)?$'
     OR (m.pricing_per_million->>'cached_input' IS NOT NULL AND
         m.pricing_per_million->>'cached_input' !~ '^[0-9]+([.][0-9]+)?$') THEN
    RAISE EXCEPTION 'partner_watch_budget_price_unknown';
  END IF;
  IF target_input_token_bound <> m.context_length-target_output_token_bound THEN
    RAISE EXCEPTION 'partner_watch_budget_context_bound_unknown';
  END IF;
  input_rate := (m.pricing_per_million->>'input')::numeric;
  output_rate := (m.pricing_per_million->>'output')::numeric;
  cached_rate := COALESCE((m.pricing_per_million->>'cached_input')::numeric,input_rate);
  -- Recompute rather than trusting caller supplied dollars. Pin the verified
  -- rates so a later catalog change cannot alter accounting for this call.
  cost := ceil((target_input_token_bound*greatest(input_rate,cached_rate)+target_output_token_bound*output_rate)/1000000*100000000)/100000000;
  IF target_reserved_cost_usd < cost THEN RAISE EXCEPTION 'partner_watch_budget_price_changed'; END IF;
  SELECT count(*)::integer, COALESCE(sum(COALESCE(consumed_cost_usd,reserved_cost_usd)),0)
    INTO calls,spent_run FROM partner_watch_model_reservations WHERE check_id=c.id AND workspace_id=c.workspace_id;
  IF calls >= c.max_model_calls THEN RAISE EXCEPTION 'partner_watch_budget_call_limit'; END IF;
  IF spent_run+cost > c.max_cost_usd_per_run THEN RAISE EXCEPTION 'partner_watch_budget_cost_limit'; END IF;
  SELECT COALESCE(sum(COALESCE(consumed_cost_usd,reserved_cost_usd)),0) INTO spent_day
    FROM partner_watch_model_reservations WHERE workspace_id=c.workspace_id AND agent_id=c.agent_id AND budget_day=day;
  IF spent_day+cost > c.max_cost_usd_per_day THEN RAISE EXCEPTION 'partner_watch_budget_daily_cost_limit'; END IF;
  INSERT INTO partner_watch_model_reservations(workspace_id,agent_id,check_id,run_id,run_attempt,model_id,budget_day,
    input_token_bound,output_token_bound,input_price,output_price,cached_input_price,pricing_verified_on,reserved_cost_usd)
    VALUES(c.workspace_id,c.agent_id,c.id,r.id,r.attempt,target_model_id,day,target_input_token_bound,target_output_token_bound,
      input_rate,output_rate,cached_rate,m.pricing_verified_on,cost) RETURNING id INTO new_id;
  RETURN QUERY SELECT new_id,c.id;
END $$;

CREATE OR REPLACE FUNCTION reconcile_partner_watch_model_budget(
  target_reservation_id uuid, target_resolution text, target_input_tokens bigint,
  target_output_tokens integer, target_cached_input_tokens bigint, target_actual_cost_usd numeric
) RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE x partner_watch_model_reservations%ROWTYPE; cost numeric; resolution text;
BEGIN
  SELECT * INTO x FROM partner_watch_model_reservations
    WHERE id=target_reservation_id AND workspace_id=app_workspace_id() FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'partner_watch_budget_reservation_missing'; END IF;
  IF x.status<>'reserved' THEN RETURN true; END IF;
  IF target_resolution IS NULL OR target_resolution NOT IN ('completed','rejected','unresolved','cancelled') THEN
    RAISE EXCEPTION 'partner_watch_budget_invalid_resolution';
  END IF;
  resolution := target_resolution;
  -- Any malformed/over-bound usage holds the original cap, rather than losing
  -- accounting entirely or trusting an understated actual-cost parameter.
  IF resolution='completed' AND (target_input_tokens IS NULL OR target_input_tokens<0 OR target_input_tokens>x.input_token_bound
      OR target_output_tokens IS NULL OR target_output_tokens<0 OR target_output_tokens>x.output_token_bound
      OR target_cached_input_tokens IS NULL OR target_cached_input_tokens<0 OR target_cached_input_tokens>target_input_tokens) THEN
    resolution := 'unresolved';
  END IF;
  IF resolution='completed' THEN
    cost := ceil(((target_input_tokens-target_cached_input_tokens)*x.input_price+target_cached_input_tokens*x.cached_input_price
      +target_output_tokens*x.output_price)/1000000*100000000)/100000000;
  ELSIF resolution IN ('rejected','cancelled') THEN cost := 0;
  ELSE cost := x.reserved_cost_usd;
  END IF;
  UPDATE partner_watch_model_reservations SET status=resolution, consumed_cost_usd=cost,
    input_tokens=CASE WHEN resolution='completed' THEN target_input_tokens END,
    output_tokens=CASE WHEN resolution='completed' THEN target_output_tokens END,
    cached_input_tokens=CASE WHEN resolution='completed' THEN target_cached_input_tokens END,
    settled_at=now() WHERE id=x.id;
  RETURN true;
END $$;
REVOKE ALL ON FUNCTION reserve_partner_watch_model_budget(uuid,text,bigint,integer,numeric,integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION reconcile_partner_watch_model_budget(uuid,text,bigint,integer,bigint,numeric) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION reserve_partner_watch_model_budget(uuid,text,bigint,integer,numeric,integer) TO app,agent;
GRANT EXECUTE ON FUNCTION reconcile_partner_watch_model_budget(uuid,text,bigint,integer,bigint,numeric) TO app,agent;

-- A stopped runtime cannot strand the selected source behind an unresolved
-- check. Only a persisted stopped run can cancel its unreviewed check; held
-- reservations still count against both the original run and the daily cap.
CREATE OR REPLACE FUNCTION cancel_stopped_partner_watch(target_run_id uuid) RETURNS integer
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public AS $$
DECLARE changed integer;
BEGIN
  UPDATE partner_watch_checks c SET cancelled_at=COALESCE(c.cancelled_at,now())
    FROM runs r WHERE r.id=target_run_id AND r.id=c.run_id AND r.workspace_id=c.workspace_id
      AND c.workspace_id=app_workspace_id() AND r.status='stopped' AND c.review_id IS NULL
      AND c.cancelled_at IS NULL;
  GET DIAGNOSTICS changed = ROW_COUNT;
  RETURN changed;
END $$;
REVOKE ALL ON FUNCTION cancel_stopped_partner_watch(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION cancel_stopped_partner_watch(uuid) TO app,agent;
