-- AgentCash sources may charge fractional cents (for example $0.005 for one
-- read-only X search). Preserve the settled per-call amount instead of
-- rounding it to the nearest cent in the screening audit row.
ALTER TABLE partner_screening_runs
  ALTER COLUMN monetary_cost_usd TYPE numeric(7,3)
  USING monetary_cost_usd::numeric(7,3);
