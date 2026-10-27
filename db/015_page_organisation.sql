ALTER TABLE hs_workspaces ADD COLUMN IF NOT EXISTS tree_version integer NOT NULL DEFAULT 1;
ALTER TABLE hs_pages ADD COLUMN IF NOT EXISTS position integer NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS hs_pages_siblings ON hs_pages(workspace_id,space_id,parent_id,position,id);
CREATE TABLE IF NOT EXISTS hs_page_tree_operations (
 workspace_id text NOT NULL REFERENCES hs_workspaces(id),operation_id uuid NOT NULL,
 actor_id text NOT NULL REFERENCES hs_users(id),page_id text NOT NULL REFERENCES hs_pages(id),
 request_hash text NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,operation_id)
);
