-- Exact owner-reviewed member wallet operations. No parent key acquires child
-- mutation authority; pending intent and last confirmed provider state differ.
CREATE TABLE IF NOT EXISTS member_wallet_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspace_wallet_config(workspace_id),
  member_id uuid NOT NULL,
  owner_member_id uuid NOT NULL,
  requested_by uuid NOT NULL REFERENCES users(id),
  kind text NOT NULL CHECK (kind IN ('create_wallet','grant_payment_review','revoke_payment_review')),
  state text NOT NULL DEFAULT 'awaiting_owner_review' CHECK (state IN ('awaiting_owner_review','expired','cancelled','changed','submitting','outcome_unknown','completed','rejected')),
  version integer NOT NULL DEFAULT 1 CHECK (version=1),
  proposal_hash text NOT NULL CHECK (proposal_hash ~ '^[0-9a-f]{64}$'),
  proposal jsonb NOT NULL CHECK (jsonb_typeof(proposal)='object'),
  request_body text NOT NULL CHECK (octet_length(request_body) <= 16384),
  provider_org_id text NOT NULL,
  wallet_name text NOT NULL UNIQUE,
  provider_activity_id text,
  failure_code text,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE(workspace_id,id),
  FOREIGN KEY(workspace_id,member_id) REFERENCES members(workspace_id,id),
  FOREIGN KEY(workspace_id,owner_member_id) REFERENCES members(workspace_id,id)
);
CREATE UNIQUE INDEX IF NOT EXISTS member_wallet_operation_open ON member_wallet_operations(workspace_id,member_id)
  WHERE state IN ('awaiting_owner_review','submitting','outcome_unknown');
CREATE TABLE IF NOT EXISTS member_wallet_bindings (
  workspace_id uuid NOT NULL,
  member_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  provider_org_id text NOT NULL,
  provider_wallet_id text NOT NULL,
  -- Reserved for a separately enrolled member authenticator, never the owner
  -- or a service user substituted for a member's signing identity.
  provider_user_id text,
  operation_id uuid NOT NULL,
  verified_at timestamptz NOT NULL,
  PRIMARY KEY(workspace_id,member_id),
  UNIQUE(provider_org_id,provider_wallet_id),
  UNIQUE(provider_org_id,provider_user_id),
  FOREIGN KEY(workspace_id,member_id) REFERENCES members(workspace_id,id),
  FOREIGN KEY(workspace_id,principal_id) REFERENCES wallet_principals(workspace_id,id),
  FOREIGN KEY(workspace_id,operation_id) REFERENCES member_wallet_operations(workspace_id,id)
);
CREATE OR REPLACE FUNCTION guard_member_wallet_proposal() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF (to_jsonb(NEW) - ARRAY['state','provider_activity_id','failure_code','updated_at']) IS DISTINCT FROM
     (to_jsonb(OLD) - ARRAY['state','provider_activity_id','failure_code','updated_at']) THEN
    RAISE EXCEPTION 'wallet proposal is immutable' USING ERRCODE='42501';
  END IF;
  IF NEW.state <> OLD.state AND NOT (
    (OLD.state='awaiting_owner_review' AND NEW.state IN ('expired','cancelled','changed','submitting')) OR
    (OLD.state IN ('submitting','outcome_unknown') AND NEW.state IN ('outcome_unknown','completed','rejected'))
  ) THEN RAISE EXCEPTION 'invalid wallet operation transition' USING ERRCODE='23514'; END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS immutable_member_wallet_proposal ON member_wallet_operations;
CREATE TRIGGER immutable_member_wallet_proposal BEFORE UPDATE ON member_wallet_operations FOR EACH ROW EXECUTE FUNCTION guard_member_wallet_proposal();
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['member_wallet_operations','member_wallet_bindings'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (workspace_id=app_workspace_id()) WITH CHECK (workspace_id=app_workspace_id())', t);
    EXECUTE format('GRANT SELECT ON %I TO app', t);
    EXECUTE format('REVOKE ALL ON %I FROM agent', t);
  END LOOP;
END $$;
GRANT INSERT ON member_wallet_operations TO app;
GRANT UPDATE(state,provider_activity_id,failure_code,updated_at) ON member_wallet_operations TO app;
-- Confirmed bindings/accounts are written by the system read-back transaction,
-- never directly by the tenant application role or browser payload.
CREATE OR REPLACE FUNCTION confirm_member_wallet(p_operation_id uuid,p_wallet_id text,p_address text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path=public,pg_temp AS $$
DECLARE op member_wallet_operations%ROWTYPE; principal uuid;
BEGIN
  IF current_setting('app.user_id',true) IS DISTINCT FROM '00000000-0000-4000-8000-000000000000' THEN
    RAISE EXCEPTION 'provider read-back transaction required' USING ERRCODE='42501';
  END IF;
  SELECT * INTO op FROM member_wallet_operations WHERE workspace_id=app_workspace_id() AND id=p_operation_id FOR UPDATE;
  IF NOT FOUND OR op.kind<>'create_wallet' OR op.state NOT IN ('submitting','outcome_unknown') OR p_wallet_id IS NULL OR p_wallet_id='' THEN
    RAISE EXCEPTION 'no in-flight member wallet operation' USING ERRCODE='23514';
  END IF;
  INSERT INTO wallet_principals(workspace_id,kind,member_id) VALUES(op.workspace_id,'member',op.member_id) ON CONFLICT DO NOTHING;
  SELECT id INTO STRICT principal FROM wallet_principals WHERE workspace_id=op.workspace_id AND kind='member' AND member_id=op.member_id;
  INSERT INTO wallet_accounts(workspace_id,principal_id,chain_id,address,verified_at) VALUES(op.workspace_id,principal,8453,p_address,now());
  INSERT INTO member_wallet_bindings(workspace_id,member_id,principal_id,provider_org_id,provider_wallet_id,operation_id,verified_at)
    VALUES(op.workspace_id,op.member_id,principal,op.provider_org_id,p_wallet_id,op.id,now());
END $$;
REVOKE ALL ON FUNCTION confirm_member_wallet(uuid,text,text) FROM PUBLIC,agent;
GRANT EXECUTE ON FUNCTION confirm_member_wallet(uuid,text,text) TO app;
