-- Additive native administration; existing identities, memberships and ownership are untouched.
ALTER TABLE hs_workspaces ADD COLUMN IF NOT EXISTS access_version integer NOT NULL DEFAULT 1;
CREATE TABLE IF NOT EXISTS hs_workspace_operations (
 workspace_id text NOT NULL REFERENCES hs_workspaces(id), operation_id uuid NOT NULL,
 actor_id text NOT NULL REFERENCES hs_users(id), request_hash text NOT NULL,
 applied_version integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(workspace_id,operation_id)
);
CREATE TABLE IF NOT EXISTS hs_workspace_audit (
 id uuid PRIMARY KEY, workspace_id text NOT NULL REFERENCES hs_workspaces(id),
 actor_id text NOT NULL REFERENCES hs_users(id), subject_id text NOT NULL REFERENCES hs_users(id),
 action text NOT NULL, before_value jsonb NOT NULL, after_value jsonb NOT NULL,
 correlation_id uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
