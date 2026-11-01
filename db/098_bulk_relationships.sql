-- HOLY-62 bulk relationship batches. Re-running this file is safe.
-- Links stay in hs_data_relationships. Account parents stay on hs_data_records.parent_organisation_id.
-- A batch records the confirmed snapshot and one outcome per source. It does not grant access.

CREATE TABLE IF NOT EXISTS hs_data_relationship_batches (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
 workspace_id text NOT NULL REFERENCES hs_workspaces(id),
 actor_id text NOT NULL REFERENCES hs_users(id),
 operation_id uuid NOT NULL,
 request_hash text NOT NULL,
 kind text NOT NULL CHECK (kind IN ('contact-account','employee-account','contract-legal-party','contract-account','parent-organisation')),
 operation text NOT NULL CHECK (operation IN ('add','remove','replace')),
 target_id uuid NOT NULL,
 role text NOT NULL DEFAULT '' CHECK (char_length(role) <= 100),
 is_primary boolean NOT NULL DEFAULT false,
 status text NOT NULL DEFAULT 'active' CHECK (status IN ('active','inactive')),
 preview_token text NOT NULL CHECK (preview_token ~ '^[a-f0-9]{64}$'),
 snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'array' AND jsonb_array_length(snapshot) BETWEEN 1 AND 1000),
 state text NOT NULL CHECK (state IN ('running','completed')),
 version integer NOT NULL DEFAULT 1 CHECK (version > 0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 completed_at timestamptz,
 UNIQUE (tenant_id, actor_id, operation_id)
);
CREATE INDEX IF NOT EXISTS hs_data_relationship_batch_actor ON hs_data_relationship_batches(tenant_id, actor_id, created_at DESC);

CREATE TABLE IF NOT EXISTS hs_data_relationship_batch_rows (
 batch_id uuid NOT NULL REFERENCES hs_data_relationship_batches(id),
 source_id uuid NOT NULL,
 ordinal integer NOT NULL CHECK (ordinal BETWEEN 1 AND 1000),
 outcome text NOT NULL CHECK (outcome IN ('success','skipped','error')),
 code text NOT NULL CHECK (char_length(code) BETWEEN 1 AND 80),
 message text NOT NULL CHECK (char_length(message) BETWEEN 1 AND 300),
 before_value jsonb,
 after_value jsonb,
 applied_version integer,
 PRIMARY KEY (batch_id, source_id),
 UNIQUE (batch_id, ordinal)
);

CREATE TABLE IF NOT EXISTS hs_data_relationship_drafts (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
 workspace_id text NOT NULL REFERENCES hs_workspaces(id),
 actor_id text NOT NULL REFERENCES hs_users(id),
 version integer NOT NULL CHECK (version > 0),
 payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
 discarded_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE (tenant_id, workspace_id, actor_id, id)
);
CREATE INDEX IF NOT EXISTS hs_data_relationship_draft_actor ON hs_data_relationship_drafts(tenant_id, workspace_id, actor_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS hs_data_relationship_draft_operations (
 tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
 workspace_id text NOT NULL REFERENCES hs_workspaces(id),
 actor_id text NOT NULL REFERENCES hs_users(id),
 operation_id uuid NOT NULL,
 request_hash text NOT NULL,
 draft_id uuid NOT NULL,
 kind text NOT NULL CHECK (kind IN ('save','discard')),
 applied_version integer NOT NULL,
 PRIMARY KEY (tenant_id, actor_id, operation_id),
 FOREIGN KEY (tenant_id, workspace_id, actor_id, draft_id) REFERENCES hs_data_relationship_drafts(tenant_id, workspace_id, actor_id, id)
);

CREATE OR REPLACE FUNCTION hs_data_relationship_batch_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.workspace_id <> OLD.workspace_id OR NEW.actor_id <> OLD.actor_id OR NEW.operation_id <> OLD.operation_id OR NEW.request_hash <> OLD.request_hash OR NEW.kind <> OLD.kind OR NEW.operation <> OLD.operation OR NEW.target_id <> OLD.target_id OR NEW.role <> OLD.role OR NEW.is_primary <> OLD.is_primary OR NEW.status <> OLD.status OR NEW.preview_token <> OLD.preview_token OR NEW.snapshot <> OLD.snapshot OR NEW.created_at <> OLD.created_at THEN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Relationship batch identity is immutable';
 END IF;
 IF OLD.state = 'completed' AND (NEW.state <> 'completed' OR NEW.completed_at IS DISTINCT FROM OLD.completed_at OR NEW.version <> OLD.version) THEN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A completed relationship batch cannot change';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS hs_data_relationship_batch_guard ON hs_data_relationship_batches;
CREATE TRIGGER hs_data_relationship_batch_guard BEFORE UPDATE ON hs_data_relationship_batches FOR EACH ROW EXECUTE FUNCTION hs_data_relationship_batch_guard();

CREATE OR REPLACE FUNCTION hs_data_relationship_batch_row_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Relationship batch rows are append-only';
END $$;
DROP TRIGGER IF EXISTS hs_data_relationship_batch_row_guard ON hs_data_relationship_batch_rows;
CREATE TRIGGER hs_data_relationship_batch_row_guard BEFORE UPDATE OR DELETE ON hs_data_relationship_batch_rows FOR EACH ROW EXECUTE FUNCTION hs_data_relationship_batch_row_guard();

CREATE OR REPLACE FUNCTION hs_data_relationship_draft_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.workspace_id <> OLD.workspace_id OR NEW.actor_id <> OLD.actor_id OR NEW.created_at <> OLD.created_at OR NEW.version <= OLD.version THEN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Relationship draft identity is immutable';
 END IF;
 IF OLD.discarded_at IS NOT NULL THEN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A discarded relationship draft cannot change';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS hs_data_relationship_draft_guard ON hs_data_relationship_drafts;
CREATE TRIGGER hs_data_relationship_draft_guard BEFORE UPDATE ON hs_data_relationship_drafts FOR EACH ROW EXECUTE FUNCTION hs_data_relationship_draft_guard();
