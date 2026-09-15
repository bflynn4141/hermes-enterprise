-- The mode a run was created in, fixed on the row.
--
-- Until now the engine read `sessions.mode` through a join, which means a
-- person switching the mode selector from Plan to Work while a run is in flight
-- would change what that run is allowed to do, halfway through. Modes are the
-- promise the product makes about what a conversation can do — "Plan writes
-- nothing" is not a promise you can keep if the answer is re-read every step —
-- so the mode is copied onto `runs` at creation and never looked up again.
--
-- Nullable with a backfill rather than NOT NULL DEFAULT: expand/contract, and
-- the reader coalesces to the session's mode so a rollback to the previous
-- code is still correct.

ALTER TABLE runs ADD COLUMN IF NOT EXISTS mode text;

UPDATE runs r
   SET mode = s.mode
  FROM sessions s
 WHERE s.id = r.session_id AND r.mode IS NULL;

ALTER TABLE runs DROP CONSTRAINT IF EXISTS runs_mode_check;
ALTER TABLE runs ADD CONSTRAINT runs_mode_check CHECK (mode IS NULL OR mode IN ('ask', 'plan', 'work'));
