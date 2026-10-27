-- Empty authority/mapping registries. No tenant, membership or grant is inferred.
CREATE TABLE IF NOT EXISTS hs_data_tenants (
 id uuid PRIMARY KEY, name text NOT NULL CHECK(char_length(btrim(name)) BETWEEN 1 AND 200),
 schema_version integer NOT NULL DEFAULT 1 CHECK(schema_version>0), policy_version integer NOT NULL DEFAULT 1 CHECK(policy_version>0)
);
CREATE TABLE IF NOT EXISTS hs_data_collections (
 tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id), id text NOT NULL,
 name text NOT NULL CHECK(char_length(btrim(name)) BETWEEN 1 AND 100), core boolean NOT NULL DEFAULT false,
 deprecated boolean NOT NULL DEFAULT false, version integer NOT NULL DEFAULT 1,
 PRIMARY KEY(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS hs_data_workspaces (
 workspace_id text PRIMARY KEY REFERENCES hs_workspaces(id) ON DELETE CASCADE,
 tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id), review_reference text NOT NULL CHECK(char_length(review_reference) BETWEEN 1 AND 300)
);
CREATE TABLE IF NOT EXISTS hs_data_records (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
 collection text NOT NULL,
 name text NOT NULL CHECK(char_length(btrim(name)) BETWEEN 1 AND 200),
 name_search text GENERATED ALWAYS AS (lower(name)) STORED,
 field_values jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(field_values)='object'),
 parent_organisation_id uuid,
 parent_collection text GENERATED ALWAYS AS (CASE WHEN collection='accounts' THEN 'organisations' ELSE NULL END) STORED,
 state text NOT NULL DEFAULT 'active' CHECK(state IN ('active','archived','trashed')),
 version integer NOT NULL DEFAULT 1 CHECK(version>0),
 created_by text NOT NULL REFERENCES hs_users(id), updated_by text NOT NULL REFERENCES hs_users(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 archived_at timestamptz, deleted_at timestamptz, recover_until timestamptz,
 UNIQUE(tenant_id,id), UNIQUE(tenant_id,id,collection),
 FOREIGN KEY(tenant_id,collection) REFERENCES hs_data_collections(tenant_id,id),
 CHECK((collection='accounts' AND parent_organisation_id IS NOT NULL) OR (collection<>'accounts' AND parent_organisation_id IS NULL)),
 FOREIGN KEY(tenant_id,parent_organisation_id,parent_collection) REFERENCES hs_data_records(tenant_id,id,collection) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX IF NOT EXISTS hs_data_record_order ON hs_data_records(tenant_id,collection,state,name_search COLLATE "C",id);
CREATE INDEX IF NOT EXISTS hs_data_record_prefix ON hs_data_records(tenant_id,collection,state,name_search text_pattern_ops);
CREATE TABLE IF NOT EXISTS hs_data_collection_grants (
 tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id), user_id text NOT NULL REFERENCES hs_users(id) ON DELETE CASCADE,
 collection text NOT NULL,
 capabilities text[] NOT NULL DEFAULT '{}', version integer NOT NULL DEFAULT 1,
 PRIMARY KEY(tenant_id,user_id,collection), FOREIGN KEY(tenant_id,collection) REFERENCES hs_data_collections(tenant_id,id),
 CHECK(capabilities <@ ARRAY['view','create','edit','link','import','export','bulk','archive','delete','restore','merge','schema','manage-views','history','restore-values']::text[])
);
CREATE TABLE IF NOT EXISTS hs_data_record_grants (
 tenant_id uuid NOT NULL, record_id uuid NOT NULL, user_id text NOT NULL REFERENCES hs_users(id) ON DELETE CASCADE,
 capabilities text[] NOT NULL DEFAULT '{}', version integer NOT NULL DEFAULT 1,
 PRIMARY KEY(tenant_id,record_id,user_id), FOREIGN KEY(tenant_id,record_id) REFERENCES hs_data_records(tenant_id,id) ON DELETE CASCADE,
 CHECK(capabilities <@ ARRAY['view','edit','link','import','export','bulk','archive','delete','restore','merge','history','restore-values']::text[])
);
CREATE INDEX IF NOT EXISTS hs_data_record_grant_actor ON hs_data_record_grants(tenant_id,user_id,record_id) WHERE('view'=ANY(capabilities));
CREATE TABLE IF NOT EXISTS hs_data_fields (
 tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id), collection text NOT NULL,
 field_key text NOT NULL CHECK(field_key ~ '^[a-f0-9-]{36}$'), label text NOT NULL CHECK(char_length(btrim(label)) BETWEEN 1 AND 100),
 kind text NOT NULL CHECK(kind IN ('text','long-text','number','currency','date','boolean','single-select','multi-select','email','phone','url','attachment','record')),
 required boolean NOT NULL DEFAULT false, default_value jsonb, choices jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(choices)='array' AND jsonb_array_length(choices)<=100),
 sensitive boolean NOT NULL DEFAULT false, unique_value boolean NOT NULL DEFAULT false, deprecated boolean NOT NULL DEFAULT false,
 version integer NOT NULL DEFAULT 1, created_by text NOT NULL REFERENCES hs_users(id),
 PRIMARY KEY(tenant_id,collection,field_key), FOREIGN KEY(tenant_id,collection) REFERENCES hs_data_collections(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS hs_data_field_permissions (
 tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id), collection text NOT NULL, field_key text NOT NULL,
 user_id text NOT NULL REFERENCES hs_users(id) ON DELETE CASCADE,
 can_view boolean NOT NULL DEFAULT false, can_write boolean NOT NULL DEFAULT false, can_history boolean NOT NULL DEFAULT false,
 PRIMARY KEY(tenant_id,collection,field_key,user_id)
);
CREATE TABLE IF NOT EXISTS hs_data_relationships (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id), source_id uuid NOT NULL, target_id uuid NOT NULL,
 kind text NOT NULL CHECK(kind IN ('contact-account','employee-account','contract-legal-party','contract-account')),
 source_collection text GENERATED ALWAYS AS (CASE WHEN kind='contact-account' THEN 'contacts' WHEN kind='employee-account' THEN 'employees' ELSE 'contracts' END) STORED,
 target_collection text GENERATED ALWAYS AS (CASE WHEN kind='contract-legal-party' THEN 'organisations' ELSE 'accounts' END) STORED,
 role text NOT NULL DEFAULT '' CHECK(char_length(role)<=100), is_primary boolean NOT NULL DEFAULT false,
 status text NOT NULL DEFAULT 'active' CHECK(status IN ('active','inactive')), version integer NOT NULL DEFAULT 1,
 UNIQUE(tenant_id,kind,source_id,target_id),
 CHECK(kind='contact-account' OR is_primary=false),
 FOREIGN KEY(tenant_id,source_id,source_collection) REFERENCES hs_data_records(tenant_id,id,collection) ON DELETE CASCADE DEFERRABLE INITIALLY DEFERRED,
 FOREIGN KEY(tenant_id,target_id,target_collection) REFERENCES hs_data_records(tenant_id,id,collection) DEFERRABLE INITIALLY DEFERRED
);
CREATE INDEX IF NOT EXISTS hs_data_relationship_target ON hs_data_relationships(tenant_id,target_id);
CREATE TABLE IF NOT EXISTS hs_data_documents (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, record_id uuid NOT NULL, page_id text REFERENCES hs_pages(id) ON DELETE SET NULL,
 created_by text NOT NULL REFERENCES hs_users(id), created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,record_id,page_id), FOREIGN KEY(tenant_id,record_id) REFERENCES hs_data_records(tenant_id,id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS hs_data_operations (
 tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id), actor_id text NOT NULL REFERENCES hs_users(id), operation_id uuid NOT NULL,
 request_hash text NOT NULL, kind text NOT NULL, record_id uuid NOT NULL, applied_version integer NOT NULL,
 PRIMARY KEY(tenant_id,actor_id,operation_id), FOREIGN KEY(tenant_id,record_id) REFERENCES hs_data_records(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS hs_data_events (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, record_id uuid NOT NULL, record_version integer NOT NULL,
 actor_id text NOT NULL REFERENCES hs_users(id), source_app text NOT NULL, operation_id uuid NOT NULL,
 kind text NOT NULL, before_value jsonb, after_value jsonb NOT NULL, field_policy jsonb NOT NULL DEFAULT '{}', created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id,record_id,record_version), FOREIGN KEY(tenant_id,record_id) REFERENCES hs_data_records(tenant_id,id)
);
CREATE TABLE IF NOT EXISTS hs_data_change_events (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id), record_id uuid NOT NULL,
 record_version integer NOT NULL, collection text NOT NULL, operation_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(), UNIQUE(tenant_id,record_id,record_version)
);
CREATE TABLE IF NOT EXISTS hs_data_query_cursors (
 token_hash text PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id), workspace_id text NOT NULL REFERENCES hs_workspaces(id),
 actor_id text NOT NULL REFERENCES hs_users(id), scope_hash text NOT NULL, last_name text NOT NULL, last_id uuid NOT NULL,
 expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '5 minutes'
);
CREATE INDEX IF NOT EXISTS hs_data_cursor_expiry ON hs_data_query_cursors(expires_at);
CREATE TABLE IF NOT EXISTS hs_data_unique_values (
 tenant_id uuid NOT NULL, collection text NOT NULL, field_key text NOT NULL, value_hash text NOT NULL, record_id uuid NOT NULL,
 PRIMARY KEY(tenant_id,collection,field_key,value_hash), FOREIGN KEY(tenant_id,record_id) REFERENCES hs_data_records(tenant_id,id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS hs_data_references (
 id uuid PRIMARY KEY, tenant_id uuid NOT NULL, record_id uuid NOT NULL,
 source_app text NOT NULL, source_type text NOT NULL, source_id text NOT NULL, version integer NOT NULL DEFAULT 1,
 UNIQUE(tenant_id,record_id,source_app,source_type,source_id), FOREIGN KEY(tenant_id,record_id) REFERENCES hs_data_records(tenant_id,id)
);

CREATE OR REPLACE FUNCTION hs_data_check_contract_parties() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE tenant uuid; candidate uuid; candidates uuid[];
BEGIN
 IF TG_TABLE_NAME='hs_data_records' THEN tenant:=NEW.tenant_id; candidates:=ARRAY[NEW.id];
 ELSIF TG_OP='DELETE' THEN tenant:=OLD.tenant_id; candidates:=ARRAY[OLD.source_id];
 ELSE tenant:=NEW.tenant_id; candidates:=ARRAY[NEW.source_id]; END IF;
 FOREACH candidate IN ARRAY candidates LOOP
  IF EXISTS(SELECT 1 FROM hs_data_records r WHERE r.tenant_id=tenant AND r.id=candidate AND r.collection='contracts') AND NOT EXISTS(SELECT 1 FROM hs_data_relationships e WHERE e.tenant_id=tenant AND e.source_id=candidate AND e.kind='contract-legal-party') THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Contract requires a legal organisation'; END IF;
 END LOOP;
 RETURN NULL;
END $$;
CREATE OR REPLACE FUNCTION hs_data_guard_identity() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.id<>OLD.id OR NEW.tenant_id<>OLD.tenant_id THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Record identity and tenant are immutable'; END IF;
 IF TG_TABLE_NAME='hs_data_records' THEN IF NEW.collection<>OLD.collection THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Record collection is immutable'; END IF;
 ELSE IF NEW.source_id<>OLD.source_id OR NEW.target_id<>OLD.target_id OR NEW.kind<>OLD.kind THEN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Relationship endpoints are immutable'; END IF; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS hs_data_contract_parties_record ON hs_data_records;
CREATE CONSTRAINT TRIGGER hs_data_contract_parties_record AFTER INSERT OR UPDATE ON hs_data_records DEFERRABLE INITIALLY DEFERRED FOR EACH ROW WHEN(NEW.collection='contracts') EXECUTE FUNCTION hs_data_check_contract_parties();
DROP TRIGGER IF EXISTS hs_data_contract_parties_edge ON hs_data_relationships;
CREATE CONSTRAINT TRIGGER hs_data_contract_parties_edge AFTER INSERT OR UPDATE OR DELETE ON hs_data_relationships DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION hs_data_check_contract_parties();
DROP TRIGGER IF EXISTS hs_data_record_identity ON hs_data_records;
CREATE TRIGGER hs_data_record_identity BEFORE UPDATE ON hs_data_records FOR EACH ROW EXECUTE FUNCTION hs_data_guard_identity();
DROP TRIGGER IF EXISTS hs_data_relationship_identity ON hs_data_relationships;
CREATE TRIGGER hs_data_relationship_identity BEFORE UPDATE ON hs_data_relationships FOR EACH ROW EXECUTE FUNCTION hs_data_guard_identity();
