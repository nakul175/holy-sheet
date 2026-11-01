-- HOLY-72 space home. Designated page plus ordered pins. Widget reads filter per reader.
ALTER TABLE hs_spaces ADD COLUMN IF NOT EXISTS home_page_id text REFERENCES hs_pages(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS hs_spaces_home_page ON hs_spaces(home_page_id) WHERE home_page_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS hs_space_pins (
  space_id text NOT NULL REFERENCES hs_spaces(id) ON DELETE CASCADE,
  page_id text NOT NULL REFERENCES hs_pages(id) ON DELETE CASCADE,
  position integer NOT NULL CHECK (position >= 0),
  pinned_by text NOT NULL REFERENCES hs_users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (space_id, page_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS hs_space_pins_order ON hs_space_pins(space_id, position);

CREATE TABLE IF NOT EXISTS hs_space_home_operations (
  space_id text NOT NULL REFERENCES hs_spaces(id) ON DELETE CASCADE,
  operation_id uuid NOT NULL,
  actor_id text NOT NULL REFERENCES hs_users(id),
  request_hash text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (space_id, operation_id)
);
