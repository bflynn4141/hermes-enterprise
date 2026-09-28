-- 0080: what the agent took from an email (decision C100).
--
-- When the agent suggests a reply or a hand-off it may add a brief: a short
-- summary and the action items in the email, each marked as ours or the
-- sender's, with a due date only when the email gives one. It is stored on the
-- message so every place that shows the email shows the same brief. It is the
-- agent's reading of untrusted text and never acts by itself; the latest
-- suggestion's brief replaces an earlier one.

ALTER TABLE inbound_email_messages ADD COLUMN IF NOT EXISTS brief jsonb;
ALTER TABLE inbound_email_messages DROP CONSTRAINT IF EXISTS inbound_email_messages_brief_shape;
ALTER TABLE inbound_email_messages ADD CONSTRAINT inbound_email_messages_brief_shape
  CHECK (brief IS NULL OR (jsonb_typeof(brief) = 'object' AND octet_length(brief::text) <= 16384));

GRANT UPDATE (brief) ON inbound_email_messages TO app;
