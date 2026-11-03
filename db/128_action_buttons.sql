-- HOLY-102 reusable action buttons.
-- Allowlisted Holy Sheet action contracts only. No script, URL, or schedule is
-- stored or started. New buttons are inserted as draft. This file does not
-- update hs_data_periodic_review_schedules and does not activate a schedule.
-- It does not alter parent_organisation_id or grant record, field, or page access.
-- Re-running this file is safe.

CREATE TABLE IF NOT EXISTS hs_action_button_managers (
  workspace_id text NOT NULL REFERENCES hs_workspaces(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES hs_users(id),
  granted_by text NOT NULL REFERENCES hs_users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE IF NOT EXISTS hs_action_buttons (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
  collection text NOT NULL,
  label text NOT NULL CHECK (char_length(btrim(label)) BETWEEN 1 AND 80),
  label_search text GENERATED ALWAYS AS (lower(label)) STORED,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'paused', 'active')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  created_by text NOT NULL REFERENCES hs_users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, collection, label_search),
  FOREIGN KEY (tenant_id, collection) REFERENCES hs_data_collections(tenant_id, id)
);

CREATE INDEX IF NOT EXISTS hs_action_buttons_tenant
  ON hs_action_buttons (tenant_id, collection, label_search, id);

CREATE OR REPLACE FUNCTION hs_action_button_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.collection <> OLD.collection
     OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Action button identity is immutable';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS hs_action_button_identity_guard ON hs_action_buttons;
CREATE TRIGGER hs_action_button_identity_guard
  BEFORE UPDATE ON hs_action_buttons
  FOR EACH ROW EXECUTE FUNCTION hs_action_button_identity_guard();

CREATE OR REPLACE FUNCTION hs_action_button_insert_draft() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'draft' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Action buttons are created as drafts and stay paused until an explicit activation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS hs_action_button_insert_draft ON hs_action_buttons;
CREATE TRIGGER hs_action_button_insert_draft
  BEFORE INSERT ON hs_action_buttons
  FOR EACH ROW EXECUTE FUNCTION hs_action_button_insert_draft();

CREATE TABLE IF NOT EXISTS hs_action_button_revisions (
  button_id uuid NOT NULL REFERENCES hs_action_buttons(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL CHECK (status IN ('draft', 'paused', 'active')),
  label text NOT NULL,
  definition jsonb NOT NULL,
  action text NOT NULL,
  actor_id text NOT NULL REFERENCES hs_users(id),
  operation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (button_id, version)
);

CREATE OR REPLACE FUNCTION hs_action_button_revision_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Action button revisions are immutable'; END $$;

DROP TRIGGER IF EXISTS hs_action_button_revision_immutable ON hs_action_button_revisions;
CREATE TRIGGER hs_action_button_revision_immutable
  BEFORE UPDATE OR DELETE ON hs_action_button_revisions
  FOR EACH ROW EXECUTE FUNCTION hs_action_button_revision_immutable();

CREATE TABLE IF NOT EXISTS hs_action_button_drafts (
  button_id uuid NOT NULL REFERENCES hs_action_buttons(id) ON DELETE CASCADE,
  actor_id text NOT NULL REFERENCES hs_users(id),
  base_version integer NOT NULL CHECK (base_version > 0),
  definition jsonb NOT NULL,
  operation_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (button_id, actor_id)
);

CREATE TABLE IF NOT EXISTS hs_action_button_operations (
  actor_id text NOT NULL REFERENCES hs_users(id),
  operation_id uuid NOT NULL,
  request_hash text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (actor_id, operation_id)
);

CREATE OR REPLACE FUNCTION hs_action_button_operation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Action button operations are immutable'; END $$;

DROP TRIGGER IF EXISTS hs_action_button_operation_immutable ON hs_action_button_operations;
CREATE TRIGGER hs_action_button_operation_immutable
  BEFORE UPDATE OR DELETE ON hs_action_button_operations
  FOR EACH ROW EXECUTE FUNCTION hs_action_button_operation_immutable();

CREATE TABLE IF NOT EXISTS hs_action_button_previews (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
  actor_id text NOT NULL REFERENCES hs_users(id),
  button_id uuid NOT NULL REFERENCES hs_action_buttons(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('activate', 'pause', 'version-change', 'rollback', 'invoke')),
  button_version integer NOT NULL CHECK (button_version > 0),
  seal text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE OR REPLACE FUNCTION hs_action_button_preview_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Action button impact reviews are immutable'; END $$;

DROP TRIGGER IF EXISTS hs_action_button_preview_immutable ON hs_action_button_previews;
CREATE TRIGGER hs_action_button_preview_immutable
  BEFORE UPDATE OR DELETE ON hs_action_button_previews
  FOR EACH ROW EXECUTE FUNCTION hs_action_button_preview_immutable();

CREATE TABLE IF NOT EXISTS hs_action_button_receipts (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
  button_id uuid NOT NULL REFERENCES hs_action_buttons(id),
  revision integer NOT NULL CHECK (revision > 0),
  record_id uuid NOT NULL,
  operation_id uuid NOT NULL,
  actor_id text NOT NULL REFERENCES hs_users(id),
  action_id text NOT NULL,
  action_status text NOT NULL CHECK (action_status IN ('succeeded', 'failed')),
  link_status text NOT NULL CHECK (link_status IN ('none', 'succeeded', 'failed')),
  link_error text,
  follows uuid,
  source text NOT NULL DEFAULT 'action-button',
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (actor_id, operation_id),
  FOREIGN KEY (tenant_id, record_id) REFERENCES hs_data_records(tenant_id, id)
);

CREATE INDEX IF NOT EXISTS hs_action_button_receipts_button
  ON hs_action_button_receipts (tenant_id, button_id, created_at);

DO $$ BEGIN
  ALTER TABLE hs_action_button_receipts
    ADD CONSTRAINT hs_action_button_receipts_follows
    FOREIGN KEY (follows) REFERENCES hs_action_button_receipts(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE OR REPLACE FUNCTION hs_action_button_receipt_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Action button receipts are immutable'; END $$;

DROP TRIGGER IF EXISTS hs_action_button_receipt_immutable ON hs_action_button_receipts;
CREATE TRIGGER hs_action_button_receipt_immutable
  BEFORE UPDATE OR DELETE ON hs_action_button_receipts
  FOR EACH ROW EXECUTE FUNCTION hs_action_button_receipt_immutable();

CREATE TABLE IF NOT EXISTS hs_action_button_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  button_id uuid,
  receipt_id uuid,
  action text NOT NULL,
  actor_id text NOT NULL REFERENCES hs_users(id),
  operation_id uuid NOT NULL,
  source text NOT NULL DEFAULT 'action-button',
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS hs_action_button_events_button
  ON hs_action_button_events (tenant_id, button_id, created_at);

CREATE OR REPLACE FUNCTION hs_action_button_event_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Action button events are immutable'; END $$;

DROP TRIGGER IF EXISTS hs_action_button_event_immutable ON hs_action_button_events;
CREATE TRIGGER hs_action_button_event_immutable
  BEFORE UPDATE OR DELETE ON hs_action_button_events
  FOR EACH ROW EXECUTE FUNCTION hs_action_button_event_immutable();
