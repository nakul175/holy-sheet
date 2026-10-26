ALTER TABLE hs_revisions ADD COLUMN IF NOT EXISTS actor_id text REFERENCES hs_users(id);
ALTER TABLE hs_revisions ADD COLUMN IF NOT EXISTS source_surface text NOT NULL DEFAULT 'legacy';
ALTER TABLE hs_revisions ADD COLUMN IF NOT EXISTS schema_version integer NOT NULL DEFAULT 2;
ALTER TABLE hs_revisions ADD COLUMN IF NOT EXISTS restored_from integer;
ALTER TABLE hs_revisions ADD COLUMN IF NOT EXISTS superseded_at timestamptz;
ALTER TABLE hs_revisions ADD COLUMN IF NOT EXISTS content_hash text;
ALTER TABLE hs_revisions ALTER COLUMN created_at SET DEFAULT clock_timestamp();
ALTER TABLE hs_pages ALTER COLUMN updated_at SET DEFAULT clock_timestamp();
-- Existing internal snapshots have unknown author/surface; do not invent attribution.
UPDATE hs_revisions v SET superseded_at=(SELECT min(n.created_at) FROM hs_revisions n WHERE n.page_id=v.page_id AND n.version>v.version)
WHERE v.superseded_at IS NULL AND EXISTS(SELECT 1 FROM hs_pages p WHERE p.id=v.page_id AND p.version>v.version);
CREATE TABLE IF NOT EXISTS hs_revision_media (
 page_id text NOT NULL, version integer NOT NULL, media_id uuid NOT NULL REFERENCES hs_media(id),
 PRIMARY KEY(page_id,version,media_id), FOREIGN KEY(page_id,version) REFERENCES hs_revisions(page_id,version) ON DELETE CASCADE
);
WITH RECURSIVE nodes AS (
 SELECT page_id,version,document AS node FROM hs_revisions
 UNION ALL SELECT n.page_id,n.version,c.value FROM nodes n CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN jsonb_typeof(n.node->'content')='array' THEN n.node->'content' ELSE '[]'::jsonb END) AS c(value)
)
INSERT INTO hs_revision_media(page_id,version,media_id)
SELECT DISTINCT n.page_id,n.version,m.id FROM nodes n JOIN hs_media m ON m.page_id=n.page_id AND m.id::text=n.node->'attrs'->>'attachmentId' WHERE n.node->>'type' IN ('image','file') ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS hs_restore_previews (
 id uuid PRIMARY KEY,user_id text NOT NULL REFERENCES hs_users(id),page_id text NOT NULL REFERENCES hs_pages(id),
 source_version integer NOT NULL,expected_version integer NOT NULL,media_signature text NOT NULL,expires_at timestamptz NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS hs_history_operations (
 page_id text NOT NULL REFERENCES hs_pages(id),operation_id uuid NOT NULL,actor_id text NOT NULL REFERENCES hs_users(id),
 request_hash text NOT NULL,result_version integer NOT NULL,source_version integer NOT NULL,warnings jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),PRIMARY KEY(page_id,operation_id)
);
CREATE OR REPLACE FUNCTION hs_revision_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.page_id IS DISTINCT FROM OLD.page_id OR NEW.version IS DISTINCT FROM OLD.version
 OR NEW.title IS DISTINCT FROM OLD.title OR NEW.document IS DISTINCT FROM OLD.document
 OR NEW.actor_id IS DISTINCT FROM OLD.actor_id OR NEW.source_surface IS DISTINCT FROM OLD.source_surface
 OR NEW.schema_version IS DISTINCT FROM OLD.schema_version OR NEW.restored_from IS DISTINCT FROM OLD.restored_from
 OR NEW.created_at IS DISTINCT FROM OLD.created_at OR NEW.content_hash IS DISTINCT FROM OLD.content_hash
 OR (OLD.superseded_at IS NOT NULL AND NEW.superseded_at IS DISTINCT FROM OLD.superseded_at)
 THEN RAISE EXCEPTION 'Saved revision content and attribution are immutable'; END IF;
 RETURN NEW;
END;
$$;
CREATE OR REPLACE TRIGGER hs_revision_immutable BEFORE UPDATE ON hs_revisions FOR EACH ROW EXECUTE FUNCTION hs_revision_immutable();
