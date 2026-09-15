-- Expand-only runtime correlation. Enterprise ids and RLS remain authoritative.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS runtime_kind text NOT NULL DEFAULT 'legacy';
ALTER TABLE runs ADD COLUMN IF NOT EXISTS runtime_profile text;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS runtime_run_id text;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS runtime_session_id text;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS runtime_attempt integer;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS runtime_request jsonb;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS runtime_request_attempt integer;
CREATE UNIQUE INDEX IF NOT EXISTS runs_runtime_identity
  ON runs(agent_id, runtime_run_id) WHERE runtime_run_id IS NOT NULL;
ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_runtime_kind;
ALTER TABLE runs ADD CONSTRAINT runs_runtime_kind CHECK (runtime_kind IN ('legacy', 'hermes'));
ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_runtime_profile_matches_agent;
ALTER TABLE runs ADD CONSTRAINT runs_runtime_profile_matches_agent CHECK (
  runtime_profile IS NULL OR runtime_profile = 'agent-' || agent_id::text
);
