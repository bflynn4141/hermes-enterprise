-- 0004_grants.sql
-- Three roles, and the grants that make "the runtime never decides" a database
-- fact rather than a code convention.
--
--   owner  migrations and the SECURITY DEFINER redaction procedure. Owns every
--          object; still subject to RLS because every tenant table is FORCEd.
--   app    the Worker. Serves requests, records decisions, writes jobs.
--   agent  the run engine's Workflow steps. It may propose, note, append turns
--          and emit run and message events. It may not decide, execute an
--          effect, invite, change a role, or write a job.
--
-- Layer 1 of three (the other two are the AgentDb type and the red-team tests).
-- Every line here is asserted in CI: if someone grants the agent role INSERT on
-- decisions in a year's time, the grant test fails before the deploy does.

-- Nothing is public. Start from zero on every run so the file is idempotent
-- and so a grant deleted from this file is actually removed.
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM app, agent;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM app, agent;

GRANT USAGE ON SCHEMA public TO app, agent;
GRANT EXECUTE ON FUNCTION app_workspace_id() TO app, agent;
GRANT EXECUTE ON FUNCTION app_user_id() TO app, agent;
GRANT EXECUTE ON FUNCTION hermes_tenant_tables() TO app, agent;

-- ---------------------------------------------------------------------------
-- app
-- ---------------------------------------------------------------------------

-- Rows the Worker creates and removes outright.
GRANT SELECT, INSERT, UPDATE, DELETE ON
  sessions, session_shares, run_queue, jobs, agent_capabilities, agent_files,
  agent_context_fields, agent_skills, invitations, user_notification_settings,
  message_feedback, workos_sync
TO app;

-- Rows the Worker creates and amends but never removes: History has to keep
-- rendering after a withdrawal, a revocation or a redaction.
GRANT SELECT, INSERT, UPDATE ON
  workspaces, members, workspace_settings, agents, instruction_versions,
  skill_versions, messages, runs, run_steps, run_turns, requests, request_notes,
  effects, documents, workspace_provider_keys, model_calls
TO app;

-- Append-only for everyone, including the Worker.
GRANT SELECT, INSERT ON decisions, events, stream_events TO app;

-- Platform tables.
GRANT SELECT, INSERT, UPDATE ON users TO app;
GRANT SELECT, INSERT, UPDATE, DELETE ON auth_sessions TO app;
GRANT SELECT, INSERT, UPDATE, DELETE ON rate_counters TO app;
GRANT SELECT ON catalog TO app;
GRANT SELECT, UPDATE ON workos_events_cursor TO app;
GRANT SELECT ON schema_migrations TO app;

GRANT USAGE, SELECT ON SEQUENCE stream_events_id_seq TO app;

-- ---------------------------------------------------------------------------
-- agent
-- ---------------------------------------------------------------------------

-- What the run engine may read. It reads its own workspace's provider key row
-- because `resolveKey` runs inside the step; the plaintext exists only for that
-- request, and only the id is ever logged.
GRANT SELECT ON
  workspaces, members, users, workspace_settings, agents, agent_capabilities,
  agent_files, agent_skills, skill_versions, sessions, messages, requests,
  request_notes, documents, runs, run_steps, run_turns, run_queue,
  instruction_versions, agent_context_fields, events, catalog,
  workspace_provider_keys, model_calls, effects, decisions
TO agent;

-- What it may add. Each of these tables carries (run_id, tool_call_id) with a
-- UNIQUE index, so a step that runs twice writes one row.
GRANT INSERT ON
  requests, request_notes, documents, run_turns, run_steps, messages,
  model_calls, stream_events, agent_context_fields, instruction_versions
TO agent;

-- What it may amend: its own run's progress and its own streaming message.
-- Note what is absent: no UPDATE on requests, so it cannot move a request out
-- of `pending` and around the decision route.
GRANT UPDATE ON runs, run_steps, messages, sessions, agent_context_fields TO agent;

GRANT USAGE, SELECT ON SEQUENCE stream_events_id_seq TO agent;

-- ---------------------------------------------------------------------------
-- The revocations that carry the invariant
-- ---------------------------------------------------------------------------

-- Said explicitly, even though the grants above never gave them, because this
-- is the list a reviewer checks and the list CI asserts.
REVOKE INSERT, UPDATE, DELETE ON decisions FROM agent;
REVOKE INSERT, UPDATE, DELETE ON effects FROM agent;
REVOKE INSERT, UPDATE, DELETE ON members FROM agent;
REVOKE INSERT, UPDATE, DELETE ON invitations FROM agent;
REVOKE ALL ON jobs FROM agent;
REVOKE UPDATE, DELETE ON requests FROM agent;
REVOKE UPDATE, DELETE ON documents FROM agent;
REVOKE ALL ON auth_sessions, rate_counters, workos_events_cursor, workos_sync,
  session_shares, message_feedback, user_notification_settings FROM agent;

-- The audit table is append-only for every role. UPDATE and DELETE are revoked
-- here and a trigger (0005) refuses them for the owner too, which REVOKE cannot
-- reach.
REVOKE UPDATE, DELETE ON events FROM app, agent;
REVOKE UPDATE, DELETE ON stream_events FROM app, agent;

-- Future tables default to no access, so adding a table without thinking about
-- grants fails closed rather than open.
ALTER DEFAULT PRIVILEGES IN SCHEMA public REVOKE ALL ON TABLES FROM PUBLIC;
