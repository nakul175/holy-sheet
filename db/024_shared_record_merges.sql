-- Durable old-ID aliases; no live app/reference resolver is activated.
ALTER TABLE hs_data_records ADD COLUMN IF NOT EXISTS merged_into_id uuid;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='hs_data_merge_target' AND conrelid='hs_data_records'::regclass) THEN
  ALTER TABLE hs_data_records ADD CONSTRAINT hs_data_merge_target FOREIGN KEY(tenant_id,merged_into_id,collection) REFERENCES hs_data_records(tenant_id,id,collection) DEFERRABLE INITIALLY DEFERRED;
 END IF;
END $$;
CREATE INDEX IF NOT EXISTS hs_data_merge_alias ON hs_data_records(tenant_id,merged_into_id) WHERE merged_into_id IS NOT NULL;
CREATE OR REPLACE FUNCTION hs_data_merge_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='UPDATE' AND OLD.merged_into_id IS NOT NULL AND NEW.merged_into_id IS DISTINCT FROM OLD.merged_into_id THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Merged record aliases are immutable'; END IF;
 IF NEW.merged_into_id IS NOT NULL THEN
  IF NEW.merged_into_id=NEW.id OR NEW.state<>'archived' OR NOT EXISTS(SELECT 1 FROM hs_data_records r WHERE r.tenant_id=NEW.tenant_id AND r.id=NEW.merged_into_id AND r.collection=NEW.collection AND r.state='active' AND r.merged_into_id IS NULL) THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Merge target must be an active same-type tenant record'; END IF;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS hs_data_merge_guard ON hs_data_records;
CREATE TRIGGER hs_data_merge_guard BEFORE INSERT OR UPDATE ON hs_data_records FOR EACH ROW EXECUTE FUNCTION hs_data_merge_guard();
CREATE TABLE IF NOT EXISTS hs_data_merge_previews (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),workspace_id text NOT NULL REFERENCES hs_workspaces(id),
 actor_id text NOT NULL REFERENCES hs_users(id),source_id uuid NOT NULL REFERENCES hs_data_records(id),survivor_id uuid NOT NULL REFERENCES hs_data_records(id),
 input jsonb NOT NULL,review_hash text NOT NULL,authority_revision text NOT NULL,consumer_revision text,
 schema_version integer NOT NULL,policy_version integer NOT NULL,data_revision bigint NOT NULL,
 blocked boolean NOT NULL,expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '5 minutes'
);
CREATE TABLE IF NOT EXISTS hs_data_merges (
 tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),operation_id uuid NOT NULL,actor_id text NOT NULL REFERENCES hs_users(id),
 source_id uuid NOT NULL REFERENCES hs_data_records(id),survivor_id uuid NOT NULL REFERENCES hs_data_records(id),
 source_version integer NOT NULL,survivor_version integer NOT NULL,consumer_revision text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,actor_id,operation_id),UNIQUE(tenant_id,source_id)
);
CREATE OR REPLACE FUNCTION hs_data_merge_provenance_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Merge provenance is immutable'; END $$;
DROP TRIGGER IF EXISTS hs_data_merge_provenance_immutable ON hs_data_merges;
CREATE TRIGGER hs_data_merge_provenance_immutable BEFORE UPDATE OR DELETE ON hs_data_merges FOR EACH ROW EXECUTE FUNCTION hs_data_merge_provenance_immutable();
