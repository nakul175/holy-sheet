CREATE TABLE IF NOT EXISTS hs_data_export_jobs (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),workspace_id text NOT NULL REFERENCES hs_workspaces(id),actor_id text NOT NULL REFERENCES hs_users(id),
 collection text NOT NULL,request_hash text NOT NULL,scope jsonb NOT NULL,format text NOT NULL CHECK(format IN ('csv','xlsx')),
 schema_version integer NOT NULL,policy_version integer NOT NULL,snapshot jsonb,row_count integer NOT NULL CHECK(row_count BETWEEN 1 AND 10000),
 warnings jsonb NOT NULL,review_hash text NOT NULL,state text NOT NULL DEFAULT 'ready' CHECK(state IN ('ready','cancelled','expired')),
 first_issued_at timestamptz,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '15 minutes',
 FOREIGN KEY(tenant_id,collection) REFERENCES hs_data_collections(tenant_id,id)
);
CREATE INDEX IF NOT EXISTS hs_data_export_actor ON hs_data_export_jobs(tenant_id,actor_id,expires_at);
CREATE OR REPLACE FUNCTION hs_data_export_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.id<>OLD.id OR NEW.tenant_id<>OLD.tenant_id OR NEW.workspace_id<>OLD.workspace_id OR NEW.actor_id<>OLD.actor_id OR NEW.collection<>OLD.collection OR NEW.request_hash<>OLD.request_hash OR NEW.scope<>OLD.scope OR NEW.format<>OLD.format OR NEW.schema_version<>OLD.schema_version OR NEW.policy_version<>OLD.policy_version OR NEW.row_count<>OLD.row_count OR NEW.warnings<>OLD.warnings OR NEW.review_hash<>OLD.review_hash OR (OLD.first_issued_at IS NOT NULL AND NEW.first_issued_at IS DISTINCT FROM OLD.first_issued_at) OR NEW.created_at<>OLD.created_at OR NEW.expires_at>OLD.expires_at OR (NEW.snapshot IS DISTINCT FROM OLD.snapshot AND NOT(NEW.snapshot IS NULL AND NEW.state IN ('cancelled','expired'))) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Export snapshot and identity are immutable'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS hs_data_export_identity_guard ON hs_data_export_jobs;
CREATE TRIGGER hs_data_export_identity_guard BEFORE UPDATE ON hs_data_export_jobs FOR EACH ROW EXECUTE FUNCTION hs_data_export_identity_guard();
