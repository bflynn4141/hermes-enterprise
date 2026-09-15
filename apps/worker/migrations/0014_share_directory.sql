-- 0014_share_directory.sql
-- Which workspace does this share token belong to?
--
-- `GET /shared/:token` has the same shape of problem as
-- `POST /invitations/:token/accept` (0013) and `POST /workspaces`: the tenant
-- key it needs is the answer, not the input. `session_shares` is a tenant table
-- under FORCE ROW LEVEL SECURITY, so a connection with no `app.workspace_id`
-- reads zero rows from it and a SECURITY DEFINER function would not help —
-- forced policies apply to the owner too.
--
-- So the same directory pattern 0013 established: one platform table holding
-- the *hash* and the workspace id and nothing else, written by a trigger, with
-- row-level security deliberately off and SELECT granted to `app` alone. The
-- most a caller can learn by guessing token hashes is that some workspace
-- exists, which a random 256-bit string will not tell them.
--
-- The row exists only while the share does: a revoked or deleted share loses
-- its directory row, so a link stops resolving the moment it is revoked rather
-- than at the next read of `revoked_at`. See decision G1.

CREATE TABLE IF NOT EXISTS share_directory (
  token_hash   text PRIMARY KEY,
  share_id     uuid NOT NULL REFERENCES session_shares (id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS share_directory_share_idx ON share_directory (share_id);

CREATE OR REPLACE FUNCTION share_directory_sync() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
  AS $$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      DELETE FROM share_directory WHERE share_id = OLD.id;
      RETURN OLD;
    END IF;
    IF NEW.revoked_at IS NOT NULL THEN
      DELETE FROM share_directory WHERE share_id = NEW.id;
      RETURN NEW;
    END IF;
    INSERT INTO share_directory (token_hash, share_id, workspace_id)
    VALUES (NEW.token_hash, NEW.id, NEW.workspace_id)
    ON CONFLICT (token_hash) DO UPDATE SET share_id = EXCLUDED.share_id,
                                           workspace_id = EXCLUDED.workspace_id;
    RETURN NEW;
  END $$;

DROP TRIGGER IF EXISTS session_shares_directory_sync ON session_shares;
CREATE TRIGGER session_shares_directory_sync AFTER INSERT OR UPDATE OR DELETE ON session_shares
  FOR EACH ROW EXECUTE FUNCTION share_directory_sync();

-- Shares that already existed when this migration ran. Idempotent, like every
-- other statement in the file.
INSERT INTO share_directory (token_hash, share_id, workspace_id)
  SELECT s.token_hash, s.id, s.workspace_id FROM session_shares s WHERE s.revoked_at IS NULL
  ON CONFLICT (token_hash) DO NOTHING;

DROP POLICY IF EXISTS tenant_isolation ON share_directory;
ALTER TABLE share_directory NO FORCE ROW LEVEL SECURITY;
ALTER TABLE share_directory DISABLE ROW LEVEL SECURITY;

GRANT SELECT ON share_directory TO app;
REVOKE ALL ON share_directory FROM agent;

-- The parameter is `lookup_hash`, not `token_hash`, for the reason 0013 records
-- at length: an unqualified name matching a column in scope resolves to the
-- column, and `WHERE d.token_hash = token_hash` is true for every row.
DROP FUNCTION IF EXISTS hermes_share_workspace(text);
CREATE OR REPLACE FUNCTION hermes_share_workspace(lookup_hash text)
  RETURNS uuid
  LANGUAGE sql
  STABLE
  AS $$
    SELECT d.workspace_id FROM share_directory d WHERE d.token_hash = lookup_hash LIMIT 1
  $$;

GRANT EXECUTE ON FUNCTION hermes_share_workspace(text) TO app;

-- The platform-table list 0003 reads, restated with the new name on it. Same
-- dance as 0008, 0012 and 0013: 0003 restores its own version when it is
-- re-applied, and this file sorts later and replaces it again.
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
      --   member_directory    answers "which workspaces is this person in?"
      --                       before a tenant key exists (0013)
      --   invitation_directory answers "which workspace is this invitation
      --                       token for?" before a tenant key exists (0013)
      --   share_directory     answers "which workspace is this share token
      --                       for?" before a tenant key exists (0014)
      AND c.relname NOT IN (
        'rate_counters', 'workspace_directory', 'job_ready',
        'platform_counters', 'validator_runs', 'member_directory',
        'invitation_directory', 'share_directory'
      )
  $$;
