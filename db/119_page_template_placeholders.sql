-- HOLY-93 page templates. Variables stay in the document text. Record placeholders
-- resolve to record blocks at page creation. Existing pages keep their copied revision.
ALTER TABLE hs_templates ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'General';
ALTER TABLE hs_templates ADD COLUMN IF NOT EXISTS restricted boolean NOT NULL DEFAULT false;
ALTER TABLE hs_template_revisions ADD COLUMN IF NOT EXISTS category text NOT NULL DEFAULT 'General';
ALTER TABLE hs_templates DROP CONSTRAINT IF EXISTS hs_templates_category_length;
ALTER TABLE hs_templates ADD CONSTRAINT hs_templates_category_length CHECK (char_length(btrim(category)) BETWEEN 1 AND 40);
