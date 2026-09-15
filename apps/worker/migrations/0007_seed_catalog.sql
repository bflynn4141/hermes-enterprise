-- 0007_seed_catalog.sql
-- The four catalog rows, from section 4 of the production plan.
--
-- Two are disabled and say why in the row itself, so the model menu can explain
-- the absence instead of silently omitting a model someone expected. Prices are
-- carried with the date they were checked; "estimated, billed by your provider"
-- is the label the Usage screen shows, and `pricing_verified_on` is what makes
-- that claim checkable.
--
-- A price change is a new migration, so it is reviewable and reversible.

INSERT INTO catalog (model_id, provider, label, transport, effort_map, default_effort, pricing_per_million, pricing_verified_on, disabled_reason)
VALUES
  (
    'deepseek-flash', 'deepseek', 'DeepSeek Flash', 'deepseek_chat',
    '{"low":"low","high":"high","max":"max"}'::jsonb, 'high',
    -- DeepSeek publishes peak and off-peak prices; both are carried so an
    -- estimate cannot silently use the wrong one.
    '{"input":0.28,"output":0.42,"input_off_peak":0.14,"output_off_peak":0.21,"cached_input":0.028}'::jsonb,
    DATE '2026-09-14', NULL
  ),
  (
    'claude-sonnet-4-6', 'anthropic', 'Claude Sonnet 4.6', 'anthropic_messages',
    '{"low":"low","medium":"medium","high":"high","max":"max"}'::jsonb, 'high',
    '{"input":3,"output":15,"input_off_peak":null,"output_off_peak":null,"cached_input":0.3}'::jsonb,
    DATE '2026-09-14', NULL
  ),
  (
    'claude-opus-4-7', 'anthropic', 'Claude Opus 4.7', 'anthropic_messages',
    NULL, NULL,
    '{"input":15,"output":75,"input_off_peak":null,"output_off_peak":null,"cached_input":1.5}'::jsonb,
    DATE '2026-09-14',
    'Not enabled for the pilot: cost per run exceeds the pilot spend budget.'
  ),
  (
    'gpt-5-5', 'openai', 'GPT-5.5', 'openai_responses',
    NULL, NULL,
    '{"input":1.25,"output":10,"input_off_peak":null,"output_off_peak":null,"cached_input":0.125}'::jsonb,
    DATE '2026-09-14',
    'Awaiting the M3 reasoning-replay engine test for the Responses transport.'
  )
ON CONFLICT (model_id) DO UPDATE SET
  provider = EXCLUDED.provider,
  label = EXCLUDED.label,
  transport = EXCLUDED.transport,
  effort_map = EXCLUDED.effort_map,
  default_effort = EXCLUDED.default_effort,
  pricing_per_million = EXCLUDED.pricing_per_million,
  pricing_verified_on = EXCLUDED.pricing_verified_on,
  disabled_reason = EXCLUDED.disabled_reason;

-- The Nous Portal row from the demo is deliberately absent: it was a proposed
-- demo configuration, never a verified deployment, and the catalog only carries
-- rows a workspace could actually reach with its own key.
