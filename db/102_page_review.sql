-- HOLY-67 document review cycle and expiry.
-- Dates are workspace calendar dates (Asia/Kolkata). Expiry flags a page; it does not unpublish it.
-- Re-running this file is safe.

CREATE TABLE IF NOT EXISTS hs_page_review (
  page_id text PRIMARY KEY REFERENCES hs_pages(id),
  cycle_months integer NOT NULL CHECK (cycle_months BETWEEN 1 AND 120),
  cycle_start_on date NOT NULL,
  next_review_on date NOT NULL,
  expires_on date NOT NULL,
  last_reviewed_by text REFERENCES hs_users(id),
  last_reviewed_at timestamptz,
  last_review_note text,
  CHECK (last_review_note IS NULL OR char_length(last_review_note) BETWEEN 1 AND 500),
  CHECK ((last_reviewed_by IS NULL) = (last_reviewed_at IS NULL))
);
CREATE INDEX IF NOT EXISTS hs_page_review_next ON hs_page_review(next_review_on);
CREATE INDEX IF NOT EXISTS hs_page_review_expires ON hs_page_review(expires_on);

CREATE TABLE IF NOT EXISTS hs_page_review_operations (
  page_id text NOT NULL REFERENCES hs_pages(id),
  operation_id uuid NOT NULL,
  actor_id text NOT NULL REFERENCES hs_users(id),
  request_hash text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (page_id, operation_id)
);

CREATE TABLE IF NOT EXISTS hs_page_review_reminders (
  id uuid PRIMARY KEY,
  page_id text NOT NULL REFERENCES hs_pages(id),
  recipient_id text NOT NULL REFERENCES hs_users(id),
  slot text NOT NULL,
  ist_date date NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  UNIQUE (page_id, slot)
);
CREATE INDEX IF NOT EXISTS hs_page_review_reminders_page ON hs_page_review_reminders(page_id, ist_date);

CREATE TABLE IF NOT EXISTS hs_space_review_policy (
  space_id text PRIMARY KEY REFERENCES hs_spaces(id),
  hide_expired_from_readers boolean NOT NULL DEFAULT false,
  updated_by text REFERENCES hs_users(id),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS hs_space_review_operations (
  space_id text NOT NULL REFERENCES hs_spaces(id),
  operation_id uuid NOT NULL,
  actor_id text NOT NULL REFERENCES hs_users(id),
  request_hash text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (space_id, operation_id)
);

ALTER TABLE hs_notifications DROP CONSTRAINT IF EXISTS hs_notifications_kind_check;
ALTER TABLE hs_notifications ADD CONSTRAINT hs_notifications_kind_check
  CHECK (kind IN ('discussion', 'acknowledgement', 'acknowledgement-reminder', 'acknowledgement-overdue', 'page-review-reminder'));
