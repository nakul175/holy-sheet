-- HOLY-60: one page or file linked to many records. A row is a link, not a copy.
-- File bytes stay on hs_linked_files. HOLY-61 versions should hang off hs_linked_files.id
-- so every record link sees the same version chain. This migration does not create versions.
CREATE TABLE IF NOT EXISTS hs_linked_files (
 id uuid PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES hs_workspaces(id),
 tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
 name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 240),
 owner_id text NOT NULL REFERENCES hs_users(id),
 media_id uuid REFERENCES hs_media(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 deleted_at timestamptz,
 unlinked_at timestamptz,
 purge_after timestamptz,
 UNIQUE (tenant_id, id)
);
CREATE INDEX IF NOT EXISTS hs_linked_files_unlinked ON hs_linked_files(workspace_id, purge_after) WHERE unlinked_at IS NOT NULL AND deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS hs_document_record_links (
 id uuid PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES hs_workspaces(id),
 tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
 doc_type text NOT NULL CHECK (doc_type IN ('page', 'file')),
 doc_id text NOT NULL,
 record_id uuid NOT NULL,
 created_by text NOT NULL REFERENCES hs_users(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE (workspace_id, doc_type, doc_id, record_id),
 FOREIGN KEY (tenant_id, record_id) REFERENCES hs_data_records(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS hs_document_record_links_record ON hs_document_record_links(workspace_id, record_id, created_at DESC, id);
CREATE INDEX IF NOT EXISTS hs_document_record_links_doc ON hs_document_record_links(workspace_id, doc_type, doc_id);

CREATE TABLE IF NOT EXISTS hs_document_record_link_operations (
 workspace_id text NOT NULL,
 actor_id text NOT NULL REFERENCES hs_users(id),
 operation_id uuid NOT NULL,
 request_hash text NOT NULL,
 kind text NOT NULL,
 result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY (workspace_id, actor_id, operation_id)
);
