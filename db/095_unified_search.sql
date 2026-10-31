-- HOLY-58: searchable text for blocks, records, fields and attachments.
-- Permissions are not copied. Queries recheck current grants and field rights.
CREATE TABLE IF NOT EXISTS hs_block_search (
 block_id text PRIMARY KEY REFERENCES hs_blocks(id) ON DELETE CASCADE,
 page_id text NOT NULL REFERENCES hs_pages(id) ON DELETE CASCADE,
 body text NOT NULL,
 ascii_only boolean GENERATED ALWAYS AS (length(body)=octet_length(body)) STORED
);
CREATE INDEX IF NOT EXISTS hs_block_search_page ON hs_block_search(page_id);

CREATE TABLE IF NOT EXISTS hs_attachment_search (
 media_id uuid PRIMARY KEY REFERENCES hs_media(id) ON DELETE CASCADE,
 page_id text NOT NULL REFERENCES hs_pages(id) ON DELETE CASCADE,
 name text NOT NULL,
 active boolean NOT NULL,
 ascii_only boolean GENERATED ALWAYS AS (length(name)=octet_length(name)) STORED
);
CREATE INDEX IF NOT EXISTS hs_attachment_search_page ON hs_attachment_search(page_id) WHERE active;

CREATE TABLE IF NOT EXISTS hs_record_search (
 tenant_id uuid NOT NULL,
 record_id uuid NOT NULL,
 kind text NOT NULL CHECK (kind IN ('record','field','attachment')),
 field_key text NOT NULL DEFAULT '',
 source_id text NOT NULL DEFAULT '',
 title text NOT NULL,
 body text NOT NULL,
 collection text NOT NULL,
 owner_id text NOT NULL,
 updated_at timestamptz NOT NULL,
 ascii_only boolean GENERATED ALWAYS AS (length(title)=octet_length(title) AND length(body)=octet_length(body)) STORED,
 PRIMARY KEY (tenant_id, record_id, kind, field_key, source_id),
 FOREIGN KEY (tenant_id, record_id) REFERENCES hs_data_records(tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS hs_record_search_collection ON hs_record_search(tenant_id, collection, kind);

CREATE OR REPLACE FUNCTION hs_search_json_text(value jsonb) RETURNS text
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE item jsonb; parts text[] := ARRAY[]::text[];
BEGIN
 IF value IS NULL OR jsonb_typeof(value)='null' THEN RETURN ''; END IF;
 IF jsonb_typeof(value)='string' THEN RETURN value #>> '{}'; END IF;
 IF jsonb_typeof(value)='number' OR jsonb_typeof(value)='boolean' THEN RETURN value #>> '{}'; END IF;
 IF jsonb_typeof(value)='array' THEN
  FOR item IN SELECT * FROM jsonb_array_elements(value) LOOP
   parts := parts || hs_search_json_text(item);
  END LOOP;
  RETURN array_to_string(parts, ' ');
 END IF;
 IF jsonb_typeof(value)='object' AND value ? 'currency' AND value ? 'minorUnits' THEN
  RETURN COALESCE(value->>'currency','') || ' ' || COALESCE(value->>'minorUnits','');
 END IF;
 RETURN '';
END $$;

-- Core sensitivity matches standardRecordFields. Unknown keys are not visible.
CREATE OR REPLACE FUNCTION hs_record_field_sensitive(collection text, field_key text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
 SELECT field_key IN ('core:email','core:phone','core:amount')
  OR (collection='employees' AND field_key='core:start-date')
$$;

CREATE OR REPLACE FUNCTION hs_record_field_core_visible(collection text, field_key text) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
 SELECT CASE collection
  WHEN 'organisations' THEN field_key IN ('core:domain','core:registration','core:notes')
  WHEN 'accounts' THEN field_key IN ('core:status','core:notes')
  WHEN 'contacts' THEN field_key IN ('core:job-title')
  WHEN 'employees' THEN field_key IN ('core:job-title','core:active')
  WHEN 'contracts' THEN field_key IN ('core:reference','core:start-date','core:end-date','core:status','core:notes')
  ELSE false
 END
$$;

-- Deny by default: a field hit needs a non-sensitive definition or an explicit can_view.
CREATE OR REPLACE FUNCTION hs_record_search_field_visible(p_tenant uuid, p_collection text, p_field_key text, p_kind text, p_actor text) RETURNS boolean
LANGUAGE sql STABLE AS $$
 SELECT p_kind='record' OR (
  NOT COALESCE((SELECT f.deprecated FROM hs_data_fields f WHERE f.tenant_id=p_tenant AND f.collection=p_collection AND f.field_key=p_field_key), false)
  AND (
   (
    NOT hs_record_field_sensitive(p_collection, p_field_key)
    AND NOT COALESCE((SELECT f.sensitive FROM hs_data_fields f WHERE f.tenant_id=p_tenant AND f.collection=p_collection AND f.field_key=p_field_key), false)
    AND (
     hs_record_field_core_visible(p_collection, p_field_key)
     OR EXISTS (SELECT 1 FROM hs_data_fields f WHERE f.tenant_id=p_tenant AND f.collection=p_collection AND f.field_key=p_field_key AND NOT f.sensitive AND NOT f.deprecated)
    )
   )
   OR EXISTS (
    SELECT 1 FROM hs_data_field_permissions p
    WHERE p.tenant_id=p_tenant AND p.collection=p_collection AND p.field_key=p_field_key AND p.user_id=p_actor AND p.can_view
    AND (
     hs_record_field_sensitive(p_collection, p_field_key)
     OR EXISTS (SELECT 1 FROM hs_data_fields f WHERE f.tenant_id=p_tenant AND f.collection=p_collection AND f.field_key=p_field_key AND f.sensitive AND NOT f.deprecated)
    )
   )
  )
 )
$$;

CREATE OR REPLACE FUNCTION hs_refresh_block_search(target text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
 DELETE FROM hs_block_search WHERE page_id=target;
 INSERT INTO hs_block_search(block_id, page_id, body)
 SELECT b.id, b.page_id, left(hs_search_text(b.node), 20000)
 FROM hs_blocks b
 WHERE b.page_id=target AND b.parent_id IS NULL AND btrim(hs_search_text(b.node))<>'';
END $$;

CREATE OR REPLACE FUNCTION hs_record_field_label(field_key text, custom_label text) RETURNS text
LANGUAGE sql IMMUTABLE AS $$
 SELECT left(COALESCE(NULLIF(btrim(custom_label), ''), CASE field_key
  WHEN 'core:domain' THEN 'Domain' WHEN 'core:registration' THEN 'Registration reference' WHEN 'core:notes' THEN 'Notes'
  WHEN 'core:status' THEN 'Status' WHEN 'core:email' THEN 'Email' WHEN 'core:phone' THEN 'Phone'
  WHEN 'core:job-title' THEN 'Job title' WHEN 'core:start-date' THEN 'Start date' WHEN 'core:end-date' THEN 'End date'
  WHEN 'core:active' THEN 'Active staff' WHEN 'core:reference' THEN 'Contract reference' WHEN 'core:amount' THEN 'Contract amount'
  ELSE field_key END), 200)
$$;

-- One statement for a bulk insert. A per-row trigger makes the 100k acceptance load miss its deadline.
CREATE OR REPLACE FUNCTION hs_record_search_statement() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
 DELETE FROM hs_record_search s USING search_new n WHERE s.tenant_id=n.tenant_id AND s.record_id=n.id;
 INSERT INTO hs_record_search(tenant_id, record_id, kind, field_key, source_id, title, body, collection, owner_id, updated_at)
 SELECT n.tenant_id, n.id, 'record', '', '', left(n.name, 200), left(n.name, 200), n.collection, n.created_by, n.updated_at
 FROM search_new n WHERE n.merged_into_id IS NULL;
 INSERT INTO hs_record_search(tenant_id, record_id, kind, field_key, source_id, title, body, collection, owner_id, updated_at)
 SELECT n.tenant_id, n.id, 'field', e.key, '', hs_record_field_label(e.key, f.label), left(hs_search_json_text(e.value), 20000), n.collection, n.created_by, n.updated_at
 FROM search_new n
 CROSS JOIN LATERAL jsonb_each(n.field_values) e
 LEFT JOIN hs_data_fields f ON f.tenant_id=n.tenant_id AND f.collection=n.collection AND f.field_key=e.key
 WHERE n.merged_into_id IS NULL
  AND COALESCE(f.deprecated, false)=false
  AND COALESCE(f.kind, '') NOT IN ('record', 'attachment')
  AND btrim(hs_search_json_text(e.value))<>'';
 INSERT INTO hs_record_search(tenant_id, record_id, kind, field_key, source_id, title, body, collection, owner_id, updated_at)
 SELECT n.tenant_id, n.id, 'attachment', e.key, elem, left(m.name, 500), left(m.name, 500), n.collection, n.created_by, n.updated_at
 FROM search_new n
 CROSS JOIN LATERAL jsonb_each(n.field_values) e
 JOIN hs_data_fields f ON f.tenant_id=n.tenant_id AND f.collection=n.collection AND f.field_key=e.key AND f.kind='attachment' AND NOT f.deprecated
 CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(e.value)='array' THEN e.value ELSE '[]'::jsonb END) elem
 JOIN hs_media m ON m.id::text=elem AND m.state='ready' AND m.deleted_at IS NULL
 WHERE n.merged_into_id IS NULL AND elem ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
 RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS hs_record_search_write ON hs_data_records;
DROP TRIGGER IF EXISTS hs_record_search_insert ON hs_data_records;
DROP TRIGGER IF EXISTS hs_record_search_update ON hs_data_records;
CREATE TRIGGER hs_record_search_insert AFTER INSERT ON hs_data_records
REFERENCING NEW TABLE AS search_new FOR EACH STATEMENT EXECUTE FUNCTION hs_record_search_statement();
CREATE TRIGGER hs_record_search_update AFTER UPDATE ON hs_data_records
REFERENCING NEW TABLE AS search_new FOR EACH STATEMENT EXECUTE FUNCTION hs_record_search_statement();

CREATE OR REPLACE FUNCTION hs_reindex_record_collection(p_tenant uuid, p_collection text) RETURNS void
LANGUAGE plpgsql AS $$
BEGIN
 DELETE FROM hs_record_search s USING hs_data_records r
 WHERE s.tenant_id=r.tenant_id AND s.record_id=r.id AND r.tenant_id=p_tenant AND r.collection=p_collection;
 INSERT INTO hs_record_search(tenant_id, record_id, kind, field_key, source_id, title, body, collection, owner_id, updated_at)
 SELECT r.tenant_id, r.id, 'record', '', '', left(r.name, 200), left(r.name, 200), r.collection, r.created_by, r.updated_at
 FROM hs_data_records r WHERE r.tenant_id=p_tenant AND r.collection=p_collection AND r.merged_into_id IS NULL;
 INSERT INTO hs_record_search(tenant_id, record_id, kind, field_key, source_id, title, body, collection, owner_id, updated_at)
 SELECT r.tenant_id, r.id, 'field', e.key, '', hs_record_field_label(e.key, f.label), left(hs_search_json_text(e.value), 20000), r.collection, r.created_by, r.updated_at
 FROM hs_data_records r
 CROSS JOIN LATERAL jsonb_each(r.field_values) e
 LEFT JOIN hs_data_fields f ON f.tenant_id=r.tenant_id AND f.collection=r.collection AND f.field_key=e.key
 WHERE r.tenant_id=p_tenant AND r.collection=p_collection AND r.merged_into_id IS NULL
  AND COALESCE(f.deprecated, false)=false AND COALESCE(f.kind, '') NOT IN ('record', 'attachment')
  AND btrim(hs_search_json_text(e.value))<>'';
 INSERT INTO hs_record_search(tenant_id, record_id, kind, field_key, source_id, title, body, collection, owner_id, updated_at)
 SELECT r.tenant_id, r.id, 'attachment', e.key, elem, left(m.name, 500), left(m.name, 500), r.collection, r.created_by, r.updated_at
 FROM hs_data_records r
 CROSS JOIN LATERAL jsonb_each(r.field_values) e
 JOIN hs_data_fields f ON f.tenant_id=r.tenant_id AND f.collection=r.collection AND f.field_key=e.key AND f.kind='attachment' AND NOT f.deprecated
 CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(e.value)='array' THEN e.value ELSE '[]'::jsonb END) elem
 JOIN hs_media m ON m.id::text=elem AND m.state='ready' AND m.deleted_at IS NULL
 WHERE r.tenant_id=p_tenant AND r.collection=p_collection AND r.merged_into_id IS NULL
  AND elem ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
END $$;

CREATE OR REPLACE FUNCTION hs_record_search_field_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE t uuid; c text;
BEGIN
 t := COALESCE(NEW.tenant_id, OLD.tenant_id);
 c := COALESCE(NEW.collection, OLD.collection);
 PERFORM hs_reindex_record_collection(t, c);
 RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS hs_record_search_fields ON hs_data_fields;
CREATE TRIGGER hs_record_search_fields AFTER INSERT OR UPDATE OR DELETE ON hs_data_fields
FOR EACH ROW EXECUTE FUNCTION hs_record_search_field_change();

CREATE OR REPLACE FUNCTION hs_attachment_search_change() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP='DELETE' THEN
  DELETE FROM hs_attachment_search WHERE media_id=OLD.id;
  DELETE FROM hs_record_search WHERE kind='attachment' AND source_id=OLD.id::text;
  RETURN NULL;
 END IF;
 INSERT INTO hs_attachment_search(media_id, page_id, name, active)
 VALUES (NEW.id, NEW.page_id, left(NEW.name, 500), NEW.state='ready' AND NEW.deleted_at IS NULL)
 ON CONFLICT (media_id) DO UPDATE SET page_id=EXCLUDED.page_id, name=EXCLUDED.name, active=EXCLUDED.active;
 IF NEW.state='ready' AND NEW.deleted_at IS NULL THEN
  UPDATE hs_record_search SET title=left(NEW.name, 500), body=left(NEW.name, 500)
  WHERE kind='attachment' AND source_id=NEW.id::text;
 ELSE
  DELETE FROM hs_record_search WHERE kind='attachment' AND source_id=NEW.id::text;
 END IF;
 RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS hs_attachment_search_write ON hs_media;
CREATE TRIGGER hs_attachment_search_write AFTER INSERT OR UPDATE OF name, state, deleted_at, page_id OR DELETE ON hs_media
FOR EACH ROW EXECUTE FUNCTION hs_attachment_search_change();

-- Keep the page projection refresh and add block rows in the same statement.
CREATE OR REPLACE FUNCTION hs_search_block_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE target text;
BEGIN
 IF TG_OP='INSERT' THEN
  FOR target IN SELECT DISTINCT page_id FROM search_new LOOP
   PERFORM hs_refresh_search(target);
   PERFORM hs_refresh_block_search(target);
  END LOOP;
 ELSIF TG_OP='DELETE' THEN
  FOR target IN SELECT DISTINCT page_id FROM search_old LOOP
   PERFORM hs_refresh_search(target);
   PERFORM hs_refresh_block_search(target);
  END LOOP;
 ELSE
  FOR target IN SELECT page_id FROM search_new UNION SELECT page_id FROM search_old LOOP
   PERFORM hs_refresh_search(target);
   PERFORM hs_refresh_block_search(target);
  END LOOP;
 END IF;
 RETURN NULL;
END $$;

INSERT INTO hs_block_search(block_id, page_id, body)
SELECT b.id, b.page_id, left(hs_search_text(b.node), 20000)
FROM hs_blocks b
WHERE b.parent_id IS NULL AND btrim(hs_search_text(b.node))<>''
AND NOT EXISTS (SELECT 1 FROM hs_block_search s WHERE s.block_id=b.id)
ON CONFLICT (block_id) DO NOTHING;
-- Missing rows only. Rows written by the statement trigger are left in place so
-- replaying this file does not walk every existing record one at a time.
INSERT INTO hs_record_search(tenant_id, record_id, kind, field_key, source_id, title, body, collection, owner_id, updated_at)
SELECT r.tenant_id, r.id, 'field', e.key, '', hs_record_field_label(e.key, f.label), left(hs_search_json_text(e.value), 20000), r.collection, r.created_by, r.updated_at
FROM hs_data_records r
CROSS JOIN LATERAL jsonb_each(r.field_values) e
LEFT JOIN hs_data_fields f ON f.tenant_id=r.tenant_id AND f.collection=r.collection AND f.field_key=e.key
WHERE r.merged_into_id IS NULL
AND NOT EXISTS (SELECT 1 FROM hs_record_search s WHERE s.tenant_id=r.tenant_id AND s.record_id=r.id AND s.kind='record')
AND COALESCE(f.deprecated, false)=false AND COALESCE(f.kind, '') NOT IN ('record', 'attachment')
AND btrim(hs_search_json_text(e.value))<>''
ON CONFLICT DO NOTHING;
INSERT INTO hs_record_search(tenant_id, record_id, kind, field_key, source_id, title, body, collection, owner_id, updated_at)
SELECT r.tenant_id, r.id, 'attachment', e.key, elem, left(m.name, 500), left(m.name, 500), r.collection, r.created_by, r.updated_at
FROM hs_data_records r
CROSS JOIN LATERAL jsonb_each(r.field_values) e
JOIN hs_data_fields f ON f.tenant_id=r.tenant_id AND f.collection=r.collection AND f.field_key=e.key AND f.kind='attachment' AND NOT f.deprecated
CROSS JOIN LATERAL jsonb_array_elements_text(CASE WHEN jsonb_typeof(e.value)='array' THEN e.value ELSE '[]'::jsonb END) elem
JOIN hs_media m ON m.id::text=elem AND m.state='ready' AND m.deleted_at IS NULL
WHERE r.merged_into_id IS NULL
AND NOT EXISTS (SELECT 1 FROM hs_record_search s WHERE s.tenant_id=r.tenant_id AND s.record_id=r.id AND s.kind='record')
AND elem ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
ON CONFLICT DO NOTHING;
INSERT INTO hs_record_search(tenant_id, record_id, kind, field_key, source_id, title, body, collection, owner_id, updated_at)
SELECT r.tenant_id, r.id, 'record', '', '', left(r.name, 200), left(r.name, 200), r.collection, r.created_by, r.updated_at
FROM hs_data_records r
WHERE r.merged_into_id IS NULL
AND NOT EXISTS (SELECT 1 FROM hs_record_search s WHERE s.tenant_id=r.tenant_id AND s.record_id=r.id AND s.kind='record')
ON CONFLICT DO NOTHING;
INSERT INTO hs_attachment_search(media_id, page_id, name, active)
SELECT m.id, m.page_id, left(m.name, 500), m.state='ready' AND m.deleted_at IS NULL
FROM hs_media m
ON CONFLICT (media_id) DO UPDATE SET page_id=EXCLUDED.page_id, name=EXCLUDED.name, active=EXCLUDED.active;
