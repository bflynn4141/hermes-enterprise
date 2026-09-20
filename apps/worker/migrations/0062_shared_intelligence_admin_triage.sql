-- Admin triage ranks only owner-shared, bounded Shared Intelligence proposals.
-- The queue never broadens access to raw traces or private conversation data.

CREATE TABLE IF NOT EXISTS shared_intelligence_goals (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id       uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  scope              text NOT NULL CHECK (scope IN ('workspace','team')),
  team_id            uuid,
  title              text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  detail             text NOT NULL CHECK (length(detail) BETWEEN 1 AND 1000),
  revision           integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  content_sha256     text NOT NULL CHECK (content_sha256 ~ '^[0-9a-f]{64}$'),
  active             boolean NOT NULL DEFAULT true,
  created_by_user_id uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shared_intelligence_goal_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT shared_intelligence_goal_scope CHECK (
    (scope='workspace' AND team_id IS NULL) OR (scope='team' AND team_id IS NOT NULL)
  ),
  CONSTRAINT shared_intelligence_goal_team_fk FOREIGN KEY (workspace_id, team_id)
    REFERENCES enterprise_teams (workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX IF NOT EXISTS shared_intelligence_goals_active_idx
  ON shared_intelligence_goals (workspace_id, active, created_at DESC);
DROP TRIGGER IF EXISTS shared_intelligence_goals_updated_at ON shared_intelligence_goals;
CREATE TRIGGER shared_intelligence_goals_updated_at BEFORE UPDATE ON shared_intelligence_goals
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE shared_intelligence_proposals
  ADD COLUMN IF NOT EXISTS triage_status text NOT NULL DEFAULT 'private',
  ADD COLUMN IF NOT EXISTS triage_goal_id uuid,
  ADD COLUMN IF NOT EXISTS triage_assessment jsonb,
  ADD COLUMN IF NOT EXISTS triage_submitted_at timestamptz,
  ADD COLUMN IF NOT EXISTS triage_decided_at timestamptz,
  ADD COLUMN IF NOT EXISTS triage_decided_by_user_id uuid,
  ADD COLUMN IF NOT EXISTS triage_decision_note text;

DO $$ BEGIN
  ALTER TABLE shared_intelligence_proposals
    ADD CONSTRAINT shared_intelligence_triage_status CHECK (triage_status IN ('private','queued','included','excluded'));
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE shared_intelligence_proposals
    ADD CONSTRAINT shared_intelligence_triage_goal_fk FOREIGN KEY (workspace_id, triage_goal_id)
      REFERENCES shared_intelligence_goals (workspace_id, id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE shared_intelligence_proposals
    ADD CONSTRAINT shared_intelligence_triage_decider_fk FOREIGN KEY (triage_decided_by_user_id)
      REFERENCES users (id) ON DELETE RESTRICT;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
DO $$ BEGIN
  ALTER TABLE shared_intelligence_proposals
    ADD CONSTRAINT shared_intelligence_triage_visibility CHECK (
      (triage_status='private' AND triage_goal_id IS NULL AND triage_assessment IS NULL AND triage_submitted_at IS NULL)
      OR (triage_status<>'private' AND triage_goal_id IS NOT NULL AND triage_assessment IS NOT NULL AND triage_submitted_at IS NOT NULL)
    );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
CREATE INDEX IF NOT EXISTS shared_intelligence_triage_queue_idx
  ON shared_intelligence_proposals (workspace_id, triage_status, triage_submitted_at DESC)
  WHERE triage_status <> 'private';

-- A source deletion withdraws the candidate from Admin as well as Library.
-- Keeping a revoked candidate in the queue would disclose an excerpt after
-- its owner removed the underlying run.
CREATE OR REPLACE FUNCTION revoke_shared_intelligence_for_deleted_run()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM library_source_team_grants grants
   USING shared_intelligence_proposals proposal,
         shared_intelligence_evidence evidence
   WHERE evidence.workspace_id=OLD.workspace_id
     AND evidence.source_run_id=OLD.id
     AND proposal.workspace_id=evidence.workspace_id
     AND proposal.id=evidence.proposal_id
     AND grants.workspace_id=proposal.workspace_id
     AND grants.source_id=proposal.library_source_id;

  UPDATE shared_intelligence_proposals proposal
     SET triage_status='private', triage_goal_id=NULL, triage_assessment=NULL,
         triage_submitted_at=NULL, triage_decided_at=NULL,
         triage_decided_by_user_id=NULL, triage_decision_note=NULL
    FROM shared_intelligence_evidence evidence
   WHERE evidence.workspace_id=OLD.workspace_id
     AND evidence.source_run_id=OLD.id
     AND proposal.workspace_id=evidence.workspace_id
     AND proposal.id=evidence.proposal_id;

  UPDATE shared_intelligence_proposals proposal
     SET status='revoked', revoked_at=COALESCE(proposal.revoked_at,now())
    FROM shared_intelligence_evidence evidence
   WHERE evidence.workspace_id=OLD.workspace_id
     AND evidence.source_run_id=OLD.id
     AND proposal.workspace_id=evidence.workspace_id
     AND proposal.id=evidence.proposal_id
     AND proposal.status NOT IN ('revoked','declined');

  UPDATE shared_intelligence_evidence
     SET approved_excerpt='[withdrawn by source owner]',
         revoked_at=COALESCE(revoked_at,now())
   WHERE workspace_id=OLD.workspace_id AND source_run_id=OLD.id;
  RETURN OLD;
END
$$;

CREATE TABLE IF NOT EXISTS shared_intelligence_triage_decisions (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id            uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  proposal_id             uuid NOT NULL REFERENCES shared_intelligence_proposals (id) ON DELETE CASCADE,
  actor_user_id           uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  decision                text NOT NULL CHECK (decision IN ('include','exclude','reopen','reassess')),
  previous_status         text NOT NULL CHECK (previous_status IN ('queued','included','excluded')),
  resulting_status        text NOT NULL CHECK (resulting_status IN ('queued','included','excluded')),
  note                    text NOT NULL DEFAULT '' CHECK (length(note) <= 1000),
  assessment_state_sha256 text NOT NULL CHECK (assessment_state_sha256 ~ '^[0-9a-f]{64}$'),
  created_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS shared_intelligence_triage_decisions_idx
  ON shared_intelligence_triage_decisions (workspace_id, proposal_id, created_at DESC);

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'shared_intelligence_goals', 'shared_intelligence_triage_decisions'
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

GRANT SELECT, INSERT, UPDATE ON shared_intelligence_goals TO app;
GRANT SELECT, INSERT ON shared_intelligence_triage_decisions TO app;
REVOKE ALL ON shared_intelligence_goals, shared_intelligence_triage_decisions FROM agent;
