-- HOLY-21 permission administration. No grants, memberships or field rights are inserted.
ALTER TABLE hs_data_collection_grants DROP CONSTRAINT IF EXISTS hs_data_collection_grants_capabilities_check;
ALTER TABLE hs_data_collection_grants ADD CONSTRAINT hs_data_collection_grants_capabilities_check CHECK(capabilities <@ ARRAY['view','create','edit','link','import','export','bulk','archive','delete','restore','merge','schema','manage-views','history','restore-values','manage-templates','manage-permissions']::text[]);

ALTER TABLE hs_data_field_permissions ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1 CHECK(version>0);

CREATE TABLE IF NOT EXISTS hs_data_permission_operations (
 tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
 actor_id text NOT NULL REFERENCES hs_users(id),
 operation_id uuid NOT NULL,
 request_hash text NOT NULL,
 response jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,actor_id,operation_id)
);
