-- History is retained independently of Trash. No purge/retention job is enabled.
CREATE TABLE IF NOT EXISTS hs_data_history_cursors (
 token_hash text PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),workspace_id text NOT NULL REFERENCES hs_workspaces(id),actor_id text NOT NULL REFERENCES hs_users(id),record_id uuid NOT NULL,scope_hash text NOT NULL,anchor_version integer NOT NULL,last_version integer NOT NULL,expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '5 minutes',FOREIGN KEY(tenant_id,record_id) REFERENCES hs_data_records(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS hs_data_value_restore_previews (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),workspace_id text NOT NULL REFERENCES hs_workspaces(id),actor_id text NOT NULL REFERENCES hs_users(id),record_id uuid NOT NULL,event_id uuid NOT NULL REFERENCES hs_data_events(id),side text NOT NULL CHECK(side IN('before','after')),field_keys jsonb NOT NULL,record_version integer NOT NULL,schema_version integer NOT NULL,policy_version integer NOT NULL,authority_revision text NOT NULL,review_hash text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '10 minutes',FOREIGN KEY(tenant_id,record_id) REFERENCES hs_data_records(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS hs_data_value_restores (
 tenant_id uuid NOT NULL,actor_id text NOT NULL,operation_id uuid NOT NULL,record_id uuid NOT NULL,event_id uuid NOT NULL REFERENCES hs_data_events(id),side text NOT NULL,field_keys jsonb NOT NULL,applied_version integer NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(tenant_id,actor_id,operation_id),FOREIGN KEY(tenant_id,record_id) REFERENCES hs_data_records(tenant_id,id)
);
CREATE OR REPLACE FUNCTION hs_data_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Protected record history and restore provenance are immutable'; END $$;
DROP TRIGGER IF EXISTS hs_data_history_immutable ON hs_data_events;
CREATE TRIGGER hs_data_history_immutable BEFORE UPDATE OR DELETE ON hs_data_events FOR EACH ROW EXECUTE FUNCTION hs_data_history_immutable();
DROP TRIGGER IF EXISTS hs_data_restore_provenance_immutable ON hs_data_value_restores;
CREATE TRIGGER hs_data_restore_provenance_immutable BEFORE UPDATE OR DELETE ON hs_data_value_restores FOR EACH ROW EXECUTE FUNCTION hs_data_history_immutable();
