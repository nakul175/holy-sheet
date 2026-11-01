-- HOLY-68 linked multilingual document variants.
-- Variants are separate pages in one group. One member is the source.
-- Staleness compares a variant's synced published version with the source's live published version.
-- Re-running this file is safe.

CREATE TABLE IF NOT EXISTS hs_variant_groups (
  id uuid PRIMARY KEY,
  workspace_id text NOT NULL REFERENCES hs_workspaces(id),
  created_by text NOT NULL REFERENCES hs_users(id),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS hs_variant_members (
  page_id text PRIMARY KEY REFERENCES hs_pages(id),
  group_id uuid NOT NULL REFERENCES hs_variant_groups(id),
  lang text NOT NULL CHECK (char_length(lang) BETWEEN 2 AND 35),
  is_source boolean NOT NULL,
  synced_source_version integer CHECK (synced_source_version IS NULL OR synced_source_version > 0)
);
CREATE INDEX IF NOT EXISTS hs_variant_members_group ON hs_variant_members(group_id);
CREATE UNIQUE INDEX IF NOT EXISTS hs_variant_members_group_lang ON hs_variant_members(group_id, lang);
CREATE UNIQUE INDEX IF NOT EXISTS hs_variant_members_one_source ON hs_variant_members(group_id) WHERE is_source;

CREATE TABLE IF NOT EXISTS hs_variant_operations (
  page_id text NOT NULL REFERENCES hs_pages(id),
  operation_id uuid NOT NULL,
  actor_id text NOT NULL REFERENCES hs_users(id),
  request_hash text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (page_id, operation_id)
);

CREATE TABLE IF NOT EXISTS hs_reader_variant_choices (
  user_id text NOT NULL REFERENCES hs_users(id),
  group_id uuid NOT NULL REFERENCES hs_variant_groups(id),
  choice text NOT NULL CHECK (choice = 'source' OR choice ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$'),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (user_id, group_id)
);

CREATE TABLE IF NOT EXISTS hs_workspace_variant_settings (
  workspace_id text PRIMARY KEY REFERENCES hs_workspaces(id),
  routing text NOT NULL DEFAULT 'banner' CHECK (routing IN ('banner', 'auto')),
  updated_by text REFERENCES hs_users(id),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS hs_workspace_variant_operations (
  workspace_id text NOT NULL REFERENCES hs_workspaces(id),
  operation_id uuid NOT NULL,
  actor_id text NOT NULL REFERENCES hs_users(id),
  request_hash text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (workspace_id, operation_id)
);

ALTER TABLE hs_users ADD COLUMN IF NOT EXISTS preferred_language text;
ALTER TABLE hs_users DROP CONSTRAINT IF EXISTS hs_users_preferred_language_check;
ALTER TABLE hs_users ADD CONSTRAINT hs_users_preferred_language_check
  CHECK (preferred_language IS NULL OR preferred_language ~ '^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8}){0,3}$');

CREATE TABLE IF NOT EXISTS hs_profile_language_operations (
  user_id text NOT NULL REFERENCES hs_users(id),
  operation_id uuid NOT NULL,
  actor_id text NOT NULL REFERENCES hs_users(id),
  request_hash text NOT NULL,
  result jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (user_id, operation_id)
);

CREATE TABLE IF NOT EXISTS hs_variant_stale_notices (
  page_id text NOT NULL REFERENCES hs_pages(id),
  source_version integer NOT NULL CHECK (source_version > 0),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (page_id, source_version)
);

ALTER TABLE hs_notifications DROP CONSTRAINT IF EXISTS hs_notifications_kind_check;
ALTER TABLE hs_notifications ADD CONSTRAINT hs_notifications_kind_check
  CHECK (kind IN ('discussion', 'acknowledgement', 'acknowledgement-reminder', 'acknowledgement-overdue', 'page-review-reminder', 'variant-stale'));
