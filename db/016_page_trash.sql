CREATE TABLE IF NOT EXISTS hs_deletion_batches (
 id uuid PRIMARY KEY,workspace_id text NOT NULL REFERENCES hs_workspaces(id),root_id text NOT NULL REFERENCES hs_pages(id),
 deleted_by text NOT NULL REFERENCES hs_users(id),deleted_at timestamptz NOT NULL,expires_at timestamptz NOT NULL,
 page_count integer NOT NULL CHECK(page_count>0),restored_at timestamptz,restored_by text REFERENCES hs_users(id)
);
ALTER TABLE hs_pages ADD COLUMN IF NOT EXISTS deletion_batch_id uuid REFERENCES hs_deletion_batches(id);
CREATE INDEX IF NOT EXISTS hs_pages_deletion_batch ON hs_pages(deletion_batch_id) WHERE deleted_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS hs_deletion_batches_workspace ON hs_deletion_batches(workspace_id,deleted_at DESC,id);
CREATE TABLE IF NOT EXISTS hs_trash_operations (
 workspace_id text NOT NULL REFERENCES hs_workspaces(id),operation_id uuid NOT NULL,actor_id text NOT NULL REFERENCES hs_users(id),
 root_id text NOT NULL REFERENCES hs_pages(id),kind text NOT NULL CHECK(kind IN ('delete','restore')),
 request_hash text NOT NULL,result jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(workspace_id,operation_id)
);
-- Older application versions must not purge recoverable clean bytes after an app rollback.
-- Rejected/quarantined bytes remain removable immediately; no scheduler is installed.
CREATE OR REPLACE FUNCTION hs_media_trash_retention() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.state='purging' AND OLD.state='ready' AND OLD.scanned_at IS NOT NULL
 AND EXISTS(SELECT 1 FROM hs_pages p LEFT JOIN hs_deletion_batches b ON b.id=p.deletion_batch_id
   WHERE p.id=OLD.page_id AND p.deleted_at IS NOT NULL
   AND COALESCE(b.expires_at,p.deleted_at+interval '30 days')>clock_timestamp())
 THEN RAISE EXCEPTION 'Recoverable Trash media cannot be purged'; END IF;
 RETURN NEW;
END;
$$;
CREATE OR REPLACE TRIGGER hs_media_trash_retention BEFORE UPDATE OF state ON hs_media FOR EACH ROW EXECUTE FUNCTION hs_media_trash_retention();
-- Private, short-lived query cursors. User-entered filter text is never persisted.
CREATE TABLE IF NOT EXISTS hs_trash_query_cursors(
 token_hash text PRIMARY KEY,workspace_id text NOT NULL REFERENCES hs_workspaces(id),actor_id text NOT NULL REFERENCES hs_users(id),
 query_hash text NOT NULL,tree_version integer NOT NULL,access_version integer NOT NULL,
 last_deleted_at timestamptz NOT NULL,last_id uuid NOT NULL,
 expires_at timestamptz NOT NULL DEFAULT clock_timestamp()+interval '5 minutes');
CREATE INDEX IF NOT EXISTS hs_trash_query_cursor_expiry ON hs_trash_query_cursors(expires_at);
