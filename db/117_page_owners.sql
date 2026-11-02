-- HOLY-91 page owners and handover (wiki W6.3). Ownership is not a grant.
-- Manage rights still come from the existing owner/admin role mapping.
-- Jobs are resumable and idempotent: a settled item is not applied again.

CREATE INDEX IF NOT EXISTS hs_pages_workspace_owner ON hs_pages(workspace_id, owner_id);

CREATE TABLE IF NOT EXISTS hs_page_owner_operations (
  page_id text NOT NULL REFERENCES hs_pages(id) ON DELETE CASCADE,
  operation_id uuid NOT NULL,
  actor_id text NOT NULL REFERENCES hs_users(id),
  request_hash text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (page_id, operation_id)
);

CREATE TABLE IF NOT EXISTS hs_handover_jobs (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES hs_workspaces(id),
  actor_id text NOT NULL REFERENCES hs_users(id),
  operation_id uuid NOT NULL,
  request_hash text NOT NULL,
  from_user_id text REFERENCES hs_users(id),
  to_user_id text NOT NULL REFERENCES hs_users(id),
  include_trashed boolean NOT NULL DEFAULT false,
  kind text NOT NULL CHECK (kind IN ('handover', 'ownerless')),
  state text NOT NULL CHECK (state IN ('running', 'completed')),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  UNIQUE (workspace_id, actor_id, operation_id)
);
CREATE INDEX IF NOT EXISTS hs_handover_jobs_actor ON hs_handover_jobs(workspace_id, actor_id, created_at DESC);

CREATE TABLE IF NOT EXISTS hs_handover_items (
  job_id uuid NOT NULL REFERENCES hs_handover_jobs(id) ON DELETE CASCADE,
  page_id text NOT NULL REFERENCES hs_pages(id) ON DELETE CASCADE,
  ordinal integer NOT NULL CHECK (ordinal > 0),
  trashed boolean NOT NULL,
  had_edit boolean NOT NULL,
  decision text NOT NULL CHECK (decision IN ('transfer', 'grant', 'skip')),
  expected_owner_id text NOT NULL REFERENCES hs_users(id),
  disposition text NOT NULL DEFAULT 'pending' CHECK (disposition IN ('pending', 'transferred', 'granted', 'skipped', 'failed')),
  code text CHECK (code IS NULL OR char_length(code) BETWEEN 1 AND 80),
  PRIMARY KEY (job_id, page_id),
  UNIQUE (job_id, ordinal)
);
CREATE INDEX IF NOT EXISTS hs_handover_items_pending ON hs_handover_items(job_id, ordinal) WHERE disposition = 'pending';

CREATE TABLE IF NOT EXISTS hs_handover_operations (
  workspace_id text NOT NULL REFERENCES hs_workspaces(id),
  actor_id text NOT NULL REFERENCES hs_users(id),
  operation_id uuid NOT NULL,
  request_hash text NOT NULL,
  job_id uuid REFERENCES hs_handover_jobs(id),
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, actor_id, operation_id)
);

CREATE OR REPLACE FUNCTION hs_handover_job_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.id <> OLD.id OR NEW.workspace_id <> OLD.workspace_id OR NEW.actor_id <> OLD.actor_id
     OR NEW.operation_id <> OLD.operation_id OR NEW.request_hash <> OLD.request_hash
     OR NEW.from_user_id IS DISTINCT FROM OLD.from_user_id OR NEW.to_user_id <> OLD.to_user_id
     OR NEW.include_trashed <> OLD.include_trashed OR NEW.kind <> OLD.kind OR NEW.created_at <> OLD.created_at THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Handover job identity is immutable';
  END IF;
  IF OLD.state = 'completed' THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A completed handover cannot change';
  END IF;
  IF NEW.version < OLD.version THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Handover version cannot move backwards';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS hs_handover_job_guard ON hs_handover_jobs;
CREATE TRIGGER hs_handover_job_guard BEFORE UPDATE ON hs_handover_jobs FOR EACH ROW EXECUTE FUNCTION hs_handover_job_guard();

CREATE OR REPLACE FUNCTION hs_handover_item_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.job_id <> OLD.job_id OR NEW.page_id <> OLD.page_id OR NEW.ordinal <> OLD.ordinal
     OR NEW.trashed <> OLD.trashed OR NEW.had_edit <> OLD.had_edit OR NEW.decision <> OLD.decision
     OR NEW.expected_owner_id <> OLD.expected_owner_id THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Handover item identity is immutable';
  END IF;
  IF OLD.disposition <> 'pending' AND (NEW.disposition <> OLD.disposition OR NEW.code IS DISTINCT FROM OLD.code) THEN
    RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'A settled handover item cannot change';
  END IF;
  RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS hs_handover_item_guard ON hs_handover_items;
CREATE TRIGGER hs_handover_item_guard BEFORE UPDATE ON hs_handover_items FOR EACH ROW EXECUTE FUNCTION hs_handover_item_guard();

ALTER TABLE hs_notifications DROP CONSTRAINT IF EXISTS hs_notifications_kind_check;
ALTER TABLE hs_notifications ADD CONSTRAINT hs_notifications_kind_check
  CHECK (kind IN ('discussion', 'acknowledgement', 'acknowledgement-reminder', 'acknowledgement-overdue', 'page-review-reminder', 'variant-stale', 'page-digest', 'page-publish', 'page-handover'));
