-- Enrollment intent only. No provider identifiers or spend authority are accepted
-- from the browser; provider provisioning requires a later owner ceremony.
CREATE UNIQUE INDEX IF NOT EXISTS members_workspace_id_id_key ON members(workspace_id, id);
CREATE TABLE IF NOT EXISTS workspace_wallet_config (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  chain_id integer NOT NULL DEFAULT 8453 CHECK (chain_id = 8453),
  asset text NOT NULL DEFAULT 'USDC' CHECK (asset = 'USDC'),
  status text NOT NULL DEFAULT 'awaiting_owner_enrollment' CHECK (status = 'awaiting_owner_enrollment'),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS wallet_principals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspace_wallet_config(workspace_id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('workspace', 'member', 'agent')),
  member_id uuid,
  agent_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, id),
  FOREIGN KEY (workspace_id, member_id) REFERENCES members(workspace_id, id),
  FOREIGN KEY (workspace_id, agent_id) REFERENCES agents(workspace_id, id),
  CHECK ((kind = 'workspace' AND member_id IS NULL AND agent_id IS NULL)
      OR (kind = 'member' AND member_id IS NOT NULL AND agent_id IS NULL)
      OR (kind = 'agent' AND agent_id IS NOT NULL AND member_id IS NULL))
);
CREATE UNIQUE INDEX IF NOT EXISTS wallet_principal_workspace ON wallet_principals(workspace_id) WHERE kind = 'workspace';
CREATE UNIQUE INDEX IF NOT EXISTS wallet_principal_member ON wallet_principals(workspace_id, member_id) WHERE kind = 'member';
CREATE UNIQUE INDEX IF NOT EXISTS wallet_principal_agent ON wallet_principals(workspace_id, agent_id) WHERE kind = 'agent';
CREATE TABLE IF NOT EXISTS wallet_enrollment_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  requested_by uuid NOT NULL REFERENCES users(id),
  state text NOT NULL DEFAULT 'awaiting_owner_enrollment' CHECK (state = 'awaiting_owner_enrollment'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, principal_id),
  FOREIGN KEY (workspace_id, principal_id) REFERENCES wallet_principals(workspace_id, id) ON DELETE CASCADE
);
-- Addresses deliberately have no insertion path yet. They become real only
-- after authenticated provider read-back, never as a side effect of enrollment.
CREATE TABLE IF NOT EXISTS wallet_accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL,
  principal_id uuid NOT NULL,
  chain_id integer NOT NULL CHECK (chain_id = 8453),
  address text NOT NULL CHECK (address ~ '^0x[0-9a-f]{40}$' AND address <> '0x0000000000000000000000000000000000000000'),
  verified_at timestamptz NOT NULL,
  UNIQUE (workspace_id, principal_id, chain_id),
  UNIQUE (workspace_id, chain_id, address),
  FOREIGN KEY (workspace_id, principal_id) REFERENCES wallet_principals(workspace_id, id) ON DELETE CASCADE
);
DO $$ DECLARE t text; BEGIN
  FOREACH t IN ARRAY ARRAY['workspace_wallet_config','wallet_principals','wallet_enrollment_operations','wallet_accounts'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format('DROP POLICY IF EXISTS tenant_isolation ON %I', t);
    EXECUTE format('CREATE POLICY tenant_isolation ON %I USING (workspace_id = app_workspace_id()) WITH CHECK (workspace_id = app_workspace_id())', t);
    EXECUTE format('GRANT SELECT ON %I TO app', t);
    EXECUTE format('REVOKE ALL ON %I FROM agent', t);
  END LOOP;
END $$;
GRANT INSERT ON workspace_wallet_config, wallet_principals, wallet_enrollment_operations TO app;
