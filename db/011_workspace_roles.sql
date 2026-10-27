-- Native HS roles are explicit, workspace-scoped and never inferred from JWT claims.
-- Existing members retain their current grants; no automatic promotion.
ALTER TABLE hs_members ADD COLUMN IF NOT EXISTS role text NOT NULL DEFAULT 'member'
  CHECK (role IN ('member','admin'));
