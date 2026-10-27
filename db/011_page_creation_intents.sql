CREATE TABLE IF NOT EXISTS hs_page_creations (
 actor_id text NOT NULL REFERENCES hs_users(id), operation_id uuid NOT NULL,
 page_id text NOT NULL REFERENCES hs_pages(id), request_hash text NOT NULL,
 PRIMARY KEY(actor_id,operation_id)
);
