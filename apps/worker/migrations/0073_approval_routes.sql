-- 0073: approval routing (roles-and-agents plan, piece 3; decision C93).
--
-- One row per rule an Admin has changed. A rule says who may approve one kind
-- of work (Admins, and/or holders of workspace roles), how many different
-- people must, and whether the person whose agent prepared the request (for a
-- decision) or who approved it (for an action) may do so themself. A missing
-- row means the default in packages/shared/src/approval-routing.ts, which is
-- what the product enforced before this table existed.

CREATE TABLE IF NOT EXISTS approval_routes (
  workspace_id       uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  route_key          text NOT NULL CHECK (route_key IN (
                       'application', 'invoice', 'agreement',
                       'payment', 'access_grant', 'signature', 'email_send')),
  admins             boolean NOT NULL,
  roles              text[] NOT NULL DEFAULT '{}' CHECK (cardinality(roles) <= 16),
  approvals_required integer NOT NULL CHECK (approvals_required BETWEEN 1 AND 5),
  allow_requester    boolean NOT NULL,
  updated_by         uuid REFERENCES users (id) ON DELETE SET NULL,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, route_key),
  -- A rule nobody can satisfy would strand every request of its kind.
  CONSTRAINT approval_routes_someone_approves CHECK (admins OR cardinality(roles) > 0),
  -- A decision closes a request in one step in this version.
  CONSTRAINT approval_routes_decision_single CHECK (
    route_key NOT IN ('application', 'invoice', 'agreement') OR approvals_required = 1)
);
DROP TRIGGER IF EXISTS approval_routes_updated_at ON approval_routes;
CREATE TRIGGER approval_routes_updated_at BEFORE UPDATE ON approval_routes
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE approval_routes ENABLE ROW LEVEL SECURITY;
ALTER TABLE approval_routes FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON approval_routes;
CREATE POLICY tenant_isolation ON approval_routes
  USING (workspace_id = app_workspace_id())
  WITH CHECK (workspace_id = app_workspace_id());
GRANT SELECT, INSERT, UPDATE, DELETE ON approval_routes TO app;
REVOKE ALL ON approval_routes FROM agent;

-- The roles a person receives when they join.
ALTER TABLE invitations
  ADD COLUMN IF NOT EXISTS role_slugs text[] NOT NULL DEFAULT '{}'
  CHECK (cardinality(role_slugs) <= 32);

-- Routes and invitations name roles that exist, as members do (0072).
CREATE OR REPLACE FUNCTION role_slugs_exist(target_workspace_id uuid, slugs text[])
  RETURNS text
  LANGUAGE sql
  STABLE
AS $$
  SELECT tag FROM unnest(COALESCE(slugs, '{}'::text[])) tag
   WHERE NOT EXISTS (SELECT 1 FROM workspace_roles r WHERE r.workspace_id = target_workspace_id AND r.slug = tag)
   LIMIT 1;
$$;

CREATE OR REPLACE FUNCTION approval_routes_roles_exist()
  RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE missing text := role_slugs_exist(NEW.workspace_id, NEW.roles);
BEGIN
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'no role % in this workspace', missing USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS approval_routes_roles_exist ON approval_routes;
CREATE TRIGGER approval_routes_roles_exist BEFORE INSERT OR UPDATE OF roles ON approval_routes
  FOR EACH ROW EXECUTE FUNCTION approval_routes_roles_exist();

CREATE OR REPLACE FUNCTION invitations_roles_exist()
  RETURNS trigger
  LANGUAGE plpgsql
AS $$
DECLARE missing text := role_slugs_exist(NEW.workspace_id, NEW.role_slugs);
BEGIN
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'no role % in this workspace', missing USING ERRCODE = '23503';
  END IF;
  RETURN NEW;
END
$$;
DROP TRIGGER IF EXISTS invitations_roles_exist ON invitations;
CREATE TRIGGER invitations_roles_exist BEFORE INSERT OR UPDATE OF role_slugs ON invitations
  FOR EACH ROW EXECUTE FUNCTION invitations_roles_exist();

-- A role approvals route to cannot be removed out from under them. Replaces
-- 0072's guard, keeping its skip for a workspace being deleted.
CREATE OR REPLACE FUNCTION workspace_roles_unheld_on_delete()
  RETURNS trigger
  LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM workspaces w WHERE w.id = OLD.workspace_id) THEN
    RETURN OLD;
  END IF;
  IF EXISTS (SELECT 1 FROM members m WHERE m.workspace_id = OLD.workspace_id AND OLD.slug = ANY (m.reviewer_roles)) THEN
    RAISE EXCEPTION 'role % is still held', OLD.slug USING ERRCODE = '23503';
  END IF;
  IF EXISTS (SELECT 1 FROM approval_routes a WHERE a.workspace_id = OLD.workspace_id AND OLD.slug = ANY (a.roles)) THEN
    RAISE EXCEPTION 'approvals still route to role %', OLD.slug USING ERRCODE = '23503';
  END IF;
  RETURN OLD;
END
$$;
