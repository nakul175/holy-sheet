ALTER TABLE hs_media ADD COLUMN IF NOT EXISTS reservation_expires_at timestamptz;
UPDATE hs_media SET reservation_expires_at=created_at+interval '30 minutes' WHERE reservation_expires_at IS NULL;
ALTER TABLE hs_media ALTER COLUMN reservation_expires_at SET DEFAULT (clock_timestamp()+interval '30 minutes');
ALTER TABLE hs_media ALTER COLUMN reservation_expires_at SET NOT NULL;
ALTER TABLE hs_media ADD COLUMN IF NOT EXISTS recovery_draft_id uuid REFERENCES hs_drafts(id) ON DELETE SET NULL;
