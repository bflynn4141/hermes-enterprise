-- 0012_ops.sql
-- M5a operations: the platform instance cap, the nightly validator's summary,
-- and the two columns workspace deletion needs.
--
-- Three things live here, and the first two are platform tables for the same
-- reason 0008's two are: the question they answer is cross-tenant by nature,
-- and the alternative is a database role that can read every tenant's rows,
-- which is the one thing this schema refuses to create. Both hold counts and
-- ids and nothing else, so a leak tells an attacker how busy the platform is
-- and nothing about anybody in it.

-- ---------------------------------------------------------------------------
-- The platform instance cap
-- ---------------------------------------------------------------------------

-- "Our platform cap is a maximum of Workflow instances per hour" (plan section
-- 5, Cost, spend, rate limits). It is deliberately *not* `rate_counters`: that
-- table is keyed by user, and the platform cap has to count an hour's
-- creations across every user in every workspace, which is one row, not one row
-- per person. Keyed by an opaque bucket name so the next platform-wide counter
-- needs no migration.
CREATE TABLE IF NOT EXISTS platform_counters (
  bucket       text NOT NULL,
  window_start timestamptz NOT NULL,
  count        integer NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);
CREATE INDEX IF NOT EXISTS platform_counters_window_idx ON platform_counters (window_start);

-- ---------------------------------------------------------------------------
-- The nightly validator's summary
-- ---------------------------------------------------------------------------

-- One row per nightly run. Counts and ids only: the validator reads stream
-- event payloads, and a summary that quoted one would put applicant text in a
-- table the erasure inventory does not cover.
--
-- `ok` is the alert: false means either the run-log validator found a sequence
-- that cannot happen, or the human-only-decisions query found a decision with
-- no human behind it. The second is the one that would end the pilot.
CREATE TABLE IF NOT EXISTS validator_runs (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  started_at        timestamptz NOT NULL DEFAULT now(),
  finished_at       timestamptz,
  workspaces        integer NOT NULL DEFAULT 0,
  runs_checked      integer NOT NULL DEFAULT 0,
  violations        integer NOT NULL DEFAULT 0,
  decisions_checked integer NOT NULL DEFAULT 0,
  forged_decisions  integer NOT NULL DEFAULT 0,
  ok                boolean NOT NULL DEFAULT true,
  -- Ids and counts. A test asserts it carries no free text.
  detail            jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX IF NOT EXISTS validator_runs_started_idx ON validator_runs (started_at DESC);

-- ---------------------------------------------------------------------------
-- Workspace deletion
-- ---------------------------------------------------------------------------

-- Deletion is scheduled, not immediate: `DELETE /w/:ws` revokes access now and
-- a Workflow sleeps seven days before anything is destroyed, so a mistaken or
-- malicious deletion is recoverable for a week. These three columns are what a
-- reader of the row (and the request the deleted workspace's Admin makes the
-- next morning) needs in order to see that state.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS deletion_requested_at timestamptz;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS deletion_requested_by uuid;
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS deletion_instance_id text;

-- ---------------------------------------------------------------------------
-- Usage
-- ---------------------------------------------------------------------------

-- `GET /w/:ws/usage` groups `model_calls` by day and by key over a range. The
-- index is the range scan; without it the usage screen table-scans every call
-- the workspace ever made, which is fine on day one and not on day ninety.
CREATE INDEX IF NOT EXISTS model_calls_workspace_created_idx
  ON model_calls (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS model_calls_workspace_key_idx
  ON model_calls (workspace_id, key_id);

-- ---------------------------------------------------------------------------
-- Row-level security
-- ---------------------------------------------------------------------------

-- Both new tables opt out, and the function that 0003 reads has to be
-- rewritten to say so. This is the same dance 0008 does: when 0003 is
-- re-applied it restores its own version of this function, and this file (which
-- sorts later) replaces it again, so the end state is the same either way.
CREATE OR REPLACE FUNCTION hermes_tenant_tables() RETURNS TABLE (table_name text)
  LANGUAGE sql STABLE
  AS $$
    SELECT c.relname::text
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public'
      AND c.relkind = 'r'
      AND (
        c.relname = 'workspaces'
        OR EXISTS (
          SELECT 1 FROM pg_attribute a
          WHERE a.attrelid = c.oid AND a.attname = 'workspace_id' AND a.attnum > 0 AND NOT a.attisdropped
        )
      )
      -- Platform tables opt out explicitly, and each one says why:
      --   rate_counters       a limit evadable by not setting the tenant key
      --                       is not a limit (0001)
      --   workspace_directory answers "which workspace is this WorkOS
      --                       organization?" before a tenant key exists (0008)
      --   job_ready           answers "which workspaces have work due?" for the
      --                       Cron, which is cross-tenant by definition (0008)
      --   platform_counters   the platform instance cap counts an hour across
      --                       every tenant, which is the whole point of it
      --   validator_runs      one row per nightly validation of every workspace
      AND c.relname NOT IN (
        'rate_counters', 'workspace_directory', 'job_ready',
        'platform_counters', 'validator_runs'
      )
  $$;

DROP POLICY IF EXISTS tenant_isolation ON platform_counters;
ALTER TABLE platform_counters NO FORCE ROW LEVEL SECURITY;
ALTER TABLE platform_counters DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON validator_runs;
ALTER TABLE validator_runs NO FORCE ROW LEVEL SECURITY;
ALTER TABLE validator_runs DISABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON platform_counters TO app;
GRANT SELECT, INSERT, UPDATE, DELETE ON validator_runs TO app;

-- The run engine has business in neither. A model that could write the row
-- saying "the human-only-decisions query passed" would be a model auditing
-- itself.
REVOKE ALL ON platform_counters, validator_runs FROM agent;

-- ---------------------------------------------------------------------------
-- New audit kinds
-- ---------------------------------------------------------------------------

-- `events.kind` is a CHECK rather than a lookup table, so widening it is a
-- migration — which is the point: a new audit kind is a deliberate act that a
-- reviewer sees in a diff, not something a route can invent at run time. The
-- constraint is dropped and recreated with the full list, so re-applying 0002
-- (which restores its own narrower version) and then this file lands on the
-- same end state either way.
ALTER TABLE events DROP CONSTRAINT IF EXISTS events_kind_check;
ALTER TABLE events ADD CONSTRAINT events_kind_check CHECK (kind IN (
  'decision.recorded', 'request.created', 'effect.assigned', 'effect.executed', 'effect.cancelled',
  'document.created', 'document.versioned', 'member.invited', 'member.joined', 'member.role_changed',
  'member.removed', 'instruction.saved', 'instruction.proposed', 'context.set', 'settings.changed',
  'session.shared', 'session.unshared', 'provider_key.added', 'provider_key.verified',
  'provider_key.revoked', 'workspace.created', 'workspace.deletion_scheduled', 'subject.redacted',
  'run.errored',
  -- M5a:
  --   usage.cap_warning          spend crossed 80 percent of the daily cap
  --   workspace.deletion_cancelled  an Admin changed their mind inside 7 days
  --   workspace.deleted          the destructive half of the deletion Workflow
  --   provider_key.attested      an Admin recorded a ZDR or DPA attestation
  --   provider_key.rewrapped     a KEK rotation re-wrapped this key's DEK
  --   validator.failed           the nightly validator found something
  'usage.cap_warning', 'workspace.deletion_cancelled', 'workspace.deleted',
  'provider_key.attested', 'provider_key.rewrapped', 'validator.failed'
));

-- ---------------------------------------------------------------------------
-- Destroying a workspace
-- ---------------------------------------------------------------------------

-- `app` deliberately holds no DELETE on `workspaces`: removal is a status
-- change everywhere else in this product (decision 6), and a role that could
-- delete a tenant row is a role one bug away from deleting a tenant. But the
-- deletion Workflow has to be able to, after its seven-day sleep.
--
-- So the same shape `redact_subject` uses: a SECURITY DEFINER procedure that
-- runs as `owner`, does exactly one thing, and is granted to `app`. The blast
-- radius is the argument list — one workspace id, and a guard that refuses a
-- workspace nobody asked to delete, so a stray call cannot destroy a live
-- tenant even with the grant.
--
-- Everything else goes with it through ON DELETE CASCADE, which is why there is
-- no list of tables here: a list would be the thing that is wrong after the
-- next migration adds a table.
CREATE OR REPLACE FUNCTION hermes_delete_workspace(target_workspace_id uuid)
  RETURNS integer
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
  AS $$
  DECLARE
    requested timestamptz;
    n integer;
  BEGIN
    IF target_workspace_id IS NULL THEN
      RAISE EXCEPTION 'hermes_delete_workspace needs a workspace';
    END IF;

    SELECT deletion_requested_at INTO requested FROM workspaces WHERE id = target_workspace_id;
    IF requested IS NULL THEN
      -- Either the workspace is already gone (nothing to do) or nobody asked
      -- for this. Both answer zero rather than raising: the Workflow's step
      -- retries on an exception, and retrying "you never asked" forever is a
      -- Workflow that never finishes.
      RETURN 0;
    END IF;

    DELETE FROM workspace_directory WHERE workspace_id = target_workspace_id;
    DELETE FROM workspaces WHERE id = target_workspace_id;
    GET DIAGNOSTICS n = ROW_COUNT;
    RETURN n;
  END;
  $$;

GRANT EXECUTE ON FUNCTION hermes_delete_workspace(uuid) TO app;
REVOKE ALL ON FUNCTION hermes_delete_workspace(uuid) FROM agent, PUBLIC;

-- ---------------------------------------------------------------------------
-- The last-Admin guard, and deleting a workspace
-- ---------------------------------------------------------------------------

-- `members_last_admin` (0005) refuses to remove the last active Admin, because
-- a workspace with no Admin is a workspace whose Inbox fills forever. That is
-- right for every removal and wrong for exactly one case: the cascade that runs
-- when the workspace itself is deleted, where there will be no Inbox either.
--
-- So the guard gains one condition: it does not fire when the workspace it is
-- protecting no longer exists. The cascade from `workspaces` reaches `members`
-- as a separate command after the parent row is gone, so the lookup is false
-- precisely then and true in every other case — including a hand-written
-- `DELETE FROM members`, which still cannot orphan a live workspace.
CREATE OR REPLACE FUNCTION members_keep_one_admin() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  DECLARE
    remaining integer;
    target_workspace uuid;
  BEGIN
    target_workspace := COALESCE(OLD.workspace_id, NEW.workspace_id);

    -- The workspace is being destroyed; there is nothing left to protect.
    IF NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.id = target_workspace) THEN
      RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
    END IF;

    SELECT count(*) INTO remaining
    FROM members m
    WHERE m.workspace_id = target_workspace
      AND m.role = 'admin'
      AND m.status = 'active'
      AND m.id <> OLD.id;

    IF TG_OP = 'UPDATE' AND NEW.role = 'admin' AND NEW.status = 'active' THEN
      remaining := remaining + 1;
    END IF;

    IF OLD.role = 'admin' AND OLD.status = 'active' AND remaining = 0 THEN
      RAISE EXCEPTION 'a workspace must keep at least one active Admin'
        USING ERRCODE = 'restrict_violation';
    END IF;

    RETURN CASE TG_OP WHEN 'DELETE' THEN OLD ELSE NEW END;
  END $$;

-- `events` is append-only (CONVENTIONS, invariant 8) and stays append-only.
-- The one exception is the same one the last-Admin guard now makes: the cascade
-- that runs when the workspace itself is deleted. There is no audit trail to
-- protect once the tenant it belonged to is gone, and the alternative — a
-- workspace whose deletion is refused by its own audit table — is a workspace
-- nobody can delete at all.
--
-- The condition is narrow on purpose. An UPDATE is still refused unconditionally,
-- and a DELETE is refused unless the workspace row has already gone, which no
-- route can bring about: `app` holds no DELETE on `workspaces`, and the only
-- path to one is `hermes_delete_workspace`, which itself refuses a workspace
-- nobody asked to delete.
CREATE OR REPLACE FUNCTION refuse_mutation() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF TG_OP = 'DELETE'
       AND OLD.workspace_id IS NOT NULL
       AND NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.id = OLD.workspace_id) THEN
      RETURN OLD;
    END IF;
    RAISE EXCEPTION '% is append-only: % is refused', TG_TABLE_NAME, TG_OP
      USING ERRCODE = 'restrict_violation';
  END $$;
