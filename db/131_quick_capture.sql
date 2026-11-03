-- HOLY-105 quick capture and web clipping.
-- A capture stores only the text, link, or note the user selected, plus the
-- source address, title, and time they supplied. Holy Sheet does not open
-- that address, collect cookies, or import an asset that was not selected.
-- The committed page or intake record is private. External sharing is not inherited.
-- Naming an operator or saving configuration does not grant access.
-- Offline captures stay local drafts. This file does not activate a schedule.
-- This file does not update hs_data_periodic_review_schedules.
-- It does not alter parent_organisation_id. Re-running this file is safe.

CREATE TABLE IF NOT EXISTS hs_quick_capture_operators (
  workspace_id text NOT NULL REFERENCES hs_workspaces(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES hs_users(id),
  granted_by text NOT NULL REFERENCES hs_users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE IF NOT EXISTS hs_quick_capture_policies (
  tenant_id uuid PRIMARY KEY REFERENCES hs_data_tenants(id),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  default_destination text NOT NULL DEFAULT 'space' CHECK (default_destination IN ('space', 'intake')),
  visibility text NOT NULL DEFAULT 'private' CHECK (visibility = 'private'),
  inherit_external boolean NOT NULL DEFAULT false CHECK (inherit_external = false),
  offline_policy text NOT NULL DEFAULT 'local-draft' CHECK (offline_policy = 'local-draft'),
  kinds jsonb NOT NULL CHECK (jsonb_typeof(kinds) = 'array'),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE OR REPLACE FUNCTION hs_quick_capture_policy_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.visibility <> 'private' OR NEW.inherit_external <> false OR NEW.offline_policy <> 'local-draft' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Capture stays private, unshared, and local when offline';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS hs_quick_capture_policy_guard ON hs_quick_capture_policies;
CREATE TRIGGER hs_quick_capture_policy_guard
  BEFORE UPDATE ON hs_quick_capture_policies
  FOR EACH ROW EXECUTE FUNCTION hs_quick_capture_policy_guard();

CREATE TABLE IF NOT EXISTS hs_quick_capture_policy_revisions (
  tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
  version integer NOT NULL CHECK (version > 0),
  default_destination text NOT NULL,
  kinds jsonb NOT NULL,
  actor_id text NOT NULL REFERENCES hs_users(id),
  operation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, version)
);

CREATE OR REPLACE FUNCTION hs_quick_capture_policy_revision_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Capture policy revisions are immutable'; END $$;

DROP TRIGGER IF EXISTS hs_quick_capture_policy_revision_immutable ON hs_quick_capture_policy_revisions;
CREATE TRIGGER hs_quick_capture_policy_revision_immutable
  BEFORE UPDATE OR DELETE ON hs_quick_capture_policy_revisions
  FOR EACH ROW EXECUTE FUNCTION hs_quick_capture_policy_revision_immutable();

CREATE TABLE IF NOT EXISTS hs_quick_capture_policy_drafts (
  tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
  actor_id text NOT NULL REFERENCES hs_users(id),
  base_version integer NOT NULL CHECK (base_version >= 0),
  default_destination text NOT NULL,
  kinds jsonb NOT NULL,
  operation_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, actor_id)
);

CREATE TABLE IF NOT EXISTS hs_quick_capture_field_policy (
  tenant_id uuid PRIMARY KEY REFERENCES hs_data_tenants(id),
  sensitive boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0)
);

CREATE TABLE IF NOT EXISTS hs_quick_capture_field_access (
  tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
  user_id text NOT NULL REFERENCES hs_users(id) ON DELETE CASCADE,
  can_view boolean NOT NULL DEFAULT false,
  can_write boolean NOT NULL DEFAULT false,
  can_history boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id, user_id)
);

CREATE TABLE IF NOT EXISTS hs_quick_capture_action_sets (
  tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
  user_id text NOT NULL REFERENCES hs_users(id) ON DELETE CASCADE,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  PRIMARY KEY (tenant_id, user_id)
);

CREATE TABLE IF NOT EXISTS hs_quick_capture_actions (
  tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
  user_id text NOT NULL REFERENCES hs_users(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('capture', 'preview', 'commit', 'search', 'download', 'history', 'configure')),
  granted_by text NOT NULL REFERENCES hs_users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, user_id, action)
);

CREATE TABLE IF NOT EXISTS hs_quick_captures (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
  kind text NOT NULL CHECK (kind IN ('text', 'link', 'note')),
  title text NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  body text NOT NULL,
  source_url text,
  source_title text,
  source_page_id text,
  source_access text NOT NULL CHECK (source_access IN ('not-opened', 'unavailable', 'permitted')),
  destination_kind text NOT NULL CHECK (destination_kind IN ('space', 'intake')),
  destination_id text NOT NULL,
  page_id text REFERENCES hs_pages(id),
  record_id uuid,
  visibility text NOT NULL DEFAULT 'private' CHECK (visibility = 'private'),
  external_share boolean NOT NULL DEFAULT false CHECK (external_share = false),
  assets jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(assets) = 'array'),
  excluded jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(excluded) = 'array'),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  policy_version integer NOT NULL CHECK (policy_version >= 0),
  preview_id uuid NOT NULL UNIQUE,
  owner_id text NOT NULL REFERENCES hs_users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS hs_quick_captures_tenant
  ON hs_quick_captures (tenant_id, created_at DESC, id);

CREATE OR REPLACE FUNCTION hs_quick_capture_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Captures are immutable'; END $$;

DROP TRIGGER IF EXISTS hs_quick_capture_immutable ON hs_quick_captures;
CREATE TRIGGER hs_quick_capture_immutable
  BEFORE UPDATE OR DELETE ON hs_quick_captures
  FOR EACH ROW EXECUTE FUNCTION hs_quick_capture_immutable();

CREATE TABLE IF NOT EXISTS hs_quick_capture_revisions (
  capture_id uuid NOT NULL REFERENCES hs_quick_captures(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  body text NOT NULL,
  source_access text NOT NULL,
  actor_id text NOT NULL REFERENCES hs_users(id),
  operation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (capture_id, version)
);

CREATE OR REPLACE FUNCTION hs_quick_capture_revision_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Capture revisions are immutable'; END $$;

DROP TRIGGER IF EXISTS hs_quick_capture_revision_immutable ON hs_quick_capture_revisions;
CREATE TRIGGER hs_quick_capture_revision_immutable
  BEFORE UPDATE OR DELETE ON hs_quick_capture_revisions
  FOR EACH ROW EXECUTE FUNCTION hs_quick_capture_revision_immutable();

CREATE TABLE IF NOT EXISTS hs_quick_capture_drafts (
  tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
  actor_id text NOT NULL REFERENCES hs_users(id),
  draft_key text NOT NULL,
  base_version integer NOT NULL CHECK (base_version >= 0),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  operation_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, actor_id, draft_key)
);

CREATE TABLE IF NOT EXISTS hs_quick_capture_operations (
  actor_id text NOT NULL REFERENCES hs_users(id),
  operation_id uuid NOT NULL,
  request_hash text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (actor_id, operation_id)
);

CREATE OR REPLACE FUNCTION hs_quick_capture_operation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Capture operations are immutable'; END $$;

DROP TRIGGER IF EXISTS hs_quick_capture_operation_immutable ON hs_quick_capture_operations;
CREATE TRIGGER hs_quick_capture_operation_immutable
  BEFORE UPDATE OR DELETE ON hs_quick_capture_operations
  FOR EACH ROW EXECUTE FUNCTION hs_quick_capture_operation_immutable();

CREATE TABLE IF NOT EXISTS hs_quick_capture_previews (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
  actor_id text NOT NULL REFERENCES hs_users(id),
  expected_version integer NOT NULL CHECK (expected_version >= 0),
  seal text NOT NULL,
  detail jsonb NOT NULL CHECK (jsonb_typeof(detail) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE OR REPLACE FUNCTION hs_quick_capture_preview_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Capture previews are immutable'; END $$;

DROP TRIGGER IF EXISTS hs_quick_capture_preview_immutable ON hs_quick_capture_previews;
CREATE TRIGGER hs_quick_capture_preview_immutable
  BEFORE UPDATE OR DELETE ON hs_quick_capture_previews
  FOR EACH ROW EXECUTE FUNCTION hs_quick_capture_preview_immutable();

CREATE TABLE IF NOT EXISTS hs_quick_capture_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  capture_id uuid,
  action text NOT NULL,
  actor_id text NOT NULL REFERENCES hs_users(id),
  operation_id uuid NOT NULL,
  source text NOT NULL DEFAULT 'quick-capture',
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS hs_quick_capture_events_capture
  ON hs_quick_capture_events (tenant_id, capture_id, created_at);

CREATE OR REPLACE FUNCTION hs_quick_capture_event_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Capture events are immutable'; END $$;

DROP TRIGGER IF EXISTS hs_quick_capture_event_immutable ON hs_quick_capture_events;
CREATE TRIGGER hs_quick_capture_event_immutable
  BEFORE UPDATE OR DELETE ON hs_quick_capture_events
  FOR EACH ROW EXECUTE FUNCTION hs_quick_capture_event_immutable();
