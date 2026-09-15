-- 0008_drafts_and_pointers.sql
-- What M2 needs that M1 did not: a per-session draft, and the two platform
-- tables that make a *global* operation possible at all.
--
-- The second half of this file is the interesting one. Every tenant table is
-- FORCE ROW LEVEL SECURITY and all three roles are NOBYPASSRLS, deliberately:
-- there is no connection in this system that can read two workspaces at once.
-- That is the property the product is built on, and it is also the reason the
-- minute Cron cannot ask "which workspaces have a job due?" and the auth
-- callback cannot ask "which workspace is WorkOS organization org_123?" — both
-- questions are cross-tenant by nature, and both would otherwise need a role
-- that can see everything, which is exactly what we refuse to create.
--
-- So each question gets its own narrow platform table holding ids and nothing
-- else: no applicant text, no payload, no name. A leak of either table tells an
-- attacker that a workspace exists and that it has work pending, which is the
-- price of never having a role that can read every tenant's rows.

-- ---------------------------------------------------------------------------
-- Drafts
-- ---------------------------------------------------------------------------

-- The composer's unsent text, per session and per user. It is a tenant table
-- like any other: a draft is written in a workspace and is only ever read by
-- the person who typed it.
CREATE TABLE IF NOT EXISTS session_drafts (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  session_id   uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  text         text NOT NULL DEFAULT '',
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, user_id)
);
CREATE INDEX IF NOT EXISTS session_drafts_workspace_idx ON session_drafts (workspace_id);

-- 0003 covers every tenant table that existed when it ran; a table added later
-- carries the same three lines itself, spelled the same way.
ALTER TABLE session_drafts ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_drafts FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON session_drafts;
CREATE POLICY tenant_isolation ON session_drafts
  USING (workspace_id = app_workspace_id()) WITH CHECK (workspace_id = app_workspace_id());

-- ---------------------------------------------------------------------------
-- The two platform tables
-- ---------------------------------------------------------------------------

-- Which workspace is WorkOS organization X? Asked by `/auth/callback` before
-- any tenant key exists and by the Events API poller for every inbound event.
-- Ids only.
CREATE TABLE IF NOT EXISTS workspace_directory (
  workspace_id           uuid PRIMARY KEY REFERENCES workspaces (id) ON DELETE CASCADE,
  workos_organization_id text UNIQUE,
  created_at             timestamptz NOT NULL DEFAULT now()
);

-- Which workspaces have a job due? Asked by the minute Cron. A row is written
-- by `enqueueJob` in the same transaction as the job it points at and deleted
-- when that job is done, so the pointer cannot outlive its job or precede it.
CREATE TABLE IF NOT EXISTS job_ready (
  job_id       uuid PRIMARY KEY REFERENCES jobs (id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL,
  next_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS job_ready_due_idx ON job_ready (next_at);

-- Both are platform tables and say so in one place: the list 0003 reads. When
-- 0003 is re-applied (the migration runner applies everything twice and
-- compares fingerprints) it restores its own two-name version of this function
-- and protects these tables; this file then replaces it again and unprotects
-- them, so the end state is the same either way.
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
      --                       organization?" before a tenant key exists
      --   job_ready           answers "which workspaces have work due?" for the
      --                       Cron, which is cross-tenant by definition
      AND c.relname NOT IN ('rate_counters', 'workspace_directory', 'job_ready')
  $$;

DROP POLICY IF EXISTS tenant_isolation ON workspace_directory;
ALTER TABLE workspace_directory NO FORCE ROW LEVEL SECURITY;
ALTER TABLE workspace_directory DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON job_ready;
ALTER TABLE job_ready NO FORCE ROW LEVEL SECURITY;
ALTER TABLE job_ready DISABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

GRANT SELECT, INSERT, UPDATE, DELETE ON session_drafts TO app;
GRANT SELECT, INSERT, UPDATE, DELETE ON workspace_directory TO app;
GRANT SELECT, INSERT, UPDATE, DELETE ON job_ready TO app;

-- The run engine has no business in any of the three: a draft is a person's
-- unsent text, and the two platform tables are the only cross-tenant surface in
-- the system.
REVOKE ALL ON session_drafts, workspace_directory, job_ready FROM agent;

-- No backfill: every statement in this file runs as `owner`, and `owner` is
-- NOBYPASSRLS like the other two roles, so a cross-workspace SELECT here would
-- read zero rows and quietly look like success. The directory row is written by
-- `POST /workspaces` inside the transaction that creates the workspace, which
-- is the only place a workspace is created.
