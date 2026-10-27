CREATE TABLE IF NOT EXISTS hs_search_snapshots (
 id uuid PRIMARY KEY, user_id text NOT NULL REFERENCES hs_users(id), workspace_id text NOT NULL REFERENCES hs_workspaces(id),
 query_hash text NOT NULL, space_id text, page_ids jsonb NOT NULL, expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '5 minutes'
);
CREATE INDEX IF NOT EXISTS hs_search_snapshot_expiry ON hs_search_snapshots(expires_at);
CREATE TABLE IF NOT EXISTS hs_search_cursors (
 token_hash text PRIMARY KEY, snapshot_id uuid NOT NULL REFERENCES hs_search_snapshots(id) ON DELETE CASCADE,
 next_position integer NOT NULL CHECK(next_position>0)
);
CREATE TABLE IF NOT EXISTS hs_search_rate (
 user_id text PRIMARY KEY REFERENCES hs_users(id), window_started timestamptz NOT NULL DEFAULT clock_timestamp(), requests integer NOT NULL DEFAULT 0
);
ALTER TABLE hs_search_rate ADD COLUMN IF NOT EXISTS denied_count bigint NOT NULL DEFAULT 0;
ALTER TABLE hs_search_rate ADD COLUMN IF NOT EXISTS last_denied_request_id uuid;
CREATE TABLE IF NOT EXISTS hs_search_audit (
 id uuid PRIMARY KEY, request_id uuid NOT NULL, user_id text NOT NULL REFERENCES hs_users(id),
 outcome text NOT NULL, result_count integer NOT NULL DEFAULT 0, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE INDEX IF NOT EXISTS hs_search_audit_time ON hs_search_audit(created_at);
