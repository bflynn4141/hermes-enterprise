-- 0013_agent_publish_and_directory.sql
-- Two narrow widenings, both of which the client's live integration proved were
-- needed and both of which are recorded in docs/DECISIONS.md (F3, F7).
--
-- 1. The agent role may publish `request.created` and `entity.updated`, but
--    only about a `requests` row a run actually wrote. The kind guard in 0005
--    refused every kind outside `message.*`/`run.*`, which meant a member who
--    was not on the proposing session's socket learned nothing about a new
--    request until they reloaded.
-- 2. A `SECURITY DEFINER` function that answers "which workspaces is this user
--    in?" from the members mirror. `members` is a tenant table under forced
--    row-level security, so the question cannot be asked without already
--    knowing the answer; `workspace_directory` only holds workspaces that came
--    from WorkOS, so a seeded or locally created one was invisible.

-- ---------------------------------------------------------------------------
-- 1. What the agent role may publish
-- ---------------------------------------------------------------------------

-- The widening is deliberately not "the agent may publish request.created".
-- It is "the agent may publish request.created *about a row it just wrote*":
-- the payload has to name a `requests` row, in this workspace, that carries a
-- `run_id` — which only `proposeRequest` sets. A tool cannot forge an event
-- about a request it did not create, and it still cannot publish
-- `decision.recorded` at all, so the decision invariant is untouched:
-- `request.created` says a proposal exists and is `pending`, which is the
-- state the decision route is the only thing that can leave.
CREATE OR REPLACE FUNCTION stream_events_agent_may_publish(kind text, workspace uuid, payload jsonb)
  RETURNS boolean
  LANGUAGE plpgsql
  STABLE
  AS $$
  DECLARE
    candidate text;
  BEGIN
    IF kind = 'request.created' THEN
      candidate := payload ->> 'request_id';
    ELSIF kind = 'entity.updated' AND payload ->> 'entity_type' = 'request' THEN
      candidate := payload ->> 'entity_id';
    ELSE
      RETURN false;
    END IF;

    -- A payload is model-adjacent data, so it is never cast blindly: a
    -- non-uuid here would raise `invalid_text_representation` from inside a
    -- BEFORE INSERT trigger, which is an error nobody could read.
    IF candidate IS NULL
       OR candidate !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
      RETURN false;
    END IF;

    RETURN EXISTS (
      SELECT 1 FROM requests r
       WHERE r.id = candidate::uuid
         AND r.workspace_id = workspace
         AND r.run_id IS NOT NULL
    );
  END $$;

GRANT EXECUTE ON FUNCTION stream_events_agent_may_publish(text, uuid, jsonb) TO app, agent;

CREATE OR REPLACE FUNCTION stream_events_agent_kind_guard() RETURNS trigger
  LANGUAGE plpgsql
  AS $$
  BEGIN
    IF current_user = 'agent'
       AND NEW.kind NOT LIKE 'message.%'
       AND NEW.kind NOT LIKE 'run.%'
       AND NOT stream_events_agent_may_publish(NEW.kind, NEW.workspace_id, NEW.payload) THEN
      RAISE EXCEPTION 'the agent role may publish message.*, run.* and an event about a request it wrote, not %', NEW.kind
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    RETURN NEW;
  END $$;

DROP TRIGGER IF EXISTS stream_events_agent_kind ON stream_events;
CREATE TRIGGER stream_events_agent_kind BEFORE INSERT ON stream_events
  FOR EACH ROW EXECUTE FUNCTION stream_events_agent_kind_guard();

-- ---------------------------------------------------------------------------
-- 2. Which workspaces is this user in?
-- ---------------------------------------------------------------------------

-- The third platform table, and it exists for the reason 0008 gives for the
-- first two: the question is cross-tenant by nature, every tenant table is
-- FORCE ROW LEVEL SECURITY, and all three roles are NOBYPASSRLS — so there is
-- no connection that can answer "which workspaces is this person in?" and we
-- refuse to create one. `GET /auth/session` used to approximate it by walking
-- `workspace_directory`, which only holds workspaces that came from WorkOS, so
-- a seeded or locally created workspace was invisible and the route answered
-- 404 `no_workspace` to someone plainly a member of one. See decision F7.
--
-- Ids, a role and a display name; no applicant text, no settings, no payload.
-- A leak of it tells an attacker which workspaces exist and who is in them,
-- which is the same price 0008 already paid for `job_ready`.
CREATE TABLE IF NOT EXISTS member_directory (
  user_id        uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  workspace_id   uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  role           text NOT NULL,
  workspace_name text NOT NULL DEFAULT '',
  joined_at      timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, workspace_id)
);
CREATE INDEX IF NOT EXISTS member_directory_workspace_idx ON member_directory (workspace_id);

-- Maintained by a trigger rather than by the routes, because a mirror three
-- code paths write is a mirror one of them will forget: `mirrorMembership`,
-- `revokeAccess` and the WorkOS events poller all move `members`, and the
-- trigger is the one place that cannot be bypassed by a fourth.
CREATE OR REPLACE FUNCTION member_directory_sync() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
  AS $$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      DELETE FROM member_directory WHERE user_id = OLD.user_id AND workspace_id = OLD.workspace_id;
      RETURN OLD;
    END IF;

    IF NEW.status <> 'active' THEN
      DELETE FROM member_directory WHERE user_id = NEW.user_id AND workspace_id = NEW.workspace_id;
      RETURN NEW;
    END IF;

    INSERT INTO member_directory (user_id, workspace_id, role, workspace_name, joined_at)
    VALUES (
      NEW.user_id,
      NEW.workspace_id,
      NEW.role,
      -- Readable here because the statement that fired this trigger is already
      -- running under this workspace's own tenant key.
      COALESCE((SELECT w.name FROM workspaces w WHERE w.id = NEW.workspace_id), ''),
      NEW.joined_at
    )
    ON CONFLICT (user_id, workspace_id)
    DO UPDATE SET role = EXCLUDED.role,
                  workspace_name = EXCLUDED.workspace_name,
                  joined_at = EXCLUDED.joined_at;
    RETURN NEW;
  END $$;

DROP TRIGGER IF EXISTS members_directory_sync ON members;
CREATE TRIGGER members_directory_sync AFTER INSERT OR UPDATE OR DELETE ON members
  FOR EACH ROW EXECUTE FUNCTION member_directory_sync();

-- A rename has to reach the copy, or the workspace switcher shows the old name
-- until someone's membership changes.
CREATE OR REPLACE FUNCTION member_directory_rename() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
  AS $$
  BEGIN
    IF NEW.name IS DISTINCT FROM OLD.name THEN
      UPDATE member_directory SET workspace_name = NEW.name WHERE workspace_id = NEW.id;
    END IF;
    RETURN NEW;
  END $$;

DROP TRIGGER IF EXISTS workspaces_directory_rename ON workspaces;
CREATE TRIGGER workspaces_directory_rename AFTER UPDATE ON workspaces
  FOR EACH ROW EXECUTE FUNCTION member_directory_rename();

-- The platform-table list 0003 reads, restated with the new name on it. Same
-- dance as 0008 and 0012: 0003 restores its own version when it is re-applied,
-- and this file sorts later and replaces it again.
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
      AND c.relname NOT IN (
        'rate_counters', 'workspace_directory', 'job_ready',
        'platform_counters', 'validator_runs', 'member_directory',
        'invitation_directory'
      )
  $$;

DROP POLICY IF EXISTS tenant_isolation ON member_directory;
ALTER TABLE member_directory NO FORCE ROW LEVEL SECURITY;
ALTER TABLE member_directory DISABLE ROW LEVEL SECURITY;

-- `app` reads it; nothing writes it but the trigger, which runs as owner.
GRANT SELECT ON member_directory TO app;
REVOKE ALL ON member_directory FROM agent;

-- The read, as a function so the route does not have to know the table's shape
-- and so the filter by `user_id` is in one place rather than at every call.
CREATE OR REPLACE FUNCTION hermes_user_workspaces(subject uuid)
  RETURNS TABLE (workspace_id uuid, name text, role text, joined_at timestamptz)
  LANGUAGE sql
  STABLE
  AS $$
    SELECT d.workspace_id, d.workspace_name, d.role, d.joined_at
      FROM member_directory d
     WHERE d.user_id = subject
     ORDER BY d.joined_at DESC
     LIMIT 200
  $$;

GRANT EXECUTE ON FUNCTION hermes_user_workspaces(uuid) TO app;

-- ---------------------------------------------------------------------------
-- 3. Which workspace does this invitation token belong to?
-- ---------------------------------------------------------------------------

-- `POST /invitations/:token/accept` has the same shape of problem as
-- `POST /workspaces`: the tenant key it needs is the answer, not the input.
-- The function is deliberately narrow — it takes an opaque token and returns
-- one workspace id, never the invitation's email, role or history — so the
-- most a caller can learn by guessing tokens is that some workspace exists,
-- which a random uuid will not tell them. See decision F2.
CREATE TABLE IF NOT EXISTS invitation_directory (
  token        text PRIMARY KEY,
  invitation_id uuid NOT NULL REFERENCES invitations (id) ON DELETE CASCADE,
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS invitation_directory_invitation_idx ON invitation_directory (invitation_id);

-- One row per token an invitation can be reached by: its id, and — where
-- WorkOS sent the email — the WorkOS invitation id. Written by a trigger for
-- the same reason the membership mirror is: three code paths create
-- invitations and a fourth will exist by the time anyone reads this.
CREATE OR REPLACE FUNCTION invitation_directory_sync() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
  AS $$
  BEGIN
    IF TG_OP = 'DELETE' THEN
      DELETE FROM invitation_directory WHERE invitation_id = OLD.id;
      RETURN OLD;
    END IF;
    -- Only a live invitation is reachable. A withdrawn or accepted one loses
    -- its row, so a forwarded link stops resolving the moment it stops being
    -- an invitation.
    IF NEW.status <> 'pending' THEN
      DELETE FROM invitation_directory WHERE invitation_id = NEW.id;
      RETURN NEW;
    END IF;
    INSERT INTO invitation_directory (token, invitation_id, workspace_id)
    VALUES (NEW.id::text, NEW.id, NEW.workspace_id)
    ON CONFLICT (token) DO UPDATE SET invitation_id = EXCLUDED.invitation_id,
                                      workspace_id = EXCLUDED.workspace_id;
    IF NEW.workos_invitation_id IS NOT NULL THEN
      INSERT INTO invitation_directory (token, invitation_id, workspace_id)
      VALUES (NEW.workos_invitation_id, NEW.id, NEW.workspace_id)
      ON CONFLICT (token) DO UPDATE SET invitation_id = EXCLUDED.invitation_id,
                                        workspace_id = EXCLUDED.workspace_id;
    END IF;
    IF NEW.token_hash IS NOT NULL THEN
      INSERT INTO invitation_directory (token, invitation_id, workspace_id)
      VALUES (NEW.token_hash, NEW.id, NEW.workspace_id)
      ON CONFLICT (token) DO UPDATE SET invitation_id = EXCLUDED.invitation_id,
                                        workspace_id = EXCLUDED.workspace_id;
    END IF;
    RETURN NEW;
  END $$;

DROP TRIGGER IF EXISTS invitations_directory_sync ON invitations;
CREATE TRIGGER invitations_directory_sync AFTER INSERT OR UPDATE OR DELETE ON invitations
  FOR EACH ROW EXECUTE FUNCTION invitation_directory_sync();

DROP POLICY IF EXISTS tenant_isolation ON invitation_directory;
ALTER TABLE invitation_directory NO FORCE ROW LEVEL SECURITY;
ALTER TABLE invitation_directory DISABLE ROW LEVEL SECURITY;

GRANT SELECT ON invitation_directory TO app;
REVOKE ALL ON invitation_directory FROM agent;

-- The parameter is `lookup_token`, not `token`: in a SQL function an unqualified
-- name that matches a column of a table in scope resolves to the *column*, so
-- `WHERE d.token = token` is `d.token = d.token` — true for every row, and the
-- function hands back somebody else's workspace. Naming it apart is the fix
-- that cannot be undone by accident.
DROP FUNCTION IF EXISTS hermes_invitation_workspace(text);
CREATE OR REPLACE FUNCTION hermes_invitation_workspace(lookup_token text)
  RETURNS uuid
  LANGUAGE sql
  STABLE
  AS $$
    SELECT d.workspace_id FROM invitation_directory d WHERE d.token = lookup_token LIMIT 1
  $$;

GRANT EXECUTE ON FUNCTION hermes_invitation_workspace(text) TO app;
