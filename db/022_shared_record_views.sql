-- Unexposed view configuration; a view never grants record or field access.
CREATE TABLE IF NOT EXISTS hs_data_views (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, workspace_id text NOT NULL REFERENCES hs_workspaces(id),
 collection text NOT NULL, owner_id text NOT NULL REFERENCES hs_users(id),
 scope text NOT NULL CHECK(scope IN ('private','workspace')), name text NOT NULL CHECK(char_length(btrim(name)) BETWEEN 1 AND 100),
 definition jsonb NOT NULL, version integer NOT NULL DEFAULT 1, deleted boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(tenant_id,collection) REFERENCES hs_data_collections(tenant_id,id)
);
CREATE INDEX IF NOT EXISTS hs_data_view_workspace ON hs_data_views(tenant_id,workspace_id,collection,id) WHERE(deleted=false AND scope='workspace');
CREATE INDEX IF NOT EXISTS hs_data_view_owner ON hs_data_views(tenant_id,workspace_id,owner_id,id) WHERE(deleted=false AND scope='private');
ALTER TABLE hs_data_schema_dependencies ADD COLUMN IF NOT EXISTS view_id uuid REFERENCES hs_data_views(id);
CREATE INDEX IF NOT EXISTS hs_data_schema_dependency_view ON hs_data_schema_dependencies(tenant_id,view_id);
CREATE TABLE IF NOT EXISTS hs_data_view_operations (
 tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),actor_id text NOT NULL REFERENCES hs_users(id),operation_id uuid NOT NULL,
 request_hash text NOT NULL,view_id uuid NOT NULL REFERENCES hs_data_views(id),applied_version integer NOT NULL,
 PRIMARY KEY(tenant_id,actor_id,operation_id)
);
CREATE TABLE IF NOT EXISTS hs_data_view_cursors (
 token_hash text PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),workspace_id text NOT NULL REFERENCES hs_workspaces(id),
 actor_id text NOT NULL REFERENCES hs_users(id),view_id uuid NOT NULL REFERENCES hs_data_views(id),scope_hash text NOT NULL,last_values jsonb NOT NULL,
 expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '5 minutes'
);
CREATE INDEX IF NOT EXISTS hs_data_view_cursor_expiry ON hs_data_view_cursors(expires_at);
CREATE OR REPLACE FUNCTION hs_data_view_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.id<>OLD.id OR NEW.tenant_id<>OLD.tenant_id OR NEW.workspace_id<>OLD.workspace_id OR NEW.collection<>OLD.collection OR NEW.owner_id<>OLD.owner_id OR NEW.scope<>OLD.scope THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='View identity and audience are immutable; explicitly copy to a new view'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS hs_data_view_identity_guard ON hs_data_views;
CREATE TRIGGER hs_data_view_identity_guard BEFORE UPDATE ON hs_data_views FOR EACH ROW EXECUTE FUNCTION hs_data_view_identity_guard();
