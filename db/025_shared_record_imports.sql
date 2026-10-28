-- Private staging only, with logical 24-hour expiry and operator-invoked cleanup.
ALTER TABLE hs_data_operations ADD COLUMN IF NOT EXISTS batch_id uuid;
ALTER TABLE hs_data_events ADD COLUMN IF NOT EXISTS batch_id uuid;
ALTER TABLE hs_data_change_events ADD COLUMN IF NOT EXISTS batch_id uuid;
ALTER TABLE hs_data_events ADD COLUMN IF NOT EXISTS batch_row integer CHECK(batch_row BETWEEN 1 AND 1048576);
ALTER TABLE hs_data_change_events ADD COLUMN IF NOT EXISTS batch_row integer CHECK(batch_row BETWEEN 1 AND 1048576);
CREATE TABLE IF NOT EXISTS hs_data_import_jobs (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),workspace_id text NOT NULL REFERENCES hs_workspaces(id),actor_id text NOT NULL REFERENCES hs_users(id),
 collection text NOT NULL,source_hash text NOT NULL,source_name text NOT NULL,format text NOT NULL CHECK(format IN ('csv','xlsx')),
 headers jsonb NOT NULL,warnings jsonb NOT NULL,worksheet text,source_bytes integer NOT NULL CHECK(source_bytes BETWEEN 1 AND 20971520),
 state text NOT NULL DEFAULT 'staged' CHECK(state IN ('staged','reviewing','reviewed','running','partial','completed','cancelled','expired')),
 mode text CHECK(mode IN ('create','update')),mapping jsonb,schema_version integer,policy_version integer,review_hash text,
 review_offset integer NOT NULL DEFAULT 0,row_count integer NOT NULL CHECK(row_count BETWEEN 1 AND 10000),version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '24 hours',
 FOREIGN KEY(tenant_id,collection) REFERENCES hs_data_collections(tenant_id,id)
);
CREATE INDEX IF NOT EXISTS hs_data_import_actor ON hs_data_import_jobs(tenant_id,actor_id,expires_at);
CREATE TABLE IF NOT EXISTS hs_data_import_rows (
 job_id uuid NOT NULL REFERENCES hs_data_import_jobs(id) ON DELETE CASCADE,ordinal integer NOT NULL,source_row integer NOT NULL,
 operation_id uuid NOT NULL,raw_cells jsonb NOT NULL,source_errors jsonb NOT NULL,
 state text NOT NULL DEFAULT 'unreviewed' CHECK(state IN ('unreviewed','valid','invalid','applied','blocked')),
 payload jsonb,errors jsonb NOT NULL DEFAULT '[]',duplicate_warning boolean NOT NULL DEFAULT false,
 record_id uuid REFERENCES hs_data_records(id),applied_version integer,
 PRIMARY KEY(job_id,ordinal)
);
CREATE TABLE IF NOT EXISTS hs_data_import_commands (
 job_id uuid NOT NULL REFERENCES hs_data_import_jobs(id) ON DELETE CASCADE,id uuid NOT NULL,request_hash text NOT NULL,
 ordinals jsonb NOT NULL,state text NOT NULL DEFAULT 'running' CHECK(state IN ('running','blocked','completed')),
 PRIMARY KEY(job_id,id)
);
CREATE TABLE IF NOT EXISTS hs_data_import_row_keys (
 job_id uuid NOT NULL REFERENCES hs_data_import_jobs(id) ON DELETE CASCADE,kind text NOT NULL,value_hash text NOT NULL,ordinal integer NOT NULL,
 PRIMARY KEY(job_id,kind,value_hash)
);
CREATE OR REPLACE FUNCTION hs_data_import_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.id<>OLD.id OR NEW.tenant_id<>OLD.tenant_id OR NEW.workspace_id<>OLD.workspace_id OR NEW.actor_id<>OLD.actor_id OR NEW.collection<>OLD.collection OR NEW.format<>OLD.format OR NEW.source_hash<>OLD.source_hash OR NEW.source_bytes<>OLD.source_bytes OR NEW.created_at<>OLD.created_at OR NEW.expires_at>OLD.expires_at THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Import batch identity and maximum lifetime are immutable'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS hs_data_import_identity_guard ON hs_data_import_jobs;
CREATE TRIGGER hs_data_import_identity_guard BEFORE UPDATE ON hs_data_import_jobs FOR EACH ROW EXECUTE FUNCTION hs_data_import_identity_guard();
