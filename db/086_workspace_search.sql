-- HOLY-2: synchronous saved-text projection. No copied permissions.
CREATE TABLE IF NOT EXISTS hs_workspace_search (
 page_id text PRIMARY KEY REFERENCES hs_pages(id) ON DELETE CASCADE,
 body text NOT NULL DEFAULT '',
 title text NOT NULL DEFAULT '',
 search_vector tsvector GENERATED ALWAYS AS(to_tsvector('simple',title||E'\n'||body)) STORED
);
CREATE INDEX IF NOT EXISTS hs_workspace_search_vector ON hs_workspace_search USING gin(search_vector);
CREATE OR REPLACE FUNCTION hs_search_text(node jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE result text;
BEGIN
 -- Match native plainText: per-reader reference labels are never indexed.
 IF node->>'type' IN ('pageLink','tableOfContents') THEN RETURN ''; END IF;
 IF node ? 'text' THEN RETURN COALESCE(node->>'text',''); END IF;
 SELECT COALESCE(string_agg(hs_search_text(value),
  CASE WHEN node->>'type' IN ('paragraph','heading','detailsSummary','codeBlock') THEN '' ELSE E'\n' END ORDER BY ordinal),'') INTO result
 FROM jsonb_array_elements(COALESCE(node->'content','[]'::jsonb)) WITH ORDINALITY AS child(value,ordinal);
 RETURN result;
END
$$;
CREATE OR REPLACE FUNCTION hs_refresh_search(target text) RETURNS void
LANGUAGE sql AS $$
 INSERT INTO hs_workspace_search(page_id,body,title)
 SELECT p.id,COALESCE(string_agg(hs_search_text(b.node),E'\n' ORDER BY b.position),''),p.title
 FROM hs_pages p LEFT JOIN hs_blocks b ON b.page_id=p.id AND b.parent_id IS NULL
 WHERE p.id=target GROUP BY p.id
 ON CONFLICT(page_id) DO UPDATE SET body=EXCLUDED.body,title=EXCLUDED.title
$$;
CREATE OR REPLACE FUNCTION hs_search_block_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE target text;
BEGIN
 IF TG_OP='INSERT' THEN
  FOR target IN SELECT DISTINCT page_id FROM search_new LOOP PERFORM hs_refresh_search(target); END LOOP;
 ELSIF TG_OP='DELETE' THEN
  FOR target IN SELECT DISTINCT page_id FROM search_old LOOP PERFORM hs_refresh_search(target); END LOOP;
 ELSE
  FOR target IN SELECT page_id FROM search_new UNION SELECT page_id FROM search_old LOOP PERFORM hs_refresh_search(target); END LOOP;
 END IF;
 RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS hs_search_blocks ON hs_blocks;
DROP TRIGGER IF EXISTS hs_search_blocks_insert ON hs_blocks;
DROP TRIGGER IF EXISTS hs_search_blocks_update ON hs_blocks;
DROP TRIGGER IF EXISTS hs_search_blocks_delete ON hs_blocks;
CREATE TRIGGER hs_search_blocks_insert AFTER INSERT ON hs_blocks REFERENCING NEW TABLE AS search_new
FOR EACH STATEMENT EXECUTE FUNCTION hs_search_block_change();
CREATE TRIGGER hs_search_blocks_update AFTER UPDATE ON hs_blocks REFERENCING NEW TABLE AS search_new OLD TABLE AS search_old
FOR EACH STATEMENT EXECUTE FUNCTION hs_search_block_change();
CREATE TRIGGER hs_search_blocks_delete AFTER DELETE ON hs_blocks REFERENCING OLD TABLE AS search_old
FOR EACH STATEMENT EXECUTE FUNCTION hs_search_block_change();
CREATE OR REPLACE FUNCTION hs_search_page_change() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 INSERT INTO hs_workspace_search(page_id,title) VALUES(NEW.id,NEW.title)
 ON CONFLICT(page_id) DO UPDATE SET title=EXCLUDED.title;
 RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS hs_search_pages ON hs_pages;
CREATE TRIGGER hs_search_pages AFTER INSERT OR UPDATE OF title ON hs_pages
FOR EACH ROW EXECUTE FUNCTION hs_search_page_change();
-- Idempotent initial projection, also covering empty pages through query COALESCE.
INSERT INTO hs_workspace_search(page_id,body,title)
SELECT p.id,COALESCE(string_agg(hs_search_text(b.node),E'\n' ORDER BY b.position),''),p.title
FROM hs_pages p LEFT JOIN hs_blocks b ON b.page_id=p.id AND b.parent_id IS NULL
WHERE NOT EXISTS(SELECT 1 FROM hs_workspace_search x WHERE x.page_id=p.id)
GROUP BY p.id ON CONFLICT DO NOTHING;
