-- HOLY-64 published document acknowledgement.
-- Extends HOLY-63 publications and HOLY-4 effective access. Acknowledgement never grants access.
-- Re-running this file is safe.

ALTER TABLE hs_document_publications ADD COLUMN IF NOT EXISTS version_number integer;
ALTER TABLE hs_document_publications ADD COLUMN IF NOT EXISTS bump text;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hs_document_publications_version_number_check') THEN
    ALTER TABLE hs_document_publications
      ADD CONSTRAINT hs_document_publications_version_number_check
      CHECK (version_number IS NULL OR version_number > 0);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'hs_document_publications_bump_check') THEN
    ALTER TABLE hs_document_publications
      ADD CONSTRAINT hs_document_publications_bump_check
      CHECK (bump IS NULL OR bump IN ('major', 'minor'));
  END IF;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS hs_document_publication_label
  ON hs_document_publications(page_id, version_number)
  WHERE version_number IS NOT NULL;

-- Audience groups are membership sets only. They do not grant page access.
CREATE TABLE IF NOT EXISTS hs_workspace_groups (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES hs_workspaces(id),
  name text NOT NULL,
  UNIQUE (workspace_id, name)
);
CREATE TABLE IF NOT EXISTS hs_workspace_group_members (
  group_id text NOT NULL REFERENCES hs_workspace_groups(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES hs_users(id),
  PRIMARY KEY (group_id, user_id)
);
CREATE INDEX IF NOT EXISTS hs_workspace_group_members_user ON hs_workspace_group_members(user_id);

CREATE TABLE IF NOT EXISTS hs_ack_campaigns (
  id uuid PRIMARY KEY,
  page_id text NOT NULL REFERENCES hs_pages(id),
  workspace_id text NOT NULL REFERENCES hs_workspaces(id),
  version_id uuid NOT NULL,
  version_number integer NOT NULL CHECK (version_number > 0),
  audience jsonb NOT NULL,
  due_at timestamptz NOT NULL,
  status text NOT NULL CHECK (status IN ('active', 'paused', 'superseded')),
  paused_reason text,
  excluded jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_by text NOT NULL REFERENCES hs_users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  FOREIGN KEY (page_id, version_id) REFERENCES hs_document_publications(page_id, id)
);
CREATE UNIQUE INDEX IF NOT EXISTS hs_ack_campaign_open
  ON hs_ack_campaigns(page_id)
  WHERE status IN ('active', 'paused');
CREATE INDEX IF NOT EXISTS hs_ack_campaigns_page ON hs_ack_campaigns(page_id, created_at DESC);

CREATE TABLE IF NOT EXISTS hs_ack_assignments (
  id uuid PRIMARY KEY,
  campaign_id uuid NOT NULL REFERENCES hs_ack_campaigns(id),
  user_id text NOT NULL REFERENCES hs_users(id),
  status text NOT NULL CHECK (status IN ('pending', 'acknowledged')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (campaign_id, user_id)
);
CREATE INDEX IF NOT EXISTS hs_ack_assignments_user ON hs_ack_assignments(user_id, campaign_id);

-- Append-only evidence. ip_country is a country code, never a full IP address.
CREATE TABLE IF NOT EXISTS hs_ack_records (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL,
  campaign_id uuid NOT NULL REFERENCES hs_ack_campaigns(id),
  assignment_id uuid NOT NULL REFERENCES hs_ack_assignments(id),
  page_id text NOT NULL,
  version_id uuid NOT NULL,
  version_number integer NOT NULL CHECK (version_number > 0),
  user_id text NOT NULL,
  acknowledged_at timestamptz NOT NULL,
  at_iso text NOT NULL,
  content_hash text NOT NULL,
  ip_country text,
  prev_hash text NOT NULL,
  hash text NOT NULL,
  CHECK (ip_country IS NULL OR ip_country ~ '^[A-Z]{2}$'),
  CHECK (content_hash ~ '^[a-f0-9]{64}$'),
  CHECK (prev_hash ~ '^[a-f0-9]{64}$'),
  CHECK (hash ~ '^[a-f0-9]{64}$')
);
CREATE UNIQUE INDEX IF NOT EXISTS hs_ack_record_once ON hs_ack_records(campaign_id, user_id);
CREATE INDEX IF NOT EXISTS hs_ack_records_page ON hs_ack_records(page_id, acknowledged_at, id);

CREATE OR REPLACE FUNCTION hs_ack_records_append_only() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Acknowledgement records are append-only';
END;
$$;
CREATE OR REPLACE TRIGGER hs_ack_records_append_only
  BEFORE UPDATE OR DELETE ON hs_ack_records
  FOR EACH ROW EXECUTE FUNCTION hs_ack_records_append_only();

-- Runtime role hs_app is created by the operator and must not own this table.
-- Grants are skipped when the role is absent so local and test databases can replay this file.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'hs_app') THEN
    REVOKE ALL ON TABLE hs_ack_records FROM hs_app;
    GRANT SELECT, INSERT ON TABLE hs_ack_records TO hs_app;
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS hs_ack_operations (
  page_id text NOT NULL REFERENCES hs_pages(id),
  operation_id uuid NOT NULL,
  actor_id text NOT NULL REFERENCES hs_users(id),
  request_hash text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (page_id, operation_id)
);

CREATE TABLE IF NOT EXISTS hs_ack_reminders (
  id uuid PRIMARY KEY,
  campaign_id uuid NOT NULL REFERENCES hs_ack_campaigns(id),
  assignment_id uuid,
  recipient_id text NOT NULL REFERENCES hs_users(id),
  kind text NOT NULL CHECK (kind IN ('assignee', 'owner_summary')),
  ist_date date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX IF NOT EXISTS hs_ack_reminder_assignee
  ON hs_ack_reminders(assignment_id, ist_date)
  WHERE kind = 'assignee';
CREATE UNIQUE INDEX IF NOT EXISTS hs_ack_reminder_owner
  ON hs_ack_reminders(campaign_id, ist_date)
  WHERE kind = 'owner_summary';

CREATE TABLE IF NOT EXISTS hs_ack_email_outbox (
  id uuid PRIMARY KEY,
  recipient_id text NOT NULL REFERENCES hs_users(id),
  campaign_id uuid REFERENCES hs_ack_campaigns(id),
  kind text NOT NULL CHECK (kind IN ('assigned', 'reminder', 'overdue-summary')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS hs_ack_email_outbox_recipient ON hs_ack_email_outbox(recipient_id, created_at DESC);

-- Discussion notifications keep their threads. Acknowledgement rows leave those foreign keys empty.
ALTER TABLE hs_notifications ALTER COLUMN event_id DROP NOT NULL;
ALTER TABLE hs_notifications ALTER COLUMN thread_id DROP NOT NULL;
ALTER TABLE hs_notifications ALTER COLUMN comment_id DROP NOT NULL;
ALTER TABLE hs_notifications ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'discussion';
ALTER TABLE hs_notifications ADD COLUMN IF NOT EXISTS summary text;
ALTER TABLE hs_notifications DROP CONSTRAINT IF EXISTS hs_notifications_kind_check;
ALTER TABLE hs_notifications ADD CONSTRAINT hs_notifications_kind_check
  CHECK (kind IN ('discussion', 'acknowledgement', 'acknowledgement-reminder', 'acknowledgement-overdue'));
CREATE INDEX IF NOT EXISTS hs_ack_notification_inbox
  ON hs_notifications(recipient_id, created_at DESC, id)
  WHERE kind <> 'discussion';

CREATE OR REPLACE FUNCTION hs_ack_sync_trash() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.deleted_at IS NOT NULL AND OLD.deleted_at IS NULL THEN
    UPDATE hs_ack_campaigns
      SET status = 'paused', paused_reason = 'trashed'
      WHERE page_id = NEW.id AND status = 'active';
  ELSIF NEW.deleted_at IS NULL AND OLD.deleted_at IS NOT NULL THEN
    UPDATE hs_ack_campaigns
      SET status = 'active', paused_reason = NULL
      WHERE page_id = NEW.id AND status = 'paused' AND paused_reason = 'trashed';
  END IF;
  RETURN NEW;
END;
$$;
CREATE OR REPLACE TRIGGER hs_ack_sync_trash
  AFTER UPDATE OF deleted_at ON hs_pages
  FOR EACH ROW EXECUTE FUNCTION hs_ack_sync_trash();
