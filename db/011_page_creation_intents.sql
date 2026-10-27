CREATE TABLE IF NOT EXISTS hs_page_creations (
 actor_id text NOT NULL REFERENCES hs_users(id) ON DELETE CASCADE, operation_id uuid NOT NULL,
 page_id text REFERENCES hs_pages(id) ON DELETE SET NULL, request_hash text NOT NULL,
 PRIMARY KEY(actor_id,operation_id)
);
