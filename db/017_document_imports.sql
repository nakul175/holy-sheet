CREATE TABLE IF NOT EXISTS hs_import_jobs (
 id uuid PRIMARY KEY, actor_id text NOT NULL REFERENCES hs_users(id),
 workspace_id text NOT NULL REFERENCES hs_workspaces(id), space_id text NOT NULL REFERENCES hs_spaces(id),
 title text NOT NULL, filename text NOT NULL, format text NOT NULL CHECK(format IN ('docx','md','txt')),
 request_hash text NOT NULL, review_hash text NOT NULL, source_bytes integer NOT NULL,
 state text NOT NULL CHECK(state IN ('preview','committed','cancelled','expired')),
 document jsonb, report jsonb NOT NULL,
 page_id text REFERENCES hs_pages(id) ON DELETE SET NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '24 hours',
 completed_at timestamptz,
 CHECK((state='preview')=(document IS NOT NULL))
);
CREATE INDEX IF NOT EXISTS hs_import_jobs_actor ON hs_import_jobs(actor_id,created_at DESC);
CREATE INDEX IF NOT EXISTS hs_import_jobs_expiry ON hs_import_jobs(expires_at) WHERE state='preview';
