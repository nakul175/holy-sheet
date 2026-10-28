CREATE TABLE IF NOT EXISTS hs_collaboration_pages (
 page_id text PRIMARY KEY REFERENCES hs_pages(id) ON DELETE CASCADE,
 epoch uuid NOT NULL, step_version integer NOT NULL DEFAULT 0 CHECK(step_version>=0),
 document_version integer NOT NULL CHECK(document_version>0), document jsonb NOT NULL,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS hs_collaboration_sessions (
 id uuid PRIMARY KEY, page_id text NOT NULL REFERENCES hs_pages(id) ON DELETE CASCADE,
 epoch uuid NOT NULL, actor_id text NOT NULL REFERENCES hs_users(id), client_id uuid NOT NULL,
 active boolean NOT NULL DEFAULT true, last_seen timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '1 hour',
 UNIQUE(page_id,epoch,actor_id,client_id)
);
CREATE INDEX IF NOT EXISTS hs_collaboration_sessions_page ON hs_collaboration_sessions(page_id,epoch,last_seen);
CREATE TABLE IF NOT EXISTS hs_collaboration_batches (
 page_id text NOT NULL REFERENCES hs_pages(id) ON DELETE CASCADE, epoch uuid NOT NULL,
 operation_id uuid NOT NULL, actor_id text NOT NULL REFERENCES hs_users(id), client_id uuid NOT NULL,
 request_hash text NOT NULL, base_step_version integer NOT NULL, first_step_version integer NOT NULL,
 last_step_version integer NOT NULL, document_version integer NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(page_id,operation_id)
);
CREATE TABLE IF NOT EXISTS hs_collaboration_steps (
 page_id text NOT NULL REFERENCES hs_pages(id) ON DELETE CASCADE, epoch uuid NOT NULL,
 step_version integer NOT NULL, operation_id uuid NOT NULL, actor_id text NOT NULL REFERENCES hs_users(id),
 client_id uuid NOT NULL, step jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(page_id,epoch,step_version)
);
CREATE INDEX IF NOT EXISTS hs_collaboration_steps_operation ON hs_collaboration_steps(page_id,operation_id);
CREATE TABLE IF NOT EXISTS hs_collaboration_presence (
 session_id uuid PRIMARY KEY REFERENCES hs_collaboration_sessions(id) ON DELETE CASCADE,
 anchor_block_id text, anchor_offset integer, head_block_id text, head_offset integer,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 CHECK(anchor_offset IS NULL OR anchor_offset>=0), CHECK(head_offset IS NULL OR head_offset>=0)
);
CREATE TABLE IF NOT EXISTS hs_collaboration_tombstones (
 page_id text NOT NULL REFERENCES hs_pages(id) ON DELETE CASCADE, block_id text NOT NULL,
 removed_epoch uuid NOT NULL, removed_step_version integer NOT NULL,
 removed_at timestamptz NOT NULL DEFAULT clock_timestamp(), PRIMARY KEY(page_id,block_id)
);
