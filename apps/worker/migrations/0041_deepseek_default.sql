-- The product default for every workspace is the exact Nous V4.1 Flash model.
-- Keep the placeholder unusable until the normal authenticated catalog sync.
-- The compatibility transport allows the complete migration catalog to replay
-- in the empty shadow database before 0024 expands the transport constraint.
INSERT INTO catalog (
  model_id, provider, label, transport, effort_map, default_effort,
  pricing_per_million, pricing_verified_on, disabled_reason,
  source, context_length, supports_tools, supports_reasoning
) VALUES (
  'nous:deepseek/deepseek-v4.1-flash', 'nous_portal', 'DeepSeek: DeepSeek V4.1 Flash', 'openrouter_chat',
  '{"low":"low","high":"high","max":"max"}'::jsonb, 'high',
  '{"input":0.15,"output":0.6,"input_off_peak":null,"output_off_peak":null,"cached_input":0.015}'::jsonb,
  DATE '2026-09-18', 'Catalog sync required.',
  'provider_list', 1048576, true, true
)
ON CONFLICT (model_id) DO NOTHING;

ALTER TABLE workspace_settings
  ALTER COLUMN default_model_id SET DEFAULT 'nous:deepseek/deepseek-v4.1-flash';
ALTER TABLE workspace_settings
  ALTER COLUMN default_effort SET DEFAULT 'low';

-- This is an intentional one-time product-default migration, including tenants
-- whose previous temporary default remained catalog-valid during an outage.
-- The migration ledger guards data separately from replayable DDL: replay must
-- not erase an Admin's later choice. The runner records this filename in the
-- same transaction, so a crash cannot leave a half-applied data migration.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE filename = '0041_deepseek_default.sql') THEN
    -- Existing synced rows may still have the former generic medium map.
    -- Prices, availability and historical runs remain untouched.
    UPDATE catalog
       SET effort_map = '{"low":"low","high":"high","max":"max"}'::jsonb,
           default_effort = 'high'
     WHERE model_id = 'nous:deepseek/deepseek-v4.1-flash';

    -- Only the migration owner can bypass FORCE, within this transaction.
    -- RLS remains enabled and FORCE is restored before the migration commits.
    ALTER TABLE workspace_settings NO FORCE ROW LEVEL SECURITY;
    ALTER TABLE sessions NO FORCE ROW LEVEL SECURITY;

    UPDATE sessions s
       SET model_id = 'nous:deepseek/deepseek-v4.1-flash', effort = 'low'
      FROM workspace_settings ws, catalog c
     WHERE s.workspace_id = ws.workspace_id
       AND c.model_id = s.model_id
       AND NOT s.archived
       AND (
         s.title = 'Iris · Automated partner screening'
         OR (s.model_id = ws.default_model_id AND s.effort IS NOT DISTINCT FROM ws.default_effort)
         OR c.provider <> 'nous_portal' OR c.disabled_reason IS NOT NULL OR NOT c.supports_tools
         OR (s.model_id = 'nous:deepseek/deepseek-v4.1-flash'
             AND s.effort IS NOT NULL AND NOT (c.effort_map ? s.effort))
       );

    UPDATE workspace_settings
       SET default_model_id = 'nous:deepseek/deepseek-v4.1-flash', default_effort = 'low', updated_at = now();

    ALTER TABLE sessions FORCE ROW LEVEL SECURITY;
    ALTER TABLE workspace_settings FORCE ROW LEVEL SECURITY;
  END IF;
END $$;
