-- HOLY-90 page follow and change digest (HS N45). Record-condition follows are a different story.
ALTER TABLE hs_users ADD COLUMN IF NOT EXISTS timezone text NOT NULL DEFAULT 'Asia/Kolkata';
ALTER TABLE hs_users DROP CONSTRAINT IF EXISTS hs_users_timezone_length;
ALTER TABLE hs_users ADD CONSTRAINT hs_users_timezone_length CHECK (char_length(timezone) BETWEEN 1 AND 80);

CREATE TABLE IF NOT EXISTS hs_page_follows (
  user_id text NOT NULL REFERENCES hs_users(id),
  page_id text NOT NULL REFERENCES hs_pages(id) ON DELETE CASCADE,
  include_children boolean NOT NULL DEFAULT false,
  frequency text NOT NULL DEFAULT 'daily' CHECK (frequency IN ('daily', 'weekly')),
  last_digest_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  removal_batch_id uuid,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (user_id, page_id)
);
CREATE INDEX IF NOT EXISTS hs_page_follows_page ON hs_page_follows(page_id);

CREATE TABLE IF NOT EXISTS hs_page_follow_operations (
  user_id text NOT NULL REFERENCES hs_users(id),
  operation_id uuid NOT NULL,
  page_id text,
  request_hash text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (user_id, operation_id)
);

CREATE TABLE IF NOT EXISTS hs_page_digest_runs (
  user_id text NOT NULL REFERENCES hs_users(id),
  window_key text NOT NULL CHECK (char_length(window_key) BETWEEN 8 AND 40),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (user_id, window_key)
);

CREATE TABLE IF NOT EXISTS hs_page_digest_mail (
  id uuid PRIMARY KEY,
  user_id text NOT NULL REFERENCES hs_users(id),
  kind text NOT NULL CHECK (kind IN ('digest', 'publish')),
  window_key text,
  subject text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 200),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 20000),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX IF NOT EXISTS hs_page_digest_mail_window ON hs_page_digest_mail(user_id, window_key) WHERE window_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS hs_page_digest_mail_user ON hs_page_digest_mail(user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS hs_page_publish_notices (
  version_id uuid NOT NULL REFERENCES hs_published_versions(id),
  user_id text NOT NULL REFERENCES hs_users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (version_id, user_id)
);

ALTER TABLE hs_notifications DROP CONSTRAINT IF EXISTS hs_notifications_kind_check;
ALTER TABLE hs_notifications ADD CONSTRAINT hs_notifications_kind_check
  CHECK (kind IN ('discussion', 'acknowledgement', 'acknowledgement-reminder', 'acknowledgement-overdue', 'page-review-reminder', 'variant-stale', 'page-digest', 'page-publish'));
