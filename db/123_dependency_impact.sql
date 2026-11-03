-- HOLY-97 document dependency impact.
-- An edge records explicit link, template, snippet, or synced-source provenance.
-- It does not copy page bodies, rewrite dependents, or grant access.
-- Re-running this file is safe.

CREATE TABLE IF NOT EXISTS hs_dependency_managers (
  workspace_id text NOT NULL REFERENCES hs_workspaces(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES hs_users(id),
  granted_by text NOT NULL REFERENCES hs_users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE IF NOT EXISTS hs_dependency_sources (
  workspace_id text NOT NULL REFERENCES hs_workspaces(id),
  kind text NOT NULL CHECK (kind IN ('link', 'template', 'snippet', 'synced-source')),
  source_id text NOT NULL,
  revision integer NOT NULL CHECK (revision > 0),
  material_digest text NOT NULL,
  state text NOT NULL DEFAULT 'active' CHECK (state IN ('active', 'retired', 'merged')),
  merged_into_id text,
  note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 2000),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, kind, source_id)
);

CREATE TABLE IF NOT EXISTS hs_dependency_edges (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES hs_workspaces(id),
  kind text NOT NULL CHECK (kind IN ('link', 'template', 'snippet', 'synced-source')),
  source_id text NOT NULL,
  source_revision integer NOT NULL CHECK (source_revision > 0),
  material_digest text NOT NULL,
  dependent_page_id text NOT NULL REFERENCES hs_pages(id),
  dependent_revision integer NOT NULL CHECK (dependent_revision > 0),
  reviewer_id text NOT NULL REFERENCES hs_users(id),
  review_state text NOT NULL DEFAULT 'current' CHECK (review_state IN ('current', 'needs_review', 'acknowledged')),
  review_reason text NOT NULL DEFAULT '' CHECK (char_length(review_reason) <= 500),
  acknowledged_source_revision integer,
  acknowledged_dependent_revision integer,
  acknowledged_at timestamptz,
  note text NOT NULL DEFAULT '' CHECK (char_length(note) <= 2000),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by text NOT NULL REFERENCES hs_users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (workspace_id, kind, source_id, dependent_page_id)
);
CREATE INDEX IF NOT EXISTS hs_dependency_edges_source ON hs_dependency_edges (workspace_id, kind, source_id);
CREATE INDEX IF NOT EXISTS hs_dependency_edges_dependent ON hs_dependency_edges (workspace_id, dependent_page_id);

CREATE TABLE IF NOT EXISTS hs_dependency_edge_revisions (
  edge_id uuid NOT NULL REFERENCES hs_dependency_edges(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  action text NOT NULL CHECK (action IN ('record', 'save', 'acknowledge', 'reassign', 'material', 'metadata', 'retire', 'merge')),
  source_revision integer NOT NULL,
  dependent_revision integer NOT NULL,
  reviewer_id text NOT NULL,
  review_state text NOT NULL,
  review_reason text NOT NULL,
  note text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_id text NOT NULL REFERENCES hs_users(id),
  operation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (edge_id, version)
);

CREATE TABLE IF NOT EXISTS hs_dependency_drafts (
  edge_id uuid NOT NULL REFERENCES hs_dependency_edges(id) ON DELETE CASCADE,
  actor_id text NOT NULL REFERENCES hs_users(id),
  base_version integer NOT NULL CHECK (base_version > 0),
  note text NOT NULL,
  reviewer_id text NOT NULL,
  operation_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (edge_id, actor_id)
);

CREATE TABLE IF NOT EXISTS hs_dependency_operations (
  actor_id text NOT NULL REFERENCES hs_users(id),
  operation_id uuid NOT NULL,
  request_hash text NOT NULL,
  edge_id uuid,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (actor_id, operation_id)
);
