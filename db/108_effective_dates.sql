-- HOLY-73 effective-dated field values.
-- Effective time is stored separately from the transaction time (entered_at).
-- No schedule runner, live activation, purge, or payroll calculation is enabled.
ALTER TABLE hs_data_collection_grants DROP CONSTRAINT IF EXISTS hs_data_collection_grants_capabilities_check;
ALTER TABLE hs_data_collection_grants ADD CONSTRAINT hs_data_collection_grants_capabilities_check CHECK(capabilities <@ ARRAY['view','create','edit','link','import','export','bulk','archive','delete','restore','merge','schema','manage-views','history','restore-values','manage-templates','manage-permissions','manage-forms','manage-reviews','review','manage-import-profiles','manage-external-ids','manage-integration-health','manage-effective-dates','correct-effective']::text[]);

CREATE TABLE IF NOT EXISTS hs_effective_field_policies (
 tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
 collection text NOT NULL,
 field_key text NOT NULL CHECK(field_key ~ '^(core:[a-z0-9-]{1,40}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$'),
 enabled boolean NOT NULL DEFAULT false,
 version integer NOT NULL DEFAULT 1 CHECK(version > 0),
 updated_by text NOT NULL REFERENCES hs_users(id),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id, collection, field_key),
 FOREIGN KEY(tenant_id, collection) REFERENCES hs_data_collections(tenant_id, id)
);

CREATE TABLE IF NOT EXISTS hs_effective_field_policy_versions (
 tenant_id uuid NOT NULL,
 collection text NOT NULL,
 field_key text NOT NULL,
 version integer NOT NULL CHECK(version > 0),
 enabled boolean NOT NULL,
 actor_id text NOT NULL REFERENCES hs_users(id),
 operation_id uuid NOT NULL,
 source text NOT NULL DEFAULT 'holy-sheet',
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id, collection, field_key, version),
 FOREIGN KEY(tenant_id, collection, field_key) REFERENCES hs_effective_field_policies(tenant_id, collection, field_key)
);

CREATE TABLE IF NOT EXISTS hs_effective_assignments (
 tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
 collection text NOT NULL,
 user_id text NOT NULL REFERENCES hs_users(id) ON DELETE CASCADE,
 can_propose boolean NOT NULL DEFAULT false,
 can_correct boolean NOT NULL DEFAULT false,
 can_activate boolean NOT NULL DEFAULT false,
 can_cancel boolean NOT NULL DEFAULT false,
 version integer NOT NULL DEFAULT 1 CHECK(version > 0),
 updated_by text NOT NULL REFERENCES hs_users(id),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id, collection, user_id),
 FOREIGN KEY(tenant_id, collection) REFERENCES hs_data_collections(tenant_id, id)
);

CREATE TABLE IF NOT EXISTS hs_effective_intervals (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
 workspace_id text NOT NULL REFERENCES hs_workspaces(id),
 record_id uuid NOT NULL,
 collection text NOT NULL,
 field_key text NOT NULL,
 value jsonb NOT NULL,
 effective_start timestamptz NOT NULL,
 effective_end timestamptz,
 timezone text NOT NULL CHECK(char_length(timezone) BETWEEN 1 AND 100),
 state text NOT NULL CHECK(state IN ('scheduled','active','ended','cancelled','blocked')),
 reason text NOT NULL DEFAULT '' CHECK(char_length(reason) <= 500),
 blocked_code text CHECK(blocked_code IS NULL OR blocked_code IN ('schema_invalid','target_invalid','rights_revoked','field_unavailable','config_disabled')),
 version integer NOT NULL DEFAULT 1 CHECK(version > 0),
 entered_at timestamptz NOT NULL,
 entered_by text NOT NULL REFERENCES hs_users(id),
 source text NOT NULL DEFAULT 'holy-sheet',
 operation_id uuid NOT NULL,
 activated_at timestamptz,
 cancelled_at timestamptz,
 CHECK(effective_end IS NULL OR effective_end > effective_start),
 FOREIGN KEY(tenant_id, record_id) REFERENCES hs_data_records(tenant_id, id)
);
CREATE INDEX IF NOT EXISTS hs_effective_interval_lookup ON hs_effective_intervals(tenant_id, record_id, field_key, effective_start);

CREATE TABLE IF NOT EXISTS hs_effective_drafts (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
 workspace_id text NOT NULL REFERENCES hs_workspaces(id),
 actor_id text NOT NULL REFERENCES hs_users(id),
 record_id uuid NOT NULL,
 collection text NOT NULL,
 field_key text NOT NULL,
 value jsonb NOT NULL,
 effective_start text NOT NULL,
 effective_end text,
 timezone text NOT NULL,
 reason text NOT NULL DEFAULT '' CHECK(char_length(reason) <= 500),
 version integer NOT NULL DEFAULT 1 CHECK(version > 0),
 state text NOT NULL DEFAULT 'open' CHECK(state IN ('open','discarded')),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(tenant_id, record_id) REFERENCES hs_data_records(tenant_id, id)
);

CREATE TABLE IF NOT EXISTS hs_effective_previews (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
 workspace_id text NOT NULL REFERENCES hs_workspaces(id),
 actor_id text NOT NULL REFERENCES hs_users(id),
 collection text NOT NULL,
 action text NOT NULL,
 confirm text NOT NULL,
 payload jsonb NOT NULL,
 review_hash text NOT NULL,
 authority_revision text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL DEFAULT clock_timestamp() + interval '10 minutes'
);

CREATE TABLE IF NOT EXISTS hs_effective_operations (
 tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
 actor_id text NOT NULL REFERENCES hs_users(id),
 operation_id uuid NOT NULL,
 request_hash text NOT NULL,
 kind text NOT NULL,
 record_id uuid,
 applied_version integer NOT NULL,
 result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id, actor_id, operation_id)
);

CREATE OR REPLACE FUNCTION hs_effective_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Effective-date history is immutable'; END $$;
DROP TRIGGER IF EXISTS hs_effective_policy_version_immutable ON hs_effective_field_policy_versions;
CREATE TRIGGER hs_effective_policy_version_immutable BEFORE UPDATE OR DELETE ON hs_effective_field_policy_versions FOR EACH ROW EXECUTE FUNCTION hs_effective_history_immutable();
DROP TRIGGER IF EXISTS hs_effective_operation_immutable ON hs_effective_operations;
CREATE TRIGGER hs_effective_operation_immutable BEFORE UPDATE OR DELETE ON hs_effective_operations FOR EACH ROW EXECUTE FUNCTION hs_effective_history_immutable();

CREATE OR REPLACE FUNCTION hs_effective_interval_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.tenant_id <> OLD.tenant_id OR NEW.workspace_id <> OLD.workspace_id OR NEW.record_id <> OLD.record_id
    OR NEW.collection <> OLD.collection OR NEW.field_key <> OLD.field_key
    OR NEW.effective_start <> OLD.effective_start OR NEW.effective_end IS DISTINCT FROM OLD.effective_end
    OR NEW.timezone <> OLD.timezone OR NEW.value <> OLD.value
    OR NEW.entered_at <> OLD.entered_at OR NEW.entered_by <> OLD.entered_by OR NEW.source <> OLD.source
 THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Effective interval identity, value, and entered time are immutable'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS hs_effective_interval_guard ON hs_effective_intervals;
CREATE TRIGGER hs_effective_interval_guard BEFORE UPDATE ON hs_effective_intervals FOR EACH ROW EXECUTE FUNCTION hs_effective_interval_guard();
