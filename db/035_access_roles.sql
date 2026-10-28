-- HOLY-5 additive access model. Existing workspaces remain on legacy model v1
-- until an explicit parity review activates space-role enforcement.
ALTER TABLE hs_members DROP CONSTRAINT IF EXISTS hs_members_role_check;
ALTER TABLE hs_members ADD CONSTRAINT hs_members_role_check
  CHECK (role IN ('owner','admin','member','observer'));

ALTER TABLE hs_workspaces ADD COLUMN IF NOT EXISTS access_model_version integer NOT NULL DEFAULT 1
  CHECK (access_model_version IN (1,2));

CREATE TABLE IF NOT EXISTS hs_space_members (
 space_id text NOT NULL REFERENCES hs_spaces(id) ON DELETE CASCADE,
 user_id text NOT NULL REFERENCES hs_users(id),
 role text NOT NULL CHECK (role IN ('leader','editor','viewer')),
 active boolean NOT NULL DEFAULT true,
 version integer NOT NULL DEFAULT 1 CHECK (version>0),
 granted_by text NOT NULL REFERENCES hs_users(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(space_id,user_id)
);

CREATE TABLE IF NOT EXISTS hs_access_invitations (
 id uuid PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES hs_workspaces(id),
 central_invitation_id text NOT NULL,
 invitee_subject text NOT NULL,
 intended_workspace_role text NOT NULL CHECK (intended_workspace_role IN ('owner','admin','member','observer')),
 intended_space_roles jsonb NOT NULL DEFAULT '[]'::jsonb,
 state text NOT NULL CHECK (state IN ('pending','accepted','expired','revoked')),
 invited_by text NOT NULL REFERENCES hs_users(id),
 accepted_user_id text REFERENCES hs_users(id),
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(workspace_id,central_invitation_id),
 CHECK (expires_at<=created_at+interval '7 days'),
 CHECK ((state='accepted')=(accepted_user_id IS NOT NULL))
);

CREATE TABLE IF NOT EXISTS hs_ownership_transfers (
 id uuid PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES hs_workspaces(id),
 from_user_id text NOT NULL REFERENCES hs_users(id),
 to_user_id text NOT NULL REFERENCES hs_users(id),
 state text NOT NULL CHECK (state IN ('pending','accepted','expired','revoked')),
 workspace_version integer NOT NULL CHECK (workspace_version>0),
 operation_id uuid NOT NULL,
 request_hash text NOT NULL,
 expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 accepted_at timestamptz,
 UNIQUE(workspace_id,operation_id),
 CHECK (from_user_id<>to_user_id),
 CHECK (expires_at<=created_at+interval '7 days'),
 CHECK ((state='accepted')=(accepted_at IS NOT NULL))
);

CREATE INDEX IF NOT EXISTS hs_space_members_user ON hs_space_members(user_id,space_id) WHERE active=true;
CREATE INDEX IF NOT EXISTS hs_access_invitations_subject ON hs_access_invitations(invitee_subject,state,expires_at);
CREATE INDEX IF NOT EXISTS hs_ownership_transfers_target ON hs_ownership_transfers(to_user_id,state,expires_at);

CREATE TABLE IF NOT EXISTS hs_space_operations (
 space_id text NOT NULL REFERENCES hs_spaces(id) ON DELETE CASCADE,
 operation_id uuid NOT NULL,
 actor_id text NOT NULL REFERENCES hs_users(id),
 request_hash text NOT NULL,
 applied_version integer NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(space_id,operation_id)
);

CREATE TABLE IF NOT EXISTS hs_space_audit (
 id uuid PRIMARY KEY,
 space_id text NOT NULL REFERENCES hs_spaces(id) ON DELETE CASCADE,
 actor_id text NOT NULL REFERENCES hs_users(id),
 subject_id text NOT NULL REFERENCES hs_users(id),
 action text NOT NULL,
 before_value jsonb,
 after_value jsonb,
 correlation_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS hs_access_invitation_operations (
 workspace_id text NOT NULL REFERENCES hs_workspaces(id),
 operation_id uuid NOT NULL,
 actor_id text NOT NULL REFERENCES hs_users(id),
 request_hash text NOT NULL,
 invitation_id uuid NOT NULL REFERENCES hs_access_invitations(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,operation_id)
);

CREATE TABLE IF NOT EXISTS hs_access_invitation_audit (
 id uuid PRIMARY KEY,
 workspace_id text NOT NULL REFERENCES hs_workspaces(id),
 invitation_id uuid NOT NULL REFERENCES hs_access_invitations(id),
 actor_id text NOT NULL REFERENCES hs_users(id),
 action text NOT NULL,
 before_value jsonb,
 after_value jsonb,
 correlation_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
