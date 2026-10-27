CREATE TABLE IF NOT EXISTS hs_checklist_task_intents (
 id uuid PRIMARY KEY, actor_id text NOT NULL REFERENCES hs_users(id),
 page_id text NOT NULL REFERENCES hs_pages(id) ON DELETE CASCADE, item_id uuid NOT NULL,
 source_version integer NOT NULL, source_hash text NOT NULL,
 request_hash text NOT NULL, review_hash text NOT NULL,
 destination jsonb NOT NULL, task_input jsonb NOT NULL,
 state text NOT NULL DEFAULT 'prepared' CHECK(state IN ('prepared','pending','bound','unlinked','cancelled')),
 task_id text, created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS hs_checklist_task_sources (
 page_id text NOT NULL REFERENCES hs_pages(id) ON DELETE CASCADE, item_id uuid NOT NULL,
 intent_id uuid NOT NULL UNIQUE REFERENCES hs_checklist_task_intents(id),
 PRIMARY KEY(page_id,item_id)
);
