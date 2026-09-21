-- 0067_demo_access_requests.sql
-- The budget behind the public request-access form.
--
-- `POST /demo/request-access` takes an email and a passcode from somebody with
-- no session, and tells them whether the passcode was right. That is a
-- guessing oracle unless every attempt is counted somewhere that survives the
-- isolate, so each attempt is a row here and the route refuses once an address
-- or a caller has spent its hourly budget. Outcomes are recorded too, so a
-- flood of wrong passcodes is visible after the fact.
--
-- A platform table, outside row-level security, for the same reason
-- `rate_counters` is (0001): the request has no workspace yet, and a limit
-- that can be evaded by failing to set the tenant key is not a limit. It has no
-- `workspace_id` column, so the guard in 0012 does not need to exempt it.
CREATE TABLE IF NOT EXISTS demo_access_requests (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email      text NOT NULL CHECK (email = lower(email)),
  -- SHA-256 of the connecting address. The raw address is never stored; the
  -- hash keys the per-caller budget and nothing else.
  ip_hash    text NOT NULL,
  outcome    text NOT NULL CHECK (outcome IN (
               'invited', 'resent', 'already_member', 'passcode_invalid',
               'domain_not_allowed', 'rate_limited', 'unavailable', 'failed')),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS demo_access_requests_email_idx ON demo_access_requests (email, created_at);
CREATE INDEX IF NOT EXISTS demo_access_requests_ip_idx ON demo_access_requests (ip_hash, created_at);
CREATE INDEX IF NOT EXISTS demo_access_requests_created_idx ON demo_access_requests (created_at);

-- DELETE so the route can prune rows older than the budget's memory; the run
-- engine has no business here at all.
GRANT SELECT, INSERT, DELETE ON demo_access_requests TO app;
REVOKE ALL ON demo_access_requests FROM agent;
