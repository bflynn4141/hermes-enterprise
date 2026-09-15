-- 0006_views.sql
-- Counts are derived, never stored.
--
-- The demo made the Inbox badge, Overview and History counts selectors over one
-- state, so 4 -> 0 worked in any order and no counter could drift. These views
-- are the same idea in Postgres: there is no `pending_count` column to forget
-- to decrement.
--
-- `security_invoker = true` makes each view run with the caller's privileges
-- and the caller's row-level security, so a view is never a way around the
-- tenant policy.

CREATE OR REPLACE VIEW v_inbox_count WITH (security_invoker = true) AS
  SELECT workspace_id, count(*)::integer AS pending
  FROM requests
  WHERE status = 'pending'
  GROUP BY workspace_id;

-- An admitted applicant's access is not granted by the admission: it is a
-- pending effect waiting for someone holding the `access` reviewer role.
CREATE OR REPLACE VIEW v_pending_grants WITH (security_invoker = true) AS
  SELECT e.workspace_id, count(*)::integer AS pending
  FROM effects e
  WHERE e.kind = 'access_grant' AND e.status IN ('pending', 'assigned')
  GROUP BY e.workspace_id;

CREATE OR REPLACE VIEW v_created_documents WITH (security_invoker = true) AS
  SELECT d.workspace_id,
         d.id AS document_id,
         d.request_id,
         d.kind,
         d.version,
         d.render_status,
         r.status AS request_status,
         d.created_at
  FROM documents d
  JOIN requests r ON r.id = d.request_id
  WHERE r.status IN ('created', 'drafted');

CREATE OR REPLACE VIEW v_decision_count WITH (security_invoker = true) AS
  SELECT workspace_id,
         count(*)::integer AS decisions,
         count(*) FILTER (WHERE decision = 'approve')::integer AS approved,
         count(*) FILTER (WHERE decision = 'decline')::integer AS declined
  FROM decisions
  GROUP BY workspace_id;

-- What the sessions list shows: the state of the session's live run, if any.
-- A session with no live run is idle, which is why the join is LEFT and the
-- status falls back rather than disappearing.
CREATE OR REPLACE VIEW v_session_status WITH (security_invoker = true) AS
  SELECT s.workspace_id,
         s.id AS session_id,
         s.owner_id,
         COALESCE(r.status, 'idle') AS status,
         r.id AS run_id,
         r.attempt,
         r.stop_requested,
         r.waiting_label,
         s.last_activity_at
  FROM sessions s
  LEFT JOIN LATERAL (
    SELECT id, status, attempt, stop_requested, waiting_label
    FROM runs
    WHERE runs.session_id = s.id AND runs.status IN ('working', 'waiting', 'stopping')
    ORDER BY runs.started_at DESC
    LIMIT 1
  ) r ON true;

GRANT SELECT ON v_inbox_count, v_pending_grants, v_created_documents, v_decision_count, v_session_status TO app;
GRANT SELECT ON v_inbox_count, v_session_status TO agent;
