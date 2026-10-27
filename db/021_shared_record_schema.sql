-- Unexposed schema-review ledger; no tenant mapping, capability or schema is seeded.
ALTER TABLE hs_data_tenants ADD COLUMN IF NOT EXISTS data_revision bigint NOT NULL DEFAULT 1;
ALTER TABLE hs_data_tenants ADD COLUMN IF NOT EXISTS dependency_revision bigint NOT NULL DEFAULT 1;
CREATE TABLE IF NOT EXISTS hs_data_schema_dependencies (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, collection text NOT NULL, field_key text NOT NULL,
 kind text NOT NULL CHECK(kind IN ('view','import-mapping','integration','reference-policy')),
 label text NOT NULL CHECK(char_length(label) BETWEEN 1 AND 200), version integer NOT NULL DEFAULT 1,
 active boolean NOT NULL DEFAULT true,
 FOREIGN KEY(tenant_id,collection,field_key) REFERENCES hs_data_fields(tenant_id,collection,field_key)
);
CREATE TABLE IF NOT EXISTS hs_data_schema_previews (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id), actor_id text NOT NULL REFERENCES hs_users(id),
 workspace_id text NOT NULL REFERENCES hs_workspaces(id), prepare_id uuid NOT NULL, request_hash text NOT NULL,
 collection text NOT NULL, field_key text NOT NULL, proposed jsonb NOT NULL, review_hash text NOT NULL,
 schema_version integer NOT NULL, policy_version integer NOT NULL, data_revision bigint NOT NULL, dependency_revision bigint NOT NULL,
 authority_revision text NOT NULL, before_schema jsonb, impact jsonb NOT NULL,
 expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '10 minutes',
 UNIQUE(tenant_id,actor_id,prepare_id)
);
CREATE INDEX IF NOT EXISTS hs_data_schema_preview_expiry ON hs_data_schema_previews(expires_at);
CREATE TABLE IF NOT EXISTS hs_data_schema_operations (
 tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id), actor_id text NOT NULL REFERENCES hs_users(id), operation_id uuid NOT NULL,
 request_hash text NOT NULL, preview_id uuid NOT NULL, collection text NOT NULL, field_key text NOT NULL,
 applied_schema_version integer NOT NULL, PRIMARY KEY(tenant_id,actor_id,operation_id)
);
CREATE TABLE IF NOT EXISTS hs_data_schema_versions (
 tenant_id uuid NOT NULL, collection text NOT NULL, field_key text NOT NULL, version integer NOT NULL,
 schema_version integer NOT NULL, definition jsonb NOT NULL, actor_id text NOT NULL REFERENCES hs_users(id),
 operation_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,collection,field_key,version), FOREIGN KEY(tenant_id,collection,field_key) REFERENCES hs_data_fields(tenant_id,collection,field_key)
);
CREATE OR REPLACE FUNCTION hs_data_revision_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE hs_data_tenants SET data_revision=data_revision+1 WHERE id IN(SELECT DISTINCT tenant_id FROM hs_changed_records);
 RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS hs_data_revision_insert ON hs_data_records;
CREATE TRIGGER hs_data_revision_insert AFTER INSERT ON hs_data_records REFERENCING NEW TABLE AS hs_changed_records FOR EACH STATEMENT EXECUTE FUNCTION hs_data_revision_changed();
DROP TRIGGER IF EXISTS hs_data_revision_update ON hs_data_records;
CREATE TRIGGER hs_data_revision_update AFTER UPDATE ON hs_data_records REFERENCING NEW TABLE AS hs_changed_records FOR EACH STATEMENT EXECUTE FUNCTION hs_data_revision_changed();
DROP TRIGGER IF EXISTS hs_data_revision_delete ON hs_data_records;
CREATE TRIGGER hs_data_revision_delete AFTER DELETE ON hs_data_records REFERENCING OLD TABLE AS hs_changed_records FOR EACH STATEMENT EXECUTE FUNCTION hs_data_revision_changed();
CREATE OR REPLACE FUNCTION hs_data_dependency_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN UPDATE hs_data_tenants SET dependency_revision=dependency_revision+1 WHERE id=OLD.tenant_id; RETURN OLD;
 ELSE UPDATE hs_data_tenants SET dependency_revision=dependency_revision+1 WHERE id=NEW.tenant_id; RETURN NEW; END IF;
END $$;
DROP TRIGGER IF EXISTS hs_data_dependency_changed ON hs_data_schema_dependencies;
CREATE TRIGGER hs_data_dependency_changed AFTER INSERT OR UPDATE OR DELETE ON hs_data_schema_dependencies FOR EACH ROW EXECUTE FUNCTION hs_data_dependency_changed();
CREATE OR REPLACE FUNCTION hs_data_field_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.tenant_id<>OLD.tenant_id OR NEW.collection<>OLD.collection OR NEW.field_key<>OLD.field_key THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Field identity is immutable'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS hs_data_field_identity_guard ON hs_data_fields;
CREATE TRIGGER hs_data_field_identity_guard BEFORE UPDATE ON hs_data_fields FOR EACH ROW EXECUTE FUNCTION hs_data_field_identity_guard();
CREATE OR REPLACE FUNCTION hs_data_schema_version_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Schema history is immutable'; END $$;
DROP TRIGGER IF EXISTS hs_data_schema_version_immutable ON hs_data_schema_versions;
CREATE TRIGGER hs_data_schema_version_immutable BEFORE UPDATE OR DELETE ON hs_data_schema_versions FOR EACH ROW EXECUTE FUNCTION hs_data_schema_version_immutable();
