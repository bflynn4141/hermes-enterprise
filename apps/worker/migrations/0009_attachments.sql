-- 0009_attachments.sql
-- Uploads: the row an object in R2 is accounted for by.
--
-- An object with no row is garbage a daily Cron deletes after 24 hours; a row
-- with no object is a declaration someone abandoned. Neither is allowed to be
-- silent, which is why the row carries both a `status` (did the bytes arrive
-- and did they match what was declared) and an `extraction_status` (did we get
-- text out of them), and why the two are separate: bytes can be perfectly fine
-- and a PDF still refuse to yield text, and a reviewer needs to be told which
-- of the two happened.
--
-- `agent_files` (Context sources, 0002) already had `extraction_status` and
-- shares this table's storage and queue. It gains the two counters this file
-- adds to `attachments`, so one extraction consumer can write to either.

-- ---------------------------------------------------------------------------
-- attachments
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS attachments (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  -- Nullable: an attachment is declared before it is attached to anything, and
  -- a session that is archived must not take its files with it.
  session_id        uuid REFERENCES sessions (id) ON DELETE SET NULL,
  -- The run turn that carried it, written by the engine's turns route. Not a
  -- foreign key: the turn row is written by a different transaction, and a
  -- constraint here would make the order of two independent writes matter.
  turn_id           uuid,
  name              text NOT NULL,
  -- `w/{workspace}/uploads/{id}`. The workspace is in the key so that the
  -- erasure path can delete a tenant's objects by prefix without a list of ids,
  -- and so the daily sweep can tell which workspace to ask about an orphan
  -- without a role that can read every tenant's rows.
  storage_key       text NOT NULL,
  size_bytes        bigint NOT NULL CHECK (size_bytes >= 0 AND size_bytes <= 20971520),
  mime              text NOT NULL CHECK (mime IN ('application/pdf', 'text/markdown', 'text/plain')),
  -- Null until `complete` has streamed the object back and hashed it.
  sha256            text,
  status            text NOT NULL DEFAULT 'uploading'
                      CHECK (status IN ('uploading', 'ready', 'failed', 'deleted')),
  status_reason     text,
  extraction_status text NOT NULL DEFAULT 'pending'
                      CHECK (extraction_status IN ('pending', 'ready', 'failed')),
  extraction_error  text,
  text_length       integer,
  token_estimate    integer,
  uploaded_by       uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  completed_at      timestamptz,
  deleted_at        timestamptz,
  updated_at        timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS attachments_workspace_idx ON attachments (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS attachments_session_idx ON attachments (session_id, created_at DESC);
-- The sweep's question, asked one workspace at a time: is this key accounted
-- for by a row that actually completed?
CREATE UNIQUE INDEX IF NOT EXISTS attachments_storage_key ON attachments (storage_key);

-- 0003 covers every tenant table that existed when it ran; a table added later
-- carries the same three lines itself, spelled the same way.
ALTER TABLE attachments ENABLE ROW LEVEL SECURITY;
ALTER TABLE attachments FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON attachments;
CREATE POLICY tenant_isolation ON attachments
  USING (workspace_id = app_workspace_id())
  WITH CHECK (workspace_id = app_workspace_id());

-- ---------------------------------------------------------------------------
-- agent_files gains the same two counters
-- ---------------------------------------------------------------------------

-- Expand, never rewrite: both are nullable with no default, so an existing row
-- keeps meaning exactly what it meant, and a reader that predates this file
-- ignores them.
ALTER TABLE agent_files ADD COLUMN IF NOT EXISTS text_length integer;
ALTER TABLE agent_files ADD COLUMN IF NOT EXISTS token_estimate integer;

-- ---------------------------------------------------------------------------
-- Grants
-- ---------------------------------------------------------------------------

-- 0004 revokes everything from `app` and `agent` before it grants, so a table
-- created afterwards carries its own grants here, and `ALTER DEFAULT PRIVILEGES`
-- means a table nobody thought about is a table nobody can read.
--
-- The app owns the lifecycle: it declares the row, completes it, and removes it
-- when someone deletes the file. The agent may only read: a tool may quote a
-- document, and nothing in the run engine may mark one ready, rename one, or
-- make one disappear.
GRANT SELECT, INSERT, UPDATE, DELETE ON attachments TO app;
GRANT SELECT ON attachments TO agent;
REVOKE INSERT, UPDATE, DELETE ON attachments FROM agent;
