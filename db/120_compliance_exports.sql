-- HOLY-94 / HS N49 compliance packs. Extends workspace export policy from 018.
-- Re-running this file is safe. It does not change hs_export_jobs.

CREATE TABLE IF NOT EXISTS hs_space_export_policy (
  space_id text PRIMARY KEY REFERENCES hs_spaces(id) ON DELETE CASCADE,
  workspace_id text NOT NULL REFERENCES hs_workspaces(id) ON DELETE CASCADE,
  attachments boolean NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0)
);

CREATE TABLE IF NOT EXISTS hs_space_export_policy_operations (
  space_id text NOT NULL REFERENCES hs_spaces(id) ON DELETE CASCADE,
  actor_id text NOT NULL REFERENCES hs_users(id),
  operation_id uuid NOT NULL,
  request_hash text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (space_id, actor_id, operation_id)
);

CREATE TABLE IF NOT EXISTS hs_compliance_jobs (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES hs_workspaces(id) ON DELETE CASCADE,
  actor_id text NOT NULL REFERENCES hs_users(id),
  operation_id uuid NOT NULL,
  scope text NOT NULL CHECK (scope IN ('page', 'tree', 'space')),
  format text NOT NULL CHECK (format IN ('pdf', 'html', 'markdown', 'compliance-pack')),
  target_id text NOT NULL,
  options jsonb NOT NULL,
  request_hash text NOT NULL,
  session_binding text NOT NULL,
  state text NOT NULL CHECK (state IN ('queued', 'running', 'ready', 'aborted', 'cancelled', 'expired')),
  progress integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  eta_seconds integer NOT NULL DEFAULT 0 CHECK (eta_seconds >= 0),
  item_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
  notes jsonb NOT NULL DEFAULT '[]'::jsonb,
  manifest_hash text,
  signature text,
  download_token text,
  expires_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  completed_at timestamptz,
  UNIQUE (workspace_id, actor_id, operation_id)
);
CREATE INDEX IF NOT EXISTS hs_compliance_jobs_actor ON hs_compliance_jobs(actor_id, created_at DESC);

CREATE TABLE IF NOT EXISTS hs_compliance_files (
  job_id uuid NOT NULL REFERENCES hs_compliance_jobs(id) ON DELETE CASCADE,
  path text NOT NULL,
  sha256 text NOT NULL,
  content text NOT NULL,
  PRIMARY KEY (job_id, path)
);

CREATE TABLE IF NOT EXISTS hs_compliance_email_outbox (
  id uuid PRIMARY KEY,
  job_id uuid NOT NULL UNIQUE REFERENCES hs_compliance_jobs(id) ON DELETE CASCADE,
  recipient_id text NOT NULL REFERENCES hs_users(id),
  subject text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 200),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

ALTER TABLE hs_notifications DROP CONSTRAINT IF EXISTS hs_notifications_kind_check;
ALTER TABLE hs_notifications ADD CONSTRAINT hs_notifications_kind_check
  CHECK (kind IN ('discussion', 'acknowledgement', 'acknowledgement-reminder', 'acknowledgement-overdue', 'page-review-reminder', 'variant-stale', 'page-digest', 'page-publish', 'page-handover', 'compliance-export'));
