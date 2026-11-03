-- HOLY-108 governed connector framework.
-- A connector records an approved type, tenant source, stable identifiers, field mappings, and direction.
-- Sharing stays off. Live activation stays off. Connection setup is not authorised here.
-- Runtime credentials stay in the suite secret store. This file stores a reference, never a secret value.
-- Configuration and assignment do not grant record, field, or page access.
-- Sync checkpoints, dedupe, conflicts, tombstones, and merges stay in the connector ledger.
-- Canonical records are not updated by this file.
-- This file does not update hs_data_periodic_review_schedules.
-- It does not alter parent_organisation_id. Re-running this file is safe.

CREATE TABLE IF NOT EXISTS hs_connector_managers (
  workspace_id text NOT NULL REFERENCES hs_workspaces(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES hs_users(id),
  granted_by text NOT NULL REFERENCES hs_users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE IF NOT EXISTS hs_connectors (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  name_search text GENERATED ALWAYS AS (lower(name)) STORED,
  connector_type text NOT NULL CHECK (connector_type IN ('records', 'directory')),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'enabled', 'paused', 'disconnected')),
  sharing text NOT NULL DEFAULT 'off' CHECK (sharing = 'off'),
  activated boolean NOT NULL DEFAULT false CHECK (activated = false),
  live_activation boolean NOT NULL DEFAULT false CHECK (live_activation = false),
  connection_authorised boolean NOT NULL DEFAULT false CHECK (connection_authorised = false),
  credentials_stored boolean NOT NULL DEFAULT false CHECK (credentials_stored = false),
  secret_ref text CHECK (secret_ref IS NULL OR secret_ref ~ '^suite-secret:[a-z][a-z0-9-]{0,63}$'),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  cache_generation integer NOT NULL DEFAULT 1 CHECK (cache_generation > 0),
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  created_by text NOT NULL REFERENCES hs_users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS hs_connectors_tenant
  ON hs_connectors (tenant_id, name_search, id);

CREATE OR REPLACE FUNCTION hs_connector_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'draft' OR NEW.sharing <> 'off' OR NEW.activated <> false OR NEW.live_activation <> false
     OR NEW.connection_authorised <> false OR NEW.credentials_stored <> false OR NEW.version <> 1 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Connectors are created as unactivated drafts';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS hs_connector_insert_guard ON hs_connectors;
CREATE TRIGGER hs_connector_insert_guard
  BEFORE INSERT ON hs_connectors
  FOR EACH ROW EXECUTE FUNCTION hs_connector_insert_guard();

CREATE OR REPLACE FUNCTION hs_connector_update_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.created_by <> OLD.created_by
     OR NEW.created_at <> OLD.created_at OR NEW.sharing <> 'off' OR NEW.sharing <> OLD.sharing
     OR NEW.activated <> false OR NEW.live_activation <> false OR NEW.connection_authorised <> false
     OR NEW.credentials_stored <> false OR NEW.version < OLD.version OR NEW.cache_generation < OLD.cache_generation THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Connector identity is immutable and activation stays off';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS hs_connector_update_guard ON hs_connectors;
CREATE TRIGGER hs_connector_update_guard
  BEFORE UPDATE ON hs_connectors
  FOR EACH ROW EXECUTE FUNCTION hs_connector_update_guard();

CREATE TABLE IF NOT EXISTS hs_connector_revisions (
  connector_id uuid NOT NULL REFERENCES hs_connectors(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL CHECK (status IN ('draft', 'enabled', 'paused', 'disconnected')),
  name text NOT NULL,
  definition jsonb NOT NULL,
  cache_generation integer NOT NULL CHECK (cache_generation > 0),
  action text NOT NULL,
  actor_id text NOT NULL REFERENCES hs_users(id),
  operation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (connector_id, version)
);

CREATE OR REPLACE FUNCTION hs_connector_revision_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Connector revisions are immutable'; END $$;

DROP TRIGGER IF EXISTS hs_connector_revision_immutable ON hs_connector_revisions;
CREATE TRIGGER hs_connector_revision_immutable
  BEFORE UPDATE OR DELETE ON hs_connector_revisions
  FOR EACH ROW EXECUTE FUNCTION hs_connector_revision_immutable();

CREATE TABLE IF NOT EXISTS hs_connector_drafts (
  tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
  actor_id text NOT NULL REFERENCES hs_users(id),
  connector_key text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('configure', 'delegate', 'sync', 'review', 'merge', 'actions')),
  base_version integer NOT NULL CHECK (base_version >= 0),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  operation_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, actor_id, connector_key, kind)
);

CREATE TABLE IF NOT EXISTS hs_connector_operations (
  actor_id text NOT NULL REFERENCES hs_users(id),
  operation_id uuid NOT NULL,
  request_hash text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (actor_id, operation_id)
);

CREATE OR REPLACE FUNCTION hs_connector_operation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Connector operations are immutable'; END $$;

DROP TRIGGER IF EXISTS hs_connector_operation_immutable ON hs_connector_operations;
CREATE TRIGGER hs_connector_operation_immutable
  BEFORE UPDATE OR DELETE ON hs_connector_operations
  FOR EACH ROW EXECUTE FUNCTION hs_connector_operation_immutable();

CREATE TABLE IF NOT EXISTS hs_connector_actor_sets (
  tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
  user_id text NOT NULL REFERENCES hs_users(id) ON DELETE CASCADE,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  PRIMARY KEY (tenant_id, user_id)
);

CREATE TABLE IF NOT EXISTS hs_connector_actor_actions (
  tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
  user_id text NOT NULL REFERENCES hs_users(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('configure', 'search', 'preview', 'download', 'history', 'enable', 'pause', 'disconnect', 'delegate', 'sync', 'review', 'merge')),
  granted_by text NOT NULL REFERENCES hs_users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, user_id, action)
);

CREATE TABLE IF NOT EXISTS hs_connector_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
  connector_id uuid NOT NULL REFERENCES hs_connectors(id) ON DELETE CASCADE,
  action text NOT NULL,
  actor_id text NOT NULL REFERENCES hs_users(id),
  operation_id uuid NOT NULL,
  source text NOT NULL CHECK (source = 'governed-connector'),
  cache_generation integer NOT NULL CHECK (cache_generation > 0),
  detail jsonb NOT NULL CHECK (jsonb_typeof(detail) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS hs_connector_events_connector
  ON hs_connector_events (tenant_id, connector_id, created_at, id);

CREATE OR REPLACE FUNCTION hs_connector_event_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Connector events are immutable'; END $$;

DROP TRIGGER IF EXISTS hs_connector_event_immutable ON hs_connector_events;
CREATE TRIGGER hs_connector_event_immutable
  BEFORE UPDATE OR DELETE ON hs_connector_events
  FOR EACH ROW EXECUTE FUNCTION hs_connector_event_immutable();

CREATE TABLE IF NOT EXISTS hs_connector_delegations (
  connector_id uuid NOT NULL REFERENCES hs_connectors(id) ON DELETE CASCADE,
  subject_kind text NOT NULL CHECK (subject_kind IN ('user', 'app')),
  subject_id text NOT NULL CHECK (char_length(subject_id) BETWEEN 1 AND 80),
  field_key text NOT NULL,
  access_granted boolean NOT NULL DEFAULT false CHECK (access_granted = false),
  version integer NOT NULL CHECK (version > 0),
  delegated_by text NOT NULL REFERENCES hs_users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (connector_id, subject_kind, subject_id, field_key)
);

CREATE TABLE IF NOT EXISTS hs_connector_checkpoints (
  connector_id uuid PRIMARY KEY REFERENCES hs_connectors(id) ON DELETE CASCADE,
  mode text NOT NULL CHECK (mode IN ('initial', 'incremental')),
  cursor text NOT NULL CHECK (char_length(cursor) BETWEEN 1 AND 80),
  generation integer NOT NULL CHECK (generation > 0),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS hs_connector_sync_items (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
  connector_id uuid NOT NULL REFERENCES hs_connectors(id) ON DELETE CASCADE,
  external_id text NOT NULL CHECK (char_length(external_id) BETWEEN 1 AND 80),
  external_field text NOT NULL CHECK (char_length(external_field) BETWEEN 1 AND 40),
  field_key text NOT NULL,
  record_id uuid NOT NULL,
  value text NOT NULL CHECK (char_length(value) BETWEEN 1 AND 2000),
  proposed_value text CHECK (proposed_value IS NULL OR char_length(proposed_value) BETWEEN 1 AND 2000),
  external_version integer NOT NULL CHECK (external_version > 0),
  canonical_version integer,
  state text NOT NULL CHECK (state IN ('proposed', 'conflict', 'tombstone', 'merged', 'rejected', 'failed')),
  attempt_count integer NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 3),
  canonical_mutated boolean NOT NULL DEFAULT false CHECK (canonical_mutated = false),
  merged_into text,
  operation_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (connector_id, external_id, external_field)
);

CREATE INDEX IF NOT EXISTS hs_connector_sync_items_connector
  ON hs_connector_sync_items (tenant_id, connector_id, state, external_id);

CREATE OR REPLACE FUNCTION hs_connector_sync_item_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Connector sync items are durable';
  END IF;
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.connector_id <> OLD.connector_id
     OR NEW.external_id <> OLD.external_id OR NEW.external_field <> OLD.external_field
     OR NEW.record_id <> OLD.record_id OR NEW.canonical_mutated <> false
     OR NEW.attempt_count < OLD.attempt_count THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Connector sync identity cannot change';
  END IF;
  IF NEW.value IS DISTINCT FROM OLD.value AND NOT (OLD.state IN ('conflict', 'tombstone') AND NEW.state = 'merged') THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Connector sync items cannot silently overwrite an accepted value';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS hs_connector_sync_item_guard ON hs_connector_sync_items;
CREATE TRIGGER hs_connector_sync_item_guard
  BEFORE UPDATE OR DELETE ON hs_connector_sync_items
  FOR EACH ROW EXECUTE FUNCTION hs_connector_sync_item_guard();
