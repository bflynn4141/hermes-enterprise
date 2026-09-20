-- Jev is served by TypeSafe's System One API. Keep prior assessment rows as
-- immutable audit history while new rows identify the provider surface and
-- public model alias that actually produced them.

ALTER TABLE request_triage_assessments
  ALTER COLUMN provider SET DEFAULT 'typesafe_api',
  ALTER COLUMN model_id SET DEFAULT 'jev-latest';
