-- Record responsibility. A handover never grants record, field, or workspace access.
CREATE TABLE IF NOT EXISTS hs_data_record_responsibility (
 tenant_id uuid NOT NULL,
 record_id uuid NOT NULL,
 user_id text REFERENCES hs_users(id),
 assigned_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id,record_id),
 FOREIGN KEY(tenant_id,record_id) REFERENCES hs_data_records(tenant_id,id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS hs_data_record_handovers (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL,
 record_id uuid NOT NULL,
 from_user_id text NOT NULL REFERENCES hs_users(id),
 to_user_id text NOT NULL REFERENCES hs_users(id),
 state text NOT NULL CHECK(state IN ('pending','accepted','cancelled')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 resolved_at timestamptz,
 FOREIGN KEY(tenant_id,record_id) REFERENCES hs_data_records(tenant_id,id) ON DELETE CASCADE,
 CHECK(from_user_id<>to_user_id)
);
CREATE UNIQUE INDEX IF NOT EXISTS hs_data_record_handover_one_pending ON hs_data_record_handovers(tenant_id,record_id) WHERE state='pending';
CREATE INDEX IF NOT EXISTS hs_data_record_handover_target ON hs_data_record_handovers(tenant_id,to_user_id,state,created_at DESC);
CREATE TABLE IF NOT EXISTS hs_data_record_handover_operations (
 tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
 actor_id text NOT NULL REFERENCES hs_users(id),
 operation_id uuid NOT NULL,
 request_hash text NOT NULL,
 record_id uuid NOT NULL,
 handover_id uuid NOT NULL REFERENCES hs_data_record_handovers(id),
 kind text NOT NULL CHECK(kind IN ('offer','accept','cancel')),
 PRIMARY KEY(tenant_id,actor_id,operation_id),
 FOREIGN KEY(tenant_id,record_id) REFERENCES hs_data_records(tenant_id,id)
);
