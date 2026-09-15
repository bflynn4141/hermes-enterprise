-- 0001_platform.sql
-- Platform tables: rows that are not owned by one workspace.
--
-- Everything in this file is deliberately outside row-level security, because
-- RLS keys on `app.workspace_id` and these rows either span workspaces (a user,
-- an auth session, the WorkOS cursor) or are global reference data (the model
-- catalog). Each one gets narrow grants instead.
--
-- Every statement is written to be safe to run twice: the migration runner
-- applies the whole set, then applies it again and asserts the schema is
-- unchanged. That is what makes a partially applied deploy recoverable.

-- ---------------------------------------------------------------------------
-- Migration bookkeeping
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS schema_migrations (
  filename    text PRIMARY KEY,
  sha256      text NOT NULL,
  applied_at  timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------

-- The single source of the tenant key. Written once here so that no policy can
-- spell it slightly differently: NULLIF turns both an unset setting and the
-- empty string a pooled connection can carry after a previous SET LOCAL into
-- NULL, and `= NULL` is never true, so the failure mode is zero rows rather
-- than every row.
CREATE OR REPLACE FUNCTION app_workspace_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.workspace_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION app_user_id() RETURNS uuid
  LANGUAGE sql STABLE
  AS $$ SELECT NULLIF(current_setting('app.user_id', true), '')::uuid $$;

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
  LANGUAGE plpgsql
  AS $$ BEGIN NEW.updated_at := now(); RETURN NEW; END $$;

-- ---------------------------------------------------------------------------
-- Users
-- ---------------------------------------------------------------------------

-- A user exists across workspaces, so `users` is not a tenant table. What is
-- tenant-scoped is `members`, and `members` is the only authorization lookup.
CREATE TABLE IF NOT EXISTS users (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workos_user_id text UNIQUE,
  email          text NOT NULL,
  email_verified boolean NOT NULL DEFAULT false,
  name           text,
  avatar_url     text,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now(),
  deleted_at     timestamptz,
  CONSTRAINT users_email_lower CHECK (email = lower(email))
);
CREATE UNIQUE INDEX IF NOT EXISTS users_email_key ON users (email);

DROP TRIGGER IF EXISTS users_updated_at ON users;
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Auth sessions: the measurable input for step-up
-- ---------------------------------------------------------------------------

-- The WorkOS access token carries no `auth_time`, and `iat` moves on every
-- refresh, so freshness cannot be read from the token. `/auth/callback` records
-- when each `sid` actually authenticated, and the decision route compares that
-- against now minus five minutes.
CREATE TABLE IF NOT EXISTS auth_sessions (
  sid               text PRIMARY KEY,
  user_id           uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  authenticated_at  timestamptz NOT NULL,
  last_seen_at      timestamptz NOT NULL DEFAULT now(),
  revoked_at        timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_sessions_user_idx ON auth_sessions (user_id, authenticated_at DESC);

-- ---------------------------------------------------------------------------
-- WorkOS Events API cursor
-- ---------------------------------------------------------------------------

-- Ordered and replayable, with no public endpoint to sign-check. One row.
CREATE TABLE IF NOT EXISTS workos_events_cursor (
  id          smallint PRIMARY KEY DEFAULT 1,
  after_id    text,
  polled_at   timestamptz,
  events_seen bigint NOT NULL DEFAULT 0,
  CONSTRAINT workos_events_cursor_singleton CHECK (id = 1)
);
INSERT INTO workos_events_cursor (id) VALUES (1) ON CONFLICT (id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- Rate counters
-- ---------------------------------------------------------------------------

-- Per-user limits (turns, uploads, shares, workspace creations, key
-- verifications). Deliberately outside RLS: a limit that can be evaded by
-- failing to set the tenant key is not a limit. The counter is keyed by user
-- first, so a user cannot spread a burst over workspaces.
CREATE TABLE IF NOT EXISTS rate_counters (
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  workspace_id uuid,
  action       text NOT NULL,
  window_start timestamptz NOT NULL,
  count        integer NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, action, window_start, workspace_id)
);
CREATE INDEX IF NOT EXISTS rate_counters_window_idx ON rate_counters (window_start);

-- ---------------------------------------------------------------------------
-- Model catalog
-- ---------------------------------------------------------------------------

-- The catalog is data, not code: prices drift faster than deploys. A row is
-- offered to a workspace only if `disabled_reason IS NULL` and that workspace
-- holds a verified key for the row's provider.
CREATE TABLE IF NOT EXISTS catalog (
  model_id             text PRIMARY KEY,
  provider             text NOT NULL CHECK (provider IN ('deepseek', 'anthropic', 'openai', 'nous_portal')),
  label                text NOT NULL,
  transport            text NOT NULL CHECK (transport IN ('deepseek_chat', 'anthropic_messages', 'openai_responses')),
  effort_map           jsonb,
  default_effort       text,
  pricing_per_million  jsonb NOT NULL,
  pricing_verified_on  date NOT NULL,
  disabled_reason      text,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);

DROP TRIGGER IF EXISTS catalog_updated_at ON catalog;
CREATE TRIGGER catalog_updated_at BEFORE UPDATE ON catalog
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
