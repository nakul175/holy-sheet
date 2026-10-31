-- Record follows and comment notifications. A follow never grants record, field, or workspace access.
CREATE TABLE IF NOT EXISTS hs_data_record_follows (
 tenant_id uuid NOT NULL,
 record_id uuid NOT NULL,
 user_id text NOT NULL REFERENCES hs_users(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,record_id,user_id),
 FOREIGN KEY(tenant_id,record_id) REFERENCES hs_data_records(tenant_id,id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS hs_data_record_follow_user ON hs_data_record_follows(user_id,tenant_id,record_id);
CREATE TABLE IF NOT EXISTS hs_data_record_notification_events (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL,
 workspace_id text NOT NULL REFERENCES hs_workspaces(id),
 record_id uuid NOT NULL,
 comment_id uuid NOT NULL REFERENCES hs_data_record_comments(id),
 actor_id text NOT NULL REFERENCES hs_users(id),
 recipients jsonb NOT NULL CHECK(jsonb_typeof(recipients)='array'),
 delivered_at timestamptz,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(tenant_id,record_id) REFERENCES hs_data_records(tenant_id,id)
);
CREATE INDEX IF NOT EXISTS hs_data_record_notification_pending ON hs_data_record_notification_events(created_at,id) WHERE delivered_at IS NULL;
CREATE TABLE IF NOT EXISTS hs_data_record_notifications (
 id uuid PRIMARY KEY,
 event_id uuid NOT NULL REFERENCES hs_data_record_notification_events(id),
 recipient_id text NOT NULL REFERENCES hs_users(id),
 tenant_id uuid NOT NULL,
 workspace_id text NOT NULL REFERENCES hs_workspaces(id),
 record_id uuid NOT NULL,
 comment_id uuid NOT NULL REFERENCES hs_data_record_comments(id),
 reason text NOT NULL CHECK(reason IN ('mention','follow')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 read_at timestamptz,
 UNIQUE(event_id,recipient_id),
 FOREIGN KEY(tenant_id,record_id) REFERENCES hs_data_records(tenant_id,id)
);
CREATE INDEX IF NOT EXISTS hs_data_record_notification_inbox ON hs_data_record_notifications(recipient_id,tenant_id,created_at DESC,id);
