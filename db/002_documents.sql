-- Additive HOLY-3 schema. Legacy tables are retained for migration/rollback.
CREATE TABLE IF NOT EXISTS hs_users (id text PRIMARY KEY, name text NOT NULL);
CREATE TABLE IF NOT EXISTS hs_workspaces (id text PRIMARY KEY, name text NOT NULL);
CREATE TABLE IF NOT EXISTS hs_members (workspace_id text REFERENCES hs_workspaces(id), user_id text REFERENCES hs_users(id), active boolean NOT NULL DEFAULT true, PRIMARY KEY(workspace_id,user_id));
CREATE TABLE IF NOT EXISTS hs_spaces (id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES hs_workspaces(id), name text NOT NULL, UNIQUE(workspace_id,name));
CREATE TABLE IF NOT EXISTS hs_pages (
 id text PRIMARY KEY, workspace_id text NOT NULL REFERENCES hs_workspaces(id), space_id text NOT NULL REFERENCES hs_spaces(id),
 parent_id text REFERENCES hs_pages(id), owner_id text NOT NULL REFERENCES hs_users(id), title text NOT NULL,
 visibility text NOT NULL DEFAULT 'private' CHECK(visibility IN ('private','space')), version integer NOT NULL DEFAULT 1,
 schema_version integer NOT NULL DEFAULT 2, updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz
);
CREATE TABLE IF NOT EXISTS hs_grants (page_id text REFERENCES hs_pages(id), subject text NOT NULL, role text NOT NULL CHECK(role IN ('viewer','editor')), PRIMARY KEY(page_id,subject));
CREATE TABLE IF NOT EXISTS hs_blocks (id text PRIMARY KEY, page_id text NOT NULL REFERENCES hs_pages(id), parent_id text, position integer NOT NULL, type text NOT NULL, node jsonb NOT NULL, version integer NOT NULL DEFAULT 1, UNIQUE(page_id,parent_id,position));
CREATE INDEX IF NOT EXISTS hs_blocks_page ON hs_blocks(page_id,parent_id,position);
CREATE TABLE IF NOT EXISTS hs_revisions (page_id text REFERENCES hs_pages(id), version integer NOT NULL, title text NOT NULL, document jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(page_id,version));
CREATE TABLE IF NOT EXISTS hs_operations (page_id text REFERENCES hs_pages(id), operation_id uuid NOT NULL, actor_id text NOT NULL REFERENCES hs_users(id), request_hash text NOT NULL, version integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(page_id,operation_id));
CREATE TABLE IF NOT EXISTS hs_media (
 id uuid PRIMARY KEY, page_id text NOT NULL REFERENCES hs_pages(id), uploader_id text NOT NULL REFERENCES hs_users(id), operation_id uuid NOT NULL,
 name text NOT NULL, mime text NOT NULL, size bigint NOT NULL, object_key text NOT NULL, state text NOT NULL,
 sha256 text, created_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz, replaced_id uuid,
 UNIQUE(page_id,operation_id)
);
CREATE INDEX IF NOT EXISTS hs_media_page ON hs_media(page_id,state);
ALTER TABLE hs_media ADD COLUMN IF NOT EXISTS scanned_at timestamptz;
CREATE TABLE IF NOT EXISTS hs_drafts (
 id uuid PRIMARY KEY, page_id text NOT NULL REFERENCES hs_pages(id), user_id text NOT NULL REFERENCES hs_users(id),
 wrapped_key text NOT NULL, attachment_ids jsonb NOT NULL DEFAULT '[]', base_version integer NOT NULL,
 expires_at timestamptz NOT NULL, updated_at timestamptz NOT NULL DEFAULT now()
);
