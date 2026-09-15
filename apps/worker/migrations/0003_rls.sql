-- 0003_rls.sql
-- Row-level security, fail-closed, forced.
--
-- The policy is the same on every tenant table and is generated from one list,
-- so no table can be given a slightly different spelling of the rule. Three
-- details matter:
--
--   * ENABLE is not enough. Without FORCE, the table's owner bypasses its own
--     policies, and migrations run as the owner, so every table is FORCEd.
--   * `NULLIF(current_setting('app.workspace_id', true), '')::uuid` yields NULL
--     both when the setting was never set and when a pooled connection carries
--     the empty string left by a previous SET LOCAL. `workspace_id = NULL` is
--     never true, so the failure mode is zero rows, never every row.
--   * `workspaces` is filtered on `id`, since it has no `workspace_id`.

-- The authoritative list of tenant tables, as a function so that the migration
-- and the tests read the same value.
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
      -- Platform tables opt out explicitly, and each one says why in 0001.
      AND c.relname NOT IN ('rate_counters')
  $$;

DO $$
DECLARE
  t text;
  predicate text;
BEGIN
  FOR t IN SELECT table_name FROM hermes_tenant_tables() LOOP
    predicate := CASE
      WHEN t = 'workspaces' THEN 'id = app_workspace_id()'
      ELSE 'workspace_id = app_workspace_id()'
    END;

    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (%s) WITH CHECK (%s)',
      t, predicate, predicate
    );
  END LOOP;
END $$;

-- A tenant table that slipped through would be a silent cross-tenant read, so
-- the migration refuses to finish rather than leaving one unprotected.
DO $$
DECLARE
  unguarded text;
BEGIN
  SELECT string_agg(c.relname, ', ') INTO unguarded
  FROM pg_class c
  JOIN pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind = 'r'
    AND c.relname IN (SELECT table_name FROM hermes_tenant_tables())
    AND (NOT c.relrowsecurity OR NOT c.relforcerowsecurity);

  IF unguarded IS NOT NULL THEN
    RAISE EXCEPTION 'tenant tables without forced row-level security: %', unguarded;
  END IF;
END $$;
