-- 0015_openrouter.sql
-- OpenRouter as a bring-your-own-key provider (decisions R1-R8).
--
-- Three changes, and they are deliberately in one file because none of them is
-- usable without the others:
--
--   1. `openrouter` becomes a value of the two provider CHECKs and
--      `openrouter_chat` a value of the transport CHECK.
--   2. `catalog` learns four columns. A seeded row keeps the defaults it would
--      have been written with (`source = 'seed'`, tools yes, reasoning no,
--      context length unknown), so the four rows from 0007 are unchanged and
--      `test/db/schema.test.ts` still compares them row for row.
--   3. `sync_openrouter_catalog` is the only way `app` writes to `catalog`.
--
-- On (3): the catalog is a platform table and `app` has had SELECT on it since
-- 0004, which is the right grant — prices are a reviewable migration, not
-- something a request may rewrite. A dynamic provider list breaks that for
-- exactly one provider, so rather than granting INSERT/UPDATE on the table and
-- hoping no future route touches a seeded row, the widening is a SECURITY
-- DEFINER function whose body cannot name any provider but `openrouter`. The
-- grant assertion in `test/db/grants.test.ts` still reads `catalog: ['SELECT']`,
-- which is the point: a reviewer sees the narrow hole rather than a wide one.

-- ---------------------------------------------------------------------------
-- 1. The enums
-- ---------------------------------------------------------------------------

ALTER TABLE catalog DROP CONSTRAINT IF EXISTS catalog_provider_check;
ALTER TABLE catalog ADD CONSTRAINT catalog_provider_check
  CHECK (provider IN ('deepseek', 'anthropic', 'openai', 'nous_portal', 'openrouter'));

ALTER TABLE catalog DROP CONSTRAINT IF EXISTS catalog_transport_check;
ALTER TABLE catalog ADD CONSTRAINT catalog_transport_check
  CHECK (transport IN ('deepseek_chat', 'anthropic_messages', 'openai_responses', 'openrouter_chat'));

ALTER TABLE workspace_provider_keys DROP CONSTRAINT IF EXISTS workspace_provider_keys_provider_check;
ALTER TABLE workspace_provider_keys ADD CONSTRAINT workspace_provider_keys_provider_check
  CHECK (provider IN ('deepseek', 'anthropic', 'openai', 'openrouter'));

-- ---------------------------------------------------------------------------
-- 2. The columns
-- ---------------------------------------------------------------------------

ALTER TABLE catalog ADD COLUMN IF NOT EXISTS source text NOT NULL DEFAULT 'seed';
ALTER TABLE catalog DROP CONSTRAINT IF EXISTS catalog_source_check;
ALTER TABLE catalog ADD CONSTRAINT catalog_source_check CHECK (source IN ('seed', 'provider_list'));
ALTER TABLE catalog ADD COLUMN IF NOT EXISTS context_length integer;
ALTER TABLE catalog ADD COLUMN IF NOT EXISTS supports_tools boolean NOT NULL DEFAULT true;
ALTER TABLE catalog ADD COLUMN IF NOT EXISTS supports_reasoning boolean NOT NULL DEFAULT false;

-- Search and paging read these; 300+ rows make both worth an index.
CREATE INDEX IF NOT EXISTS catalog_provider_idx ON catalog (provider, model_id);
CREATE INDEX IF NOT EXISTS catalog_source_idx ON catalog (source);

-- The key row carries a count and a timestamp rather than the list: OpenRouter
-- verifies against hundreds of ids and `verified_models` is a text[] the
-- Settings screen renders.
ALTER TABLE workspace_provider_keys ADD COLUMN IF NOT EXISTS synced_model_count integer;
ALTER TABLE workspace_provider_keys ADD COLUMN IF NOT EXISTS models_synced_at timestamptz;

-- ---------------------------------------------------------------------------
-- 3. The one way `app` writes a catalog row
-- ---------------------------------------------------------------------------

-- `rows` is the already-normalised shape the Worker computed from OpenRouter's
-- `GET /api/v1/models`: prices per million, not per token, and the ids already
-- carry the `openrouter:` prefix. Anything whose `model_id` does not carry that
-- prefix is skipped rather than rejected, so a malformed element cannot abort a
-- sync of three hundred good ones.
--
-- Rows that were synced before and are absent from this payload are not
-- deleted: `sessions.model_id`, `runs.model_id` and `model_calls.model_id` all
-- reference `catalog`, and a session that named a model last week must still
-- render. They are disabled with a reason instead, which is the same mechanism
-- the pilot uses for a model it does not offer.
CREATE OR REPLACE FUNCTION sync_openrouter_catalog(rows jsonb, verified_on date)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  written integer;
BEGIN
  IF jsonb_typeof(rows) <> 'array' THEN
    RAISE EXCEPTION 'sync_openrouter_catalog expects a json array';
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
     WHERE r ->> 'model_id' LIKE 'openrouter:%'
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
      i.model_id, 'openrouter', i.label, 'openrouter_chat',
      CASE WHEN i.supports_reasoning THEN i.effort_map ELSE NULL END,
      CASE WHEN i.supports_reasoning THEN i.default_effort ELSE NULL END,
      i.pricing_per_million, verified_on, NULL,
      'provider_list', i.context_length, i.supports_tools, i.supports_reasoning
      FROM incoming i
    ON CONFLICT (model_id) DO UPDATE SET
      label = EXCLUDED.label,
      effort_map = EXCLUDED.effort_map,
      default_effort = EXCLUDED.default_effort,
      pricing_per_million = EXCLUDED.pricing_per_million,
      pricing_verified_on = EXCLUDED.pricing_verified_on,
      disabled_reason = NULL,
      context_length = EXCLUDED.context_length,
      supports_tools = EXCLUDED.supports_tools,
      supports_reasoning = EXCLUDED.supports_reasoning
    -- A seeded row can never be overwritten by a sync, even if OpenRouter one
    -- day publishes an id that collides with one.
    WHERE catalog.source = 'provider_list'
    RETURNING 1
  ),
  retired AS (
    UPDATE catalog c
       SET disabled_reason = 'No longer listed by OpenRouter.'
     WHERE c.provider = 'openrouter'
       AND c.source = 'provider_list'
       AND c.disabled_reason IS NULL
       AND NOT EXISTS (SELECT 1 FROM incoming i WHERE i.model_id = c.model_id)
    RETURNING 1
  )
  SELECT count(*)::integer INTO written FROM upserted;

  RETURN COALESCE(written, 0);
END;
$$;

REVOKE ALL ON FUNCTION sync_openrouter_catalog(jsonb, date) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION sync_openrouter_catalog(jsonb, date) TO app;
