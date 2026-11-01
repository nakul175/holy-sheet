-- HOLY-66 synced blocks. HOLY-65 snippets reuse this table (kind = 'sync' here).
-- Idempotent: safe to replay. Content bodies stay in hs_synced_blocks, never in audit.
CREATE TABLE IF NOT EXISTS hs_synced_blocks (
  id text PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES hs_workspaces(id),
  source_page_id text NOT NULL REFERENCES hs_pages(id),
  content jsonb NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  updated_by text NOT NULL REFERENCES hs_users(id),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  previous_content jsonb,
  previous_version integer,
  deleted_at timestamptz,
  deleted_by text REFERENCES hs_users(id),
  purge_after timestamptz,
  kind text NOT NULL DEFAULT 'sync'
);
ALTER TABLE hs_synced_blocks ADD COLUMN IF NOT EXISTS previous_content jsonb;
ALTER TABLE hs_synced_blocks ADD COLUMN IF NOT EXISTS previous_version integer;
ALTER TABLE hs_synced_blocks ADD COLUMN IF NOT EXISTS deleted_at timestamptz;
ALTER TABLE hs_synced_blocks ADD COLUMN IF NOT EXISTS deleted_by text REFERENCES hs_users(id);
ALTER TABLE hs_synced_blocks ADD COLUMN IF NOT EXISTS purge_after timestamptz;
ALTER TABLE hs_synced_blocks ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'sync';
ALTER TABLE hs_synced_blocks ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT clock_timestamp();

CREATE TABLE IF NOT EXISTS hs_synced_placements (
  page_id text NOT NULL REFERENCES hs_pages(id) ON DELETE CASCADE,
  block_id text NOT NULL,
  synced_id text NOT NULL REFERENCES hs_synced_blocks(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (page_id, block_id)
);
CREATE INDEX IF NOT EXISTS hs_synced_placements_synced ON hs_synced_placements(synced_id);

CREATE TABLE IF NOT EXISTS hs_synced_grants (
  synced_id text NOT NULL REFERENCES hs_synced_blocks(id) ON DELETE CASCADE,
  subject text NOT NULL,
  role text NOT NULL CHECK (role IN ('viewer', 'editor')),
  PRIMARY KEY (synced_id, subject)
);

CREATE TABLE IF NOT EXISTS hs_synced_operations (
  synced_id text NOT NULL,
  operation_id uuid NOT NULL,
  actor_id text NOT NULL REFERENCES hs_users(id),
  request_hash text NOT NULL,
  result jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (synced_id, operation_id)
);

CREATE TABLE IF NOT EXISTS hs_synced_events (
  id uuid PRIMARY KEY,
  synced_id text NOT NULL,
  workspace_id text NOT NULL,
  origin_page_id text NOT NULL,
  version integer NOT NULL,
  actor_id text NOT NULL,
  kind text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS hs_synced_events_synced ON hs_synced_events(synced_id, created_at);

-- Placement pages must not index synced body text. Source text lives only on hs_synced_blocks.
CREATE OR REPLACE FUNCTION hs_search_text(node jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE result text;
BEGIN
 IF node->>'type' IN ('pageLink','tableOfContents','syncedBlock') THEN RETURN ''; END IF;
 IF node ? 'text' THEN RETURN COALESCE(node->>'text',''); END IF;
 SELECT COALESCE(string_agg(hs_search_text(value),
  CASE WHEN node->>'type' IN ('paragraph','heading','detailsSummary','codeBlock') THEN '' ELSE E'\n' END ORDER BY ordinal),'') INTO result
 FROM jsonb_array_elements(COALESCE(node->'content','[]'::jsonb)) WITH ORDINALITY AS child(value,ordinal);
 RETURN result;
END
$$;
