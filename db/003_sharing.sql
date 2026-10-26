ALTER TABLE hs_pages ADD COLUMN IF NOT EXISTS acl_version integer NOT NULL DEFAULT 1;
CREATE TABLE IF NOT EXISTS hs_share_operations (
 page_id text NOT NULL REFERENCES hs_pages(id), operation_id uuid NOT NULL,
 actor_id text NOT NULL REFERENCES hs_users(id), request_hash text NOT NULL,
 applied_version integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
 PRIMARY KEY(page_id,operation_id)
);
CREATE TABLE IF NOT EXISTS hs_audit (
 id uuid PRIMARY KEY, actor_id text NOT NULL REFERENCES hs_users(id),
 action text NOT NULL, page_id text REFERENCES hs_pages(id), subject_id text,
 before_value jsonb, after_value jsonb, correlation_id uuid NOT NULL,
 created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS hs_pages_parent ON hs_pages(parent_id);
CREATE INDEX IF NOT EXISTS hs_audit_page ON hs_audit(page_id,created_at);
CREATE OR REPLACE FUNCTION hs_audit_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Audit events are append-only'; END;
$$;
CREATE OR REPLACE TRIGGER hs_audit_immutable BEFORE UPDATE OR DELETE ON hs_audit
FOR EACH ROW EXECUTE FUNCTION hs_audit_append_only();
