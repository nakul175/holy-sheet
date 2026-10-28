-- No purge executable or scheduler. Retention is separately reviewed before use.
CREATE TABLE IF NOT EXISTS hs_data_retention_policies (
 tenant_id uuid PRIMARY KEY REFERENCES hs_data_tenants(id),version integer NOT NULL DEFAULT 1,
 trash_days integer NOT NULL DEFAULT 30 CHECK(trash_days=30),review_reference text NOT NULL CHECK(length(btrim(review_reference)) BETWEEN 1 AND 500)
);
ALTER TABLE hs_data_records ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE hs_data_records ADD COLUMN IF NOT EXISTS trash_deadline timestamptz;
ALTER TABLE hs_data_records ADD COLUMN IF NOT EXISTS deleted_by text REFERENCES hs_users(id);
ALTER TABLE hs_data_records ADD COLUMN IF NOT EXISTS before_trash_state text CHECK(before_trash_state IN ('active','archived'));
ALTER TABLE hs_data_records ADD COLUMN IF NOT EXISTS retention_hold boolean NOT NULL DEFAULT false;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='hs_data_trash_metadata' AND conrelid='hs_data_records'::regclass) THEN
  ALTER TABLE hs_data_records ADD CONSTRAINT hs_data_trash_metadata CHECK(
   (state='trashed' AND deleted_at IS NOT NULL AND trash_deadline IS NOT NULL AND trash_deadline=deleted_at+interval '30 days' AND deleted_by IS NOT NULL AND before_trash_state IS NOT NULL)
   OR (state<>'trashed' AND deleted_at IS NULL AND trash_deadline IS NULL AND deleted_by IS NULL AND before_trash_state IS NULL)
  );
 END IF;
END $$;
CREATE INDEX IF NOT EXISTS hs_data_record_trash_deadline ON hs_data_records(tenant_id,collection,trash_deadline,id) WHERE(state='trashed');
CREATE TABLE IF NOT EXISTS hs_data_delete_previews (
 id uuid PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),workspace_id text NOT NULL REFERENCES hs_workspaces(id),
 actor_id text NOT NULL REFERENCES hs_users(id),record_id uuid NOT NULL REFERENCES hs_data_records(id),
 record_version integer NOT NULL,schema_version integer NOT NULL,policy_version integer NOT NULL,retention_version integer NOT NULL,
 data_revision bigint NOT NULL,authority_revision text NOT NULL,review_hash text NOT NULL,
 blocked boolean NOT NULL,expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '5 minutes'
);
CREATE INDEX IF NOT EXISTS hs_data_delete_preview_expiry ON hs_data_delete_previews(expires_at);
CREATE TABLE IF NOT EXISTS hs_data_trash_cursors (
 token_hash text PRIMARY KEY,tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),workspace_id text NOT NULL REFERENCES hs_workspaces(id),actor_id text NOT NULL REFERENCES hs_users(id),
 scope_hash text NOT NULL,last_time timestamptz NOT NULL,last_id uuid NOT NULL,
 expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '5 minutes'
);
CREATE INDEX IF NOT EXISTS hs_data_trash_cursor_expiry ON hs_data_trash_cursors(expires_at);
