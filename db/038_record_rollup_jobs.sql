CREATE TABLE IF NOT EXISTS hs_data_rollup_jobs (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id), workspace_id text NOT NULL REFERENCES hs_workspaces(id),
 actor_id text NOT NULL REFERENCES hs_users(id), owner_record_id uuid NOT NULL, owner_version integer NOT NULL,
 collection text NOT NULL, field_key uuid NOT NULL, rollup_version integer NOT NULL, definition jsonb NOT NULL,
 schema_version integer NOT NULL, policy_version integer NOT NULL, data_revision bigint NOT NULL, authority_revision text NOT NULL,
 state text NOT NULL DEFAULT 'pending' CHECK(state IN('pending','running','completed','stale','cancelled','failed')),
 next_ordinal integer NOT NULL DEFAULT 0 CHECK(next_ordinal>=0), page_count integer NOT NULL DEFAULT 0 CHECK(page_count>=0),
 visible_count integer NOT NULL DEFAULT 0 CHECK(visible_count>=0), accumulator jsonb NOT NULL DEFAULT '{"count":0,"value":null}',
 result jsonb, failure_code text, version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '24 hours',
 UNIQUE(tenant_id,actor_id,id), FOREIGN KEY(tenant_id,owner_record_id) REFERENCES hs_data_records(tenant_id,id)
);
CREATE INDEX IF NOT EXISTS hs_data_rollup_job_actor ON hs_data_rollup_jobs(tenant_id,workspace_id,actor_id,created_at DESC);
CREATE INDEX IF NOT EXISTS hs_data_rollup_job_expiry ON hs_data_rollup_jobs(expires_at);
CREATE TABLE IF NOT EXISTS hs_data_rollup_job_items (
 job_id uuid NOT NULL REFERENCES hs_data_rollup_jobs(id) ON DELETE CASCADE, ordinal integer NOT NULL CHECK(ordinal>=0), record_id uuid NOT NULL,
 PRIMARY KEY(job_id,ordinal), UNIQUE(job_id,record_id)
);
CREATE TABLE IF NOT EXISTS hs_data_rollup_job_commands (
 tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id), actor_id text NOT NULL REFERENCES hs_users(id), operation_id uuid NOT NULL,
 job_id uuid NOT NULL REFERENCES hs_data_rollup_jobs(id) ON DELETE CASCADE, kind text NOT NULL CHECK(kind IN('start','resume','cancel')),
 request_hash text NOT NULL, response jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,actor_id,operation_id)
);

CREATE OR REPLACE FUNCTION hs_data_rollup_policy_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 UPDATE hs_data_tenants SET policy_version=policy_version+1
 WHERE id=COALESCE(NEW.tenant_id,OLD.tenant_id)
 AND EXISTS(SELECT 1 FROM hs_data_rollup_jobs j WHERE j.tenant_id=COALESCE(NEW.tenant_id,OLD.tenant_id) AND j.state IN('pending','running','completed') AND j.expires_at>clock_timestamp());
 RETURN COALESCE(NEW,OLD);
END $$;
DROP TRIGGER IF EXISTS hs_data_rollup_collection_policy ON hs_data_collection_grants;
CREATE TRIGGER hs_data_rollup_collection_policy AFTER INSERT OR UPDATE OR DELETE ON hs_data_collection_grants
 FOR EACH ROW EXECUTE FUNCTION hs_data_rollup_policy_changed();
DROP TRIGGER IF EXISTS hs_data_rollup_record_policy ON hs_data_record_grants;
CREATE TRIGGER hs_data_rollup_record_policy AFTER INSERT OR UPDATE OR DELETE ON hs_data_record_grants
 FOR EACH ROW EXECUTE FUNCTION hs_data_rollup_policy_changed();
DROP TRIGGER IF EXISTS hs_data_rollup_field_policy ON hs_data_field_permissions;
CREATE TRIGGER hs_data_rollup_field_policy AFTER INSERT OR UPDATE OR DELETE ON hs_data_field_permissions
 FOR EACH ROW EXECUTE FUNCTION hs_data_rollup_policy_changed();
