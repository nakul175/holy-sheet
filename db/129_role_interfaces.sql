-- HOLY-103 role interfaces.
-- Screens compose approved lists, details, forms, charts, and buttons.
-- A role assignment is presentation only. It does not grant record, field,
-- collection, or page access, and it does not share an interface publicly.
-- New interfaces are inserted as draft. This file does not update
-- hs_data_periodic_review_schedules and does not activate a schedule.
-- It does not alter parent_organisation_id. Re-running this file is safe.

CREATE TABLE IF NOT EXISTS hs_role_interface_managers (
  workspace_id text NOT NULL REFERENCES hs_workspaces(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES hs_users(id),
  granted_by text NOT NULL REFERENCES hs_users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE IF NOT EXISTS hs_role_interfaces (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  name_search text GENERATED ALWAYS AS (lower(name)) STORED,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'preview', 'published')),
  sharing text NOT NULL DEFAULT 'private' CHECK (sharing = 'private'),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  created_by text NOT NULL REFERENCES hs_users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, name_search)
);

CREATE INDEX IF NOT EXISTS hs_role_interfaces_tenant
  ON hs_role_interfaces (tenant_id, name_search, id);

CREATE OR REPLACE FUNCTION hs_role_interface_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.created_by <> OLD.created_by
     OR NEW.created_at <> OLD.created_at OR NEW.sharing <> OLD.sharing OR NEW.sharing <> 'private' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Interface identity is immutable and interfaces stay private';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS hs_role_interface_identity_guard ON hs_role_interfaces;
CREATE TRIGGER hs_role_interface_identity_guard
  BEFORE UPDATE ON hs_role_interfaces
  FOR EACH ROW EXECUTE FUNCTION hs_role_interface_identity_guard();

CREATE OR REPLACE FUNCTION hs_role_interface_insert_draft() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'draft' OR NEW.sharing <> 'private' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Interfaces are created as private drafts and are not shared publicly';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS hs_role_interface_insert_draft ON hs_role_interfaces;
CREATE TRIGGER hs_role_interface_insert_draft
  BEFORE INSERT ON hs_role_interfaces
  FOR EACH ROW EXECUTE FUNCTION hs_role_interface_insert_draft();

CREATE TABLE IF NOT EXISTS hs_role_interface_revisions (
  interface_id uuid NOT NULL REFERENCES hs_role_interfaces(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL CHECK (status IN ('draft', 'preview', 'published')),
  name text NOT NULL,
  definition jsonb NOT NULL,
  action text NOT NULL,
  actor_id text NOT NULL REFERENCES hs_users(id),
  operation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (interface_id, version)
);

CREATE OR REPLACE FUNCTION hs_role_interface_revision_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Interface revisions are immutable'; END $$;

DROP TRIGGER IF EXISTS hs_role_interface_revision_immutable ON hs_role_interface_revisions;
CREATE TRIGGER hs_role_interface_revision_immutable
  BEFORE UPDATE OR DELETE ON hs_role_interface_revisions
  FOR EACH ROW EXECUTE FUNCTION hs_role_interface_revision_immutable();

CREATE TABLE IF NOT EXISTS hs_role_interface_drafts (
  interface_id uuid NOT NULL REFERENCES hs_role_interfaces(id) ON DELETE CASCADE,
  actor_id text NOT NULL REFERENCES hs_users(id),
  base_version integer NOT NULL CHECK (base_version > 0),
  definition jsonb NOT NULL,
  operation_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (interface_id, actor_id)
);

CREATE TABLE IF NOT EXISTS hs_role_interface_operations (
  actor_id text NOT NULL REFERENCES hs_users(id),
  operation_id uuid NOT NULL,
  request_hash text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (actor_id, operation_id)
);

CREATE OR REPLACE FUNCTION hs_role_interface_operation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Interface operations are immutable'; END $$;

DROP TRIGGER IF EXISTS hs_role_interface_operation_immutable ON hs_role_interface_operations;
CREATE TRIGGER hs_role_interface_operation_immutable
  BEFORE UPDATE OR DELETE ON hs_role_interface_operations
  FOR EACH ROW EXECUTE FUNCTION hs_role_interface_operation_immutable();

CREATE TABLE IF NOT EXISTS hs_role_interface_previews (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
  actor_id text NOT NULL REFERENCES hs_users(id),
  interface_id uuid NOT NULL REFERENCES hs_role_interfaces(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('stage', 'publish', 'version-change', 'rollback', 'submit')),
  interface_version integer NOT NULL CHECK (interface_version > 0),
  seal text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE OR REPLACE FUNCTION hs_role_interface_preview_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Interface impact reviews are immutable'; END $$;

DROP TRIGGER IF EXISTS hs_role_interface_preview_immutable ON hs_role_interface_previews;
CREATE TRIGGER hs_role_interface_preview_immutable
  BEFORE UPDATE OR DELETE ON hs_role_interface_previews
  FOR EACH ROW EXECUTE FUNCTION hs_role_interface_preview_immutable();

CREATE TABLE IF NOT EXISTS hs_role_interface_roles (
  interface_id uuid NOT NULL REFERENCES hs_role_interfaces(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'admin', 'member', 'observer')),
  assigned_by text NOT NULL REFERENCES hs_users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (interface_id, role)
);

CREATE TABLE IF NOT EXISTS hs_role_interface_submissions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
  interface_id uuid NOT NULL REFERENCES hs_role_interfaces(id),
  component_id text NOT NULL,
  record_id uuid NOT NULL,
  record_version integer NOT NULL CHECK (record_version > 0),
  operation_id uuid NOT NULL,
  actor_id text NOT NULL REFERENCES hs_users(id),
  source text NOT NULL DEFAULT 'role-interface',
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (actor_id, operation_id),
  FOREIGN KEY (tenant_id, record_id) REFERENCES hs_data_records(tenant_id, id)
);

CREATE INDEX IF NOT EXISTS hs_role_interface_submissions_interface
  ON hs_role_interface_submissions (tenant_id, interface_id, created_at);

CREATE OR REPLACE FUNCTION hs_role_interface_submission_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Interface submissions are immutable'; END $$;

DROP TRIGGER IF EXISTS hs_role_interface_submission_immutable ON hs_role_interface_submissions;
CREATE TRIGGER hs_role_interface_submission_immutable
  BEFORE UPDATE OR DELETE ON hs_role_interface_submissions
  FOR EACH ROW EXECUTE FUNCTION hs_role_interface_submission_immutable();

CREATE TABLE IF NOT EXISTS hs_role_interface_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  interface_id uuid,
  submission_id uuid,
  action text NOT NULL,
  actor_id text NOT NULL REFERENCES hs_users(id),
  operation_id uuid NOT NULL,
  source text NOT NULL DEFAULT 'role-interface',
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS hs_role_interface_events_interface
  ON hs_role_interface_events (tenant_id, interface_id, created_at);

CREATE OR REPLACE FUNCTION hs_role_interface_event_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Interface events are immutable'; END $$;

DROP TRIGGER IF EXISTS hs_role_interface_event_immutable ON hs_role_interface_events;
CREATE TRIGGER hs_role_interface_event_immutable
  BEFORE UPDATE OR DELETE ON hs_role_interface_events
  FOR EACH ROW EXECUTE FUNCTION hs_role_interface_event_immutable();

ALTER TABLE hs_data_schema_dependencies ADD COLUMN IF NOT EXISTS interface_id uuid;

DO $$ BEGIN
  ALTER TABLE hs_data_schema_dependencies
    ADD CONSTRAINT hs_data_schema_dependencies_interface_id_fkey
    FOREIGN KEY (interface_id) REFERENCES hs_role_interfaces(id) ON DELETE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

ALTER TABLE hs_data_schema_dependencies DROP CONSTRAINT IF EXISTS hs_data_schema_dependencies_kind_check;
ALTER TABLE hs_data_schema_dependencies ADD CONSTRAINT hs_data_schema_dependencies_kind_check CHECK (kind IN ('view', 'import-mapping', 'integration', 'reference-policy', 'template', 'intake', 'review', 'quality', 'periodic-review', 'interface'));
