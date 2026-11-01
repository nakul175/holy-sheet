-- HOLY-71 integration health and reconciliation.
-- Extends the version-one change outbox and reference ledger for authorised operators.
-- Consumers stay paused: no live activation, credential, schedule, or record grant is stored.
ALTER TABLE hs_data_collection_grants DROP CONSTRAINT IF EXISTS hs_data_collection_grants_capabilities_check;
ALTER TABLE hs_data_collection_grants ADD CONSTRAINT hs_data_collection_grants_capabilities_check CHECK(capabilities <@ ARRAY['view','create','edit','link','import','export','bulk','archive','delete','restore','merge','schema','manage-views','history','restore-values','manage-templates','manage-permissions','manage-forms','manage-reviews','review','manage-import-profiles','manage-external-ids','manage-integration-health']::text[]);

CREATE TABLE IF NOT EXISTS hs_integration_consumers (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
 workspace_id text NOT NULL REFERENCES hs_workspaces(id),
 client_id text NOT NULL CHECK(client_id ~ '^[a-z][a-z0-9-]{0,63}$'),
 label text NOT NULL CHECK(char_length(btrim(label)) BETWEEN 1 AND 100),
 outage text NOT NULL DEFAULT 'none' CHECK(outage IN ('none','partial','isolated')),
 delivery_mode text NOT NULL DEFAULT 'paused' CHECK(delivery_mode = 'paused'),
 live_activation boolean NOT NULL DEFAULT false CHECK(live_activation = false),
 version integer NOT NULL DEFAULT 1 CHECK(version > 0),
 created_by text NOT NULL REFERENCES hs_users(id),
 updated_by text NOT NULL REFERENCES hs_users(id),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id, workspace_id, client_id)
);

CREATE TABLE IF NOT EXISTS hs_integration_consumer_grants (
 tenant_id uuid NOT NULL,
 consumer_id uuid NOT NULL REFERENCES hs_integration_consumers(id),
 user_id text NOT NULL REFERENCES hs_users(id) ON DELETE CASCADE,
 can_read boolean NOT NULL DEFAULT false,
 can_reconcile boolean NOT NULL DEFAULT false,
 can_repair boolean NOT NULL DEFAULT false,
 can_export boolean NOT NULL DEFAULT false,
 can_history boolean NOT NULL DEFAULT false,
 version integer NOT NULL DEFAULT 1 CHECK(version > 0),
 PRIMARY KEY(tenant_id, consumer_id, user_id)
);

CREATE TABLE IF NOT EXISTS hs_integration_consumer_versions (
 tenant_id uuid NOT NULL,
 consumer_id uuid NOT NULL REFERENCES hs_integration_consumers(id),
 version integer NOT NULL CHECK(version > 0),
 client_id text NOT NULL,
 label text NOT NULL,
 outage text NOT NULL,
 actor_id text NOT NULL REFERENCES hs_users(id),
 operation_id uuid NOT NULL,
 source text NOT NULL DEFAULT 'holy-sheet',
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id, consumer_id, version)
);

CREATE TABLE IF NOT EXISTS hs_integration_acknowledgements (
 tenant_id uuid NOT NULL,
 consumer_id uuid NOT NULL REFERENCES hs_integration_consumers(id),
 last_sequence bigint NOT NULL CHECK(last_sequence >= 0),
 event_id uuid,
 record_version integer,
 version integer NOT NULL DEFAULT 1 CHECK(version > 0),
 actor_id text NOT NULL REFERENCES hs_users(id),
 source text NOT NULL DEFAULT 'holy-sheet',
 acknowledged_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id, consumer_id)
);

CREATE TABLE IF NOT EXISTS hs_integration_deliveries (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
 workspace_id text NOT NULL REFERENCES hs_workspaces(id),
 consumer_id uuid NOT NULL REFERENCES hs_integration_consumers(id),
 event_id uuid NOT NULL REFERENCES hs_data_change_events(id),
 event_sequence bigint NOT NULL CHECK(event_sequence >= 0),
 record_id uuid NOT NULL,
 record_version integer NOT NULL CHECK(record_version > 0),
 state text NOT NULL CHECK(state IN ('pending','failed','poison','replay-queued','repaired')),
 attempt_count integer NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 20),
 next_attempt_at timestamptz,
 failure_code text CHECK(failure_code IS NULL OR failure_code ~ '^[a-z][a-z0-9-]{0,40}$'),
 failure_redacted text NOT NULL DEFAULT '' CHECK(char_length(failure_redacted) <= 200),
 version integer NOT NULL DEFAULT 1 CHECK(version > 0),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id, consumer_id, event_id)
);
CREATE INDEX IF NOT EXISTS hs_integration_delivery_consumer ON hs_integration_deliveries(tenant_id, consumer_id, state, updated_at DESC);

CREATE TABLE IF NOT EXISTS hs_integration_operations (
 tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
 actor_id text NOT NULL REFERENCES hs_users(id),
 operation_id uuid NOT NULL,
 request_hash text NOT NULL,
 consumer_id uuid,
 applied_version integer NOT NULL,
 kind text NOT NULL,
 result jsonb NOT NULL,
 PRIMARY KEY(tenant_id, actor_id, operation_id)
);

CREATE TABLE IF NOT EXISTS hs_integration_drafts (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
 workspace_id text NOT NULL REFERENCES hs_workspaces(id),
 actor_id text NOT NULL REFERENCES hs_users(id),
 collection text NOT NULL,
 consumer_id uuid NOT NULL,
 note text NOT NULL DEFAULT '' CHECK(char_length(note) <= 500),
 observations jsonb NOT NULL DEFAULT '{}',
 version integer NOT NULL DEFAULT 1 CHECK(version > 0),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 UNIQUE(tenant_id, workspace_id, actor_id, consumer_id)
);

CREATE TABLE IF NOT EXISTS hs_integration_previews (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
 workspace_id text NOT NULL REFERENCES hs_workspaces(id),
 actor_id text NOT NULL REFERENCES hs_users(id),
 collection text NOT NULL,
 consumer_id uuid,
 action text NOT NULL,
 confirm text NOT NULL,
 payload jsonb NOT NULL,
 review_hash text NOT NULL,
 authority_revision text NOT NULL,
 expires_at timestamptz NOT NULL DEFAULT clock_timestamp() + interval '15 minutes'
);

CREATE TABLE IF NOT EXISTS hs_integration_runs (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
 workspace_id text NOT NULL REFERENCES hs_workspaces(id),
 actor_id text NOT NULL REFERENCES hs_users(id),
 collection text NOT NULL,
 consumer_id uuid NOT NULL REFERENCES hs_integration_consumers(id),
 phase text NOT NULL CHECK(phase IN ('events','records','references','extras','completed')),
 cursor_sequence bigint NOT NULL DEFAULT 0 CHECK(cursor_sequence >= 0),
 observation_offset integer NOT NULL DEFAULT 0 CHECK(observation_offset >= 0),
 reference_cursor text NOT NULL DEFAULT '',
 bound integer NOT NULL CHECK(bound BETWEEN 1 AND 50),
 observations jsonb NOT NULL,
 state text NOT NULL CHECK(state IN ('open','completed')),
 version integer NOT NULL DEFAULT 1 CHECK(version > 0),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS hs_integration_mismatches (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
 run_id uuid NOT NULL REFERENCES hs_integration_runs(id),
 consumer_id uuid NOT NULL REFERENCES hs_integration_consumers(id),
 class text NOT NULL CHECK(class IN ('unacknowledged','version-lag','version-ahead','unknown-record','missing-reference','extra-reference','reference-version','poison')),
 record_id uuid,
 event_id uuid,
 reference_key text,
 canonical_version integer,
 observed_version integer,
 state text NOT NULL DEFAULT 'open' CHECK(state IN ('open','held','queued','isolated')),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);
CREATE UNIQUE INDEX IF NOT EXISTS hs_integration_mismatch_identity ON hs_integration_mismatches(
 run_id, class,
 COALESCE(record_id, '00000000-0000-0000-0000-000000000000'::uuid),
 COALESCE(event_id, '00000000-0000-0000-0000-000000000000'::uuid),
 COALESCE(reference_key, '')
);

CREATE TABLE IF NOT EXISTS hs_integration_repairs (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
 consumer_id uuid NOT NULL REFERENCES hs_integration_consumers(id),
 mismatch_id uuid,
 delivery_id uuid,
 action text NOT NULL,
 decision text NOT NULL,
 applied_version integer NOT NULL,
 actor_id text NOT NULL REFERENCES hs_users(id),
 operation_id uuid NOT NULL,
 source text NOT NULL DEFAULT 'holy-sheet',
 created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE OR REPLACE FUNCTION hs_integration_consumer_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.workspace_id <> OLD.workspace_id OR NEW.client_id <> OLD.client_id OR NEW.created_by <> OLD.created_by OR NEW.created_at <> OLD.created_at OR NEW.delivery_mode <> 'paused' OR NEW.live_activation <> false THEN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Integration consumer identity stays paused and immutable';
 END IF;
 IF NEW.label IS DISTINCT FROM OLD.label OR NEW.outage IS DISTINCT FROM OLD.outage THEN
  IF NEW.version <> OLD.version + 1 THEN
   RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Integration consumer changes require a new version';
  END IF;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS hs_integration_consumer_guard ON hs_integration_consumers;
CREATE TRIGGER hs_integration_consumer_guard BEFORE UPDATE ON hs_integration_consumers FOR EACH ROW EXECUTE FUNCTION hs_integration_consumer_guard();

CREATE OR REPLACE FUNCTION hs_integration_ack_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.tenant_id <> OLD.tenant_id OR NEW.consumer_id <> OLD.consumer_id THEN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Integration acknowledgement identity is immutable';
 END IF;
 IF NEW.last_sequence IS DISTINCT FROM OLD.last_sequence OR NEW.event_id IS DISTINCT FROM OLD.event_id OR NEW.record_version IS DISTINCT FROM OLD.record_version THEN
  IF NEW.version <> OLD.version + 1 OR NEW.last_sequence < OLD.last_sequence THEN
   RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Integration acknowledgement moves forward by one version';
  END IF;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS hs_integration_ack_guard ON hs_integration_acknowledgements;
CREATE TRIGGER hs_integration_ack_guard BEFORE UPDATE ON hs_integration_acknowledgements FOR EACH ROW EXECUTE FUNCTION hs_integration_ack_guard();

CREATE OR REPLACE FUNCTION hs_integration_delivery_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.workspace_id <> OLD.workspace_id OR NEW.consumer_id <> OLD.consumer_id OR NEW.event_id <> OLD.event_id OR NEW.record_id <> OLD.record_id THEN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Integration delivery identity is immutable';
 END IF;
 IF NEW.state IS DISTINCT FROM OLD.state OR NEW.attempt_count IS DISTINCT FROM OLD.attempt_count OR NEW.failure_redacted IS DISTINCT FROM OLD.failure_redacted OR NEW.next_attempt_at IS DISTINCT FROM OLD.next_attempt_at OR NEW.failure_code IS DISTINCT FROM OLD.failure_code THEN
  IF NEW.version <> OLD.version + 1 THEN
   RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Integration delivery changes require a new version';
  END IF;
 END IF;
 IF OLD.state = 'poison' AND NEW.state IS DISTINCT FROM 'poison' THEN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Poison deliveries stay isolated';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS hs_integration_delivery_guard ON hs_integration_deliveries;
CREATE TRIGGER hs_integration_delivery_guard BEFORE UPDATE ON hs_integration_deliveries FOR EACH ROW EXECUTE FUNCTION hs_integration_delivery_guard();

CREATE OR REPLACE FUNCTION hs_integration_run_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.id <> OLD.id OR NEW.tenant_id <> OLD.tenant_id OR NEW.workspace_id <> OLD.workspace_id OR NEW.actor_id <> OLD.actor_id OR NEW.collection <> OLD.collection OR NEW.consumer_id <> OLD.consumer_id OR NEW.bound <> OLD.bound OR NEW.observations <> OLD.observations OR NEW.created_at <> OLD.created_at THEN
  RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Integration reconciliation scope is immutable';
 END IF;
 IF NEW.phase IS DISTINCT FROM OLD.phase OR NEW.cursor_sequence IS DISTINCT FROM OLD.cursor_sequence OR NEW.observation_offset IS DISTINCT FROM OLD.observation_offset OR NEW.reference_cursor IS DISTINCT FROM OLD.reference_cursor OR NEW.state IS DISTINCT FROM OLD.state THEN
  IF NEW.version <> OLD.version + 1 THEN
   RAISE EXCEPTION USING ERRCODE = '23514', MESSAGE = 'Integration reconciliation progress requires a new version';
  END IF;
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS hs_integration_run_guard ON hs_integration_runs;
CREATE TRIGGER hs_integration_run_guard BEFORE UPDATE ON hs_integration_runs FOR EACH ROW EXECUTE FUNCTION hs_integration_run_guard();

DROP TRIGGER IF EXISTS hs_integration_consumer_versions_immutable ON hs_integration_consumer_versions;
CREATE TRIGGER hs_integration_consumer_versions_immutable BEFORE UPDATE OR DELETE ON hs_integration_consumer_versions FOR EACH ROW EXECUTE FUNCTION hs_data_history_immutable();
DROP TRIGGER IF EXISTS hs_integration_operations_immutable ON hs_integration_operations;
CREATE TRIGGER hs_integration_operations_immutable BEFORE UPDATE OR DELETE ON hs_integration_operations FOR EACH ROW EXECUTE FUNCTION hs_data_history_immutable();
DROP TRIGGER IF EXISTS hs_integration_repairs_immutable ON hs_integration_repairs;
CREATE TRIGGER hs_integration_repairs_immutable BEFORE UPDATE OR DELETE ON hs_integration_repairs FOR EACH ROW EXECUTE FUNCTION hs_data_history_immutable();
