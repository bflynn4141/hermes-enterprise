-- Partnerships + Finance: one composite agent per human principal, using one
-- server-enforced connector. Private records are deliberately app-role only;
-- agents reach them through a run-scoped capability check, never direct SQL.

CREATE UNIQUE INDEX IF NOT EXISTS agents_workspace_id_id_key ON agents (workspace_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS sessions_workspace_id_id_key ON sessions (workspace_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS runs_workspace_id_id_key ON runs (workspace_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS requests_workspace_id_id_key ON requests (workspace_id, id);

CREATE TABLE IF NOT EXISTS enterprise_teams (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id  uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  slug          text NOT NULL CHECK (slug IN ('partnerships', 'finance')),
  name          text NOT NULL CHECK (name IN ('Partnerships', 'Finance')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT enterprise_teams_workspace_slug_key UNIQUE (workspace_id, slug),
  CONSTRAINT enterprise_teams_workspace_id_key UNIQUE (workspace_id, id)
);

CREATE TABLE IF NOT EXISTS enterprise_team_agents (
  workspace_id       uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  team_id            uuid NOT NULL,
  agent_id           uuid NOT NULL,
  principal_user_id  uuid NOT NULL,
  role_template_key  text NOT NULL CHECK (role_template_key IN ('partnerships-agent', 'finance-agent')),
  role_template_version text NOT NULL DEFAULT '1.0.0',
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, team_id, agent_id),
  CONSTRAINT enterprise_team_agents_team_fk FOREIGN KEY (workspace_id, team_id)
    REFERENCES enterprise_teams (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT enterprise_team_agents_agent_fk FOREIGN KEY (workspace_id, agent_id)
    REFERENCES agents (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT enterprise_team_agents_principal_fk FOREIGN KEY (workspace_id, principal_user_id)
    REFERENCES members (workspace_id, user_id) ON DELETE RESTRICT,
  CONSTRAINT enterprise_team_agents_one_agent_key UNIQUE (workspace_id, agent_id),
  CONSTRAINT enterprise_team_agents_one_principal_key UNIQUE (workspace_id, principal_user_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS enterprise_team_agents_one_team_key
  ON enterprise_team_agents (workspace_id, team_id);
DROP TRIGGER IF EXISTS enterprise_team_agents_updated_at ON enterprise_team_agents;
CREATE TRIGGER enterprise_team_agents_updated_at BEFORE UPDATE ON enterprise_team_agents
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Bundled skill artifacts are immutable identities. A requirement may be
-- checked against one, but never grants authority on its own.
CREATE TABLE IF NOT EXISTS enterprise_skill_artifacts (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  skill_key      text NOT NULL,
  skill_version  text NOT NULL,
  digest         text NOT NULL CHECK (digest ~ '^sha256:[0-9a-f]{64}$'),
  manifest       jsonb NOT NULL CHECK (jsonb_typeof(manifest) = 'object'),
  created_at     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT enterprise_skill_artifacts_version_key UNIQUE (skill_key, skill_version),
  CONSTRAINT enterprise_skill_artifacts_digest_key UNIQUE (digest)
);

CREATE OR REPLACE FUNCTION prevent_enterprise_skill_artifact_change()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'enterprise skill artifacts are immutable';
END
$$;
DROP TRIGGER IF EXISTS enterprise_skill_artifacts_immutable ON enterprise_skill_artifacts;
CREATE TRIGGER enterprise_skill_artifacts_immutable BEFORE UPDATE OR DELETE ON enterprise_skill_artifacts
  FOR EACH ROW EXECUTE FUNCTION prevent_enterprise_skill_artifact_change();

INSERT INTO enterprise_skill_artifacts (skill_key, skill_version, digest, manifest) VALUES
  ('partner-program-screening', '1.7.0',
   'sha256:9f124ce44aa318b13e9f8ccfd92072d8b3ba6a22030eaad31cfafbfda3a1e2a9',
   '{"runtime_name":"enterprise_bridge:partner-program-screening","role_template":"partnerships-agent","required_capabilities":["partner.discovery.read","partner.review.prepare","partner.outreach.draft","partner.records.qualification.write","partner.handoff.publish"]}'::jsonb),
  ('partner-invoice-review', '1.0.0',
   'sha256:f0f6c637aa48293825b6282cdda542577c5ce965996ebbbdacc7ad3b691f7ae5',
   '{"runtime_name":"enterprise_bridge:partner-invoice-review","role_template":"finance-agent","required_capabilities":["partner.shared.read","partner.invoice.read","partner.invoice.review.prepare"]}'::jsonb)
ON CONFLICT (skill_key, skill_version) DO NOTHING;

ALTER TABLE enterprise_skill_assignments
  ADD COLUMN IF NOT EXISTS team_id uuid,
  ADD COLUMN IF NOT EXISTS artifact_id uuid REFERENCES enterprise_skill_artifacts (id) ON DELETE RESTRICT;
ALTER TABLE enterprise_skill_assignments
  ALTER COLUMN schedule SET DEFAULT '{"enabled":false,"interval_minutes":360}'::jsonb;
DO $$ BEGIN
  ALTER TABLE enterprise_skill_assignments ADD CONSTRAINT enterprise_skill_assignments_team_fk
    FOREIGN KEY (workspace_id, team_id) REFERENCES enterprise_teams (workspace_id, id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE enterprise_skill_assignment_revisions
  ADD COLUMN IF NOT EXISTS team_id uuid,
  ADD COLUMN IF NOT EXISTS artifact_id uuid REFERENCES enterprise_skill_artifacts (id) ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION capture_enterprise_skill_assignment_revision()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO enterprise_skill_assignment_revisions
    (assignment_id, workspace_id, revision, skill_version, state, config,
     capability_grants, schedule, approval_policy, team_id, artifact_id, changed_by)
  VALUES
    (NEW.id, NEW.workspace_id, NEW.revision, NEW.skill_version, NEW.state, NEW.config,
     NEW.capability_grants, NEW.schedule, NEW.approval_policy, NEW.team_id, NEW.artifact_id,
     COALESCE(
       (SELECT id FROM users WHERE id = NULLIF(current_setting('app.user_id', true), '')::uuid),
       NEW.assigned_by
     ));
  RETURN NEW;
END
$$;

CREATE TABLE IF NOT EXISTS enterprise_connection_bindings (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  team_id            uuid NOT NULL,
  connector_key      text NOT NULL CHECK (connector_key = 'enterprise-partner-records'),
  state              text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'paused', 'revoked')),
  capability_grants  text[] NOT NULL DEFAULT '{}',
  capability_denies  text[] NOT NULL DEFAULT '{}',
  resource_scope     jsonb NOT NULL CHECK (jsonb_typeof(resource_scope) = 'object'),
  created_by         uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT enterprise_connection_bindings_team_fk FOREIGN KEY (workspace_id, team_id)
    REFERENCES enterprise_teams (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT enterprise_connection_bindings_key UNIQUE (workspace_id, team_id, connector_key)
);
DROP TRIGGER IF EXISTS enterprise_connection_bindings_updated_at ON enterprise_connection_bindings;
CREATE TRIGGER enterprise_connection_bindings_updated_at BEFORE UPDATE ON enterprise_connection_bindings
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS partner_records (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  team_id            uuid NOT NULL,
  owner_agent_id     uuid NOT NULL,
  kind               text NOT NULL CHECK (kind IN (
                       'qualification', 'outreach_draft', 'engagement', 'invoice',
                       'invoice_review', 'needs_information'
                     )),
  partner_id         uuid NOT NULL,
  revision           integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  data               jsonb NOT NULL CHECK (jsonb_typeof(data) = 'object'),
  evidence_ids       text[] NOT NULL DEFAULT '{}',
  source_session_id  uuid NOT NULL,
  source_run_id      uuid NOT NULL,
  idempotency_key    text NOT NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT partner_records_team_fk FOREIGN KEY (workspace_id, team_id)
    REFERENCES enterprise_teams (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT partner_records_agent_fk FOREIGN KEY (workspace_id, owner_agent_id)
    REFERENCES agents (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT partner_records_session_fk FOREIGN KEY (workspace_id, source_session_id)
    REFERENCES sessions (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT partner_records_run_fk FOREIGN KEY (workspace_id, source_run_id)
    REFERENCES runs (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT partner_records_idempotency_key UNIQUE (workspace_id, team_id, owner_agent_id, kind, idempotency_key),
  CONSTRAINT partner_records_workspace_id_key UNIQUE (workspace_id, id)
);
CREATE INDEX IF NOT EXISTS partner_records_team_kind_idx
  ON partner_records (workspace_id, team_id, kind, created_at DESC);

CREATE OR REPLACE FUNCTION enforce_partner_record_revision()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.workspace_id <> OLD.workspace_id OR NEW.team_id <> OLD.team_id
     OR NEW.owner_agent_id <> OLD.owner_agent_id OR NEW.kind <> OLD.kind
     OR NEW.partner_id <> OLD.partner_id OR NEW.source_session_id <> OLD.source_session_id
     OR NEW.source_run_id <> OLD.source_run_id OR NEW.idempotency_key <> OLD.idempotency_key THEN
    RAISE EXCEPTION 'partner record identity is immutable';
  END IF;
  IF NEW.revision <> OLD.revision + 1 THEN
    RAISE EXCEPTION 'partner record revision must increase by one';
  END IF;
  NEW.updated_at := now();
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS partner_records_revision_guard ON partner_records;
CREATE TRIGGER partner_records_revision_guard BEFORE UPDATE ON partner_records
  FOR EACH ROW EXECUTE FUNCTION enforce_partner_record_revision();

CREATE TABLE IF NOT EXISTS partner_handoffs (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id           uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  from_team_id           uuid NOT NULL,
  to_team_id             uuid NOT NULL,
  source_record_id       uuid NOT NULL,
  source_record_revision integer NOT NULL CHECK (source_record_revision > 0),
  invoice_record_id      uuid NOT NULL,
  invoice_record_revision integer NOT NULL CHECK (invoice_record_revision > 0),
  projection             jsonb NOT NULL CHECK (jsonb_typeof(projection) = 'object'),
  source_session_id      uuid NOT NULL,
  requested_by           uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  status                 text NOT NULL DEFAULT 'queued' CHECK (status IN (
                           'queued', 'processing', 'completed', 'needs_information', 'failed', 'stale'
                         )),
  result_reason          text,
  simulated              boolean NOT NULL DEFAULT false,
  idempotency_key        text NOT NULL,
  completed_at           timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT partner_handoffs_from_team_fk FOREIGN KEY (workspace_id, from_team_id)
    REFERENCES enterprise_teams (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT partner_handoffs_to_team_fk FOREIGN KEY (workspace_id, to_team_id)
    REFERENCES enterprise_teams (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT partner_handoffs_source_record_fk FOREIGN KEY (workspace_id, source_record_id)
    REFERENCES partner_records (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT partner_handoffs_invoice_record_fk FOREIGN KEY (workspace_id, invoice_record_id)
    REFERENCES partner_records (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT partner_handoffs_source_session_fk FOREIGN KEY (workspace_id, source_session_id)
    REFERENCES sessions (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT partner_handoffs_distinct_teams CHECK (from_team_id <> to_team_id),
  CONSTRAINT partner_handoffs_idempotency_key UNIQUE (workspace_id, from_team_id, idempotency_key),
  CONSTRAINT partner_handoffs_workspace_id_key UNIQUE (workspace_id, id)
);
CREATE INDEX IF NOT EXISTS partner_handoffs_recipient_idx
  ON partner_handoffs (workspace_id, to_team_id, status, created_at DESC);
DROP TRIGGER IF EXISTS partner_handoffs_updated_at ON partner_handoffs;
CREATE TRIGGER partner_handoffs_updated_at BEFORE UPDATE ON partner_handoffs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS enterprise_run_grants (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  run_id                uuid NOT NULL,
  agent_id              uuid NOT NULL,
  team_id               uuid NOT NULL,
  assignment_id         uuid NOT NULL REFERENCES enterprise_skill_assignments (id) ON DELETE RESTRICT,
  assignment_revision   integer NOT NULL CHECK (assignment_revision > 0),
  artifact_id           uuid NOT NULL REFERENCES enterprise_skill_artifacts (id) ON DELETE RESTRICT,
  artifact_digest       text NOT NULL CHECK (artifact_digest ~ '^sha256:[0-9a-f]{64}$'),
  connection_binding_id uuid NOT NULL REFERENCES enterprise_connection_bindings (id) ON DELETE RESTRICT,
  capability            text NOT NULL,
  resource_kind         text NOT NULL CHECK (resource_kind IN ('team_records', 'handoff')),
  resource_id           uuid,
  allowed_fields        text[] NOT NULL DEFAULT '{}',
  allowed_actions       text[] NOT NULL DEFAULT '{}',
  effect                text NOT NULL CHECK (effect IN ('allow', 'deny')),
  created_at            timestamptz NOT NULL DEFAULT now(),
  revoked_at            timestamptz,
  CONSTRAINT enterprise_run_grants_run_fk FOREIGN KEY (workspace_id, run_id)
    REFERENCES runs (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT enterprise_run_grants_agent_fk FOREIGN KEY (workspace_id, agent_id)
    REFERENCES agents (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT enterprise_run_grants_team_fk FOREIGN KEY (workspace_id, team_id)
    REFERENCES enterprise_teams (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT enterprise_run_grants_key UNIQUE (
    run_id, capability, resource_kind, resource_id, effect
  )
);
CREATE INDEX IF NOT EXISTS enterprise_run_grants_lookup_idx
  ON enterprise_run_grants (workspace_id, run_id, agent_id, capability, effect)
  WHERE revoked_at IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS enterprise_run_grants_snapshot_key
  ON enterprise_run_grants (
    run_id, capability, resource_kind, COALESCE(resource_id, '00000000-0000-0000-0000-000000000000'::uuid), effect
  );

CREATE TABLE IF NOT EXISTS partner_workflow_executions (
  handoff_id         uuid PRIMARY KEY,
  workspace_id      uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  finance_agent_id  uuid NOT NULL,
  finance_session_id uuid,
  finance_run_id    uuid,
  request_id        uuid REFERENCES requests (id) ON DELETE SET NULL,
  result_record_id  uuid,
  status            text NOT NULL DEFAULT 'queued' CHECK (status IN (
                      'queued', 'processing', 'completed', 'needs_information', 'failed', 'stale'
                    )),
  result_reason     text,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT partner_workflow_executions_handoff_fk FOREIGN KEY (workspace_id, handoff_id)
    REFERENCES partner_handoffs (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT partner_workflow_executions_agent_fk FOREIGN KEY (workspace_id, finance_agent_id)
    REFERENCES agents (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT partner_workflow_executions_session_fk FOREIGN KEY (workspace_id, finance_session_id)
    REFERENCES sessions (workspace_id, id) ON DELETE SET NULL,
  CONSTRAINT partner_workflow_executions_run_fk FOREIGN KEY (workspace_id, finance_run_id)
    REFERENCES runs (workspace_id, id) ON DELETE SET NULL,
  CONSTRAINT partner_workflow_executions_result_fk FOREIGN KEY (workspace_id, result_record_id)
    REFERENCES partner_records (workspace_id, id) ON DELETE SET NULL
);
DROP TRIGGER IF EXISTS partner_workflow_executions_updated_at ON partner_workflow_executions;
CREATE TRIGGER partner_workflow_executions_updated_at BEFORE UPDATE ON partner_workflow_executions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Most legacy Inbox rows remain workspace-visible. A row with one or more
-- audiences is private to the named principals, including direct-id reads.
CREATE TABLE IF NOT EXISTS request_audiences (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  request_id   uuid NOT NULL REFERENCES requests (id) ON DELETE CASCADE,
  user_id      uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  purpose      text NOT NULL CHECK (purpose IN ('owner', 'reviewer')),
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (request_id, user_id)
);
DO $$ BEGIN
  ALTER TABLE request_audiences ADD CONSTRAINT request_audiences_request_workspace_fk
    FOREIGN KEY (workspace_id, request_id) REFERENCES requests (workspace_id, id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS request_audiences_user_idx
  ON request_audiences (workspace_id, user_id, request_id);
CREATE UNIQUE INDEX IF NOT EXISTS requests_partner_invoice_handoff_key
  ON requests (workspace_id, subject_key)
  WHERE subject_key LIKE 'partner-invoice-handoff:%';

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'enterprise_teams', 'enterprise_team_agents', 'enterprise_connection_bindings',
    'partner_records', 'partner_handoffs', 'enterprise_run_grants',
    'partner_workflow_executions', 'request_audiences'
  ] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (workspace_id = app_workspace_id()) WITH CHECK (workspace_id = app_workspace_id())',
      table_name
    );
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE ON enterprise_teams, enterprise_team_agents,
  enterprise_connection_bindings, partner_records, partner_handoffs,
  enterprise_run_grants, partner_workflow_executions, request_audiences TO app;
GRANT SELECT ON enterprise_skill_artifacts TO app, agent;
REVOKE ALL ON enterprise_teams, enterprise_team_agents, enterprise_connection_bindings,
  partner_records, partner_handoffs, enterprise_run_grants,
  partner_workflow_executions, request_audiences FROM agent;
REVOKE INSERT, UPDATE, DELETE ON enterprise_skill_artifacts FROM app, agent;

-- Agent-facing skill metadata is readable, but private connector data above is
-- not. Existing legacy assignment rows remain eligible with their old state;
-- new role-template assignments explicitly carry team + artifact identities.
GRANT SELECT ON enterprise_team_agents, enterprise_teams TO agent;
