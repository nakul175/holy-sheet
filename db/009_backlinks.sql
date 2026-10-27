-- The canonical current block table is updated in the document-save transaction.
-- This partial expression index needs no asynchronous queue or copied page titles.
CREATE INDEX IF NOT EXISTS hs_blocks_page_reference ON hs_blocks((node->'attrs'->>'pageId'),page_id) WHERE type='pageLink';
