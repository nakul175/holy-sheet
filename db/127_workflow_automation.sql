-- HOLY-101 workflow automation builder.
-- Deterministic triggers, conditions, and actions only. No AI agent is stored
-- or invoked. New workflows are inserted as draft. This file does not update
-- hs_data_periodic_review_schedules and does not activate a schedule.
-- It does not alter parent_organisation_id or grant record, field, or page access.
-- Re-running this file is safe.

CREATE TABLE IF NOT EXISTS hs_workflow_managers (
  workspace_id text NOT NULL REFERENCES hs_workspaces(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES hs_users(id),
  granted_by text NOT NULL REFERENCES hs_users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE IF NOT EXISTS hs_workflows (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
  collection text NOT NULL,
  name text NOT NULL CHECK (char_length(btrim(name)) BETWEEN 1 AND 80),
  name_search text GENERATED ALWAYS AS (lower(name)) STORED,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'paused', 'active')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  definition jsonb NOT NULL CHECK (jsonb_typeof(definition) = 'object'),
  created_by text NOT NULL REFERENCES hs_users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, collection, name_search),
  FOREIGN KEY (tenant_id, collection) REFERENCES hs_data_collections(tenant_id, id)
);

CREATE INDEX IF NOT EXISTS hs_workflows_tenant
  ON hs_workflows (tenant_id, collection, name_search, id);

CREATE OR REPLACE FUNCTION hs_workflow_identity_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.collection <> OLD.collection
     OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Workflow identity is immutable';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS hs_workflow_identity_guard ON hs_workflows;
CREATE TRIGGER hs_workflow_identity_guard
  BEFORE UPDATE ON hs_workflows
  FOR EACH ROW EXECUTE FUNCTION hs_workflow_identity_guard();

CREATE OR REPLACE FUNCTION hs_workflow_insert_draft() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status <> 'draft' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Workflows are created as drafts and stay paused until an explicit activation';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS hs_workflow_insert_draft ON hs_workflows;
CREATE TRIGGER hs_workflow_insert_draft
  BEFORE INSERT ON hs_workflows
  FOR EACH ROW EXECUTE FUNCTION hs_workflow_insert_draft();

CREATE TABLE IF NOT EXISTS hs_workflow_revisions (
  workflow_id uuid NOT NULL REFERENCES hs_workflows(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL CHECK (status IN ('draft', 'paused', 'active')),
  definition jsonb NOT NULL,
  action text NOT NULL,
  actor_id text NOT NULL REFERENCES hs_users(id),
  operation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workflow_id, version)
);

CREATE OR REPLACE FUNCTION hs_workflow_revision_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Workflow revisions are immutable'; END $$;

DROP TRIGGER IF EXISTS hs_workflow_revision_immutable ON hs_workflow_revisions;
CREATE TRIGGER hs_workflow_revision_immutable
  BEFORE UPDATE OR DELETE ON hs_workflow_revisions
  FOR EACH ROW EXECUTE FUNCTION hs_workflow_revision_immutable();

CREATE TABLE IF NOT EXISTS hs_workflow_drafts (
  workflow_id uuid NOT NULL REFERENCES hs_workflows(id) ON DELETE CASCADE,
  actor_id text NOT NULL REFERENCES hs_users(id),
  base_version integer NOT NULL CHECK (base_version > 0),
  definition jsonb NOT NULL,
  operation_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workflow_id, actor_id)
);

CREATE TABLE IF NOT EXISTS hs_workflow_operations (
  actor_id text NOT NULL REFERENCES hs_users(id),
  operation_id uuid NOT NULL,
  request_hash text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (actor_id, operation_id)
);

CREATE OR REPLACE FUNCTION hs_workflow_operation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Workflow operations are immutable'; END $$;

DROP TRIGGER IF EXISTS hs_workflow_operation_immutable ON hs_workflow_operations;
CREATE TRIGGER hs_workflow_operation_immutable
  BEFORE UPDATE OR DELETE ON hs_workflow_operations
  FOR EACH ROW EXECUTE FUNCTION hs_workflow_operation_immutable();

CREATE TABLE IF NOT EXISTS hs_workflow_previews (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
  actor_id text NOT NULL REFERENCES hs_users(id),
  workflow_id uuid NOT NULL REFERENCES hs_workflows(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('activate', 'pause', 'version-change', 'rollback', 'replay', 'dry-run')),
  workflow_version integer NOT NULL CHECK (workflow_version > 0),
  seal text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE OR REPLACE FUNCTION hs_workflow_preview_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Workflow impact reviews are immutable'; END $$;

DROP TRIGGER IF EXISTS hs_workflow_preview_immutable ON hs_workflow_previews;
CREATE TRIGGER hs_workflow_preview_immutable
  BEFORE UPDATE OR DELETE ON hs_workflow_previews
  FOR EACH ROW EXECUTE FUNCTION hs_workflow_preview_immutable();

CREATE TABLE IF NOT EXISTS hs_workflow_runs (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
  workflow_id uuid NOT NULL REFERENCES hs_workflows(id),
  revision integer NOT NULL CHECK (revision > 0),
  record_id uuid NOT NULL,
  event text NOT NULL,
  event_field text,
  event_key text NOT NULL,
  source_key text NOT NULL,
  depth integer NOT NULL CHECK (depth BETWEEN 1 AND 11),
  status text NOT NULL CHECK (status IN ('running', 'retrying', 'completed', 'dead-letter')),
  outcome text NOT NULL,
  attempt integer NOT NULL CHECK (attempt BETWEEN 1 AND 3),
  next_attempt_at timestamptz,
  replay_of uuid,
  operation_id uuid NOT NULL,
  identity_kind text NOT NULL CHECK (identity_kind IN ('delegated', 'service')),
  identity_subject text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, event_key),
  FOREIGN KEY (tenant_id, record_id) REFERENCES hs_data_records(tenant_id, id)
);

CREATE INDEX IF NOT EXISTS hs_workflow_runs_workflow
  ON hs_workflow_runs (tenant_id, workflow_id, created_at);

DO $$ BEGIN
  ALTER TABLE hs_workflow_runs
    ADD CONSTRAINT hs_workflow_runs_replay
    FOREIGN KEY (replay_of) REFERENCES hs_workflow_runs(id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS hs_workflow_steps (
  step_key text PRIMARY KEY,
  tenant_id uuid NOT NULL,
  run_id uuid NOT NULL REFERENCES hs_workflow_runs(id),
  action_index integer NOT NULL CHECK (action_index >= 0 AND action_index < 8),
  outcome text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE OR REPLACE FUNCTION hs_workflow_step_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Workflow steps are immutable'; END $$;

DROP TRIGGER IF EXISTS hs_workflow_step_immutable ON hs_workflow_steps;
CREATE TRIGGER hs_workflow_step_immutable
  BEFORE UPDATE OR DELETE ON hs_workflow_steps
  FOR EACH ROW EXECUTE FUNCTION hs_workflow_step_immutable();

CREATE TABLE IF NOT EXISTS hs_workflow_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  workflow_id uuid,
  run_id uuid,
  action text NOT NULL,
  actor_id text NOT NULL REFERENCES hs_users(id),
  operation_id uuid NOT NULL,
  source text NOT NULL DEFAULT 'workflow-automation',
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS hs_workflow_events_workflow
  ON hs_workflow_events (tenant_id, workflow_id, created_at);

CREATE OR REPLACE FUNCTION hs_workflow_event_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Workflow events are immutable'; END $$;

DROP TRIGGER IF EXISTS hs_workflow_event_immutable ON hs_workflow_events;
CREATE TRIGGER hs_workflow_event_immutable
  BEFORE UPDATE OR DELETE ON hs_workflow_events
  FOR EACH ROW EXECUTE FUNCTION hs_workflow_event_immutable();
