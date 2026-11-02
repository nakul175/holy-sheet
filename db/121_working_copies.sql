-- HOLY-95 private document working copies.
-- A copy is a separate page owned by its creator. Grants, workspace role,
-- and publishing review on the original are not copied and are not bypassed.
-- Re-running this file is safe.

CREATE TABLE IF NOT EXISTS hs_working_copies (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES hs_workspaces(id),
  copy_page_id text NOT NULL UNIQUE REFERENCES hs_pages(id),
  source_page_id text NOT NULL REFERENCES hs_pages(id),
  owner_id text NOT NULL REFERENCES hs_users(id),
  base_version integer NOT NULL CHECK (base_version > 0),
  captured_page_version integer NOT NULL CHECK (captured_page_version > 0),
  base_title text NOT NULL,
  base_document jsonb NOT NULL,
  block_map jsonb NOT NULL,
  media_map jsonb NOT NULL,
  redacted_blocks jsonb NOT NULL DEFAULT '[]'::jsonb,
  hidden_fields jsonb NOT NULL DEFAULT '[]'::jsonb,
  choices jsonb NOT NULL DEFAULT '{}'::jsonb,
  state text NOT NULL CHECK (state IN ('open', 'applied', 'abandoned', 'archived')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  applied_source_version integer,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CHECK (copy_page_id <> source_page_id)
);

CREATE INDEX IF NOT EXISTS hs_working_copies_source ON hs_working_copies(source_page_id, owner_id);
CREATE INDEX IF NOT EXISTS hs_working_copies_owner ON hs_working_copies(owner_id, state);

CREATE TABLE IF NOT EXISTS hs_working_copy_operations (
  actor_id text NOT NULL REFERENCES hs_users(id),
  operation_id uuid NOT NULL,
  request_hash text NOT NULL,
  copy_id uuid REFERENCES hs_working_copies(id),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (actor_id, operation_id)
);
