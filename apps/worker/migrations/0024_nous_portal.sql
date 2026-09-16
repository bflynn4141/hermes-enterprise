-- 0024_nous_portal.sql
-- Nous Portal as the workspace-owned inference provider.
--
-- The official Hermes Agent runtime remains the execution layer. The Worker
-- keeps each workspace's Nous Portal credential encrypted, exposes only the
-- narrow agent-scoped proxy to the runtime, and synchronizes the public model
-- catalog through one provider-limited SECURITY DEFINER function.

ALTER TABLE catalog DROP CONSTRAINT IF EXISTS catalog_provider_check;
ALTER TABLE catalog ADD CONSTRAINT catalog_provider_check
  CHECK (provider IN ('deepseek', 'anthropic', 'openai', 'nous_portal', 'openrouter'));

ALTER TABLE catalog DROP CONSTRAINT IF EXISTS catalog_transport_check;
ALTER TABLE catalog ADD CONSTRAINT catalog_transport_check
  CHECK (transport IN ('deepseek_chat', 'anthropic_messages', 'openai_responses', 'openrouter_chat', 'nous_chat'));

ALTER TABLE workspace_provider_keys DROP CONSTRAINT IF EXISTS workspace_provider_keys_provider_check;
ALTER TABLE workspace_provider_keys ADD CONSTRAINT workspace_provider_keys_provider_check
  CHECK (provider IN ('deepseek', 'anthropic', 'openai', 'openrouter', 'nous_portal'));

CREATE OR REPLACE FUNCTION sync_nous_portal_catalog(rows jsonb, verified_on date)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  written integer;
BEGIN
  IF jsonb_typeof(rows) <> 'array' THEN
    RAISE EXCEPTION 'sync_nous_portal_catalog expects a json array';
  END IF;

  WITH incoming AS (
    SELECT
      r ->> 'model_id'                             AS model_id,
      r ->> 'label'                                AS label,
      r -> 'effort_map'                            AS effort_map,
      r ->> 'default_effort'                       AS default_effort,
      r -> 'pricing_per_million'                   AS pricing_per_million,
      NULLIF(r ->> 'context_length', '')::integer  AS context_length,
      COALESCE((r ->> 'supports_tools')::boolean, false)     AS supports_tools,
      COALESCE((r ->> 'supports_reasoning')::boolean, false) AS supports_reasoning
      FROM jsonb_array_elements(rows) AS r
     WHERE r ->> 'model_id' LIKE 'nous:%'
       AND r ->> 'label' IS NOT NULL
       AND jsonb_typeof(r -> 'pricing_per_million') = 'object'
  ),
  upserted AS (
    INSERT INTO catalog (
      model_id, provider, label, transport, effort_map, default_effort,
      pricing_per_million, pricing_verified_on, disabled_reason,
      source, context_length, supports_tools, supports_reasoning
    )
    SELECT
      i.model_id, 'nous_portal', i.label, 'nous_chat',
      CASE WHEN i.supports_reasoning THEN i.effort_map ELSE NULL END,
      CASE WHEN i.supports_reasoning THEN i.default_effort ELSE NULL END,
      i.pricing_per_million, verified_on, NULL,
      'provider_list', i.context_length, i.supports_tools, i.supports_reasoning
      FROM incoming i
    ON CONFLICT (model_id) DO UPDATE SET
      label = EXCLUDED.label,
      provider = EXCLUDED.provider,
      transport = EXCLUDED.transport,
      effort_map = EXCLUDED.effort_map,
      default_effort = EXCLUDED.default_effort,
      pricing_per_million = EXCLUDED.pricing_per_million,
      pricing_verified_on = EXCLUDED.pricing_verified_on,
      disabled_reason = NULL,
      context_length = EXCLUDED.context_length,
      supports_tools = EXCLUDED.supports_tools,
      supports_reasoning = EXCLUDED.supports_reasoning
    WHERE catalog.source = 'provider_list'
    RETURNING 1
  ),
  retired AS (
    UPDATE catalog c
       SET disabled_reason = 'No longer listed by Nous Portal.'
     WHERE c.provider = 'nous_portal'
       AND c.source = 'provider_list'
       AND c.disabled_reason IS NULL
       AND NOT EXISTS (SELECT 1 FROM incoming i WHERE i.model_id = c.model_id)
    RETURNING 1
  )
  SELECT count(*)::integer INTO written FROM upserted;

  RETURN COALESCE(written, 0);
END;
$$;

REVOKE ALL ON FUNCTION sync_nous_portal_catalog(jsonb, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sync_nous_portal_catalog(jsonb, date) TO app;

-- The placeholder satisfies the workspace-settings foreign key before a key is
-- connected. Its pre-sync transport is an existing compatible value so older
-- idempotent migrations can replay over an empty tenant database; the first
-- catalog sync replaces it with `nous_chat` before the model becomes usable.
INSERT INTO catalog (
  model_id, provider, label, transport, effort_map, default_effort,
  pricing_per_million, pricing_verified_on, disabled_reason,
  source, context_length, supports_tools, supports_reasoning
) VALUES (
  'nous:anthropic/claude-sonnet-5', 'nous_portal', 'Anthropic: Claude Sonnet 5', 'openrouter_chat',
  '{"low": "low", "medium": "medium", "high": "high"}'::jsonb, 'medium',
  '{"input": 2, "output": 10, "input_off_peak": null, "output_off_peak": null, "cached_input": 0.2}'::jsonb,
  DATE '2026-09-15', 'Catalog sync required.',
  'provider_list', 1000000, true, true
)
ON CONFLICT (model_id) DO NOTHING;

-- `MIGRATE_ALLOW_EDIT=1` can re-run this pre-deployment migration in a local
-- database that already has the earlier compatibility placeholder. Do not
-- disable a row that has completed a real sync (`nous_chat`).
UPDATE catalog
   SET disabled_reason = 'Catalog sync required.'
 WHERE model_id = 'nous:anthropic/claude-sonnet-5'
   AND provider = 'nous_portal'
   AND transport = 'openrouter_chat'
   AND source = 'provider_list';

ALTER TABLE workspace_settings
  ALTER COLUMN default_model_id SET DEFAULT 'nous:anthropic/claude-sonnet-5';

ALTER TABLE workspace_settings
  ALTER COLUMN default_effort SET DEFAULT 'medium';
