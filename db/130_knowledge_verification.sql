-- HOLY-104 knowledge verification badges.
-- A badge is a steward attestation of one published page or record revision.
-- It records an owner, a basis, and an expiry of 1–365 days.
-- It is not an AI truth score and it is not a legal certification.
-- Title-only policy is preserve: a title or record-name change keeps the badge
-- current. A body change or a recorded source change marks the badge stale.
-- Naming a steward, saving policy, or granting an action does not grant access
-- to a page, record, collection, or field.
-- This file does not update hs_data_periodic_review_schedules.
-- It does not alter parent_organisation_id. Re-running this file is safe.

CREATE TABLE IF NOT EXISTS hs_knowledge_verification_stewards (
  workspace_id text NOT NULL REFERENCES hs_workspaces(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES hs_users(id),
  granted_by text NOT NULL REFERENCES hs_users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE IF NOT EXISTS hs_knowledge_verification_policies (
  tenant_id uuid PRIMARY KEY REFERENCES hs_data_tenants(id),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  title_only text NOT NULL DEFAULT 'preserve' CHECK (title_only = 'preserve'),
  bases jsonb NOT NULL CHECK (jsonb_typeof(bases) = 'array'),
  default_expiry_days integer NOT NULL DEFAULT 90 CHECK (default_expiry_days BETWEEN 1 AND 365),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE OR REPLACE FUNCTION hs_knowledge_verification_policy_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.tenant_id <> OLD.tenant_id OR NEW.title_only <> 'preserve' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Verification policy identity is immutable and title-only changes keep the badge';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS hs_knowledge_verification_policy_guard ON hs_knowledge_verification_policies;
CREATE TRIGGER hs_knowledge_verification_policy_guard
  BEFORE UPDATE ON hs_knowledge_verification_policies
  FOR EACH ROW EXECUTE FUNCTION hs_knowledge_verification_policy_guard();

CREATE TABLE IF NOT EXISTS hs_knowledge_verification_policy_revisions (
  tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
  version integer NOT NULL CHECK (version > 0),
  bases jsonb NOT NULL,
  default_expiry_days integer NOT NULL,
  actor_id text NOT NULL REFERENCES hs_users(id),
  operation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, version)
);

CREATE OR REPLACE FUNCTION hs_knowledge_verification_policy_revision_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Verification policy revisions are immutable'; END $$;

DROP TRIGGER IF EXISTS hs_knowledge_verification_policy_revision_immutable ON hs_knowledge_verification_policy_revisions;
CREATE TRIGGER hs_knowledge_verification_policy_revision_immutable
  BEFORE UPDATE OR DELETE ON hs_knowledge_verification_policy_revisions
  FOR EACH ROW EXECUTE FUNCTION hs_knowledge_verification_policy_revision_immutable();

CREATE TABLE IF NOT EXISTS hs_knowledge_verification_policy_drafts (
  tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
  actor_id text NOT NULL REFERENCES hs_users(id),
  base_version integer NOT NULL CHECK (base_version >= 0),
  bases jsonb NOT NULL,
  default_expiry_days integer NOT NULL,
  operation_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, actor_id)
);

CREATE TABLE IF NOT EXISTS hs_knowledge_verification_field_policy (
  tenant_id uuid PRIMARY KEY REFERENCES hs_data_tenants(id),
  sensitive boolean NOT NULL DEFAULT false,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0)
);

CREATE TABLE IF NOT EXISTS hs_knowledge_verification_field_access (
  tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
  user_id text NOT NULL REFERENCES hs_users(id) ON DELETE CASCADE,
  can_view boolean NOT NULL DEFAULT false,
  can_write boolean NOT NULL DEFAULT false,
  can_history boolean NOT NULL DEFAULT false,
  PRIMARY KEY (tenant_id, user_id)
);

CREATE TABLE IF NOT EXISTS hs_knowledge_verification_action_sets (
  tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
  user_id text NOT NULL REFERENCES hs_users(id) ON DELETE CASCADE,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  PRIMARY KEY (tenant_id, user_id)
);

CREATE TABLE IF NOT EXISTS hs_knowledge_verification_actions (
  tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
  user_id text NOT NULL REFERENCES hs_users(id) ON DELETE CASCADE,
  action text NOT NULL CHECK (action IN ('verify', 'renew', 'revoke', 'report', 'download', 'history', 'configure')),
  granted_by text NOT NULL REFERENCES hs_users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, user_id, action)
);

CREATE TABLE IF NOT EXISTS hs_knowledge_verification_badges (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
  target_kind text NOT NULL CHECK (target_kind IN ('page', 'record')),
  target_id text NOT NULL CHECK (char_length(target_id) BETWEEN 1 AND 200),
  revision_version integer NOT NULL CHECK (revision_version > 0),
  published_ref text NOT NULL,
  title_hash text NOT NULL,
  content_hash text NOT NULL,
  source_hash text NOT NULL,
  title_only text NOT NULL DEFAULT 'preserve' CHECK (title_only = 'preserve'),
  owner_id text NOT NULL REFERENCES hs_users(id),
  basis text NOT NULL,
  basis_note text NOT NULL,
  expiry_days integer NOT NULL CHECK (expiry_days BETWEEN 1 AND 365),
  expires_at timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'current' CHECK (status IN ('current', 'stale', 'revoked')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  verified_by text NOT NULL REFERENCES hs_users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (tenant_id, target_kind, target_id)
);

CREATE INDEX IF NOT EXISTS hs_knowledge_verification_badges_tenant
  ON hs_knowledge_verification_badges (tenant_id, updated_at DESC, id);

CREATE OR REPLACE FUNCTION hs_knowledge_verification_badge_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.target_kind <> OLD.target_kind
     OR NEW.target_id <> OLD.target_id OR NEW.created_at <> OLD.created_at
     OR NEW.title_only <> 'preserve' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Verification badge identity is immutable';
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS hs_knowledge_verification_badge_guard ON hs_knowledge_verification_badges;
CREATE TRIGGER hs_knowledge_verification_badge_guard
  BEFORE UPDATE ON hs_knowledge_verification_badges
  FOR EACH ROW EXECUTE FUNCTION hs_knowledge_verification_badge_guard();

CREATE TABLE IF NOT EXISTS hs_knowledge_verification_revisions (
  badge_id uuid NOT NULL REFERENCES hs_knowledge_verification_badges(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  status text NOT NULL,
  revision_version integer NOT NULL,
  published_ref text NOT NULL,
  title_hash text NOT NULL,
  content_hash text NOT NULL,
  source_hash text NOT NULL,
  owner_id text NOT NULL,
  basis text NOT NULL,
  basis_note text NOT NULL,
  expiry_days integer NOT NULL,
  expires_at timestamptz NOT NULL,
  action text NOT NULL,
  actor_id text NOT NULL REFERENCES hs_users(id),
  operation_id uuid NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (badge_id, version)
);

CREATE OR REPLACE FUNCTION hs_knowledge_verification_revision_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Verification revisions are immutable'; END $$;

DROP TRIGGER IF EXISTS hs_knowledge_verification_revision_immutable ON hs_knowledge_verification_revisions;
CREATE TRIGGER hs_knowledge_verification_revision_immutable
  BEFORE UPDATE OR DELETE ON hs_knowledge_verification_revisions
  FOR EACH ROW EXECUTE FUNCTION hs_knowledge_verification_revision_immutable();

CREATE TABLE IF NOT EXISTS hs_knowledge_verification_drafts (
  tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
  actor_id text NOT NULL REFERENCES hs_users(id),
  target_kind text NOT NULL CHECK (target_kind IN ('page', 'record')),
  target_id text NOT NULL,
  base_version integer NOT NULL CHECK (base_version >= 0),
  payload jsonb NOT NULL CHECK (jsonb_typeof(payload) = 'object'),
  operation_id uuid NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (tenant_id, actor_id, target_kind, target_id)
);

CREATE TABLE IF NOT EXISTS hs_knowledge_verification_operations (
  actor_id text NOT NULL REFERENCES hs_users(id),
  operation_id uuid NOT NULL,
  request_hash text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (actor_id, operation_id)
);

CREATE OR REPLACE FUNCTION hs_knowledge_verification_operation_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Verification operations are immutable'; END $$;

DROP TRIGGER IF EXISTS hs_knowledge_verification_operation_immutable ON hs_knowledge_verification_operations;
CREATE TRIGGER hs_knowledge_verification_operation_immutable
  BEFORE UPDATE OR DELETE ON hs_knowledge_verification_operations
  FOR EACH ROW EXECUTE FUNCTION hs_knowledge_verification_operation_immutable();

CREATE TABLE IF NOT EXISTS hs_knowledge_verification_previews (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
  actor_id text NOT NULL REFERENCES hs_users(id),
  action text NOT NULL CHECK (action IN ('verify', 'renew', 'revoke')),
  badge_id uuid,
  target_kind text NOT NULL CHECK (target_kind IN ('page', 'record')),
  target_id text NOT NULL,
  expected_version integer NOT NULL CHECK (expected_version >= 0),
  seal text NOT NULL,
  detail jsonb NOT NULL CHECK (jsonb_typeof(detail) = 'object'),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE OR REPLACE FUNCTION hs_knowledge_verification_preview_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Verification impact reviews are immutable'; END $$;

DROP TRIGGER IF EXISTS hs_knowledge_verification_preview_immutable ON hs_knowledge_verification_previews;
CREATE TRIGGER hs_knowledge_verification_preview_immutable
  BEFORE UPDATE OR DELETE ON hs_knowledge_verification_previews
  FOR EACH ROW EXECUTE FUNCTION hs_knowledge_verification_preview_immutable();

CREATE TABLE IF NOT EXISTS hs_knowledge_verification_events (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL,
  badge_id uuid,
  action text NOT NULL,
  actor_id text NOT NULL REFERENCES hs_users(id),
  operation_id uuid NOT NULL,
  source text NOT NULL DEFAULT 'knowledge-verification',
  detail jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE INDEX IF NOT EXISTS hs_knowledge_verification_events_badge
  ON hs_knowledge_verification_events (tenant_id, badge_id, created_at);

CREATE OR REPLACE FUNCTION hs_knowledge_verification_event_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Verification events are immutable'; END $$;

DROP TRIGGER IF EXISTS hs_knowledge_verification_event_immutable ON hs_knowledge_verification_events;
CREATE TRIGGER hs_knowledge_verification_event_immutable
  BEFORE UPDATE OR DELETE ON hs_knowledge_verification_events
  FOR EACH ROW EXECUTE FUNCTION hs_knowledge_verification_event_immutable();

CREATE TABLE IF NOT EXISTS hs_knowledge_verification_concerns (
  id uuid PRIMARY KEY,
  tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
  badge_id uuid NOT NULL REFERENCES hs_knowledge_verification_badges(id) ON DELETE CASCADE,
  actor_id text NOT NULL REFERENCES hs_users(id),
  operation_id uuid NOT NULL,
  reason text NOT NULL CHECK (char_length(btrim(reason)) BETWEEN 1 AND 500),
  source text NOT NULL DEFAULT 'knowledge-verification',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (actor_id, operation_id)
);

CREATE OR REPLACE FUNCTION hs_knowledge_verification_concern_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Verification concerns are immutable'; END $$;

DROP TRIGGER IF EXISTS hs_knowledge_verification_concern_immutable ON hs_knowledge_verification_concerns;
CREATE TRIGGER hs_knowledge_verification_concern_immutable
  BEFORE UPDATE OR DELETE ON hs_knowledge_verification_concerns
  FOR EACH ROW EXECUTE FUNCTION hs_knowledge_verification_concern_immutable();
