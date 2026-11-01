-- HOLY-61 versions hang off hs_linked_files.id (HOLY-60 stable file identity).
-- Spec shape hs_record_attachments(id, record_id, field_id, current_version_id) maps here:
--   id = hs_linked_files.id
--   record association = hs_document_record_links (one file, many records)
--   field_id = hs_linked_files.field_key (optional attachment field key)
--   current_version_id = hs_linked_files.current_version_id
-- There is no parallel hs_record_attachments table. A second identity would split
-- the chain so a new version would not show on every linked record.
-- blob_key is server-generated and is never accepted from a client.

ALTER TABLE hs_linked_files ADD COLUMN IF NOT EXISTS field_key text;
ALTER TABLE hs_linked_files ADD COLUMN IF NOT EXISTS current_version_id uuid;
ALTER TABLE hs_linked_files DROP CONSTRAINT IF EXISTS hs_linked_files_field_key_len;
ALTER TABLE hs_linked_files ADD CONSTRAINT hs_linked_files_field_key_len CHECK (field_key IS NULL OR char_length(field_key) BETWEEN 1 AND 100);

CREATE TABLE IF NOT EXISTS hs_attachment_versions (
 id uuid PRIMARY KEY,
 file_id uuid NOT NULL,
 workspace_id text NOT NULL REFERENCES hs_workspaces(id),
 tenant_id uuid NOT NULL,
 version_no integer NOT NULL CHECK (version_no > 0),
 blob_key uuid NOT NULL UNIQUE,
 checksum text NOT NULL CHECK (checksum ~ '^[a-f0-9]{64}$'),
 size bigint NOT NULL CHECK (size > 0 AND size <= 50000000),
 mime text NOT NULL,
 name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 240),
 scan_status text NOT NULL CHECK (scan_status = 'clean'),
 note text CHECK (note IS NULL OR char_length(note) <= 500),
 uploader_id text NOT NULL REFERENCES hs_users(id),
 restored_from integer,
 deleted_at timestamptz,
 deleted_by text REFERENCES hs_users(id),
 delete_reason text CHECK (delete_reason IS NULL OR char_length(delete_reason) <= 500),
 purge_after timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 scanned_at timestamptz,
 UNIQUE (file_id, version_no),
 FOREIGN KEY (tenant_id, file_id) REFERENCES hs_linked_files(tenant_id, id)
);
CREATE INDEX IF NOT EXISTS hs_attachment_versions_file ON hs_attachment_versions(file_id, version_no DESC);
CREATE INDEX IF NOT EXISTS hs_attachment_versions_deleted ON hs_attachment_versions(purge_after) WHERE deleted_at IS NOT NULL;

ALTER TABLE hs_linked_files DROP CONSTRAINT IF EXISTS hs_linked_files_current_version_fk;
ALTER TABLE hs_linked_files ADD CONSTRAINT hs_linked_files_current_version_fk FOREIGN KEY (current_version_id) REFERENCES hs_attachment_versions(id);

CREATE TABLE IF NOT EXISTS hs_attachment_reservations (
 id uuid PRIMARY KEY,
 file_id uuid NOT NULL,
 workspace_id text NOT NULL REFERENCES hs_workspaces(id),
 tenant_id uuid NOT NULL,
 actor_id text NOT NULL REFERENCES hs_users(id),
 operation_id uuid NOT NULL,
 record_id uuid NOT NULL,
 name text NOT NULL,
 mime text NOT NULL,
 size bigint NOT NULL CHECK (size > 0 AND size <= 50000000),
 note text,
 blob_key uuid NOT NULL UNIQUE,
 checksum text,
 state text NOT NULL CHECK (state IN ('reserved','scanning','consumed','released')),
 release_reason text,
 expires_at timestamptz NOT NULL DEFAULT clock_timestamp() + interval '30 minutes',
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE (workspace_id, actor_id, operation_id),
 FOREIGN KEY (tenant_id, file_id) REFERENCES hs_linked_files(tenant_id, id)
);

CREATE TABLE IF NOT EXISTS hs_attachment_download_tokens (
 token_hash text PRIMARY KEY,
 version_id uuid NOT NULL REFERENCES hs_attachment_versions(id),
 workspace_id text NOT NULL REFERENCES hs_workspaces(id),
 actor_id text NOT NULL REFERENCES hs_users(id),
 record_id uuid NOT NULL,
 session_key text NOT NULL,
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK (expires_at <= created_at + interval '5 minutes')
);
CREATE INDEX IF NOT EXISTS hs_attachment_download_tokens_expiry ON hs_attachment_download_tokens(expires_at);

CREATE TABLE IF NOT EXISTS hs_attachment_pins (
 id uuid PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES hs_workspaces(id),
 tenant_id uuid NOT NULL,
 file_id uuid NOT NULL,
 record_id uuid NOT NULL,
 source_kind text NOT NULL CHECK (source_kind IN ('page','record')),
 source_id text NOT NULL CHECK (char_length(source_id) BETWEEN 1 AND 100),
 pinned_version_no integer,
 created_by text NOT NULL REFERENCES hs_users(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY (tenant_id, file_id) REFERENCES hs_linked_files(tenant_id, id),
 FOREIGN KEY (tenant_id, record_id) REFERENCES hs_data_records(tenant_id, id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS hs_attachment_pins_current ON hs_attachment_pins(workspace_id, source_kind, source_id, file_id) WHERE pinned_version_no IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS hs_attachment_pins_version ON hs_attachment_pins(workspace_id, source_kind, source_id, file_id, pinned_version_no) WHERE pinned_version_no IS NOT NULL;

CREATE TABLE IF NOT EXISTS hs_attachment_operations (
 workspace_id text NOT NULL,
 actor_id text NOT NULL REFERENCES hs_users(id),
 operation_id uuid NOT NULL,
 request_hash text NOT NULL,
 kind text NOT NULL,
 result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY (workspace_id, actor_id, operation_id)
);

CREATE OR REPLACE FUNCTION hs_attachment_version_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'DELETE' THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'attachment versions are retained'; END IF;
 IF NEW.file_id IS DISTINCT FROM OLD.file_id
    OR NEW.version_no IS DISTINCT FROM OLD.version_no
    OR NEW.blob_key IS DISTINCT FROM OLD.blob_key
    OR NEW.checksum IS DISTINCT FROM OLD.checksum
    OR NEW.size IS DISTINCT FROM OLD.size
    OR NEW.mime IS DISTINCT FROM OLD.mime
    OR NEW.scan_status IS DISTINCT FROM OLD.scan_status
    OR NEW.uploader_id IS DISTINCT FROM OLD.uploader_id
    OR NEW.name IS DISTINCT FROM OLD.name
    OR NEW.note IS DISTINCT FROM OLD.note
    OR NEW.restored_from IS DISTINCT FROM OLD.restored_from
 THEN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'attachment version bytes are immutable'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS hs_attachment_version_guard ON hs_attachment_versions;
CREATE TRIGGER hs_attachment_version_guard BEFORE UPDATE OR DELETE ON hs_attachment_versions FOR EACH ROW EXECUTE FUNCTION hs_attachment_version_guard();
