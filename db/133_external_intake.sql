-- HOLY-107 controlled external intake forms.
-- A form lists schema-bound fields, validation, a private destination queue, and an explicit audience.
-- Sharing stays off. This file does not activate a form, grant access, or commit quarantined intake.
-- Anonymous intake is off unless an administrator writes an explicit policy row.
-- Naming a manager or saving configuration does not grant record, field, or page access.
-- Submissions stay in quarantine until a permitted review commits them.
-- A matching record name is never an update key.
-- This file does not update hs_data_periodic_review_schedules.
-- It does not alter parent_organisation_id. Re-running this file is safe.

CREATE TABLE IF NOT EXISTS hs_intake_form_managers (
  workspace_id text NOT NULL REFERENCES hs_workspaces(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES hs_users(id),
  granted_by text NOT NULL REFERENCES hs_users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE IF NOT EXISTS hs_intake_forms (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  name_search text GENERATED ALWAYS AS (lower(name)) STORED,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'disabled', 'expired', 'revoked')),
  sharing text NOT NULL DEFAULT 'off' CHECK (sharing = 'off'),
  activated boolean NOT NULL DEFAULT false CHECK (activated = false),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  cache_generation integer NOT NULL DEFAULT 1 CHECK (cache_generation > 0),
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  expires_at timestamptz NOT NULL,
  created_by text NOT NULL REFERENCES hs_users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, id)
);

CREATE INDEX IF NOT EXISTS hs_intake_forms_tenant
  ON hs_intake_forms (tenant_id, name_search, id);

CREATE OR REPLACE FUNCTION hs_intake_form_insert_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'draft' OR NEW.sharing <> 'off' OR NEW.activated <> false OR NEW.version <> 1 THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Intake forms are created as unactivated drafts';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS hs_intake_form_insert_guard ON hs_intake_forms;
CREATE TRIGGER hs_intake_form_insert_guard
  BEFORE INSERT ON hs_intake_forms
  FOR EACH ROW EXECUTE FUNCTION hs_intake_form_insert_guard();

CREATE OR REPLACE FUNCTION hs_intake_form_update_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.created_by <> OLD.created_by
     OR NEW.created_at <> OLD.created_at OR NEW.sharing <> 'off' OR NEW.sharing <> OLD.sharing
     OR NEW.activated <> false OR NEW.version < OLD.version OR NEW.cache_generation < OLD.cache_generation THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Intake form identity is immutable and activation stays off';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS hs_intake_form_update_guard ON hs_intake_forms;
CREATE TRIGGER hs_intake_form_update_guard
  BEFORE UPDATE ON hs_intake_forms
  FOR EACH ROW EXECUTE FUNCTION hs_intake_form_update_guard();

CREATE TABLE IF NOT EXISTS hs_intake_form_revisions (
  form_id uuid NOT NULL REFERENCES hs_intake_forms(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL CHECK (status IN ('draft', 'disabled', 'expired', 'revoked')),
  name text NOT NULL,
  definition jsonb NOT NULL,
  cache_generation integer NOT NULL CHECK (cache_generation > 0),
  action text NOT NULL,
  actor_id text NOT NULL REFERENCES hs_users(id),
  operation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (form_id, version)
);

CREATE OR REPLACE FUNCTION hs_intake_form_revision_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Intake form revisions are immutable'; END $$;

DROP TRIGGER IF EXISTS hs_intake_form_revision_immutable ON hs_intake_form_revisions;
CREATE TRIGGER hs_intake_form_revision_immutable
  BEFORE UPDATE OR DELETE ON hs_intake_form_revisions
  FOR EACH ROW EXECUTE FUNCTION hs_intake_form_revision_immutable();

CREATE TABLE IF NOT EXISTS hs_intake_form_drafts (
  tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
  actor_id text NOT NULL REFERENCES hs_users(id),
  form_key text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('configure', 'policy', 'submit', 'review', 'commit', 'actions')),
  base_version integer NOT NULL CHECK (base_version >= 0),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  operation_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, actor_id, form_key, kind)
);

CREATE TABLE IF NOT EXISTS hs_intake_form_operations (
  actor_id text NOT NULL REFERENCES hs_users(id),
  operation_id uuid NOT NULL,
  request_hash text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (actor_id, operation_id)
);

CREATE OR REPLACE FUNCTION hs_intake_form_operation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Intake form operations are immutable'; END $$;

DROP TRIGGER IF EXISTS hs_intake_form_operation_immutable ON hs_intake_form_operations;
CREATE TRIGGER hs_intake_form_operation_immutable
  BEFORE UPDATE OR DELETE ON hs_intake_form_operations
  FOR EACH ROW EXECUTE FUNCTION hs_intake_form_operation_immutable();

CREATE TABLE IF NOT EXISTS hs_intake_anonymous_policy (
  tenant_id uuid PRIMARY KEY REFERENCES hs_data_tenants(id),
  allowed boolean NOT NULL,
  version integer NOT NULL CHECK (version > 0),
  updated_by text NOT NULL REFERENCES hs_users(id),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS hs_intake_form_actor_sets (
  tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
  user_id text NOT NULL REFERENCES hs_users(id) ON DELETE CASCADE,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  PRIMARY KEY (tenant_id, user_id)
);

CREATE TABLE IF NOT EXISTS hs_intake_form_actor_actions (
  tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
  user_id text NOT NULL REFERENCES hs_users(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('configure', 'search', 'preview', 'download', 'history', 'disable', 'review', 'commit', 'policy', 'receipt')),
  granted_by text NOT NULL REFERENCES hs_users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, user_id, action)
);

CREATE TABLE IF NOT EXISTS hs_intake_form_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
  form_id uuid NOT NULL REFERENCES hs_intake_forms(id) ON DELETE CASCADE,
  action text NOT NULL,
  actor_id text NOT NULL REFERENCES hs_users(id),
  operation_id uuid NOT NULL,
  source text NOT NULL CHECK (source = 'intake-form'),
  cache_generation integer NOT NULL CHECK (cache_generation > 0),
  detail jsonb NOT NULL CHECK (jsonb_typeof(detail) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS hs_intake_form_events_form
  ON hs_intake_form_events (tenant_id, form_id, created_at, id);

CREATE OR REPLACE FUNCTION hs_intake_form_event_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Intake form events are immutable'; END $$;

DROP TRIGGER IF EXISTS hs_intake_form_event_immutable ON hs_intake_form_events;
CREATE TRIGGER hs_intake_form_event_immutable
  BEFORE UPDATE OR DELETE ON hs_intake_form_events
  FOR EACH ROW EXECUTE FUNCTION hs_intake_form_event_immutable();

CREATE TABLE IF NOT EXISTS hs_intake_challenges (
  token uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
  form_id uuid NOT NULL REFERENCES hs_intake_forms(id) ON DELETE CASCADE,
  used boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS hs_intake_rates (
  form_id uuid NOT NULL REFERENCES hs_intake_forms(id) ON DELETE CASCADE,
  subject_key text NOT NULL CHECK (char_length(subject_key) BETWEEN 1 AND 200),
  window_start timestamptz NOT NULL,
  count integer NOT NULL CHECK (count > 0),
  PRIMARY KEY (form_id, subject_key, window_start)
);

CREATE TABLE IF NOT EXISTS hs_intake_submissions (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
  form_id uuid NOT NULL REFERENCES hs_intake_forms(id) ON DELETE CASCADE,
  form_version integer NOT NULL CHECK (form_version > 0),
  queue_name text NOT NULL CHECK (char_length(btrim(queue_name)) BETWEEN 1 AND 41),
  actor_id text REFERENCES hs_users(id),
  anonymous boolean NOT NULL DEFAULT false,
  intent_token uuid NOT NULL,
  state text NOT NULL CHECK (state IN ('quarantine', 'reviewed', 'committed', 'fenced', 'rejected')),
  record_name text NOT NULL CHECK (char_length(btrim(record_name)) BETWEEN 1 AND 80),
  values jsonb NOT NULL CHECK (jsonb_typeof(values) = 'object'),
  consent_version integer,
  receipt_code text NOT NULL UNIQUE CHECK (char_length(receipt_code) BETWEEN 8 AND 80),
  request_hash text NOT NULL,
  operation_id uuid NOT NULL UNIQUE,
  committed_record_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (form_id, intent_token),
  CHECK ((anonymous = true AND actor_id IS NULL) OR (anonymous = false AND actor_id IS NOT NULL)),
  CHECK (committed_record_id IS NULL OR state = 'committed')
);

CREATE INDEX IF NOT EXISTS hs_intake_submissions_form
  ON hs_intake_submissions (tenant_id, form_id, state, created_at);

CREATE TABLE IF NOT EXISTS hs_intake_attachments (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
  submission_id uuid NOT NULL REFERENCES hs_intake_submissions(id) ON DELETE CASCADE,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 120),
  media_type text NOT NULL CHECK (char_length(media_type) BETWEEN 1 AND 80),
  byte_size integer NOT NULL CHECK (byte_size > 0),
  scan_state text NOT NULL CHECK (scan_state IN ('quarantine', 'clean', 'rejected')),
  quarantined boolean NOT NULL DEFAULT true CHECK (quarantined = true),
  fetched boolean NOT NULL DEFAULT false CHECK (fetched = false),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS hs_intake_attachments_submission
  ON hs_intake_attachments (submission_id, id);
