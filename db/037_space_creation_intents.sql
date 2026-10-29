-- Preserve creation identity across a lost successful space-creation response.
CREATE TABLE IF NOT EXISTS hs_space_creations (
 actor_id text NOT NULL REFERENCES hs_users(id),
 operation_id uuid NOT NULL,
 space_id text REFERENCES hs_spaces(id) ON DELETE SET NULL,
 request_hash text NOT NULL,
 PRIMARY KEY(actor_id,operation_id)
);
