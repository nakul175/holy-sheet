-- HOLY-109 approved public knowledge sites.
-- A site records approved page revisions, paths, and navigation for a later public help centre.
-- Sharing stays off. No live site, domain, or public host is enabled here.
-- Configuration and assignment do not grant page, record, or field access.
-- Unpublish and rollback advance the cache generation. Third-party copies are not retracted.
-- This file does not update hs_data_periodic_review_schedules.
-- It does not alter parent_organisation_id. Re-running this file is safe.

CREATE TABLE IF NOT EXISTS hs_knowledge_site_managers (
  workspace_id text NOT NULL REFERENCES hs_workspaces(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES hs_users(id),
  granted_by text NOT NULL REFERENCES hs_users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE IF NOT EXISTS hs_knowledge_sites (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  name_search text GENERATED ALWAYS AS (lower(name)) STORED,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'unpublished')),
  sharing text NOT NULL DEFAULT 'off' CHECK (sharing = 'off'),
  live_site boolean NOT NULL DEFAULT false CHECK (live_site = false),
  public_enabled boolean NOT NULL DEFAULT false CHECK (public_enabled = false),
  domain text CHECK (domain IS NULL),
  audience_confirmed boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  cache_generation integer NOT NULL DEFAULT 1 CHECK (cache_generation > 0),
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  served jsonb CHECK (served IS NULL OR jsonb_typeof(served) = 'object'),
  served_snapshot_id uuid,
  created_by text NOT NULL REFERENCES hs_users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS hs_knowledge_sites_tenant
  ON hs_knowledge_sites (tenant_id, name_search, id);

CREATE OR REPLACE FUNCTION hs_knowledge_site_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'draft' OR NEW.sharing <> 'off' OR NEW.live_site <> false OR NEW.public_enabled <> false
     OR NEW.domain IS NOT NULL OR NEW.audience_confirmed <> false OR NEW.version <> 1 OR NEW.served IS NOT NULL
     OR NEW.served_snapshot_id IS NOT NULL THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Knowledge sites are created as private drafts';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS hs_knowledge_site_insert_guard ON hs_knowledge_sites;
CREATE TRIGGER hs_knowledge_site_insert_guard
  BEFORE INSERT ON hs_knowledge_sites
  FOR EACH ROW EXECUTE FUNCTION hs_knowledge_site_insert_guard();

CREATE OR REPLACE FUNCTION hs_knowledge_site_update_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.created_by <> OLD.created_by
     OR NEW.created_at <> OLD.created_at OR NEW.sharing <> 'off' OR NEW.live_site <> false
     OR NEW.public_enabled <> false OR NEW.domain IS NOT NULL
     OR NEW.version < OLD.version OR NEW.cache_generation < OLD.cache_generation THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Knowledge site identity is immutable and publication stays private';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS hs_knowledge_site_update_guard ON hs_knowledge_sites;
CREATE TRIGGER hs_knowledge_site_update_guard
  BEFORE UPDATE ON hs_knowledge_sites
  FOR EACH ROW EXECUTE FUNCTION hs_knowledge_site_update_guard();

CREATE TABLE IF NOT EXISTS hs_knowledge_site_revisions (
  site_id uuid NOT NULL REFERENCES hs_knowledge_sites(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL CHECK (status IN ('draft', 'published', 'unpublished')),
  name text NOT NULL,
  definition jsonb NOT NULL,
  cache_generation integer NOT NULL CHECK (cache_generation > 0),
  action text NOT NULL,
  actor_id text NOT NULL REFERENCES hs_users(id),
  operation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (site_id, version)
);

CREATE OR REPLACE FUNCTION hs_knowledge_site_revision_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Knowledge site revisions are immutable'; END $$;

DROP TRIGGER IF EXISTS hs_knowledge_site_revision_immutable ON hs_knowledge_site_revisions;
CREATE TRIGGER hs_knowledge_site_revision_immutable
  BEFORE UPDATE OR DELETE ON hs_knowledge_site_revisions
  FOR EACH ROW EXECUTE FUNCTION hs_knowledge_site_revision_immutable();

CREATE TABLE IF NOT EXISTS hs_knowledge_site_snapshots (
  id uuid PRIMARY KEY,
  site_id uuid NOT NULL REFERENCES hs_knowledge_sites(id) ON DELETE CASCADE,
  site_version integer NOT NULL CHECK (site_version > 0),
  cache_generation integer NOT NULL CHECK (cache_generation > 0),
  kind text NOT NULL CHECK (kind IN ('publish', 'rollback')),
  projection jsonb NOT NULL CHECK (jsonb_typeof(projection) = 'object'),
  actor_id text NOT NULL REFERENCES hs_users(id),
  operation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS hs_knowledge_site_snapshots_site
  ON hs_knowledge_site_snapshots (site_id, created_at, id);

CREATE OR REPLACE FUNCTION hs_knowledge_site_snapshot_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Knowledge site snapshots are immutable'; END $$;

DROP TRIGGER IF EXISTS hs_knowledge_site_snapshot_immutable ON hs_knowledge_site_snapshots;
CREATE TRIGGER hs_knowledge_site_snapshot_immutable
  BEFORE UPDATE OR DELETE ON hs_knowledge_site_snapshots
  FOR EACH ROW EXECUTE FUNCTION hs_knowledge_site_snapshot_immutable();

CREATE TABLE IF NOT EXISTS hs_knowledge_site_drafts (
  tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
  actor_id text NOT NULL REFERENCES hs_users(id),
  site_key text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('configure', 'publish', 'unpublish', 'rollback', 'actions', 'render')),
  base_version integer NOT NULL CHECK (base_version >= 0),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  operation_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, actor_id, site_key, kind)
);

CREATE TABLE IF NOT EXISTS hs_knowledge_site_operations (
  actor_id text NOT NULL REFERENCES hs_users(id),
  operation_id uuid NOT NULL,
  request_hash text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (actor_id, operation_id)
);

CREATE OR REPLACE FUNCTION hs_knowledge_site_operation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Knowledge site operations are immutable'; END $$;

DROP TRIGGER IF EXISTS hs_knowledge_site_operation_immutable ON hs_knowledge_site_operations;
CREATE TRIGGER hs_knowledge_site_operation_immutable
  BEFORE UPDATE OR DELETE ON hs_knowledge_site_operations
  FOR EACH ROW EXECUTE FUNCTION hs_knowledge_site_operation_immutable();

CREATE TABLE IF NOT EXISTS hs_knowledge_site_actor_sets (
  tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
  user_id text NOT NULL REFERENCES hs_users(id) ON DELETE CASCADE,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  PRIMARY KEY (tenant_id, user_id)
);

CREATE TABLE IF NOT EXISTS hs_knowledge_site_actor_actions (
  tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
  user_id text NOT NULL REFERENCES hs_users(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('configure', 'search', 'preview', 'download', 'history', 'publish', 'unpublish', 'rollback', 'render')),
  granted_by text NOT NULL REFERENCES hs_users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, user_id, action)
);

CREATE TABLE IF NOT EXISTS hs_knowledge_site_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
  site_id uuid NOT NULL REFERENCES hs_knowledge_sites(id) ON DELETE CASCADE,
  action text NOT NULL,
  actor_id text NOT NULL REFERENCES hs_users(id),
  operation_id uuid NOT NULL,
  source text NOT NULL CHECK (source = 'knowledge-site'),
  cache_generation integer NOT NULL CHECK (cache_generation > 0),
  detail jsonb NOT NULL CHECK (jsonb_typeof(detail) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS hs_knowledge_site_events_site
  ON hs_knowledge_site_events (tenant_id, site_id, created_at, id);

CREATE OR REPLACE FUNCTION hs_knowledge_site_event_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Knowledge site events are immutable'; END $$;

DROP TRIGGER IF EXISTS hs_knowledge_site_event_immutable ON hs_knowledge_site_events;
CREATE TRIGGER hs_knowledge_site_event_immutable
  BEFORE UPDATE OR DELETE ON hs_knowledge_site_events
  FOR EACH ROW EXECUTE FUNCTION hs_knowledge_site_event_immutable();

CREATE TABLE IF NOT EXISTS hs_knowledge_site_search (
  site_id uuid NOT NULL REFERENCES hs_knowledge_sites(id) ON DELETE CASCADE,
  cache_generation integer NOT NULL CHECK (cache_generation > 0),
  page_id text NOT NULL,
  path text NOT NULL,
  body text NOT NULL,
  PRIMARY KEY (site_id, cache_generation, page_id)
);

CREATE TABLE IF NOT EXISTS hs_knowledge_site_assets (
  site_id uuid NOT NULL REFERENCES hs_knowledge_sites(id) ON DELETE CASCADE,
  cache_generation integer NOT NULL CHECK (cache_generation > 0),
  media_id uuid NOT NULL,
  page_id text NOT NULL,
  name text NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
  mime text NOT NULL CHECK (char_length(mime) BETWEEN 1 AND 120),
  scan_state text NOT NULL CHECK (scan_state = 'clean'),
  quarantined boolean NOT NULL CHECK (quarantined = false),
  object_key_stored boolean NOT NULL DEFAULT false CHECK (object_key_stored = false),
  direct_url text CHECK (direct_url IS NULL),
  PRIMARY KEY (site_id, cache_generation, media_id)
);
