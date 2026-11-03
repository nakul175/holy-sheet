-- HOLY-99 shared classification and tagging.
-- The taxonomy is tenant-owned. Assignments store stable tag ids. They do not
-- copy page bodies or record values, and they do not grant access.
-- Re-running this file is safe.

CREATE TABLE IF NOT EXISTS hs_classification_managers (
  workspace_id text NOT NULL REFERENCES hs_workspaces(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES hs_users(id),
  granted_by text NOT NULL REFERENCES hs_users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE IF NOT EXISTS hs_classification_tags (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
  code text NOT NULL CHECK (code ~ '^[A-Z0-9][A-Z0-9-]{0,31}$'),
  label text NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 80),
  parent_id uuid,
  documents boolean NOT NULL DEFAULT false,
  collections jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(collections) = 'array'),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'deprecated', 'merged', 'removed')),
  merged_into_id uuid,
  handling text NOT NULL DEFAULT 'metadata' CHECK (handling IN ('metadata', 'restrict')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by text NOT NULL REFERENCES hs_users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, code)
);

CREATE INDEX IF NOT EXISTS hs_classification_tags_tenant
  ON hs_classification_tags (tenant_id, status, code);

DO $$ BEGIN
  ALTER TABLE hs_classification_tags
    ADD CONSTRAINT hs_classification_tags_parent
    FOREIGN KEY (parent_id) REFERENCES hs_classification_tags(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  ALTER TABLE hs_classification_tags
    ADD CONSTRAINT hs_classification_tags_merged
    FOREIGN KEY (merged_into_id) REFERENCES hs_classification_tags(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE OR REPLACE FUNCTION hs_classification_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE other uuid;
BEGIN
  IF NEW.parent_id IS NOT NULL THEN
    IF NEW.parent_id = NEW.id THEN RAISE EXCEPTION 'classification parent cycle'; END IF;
    SELECT tenant_id INTO other FROM hs_classification_tags WHERE id = NEW.parent_id;
    IF other IS DISTINCT FROM NEW.tenant_id THEN RAISE EXCEPTION 'classification parent tenant'; END IF;
  END IF;
  IF NEW.merged_into_id IS NOT NULL THEN
    IF NEW.merged_into_id = NEW.id THEN RAISE EXCEPTION 'classification merge cycle'; END IF;
    SELECT tenant_id INTO other FROM hs_classification_tags WHERE id = NEW.merged_into_id;
    IF other IS DISTINCT FROM NEW.tenant_id THEN RAISE EXCEPTION 'classification merge tenant'; END IF;
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.id IS DISTINCT FROM OLD.id OR NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.code IS DISTINCT FROM OLD.code) THEN
    RAISE EXCEPTION 'classification identity is stable';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS hs_classification_guard ON hs_classification_tags;
CREATE TRIGGER hs_classification_guard
  BEFORE INSERT OR UPDATE ON hs_classification_tags
  FOR EACH ROW EXECUTE FUNCTION hs_classification_guard();

CREATE TABLE IF NOT EXISTS hs_classification_revisions (
  tag_id uuid NOT NULL REFERENCES hs_classification_tags(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  action text NOT NULL,
  code text NOT NULL,
  label text NOT NULL,
  parent_id uuid,
  documents boolean NOT NULL,
  collections jsonb NOT NULL,
  status text NOT NULL,
  merged_into_id uuid,
  handling text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  actor_id text NOT NULL REFERENCES hs_users(id),
  operation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tag_id, version)
);

CREATE OR REPLACE FUNCTION hs_classification_revision_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Classification revisions are immutable'; END $$;

DROP TRIGGER IF EXISTS hs_classification_revision_immutable ON hs_classification_revisions;
CREATE TRIGGER hs_classification_revision_immutable
  BEFORE UPDATE OR DELETE ON hs_classification_revisions
  FOR EACH ROW EXECUTE FUNCTION hs_classification_revision_immutable();

CREATE TABLE IF NOT EXISTS hs_classification_handling (
  tag_id uuid NOT NULL REFERENCES hs_classification_tags(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES hs_users(id),
  PRIMARY KEY (tag_id, user_id)
);

CREATE TABLE IF NOT EXISTS hs_classification_targets (
  tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
  target_kind text NOT NULL CHECK (target_kind IN ('record', 'page')),
  target_id text NOT NULL CHECK (char_length(target_id) BETWEEN 1 AND 200),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, target_kind, target_id)
);

CREATE TABLE IF NOT EXISTS hs_classification_assignments (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
  tag_id uuid NOT NULL REFERENCES hs_classification_tags(id),
  target_kind text NOT NULL CHECK (target_kind IN ('record', 'page')),
  target_id text NOT NULL CHECK (char_length(target_id) BETWEEN 1 AND 200),
  created_by text NOT NULL REFERENCES hs_users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, tag_id, target_kind, target_id)
);

CREATE INDEX IF NOT EXISTS hs_classification_assignments_target
  ON hs_classification_assignments (tenant_id, target_kind, target_id);
CREATE INDEX IF NOT EXISTS hs_classification_assignments_tag
  ON hs_classification_assignments (tenant_id, tag_id);

CREATE TABLE IF NOT EXISTS hs_classification_assignment_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
  tag_id uuid NOT NULL REFERENCES hs_classification_tags(id),
  target_kind text NOT NULL,
  target_id text NOT NULL,
  action text NOT NULL CHECK (action IN ('assign', 'remove', 'remap')),
  actor_id text NOT NULL REFERENCES hs_users(id),
  operation_id uuid NOT NULL,
  source text NOT NULL DEFAULT 'classification',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS hs_classification_assignment_events_target
  ON hs_classification_assignment_events (tenant_id, target_kind, target_id, created_at);
CREATE INDEX IF NOT EXISTS hs_classification_assignment_events_tag
  ON hs_classification_assignment_events (tag_id, created_at);

CREATE TABLE IF NOT EXISTS hs_classification_field_policy (
  tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
  scope_key text NOT NULL CHECK (char_length(scope_key) BETWEEN 1 AND 80),
  sensitive boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  PRIMARY KEY (tenant_id, scope_key)
);

CREATE TABLE IF NOT EXISTS hs_classification_field_access (
  tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
  scope_key text NOT NULL,
  user_id text NOT NULL REFERENCES hs_users(id) ON DELETE CASCADE,
  can_view boolean NOT NULL DEFAULT false,
  can_assign boolean NOT NULL DEFAULT false,
  can_history boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id, scope_key, user_id)
);

CREATE TABLE IF NOT EXISTS hs_classification_drafts (
  tag_id uuid NOT NULL REFERENCES hs_classification_tags(id) ON DELETE CASCADE,
  actor_id text NOT NULL REFERENCES hs_users(id),
  base_version integer NOT NULL CHECK (base_version > 0),
  label text NOT NULL,
  parent_id uuid,
  documents boolean NOT NULL,
  collections jsonb NOT NULL,
  handling text NOT NULL,
  cleared_user_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  operation_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tag_id, actor_id)
);

CREATE TABLE IF NOT EXISTS hs_classification_previews (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
  actor_id text NOT NULL REFERENCES hs_users(id),
  tag_id uuid NOT NULL REFERENCES hs_classification_tags(id),
  action text NOT NULL CHECK (action IN ('merge', 'remove')),
  into_id uuid,
  tag_version integer NOT NULL CHECK (tag_version > 0),
  reference_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS hs_classification_operations (
  actor_id text NOT NULL REFERENCES hs_users(id),
  operation_id uuid NOT NULL,
  request_hash text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (actor_id, operation_id)
);
