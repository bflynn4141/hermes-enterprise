-- Durable member setup. This state machine prepares a verified agent before an
-- invitation may be delivered. Provider operations and email delivery remain
-- separate, so an uncertain result can never be retried as a second create/send.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid='invitations'::regclass
       AND conname='invitations_workspace_id_unique'
  ) THEN
    ALTER TABLE invitations ADD CONSTRAINT invitations_workspace_id_unique UNIQUE(workspace_id,id);
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS member_provisioning_operations (
  id                     uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id           uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  invitation_id          uuid NOT NULL,
  requested_by           uuid REFERENCES users(id) ON DELETE SET NULL,
  role_template_key      text NOT NULL CHECK (role_template_key IN ('partnerships-agent','finance-agent')),
  role_template_version  text NOT NULL DEFAULT '1.0.0',
  create_intent_id       uuid NOT NULL DEFAULT gen_random_uuid(),
  revision               integer NOT NULL DEFAULT 0 CHECK (revision >= 0),
  preparation            text NOT NULL DEFAULT 'queued' CHECK (preparation IN (
                           'awaiting_connection','queued','creating','configuring','verifying',
                           'ready','reconciliation_required','failed')),
  cancellation           text NOT NULL DEFAULT 'none' CHECK (cancellation IN ('none','requested','complete')),
  issue                  text CHECK (issue IS NULL OR issue IN (
                           'cloud_not_connected','cloud_reconnect_required','billing_unverified',
                           'insufficient_credits','cloud_contract_unverified','bootstrap_unsupported',
                           'readiness_failed','creation_outcome_unknown','delivery_outcome_unknown',
                           'delivery_rejected','temporary_failure')),
  cloud_agent_id         text,
  requested_at           timestamptz NOT NULL DEFAULT now(),
  completed_at           timestamptz,
  created_at             timestamptz NOT NULL DEFAULT now(),
  updated_at             timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, invitation_id),
  UNIQUE (workspace_id, create_intent_id)
);
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid='member_provisioning_operations'::regclass
       AND conname='member_provisioning_operations_invitation_fk'
  ) THEN
    ALTER TABLE member_provisioning_operations
      ADD CONSTRAINT member_provisioning_operations_invitation_fk
      FOREIGN KEY(workspace_id,invitation_id) REFERENCES invitations(workspace_id,id) ON DELETE RESTRICT;
  END IF;
END $$;
CREATE INDEX IF NOT EXISTS member_provisioning_operations_state_idx
  ON member_provisioning_operations(workspace_id, preparation, cancellation, updated_at);
DROP TRIGGER IF EXISTS member_provisioning_operations_updated_at ON member_provisioning_operations;
CREATE TRIGGER member_provisioning_operations_updated_at BEFORE UPDATE ON member_provisioning_operations
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE member_provisioning_operations ENABLE ROW LEVEL SECURITY;
ALTER TABLE member_provisioning_operations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON member_provisioning_operations;
CREATE POLICY tenant_isolation ON member_provisioning_operations
  USING (workspace_id=app_workspace_id()) WITH CHECK (workspace_id=app_workspace_id());
GRANT SELECT, INSERT, UPDATE ON member_provisioning_operations TO app;
REVOKE ALL ON member_provisioning_operations FROM agent;
REVOKE DELETE ON member_provisioning_operations FROM app;

-- Even a hand-written job cannot bypass the readiness gate. Legacy invitations
-- without an operation retain their existing delivery behavior during rollout.
CREATE OR REPLACE FUNCTION guard_member_invitation_delivery() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.kind = 'workos_sync'
     AND NEW.payload->>'action' IN ('send_invitation','resend_invitation')
     AND EXISTS (
       SELECT 1 FROM member_provisioning_operations op
        WHERE op.workspace_id=NEW.workspace_id
          AND op.invitation_id=(NEW.payload->>'invitation_id')::uuid
          AND (op.preparation <> 'ready' OR op.cancellation <> 'none')
     ) THEN
    RAISE EXCEPTION 'member provisioning is not ready for invitation delivery' USING ERRCODE='23514';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS jobs_member_invitation_delivery_guard ON jobs;
CREATE TRIGGER jobs_member_invitation_delivery_guard BEFORE INSERT OR UPDATE OF payload, kind ON jobs
  FOR EACH ROW EXECUTE FUNCTION guard_member_invitation_delivery();
