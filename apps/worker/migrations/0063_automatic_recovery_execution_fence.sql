-- A scheduled recovery is admitted only for the managed, token-digest Hermes
-- runtime. Persist that server-owned decision so the Workflow can re-check the
-- same contract after a deployment or binding change, before choosing an
-- engine or submitting to a provider.
ALTER TABLE runs
  ADD COLUMN IF NOT EXISTS automatic_recovery boolean NOT NULL DEFAULT false;
