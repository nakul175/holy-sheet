CREATE TABLE IF NOT EXISTS hs_navigation_state (
 user_id text PRIMARY KEY REFERENCES hs_users(id), version integer NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS hs_favourites (
 user_id text REFERENCES hs_users(id), page_id text REFERENCES hs_pages(id), position bigint NOT NULL,
 PRIMARY KEY(user_id,page_id)
);
CREATE INDEX IF NOT EXISTS hs_favourites_order ON hs_favourites(user_id,position,page_id);
CREATE TABLE IF NOT EXISTS hs_recents (
 user_id text REFERENCES hs_users(id), page_id text REFERENCES hs_pages(id), opened_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(user_id,page_id)
);
CREATE INDEX IF NOT EXISTS hs_recents_order ON hs_recents(user_id,opened_at DESC,page_id);
