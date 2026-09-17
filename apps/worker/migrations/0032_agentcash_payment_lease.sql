-- 0032_agentcash_payment_lease.sql
-- Reserve the one approved paid call before the runtime reaches AgentCash.
-- A transport failure after reservation stays non-retryable under a different
-- tool-call id, preferring a missed result over an accidental double payment.

ALTER TABLE partner_screening_runs
  ADD COLUMN IF NOT EXISTS agentcash_tool_call_id text;

-- Rows completed by the previous release paid before leases existed. Mark
-- them as historical; they are terminal and cannot authorize another call.
-- The migration owner temporarily lifts FORCE so it can reach every tenant;
-- the transaction restores FORCE before adding the invariant.
ALTER TABLE partner_screening_runs NO FORCE ROW LEVEL SECURITY;
UPDATE partner_screening_runs
   SET agentcash_tool_call_id = 'legacy-before-payment-lease'
 WHERE source = 'agentcash_people'
   AND api_requests_used = 1
   AND agentcash_tool_call_id IS NULL;
ALTER TABLE partner_screening_runs FORCE ROW LEVEL SECURITY;

ALTER TABLE partner_screening_runs
  DROP CONSTRAINT IF EXISTS partner_screening_runs_agentcash_lease_check;
ALTER TABLE partner_screening_runs
  ADD CONSTRAINT partner_screening_runs_agentcash_lease_check
  CHECK (
    (source <> 'agentcash_people' AND agentcash_tool_call_id IS NULL)
    OR (source = 'agentcash_people' AND (
      (api_requests_used = 0 AND agentcash_tool_call_id IS NULL)
      OR (api_requests_used = 1 AND agentcash_tool_call_id IS NOT NULL)
    ))
  );

-- Keep the database's terminal cost record aligned with the only request the
-- runtime can lease. This is a defense-in-depth invariant; the pre-call lease
-- validates the exact $0.15 request before the wallet is reached.
ALTER TABLE partner_screening_runs
  DROP CONSTRAINT IF EXISTS partner_screening_runs_monetary_cost_check;
ALTER TABLE partner_screening_runs
  ADD CONSTRAINT partner_screening_runs_monetary_cost_check
  CHECK (monetary_cost_usd >= 0 AND monetary_cost_usd <= 0.15);
