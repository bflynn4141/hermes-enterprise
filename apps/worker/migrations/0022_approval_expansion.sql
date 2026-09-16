-- Enterprise approvals: immutable policy snapshots, revision-bound votes and
-- a durable finalization hook. Legacy application/document decisions remain
-- in their existing tables and routes.

-- The enterprise fixture may name colleague agents. Runtime provisioning is a
-- separate concern, so more than one agent row may exist while only configured
-- profiles can execute. Keep a non-unique index under the historical name so
-- replaying 0002's `CREATE UNIQUE INDEX IF NOT EXISTS` remains idempotent after
-- a workspace contains multiple agents.
DROP INDEX IF EXISTS agents_one_per_workspace;
CREATE INDEX agents_one_per_workspace ON agents (workspace_id);

ALTER TABLE requests DROP CONSTRAINT IF EXISTS requests_kind_check;
ALTER TABLE requests ADD CONSTRAINT requests_kind_check
  CHECK (kind IN ('application', 'invoice', 'agreement', 'approval'));

ALTER TABLE requests DROP CONSTRAINT IF EXISTS requests_status_check;
ALTER TABLE requests ADD CONSTRAINT requests_status_check
  CHECK (status IN (
    'pending', 'admitted', 'declined', 'created', 'drafted', 'withdrawn',
    'approved', 'changes_requested', 'expired'
  ));

CREATE TABLE IF NOT EXISTS agent_owners (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  agent_id      uuid PRIMARY KEY REFERENCES agents (id) ON DELETE CASCADE,
  member_id     uuid NOT NULL REFERENCES members (id) ON DELETE RESTRICT,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS agent_owners_member_idx ON agent_owners (workspace_id, member_id);

DROP TRIGGER IF EXISTS agent_owners_updated_at ON agent_owners;
CREATE TRIGGER agent_owners_updated_at BEFORE UPDATE ON agent_owners
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Resources that a policy can name authoritatively. A mutable identifier is
-- never enough for an authorization hash; version and sha256 are the binding.
CREATE TABLE IF NOT EXISTS approval_resources (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  resource_key       text NOT NULL,
  kind               text NOT NULL CHECK (kind IN (
                       'folder', 'artifact', 'data', 'system', 'rule', 'skill', 'other'
                     )),
  label              text NOT NULL,
  owner_member_id    uuid NOT NULL REFERENCES members (id) ON DELETE RESTRICT,
  version            text,
  sha256             text CHECK (sha256 IS NULL OR sha256 ~ '^[0-9a-f]{64}$'),
  executor_available boolean NOT NULL DEFAULT false,
  active             boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT approval_resources_key UNIQUE (workspace_id, resource_key)
);

DROP TRIGGER IF EXISTS approval_resources_updated_at ON approval_resources;
CREATE TRIGGER approval_resources_updated_at BEFORE UPDATE ON approval_resources
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- `key` is an input hint, not authority. The server selects the one applicable
-- policy from type/requester/target/budget rules and rejects a different key.
CREATE TABLE IF NOT EXISTS approval_policies (
  id                       uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id             uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  key                      text NOT NULL,
  version                  integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  approval_type            text NOT NULL CHECK (approval_type IN (
                             'run_plan', 'team_commitment', 'access', 'communication',
                             'shared_learning', 'deliverable', 'data_disclosure',
                             'record_change', 'exception', 'agent_governance'
                           )),
  requester_agent_id       uuid REFERENCES agents (id) ON DELETE RESTRICT,
  target_resource_ids      text[] NOT NULL DEFAULT '{}',
  max_budget_minor         bigint CHECK (max_budget_minor IS NULL OR max_budget_minor >= 0),
  priority                 integer NOT NULL DEFAULT 0,
  mode                     text NOT NULL CHECK (mode IN ('sequential', 'parallel')),
  prevent_self_review      boolean NOT NULL DEFAULT true,
  require_distinct_reviewers boolean NOT NULL DEFAULT true
                               CHECK (require_distinct_reviewers = true),
  max_duration_seconds     integer NOT NULL DEFAULT 604800
                               CHECK (max_duration_seconds BETWEEN 60 AND 7776000),
  steps                    jsonb NOT NULL,
  active                   boolean NOT NULL DEFAULT true,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT approval_policies_key UNIQUE (workspace_id, key, version)
);
CREATE UNIQUE INDEX IF NOT EXISTS approval_policies_one_active_key
  ON approval_policies (workspace_id, key) WHERE active;
CREATE INDEX IF NOT EXISTS approval_policies_match_idx
  ON approval_policies (workspace_id, approval_type, active, priority DESC);

DROP TRIGGER IF EXISTS approval_policies_updated_at ON approval_policies;
CREATE TRIGGER approval_policies_updated_at BEFORE UPDATE ON approval_policies
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS approval_requests (
  request_id              uuid PRIMARY KEY REFERENCES requests (id) ON DELETE CASCADE,
  workspace_id            uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  policy_id               uuid NOT NULL REFERENCES approval_policies (id) ON DELETE RESTRICT,
  policy_version          integer NOT NULL CHECK (policy_version >= 1),
  authorization_revision integer NOT NULL DEFAULT 1 CHECK (authorization_revision >= 1),
  authorization_hash     text NOT NULL CHECK (authorization_hash ~ '^sha256:[0-9a-f]{64}$'),
  status                 text NOT NULL DEFAULT 'pending' CHECK (status IN (
                           'pending', 'approved', 'declined', 'changes_requested',
                           'expired', 'withdrawn'
                         )),
  expires_at             timestamptz NOT NULL,
  requester_agent_id     uuid NOT NULL REFERENCES agents (id) ON DELETE RESTRICT,
  requester_member_id    uuid REFERENCES members (id) ON DELETE SET NULL,
  requester_user_id      uuid REFERENCES users (id) ON DELETE SET NULL,
  source_session_id      uuid REFERENCES sessions (id) ON DELETE SET NULL,
  source_run_id          uuid REFERENCES runs (id) ON DELETE SET NULL,
  proposal_idempotency_key text NOT NULL,
  proposal_idempotency_hash text NOT NULL,
  effect_kind            text NOT NULL CHECK (effect_kind IN (
                           'none', 'access', 'communication', 'shared_learning_publish',
                           'data_disclosure', 'record_change', 'agent_governance_change'
                         )),
  effect_status          text NOT NULL DEFAULT 'not_required' CHECK (effect_status IN (
                           'not_required', 'waiting', 'unavailable', 'executed', 'failed', 'cancelled'
                         )),
  effect_reason          text,
  work_status            text NOT NULL DEFAULT 'waiting' CHECK (work_status IN (
                           'waiting', 'ready', 'admitted', 'completed', 'cancelled'
                         )),
  work_reason            text,
  continuation_id        uuid,
  finalization_job_id    uuid REFERENCES jobs (id) ON DELETE SET NULL,
  finalized_at           timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT approval_requests_proposal_key UNIQUE (workspace_id, proposal_idempotency_key),
  CONSTRAINT approval_requests_proposal_hash_check CHECK (proposal_idempotency_hash ~ '^[0-9a-f]{64}$')
);
CREATE INDEX IF NOT EXISTS approval_requests_attention_idx
  ON approval_requests (workspace_id, status, expires_at, created_at DESC);

DROP TRIGGER IF EXISTS approval_requests_updated_at ON approval_requests;
CREATE TRIGGER approval_requests_updated_at BEFORE UPDATE ON approval_requests
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Keep iterative re-application compatible with a throwaway database that
-- received an earlier draft of this not-yet-released migration.
ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS proposal_idempotency_hash text DEFAULT repeat('0', 64);
ALTER TABLE approval_requests ALTER COLUMN proposal_idempotency_hash SET DEFAULT repeat('0', 64);
ALTER TABLE approval_requests ALTER COLUMN proposal_idempotency_hash SET NOT NULL;
ALTER TABLE approval_requests ALTER COLUMN proposal_idempotency_hash DROP DEFAULT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'approval_requests_proposal_hash_check') THEN
    ALTER TABLE approval_requests ADD CONSTRAINT approval_requests_proposal_hash_check
      CHECK (proposal_idempotency_hash ~ '^[0-9a-f]{64}$');
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS approval_revisions (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id           uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  request_id             uuid NOT NULL REFERENCES approval_requests (request_id) ON DELETE CASCADE,
  revision               integer NOT NULL CHECK (revision >= 1),
  authorization_hash     text NOT NULL CHECK (authorization_hash ~ '^sha256:[0-9a-f]{64}$'),
  payload                jsonb NOT NULL,
  status                 text NOT NULL DEFAULT 'pending' CHECK (status IN (
                           'pending', 'approved', 'declined', 'changes_requested',
                           'expired', 'superseded', 'withdrawn'
                         )),
  created_by_type        text NOT NULL CHECK (created_by_type IN ('user', 'agent', 'system')),
  created_by_user_id     uuid REFERENCES users (id) ON DELETE SET NULL,
  created_by_agent_id    uuid REFERENCES agents (id) ON DELETE SET NULL,
  superseded_at          timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT approval_revisions_number UNIQUE (request_id, revision),
  CONSTRAINT approval_revisions_hash UNIQUE (request_id, authorization_hash)
);

CREATE TABLE IF NOT EXISTS approval_votes (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id           uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  request_id             uuid NOT NULL REFERENCES approval_requests (request_id) ON DELETE CASCADE,
  revision               integer NOT NULL,
  authorization_hash     text NOT NULL,
  step_id                text NOT NULL,
  decision               text NOT NULL CHECK (decision IN ('approve', 'decline', 'request_changes')),
  reviewer_member_id     uuid NOT NULL REFERENCES members (id) ON DELETE RESTRICT,
  reviewer_user_id       uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  note                   text,
  idempotency_key        text NOT NULL,
  recorded_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT approval_votes_once UNIQUE (request_id, revision, step_id, reviewer_member_id),
  CONSTRAINT approval_votes_idempotency UNIQUE (workspace_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS approval_votes_request_idx
  ON approval_votes (request_id, revision, recorded_at);

CREATE TABLE IF NOT EXISTS approval_routes (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  request_id          uuid NOT NULL REFERENCES approval_requests (request_id) ON DELETE CASCADE,
  revision            integer NOT NULL,
  step_id             text NOT NULL,
  reviewer_member_id  uuid NOT NULL REFERENCES members (id) ON DELETE RESTRICT,
  routed_by_member_id uuid NOT NULL REFERENCES members (id) ON DELETE RESTRICT,
  reason              text NOT NULL,
  idempotency_key     text NOT NULL,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT approval_routes_idempotency UNIQUE (workspace_id, idempotency_key)
);
CREATE INDEX IF NOT EXISTS approval_routes_current_idx
  ON approval_routes (request_id, revision, step_id, created_at DESC);

-- One namespace across human commands means reusing an idempotency key for a
-- different operation is a conflict rather than an accidental replay.
CREATE TABLE IF NOT EXISTS approval_commands (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  request_id      uuid NOT NULL REFERENCES approval_requests (request_id) ON DELETE CASCADE,
  operation       text NOT NULL CHECK (operation IN ('decision', 'revision', 'route')),
  idempotency_key text NOT NULL,
  command_hash    text NOT NULL,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT approval_commands_idempotency UNIQUE (workspace_id, idempotency_key),
  CONSTRAINT approval_commands_hash_check CHECK (command_hash ~ '^[0-9a-f]{64}$')
);

ALTER TABLE approval_commands ADD COLUMN IF NOT EXISTS command_hash text DEFAULT repeat('0', 64);
ALTER TABLE approval_commands ALTER COLUMN command_hash SET DEFAULT repeat('0', 64);
ALTER TABLE approval_commands ALTER COLUMN command_hash SET NOT NULL;
ALTER TABLE approval_commands ALTER COLUMN command_hash DROP DEFAULT;
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'approval_commands_hash_check') THEN
    ALTER TABLE approval_commands ADD CONSTRAINT approval_commands_hash_check
      CHECK (command_hash ~ '^[0-9a-f]{64}$');
  END IF;
END $$;

-- Votes, routes and command dedupe records are facts, never mutable state.
DROP TRIGGER IF EXISTS approval_votes_append_only ON approval_votes;
CREATE TRIGGER approval_votes_append_only BEFORE UPDATE OR DELETE ON approval_votes
  FOR EACH ROW EXECUTE FUNCTION refuse_mutation();
DROP TRIGGER IF EXISTS approval_routes_append_only ON approval_routes;
CREATE TRIGGER approval_routes_append_only BEFORE UPDATE OR DELETE ON approval_routes
  FOR EACH ROW EXECUTE FUNCTION refuse_mutation();
DROP TRIGGER IF EXISTS approval_commands_append_only ON approval_commands;
CREATE TRIGGER approval_commands_append_only BEFORE UPDATE OR DELETE ON approval_commands
  FOR EACH ROW EXECUTE FUNCTION refuse_mutation();

-- New audit kinds are deliberate schema changes. `superseded` is a revision
-- state; the top-level request remains on its current revision/status.
ALTER TABLE events DROP CONSTRAINT IF EXISTS events_kind_check;
ALTER TABLE events ADD CONSTRAINT events_kind_check CHECK (kind IN (
  'decision.recorded', 'request.created', 'effect.assigned', 'effect.executed', 'effect.cancelled',
  'document.created', 'document.versioned', 'member.invited', 'member.joined', 'member.role_changed',
  'member.removed', 'instruction.saved', 'instruction.proposed', 'context.set', 'settings.changed',
  'session.shared', 'session.unshared', 'provider_key.added', 'provider_key.verified',
  'provider_key.revoked', 'workspace.created', 'workspace.deletion_scheduled', 'subject.redacted',
  'run.errored', 'usage.cap_warning', 'workspace.deletion_cancelled', 'workspace.deleted',
  'provider_key.attested', 'provider_key.rewrapped', 'validator.failed',
  'approval.proposed', 'approval.vote_recorded', 'approval.revised', 'approval.routed',
  'approval.finalized', 'approval.expired'
));

-- Every new table is tenant-isolated on first application; re-applying 0003
-- reaches the same end state during the migration idempotence check.
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'agent_owners', 'approval_resources', 'approval_policies', 'approval_requests',
    'approval_revisions', 'approval_votes', 'approval_routes', 'approval_commands'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (workspace_id = app_workspace_id()) WITH CHECK (workspace_id = app_workspace_id())',
      t
    );
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON
  agent_owners, approval_resources, approval_policies, approval_requests, approval_revisions
TO app;
GRANT SELECT, INSERT ON approval_votes, approval_routes, approval_commands TO app;

-- Runtime may inspect status through its tenant-bound connection. It cannot
-- author policy, vote, route, revise, finalize or enqueue continuation jobs.
GRANT SELECT ON
  agent_owners, approval_resources, approval_policies, approval_requests,
  approval_revisions, approval_votes, approval_routes
TO agent;
REVOKE INSERT, UPDATE, DELETE ON
  agent_owners, approval_resources, approval_policies, approval_requests,
  approval_revisions, approval_votes, approval_routes, approval_commands
FROM agent;
