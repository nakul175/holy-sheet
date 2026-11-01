-- HOLY-86: idempotent search jump inserts. The row stores ids only, never titles or field values.
CREATE TABLE IF NOT EXISTS hs_search_jump_operations (
 actor_id text NOT NULL REFERENCES hs_users(id) ON DELETE CASCADE,
 operation_id uuid NOT NULL,
 request_hash text NOT NULL,
 result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY (actor_id, operation_id)
);
