ALTER TABLE hs_templates ADD COLUMN IF NOT EXISTS source_template_id text;
ALTER TABLE hs_templates ADD COLUMN IF NOT EXISTS source_template_revision integer CHECK (source_template_revision>0);
