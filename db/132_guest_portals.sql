-- HOLY-106 authenticated external guest portals.
-- A portal lists explicit screens, record scope, fields, actions, and an expiry policy.
-- Sharing stays off. This file does not invite anyone, grant access, store credentials,
-- or configure suite identity. A later activation path would have to be separate.
-- Guest identity rows only record a suite subject. They cannot store credentials,
-- send invitations, or grant access.
-- Naming a manager or saving configuration does not grant record, field, or page access.
-- This file does not update hs_data_periodic_review_schedules.
-- It does not alter parent_organisation_id. Re-running this file is safe.

CREATE TABLE IF NOT EXISTS hs_guest_portal_managers (
  workspace_id text NOT NULL REFERENCES hs_workspaces(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES hs_users(id),
  granted_by text NOT NULL REFERENCES hs_users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE IF NOT EXISTS hs_guest_portals (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  name_search text GENERATED ALWAYS AS (lower(name)) STORED,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'preview', 'paused', 'revoked')),
  sharing text NOT NULL DEFAULT 'off' CHECK (sharing = 'off'),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  cache_generation integer NOT NULL DEFAULT 1 CHECK (cache_generation > 0),
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  created_by text NOT NULL REFERENCES hs_users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS hs_guest_portals_tenant
  ON hs_guest_portals (tenant_id, name_search, id);

CREATE OR REPLACE FUNCTION hs_guest_portal_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'draft' OR NEW.sharing <> 'off' OR NEW.version <> 1 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Portals are created as unshared drafts';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS hs_guest_portal_insert_guard ON hs_guest_portals;
CREATE TRIGGER hs_guest_portal_insert_guard
  BEFORE INSERT ON hs_guest_portals
  FOR EACH ROW EXECUTE FUNCTION hs_guest_portal_insert_guard();

CREATE OR REPLACE FUNCTION hs_guest_portal_update_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.created_by <> OLD.created_by
     OR NEW.created_at <> OLD.created_at OR NEW.sharing <> 'off' OR NEW.sharing <> OLD.sharing
     OR NEW.version < OLD.version OR NEW.cache_generation < OLD.cache_generation THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Portal identity is immutable and sharing stays off';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS hs_guest_portal_update_guard ON hs_guest_portals;
CREATE TRIGGER hs_guest_portal_update_guard
  BEFORE UPDATE ON hs_guest_portals
  FOR EACH ROW EXECUTE FUNCTION hs_guest_portal_update_guard();

CREATE TABLE IF NOT EXISTS hs_guest_portal_revisions (
  portal_id uuid NOT NULL REFERENCES hs_guest_portals(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL CHECK (status IN ('draft', 'preview', 'paused', 'revoked')),
  name text NOT NULL,
  definition jsonb NOT NULL,
  cache_generation integer NOT NULL CHECK (cache_generation > 0),
  action text NOT NULL,
  actor_id text NOT NULL REFERENCES hs_users(id),
  operation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (portal_id, version)
);

CREATE OR REPLACE FUNCTION hs_guest_portal_revision_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Portal revisions are immutable'; END $$;

DROP TRIGGER IF EXISTS hs_guest_portal_revision_immutable ON hs_guest_portal_revisions;
CREATE TRIGGER hs_guest_portal_revision_immutable
  BEFORE UPDATE OR DELETE ON hs_guest_portal_revisions
  FOR EACH ROW EXECUTE FUNCTION hs_guest_portal_revision_immutable();

CREATE TABLE IF NOT EXISTS hs_guest_portal_drafts (
  tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
  actor_id text NOT NULL REFERENCES hs_users(id),
  portal_key text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('configure', 'link', 'form', 'comment', 'file', 'actions')),
  base_version integer NOT NULL CHECK (base_version >= 0),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  operation_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, actor_id, portal_key, kind)
);

CREATE TABLE IF NOT EXISTS hs_guest_portal_operations (
  actor_id text NOT NULL REFERENCES hs_users(id),
  operation_id uuid NOT NULL,
  request_hash text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (actor_id, operation_id)
);

CREATE OR REPLACE FUNCTION hs_guest_portal_operation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Portal operations are immutable'; END $$;

DROP TRIGGER IF EXISTS hs_guest_portal_operation_immutable ON hs_guest_portal_operations;
CREATE TRIGGER hs_guest_portal_operation_immutable
  BEFORE UPDATE OR DELETE ON hs_guest_portal_operations
  FOR EACH ROW EXECUTE FUNCTION hs_guest_portal_operation_immutable();

CREATE TABLE IF NOT EXISTS hs_guest_portal_identities (
  portal_id uuid NOT NULL REFERENCES hs_guest_portals(id) ON DELETE CASCADE,
  suite_subject text NOT NULL REFERENCES hs_users(id),
  credentials_stored boolean NOT NULL DEFAULT false CHECK (credentials_stored = false),
  invitation_sent boolean NOT NULL DEFAULT false CHECK (invitation_sent = false),
  access_granted boolean NOT NULL DEFAULT false CHECK (access_granted = false),
  version integer NOT NULL CHECK (version > 0),
  linked_by text NOT NULL REFERENCES hs_users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (portal_id, suite_subject)
);

CREATE TABLE IF NOT EXISTS hs_guest_portal_grants (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
  portal_id uuid NOT NULL REFERENCES hs_guest_portals(id) ON DELETE CASCADE,
  suite_subject text NOT NULL,
  state text NOT NULL CHECK (state IN ('current', 'revoked', 'expired')),
  starts_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  CHECK (expires_at > starts_at)
);

CREATE INDEX IF NOT EXISTS hs_guest_portal_grants_subject
  ON hs_guest_portal_grants (tenant_id, portal_id, suite_subject);

CREATE TABLE IF NOT EXISTS hs_guest_portal_actor_sets (
  tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
  user_id text NOT NULL REFERENCES hs_users(id) ON DELETE CASCADE,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  PRIMARY KEY (tenant_id, user_id)
);

CREATE TABLE IF NOT EXISTS hs_guest_portal_actor_actions (
  tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
  user_id text NOT NULL REFERENCES hs_users(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('configure', 'search', 'preview', 'download', 'history', 'pause', 'revoke', 'form', 'comment', 'file', 'export', 'link')),
  granted_by text NOT NULL REFERENCES hs_users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, user_id, action)
);

CREATE TABLE IF NOT EXISTS hs_guest_portal_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
  portal_id uuid NOT NULL REFERENCES hs_guest_portals(id) ON DELETE CASCADE,
  action text NOT NULL,
  actor_id text NOT NULL REFERENCES hs_users(id),
  operation_id uuid NOT NULL,
  source text NOT NULL CHECK (source = 'guest-portal'),
  cache_generation integer NOT NULL CHECK (cache_generation > 0),
  detail jsonb NOT NULL CHECK (jsonb_typeof(detail) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS hs_guest_portal_events_portal
  ON hs_guest_portal_events (tenant_id, portal_id, created_at, id);

CREATE OR REPLACE FUNCTION hs_guest_portal_event_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Portal events are immutable'; END $$;

DROP TRIGGER IF EXISTS hs_guest_portal_event_immutable ON hs_guest_portal_events;
CREATE TRIGGER hs_guest_portal_event_immutable
  BEFORE UPDATE OR DELETE ON hs_guest_portal_events
  FOR EACH ROW EXECUTE FUNCTION hs_guest_portal_event_immutable();

CREATE TABLE IF NOT EXISTS hs_guest_portal_submissions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
  portal_id uuid NOT NULL REFERENCES hs_guest_portals(id) ON DELETE CASCADE,
  record_id uuid NOT NULL,
  actor_id text NOT NULL REFERENCES hs_users(id),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  portal_version integer NOT NULL CHECK (portal_version > 0),
  values jsonb NOT NULL CHECK (jsonb_typeof(values) = 'object'),
  operation_id uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE OR REPLACE FUNCTION hs_guest_portal_submission_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Portal submissions are immutable'; END $$;

DROP TRIGGER IF EXISTS hs_guest_portal_submission_immutable ON hs_guest_portal_submissions;
CREATE TRIGGER hs_guest_portal_submission_immutable
  BEFORE UPDATE OR DELETE ON hs_guest_portal_submissions
  FOR EACH ROW EXECUTE FUNCTION hs_guest_portal_submission_immutable();

CREATE TABLE IF NOT EXISTS hs_guest_portal_comments (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
  portal_id uuid NOT NULL REFERENCES hs_guest_portals(id) ON DELETE CASCADE,
  record_id uuid NOT NULL,
  actor_id text NOT NULL REFERENCES hs_users(id),
  body text NOT NULL CHECK (char_length(btrim(body)) BETWEEN 1 AND 4000),
  operation_id uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE OR REPLACE FUNCTION hs_guest_portal_comment_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Portal comments are immutable'; END $$;

DROP TRIGGER IF EXISTS hs_guest_portal_comment_immutable ON hs_guest_portal_comments;
CREATE TRIGGER hs_guest_portal_comment_immutable
  BEFORE UPDATE OR DELETE ON hs_guest_portal_comments
  FOR EACH ROW EXECUTE FUNCTION hs_guest_portal_comment_immutable();

CREATE TABLE IF NOT EXISTS hs_guest_portal_files (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
  portal_id uuid NOT NULL REFERENCES hs_guest_portals(id) ON DELETE CASCADE,
  record_id uuid NOT NULL,
  actor_id text NOT NULL REFERENCES hs_users(id),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 200),
  fetched boolean NOT NULL DEFAULT false CHECK (fetched = false),
  operation_id uuid NOT NULL UNIQUE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE OR REPLACE FUNCTION hs_guest_portal_file_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Portal files are immutable'; END $$;

DROP TRIGGER IF EXISTS hs_guest_portal_file_immutable ON hs_guest_portal_files;
CREATE TRIGGER hs_guest_portal_file_immutable
  BEFORE UPDATE OR DELETE ON hs_guest_portal_files
  FOR EACH ROW EXECUTE FUNCTION hs_guest_portal_file_immutable();
