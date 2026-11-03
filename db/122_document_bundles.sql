-- HOLY-96 reusable document bundles.
-- A bundle stores an ordered list of document/version references. It does not
-- copy page bodies, grants, or record values. Sharing a bundle does not grant
-- access to the referenced documents. Re-running this file is safe.

CREATE TABLE IF NOT EXISTS hs_document_bundle_managers (
  workspace_id text NOT NULL REFERENCES hs_workspaces(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES hs_users(id),
  granted_by text NOT NULL REFERENCES hs_users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE IF NOT EXISTS hs_document_bundles (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES hs_workspaces(id),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 100),
  description text NOT NULL DEFAULT '' CHECK (char_length(description) <= 2000),
  owner_id text NOT NULL REFERENCES hs_users(id),
  state text NOT NULL DEFAULT 'draft' CHECK (state IN ('draft', 'published', 'archived')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  members jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by text NOT NULL REFERENCES hs_users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  archived_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS hs_document_bundles_name
  ON hs_document_bundles (workspace_id, lower(btrim(name)))
  WHERE archived_at IS NULL;
CREATE INDEX IF NOT EXISTS hs_document_bundles_workspace
  ON hs_document_bundles (workspace_id, lower(btrim(name)), id)
  WHERE archived_at IS NULL;

CREATE TABLE IF NOT EXISTS hs_document_bundle_revisions (
  bundle_id uuid NOT NULL REFERENCES hs_document_bundles(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  action text NOT NULL CHECK (action IN ('create', 'save', 'publish', 'share', 'unshare', 'archive')),
  name text NOT NULL,
  description text NOT NULL,
  owner_id text NOT NULL,
  members jsonb NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_id text NOT NULL REFERENCES hs_users(id),
  operation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (bundle_id, version)
);

CREATE TABLE IF NOT EXISTS hs_document_bundle_publications (
  id uuid PRIMARY KEY,
  bundle_id uuid NOT NULL REFERENCES hs_document_bundles(id) ON DELETE CASCADE,
  publication_no integer NOT NULL CHECK (publication_no > 0),
  config_version integer NOT NULL CHECK (config_version > 0),
  name text NOT NULL,
  description text NOT NULL,
  owner_id text NOT NULL,
  snapshot jsonb NOT NULL,
  snapshot_hash text NOT NULL,
  published_by text NOT NULL REFERENCES hs_users(id),
  operation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (bundle_id, publication_no)
);
CREATE INDEX IF NOT EXISTS hs_document_bundle_publications_bundle
  ON hs_document_bundle_publications (bundle_id, publication_no DESC);

CREATE OR REPLACE FUNCTION hs_document_bundle_publication_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Published bundle packages are immutable'; END;
$$;
DROP TRIGGER IF EXISTS hs_document_bundle_publication_immutable ON hs_document_bundle_publications;
CREATE TRIGGER hs_document_bundle_publication_immutable
  BEFORE UPDATE OR DELETE ON hs_document_bundle_publications
  FOR EACH ROW EXECUTE FUNCTION hs_document_bundle_publication_immutable();

CREATE TABLE IF NOT EXISTS hs_document_bundle_grants (
  bundle_id uuid NOT NULL REFERENCES hs_document_bundles(id) ON DELETE CASCADE,
  subject text NOT NULL,
  role text NOT NULL CHECK (role IN ('viewer', 'editor')),
  PRIMARY KEY (bundle_id, subject)
);
CREATE INDEX IF NOT EXISTS hs_document_bundle_grants_subject ON hs_document_bundle_grants (subject);

CREATE TABLE IF NOT EXISTS hs_document_bundle_drafts (
  bundle_id uuid NOT NULL REFERENCES hs_document_bundles(id) ON DELETE CASCADE,
  actor_id text NOT NULL REFERENCES hs_users(id),
  base_version integer NOT NULL CHECK (base_version > 0),
  name text NOT NULL,
  description text NOT NULL,
  owner_id text NOT NULL,
  members jsonb NOT NULL,
  operation_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (bundle_id, actor_id)
);

CREATE TABLE IF NOT EXISTS hs_document_bundle_operations (
  actor_id text NOT NULL REFERENCES hs_users(id),
  operation_id uuid NOT NULL,
  request_hash text NOT NULL,
  bundle_id uuid,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (actor_id, operation_id)
);
