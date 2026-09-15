-- Durable attempt timing without SELECT on the agent's insert-only outbox.
-- A replay reuses the original start; only a new attempt resets human waits.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS runtime_started_at timestamptz;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS runtime_wait_started_at timestamptz;
ALTER TABLE runs ADD COLUMN IF NOT EXISTS runtime_wait_ms bigint NOT NULL DEFAULT 0;
