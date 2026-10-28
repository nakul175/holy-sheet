-- Empty registries. Configuration authority never grants record access.
CREATE TABLE IF NOT EXISTS hs_data_reference_list_permissions(
 tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),user_id text NOT NULL REFERENCES hs_users(id),
 can_read boolean NOT NULL DEFAULT false,can_manage boolean NOT NULL DEFAULT false,version integer NOT NULL DEFAULT 1 CHECK(version>0),
 CHECK(NOT can_manage OR can_read),PRIMARY KEY(tenant_id,user_id));
CREATE TABLE IF NOT EXISTS hs_data_reference_lists(
 tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),id uuid NOT NULL,name text NOT NULL,
 name_search text GENERATED ALWAYS AS(lower(name)) STORED,version integer NOT NULL CHECK(version>0),definition jsonb NOT NULL,
 created_by text NOT NULL REFERENCES hs_users(id),PRIMARY KEY(tenant_id,id),UNIQUE(tenant_id,name_search));
CREATE TABLE IF NOT EXISTS hs_data_reference_list_versions(
 tenant_id uuid NOT NULL,list_id uuid NOT NULL,version integer NOT NULL,definition jsonb NOT NULL,
 actor_id text NOT NULL REFERENCES hs_users(id),operation_id uuid NOT NULL,source_app text NOT NULL DEFAULT 'holy-sheet',
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,list_id,version),
 FOREIGN KEY(tenant_id,list_id) REFERENCES hs_data_reference_lists(tenant_id,id));
CREATE TABLE IF NOT EXISTS hs_data_reference_list_previews(
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),workspace_id text NOT NULL REFERENCES hs_workspaces(id),
 actor_id text NOT NULL REFERENCES hs_users(id),list_id uuid NOT NULL,expected_version integer NOT NULL,
 definition_hash text NOT NULL,review_hash text NOT NULL,schema_version integer NOT NULL,policy_version integer NOT NULL,
 data_revision bigint NOT NULL,authority_revision text NOT NULL,permission_version integer NOT NULL,
 expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '10 minutes');
CREATE TABLE IF NOT EXISTS hs_data_reference_list_operations(
 tenant_id uuid NOT NULL,actor_id text NOT NULL REFERENCES hs_users(id),operation_id uuid NOT NULL,
 list_id uuid NOT NULL,request_hash text NOT NULL,applied_version integer NOT NULL,
 PRIMARY KEY(tenant_id,actor_id,operation_id),FOREIGN KEY(tenant_id,list_id) REFERENCES hs_data_reference_lists(tenant_id,id));
DROP TRIGGER IF EXISTS hs_data_reference_list_versions_immutable ON hs_data_reference_list_versions;
CREATE TRIGGER hs_data_reference_list_versions_immutable BEFORE UPDATE OR DELETE ON hs_data_reference_list_versions FOR EACH ROW EXECUTE FUNCTION hs_data_history_immutable();
