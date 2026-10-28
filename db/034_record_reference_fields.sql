-- No bindings or grants are created. Tenant-qualified foreign keys prevent
-- a custom field from resolving a list from another tenant.
ALTER TABLE hs_data_fields ADD COLUMN IF NOT EXISTS reference_list_id uuid;
DO $$ BEGIN
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='hs_data_field_reference_list') THEN
  ALTER TABLE hs_data_fields ADD CONSTRAINT hs_data_field_reference_list
   FOREIGN KEY(tenant_id,reference_list_id) REFERENCES hs_data_reference_lists(tenant_id,id);
 END IF;
 IF NOT EXISTS(SELECT 1 FROM pg_constraint WHERE conname='hs_data_field_reference_kind') THEN
  ALTER TABLE hs_data_fields ADD CONSTRAINT hs_data_field_reference_kind
   CHECK(reference_list_id IS NULL OR (kind IN('single-select','multi-select') AND choices='[]'::jsonb));
 END IF;
END $$;
