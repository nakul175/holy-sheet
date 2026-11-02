-- HOLY-92 / HS N47. Directory visibility, archive, and resumable page-tree migration.
-- Existing spaces stay open so current workspace navigation is unchanged.
ALTER TABLE hs_spaces ADD COLUMN IF NOT EXISTS directory_visibility text NOT NULL DEFAULT 'open';
ALTER TABLE hs_spaces DROP CONSTRAINT IF EXISTS hs_spaces_directory_visibility_check;
ALTER TABLE hs_spaces ADD CONSTRAINT hs_spaces_directory_visibility_check CHECK (directory_visibility IN ('open', 'discoverable', 'private'));
ALTER TABLE hs_spaces ADD COLUMN IF NOT EXISTS archived_at timestamptz;
CREATE INDEX IF NOT EXISTS hs_spaces_directory ON hs_spaces (workspace_id, directory_visibility) WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS hs_space_access_requests (
  id uuid PRIMARY KEY,
  space_id text NOT NULL REFERENCES hs_spaces(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES hs_users(id),
  workspace_id text NOT NULL REFERENCES hs_workspaces(id),
  state text NOT NULL CHECK (state IN ('pending', 'approved', 'rejected')),
  operation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (space_id, operation_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS hs_space_access_requests_pending ON hs_space_access_requests (space_id, user_id) WHERE state = 'pending';

CREATE TABLE IF NOT EXISTS hs_space_directory_operations (
  workspace_id text NOT NULL REFERENCES hs_workspaces(id),
  operation_id uuid NOT NULL,
  actor_id text NOT NULL REFERENCES hs_users(id),
  request_hash text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, operation_id)
);

CREATE TABLE IF NOT EXISTS hs_space_migration_jobs (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES hs_workspaces(id),
  operation_id uuid NOT NULL,
  actor_id text NOT NULL REFERENCES hs_users(id),
  root_page_id text NOT NULL,
  source_space_id text NOT NULL,
  target_space_id text NOT NULL,
  parent_id text,
  status text NOT NULL CHECK (status IN ('running', 'halted', 'completed')),
  request_hash text NOT NULL,
  preview jsonb NOT NULL,
  page_ids jsonb NOT NULL,
  tree_version integer NOT NULL,
  cursor_index integer NOT NULL DEFAULT 0,
  halt_reason text,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (workspace_id, operation_id)
);

CREATE TABLE IF NOT EXISTS hs_space_migration_steps (
  job_id uuid NOT NULL REFERENCES hs_space_migration_jobs(id) ON DELETE CASCADE,
  operation_id uuid NOT NULL,
  actor_id text NOT NULL REFERENCES hs_users(id),
  request_hash text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (job_id, operation_id)
);

CREATE TABLE IF NOT EXISTS hs_space_page_redirects (
  workspace_id text NOT NULL REFERENCES hs_workspaces(id),
  page_id text NOT NULL REFERENCES hs_pages(id),
  from_space_id text NOT NULL,
  to_space_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, page_id, from_space_id)
);
