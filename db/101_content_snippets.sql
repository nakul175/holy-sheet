-- HOLY-65 approved reusable snippets.
-- Bodies live in hs_snippet_versions and, once approved, on the HOLY-66 anchor
-- (hs_synced_blocks.kind = 'snippet'). Page JSON stores placement ids only.
-- Idempotent: safe to replay.
ALTER TABLE hs_synced_blocks ALTER COLUMN source_page_id DROP NOT NULL;

CREATE TABLE IF NOT EXISTS hs_snippet_roles (
  space_id text NOT NULL REFERENCES hs_spaces(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES hs_users(id),
  role text NOT NULL CHECK (role IN ('manager', 'approver', 'reviewer')),
  granted_by text NOT NULL REFERENCES hs_users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (space_id, user_id, role)
);

CREATE TABLE IF NOT EXISTS hs_snippets (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES hs_workspaces(id),
  space_id text NOT NULL REFERENCES hs_spaces(id),
  title text NOT NULL,
  synced_id text NOT NULL UNIQUE REFERENCES hs_synced_blocks(id),
  created_by text NOT NULL REFERENCES hs_users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  retired_at timestamptz,
  retired_by text REFERENCES hs_users(id),
  deleted_at timestamptz,
  deleted_by text REFERENCES hs_users(id),
  purge_after timestamptz
);
ALTER TABLE hs_snippets ADD COLUMN IF NOT EXISTS retired_at timestamptz;
ALTER TABLE hs_snippets ADD COLUMN IF NOT EXISTS retired_by text REFERENCES hs_users(id);
ALTER TABLE hs_snippets ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE hs_snippets ADD COLUMN IF NOT EXISTS deleted_by text REFERENCES hs_users(id);
ALTER TABLE hs_snippets ADD COLUMN IF NOT EXISTS purge_after timestamptz;
CREATE INDEX IF NOT EXISTS hs_snippets_space ON hs_snippets(workspace_id, space_id);

CREATE TABLE IF NOT EXISTS hs_snippet_versions (
  id text PRIMARY KEY,
  snippet_id text NOT NULL REFERENCES hs_snippets(id) ON DELETE CASCADE,
  version_number integer NOT NULL CHECK (version_number > 0),
  state text NOT NULL CHECK (state IN ('draft', 'in_review', 'approved')),
  content jsonb NOT NULL,
  created_by text NOT NULL REFERENCES hs_users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  submitted_by text REFERENCES hs_users(id),
  submitted_at timestamptz,
  approved_by text REFERENCES hs_users(id),
  approved_at timestamptz,
  approval_note text,
  UNIQUE (snippet_id, version_number)
);
CREATE INDEX IF NOT EXISTS hs_snippet_versions_snippet ON hs_snippet_versions(snippet_id, version_number);

CREATE TABLE IF NOT EXISTS hs_snippet_placements (
  page_id text NOT NULL REFERENCES hs_pages(id) ON DELETE CASCADE,
  block_id text NOT NULL,
  snippet_id text NOT NULL REFERENCES hs_snippets(id),
  pin_version integer,
  created_by text NOT NULL REFERENCES hs_users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (page_id, block_id)
);
CREATE INDEX IF NOT EXISTS hs_snippet_placements_snippet ON hs_snippet_placements(snippet_id);

CREATE TABLE IF NOT EXISTS hs_snippet_operations (
  scope_id text NOT NULL,
  operation_id uuid NOT NULL,
  actor_id text NOT NULL REFERENCES hs_users(id),
  request_hash text NOT NULL,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (scope_id, operation_id)
);
