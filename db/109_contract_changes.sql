-- HOLY-74 contract amendments, extensions, and renewals.
-- Internal records and versioned documents only. A date or status does not sign,
-- execute, or commit a renewal. No schedule runner is enabled.
ALTER TABLE hs_data_collection_grants DROP CONSTRAINT IF EXISTS hs_data_collection_grants_capabilities_check;
ALTER TABLE hs_data_collection_grants ADD CONSTRAINT hs_data_collection_grants_capabilities_check CHECK(capabilities <@ ARRAY['view','create','edit','link','import','export','bulk','archive','delete','restore','merge','schema','manage-views','history','restore-values','manage-templates','manage-permissions','manage-forms','manage-reviews','review','manage-import-profiles','manage-external-ids','manage-integration-health','manage-effective-dates','correct-effective','manage-contract-changes']::text[]);

CREATE TABLE IF NOT EXISTS hs_contract_change_policies (
 tenant_id uuid PRIMARY KEY REFERENCES hs_data_tenants(id),
 review_required boolean NOT NULL,
 version integer NOT NULL DEFAULT 1 CHECK(version > 0),
 updated_by text NOT NULL REFERENCES hs_users(id),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS hs_contract_change_policy_versions (
 tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
 version integer NOT NULL CHECK(version > 0),
 review_required boolean NOT NULL,
 actor_id text NOT NULL REFERENCES hs_users(id),
 operation_id uuid NOT NULL,
 source text NOT NULL DEFAULT 'holy-sheet',
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id, version)
);

CREATE TABLE IF NOT EXISTS hs_contract_change_assignments (
 tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
 user_id text NOT NULL REFERENCES hs_users(id) ON DELETE CASCADE,
 can_propose boolean NOT NULL DEFAULT false,
 can_approve boolean NOT NULL DEFAULT false,
 can_effectuate boolean NOT NULL DEFAULT false,
 can_decide boolean NOT NULL DEFAULT false,
 version integer NOT NULL DEFAULT 1 CHECK(version > 0),
 updated_by text NOT NULL REFERENCES hs_users(id),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id, user_id)
);

CREATE TABLE IF NOT EXISTS hs_contract_changes (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
 workspace_id text NOT NULL REFERENCES hs_workspaces(id),
 kind text NOT NULL CHECK(kind IN ('amendment','extension','renewal')),
 parent_record_id uuid NOT NULL,
 successor_record_id uuid NOT NULL,
 effective_start timestamptz NOT NULL,
 proposed_end text CHECK(proposed_end IS NULL OR proposed_end ~ '^\d{4}-\d{2}-\d{2}$'),
 timezone text NOT NULL CHECK(char_length(timezone) BETWEEN 1 AND 100),
 document_file_id uuid NOT NULL,
 document_version_no integer NOT NULL CHECK(document_version_no > 0),
 document_history jsonb NOT NULL,
 parent_terms jsonb NOT NULL,
 parent_version integer NOT NULL CHECK(parent_version > 0),
 successor_version integer NOT NULL CHECK(successor_version > 0),
 status text NOT NULL CHECK(status IN ('draft','proposed','approved','effective')),
 decision text NOT NULL DEFAULT 'undecided' CHECK(decision IN ('undecided','renew','do-not-renew')),
 responsible_user_id text REFERENCES hs_users(id),
 version integer NOT NULL DEFAULT 1 CHECK(version > 0),
 entered_at timestamptz NOT NULL,
 entered_by text NOT NULL REFERENCES hs_users(id),
 proposed_by text REFERENCES hs_users(id),
 proposed_at timestamptz,
 approved_by text REFERENCES hs_users(id),
 approved_at timestamptz,
 effective_at timestamptz,
 review_policy_version integer CHECK(review_policy_version IS NULL OR review_policy_version >= 0),
 source text NOT NULL DEFAULT 'holy-sheet',
 operation_id uuid NOT NULL,
 legal_commitment boolean NOT NULL DEFAULT false CHECK(legal_commitment = false),
 CHECK(parent_record_id <> successor_record_id),
 FOREIGN KEY(tenant_id, parent_record_id) REFERENCES hs_data_records(tenant_id, id),
 FOREIGN KEY(tenant_id, successor_record_id) REFERENCES hs_data_records(tenant_id, id)
);
CREATE INDEX IF NOT EXISTS hs_contract_change_parent ON hs_contract_changes(tenant_id, parent_record_id, successor_record_id);

CREATE TABLE IF NOT EXISTS hs_contract_change_events (
 tenant_id uuid NOT NULL,
 change_id uuid NOT NULL REFERENCES hs_contract_changes(id),
 event_version integer NOT NULL CHECK(event_version > 0),
 kind text NOT NULL CHECK(kind IN ('create','propose','approve','effectuate','decide')),
 status text NOT NULL CHECK(status IN ('draft','proposed','approved','effective')),
 decision text CHECK(decision IS NULL OR decision IN ('undecided','renew','do-not-renew')),
 responsible_user_id text,
 actor_id text NOT NULL REFERENCES hs_users(id),
 operation_id uuid NOT NULL,
 source text NOT NULL DEFAULT 'holy-sheet',
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id, change_id, event_version)
);

CREATE TABLE IF NOT EXISTS hs_contract_change_drafts (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
 workspace_id text NOT NULL REFERENCES hs_workspaces(id),
 actor_id text NOT NULL REFERENCES hs_users(id),
 kind text NOT NULL CHECK(kind IN ('amendment','extension','renewal')),
 parent_record_id uuid NOT NULL,
 successor_record_id uuid NOT NULL,
 effective_start text NOT NULL,
 proposed_end text,
 timezone text NOT NULL,
 document_file_id uuid NOT NULL,
 document_version_no integer NOT NULL CHECK(document_version_no > 0),
 responsible_user_id text,
 decision text NOT NULL CHECK(decision IN ('undecided','renew','do-not-renew')),
 version integer NOT NULL DEFAULT 1 CHECK(version > 0),
 state text NOT NULL DEFAULT 'open' CHECK(state IN ('open','discarded')),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(tenant_id, parent_record_id) REFERENCES hs_data_records(tenant_id, id),
 FOREIGN KEY(tenant_id, successor_record_id) REFERENCES hs_data_records(tenant_id, id)
);

CREATE TABLE IF NOT EXISTS hs_contract_change_previews (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
 workspace_id text NOT NULL REFERENCES hs_workspaces(id),
 actor_id text NOT NULL REFERENCES hs_users(id),
 action text NOT NULL,
 confirm text NOT NULL,
 payload jsonb NOT NULL,
 review_hash text NOT NULL,
 authority_revision text NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 expires_at timestamptz NOT NULL DEFAULT clock_timestamp() + interval '10 minutes'
);

CREATE TABLE IF NOT EXISTS hs_contract_change_operations (
 tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
 actor_id text NOT NULL REFERENCES hs_users(id),
 operation_id uuid NOT NULL,
 request_hash text NOT NULL,
 kind text NOT NULL,
 change_id uuid,
 applied_version integer NOT NULL,
 result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id, actor_id, operation_id)
);

CREATE OR REPLACE FUNCTION hs_contract_change_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Contract change history is immutable'; END $$;
DROP TRIGGER IF EXISTS hs_contract_change_policy_version_immutable ON hs_contract_change_policy_versions;
CREATE TRIGGER hs_contract_change_policy_version_immutable BEFORE UPDATE OR DELETE ON hs_contract_change_policy_versions FOR EACH ROW EXECUTE FUNCTION hs_contract_change_history_immutable();
DROP TRIGGER IF EXISTS hs_contract_change_event_immutable ON hs_contract_change_events;
CREATE TRIGGER hs_contract_change_event_immutable BEFORE UPDATE OR DELETE ON hs_contract_change_events FOR EACH ROW EXECUTE FUNCTION hs_contract_change_history_immutable();
DROP TRIGGER IF EXISTS hs_contract_change_operation_immutable ON hs_contract_change_operations;
CREATE TRIGGER hs_contract_change_operation_immutable BEFORE UPDATE OR DELETE ON hs_contract_change_operations FOR EACH ROW EXECUTE FUNCTION hs_contract_change_history_immutable();

CREATE OR REPLACE FUNCTION hs_contract_change_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NEW.tenant_id <> OLD.tenant_id OR NEW.workspace_id <> OLD.workspace_id OR NEW.id <> OLD.id
    OR NEW.kind <> OLD.kind OR NEW.parent_record_id <> OLD.parent_record_id OR NEW.successor_record_id <> OLD.successor_record_id
    OR NEW.effective_start <> OLD.effective_start OR NEW.proposed_end IS DISTINCT FROM OLD.proposed_end OR NEW.timezone <> OLD.timezone
    OR NEW.document_file_id <> OLD.document_file_id OR NEW.document_version_no <> OLD.document_version_no
    OR NEW.document_history <> OLD.document_history OR NEW.parent_terms <> OLD.parent_terms
    OR NEW.parent_version <> OLD.parent_version OR NEW.successor_version <> OLD.successor_version
    OR NEW.entered_at <> OLD.entered_at OR NEW.entered_by <> OLD.entered_by OR NEW.source <> OLD.source
    OR NEW.legal_commitment IS DISTINCT FROM OLD.legal_commitment
    OR (OLD.review_policy_version IS NOT NULL AND NEW.review_policy_version IS DISTINCT FROM OLD.review_policy_version)
 THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Contract change identity, original terms, and document history are immutable'; END IF;
 IF NEW.status IS DISTINCT FROM OLD.status AND NOT (
    (OLD.status = 'draft' AND NEW.status = 'proposed') OR
    (OLD.status = 'proposed' AND NEW.status = 'approved') OR
    (OLD.status = 'approved' AND NEW.status = 'effective')
 ) THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Contract change status transition is not allowed'; END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS hs_contract_change_guard ON hs_contract_changes;
CREATE TRIGGER hs_contract_change_guard BEFORE UPDATE ON hs_contract_changes FOR EACH ROW EXECUTE FUNCTION hs_contract_change_guard();
