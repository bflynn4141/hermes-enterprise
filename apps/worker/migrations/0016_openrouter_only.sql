-- 0016_openrouter_only.sql
-- OpenRouter as the only provider a workspace can use (decisions R12, R13).
--
-- The enforcement itself is code, not SQL: `ALLOWED_PROVIDERS` is a Worker
-- variable and `model/allowed.ts` is the one place that reads it. A CHECK
-- constraint would have been the obvious alternative and is the wrong one —
-- the seeded rows and the three other adapters still have to exist (the
-- transport replay rules are tested against them, `model_calls` rows from last
-- month still reference `deepseek-flash`), and a constraint cannot be relaxed
-- for a customer who brings their own Anthropic account without a migration
-- and a deploy.
--
-- Two things do belong in a migration, because both are facts about rows:
--
--   1. The placeholder catalog row for the workspace default. A fresh
--      workspace's `default_model_id` is an OpenRouter id, and that column is a
--      foreign key into `catalog` — so the row has to exist before any key has
--      been verified. It is written with `source = 'provider_list'` precisely
--      so that the first real sync *overwrites* it: a placeholder that a sync
--      could not correct would be a price nobody ever re-verified.
--   2. The column default, which is what `POST /workspaces` and the live
--      fixtures both rely on.
--
-- What is deliberately not here: an UPDATE of existing workspaces' defaults.
-- Every tenant table is FORCE ROW LEVEL SECURITY and all three roles are
-- NOBYPASSRLS (decision 23), so a migration cannot enumerate tenants — which is
-- the isolation working rather than a gap. An existing workspace is moved by
-- `promoteDefaultModel`, inside its own tenant transaction, the next time its
-- OpenRouter key is verified or the weekly reverify runs.

-- ---------------------------------------------------------------------------
-- 1. The placeholder row
-- ---------------------------------------------------------------------------

-- Priced from Anthropic's published Sonnet figures rather than left at zero:
-- a row that says "free" and is not is the error nobody notices until the
-- invoice (decision R6). `pricing_verified_on` is this migration's date and the
-- first sync replaces every column below with OpenRouter's own answer.
INSERT INTO catalog (
  model_id, provider, label, transport, effort_map, default_effort,
  pricing_per_million, pricing_verified_on, disabled_reason,
  source, context_length, supports_tools, supports_reasoning
) VALUES (
  'openrouter:anthropic/claude-sonnet-5', 'openrouter', 'Anthropic: Claude Sonnet 5', 'openrouter_chat',
  '{"low": "low", "medium": "medium", "high": "high"}'::jsonb, 'medium',
  '{"input": 3, "output": 15, "input_off_peak": null, "output_off_peak": null, "cached_input": 0.3}'::jsonb,
  DATE '2026-09-15',
  -- Null, not "not synced yet": with no key the catalog route already answers
  -- `no_key` with an action, and a second sentence saying the same thing in
  -- other words is how a screen ends up contradicting itself.
  NULL,
  'provider_list', 200000, true, true
)
ON CONFLICT (model_id) DO NOTHING;

-- ---------------------------------------------------------------------------
-- 2. The default a new workspace starts on
-- ---------------------------------------------------------------------------

ALTER TABLE workspace_settings
  ALTER COLUMN default_model_id SET DEFAULT 'openrouter:anthropic/claude-sonnet-5';

-- The effort a new workspace starts on has to be one this model names. Sonnet
-- through OpenRouter takes low/medium/high and not `max`, and an effort the
-- adapter cannot map is a 400 on the first turn (decision 26).
ALTER TABLE workspace_settings
  ALTER COLUMN default_effort SET DEFAULT 'medium';
