CREATE EXTENSION IF NOT EXISTS pg_trgm;

CREATE TABLE app_user (
  id uuid PRIMARY KEY,
  display_name text NOT NULL,
  email text NOT NULL UNIQUE
);

CREATE TABLE workspace (
  id uuid PRIMARY KEY,
  name text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE workspace_member (
  workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('owner', 'member')),
  PRIMARY KEY (workspace_id, user_id)
);

CREATE TABLE space (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  name text NOT NULL,
  created_by uuid NOT NULL REFERENCES app_user(id),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, name)
);

CREATE TABLE page (
  id uuid PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspace(id) ON DELETE CASCADE,
  space_id uuid NOT NULL REFERENCES space(id) ON DELETE CASCADE,
  parent_page_id uuid REFERENCES page(id) ON DELETE SET NULL,
  title text NOT NULL DEFAULT 'Untitled',
  owner_id uuid NOT NULL REFERENCES app_user(id),
  visibility text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'space')),
  version integer NOT NULL DEFAULT 1,
  deleted_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE page_grant (
  page_id uuid NOT NULL REFERENCES page(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES app_user(id) ON DELETE CASCADE,
  permission text NOT NULL CHECK (permission IN ('read', 'edit')),
  PRIMARY KEY (page_id, user_id)
);

CREATE TABLE block (
  id uuid PRIMARY KEY,
  page_id uuid NOT NULL REFERENCES page(id) ON DELETE CASCADE,
  parent_block_id uuid REFERENCES block(id) ON DELETE CASCADE,
  type text NOT NULL CHECK (type IN ('paragraph','heading','bullet','number','checklist')),
  content jsonb NOT NULL DEFAULT '{"text":""}'::jsonb,
  position integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (page_id, parent_block_id, position)
);

CREATE INDEX page_workspace_updated_idx ON page(workspace_id, updated_at DESC) WHERE deleted_at IS NULL;
CREATE INDEX page_title_trgm_idx ON page USING gin (title gin_trgm_ops) WHERE deleted_at IS NULL;
CREATE INDEX block_text_trgm_idx ON block USING gin ((content->>'text') gin_trgm_ops);
CREATE INDEX block_page_position_idx ON block(page_id, position);

-- Permission checks remain authoritative in the query; search indexes never grant access.
