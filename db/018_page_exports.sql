ALTER TABLE hs_workspaces ADD COLUMN IF NOT EXISTS export_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE hs_workspaces ADD COLUMN IF NOT EXISTS export_version integer NOT NULL DEFAULT 1;
CREATE TABLE IF NOT EXISTS hs_export_jobs (
 id uuid PRIMARY KEY, actor_id text NOT NULL REFERENCES hs_users(id),
 page_id text NOT NULL REFERENCES hs_pages(id) ON DELETE CASCADE,
 source_version integer NOT NULL, format text NOT NULL CHECK(format IN ('pdf','markdown')),
 request_hash text NOT NULL, review_hash text NOT NULL, content_hash text NOT NULL,
 references_hash text NOT NULL, policy_version integer NOT NULL, report jsonb NOT NULL,
 state text NOT NULL DEFAULT 'ready' CHECK(state IN ('ready','cancelled','expired')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '15 minutes',
 issued_at timestamptz, cancelled_at timestamptz,
 FOREIGN KEY(page_id,source_version) REFERENCES hs_revisions(page_id,version) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS hs_export_jobs_actor ON hs_export_jobs(actor_id,created_at DESC);
CREATE TABLE IF NOT EXISTS hs_export_policy_operations (
 workspace_id text NOT NULL REFERENCES hs_workspaces(id) ON DELETE CASCADE,
 actor_id text NOT NULL REFERENCES hs_users(id), operation_id uuid NOT NULL,
 request_hash text NOT NULL, result jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,actor_id,operation_id)
);
