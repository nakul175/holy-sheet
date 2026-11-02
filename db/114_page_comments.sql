-- HOLY-89 page comments: comment backlinks and content-free mention mail.
-- Comment rows use the comment id as block_id. Document indexing must not delete them.
ALTER TABLE hs_record_backlinks DROP CONSTRAINT IF EXISTS hs_record_backlinks_ref_type_check;
ALTER TABLE hs_record_backlinks ADD CONSTRAINT hs_record_backlinks_ref_type_check CHECK (ref_type IN ('chip', 'card', 'link', 'comment'));

CREATE TABLE IF NOT EXISTS hs_discussion_email_outbox (
  id uuid PRIMARY KEY,
  notification_id uuid NOT NULL UNIQUE REFERENCES hs_notifications(id),
  recipient_id text NOT NULL REFERENCES hs_users(id),
  page_id text NOT NULL REFERENCES hs_pages(id),
  subject text NOT NULL CHECK (char_length(subject) BETWEEN 1 AND 200),
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 500),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS hs_discussion_email_recipient ON hs_discussion_email_outbox(recipient_id, created_at DESC);
