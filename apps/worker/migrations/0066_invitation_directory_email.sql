-- Which pending invitations are addressed to this person?
--
-- The workspace picker (`GET /auth/session` with no `?ws`) answers "which
-- workspaces am I in?" from `member_directory`. It could not answer "who has
-- invited me?" at all: `invitations` is a tenant table under forced row-level
-- security, and a person with no membership yet has no tenant key to ask
-- under. Today the only way to reach an invitation was the emailed link.
--
-- `invitation_directory` (0013) already keeps one platform-side row per live
-- invitation token. This adds a *digest* of the invited address to it, so the
-- question becomes a platform lookup that returns only ids — the route then
-- reads each invitation under its own workspace key, filtered by the session's
-- verified email a second time. The digest, not the address: `app` can read
-- this table without a tenant key, and a platform table of plaintext email
-- addresses is a list nobody needs.

ALTER TABLE invitation_directory ADD COLUMN IF NOT EXISTS email_digest bytea;
CREATE INDEX IF NOT EXISTS invitation_directory_email_idx ON invitation_directory (email_digest);

CREATE OR REPLACE FUNCTION hermes_invitation_email_digest(address text) RETURNS bytea
  LANGUAGE sql IMMUTABLE STRICT
  AS $$ SELECT sha256(convert_to(lower(btrim(address)), 'UTF8')) $$;

-- The same trigger as 0013, now carrying the digest on every row it writes.
CREATE OR REPLACE FUNCTION invitation_directory_sync() RETURNS trigger
  LANGUAGE plpgsql
  SECURITY DEFINER
  SET search_path = public
  AS $$
  DECLARE
    digest bytea;
  BEGIN
    IF TG_OP = 'DELETE' THEN
      DELETE FROM invitation_directory WHERE invitation_id = OLD.id;
      RETURN OLD;
    END IF;
    -- Only a live invitation is reachable. A withdrawn or accepted one loses
    -- its row, so a forwarded link stops resolving the moment it stops being
    -- an invitation.
    IF NEW.status <> 'pending' THEN
      DELETE FROM invitation_directory WHERE invitation_id = NEW.id;
      RETURN NEW;
    END IF;
    digest := hermes_invitation_email_digest(NEW.email);
    INSERT INTO invitation_directory (token, invitation_id, workspace_id, email_digest)
    VALUES (NEW.id::text, NEW.id, NEW.workspace_id, digest)
    ON CONFLICT (token) DO UPDATE SET invitation_id = EXCLUDED.invitation_id,
                                      workspace_id = EXCLUDED.workspace_id,
                                      email_digest = EXCLUDED.email_digest;
    IF NEW.workos_invitation_id IS NOT NULL THEN
      INSERT INTO invitation_directory (token, invitation_id, workspace_id, email_digest)
      VALUES (NEW.workos_invitation_id, NEW.id, NEW.workspace_id, digest)
      ON CONFLICT (token) DO UPDATE SET invitation_id = EXCLUDED.invitation_id,
                                        workspace_id = EXCLUDED.workspace_id,
                                        email_digest = EXCLUDED.email_digest;
    END IF;
    IF NEW.token_hash IS NOT NULL THEN
      INSERT INTO invitation_directory (token, invitation_id, workspace_id, email_digest)
      VALUES (NEW.token_hash, NEW.id, NEW.workspace_id, digest)
      ON CONFLICT (token) DO UPDATE SET invitation_id = EXCLUDED.invitation_id,
                                        workspace_id = EXCLUDED.workspace_id,
                                        email_digest = EXCLUDED.email_digest;
    END IF;
    RETURN NEW;
  END $$;

-- Backfill rows written before the column existed. The migration role is
-- NOBYPASSRLS like every other, so each workspace is visited under its own
-- tenant key; the directory itself is the list of workspaces to visit.
DO $$
DECLARE
  ws uuid;
BEGIN
  FOR ws IN SELECT DISTINCT d.workspace_id FROM invitation_directory d WHERE d.email_digest IS NULL LOOP
    PERFORM set_config('app.workspace_id', ws::text, true);
    UPDATE invitation_directory d
       SET email_digest = hermes_invitation_email_digest(i.email)
      FROM invitations i
     WHERE i.id = d.invitation_id AND i.workspace_id = ws AND d.email_digest IS NULL;
  END LOOP;
  PERFORM set_config('app.workspace_id', '', true);
END $$;

-- Ids only. Names, roles and expiry are read afterwards under each
-- workspace's own key, where the invited address is checked again against
-- the session. Bounded, because a list is what the picker shows and fifty is
-- already more than anyone has.
DROP FUNCTION IF EXISTS hermes_user_invitations(text);
CREATE OR REPLACE FUNCTION hermes_user_invitations(subject_email text)
  RETURNS TABLE (invitation_id uuid, workspace_id uuid)
  LANGUAGE sql
  STABLE
  AS $$
    SELECT DISTINCT d.invitation_id, d.workspace_id
      FROM invitation_directory d
     WHERE d.email_digest = hermes_invitation_email_digest(subject_email)
     LIMIT 50
  $$;

GRANT EXECUTE ON FUNCTION hermes_invitation_email_digest(text) TO app;
GRANT EXECUTE ON FUNCTION hermes_user_invitations(text) TO app;
