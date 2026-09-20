-- Shared Intelligence promotes explicitly approved excerpts from private,
-- completed runs into reviewed Library source versions. Raw provider turns,
-- tool arguments/results and hidden reasoning never enter these tables.

CREATE TABLE IF NOT EXISTS shared_intelligence_proposals (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  created_by_user_id    uuid NOT NULL REFERENCES users (id) ON DELETE RESTRICT,
  requester_agent_id    uuid NOT NULL REFERENCES agents (id) ON DELETE RESTRICT,
  title                 text NOT NULL CHECK (length(title) BETWEEN 1 AND 200),
  goal                  text NOT NULL CHECK (length(goal) BETWEEN 1 AND 1000),
  lesson                text NOT NULL CHECK (length(lesson) BETWEEN 1 AND 4000),
  rationale             text NOT NULL CHECK (length(rationale) BETWEEN 1 AND 4000),
  target_team_ids       uuid[] NOT NULL CHECK (cardinality(target_team_ids) BETWEEN 1 AND 2),
  target_team_labels    text[] NOT NULL CHECK (cardinality(target_team_labels) = cardinality(target_team_ids)),
  dedupe_sha256         text NOT NULL CHECK (dedupe_sha256 ~ '^[0-9a-f]{64}$'),
  assessment            jsonb NOT NULL,
  status                text NOT NULL CHECK (status IN (
                          'needs_review', 'ready_for_review', 'pending_review',
                          'published', 'revoked', 'declined'
                        )),
  approval_request_id   uuid REFERENCES requests (id) ON DELETE SET NULL,
  approval_revision     integer,
  approval_hash         text CHECK (approval_hash IS NULL OR approval_hash ~ '^sha256:[0-9a-f]{64}$'),
  library_source_id     uuid,
  library_version_id    uuid,
  created_at            timestamptz NOT NULL DEFAULT now(),
  published_at          timestamptz,
  revoked_at            timestamptz,
  updated_at            timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shared_intelligence_library_source_fk FOREIGN KEY (workspace_id, library_source_id)
    REFERENCES library_sources (workspace_id, id) ON DELETE SET NULL,
  CONSTRAINT shared_intelligence_library_version_fk FOREIGN KEY (library_version_id)
    REFERENCES library_source_versions (id) ON DELETE SET NULL,
  CONSTRAINT shared_intelligence_approval_binding CHECK (
    (approval_request_id IS NULL AND approval_revision IS NULL AND approval_hash IS NULL)
    OR (approval_request_id IS NOT NULL AND approval_revision IS NOT NULL AND approval_hash IS NOT NULL)
  )
);
CREATE UNIQUE INDEX IF NOT EXISTS shared_intelligence_active_dedupe
  ON shared_intelligence_proposals (workspace_id, dedupe_sha256)
  WHERE status IN ('needs_review', 'ready_for_review', 'pending_review', 'published');
CREATE INDEX IF NOT EXISTS shared_intelligence_creator_idx
  ON shared_intelligence_proposals (workspace_id, created_by_user_id, created_at DESC);
DROP TRIGGER IF EXISTS shared_intelligence_proposals_updated_at ON shared_intelligence_proposals;
CREATE TRIGGER shared_intelligence_proposals_updated_at BEFORE UPDATE ON shared_intelligence_proposals
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE IF NOT EXISTS shared_intelligence_evidence (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  proposal_id         uuid NOT NULL REFERENCES shared_intelligence_proposals (id) ON DELETE CASCADE,
  source_run_id       uuid REFERENCES runs (id) ON DELETE SET NULL,
  source_session_id   uuid REFERENCES sessions (id) ON DELETE SET NULL,
  source_message_id   uuid NOT NULL,
  source_message_role text NOT NULL CHECK (source_message_role IN ('user','iris')),
  session_title       text NOT NULL CHECK (length(session_title) BETWEEN 1 AND 200),
  run_ended_at        timestamptz NOT NULL,
  source_sha256       text NOT NULL CHECK (source_sha256 ~ '^[0-9a-f]{64}$'),
  approved_excerpt    text NOT NULL CHECK (length(approved_excerpt) BETWEEN 1 AND 1000),
  excerpt_sha256      text NOT NULL CHECK (excerpt_sha256 ~ '^[0-9a-f]{64}$'),
  provenance          text NOT NULL CHECK (provenance = 'verified_quote'),
  tool_names          text[] NOT NULL DEFAULT '{}',
  step_labels         text[] NOT NULL DEFAULT '{}',
  outcome             text NOT NULL CHECK (outcome = 'runtime_completed'),
  revoked_at          timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT shared_intelligence_evidence_source_key UNIQUE (proposal_id, source_sha256),
  CONSTRAINT shared_intelligence_evidence_run_key UNIQUE (proposal_id, source_run_id)
);
CREATE INDEX IF NOT EXISTS shared_intelligence_evidence_run_idx
  ON shared_intelligence_evidence (workspace_id, source_run_id) WHERE source_run_id IS NOT NULL;

DO $$
DECLARE table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'shared_intelligence_proposals', 'shared_intelligence_evidence'
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

-- Deleting a private source run withdraws every dependent publication. The
-- immutable Library version remains an audit fact, but no team can select it.
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
     SET status='revoked', revoked_at=COALESCE(proposal.revoked_at,now())
    FROM shared_intelligence_evidence evidence
   WHERE evidence.workspace_id=OLD.workspace_id
     AND evidence.source_run_id=OLD.id
     AND proposal.workspace_id=evidence.workspace_id
     AND proposal.id=evidence.proposal_id
     AND proposal.status NOT IN ('revoked','declined');

  UPDATE shared_intelligence_evidence
     SET revoked_at=COALESCE(revoked_at,now())
   WHERE workspace_id=OLD.workspace_id AND source_run_id=OLD.id;
  RETURN OLD;
END
$$;
DROP TRIGGER IF EXISTS runs_revoke_shared_intelligence ON runs;
CREATE TRIGGER runs_revoke_shared_intelligence BEFORE DELETE ON runs
  FOR EACH ROW EXECUTE FUNCTION revoke_shared_intelligence_for_deleted_run();

GRANT SELECT, INSERT, UPDATE ON shared_intelligence_proposals, shared_intelligence_evidence TO app;
GRANT DELETE ON library_source_team_grants TO app;
REVOKE ALL ON shared_intelligence_proposals, shared_intelligence_evidence FROM agent;
