ALTER TABLE hs_grants DROP CONSTRAINT IF EXISTS hs_grants_role_check;
ALTER TABLE hs_grants ADD CONSTRAINT hs_grants_role_check CHECK(role IN ('viewer','commenter','editor'));
CREATE TABLE IF NOT EXISTS hs_threads (
 id uuid PRIMARY KEY, page_id text NOT NULL REFERENCES hs_pages(id), creator_id text NOT NULL REFERENCES hs_users(id),
 status text NOT NULL DEFAULT 'open' CHECK(status IN ('open','resolved')), version integer NOT NULL DEFAULT 1,
 anchors jsonb NOT NULL DEFAULT '[]', created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS hs_comments (
 id uuid PRIMARY KEY, thread_id uuid NOT NULL REFERENCES hs_threads(id), author_id text NOT NULL REFERENCES hs_users(id),
 body text NOT NULL CHECK(char_length(body)<=10000), is_root boolean NOT NULL DEFAULT false, version integer NOT NULL DEFAULT 1,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), edited_at timestamptz,
 deleted_at timestamptz, deleted_by text REFERENCES hs_users(id), moderated boolean NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX IF NOT EXISTS hs_thread_root ON hs_comments(thread_id) WHERE is_root;
CREATE INDEX IF NOT EXISTS hs_thread_page ON hs_threads(page_id,created_at,id);
CREATE INDEX IF NOT EXISTS hs_comment_thread ON hs_comments(thread_id,created_at,id);
CREATE TABLE IF NOT EXISTS hs_comment_mentions (
 comment_id uuid NOT NULL REFERENCES hs_comments(id), user_id text NOT NULL REFERENCES hs_users(id), current boolean NOT NULL DEFAULT true,
 PRIMARY KEY(comment_id,user_id)
);
CREATE TABLE IF NOT EXISTS hs_discussion_operations (
 page_id text NOT NULL REFERENCES hs_pages(id), operation_id uuid NOT NULL, actor_id text NOT NULL REFERENCES hs_users(id),
 request_hash text NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(page_id,operation_id)
);
CREATE TABLE IF NOT EXISTS hs_notification_events (
 id uuid PRIMARY KEY, page_id text NOT NULL REFERENCES hs_pages(id), thread_id uuid NOT NULL REFERENCES hs_threads(id), comment_id uuid NOT NULL REFERENCES hs_comments(id),
 actor_id text NOT NULL REFERENCES hs_users(id), recipients jsonb NOT NULL, delivered_at timestamptz, created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS hs_notifications (
 id uuid PRIMARY KEY, event_id uuid NOT NULL REFERENCES hs_notification_events(id), recipient_id text NOT NULL REFERENCES hs_users(id),
 page_id text NOT NULL REFERENCES hs_pages(id), thread_id uuid NOT NULL REFERENCES hs_threads(id), comment_id uuid NOT NULL REFERENCES hs_comments(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), read_at timestamptz, UNIQUE(event_id,recipient_id)
);
CREATE INDEX IF NOT EXISTS hs_notification_inbox ON hs_notifications(recipient_id,created_at,id);
