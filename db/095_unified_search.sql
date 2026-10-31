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

CREATE OR REPLACE FUNCTION hs_refresh_record_search(target_tenant uuid, target_record uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
 rec hs_data_records%ROWTYPE;
 key text; val jsonb; body text; label text; fkind text; elem text; media_name text;
BEGIN
 DELETE FROM hs_record_search WHERE tenant_id=target_tenant AND record_id=target_record;
 SELECT * INTO rec FROM hs_data_records WHERE tenant_id=target_tenant AND id=target_record;
 IF NOT FOUND OR rec.merged_into_id IS NOT NULL THEN RETURN; END IF;
 INSERT INTO hs_record_search(tenant_id, record_id, kind, field_key, source_id, title, body, collection, owner_id, updated_at)
 VALUES (rec.tenant_id, rec.id, 'record', '', '', left(rec.name, 200), left(rec.name, 200), rec.collection, rec.created_by, rec.updated_at);
 FOR key, val IN SELECT e.key, e.value FROM jsonb_each(rec.field_values) AS e LOOP
  SELECT f.label, f.kind INTO label, fkind FROM hs_data_fields f
   WHERE f.tenant_id=rec.tenant_id AND f.collection=rec.collection AND f.field_key=key;
  IF NOT FOUND THEN
   label := CASE key
    WHEN 'core:domain' THEN 'Domain' WHEN 'core:registration' THEN 'Registration reference' WHEN 'core:notes' THEN 'Notes'
    WHEN 'core:status' THEN 'Status' WHEN 'core:email' THEN 'Email' WHEN 'core:phone' THEN 'Phone'
    WHEN 'core:job-title' THEN 'Job title' WHEN 'core:start-date' THEN 'Start date' WHEN 'core:end-date' THEN 'End date'
    WHEN 'core:active' THEN 'Active staff' WHEN 'core:reference' THEN 'Contract reference' WHEN 'core:amount' THEN 'Contract amount'
    ELSE key END;
   fkind := CASE
    WHEN key='core:amount' THEN 'currency'
    WHEN key IN ('core:email') THEN 'email'
    WHEN key IN ('core:phone') THEN 'phone'
    ELSE 'text' END;
  END IF;
  IF EXISTS (SELECT 1 FROM hs_data_fields f WHERE f.tenant_id=rec.tenant_id AND f.collection=rec.collection AND f.field_key=key AND (f.deprecated OR f.kind='record')) THEN CONTINUE; END IF;
  IF fkind='record' THEN CONTINUE; END IF;
  IF fkind='attachment' AND jsonb_typeof(val)='array' THEN
   FOR elem IN SELECT jsonb_array_elements_text(val) LOOP
    IF elem ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
     SELECT m.name INTO media_name FROM hs_media m WHERE m.id=elem::uuid AND m.state='ready' AND m.deleted_at IS NULL;
     IF FOUND AND btrim(media_name)<>'' THEN
      INSERT INTO hs_record_search(tenant_id, record_id, kind, field_key, source_id, title, body, collection, owner_id, updated_at)
      VALUES (rec.tenant_id, rec.id, 'attachment', key, elem, left(media_name, 500), left(media_name, 500), rec.collection, rec.created_by, rec.updated_at)
      ON CONFLICT DO NOTHING;
     END IF;
    END IF;
   END LOOP;
   CONTINUE;
  END IF;
  body := left(hs_search_json_text(val), 20000);
  IF body IS NULL OR btrim(body)='' THEN CONTINUE; END IF;
  INSERT INTO hs_record_search(tenant_id, record_id, kind, field_key, source_id, title, body, collection, owner_id, updated_at)
  VALUES (rec.tenant_id, rec.id, 'field', key, '', left(label, 200), body, rec.collection, rec.created_by, rec.updated_at)
  ON CONFLICT DO NOTHING;
 END LOOP;
END $$;

CREATE OR REPLACE FUNCTION hs_record_search_row() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
 PERFORM hs_refresh_record_search(NEW.tenant_id, NEW.id);
 RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS hs_record_search_write ON hs_data_records;
CREATE TRIGGER hs_record_search_write AFTER INSERT OR UPDATE ON hs_data_records
FOR EACH ROW EXECUTE FUNCTION hs_record_search_row();

CREATE OR REPLACE FUNCTION hs_record_search_field_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE rec_id uuid; t uuid; c text;
BEGIN
 t := COALESCE(NEW.tenant_id, OLD.tenant_id);
 c := COALESCE(NEW.collection, OLD.collection);
 FOR rec_id IN SELECT id FROM hs_data_records WHERE tenant_id=t AND collection=c LOOP
  PERFORM hs_refresh_record_search(t, rec_id);
 END LOOP;
 RETURN NULL;
END $$;
DROP TRIGGER IF EXISTS hs_record_search_fields ON hs_data_fields;
CREATE TRIGGER hs_record_search_fields AFTER INSERT OR UPDATE OR DELETE ON hs_data_fields
FOR EACH ROW EXECUTE FUNCTION hs_record_search_field_change();

CREATE OR REPLACE FUNCTION hs_attachment_search_change() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE rec record;
BEGIN
 IF TG_OP='DELETE' THEN
  DELETE FROM hs_attachment_search WHERE media_id=OLD.id;
  FOR rec IN SELECT r.tenant_id, r.id AS record_id FROM hs_data_records r WHERE r.field_values::text LIKE '%' || OLD.id::text || '%' LOOP
   PERFORM hs_refresh_record_search(rec.tenant_id, rec.record_id);
  END LOOP;
  RETURN NULL;
 END IF;
 INSERT INTO hs_attachment_search(media_id, page_id, name, active)
 VALUES (NEW.id, NEW.page_id, left(NEW.name, 500), NEW.state='ready' AND NEW.deleted_at IS NULL)
 ON CONFLICT (media_id) DO UPDATE SET page_id=EXCLUDED.page_id, name=EXCLUDED.name, active=EXCLUDED.active;
 FOR rec IN SELECT r.tenant_id, r.id AS record_id FROM hs_data_records r WHERE r.field_values::text LIKE '%' || NEW.id::text || '%' LOOP
  PERFORM hs_refresh_record_search(rec.tenant_id, rec.record_id);
 END LOOP;
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

DO $$ DECLARE target text; BEGIN
 FOR target IN SELECT id FROM hs_pages LOOP PERFORM hs_refresh_block_search(target); END LOOP;
END $$;
DO $$ DECLARE rec record; BEGIN
 FOR rec IN SELECT tenant_id, id FROM hs_data_records LOOP PERFORM hs_refresh_record_search(rec.tenant_id, rec.id); END LOOP;
END $$;
INSERT INTO hs_attachment_search(media_id, page_id, name, active)
SELECT m.id, m.page_id, left(m.name, 500), m.state='ready' AND m.deleted_at IS NULL
FROM hs_media m
ON CONFLICT (media_id) DO UPDATE SET page_id=EXCLUDED.page_id, name=EXCLUDED.name, active=EXCLUDED.active;
