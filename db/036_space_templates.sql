ALTER TABLE hs_templates ADD COLUMN IF NOT EXISTS scope_space_id text REFERENCES hs_spaces(id);
CREATE UNIQUE INDEX IF NOT EXISTS hs_templates_space_name
 ON hs_templates(workspace_id,scope_space_id,lower(name))
 WHERE archived_at IS NULL AND scope_space_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS hs_space_template_managers (
 workspace_id text NOT NULL REFERENCES hs_workspaces(id),
 space_id text NOT NULL REFERENCES hs_spaces(id),
 user_id text NOT NULL REFERENCES hs_users(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,space_id,user_id)
);
