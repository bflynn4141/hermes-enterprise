-- Role-aware warm capacity.  The discovery grant remains the single role
-- identity for a capacity row; this migration widens its exact profile union
-- without duplicating a mutable role column onto hermes_cloud_capacity.

ALTER TABLE runtime_discovery_grants
  ADD COLUMN IF NOT EXISTS role_template_version text NOT NULL DEFAULT '1.0.0';

ALTER TABLE runtime_discovery_grants
  DROP CONSTRAINT IF EXISTS runtime_discovery_grants_role_template_key_check,
  DROP CONSTRAINT IF EXISTS runtime_discovery_grants_skill_key_check,
  DROP CONSTRAINT IF EXISTS runtime_discovery_grants_skill_version_check,
  DROP CONSTRAINT IF EXISTS runtime_discovery_grants_runtime_name_check,
  DROP CONSTRAINT IF EXISTS runtime_discovery_grants_artifact_digest_check,
  DROP CONSTRAINT IF EXISTS runtime_discovery_grants_exact_profile_check;

ALTER TABLE runtime_discovery_grants
  ADD CONSTRAINT runtime_discovery_grants_exact_profile_check CHECK (
    role_template_version = '1.0.0'
    AND (
      (
        role_template_key = 'partnerships-agent'
        AND skill_key = 'partner-program-screening'
        AND skill_version = '1.7.0'
        AND runtime_name = 'enterprise_bridge:partner-program-screening'
        AND artifact_digest = 'sha256:9f124ce44aa318b13e9f8ccfd92072d8b3ba6a22030eaad31cfafbfda3a1e2a9'
      )
      OR
      (
        role_template_key = 'finance-agent'
        AND skill_key = 'partner-invoice-review'
        AND skill_version = '1.0.1'
        AND runtime_name = 'enterprise_bridge:partner-invoice-review'
        AND artifact_digest = 'sha256:bdb13d70f7a603f92eb47fc2d1c057c82f26658e61df8cf357790f23875753e4'
      )
    )
  );

ALTER TABLE hermes_cloud_capacity
  DROP CONSTRAINT IF EXISTS hermes_cloud_capacity_usable_check;
ALTER TABLE hermes_cloud_capacity
  ADD CONSTRAINT hermes_cloud_capacity_usable_check CHECK (
    state = 'quarantined'
    OR (
      native_cron_disabled
      AND agentcash_enabled = agentcash_wallet_present
    )
  );

GRANT SELECT (role_template_version), INSERT (role_template_version)
  ON runtime_discovery_grants TO app;
