-- HOLY-87: explicit page mentions of a record (chip, card, or plain link).
-- View-block membership is not indexed. Rows store ids only, never titles or field values.
CREATE TABLE IF NOT EXISTS hs_record_backlinks (
  workspace_id text NOT NULL REFERENCES hs_workspaces(id) ON DELETE CASCADE,
  record_id uuid NOT NULL REFERENCES hs_data_records(id) ON DELETE CASCADE,
  page_id text NOT NULL REFERENCES hs_pages(id) ON DELETE CASCADE,
  block_id text NOT NULL CHECK (char_length(block_id) BETWEEN 1 AND 100),
  ref_type text NOT NULL CHECK (ref_type IN ('chip', 'card', 'link')),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, record_id, page_id, block_id)
);
CREATE INDEX IF NOT EXISTS hs_record_backlinks_record ON hs_record_backlinks (workspace_id, record_id, page_id);
CREATE INDEX IF NOT EXISTS hs_record_backlinks_page ON hs_record_backlinks (page_id);
