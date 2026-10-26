CREATE TABLE IF NOT EXISTS hs_templates (
 id uuid PRIMARY KEY,workspace_id text NOT NULL REFERENCES hs_workspaces(id),owner_id text NOT NULL REFERENCES hs_users(id),
 name text NOT NULL,description text NOT NULL DEFAULT '',draft jsonb NOT NULL,draft_version integer NOT NULL DEFAULT 1,
 published_version integer NOT NULL DEFAULT 0,source_page_id text REFERENCES hs_pages(id),source_page_version integer,
 archived_at timestamptz,updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX IF NOT EXISTS hs_templates_personal_name ON hs_templates(workspace_id,owner_id,lower(name)) WHERE archived_at IS NULL;
CREATE TABLE IF NOT EXISTS hs_template_revisions (
 template_id uuid NOT NULL REFERENCES hs_templates(id),version integer NOT NULL,name text NOT NULL,description text NOT NULL,
 document jsonb NOT NULL,actor_id text NOT NULL REFERENCES hs_users(id),created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(template_id,version)
);
CREATE OR REPLACE FUNCTION hs_template_revision_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Published template revisions are immutable'; END;
$$;
CREATE OR REPLACE TRIGGER hs_template_revision_immutable BEFORE UPDATE ON hs_template_revisions FOR EACH ROW EXECUTE FUNCTION hs_template_revision_immutable();
CREATE TABLE IF NOT EXISTS hs_template_operations (
 workspace_id text NOT NULL REFERENCES hs_workspaces(id),actor_id text NOT NULL REFERENCES hs_users(id),operation_id uuid NOT NULL,
 request_hash text NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(workspace_id,actor_id,operation_id)
);
CREATE TABLE IF NOT EXISTS hs_page_template_sources (
 page_id text PRIMARY KEY REFERENCES hs_pages(id),template_id text NOT NULL,template_revision integer NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
