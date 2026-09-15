-- 0002_tenant.sql
-- Every table that belongs to a workspace.
--
-- Two rules hold throughout:
--   * every row carries `workspace_id`, because that is the key row-level
--     security filters on (0003), and a table without it cannot be isolated;
--   * every table a tool writes carries `(run_id, tool_call_id)` with a UNIQUE
--     index, because a Workflow step can run more than once and a retried tool
--     must not produce a second request, note or document.

-- ---------------------------------------------------------------------------
-- Workspace, membership, settings
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS workspaces (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workos_organization_id  text UNIQUE,
  name                    text NOT NULL,
  slug                    text NOT NULL,
  -- Chosen before the first Durable Object or R2 object exists, because hub
  -- and bucket jurisdiction cannot be changed afterwards.
  jurisdiction            text NOT NULL DEFAULT 'default' CHECK (jurisdiction IN ('default', 'eu')),
  deletion_scheduled_at   timestamptz,
  created_by              uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at              timestamptz NOT NULL DEFAULT now(),
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS workspaces_slug_key ON workspaces (slug);

DROP TRIGGER IF EXISTS workspaces_updated_at ON workspaces;
CREATE TRIGGER workspaces_updated_at BEFORE UPDATE ON workspaces
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The mirror of WorkOS organization memberships, and the only authorization
-- lookup in the product. WorkOS owns sign-in; this table owns "may they".
CREATE TABLE IF NOT EXISTS members (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  user_id               uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  role                  text NOT NULL CHECK (role IN ('admin', 'member')),
  -- A member may hold several reviewer roles; they gate effects, not decisions.
  reviewer_roles        text[] NOT NULL DEFAULT '{}',
  workos_membership_id  text UNIQUE,
  status                text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'inactive')),
  joined_at             timestamptz NOT NULL DEFAULT now(),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT members_workspace_user_key UNIQUE (workspace_id, user_id)
);
CREATE INDEX IF NOT EXISTS members_user_idx ON members (user_id);

DROP TRIGGER IF EXISTS members_updated_at ON members;
CREATE TRIGGER members_updated_at BEFORE UPDATE ON members
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS invitations (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id         uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  email                text NOT NULL CHECK (email = lower(email)),
  role                 text NOT NULL CHECK (role IN ('admin', 'member')),
  workos_invitation_id text UNIQUE,
  -- Kept for the local fallback path; WorkOS owns the live invitation.
  token_hash           text,
  expires_at           timestamptz NOT NULL,
  status               text NOT NULL DEFAULT 'pending'
                         CHECK (status IN ('pending', 'accepted', 'expired', 'withdrawn', 'bounced', 'resent')),
  accepted_by          uuid REFERENCES users (id) ON DELETE SET NULL,
  superseded_by        uuid REFERENCES invitations (id) ON DELETE SET NULL,
  invited_by           uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
-- One live invitation per email per workspace; resent rows keep their history.
CREATE UNIQUE INDEX IF NOT EXISTS invitations_live_key
  ON invitations (workspace_id, email) WHERE status = 'pending';

DROP TRIGGER IF EXISTS invitations_updated_at ON invitations;
CREATE TRIGGER invitations_updated_at BEFORE UPDATE ON invitations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS user_notification_settings (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  approvals    boolean NOT NULL DEFAULT true,
  blocked      boolean NOT NULL DEFAULT true,
  digest       boolean NOT NULL DEFAULT false,
  -- The previous value plus its source, so Undo in chat can restore exactly
  -- what the toggle was before, including who changed it.
  previous     jsonb,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE IF NOT EXISTS workspace_settings (
  workspace_id        uuid PRIMARY KEY REFERENCES workspaces (id) ON DELETE CASCADE,
  default_model_id    text NOT NULL DEFAULT 'deepseek-flash' REFERENCES catalog (model_id),
  default_effort      text DEFAULT 'high',
  default_runtime     text NOT NULL DEFAULT 'cloud' CHECK (default_runtime IN ('cloud', 'local')),
  daily_token_cap     bigint,
  max_concurrent_runs integer NOT NULL DEFAULT 3 CHECK (max_concurrent_runs >= 1),
  flags               jsonb NOT NULL DEFAULT '{}'::jsonb,
  timezone            text NOT NULL DEFAULT 'UTC',
  updated_at          timestamptz NOT NULL DEFAULT now()
);

-- ---------------------------------------------------------------------------
-- The agent
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS agents (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  name                text NOT NULL,
  responsibility      text,
  instructions_active text,
  status              text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'started')),
  setup_step          text,
  started_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
-- The pilot has one agent per workspace; the unique index is what stops a
-- second onboarding route from quietly creating a second Iris.
CREATE UNIQUE INDEX IF NOT EXISTS agents_one_per_workspace ON agents (workspace_id);

DROP TRIGGER IF EXISTS agents_updated_at ON agents;
CREATE TRIGGER agents_updated_at BEFORE UPDATE ON agents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS agent_capabilities (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  agent_id     uuid NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  -- 'can' is what Iris may do alone; 'approves' is what it must queue.
  kind         text NOT NULL CHECK (kind IN ('can', 'approves')),
  title        text NOT NULL,
  scope        text,
  tool_names   text[] NOT NULL DEFAULT '{}',
  position     integer NOT NULL DEFAULT 0,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_capabilities_agent_idx ON agent_capabilities (agent_id, kind, position);

CREATE TABLE IF NOT EXISTS agent_files (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  agent_id          uuid REFERENCES agents (id) ON DELETE CASCADE,
  name              text NOT NULL,
  storage_key       text,
  size_bytes        bigint,
  sha256            text,
  mime              text,
  extraction_status text NOT NULL DEFAULT 'pending'
                      CHECK (extraction_status IN ('pending', 'ready', 'failed')),
  extraction_error  text,
  uploaded_by       uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_files_workspace_idx ON agent_files (workspace_id, created_at DESC);

CREATE TABLE IF NOT EXISTS agent_context_fields (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  agent_id     uuid NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  key          text NOT NULL,
  value        text,
  scope        text NOT NULL DEFAULT 'reply' CHECK (scope IN ('reply', 'future')),
  set_by       uuid REFERENCES users (id) ON DELETE SET NULL,
  run_id       uuid,
  tool_call_id text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT agent_context_fields_key UNIQUE (agent_id, key)
);

CREATE TABLE IF NOT EXISTS instruction_versions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  agent_id     uuid NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  body         text NOT NULL,
  status       text NOT NULL DEFAULT 'proposed' CHECK (status IN ('proposed', 'saved', 'discarded')),
  proposed_by  uuid REFERENCES users (id) ON DELETE SET NULL,
  run_id       uuid,
  tool_call_id text,
  -- Provenance: which turns and files the proposal came from, so the diff can
  -- be reviewed rather than trusted.
  sources      jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at   timestamptz NOT NULL DEFAULT now(),
  saved_at     timestamptz
);
CREATE UNIQUE INDEX IF NOT EXISTS instruction_versions_tool_call_key
  ON instruction_versions (run_id, tool_call_id) WHERE run_id IS NOT NULL AND tool_call_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS skill_versions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  skill_key    text NOT NULL,
  version      integer NOT NULL CHECK (version >= 1),
  name         text NOT NULL,
  description  text,
  body         text,
  procedure    jsonb NOT NULL DEFAULT '[]'::jsonb,
  shared_by    uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT skill_versions_key UNIQUE (workspace_id, skill_key, version)
);

CREATE TABLE IF NOT EXISTS agent_skills (
  workspace_id     uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  agent_id         uuid NOT NULL REFERENCES agents (id) ON DELETE CASCADE,
  skill_version_id uuid NOT NULL REFERENCES skill_versions (id) ON DELETE CASCADE,
  adopted_by       uuid REFERENCES users (id) ON DELETE SET NULL,
  adopted_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (agent_id, skill_version_id)
);

-- ---------------------------------------------------------------------------
-- Sessions and messages
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS sessions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  owner_id         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  title            text NOT NULL DEFAULT 'New session',
  subtitle         text,
  mode             text NOT NULL DEFAULT 'work' CHECK (mode IN ('ask', 'plan', 'work')),
  model_id         text NOT NULL REFERENCES catalog (model_id),
  effort           text,
  runtime          text NOT NULL DEFAULT 'cloud' CHECK (runtime IN ('cloud', 'local')),
  pinned           boolean NOT NULL DEFAULT false,
  archived         boolean NOT NULL DEFAULT false,
  read_only        boolean NOT NULL DEFAULT false,
  carried          jsonb,
  focus_ref        jsonb,
  context          jsonb,
  next_seq         integer NOT NULL DEFAULT 0,
  last_activity_at timestamptz NOT NULL DEFAULT now(),
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS sessions_workspace_idx ON sessions (workspace_id, last_activity_at DESC);
CREATE INDEX IF NOT EXISTS sessions_owner_idx ON sessions (owner_id);

DROP TRIGGER IF EXISTS sessions_updated_at ON sessions;
CREATE TRIGGER sessions_updated_at BEFORE UPDATE ON sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS session_shares (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  session_id         uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  created_by         uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  token_hash         text NOT NULL UNIQUE,
  audience           text NOT NULL,
  -- A share is a snapshot: the holder sees messages up to this sequence and
  -- nothing that happens afterwards.
  message_cutoff_seq integer NOT NULL,
  revoked_at         timestamptz,
  created_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS session_shares_session_idx ON session_shares (session_id) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS messages (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  session_id   uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  seq          integer NOT NULL,
  role         text NOT NULL CHECK (role IN ('user', 'iris', 'human', 'system')),
  kind         text,
  text         text NOT NULL DEFAULT '',
  blocks       jsonb NOT NULL DEFAULT '[]'::jsonb,
  -- Values frozen at answer time, so a transcript does not rewrite itself when
  -- the underlying rows change.
  snapshots    jsonb,
  worked_ms    integer,
  status       text NOT NULL DEFAULT 'complete' CHECK (status IN ('streaming', 'complete', 'incomplete')),
  -- The client's own id for the message it optimistically rendered; a duplicate
  -- POST returns the existing row instead of a second message.
  client_id    text,
  run_id       uuid,
  turn         integer,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT messages_seq_key UNIQUE (session_id, seq)
);
CREATE UNIQUE INDEX IF NOT EXISTS messages_client_id_key
  ON messages (session_id, client_id) WHERE client_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS messages_session_idx ON messages (session_id, seq DESC);

CREATE TABLE IF NOT EXISTS message_feedback (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  message_id   uuid NOT NULL REFERENCES messages (id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  rating       text NOT NULL CHECK (rating IN ('helpful', 'not_helpful')),
  note         text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT message_feedback_key UNIQUE (message_id, user_id)
);

-- ---------------------------------------------------------------------------
-- Runs
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS runs (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  session_id            uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  status                text NOT NULL DEFAULT 'working'
                          CHECK (status IN ('working', 'waiting', 'stopping', 'stopped', 'error', 'completed')),
  waiting_for           text,
  waiting_label         text,
  active_ms             integer NOT NULL DEFAULT 0,
  interrupted           boolean NOT NULL DEFAULT false,
  instruction_version_id uuid REFERENCES instruction_versions (id) ON DELETE SET NULL,
  skill_version_ids     uuid[] NOT NULL DEFAULT '{}',
  max_turns             integer NOT NULL DEFAULT 12,
  model_id              text NOT NULL REFERENCES catalog (model_id),
  effort                text,
  error                 jsonb,
  trace_id              text,
  -- Cloudflare Workflows: the instance id is `${run_id}-a${attempt}`, which
  -- matches the documented id pattern and is asserted by a CI test.
  workflow_instance_id  text,
  attempt               integer NOT NULL DEFAULT 1 CHECK (attempt >= 1),
  -- Stop is a persisted flag honoured at the next step boundary, not an
  -- in-process abort. The provider step reads it from every delta reply.
  stop_requested        boolean NOT NULL DEFAULT false,
  engine_version        integer NOT NULL DEFAULT 1,
  -- The idempotency record for POST turns: the row is inserted before the
  -- Workflow instance is created, so a duplicate POST returns the same run.
  client_turn_id        text NOT NULL,
  started_at            timestamptz NOT NULL DEFAULT now(),
  ended_at              timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT runs_client_turn_key UNIQUE (session_id, client_turn_id)
);
-- At most one live run per session. A partial unique index is the cheapest
-- honest way to say it: the database refuses the second one.
CREATE UNIQUE INDEX IF NOT EXISTS runs_one_active_per_session
  ON runs (session_id) WHERE status IN ('working', 'waiting', 'stopping');
CREATE UNIQUE INDEX IF NOT EXISTS runs_workflow_instance_key
  ON runs (workflow_instance_id) WHERE workflow_instance_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS runs_sweep_idx ON runs (status, updated_at)
  WHERE status IN ('working', 'waiting', 'stopping');

DROP TRIGGER IF EXISTS runs_updated_at ON runs;
CREATE TRIGGER runs_updated_at BEFORE UPDATE ON runs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS run_steps (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  run_id       uuid NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  turn         integer NOT NULL DEFAULT 0,
  step_id      text NOT NULL,
  label        text NOT NULL,
  state        text NOT NULL DEFAULT 'todo' CHECK (state IN ('todo', 'active', 'done', 'failed')),
  tool_call_id text,
  step_attempt integer NOT NULL DEFAULT 1,
  started_at   timestamptz,
  ended_at     timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT run_steps_key UNIQUE (run_id, turn, step_id)
);

CREATE TABLE IF NOT EXISTS run_turns (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  run_id           uuid NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  turn             integer NOT NULL,
  seq              integer NOT NULL DEFAULT 0,
  role             text NOT NULL CHECK (role IN ('system', 'user', 'assistant', 'tool')),
  -- The raw provider message, kept verbatim so reasoning replay rules work.
  provider_message jsonb NOT NULL,
  -- Which applicant this turn is about, so a redaction can find it.
  subject_id       uuid,
  tool_call_id     text,
  schema_version   integer NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT run_turns_key UNIQUE (run_id, turn, seq)
);
CREATE UNIQUE INDEX IF NOT EXISTS run_turns_tool_call_key
  ON run_turns (run_id, tool_call_id) WHERE tool_call_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS run_turns_subject_idx ON run_turns (subject_id) WHERE subject_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS run_queue (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  run_id       uuid NOT NULL REFERENCES runs (id) ON DELETE CASCADE,
  session_id   uuid NOT NULL REFERENCES sessions (id) ON DELETE CASCADE,
  text         text NOT NULL,
  status       text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'paused', 'sent', 'removed')),
  position     integer NOT NULL DEFAULT 0,
  created_by   uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS run_queue_run_idx ON run_queue (run_id, position);

CREATE TABLE IF NOT EXISTS model_calls (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  run_id              uuid REFERENCES runs (id) ON DELETE SET NULL,
  turn                integer,
  model_id            text NOT NULL,
  provider            text NOT NULL,
  -- Which workspace key paid for the call. Only the id: never the key.
  key_id              uuid,
  input_tokens        integer NOT NULL DEFAULT 0,
  output_tokens       integer NOT NULL DEFAULT 0,
  cached_input_tokens integer NOT NULL DEFAULT 0,
  reasoning_tokens    integer NOT NULL DEFAULT 0,
  -- Estimated by us from the catalog price; the provider does the billing.
  cost_usd_estimate   numeric(12, 6) NOT NULL DEFAULT 0,
  latency_ms          integer,
  status              text NOT NULL DEFAULT 'ok',
  trace_id            text,
  created_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS model_calls_usage_idx ON model_calls (workspace_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- Requests, decisions, effects, documents
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS requests (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  kind         text NOT NULL CHECK (kind IN ('application', 'invoice', 'agreement')),
  -- Normalised subject key (hashed email or name), so an erasure request can
  -- find every row about one person without scanning jsonb by hand.
  subject_key  text,
  subject_id   uuid,
  label        text NOT NULL DEFAULT '',
  payload      jsonb NOT NULL,
  status       text NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending', 'admitted', 'declined', 'created', 'drafted', 'withdrawn')),
  run_id       uuid REFERENCES runs (id) ON DELETE SET NULL,
  session_id   uuid REFERENCES sessions (id) ON DELETE SET NULL,
  tool_call_id text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS requests_tool_call_key
  ON requests (run_id, tool_call_id) WHERE run_id IS NOT NULL AND tool_call_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS requests_inbox_idx ON requests (workspace_id, status, created_at DESC);
CREATE INDEX IF NOT EXISTS requests_subject_idx ON requests (subject_key) WHERE subject_key IS NOT NULL;

DROP TRIGGER IF EXISTS requests_updated_at ON requests;
CREATE TRIGGER requests_updated_at BEFORE UPDATE ON requests
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- One decision per request, forever. The UNIQUE constraint is the reason two
-- browser tabs cannot produce two decisions; the route reads the existing row
-- and answers 200 with `conflict: true` rather than erroring at the human.
CREATE TABLE IF NOT EXISTS decisions (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id     uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  request_id       uuid NOT NULL UNIQUE REFERENCES requests (id) ON DELETE CASCADE,
  decision         text NOT NULL CHECK (decision IN ('approve', 'decline')),
  resulting_status text NOT NULL,
  -- Always a user. The nightly query asserts this column never holds the id of
  -- a service account, and the `agent` role has no INSERT here at all.
  decided_by       uuid NOT NULL REFERENCES users (id),
  -- The authenticated session that made the decision, for the step-up audit.
  sid              text,
  note             text,
  decided_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS effects (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  -- An effect cannot exist without the decision that implied it.
  decision_id        uuid NOT NULL REFERENCES decisions (id) ON DELETE CASCADE,
  request_id         uuid NOT NULL REFERENCES requests (id) ON DELETE CASCADE,
  kind               text NOT NULL CHECK (kind IN ('access_grant', 'email_send', 'payment', 'signature')),
  status             text NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending', 'assigned', 'executed', 'cancelled', 'unavailable', 'failed')),
  required_role      text NOT NULL,
  approvals_required integer NOT NULL DEFAULT 1 CHECK (approvals_required >= 1),
  assignee_id        uuid REFERENCES users (id) ON DELETE SET NULL,
  executed_by        uuid REFERENCES users (id) ON DELETE SET NULL,
  executed_at        timestamptz,
  -- What the execution attempt actually reported. In the pilot every execution
  -- returns `unavailable`: no outreach, payment or signature code exists.
  enforcement_result jsonb,
  cancelled_reason   text,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS effects_pending_idx ON effects (workspace_id, status, created_at DESC);

DROP TRIGGER IF EXISTS effects_updated_at ON effects;
CREATE TRIGGER effects_updated_at BEFORE UPDATE ON effects
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS request_notes (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  request_id   uuid NOT NULL REFERENCES requests (id) ON DELETE CASCADE,
  body         text NOT NULL,
  author_type  text NOT NULL DEFAULT 'user' CHECK (author_type IN ('user', 'agent')),
  author_id    uuid REFERENCES users (id) ON DELETE SET NULL,
  run_id       uuid REFERENCES runs (id) ON DELETE SET NULL,
  tool_call_id text,
  created_at   timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS request_notes_tool_call_key
  ON request_notes (run_id, tool_call_id) WHERE run_id IS NOT NULL AND tool_call_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS request_notes_request_idx ON request_notes (request_id, created_at);

CREATE TABLE IF NOT EXISTS documents (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  request_id    uuid NOT NULL REFERENCES requests (id) ON DELETE CASCADE,
  kind          text NOT NULL CHECK (kind IN ('invoice', 'agreement')),
  version       integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  supersedes_id uuid REFERENCES documents (id) ON DELETE SET NULL,
  payload       jsonb NOT NULL,
  storage_key   text,
  render_status text NOT NULL DEFAULT 'pending'
                  CHECK (render_status IN ('pending', 'ready', 'failed', 'missing')),
  render_error  text,
  created_by    uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT documents_version_key UNIQUE (request_id, version)
);

DROP TRIGGER IF EXISTS documents_updated_at ON documents;
CREATE TRIGGER documents_updated_at BEFORE UPDATE ON documents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ---------------------------------------------------------------------------
-- Outbox, audit, jobs
-- ---------------------------------------------------------------------------

-- The outbox. Written in the same transaction as the change it describes, so a
-- published event always has a committed row behind it, and `id` is the replay
-- cursor. bigserial because replay needs monotonic ids.
CREATE TABLE IF NOT EXISTS stream_events (
  id             bigserial PRIMARY KEY,
  workspace_id   uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  session_id     uuid REFERENCES sessions (id) ON DELETE CASCADE,
  kind           text NOT NULL,
  payload        jsonb NOT NULL,
  schema_version integer NOT NULL DEFAULT 1,
  trace_id       text,
  created_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS stream_events_workspace_idx ON stream_events (workspace_id, id);
CREATE INDEX IF NOT EXISTS stream_events_session_idx ON stream_events (session_id, id) WHERE session_id IS NOT NULL;

-- The audit projection. Ids and enum kinds only: no free text, ever. That is
-- what lets an erasure tombstone a subject without destroying the trail, and
-- it is enforced by the column list, not by a review habit.
CREATE TABLE IF NOT EXISTS events (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  actor_type    text NOT NULL CHECK (actor_type IN ('user', 'agent', 'system')),
  actor_user_id uuid REFERENCES users (id) ON DELETE SET NULL,
  kind          text NOT NULL CHECK (kind IN (
    'decision.recorded', 'request.created', 'effect.assigned', 'effect.executed', 'effect.cancelled',
    'document.created', 'document.versioned', 'member.invited', 'member.joined', 'member.role_changed',
    'member.removed', 'instruction.saved', 'instruction.proposed', 'context.set', 'settings.changed',
    'session.shared', 'session.unshared', 'provider_key.added', 'provider_key.verified',
    'provider_key.revoked', 'workspace.created', 'workspace.deletion_scheduled', 'subject.redacted',
    'run.errored'
  )),
  request_id    uuid,
  run_id        uuid,
  session_id    uuid,
  decision_id   uuid,
  effect_id     uuid,
  document_id   uuid,
  member_id     uuid,
  invitation_id uuid,
  subject_id    uuid,
  key_id        uuid,
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS events_history_idx ON events (workspace_id, created_at DESC);
CREATE INDEX IF NOT EXISTS events_request_idx ON events (request_id) WHERE request_id IS NOT NULL;

-- Every cross-system side effect after a commit is a row here, written in the
-- same transaction as the change. The committing request tries it immediately;
-- the minute Cron retries whatever is still undone. UNIQUE(kind, key) is the
-- idempotency key, so a receipt cannot be sent twice.
CREATE TABLE IF NOT EXISTS jobs (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  kind         text NOT NULL,
  key          text NOT NULL,
  payload      jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempts     integer NOT NULL DEFAULT 0,
  next_at      timestamptz NOT NULL DEFAULT now(),
  locked_until timestamptz,
  done_at      timestamptz,
  last_error   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT jobs_key UNIQUE (kind, key)
);
CREATE INDEX IF NOT EXISTS jobs_claimable_idx ON jobs (next_at) WHERE done_at IS NULL;

CREATE TABLE IF NOT EXISTS workos_sync (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  resource_type text NOT NULL CHECK (resource_type IN ('organization', 'membership', 'invitation', 'user')),
  resource_id   uuid,
  workos_id     text,
  -- 'outbound' is a change of ours WorkOS has not seen yet; 'inbound' is a
  -- change made in the WorkOS dashboard that our transaction has to apply.
  direction     text NOT NULL CHECK (direction IN ('inbound', 'outbound')),
  status        text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'done', 'failed')),
  payload       jsonb NOT NULL DEFAULT '{}'::jsonb,
  attempts      integer NOT NULL DEFAULT 0,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS workos_sync_pending_idx ON workos_sync (status, created_at) WHERE status = 'pending';

-- ---------------------------------------------------------------------------
-- Provider keys (bring your own key)
-- ---------------------------------------------------------------------------

-- Envelope encryption. The key is encrypted with its own AES-GCM data key; the
-- data key is wrapped by a master key held as a Worker secret. The AAD is split
-- so rotation works: the data ciphertext binds (workspace_id, key_id), the DEK
-- wrap binds (workspace_id, key_id, kek_version), and a rotation re-wraps only
-- the DEK. Nothing here is readable without the current KEK.
CREATE TABLE IF NOT EXISTS workspace_provider_keys (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  provider        text NOT NULL CHECK (provider IN ('deepseek', 'anthropic', 'openai')),
  label           text NOT NULL DEFAULT '',
  ciphertext      bytea NOT NULL,
  iv              bytea NOT NULL,
  wrapped_dek     bytea NOT NULL,
  wrap_iv         bytea NOT NULL,
  kek_version     integer NOT NULL,
  -- SHA-256 of the key, so a re-paste of the same key is recognised without
  -- decrypting anything; `last4` is all the UI ever shows.
  fingerprint     text NOT NULL,
  last4           text NOT NULL,
  status          text NOT NULL DEFAULT 'unverified'
                    CHECK (status IN ('unverified', 'verified', 'verified_scoped', 'invalid', 'revoked')),
  verified_models text[] NOT NULL DEFAULT '{}',
  -- What the Admin attested about the provider's retention terms (ZDR, DPA).
  attestation     jsonb,
  added_by        uuid REFERENCES users (id) ON DELETE SET NULL,
  verified_at     timestamptz,
  rotated_at      timestamptz,
  revoked_at      timestamptz,
  replaces_key_id uuid REFERENCES workspace_provider_keys (id) ON DELETE SET NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);
-- One live key per provider per workspace; revoked rows stay for history.
CREATE UNIQUE INDEX IF NOT EXISTS workspace_provider_keys_live
  ON workspace_provider_keys (workspace_id, provider) WHERE revoked_at IS NULL;
CREATE INDEX IF NOT EXISTS workspace_provider_keys_fingerprint_idx
  ON workspace_provider_keys (workspace_id, fingerprint);

DROP TRIGGER IF EXISTS workspace_provider_keys_updated_at ON workspace_provider_keys;
CREATE TRIGGER workspace_provider_keys_updated_at BEFORE UPDATE ON workspace_provider_keys
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
