-- HOLY-88 stable published URLs. Extends HOLY-63: the snapshot is an immutable hs_revisions
-- row (revision_id), not a second document body. HOLY-63 review publications stay on /pages/{id}.
ALTER TABLE hs_spaces ADD COLUMN IF NOT EXISTS slug text;
ALTER TABLE hs_spaces DROP CONSTRAINT IF EXISTS hs_spaces_slug_check;
ALTER TABLE hs_spaces ADD CONSTRAINT hs_spaces_slug_check CHECK (slug IS NULL OR slug ~ '^[a-z0-9][a-z0-9-]{1,78}[a-z0-9]$');
CREATE UNIQUE INDEX IF NOT EXISTS hs_spaces_workspace_slug ON hs_spaces (workspace_id, slug) WHERE slug IS NOT NULL;

CREATE TABLE IF NOT EXISTS hs_published_versions (
  id uuid PRIMARY KEY,
  page_id text NOT NULL REFERENCES hs_pages(id),
  version_no integer NOT NULL CHECK (version_no > 0),
  revision_id text NOT NULL CHECK (char_length(revision_id) BETWEEN 3 AND 240),
  revision_version integer NOT NULL CHECK (revision_version > 0),
  published_by text NOT NULL REFERENCES hs_users(id),
  note text NOT NULL CHECK (char_length(note) BETWEEN 1 AND 500),
  freeze_values jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (page_id, version_no),
  FOREIGN KEY (page_id, revision_version) REFERENCES hs_revisions(page_id, version)
);
CREATE INDEX IF NOT EXISTS hs_published_versions_page ON hs_published_versions (page_id, version_no DESC);

CREATE TABLE IF NOT EXISTS hs_page_slugs (
  space_id text NOT NULL REFERENCES hs_spaces(id),
  slug text NOT NULL CHECK (slug ~ '^[a-z0-9][a-z0-9-]{1,78}[a-z0-9]$'),
  page_id text NOT NULL REFERENCES hs_pages(id),
  active boolean NOT NULL DEFAULT true,
  PRIMARY KEY (space_id, slug)
);
CREATE UNIQUE INDEX IF NOT EXISTS hs_page_slugs_one_active ON hs_page_slugs (page_id) WHERE active;

CREATE TABLE IF NOT EXISTS hs_slug_redirects (
  workspace_id text NOT NULL REFERENCES hs_workspaces(id),
  space_slug text NOT NULL,
  page_slug text NOT NULL,
  page_id text NOT NULL REFERENCES hs_pages(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, space_slug, page_slug)
);
CREATE INDEX IF NOT EXISTS hs_slug_redirects_page ON hs_slug_redirects (page_id);

CREATE TABLE IF NOT EXISTS hs_page_publication_state (
  page_id text PRIMARY KEY REFERENCES hs_pages(id),
  live boolean NOT NULL DEFAULT true,
  unpublished_at timestamptz,
  unpublish_reason text,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS hs_published_page_operations (
  page_id text NOT NULL REFERENCES hs_pages(id),
  operation_id uuid NOT NULL,
  actor_id text NOT NULL REFERENCES hs_users(id),
  request_hash text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (page_id, operation_id)
);

CREATE OR REPLACE FUNCTION hs_published_version_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Published page versions are immutable'; END;
$$;
DROP TRIGGER IF EXISTS hs_published_version_immutable ON hs_published_versions;
CREATE TRIGGER hs_published_version_immutable BEFORE UPDATE OR DELETE ON hs_published_versions
  FOR EACH ROW EXECUTE FUNCTION hs_published_version_immutable();
