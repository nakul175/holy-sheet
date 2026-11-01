-- HOLY-70 external system identifier mappings.
-- A mapping is identity metadata for one tenant, integration namespace, and external ID.
-- It is not a credential, and an integration grant does not grant record access.
ALTER TABLE hs_data_collection_grants DROP CONSTRAINT IF EXISTS hs_data_collection_grants_capabilities_check;
ALTER TABLE hs_data_collection_grants ADD CONSTRAINT hs_data_collection_grants_capabilities_check CHECK(capabilities <@ ARRAY['view','create','edit','link','import','export','bulk','archive','delete','restore','merge','schema','manage-views','history','restore-values','manage-templates','manage-permissions','manage-forms','manage-reviews','review','manage-import-profiles','manage-external-ids']::text[]);

CREATE TABLE IF NOT EXISTS hs_external_integrations (
 tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
 workspace_id text NOT NULL REFERENCES hs_workspaces(id),
 namespace text NOT NULL CHECK(namespace ~ '^[a-z0-9][a-z0-9._-]{0,79}$'),
 label text NOT NULL CHECK(char_length(btrim(label)) BETWEEN 1 AND 100),
 state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','archived')),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_by text NOT NULL REFERENCES hs_users(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,namespace)
);

CREATE TABLE IF NOT EXISTS hs_external_integration_grants (
 tenant_id uuid NOT NULL,
 namespace text NOT NULL,
 user_id text NOT NULL REFERENCES hs_users(id) ON DELETE CASCADE,
 can_read boolean NOT NULL DEFAULT false,
 can_write boolean NOT NULL DEFAULT false,
 can_export boolean NOT NULL DEFAULT false,
 can_history boolean NOT NULL DEFAULT false,
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 PRIMARY KEY(tenant_id,namespace,user_id),
 FOREIGN KEY(tenant_id,namespace) REFERENCES hs_external_integrations(tenant_id,namespace)
);

CREATE TABLE IF NOT EXISTS hs_external_identifier_mappings (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
 workspace_id text NOT NULL REFERENCES hs_workspaces(id),
 namespace text NOT NULL,
 external_id text NOT NULL CHECK(char_length(external_id) BETWEEN 1 AND 200),
 record_id uuid NOT NULL,
 original_record_id uuid NOT NULL,
 redirected_from_record_id uuid,
 redirect_reason text CHECK(redirect_reason IS NULL OR redirect_reason IN ('explicit-review','merge')),
 state text NOT NULL CHECK(state IN ('active','archived','deleted')),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 provenance_label text NOT NULL DEFAULT '' CHECK(char_length(provenance_label)<=120),
 created_by text NOT NULL REFERENCES hs_users(id),
 updated_by text NOT NULL REFERENCES hs_users(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,namespace,external_id),
 FOREIGN KEY(tenant_id,namespace) REFERENCES hs_external_integrations(tenant_id,namespace),
 FOREIGN KEY(tenant_id,record_id) REFERENCES hs_data_records(tenant_id,id),
 FOREIGN KEY(tenant_id,original_record_id) REFERENCES hs_data_records(tenant_id,id)
);
CREATE INDEX IF NOT EXISTS hs_external_identifier_record ON hs_external_identifier_mappings(tenant_id,workspace_id,record_id,namespace,external_id);

CREATE TABLE IF NOT EXISTS hs_external_identifier_versions (
 tenant_id uuid NOT NULL,
 mapping_id uuid NOT NULL REFERENCES hs_external_identifier_mappings(id),
 version integer NOT NULL CHECK(version>0),
 namespace text NOT NULL,
 external_id text NOT NULL,
 record_id uuid NOT NULL,
 original_record_id uuid NOT NULL,
 redirected_from_record_id uuid,
 redirect_reason text,
 state text NOT NULL,
 provenance_label text NOT NULL,
 actor_id text NOT NULL REFERENCES hs_users(id),
 operation_id uuid NOT NULL,
 source text NOT NULL DEFAULT 'holy-sheet',
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,mapping_id,version)
);

CREATE TABLE IF NOT EXISTS hs_external_identifier_operations (
 tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
 actor_id text NOT NULL REFERENCES hs_users(id),
 operation_id uuid NOT NULL,
 request_hash text NOT NULL,
 mapping_id uuid NOT NULL,
 applied_version integer NOT NULL,
 kind text NOT NULL,
 PRIMARY KEY(tenant_id,actor_id,operation_id)
);

CREATE TABLE IF NOT EXISTS hs_external_identifier_drafts (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
 workspace_id text NOT NULL REFERENCES hs_workspaces(id),
 actor_id text NOT NULL REFERENCES hs_users(id),
 collection text NOT NULL,
 record_id uuid NOT NULL,
 mapping_id uuid NOT NULL,
 namespace text NOT NULL,
 external_id text NOT NULL,
 provenance_label text NOT NULL DEFAULT '',
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,workspace_id,actor_id,mapping_id)
);

CREATE TABLE IF NOT EXISTS hs_external_identifier_previews (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
 workspace_id text NOT NULL REFERENCES hs_workspaces(id),
 actor_id text NOT NULL REFERENCES hs_users(id),
 record_id uuid NOT NULL,
 namespace text NOT NULL,
 external_id text NOT NULL,
 provenance_label text NOT NULL,
 conflict jsonb,
 review_hash text NOT NULL,
 authority_revision text NOT NULL,
 expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '15 minutes'
);

CREATE OR REPLACE FUNCTION hs_external_identifier_record_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.id<>OLD.id OR NEW.tenant_id<>OLD.tenant_id OR NEW.workspace_id<>OLD.workspace_id OR NEW.namespace<>OLD.namespace OR NEW.external_id<>OLD.external_id OR NEW.original_record_id<>OLD.original_record_id OR NEW.created_by<>OLD.created_by OR NEW.created_at<>OLD.created_at THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='External identifier identity and original record are immutable';
 END IF;
 IF NEW.record_id<>OLD.record_id OR NEW.state<>OLD.state OR NEW.provenance_label IS DISTINCT FROM OLD.provenance_label THEN
  IF NEW.version<>OLD.version+1 THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='External identifier changes require a new version';
  END IF;
 END IF;
 IF NEW.record_id<>OLD.record_id THEN
  IF NEW.redirected_from_record_id IS DISTINCT FROM OLD.record_id OR NEW.redirect_reason NOT IN ('explicit-review','merge') THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='External identifier reassignment requires explicit review or a merge redirect';
  END IF;
  IF NEW.redirect_reason='merge' AND NEW.state<>OLD.state THEN
   RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Merge redirect preserves the explicit mapping state';
  END IF;
 ELSIF NEW.redirected_from_record_id IS DISTINCT FROM OLD.redirected_from_record_id OR NEW.redirect_reason IS DISTINCT FROM OLD.redirect_reason THEN
  RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Redirect metadata changes only when the canonical record changes';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS hs_external_identifier_record_guard ON hs_external_identifier_mappings;
CREATE TRIGGER hs_external_identifier_record_guard BEFORE UPDATE ON hs_external_identifier_mappings FOR EACH ROW EXECUTE FUNCTION hs_external_identifier_record_guard();

DROP TRIGGER IF EXISTS hs_external_identifier_versions_immutable ON hs_external_identifier_versions;
CREATE TRIGGER hs_external_identifier_versions_immutable BEFORE UPDATE OR DELETE ON hs_external_identifier_versions FOR EACH ROW EXECUTE FUNCTION hs_data_history_immutable();
DROP TRIGGER IF EXISTS hs_external_identifier_operations_immutable ON hs_external_identifier_operations;
CREATE TRIGGER hs_external_identifier_operations_immutable BEFORE UPDATE OR DELETE ON hs_external_identifier_operations FOR EACH ROW EXECUTE FUNCTION hs_data_history_immutable();
