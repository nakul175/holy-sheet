-- HOLY-69 reusable import mapping profiles.
-- A profile stores a named column-header to field-id mapping and an explicit
-- create or update mode. It does not store staged cell samples, credentials,
-- or record values, and saving one does not grant record access or create fields.
ALTER TABLE hs_data_collection_grants DROP CONSTRAINT IF EXISTS hs_data_collection_grants_capabilities_check;
ALTER TABLE hs_data_collection_grants ADD CONSTRAINT hs_data_collection_grants_capabilities_check CHECK(capabilities <@ ARRAY['view','create','edit','link','import','export','bulk','archive','delete','restore','merge','schema','manage-views','history','restore-values','manage-templates','manage-permissions','manage-forms','manage-reviews','review','manage-import-profiles']::text[]);

CREATE TABLE IF NOT EXISTS hs_data_import_profiles (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
 workspace_id text NOT NULL REFERENCES hs_workspaces(id),
 collection text NOT NULL,
 owner_id text NOT NULL REFERENCES hs_users(id),
 scope text NOT NULL CHECK(scope IN ('personal','shared')),
 name text NOT NULL CHECK(char_length(btrim(name)) BETWEEN 1 AND 100),
 mode text NOT NULL CHECK(mode IN ('create','update')),
 columns jsonb NOT NULL CHECK(jsonb_typeof(columns)='array' AND jsonb_array_length(columns) BETWEEN 1 AND 100),
 bindings jsonb NOT NULL CHECK(jsonb_typeof(bindings)='array' AND jsonb_array_length(bindings)<=100),
 schema_version integer NOT NULL CHECK(schema_version>0),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 deleted boolean NOT NULL DEFAULT false,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(tenant_id,collection) REFERENCES hs_data_collections(tenant_id,id)
);
CREATE INDEX IF NOT EXISTS hs_data_import_profile_shared ON hs_data_import_profiles(tenant_id,workspace_id,collection,id) WHERE deleted=false AND scope='shared';
CREATE INDEX IF NOT EXISTS hs_data_import_profile_owner ON hs_data_import_profiles(tenant_id,workspace_id,owner_id,id) WHERE deleted=false AND scope='personal';

CREATE TABLE IF NOT EXISTS hs_data_import_profile_versions (
 tenant_id uuid NOT NULL,
 profile_id uuid NOT NULL REFERENCES hs_data_import_profiles(id),
 version integer NOT NULL CHECK(version>0),
 name text NOT NULL,
 mode text NOT NULL,
 columns jsonb NOT NULL,
 bindings jsonb NOT NULL,
 schema_version integer NOT NULL,
 actor_id text NOT NULL REFERENCES hs_users(id),
 operation_id uuid NOT NULL,
 source text NOT NULL DEFAULT 'holy-sheet',
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,profile_id,version)
);

CREATE TABLE IF NOT EXISTS hs_data_import_profile_operations (
 tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
 actor_id text NOT NULL REFERENCES hs_users(id),
 operation_id uuid NOT NULL,
 request_hash text NOT NULL,
 profile_id uuid NOT NULL,
 applied_version integer NOT NULL,
 kind text NOT NULL,
 PRIMARY KEY(tenant_id,actor_id,operation_id)
);

CREATE TABLE IF NOT EXISTS hs_data_import_profile_drafts (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
 workspace_id text NOT NULL REFERENCES hs_workspaces(id),
 actor_id text NOT NULL REFERENCES hs_users(id),
 collection text NOT NULL,
 profile_id uuid NOT NULL,
 name text NOT NULL CHECK(char_length(btrim(name)) BETWEEN 1 AND 100),
 scope text NOT NULL CHECK(scope IN ('personal','shared')),
 mode text NOT NULL CHECK(mode IN ('create','update')),
 columns jsonb NOT NULL CHECK(jsonb_typeof(columns)='array' AND jsonb_array_length(columns) BETWEEN 1 AND 100),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,workspace_id,actor_id,collection,profile_id)
);

CREATE OR REPLACE FUNCTION hs_data_import_profile_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.id<>OLD.id OR NEW.tenant_id<>OLD.tenant_id OR NEW.workspace_id<>OLD.workspace_id OR NEW.collection<>OLD.collection OR NEW.owner_id<>OLD.owner_id OR NEW.scope<>OLD.scope OR NEW.created_at<>OLD.created_at THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Import profile identity, collection and audience are immutable; save a new profile to share a personal one';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS hs_data_import_profile_identity_guard ON hs_data_import_profiles;
CREATE TRIGGER hs_data_import_profile_identity_guard BEFORE UPDATE ON hs_data_import_profiles FOR EACH ROW EXECUTE FUNCTION hs_data_import_profile_identity_guard();

DROP TRIGGER IF EXISTS hs_data_import_profile_versions_immutable ON hs_data_import_profile_versions;
CREATE TRIGGER hs_data_import_profile_versions_immutable BEFORE UPDATE OR DELETE ON hs_data_import_profile_versions FOR EACH ROW EXECUTE FUNCTION hs_data_history_immutable();
DROP TRIGGER IF EXISTS hs_data_import_profile_operations_immutable ON hs_data_import_profile_operations;
CREATE TRIGGER hs_data_import_profile_operations_immutable BEFORE UPDATE OR DELETE ON hs_data_import_profile_operations FOR EACH ROW EXECUTE FUNCTION hs_data_history_immutable();
