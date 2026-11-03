-- HOLY-100 hierarchical custom collections.
-- Optional same-collection parent. This does not alter Account to Organisation
-- (hs_data_records.parent_organisation_id) and it does not grant access.
-- Re-running this file is safe.

CREATE TABLE IF NOT EXISTS hs_collection_hierarchy_managers (
  workspace_id text NOT NULL REFERENCES hs_workspaces(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES hs_users(id),
  granted_by text NOT NULL REFERENCES hs_users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE IF NOT EXISTS hs_collection_hierarchy (
  tenant_id uuid NOT NULL,
  collection text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  allow_roots boolean NOT NULL DEFAULT true,
  depth_limit integer NOT NULL DEFAULT 20 CHECK (depth_limit BETWEEN 1 AND 20),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_by text NOT NULL REFERENCES hs_users(id),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, collection),
  FOREIGN KEY (tenant_id, collection) REFERENCES hs_data_collections(tenant_id, id)
);

CREATE TABLE IF NOT EXISTS hs_collection_hierarchy_revisions (
  tenant_id uuid NOT NULL,
  collection text NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  enabled boolean NOT NULL,
  allow_roots boolean NOT NULL,
  depth_limit integer NOT NULL,
  actor_id text NOT NULL REFERENCES hs_users(id),
  operation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, collection, version),
  FOREIGN KEY (tenant_id, collection) REFERENCES hs_collection_hierarchy(tenant_id, collection) ON DELETE CASCADE
);

CREATE OR REPLACE FUNCTION hs_collection_hierarchy_revision_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Collection hierarchy revisions are immutable'; END $$;

DROP TRIGGER IF EXISTS hs_collection_hierarchy_revision_immutable ON hs_collection_hierarchy_revisions;
CREATE TRIGGER hs_collection_hierarchy_revision_immutable
  BEFORE UPDATE OR DELETE ON hs_collection_hierarchy_revisions
  FOR EACH ROW EXECUTE FUNCTION hs_collection_hierarchy_revision_immutable();

CREATE TABLE IF NOT EXISTS hs_collection_hierarchy_links (
  tenant_id uuid NOT NULL,
  record_id uuid NOT NULL,
  collection text NOT NULL,
  parent_id uuid,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  PRIMARY KEY (tenant_id, record_id),
  CHECK (parent_id IS DISTINCT FROM record_id),
  FOREIGN KEY (tenant_id, record_id, collection) REFERENCES hs_data_records(tenant_id, id, collection),
  FOREIGN KEY (tenant_id, collection) REFERENCES hs_data_collections(tenant_id, id)
);

DO $$ BEGIN
  ALTER TABLE hs_collection_hierarchy_links
    ADD CONSTRAINT hs_collection_hierarchy_links_parent
    FOREIGN KEY (tenant_id, parent_id) REFERENCES hs_data_records(tenant_id, id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS hs_collection_hierarchy_links_parent
  ON hs_collection_hierarchy_links (tenant_id, collection, parent_id);

CREATE TABLE IF NOT EXISTS hs_collection_hierarchy_link_revisions (
  tenant_id uuid NOT NULL,
  record_id uuid NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  collection text NOT NULL,
  parent_id uuid,
  action text NOT NULL,
  actor_id text NOT NULL REFERENCES hs_users(id),
  operation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, record_id, version)
);

CREATE OR REPLACE FUNCTION hs_collection_hierarchy_link_revision_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Collection hierarchy link revisions are immutable'; END $$;

DROP TRIGGER IF EXISTS hs_collection_hierarchy_link_revision_immutable ON hs_collection_hierarchy_link_revisions;
CREATE TRIGGER hs_collection_hierarchy_link_revision_immutable
  BEFORE UPDATE OR DELETE ON hs_collection_hierarchy_link_revisions
  FOR EACH ROW EXECUTE FUNCTION hs_collection_hierarchy_link_revision_immutable();

CREATE TABLE IF NOT EXISTS hs_collection_hierarchy_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  collection text NOT NULL,
  record_id uuid,
  action text NOT NULL,
  parent_id uuid,
  actor_id text NOT NULL REFERENCES hs_users(id),
  operation_id uuid NOT NULL,
  source text NOT NULL DEFAULT 'collection-hierarchy',
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS hs_collection_hierarchy_events_record
  ON hs_collection_hierarchy_events (tenant_id, record_id, created_at);

CREATE TABLE IF NOT EXISTS hs_collection_hierarchy_drafts (
  actor_id text NOT NULL REFERENCES hs_users(id),
  tenant_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('config', 'placement')),
  collection text NOT NULL,
  record_key text NOT NULL DEFAULT '',
  base_version integer NOT NULL CHECK (base_version >= 0),
  enabled boolean,
  allow_roots boolean,
  depth_limit integer,
  parent_id uuid,
  operation_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (actor_id, tenant_id, kind, collection, record_key)
);

CREATE TABLE IF NOT EXISTS hs_collection_hierarchy_previews (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  actor_id text NOT NULL REFERENCES hs_users(id),
  collection text NOT NULL,
  action text NOT NULL CHECK (action IN ('reparent', 'archive', 'delete')),
  record_id uuid NOT NULL,
  parent_id uuid,
  record_version integer NOT NULL CHECK (record_version > 0),
  link_version integer NOT NULL CHECK (link_version >= 0),
  subtree_hash text NOT NULL,
  reference_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS hs_collection_hierarchy_operations (
  actor_id text NOT NULL REFERENCES hs_users(id),
  operation_id uuid NOT NULL,
  request_hash text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (actor_id, operation_id)
);

CREATE TABLE IF NOT EXISTS hs_collection_hierarchy_field_policy (
  tenant_id uuid NOT NULL,
  collection text NOT NULL,
  sensitive boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  PRIMARY KEY (tenant_id, collection),
  FOREIGN KEY (tenant_id, collection) REFERENCES hs_data_collections(tenant_id, id)
);

CREATE TABLE IF NOT EXISTS hs_collection_hierarchy_field_access (
  tenant_id uuid NOT NULL,
  collection text NOT NULL,
  user_id text NOT NULL REFERENCES hs_users(id) ON DELETE CASCADE,
  can_view boolean NOT NULL DEFAULT false,
  can_assign boolean NOT NULL DEFAULT false,
  can_history boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id, collection, user_id)
);

CREATE OR REPLACE FUNCTION hs_collection_hierarchy_max_depth(p_tenant uuid, p_collection text) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE rec record; cursor uuid; node_depth integer; seen uuid[]; result integer := 0;
BEGIN
  FOR rec IN SELECT record_id, parent_id FROM hs_collection_hierarchy_links WHERE tenant_id = p_tenant AND collection = p_collection LOOP
    node_depth := 1;
    cursor := rec.parent_id;
    seen := ARRAY[rec.record_id];
    WHILE cursor IS NOT NULL LOOP
      IF cursor = ANY(seen) OR node_depth >= 21 THEN
        node_depth := 21;
        EXIT;
      END IF;
      seen := array_append(seen, cursor);
      node_depth := node_depth + 1;
      SELECT parent_id INTO cursor FROM hs_collection_hierarchy_links WHERE tenant_id = p_tenant AND record_id = cursor;
    END LOOP;
    IF node_depth > result THEN result := node_depth; END IF;
  END LOOP;
  RETURN result;
END $$;

CREATE OR REPLACE FUNCTION hs_collection_hierarchy_span(tenant uuid, record uuid) RETURNS integer LANGUAGE plpgsql AS $$
DECLARE span integer;
BEGIN
  WITH RECURSIVE down AS (
    SELECT record AS id, 0 AS rel, ARRAY[record] AS path
    UNION ALL
    SELECT l.record_id, down.rel + 1, down.path || l.record_id
    FROM hs_collection_hierarchy_links l
    JOIN down ON l.parent_id = down.id AND l.tenant_id = tenant
    WHERE down.rel < 21 AND NOT l.record_id = ANY(down.path)
  )
  SELECT COALESCE(max(rel), 0) INTO span FROM down;
  RETURN span;
END $$;

CREATE OR REPLACE FUNCTION hs_collection_hierarchy_config_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE collection_core boolean; current_depth integer; root_links integer;
BEGIN
  SELECT core INTO collection_core FROM hs_data_collections WHERE tenant_id = NEW.tenant_id AND id = NEW.collection;
  IF collection_core IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'hierarchy custom collection only';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW.tenant_id IS DISTINCT FROM OLD.tenant_id OR NEW.collection IS DISTINCT FROM OLD.collection) THEN
    RAISE EXCEPTION 'hierarchy identity is stable';
  END IF;
  IF NEW.depth_limit < 1 OR NEW.depth_limit > 20 THEN
    RAISE EXCEPTION 'hierarchy depth limit';
  END IF;
  current_depth := hs_collection_hierarchy_max_depth(NEW.tenant_id, NEW.collection);
  IF current_depth > NEW.depth_limit THEN
    RAISE EXCEPTION 'hierarchy cycle or depth';
  END IF;
  IF NEW.allow_roots = false THEN
    SELECT count(*) INTO root_links FROM hs_collection_hierarchy_links
      WHERE tenant_id = NEW.tenant_id AND collection = NEW.collection AND parent_id IS NULL;
    IF root_links > 0 THEN RAISE EXCEPTION 'hierarchy roots are not permitted'; END IF;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS hs_collection_hierarchy_config_guard ON hs_collection_hierarchy;
CREATE TRIGGER hs_collection_hierarchy_config_guard
  BEFORE INSERT OR UPDATE ON hs_collection_hierarchy
  FOR EACH ROW EXECUTE FUNCTION hs_collection_hierarchy_config_guard();

CREATE OR REPLACE FUNCTION hs_collection_hierarchy_link_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  enabled boolean;
  allow_roots boolean;
  depth_limit integer;
  parent_collection text;
  parent_tenant uuid;
  parent_state text;
  parent_merged uuid;
  record_collection text;
  record_tenant uuid;
  cursor uuid;
  seen uuid[];
  node_depth integer := 1;
  span integer;
BEGIN
  SELECT r.tenant_id, r.collection INTO record_tenant, record_collection FROM hs_data_records r WHERE r.id = NEW.record_id;
  IF record_tenant IS DISTINCT FROM NEW.tenant_id OR record_collection IS DISTINCT FROM NEW.collection THEN
    RAISE EXCEPTION 'hierarchy record tenant';
  END IF;
  SELECT h.enabled, h.allow_roots, h.depth_limit INTO enabled, allow_roots, depth_limit
    FROM hs_collection_hierarchy h WHERE h.tenant_id = NEW.tenant_id AND h.collection = NEW.collection;
  IF NOT COALESCE(enabled, false) THEN
    RAISE EXCEPTION 'hierarchy is not enabled';
  END IF;
  IF NEW.parent_id IS NULL THEN
    IF NOT COALESCE(allow_roots, false) THEN
      RAISE EXCEPTION 'hierarchy roots are not permitted';
    END IF;
  ELSE
    IF NEW.parent_id = NEW.record_id THEN
      RAISE EXCEPTION 'hierarchy self parent';
    END IF;
    SELECT r.tenant_id, r.collection, r.state, r.merged_into_id INTO parent_tenant, parent_collection, parent_state, parent_merged
      FROM hs_data_records r WHERE r.id = NEW.parent_id;
    IF parent_tenant IS DISTINCT FROM NEW.tenant_id THEN
      RAISE EXCEPTION 'hierarchy cross tenant';
    END IF;
    IF parent_collection IS DISTINCT FROM NEW.collection THEN
      RAISE EXCEPTION 'hierarchy cross collection';
    END IF;
    IF parent_state IS DISTINCT FROM 'active' OR parent_merged IS NOT NULL THEN
      RAISE EXCEPTION 'hierarchy parent unavailable';
    END IF;
    cursor := NEW.parent_id;
    seen := ARRAY[NEW.record_id];
    WHILE cursor IS NOT NULL LOOP
      IF cursor = ANY(seen) OR node_depth >= depth_limit THEN
        RAISE EXCEPTION 'hierarchy cycle or depth';
      END IF;
      seen := array_append(seen, cursor);
      node_depth := node_depth + 1;
      SELECT l.parent_id INTO cursor FROM hs_collection_hierarchy_links l
        WHERE l.tenant_id = NEW.tenant_id AND l.record_id = cursor;
    END LOOP;
  END IF;
  span := hs_collection_hierarchy_span(NEW.tenant_id, NEW.record_id);
  IF node_depth + span > depth_limit THEN
    RAISE EXCEPTION 'hierarchy cycle or depth';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS hs_collection_hierarchy_link_guard ON hs_collection_hierarchy_links;
CREATE TRIGGER hs_collection_hierarchy_link_guard
  BEFORE INSERT OR UPDATE ON hs_collection_hierarchy_links
  FOR EACH ROW EXECUTE FUNCTION hs_collection_hierarchy_link_guard();
