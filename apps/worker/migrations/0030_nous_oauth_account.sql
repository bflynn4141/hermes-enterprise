-- 0030_nous_oauth_account.sql
-- Display-safe Nous account attribution for the workspace provider grant.
--
-- The OAuth token bundle remains envelope-encrypted. These columns retain only
-- identity metadata returned by the authenticated Nous account endpoint so an
-- Admin can tell which subscription is paying for workspace inference. The
-- existing provider_key.added event identifies the WorkOS user who connected
-- it; key_id joins that event to this metadata.

ALTER TABLE workspace_provider_keys
  ADD COLUMN IF NOT EXISTS oauth_account_user_id text,
  ADD COLUMN IF NOT EXISTS oauth_account_email text,
  ADD COLUMN IF NOT EXISTS oauth_organization_id text,
  ADD COLUMN IF NOT EXISTS oauth_organization_name text,
  ADD COLUMN IF NOT EXISTS oauth_organization_slug text,
  ADD COLUMN IF NOT EXISTS oauth_account_verified_at timestamptz;

ALTER TABLE workspace_provider_keys
  DROP CONSTRAINT IF EXISTS workspace_provider_keys_oauth_account_lengths;
ALTER TABLE workspace_provider_keys
  ADD CONSTRAINT workspace_provider_keys_oauth_account_lengths CHECK (
    length(oauth_account_user_id) <= 255 AND
    length(oauth_account_email) <= 320 AND
    length(oauth_organization_id) <= 255 AND
    length(oauth_organization_name) <= 200 AND
    length(oauth_organization_slug) <= 200
  );
