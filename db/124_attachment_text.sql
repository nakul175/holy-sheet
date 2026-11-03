-- HOLY-98 attachment text search and OCR.
-- Classical in-boundary extraction only. These rows do not grant access and do not alter source bytes.
-- Re-running this file is safe.

CREATE TABLE IF NOT EXISTS hs_attachment_text_managers (
  workspace_id text NOT NULL REFERENCES hs_workspaces(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES hs_users(id),
  granted_by text NOT NULL REFERENCES hs_users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE IF NOT EXISTS hs_attachment_text_config (
  workspace_id text PRIMARY KEY REFERENCES hs_workspaces(id) ON DELETE CASCADE,
  language text NOT NULL DEFAULT 'en' CHECK (language IN ('en')),
  enabled boolean NOT NULL DEFAULT true,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS hs_attachment_text_config_revisions (
  workspace_id text NOT NULL REFERENCES hs_workspaces(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  language text NOT NULL,
  enabled boolean NOT NULL,
  actor_id text NOT NULL REFERENCES hs_users(id),
  operation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, version)
);

CREATE TABLE IF NOT EXISTS hs_attachment_text_drafts (
  workspace_id text NOT NULL REFERENCES hs_workspaces(id) ON DELETE CASCADE,
  actor_id text NOT NULL REFERENCES hs_users(id),
  base_version integer NOT NULL CHECK (base_version >= 0),
  language text NOT NULL CHECK (language IN ('en')),
  enabled boolean NOT NULL,
  operation_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, actor_id)
);

CREATE TABLE IF NOT EXISTS hs_attachment_text_indexes (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES hs_workspaces(id),
  tenant_id uuid NOT NULL,
  file_id uuid NOT NULL,
  version_id uuid NOT NULL REFERENCES hs_attachment_versions(id),
  version_no integer NOT NULL CHECK (version_no > 0),
  checksum text NOT NULL,
  mime text NOT NULL,
  language text NOT NULL,
  status text NOT NULL CHECK (status IN ('extracted','ocr','ocr-error','unsupported','oversize','page-limit','failed','empty','disabled')),
  page_count integer NOT NULL CHECK (page_count >= 0 AND page_count <= 500),
  ocr_error_count integer NOT NULL DEFAULT 0 CHECK (ocr_error_count >= 0),
  failure text CHECK (failure IS NULL OR char_length(failure) <= 300),
  attempts integer NOT NULL DEFAULT 1 CHECK (attempts BETWEEN 1 AND 5),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  indexed_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, version_id)
);
CREATE INDEX IF NOT EXISTS hs_attachment_text_indexes_file ON hs_attachment_text_indexes (tenant_id, file_id);

CREATE TABLE IF NOT EXISTS hs_attachment_text_pages (
  index_id uuid NOT NULL REFERENCES hs_attachment_text_indexes(id) ON DELETE CASCADE,
  page_no integer NOT NULL CHECK (page_no BETWEEN 1 AND 500),
  text text NOT NULL CHECK (char_length(text) <= 8000),
  recognition text NOT NULL CHECK (recognition IN ('text','ocr')),
  ocr_errors text NOT NULL DEFAULT '' CHECK (char_length(ocr_errors) <= 1000),
  PRIMARY KEY (index_id, page_no)
);

CREATE TABLE IF NOT EXISTS hs_attachment_text_operations (
  actor_id text NOT NULL REFERENCES hs_users(id),
  operation_id uuid NOT NULL,
  request_hash text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (actor_id, operation_id)
);
