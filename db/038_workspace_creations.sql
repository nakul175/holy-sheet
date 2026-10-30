-- New empty workspace creation, explicitly restricted to an existing Owner.
CREATE TABLE IF NOT EXISTS hs_workspace_creations (
 actor_id text NOT NULL REFERENCES hs_users(id),
 operation_id uuid NOT NULL,
 source_workspace_id text REFERENCES hs_workspaces(id) ON DELETE SET NULL,
 workspace_id text REFERENCES hs_workspaces(id) ON DELETE SET NULL,
 request_hash text NOT NULL,
 PRIMARY KEY(actor_id,operation_id)
);
