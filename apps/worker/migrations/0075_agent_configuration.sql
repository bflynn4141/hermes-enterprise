-- 0075: Admins configure an agent (roles-and-agents plan, piece 4; decision C96).
--
-- Two additions, and neither changes any existing row:
--
--   agents.model_id  the model a new session for this agent starts from. NULL
--                    (every existing agent) keeps today's behaviour: the
--                    workspace default. It is a default, not a lock: a session
--                    owner may still change their session's model, and an
--                    existing session is never rewritten.
--
--   enterprise_skill_assignments.removed_at
--                    an Admin removed this catalog skill from the agent. The
--                    row stays because run grants and discovery grants refer
--                    to it (ON DELETE RESTRICT) and its revision history is
--                    the audit trail. A removed assignment is always paused,
--                    so every reader that asks for `state = 'active'` already
--                    treats it as gone; assigning the same skill again
--                    reactivates the row and clears the mark.

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS model_id text NULL REFERENCES catalog (model_id);
DO $$ BEGIN
  ALTER TABLE agents ADD CONSTRAINT agents_model_id_length
    CHECK (model_id IS NULL OR char_length(model_id) BETWEEN 1 AND 128);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE enterprise_skill_assignments
  ADD COLUMN IF NOT EXISTS removed_at timestamptz NULL;
-- A removed skill can never be the active one: the runtime would otherwise be
-- admitted with a skill the directory no longer lists.
DO $$ BEGIN
  ALTER TABLE enterprise_skill_assignments ADD CONSTRAINT enterprise_skill_assignments_removed_paused
    CHECK (removed_at IS NULL OR state = 'paused');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
