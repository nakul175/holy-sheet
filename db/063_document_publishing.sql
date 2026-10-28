-- HOLY-63: opt-in document workflow; this creates no grants or memberships.
CREATE TABLE IF NOT EXISTS hs_document_workflows (
 page_id text PRIMARY KEY REFERENCES hs_pages(id),
 version integer NOT NULL CHECK(version>0),
 policy_version integer NOT NULL DEFAULT 1,
 reviewers jsonb NOT NULL,
 publication_id uuid,
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS hs_document_reviews (
 id uuid PRIMARY KEY,
 page_id text NOT NULL REFERENCES hs_document_workflows(page_id),
 source_version integer NOT NULL,
 policy_version integer NOT NULL,
 submitted_by text NOT NULL REFERENCES hs_users(id),
 submitted_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 title text NOT NULL,
 document jsonb NOT NULL,
 manifest jsonb NOT NULL,
 snapshot_hash text NOT NULL,
 state text NOT NULL CHECK(state IN ('pending','approved','rejected')),
 decided_by text REFERENCES hs_users(id),
 decided_at timestamptz,
 reason text,
 CHECK ((state='pending')=(decided_by IS NULL))
);
CREATE TABLE IF NOT EXISTS hs_document_publications (
 id uuid PRIMARY KEY,
 page_id text NOT NULL REFERENCES hs_document_workflows(page_id),
 review_id uuid NOT NULL UNIQUE REFERENCES hs_document_reviews(id),
 source_version integer NOT NULL,
 title text NOT NULL,
 document jsonb NOT NULL,
 manifest jsonb NOT NULL,
 snapshot_hash text NOT NULL,
 published_by text NOT NULL REFERENCES hs_users(id),
 published_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE TABLE IF NOT EXISTS hs_document_workflow_operations (
 page_id text NOT NULL REFERENCES hs_document_workflows(page_id),
 operation_id uuid NOT NULL,
 actor_id text NOT NULL REFERENCES hs_users(id),
 request_hash text NOT NULL,
 result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(page_id,operation_id)
);
CREATE OR REPLACE FUNCTION hs_document_publication_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION 'Published document snapshots are immutable'; END;
$$;
CREATE OR REPLACE TRIGGER hs_document_publication_immutable BEFORE UPDATE OR DELETE ON hs_document_publications FOR EACH ROW EXECUTE FUNCTION hs_document_publication_immutable();
CREATE OR REPLACE FUNCTION hs_document_review_snapshot_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.id IS DISTINCT FROM OLD.id OR NEW.page_id IS DISTINCT FROM OLD.page_id
 OR NEW.source_version IS DISTINCT FROM OLD.source_version OR NEW.policy_version IS DISTINCT FROM OLD.policy_version
 OR NEW.submitted_by IS DISTINCT FROM OLD.submitted_by OR NEW.submitted_at IS DISTINCT FROM OLD.submitted_at
 OR NEW.title IS DISTINCT FROM OLD.title OR NEW.document IS DISTINCT FROM OLD.document
 OR NEW.manifest IS DISTINCT FROM OLD.manifest OR NEW.snapshot_hash IS DISTINCT FROM OLD.snapshot_hash
 OR OLD.state<>'pending' THEN RAISE EXCEPTION 'Review snapshot and completed decisions are immutable'; END IF;
 RETURN NEW;
END;
$$;
CREATE OR REPLACE TRIGGER hs_document_review_snapshot_immutable BEFORE UPDATE ON hs_document_reviews FOR EACH ROW EXECUTE FUNCTION hs_document_review_snapshot_immutable();
CREATE INDEX IF NOT EXISTS hs_document_reviews_page ON hs_document_reviews(page_id,submitted_at DESC,id);
-- Reviewed assets remain pinned while their source page exists outside Trash.
-- Rejected/malicious objects still take the security cleanup path first.
CREATE OR REPLACE FUNCTION hs_document_media_retained(media uuid) RETURNS boolean LANGUAGE sql STABLE AS $$
 SELECT EXISTS(SELECT 1 FROM hs_document_reviews r JOIN hs_pages p ON p.id=r.page_id
 WHERE p.deleted_at IS NULL AND r.manifest @> jsonb_build_array(jsonb_build_object('kind','attachment','targetId',media::text)))
$$;

ALTER TABLE hs_export_jobs ADD COLUMN IF NOT EXISTS publication_id uuid REFERENCES hs_document_publications(id);
