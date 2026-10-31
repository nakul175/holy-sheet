-- Record comments. A comment never grants record, field, or workspace access.
CREATE TABLE IF NOT EXISTS hs_data_record_comments (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL,
 record_id uuid NOT NULL,
 author_id text NOT NULL REFERENCES hs_users(id),
 body text NOT NULL CHECK(char_length(btrim(body))>=1 AND char_length(body)<=10000),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(tenant_id,record_id) REFERENCES hs_data_records(tenant_id,id)
);
CREATE INDEX IF NOT EXISTS hs_data_record_comment_order ON hs_data_record_comments(tenant_id,record_id,created_at DESC,id DESC);
CREATE TABLE IF NOT EXISTS hs_data_record_comment_mentions (
 comment_id uuid NOT NULL REFERENCES hs_data_record_comments(id),
 user_id text NOT NULL REFERENCES hs_users(id),
 PRIMARY KEY(comment_id,user_id)
);
CREATE TABLE IF NOT EXISTS hs_data_record_comment_operations (
 tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
 actor_id text NOT NULL REFERENCES hs_users(id),
 operation_id uuid NOT NULL,
 request_hash text NOT NULL,
 record_id uuid NOT NULL,
 comment_id uuid NOT NULL REFERENCES hs_data_record_comments(id),
 PRIMARY KEY(tenant_id,actor_id,operation_id),
 FOREIGN KEY(tenant_id,record_id) REFERENCES hs_data_records(tenant_id,id)
);
CREATE OR REPLACE FUNCTION hs_data_record_comment_immutable() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION USING ERRCODE='23514',MESSAGE='Record comments are immutable'; END $$;
DROP TRIGGER IF EXISTS hs_data_record_comments_immutable ON hs_data_record_comments;
CREATE TRIGGER hs_data_record_comments_immutable BEFORE UPDATE OR DELETE ON hs_data_record_comments FOR EACH ROW EXECUTE FUNCTION hs_data_record_comment_immutable();
DROP TRIGGER IF EXISTS hs_data_record_comment_mentions_immutable ON hs_data_record_comment_mentions;
CREATE TRIGGER hs_data_record_comment_mentions_immutable BEFORE UPDATE OR DELETE ON hs_data_record_comment_mentions FOR EACH ROW EXECUTE FUNCTION hs_data_record_comment_immutable();
DROP TRIGGER IF EXISTS hs_data_record_comment_operations_immutable ON hs_data_record_comment_operations;
CREATE TRIGGER hs_data_record_comment_operations_immutable BEFORE UPDATE OR DELETE ON hs_data_record_comment_operations FOR EACH ROW EXECUTE FUNCTION hs_data_record_comment_immutable();
