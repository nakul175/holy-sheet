-- HOLY-75 employee onboarding and offboarding records.
-- Directory lifecycle only. A state, checklist, account link, or handover recipient
-- does not provision an account, transfer access or login credentials, run payroll,
-- or record an employment decision. Access revoked is recorded only from identity-service evidence.
ALTER TABLE hs_data_collection_grants DROP CONSTRAINT IF EXISTS hs_data_collection_grants_capabilities_check;
ALTER TABLE hs_data_collection_grants ADD CONSTRAINT hs_data_collection_grants_capabilities_check CHECK(capabilities <@ ARRAY['view','create','edit','link','import','export','bulk','archive','delete','restore','merge','schema','manage-views','history','restore-values','manage-templates','manage-permissions','manage-forms','manage-reviews','review','manage-import-profiles','manage-external-ids','manage-integration-health','manage-effective-dates','correct-effective','manage-contract-changes','manage-staff-lifecycle']::text[]);

CREATE TABLE IF NOT EXISTS hs_staff_lifecycle_policies (
 tenant_id uuid PRIMARY KEY REFERENCES hs_data_tenants(id),
 acknowledgement_required boolean NOT NULL,
 version integer NOT NULL DEFAULT 1 CHECK(version > 0),
 updated_by text NOT NULL REFERENCES hs_users(id),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS hs_staff_lifecycle_policy_versions (
 tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
 version integer NOT NULL CHECK(version > 0),
 acknowledgement_required boolean NOT NULL,
 actor_id text NOT NULL REFERENCES hs_users(id),
 operation_id uuid NOT NULL,
 source text NOT NULL DEFAULT 'holy-sheet',
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id, version)
);

CREATE TABLE IF NOT EXISTS hs_staff_lifecycle_assignments (
 tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
 user_id text NOT NULL REFERENCES hs_users(id) ON DELETE CASCADE,
 can_maintain boolean NOT NULL DEFAULT false,
 can_handover boolean NOT NULL DEFAULT false,
 can_record_evidence boolean NOT NULL DEFAULT false,
 version integer NOT NULL DEFAULT 1 CHECK(version > 0),
 updated_by text NOT NULL REFERENCES hs_users(id),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id, user_id)
);

CREATE TABLE IF NOT EXISTS hs_staff_lifecycles (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
 workspace_id text NOT NULL REFERENCES hs_workspaces(id),
 employee_record_id uuid NOT NULL,
 directory_user_id text,
 state text NOT NULL CHECK(state IN ('planned','start','active','leaving','left')),
 planned_on text CHECK(planned_on IS NULL OR planned_on ~ '^\d{4}-\d{2}-\d{2}$'),
 start_on text CHECK(start_on IS NULL OR start_on ~ '^\d{4}-\d{2}-\d{2}$'),
 leaving_on text CHECK(leaving_on IS NULL OR leaving_on ~ '^\d{4}-\d{2}-\d{2}$'),
 left_on text CHECK(left_on IS NULL OR left_on ~ '^\d{4}-\d{2}-\d{2}$'),
 checklist jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(checklist) = 'array'),
 recipient_user_id text,
 handover_state text NOT NULL DEFAULT 'open' CHECK(handover_state IN ('open','complete')),
 exceptions_acknowledged boolean NOT NULL DEFAULT false,
 exception_note text CHECK(exception_note IS NULL OR char_length(exception_note) BETWEEN 1 AND 500),
 outstanding_snapshot jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(outstanding_snapshot) = 'array'),
 version integer NOT NULL DEFAULT 1 CHECK(version > 0),
 entered_at timestamptz NOT NULL,
 entered_by text NOT NULL REFERENCES hs_users(id),
 source text NOT NULL DEFAULT 'holy-sheet',
 operation_id uuid NOT NULL,
 access_transferred boolean NOT NULL DEFAULT false CHECK(access_transferred = false),
 credentials_transferred boolean NOT NULL DEFAULT false CHECK(credentials_transferred = false),
 access_revoked boolean NOT NULL DEFAULT false,
 UNIQUE(tenant_id, employee_record_id),
 FOREIGN KEY(tenant_id, employee_record_id) REFERENCES hs_data_records(tenant_id, id)
);
CREATE INDEX IF NOT EXISTS hs_staff_lifecycle_employee ON hs_staff_lifecycles(tenant_id, employee_record_id);

CREATE TABLE IF NOT EXISTS hs_staff_lifecycle_accounts (
 tenant_id uuid NOT NULL,
 lifecycle_id uuid NOT NULL REFERENCES hs_staff_lifecycles(id),
 account_record_id uuid NOT NULL,
 PRIMARY KEY(tenant_id, lifecycle_id, account_record_id),
 FOREIGN KEY(tenant_id, account_record_id) REFERENCES hs_data_records(tenant_id, id)
);

CREATE TABLE IF NOT EXISTS hs_staff_lifecycle_events (
 tenant_id uuid NOT NULL,
 lifecycle_id uuid NOT NULL REFERENCES hs_staff_lifecycles(id),
 event_version integer NOT NULL CHECK(event_version > 0),
 kind text NOT NULL CHECK(kind IN ('create','transition','checklist','link-accounts','name-recipient','complete-handover','identity-evidence')),
 state text NOT NULL CHECK(state IN ('planned','start','active','leaving','left')),
 evidence_class text NOT NULL CHECK(evidence_class IN ('hr-record','identity-evidence')),
 access_revoked boolean NOT NULL DEFAULT false,
 evidence_reference text,
 actor_id text NOT NULL REFERENCES hs_users(id),
 operation_id uuid NOT NULL,
 source text NOT NULL,
 detail jsonb NOT NULL DEFAULT '{}' CHECK(jsonb_typeof(detail) = 'object'),
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id, lifecycle_id, event_version),
 CHECK(
  (evidence_class = 'hr-record' AND access_revoked = false AND source = 'holy-sheet' AND evidence_reference IS NULL)
  OR (evidence_class = 'identity-evidence' AND evidence_reference IS NOT NULL AND char_length(btrim(evidence_reference)) BETWEEN 1 AND 200 AND source <> 'holy-sheet')
 )
);

CREATE TABLE IF NOT EXISTS hs_staff_lifecycle_drafts (
 id uuid PRIMARY KEY,
 tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
 workspace_id text NOT NULL REFERENCES hs_workspaces(id),
 actor_id text NOT NULL REFERENCES hs_users(id),
 employee_record_id uuid NOT NULL,
 directory_user_id text,
 planned_on text,
 start_on text,
 leaving_on text,
 left_on text,
 checklist jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(checklist) = 'array'),
 account_ids jsonb NOT NULL DEFAULT '[]' CHECK(jsonb_typeof(account_ids) = 'array'),
 recipient_user_id text,
 exceptions_acknowledged boolean NOT NULL DEFAULT false,
 exception_note text,
 version integer NOT NULL DEFAULT 1 CHECK(version > 0),
 state text NOT NULL DEFAULT 'open' CHECK(state IN ('open','discarded')),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 FOREIGN KEY(tenant_id, employee_record_id) REFERENCES hs_data_records(tenant_id, id)
);

CREATE TABLE IF NOT EXISTS hs_staff_lifecycle_previews (
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

CREATE TABLE IF NOT EXISTS hs_staff_lifecycle_operations (
 tenant_id uuid NOT NULL REFERENCES hs_data_tenants(id),
 actor_id text NOT NULL REFERENCES hs_users(id),
 operation_id uuid NOT NULL,
 request_hash text NOT NULL,
 kind text NOT NULL,
 lifecycle_id uuid,
 applied_version integer NOT NULL,
 result jsonb NOT NULL,
 created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(tenant_id, actor_id, operation_id)
);

CREATE OR REPLACE FUNCTION hs_staff_lifecycle_history_immutable() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Staff lifecycle history is immutable'; END $$;
DROP TRIGGER IF EXISTS hs_staff_lifecycle_policy_version_immutable ON hs_staff_lifecycle_policy_versions;
CREATE TRIGGER hs_staff_lifecycle_policy_version_immutable BEFORE UPDATE OR DELETE ON hs_staff_lifecycle_policy_versions FOR EACH ROW EXECUTE FUNCTION hs_staff_lifecycle_history_immutable();
DROP TRIGGER IF EXISTS hs_staff_lifecycle_event_immutable ON hs_staff_lifecycle_events;
CREATE TRIGGER hs_staff_lifecycle_event_immutable BEFORE UPDATE OR DELETE ON hs_staff_lifecycle_events FOR EACH ROW EXECUTE FUNCTION hs_staff_lifecycle_history_immutable();
DROP TRIGGER IF EXISTS hs_staff_lifecycle_operation_immutable ON hs_staff_lifecycle_operations;
CREATE TRIGGER hs_staff_lifecycle_operation_immutable BEFORE UPDATE OR DELETE ON hs_staff_lifecycle_operations FOR EACH ROW EXECUTE FUNCTION hs_staff_lifecycle_history_immutable();

CREATE OR REPLACE FUNCTION hs_staff_lifecycle_account_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF NOT EXISTS(SELECT 1 FROM hs_data_records WHERE tenant_id = NEW.tenant_id AND id = NEW.account_record_id AND collection = 'accounts') THEN
  RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Account responsibility must reference an account record';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS hs_staff_lifecycle_account_guard ON hs_staff_lifecycle_accounts;
CREATE TRIGGER hs_staff_lifecycle_account_guard BEFORE INSERT ON hs_staff_lifecycle_accounts FOR EACH ROW EXECUTE FUNCTION hs_staff_lifecycle_account_guard();

CREATE OR REPLACE FUNCTION hs_staff_lifecycle_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
 IF TG_OP = 'INSERT' THEN
  IF NEW.access_revoked THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Access revoked cannot be claimed without identity-service evidence'; END IF;
  IF NEW.state <> 'planned' THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Staff lifecycle opens as planned'; END IF;
  IF NEW.handover_state <> 'open' THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='A new staff lifecycle handover stays open'; END IF;
  IF NOT EXISTS(SELECT 1 FROM hs_data_records WHERE tenant_id = NEW.tenant_id AND id = NEW.employee_record_id AND collection = 'employees') THEN
   RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Staff lifecycle belongs to an employee record';
  END IF;
  RETURN NEW;
 END IF;
 IF NEW.tenant_id <> OLD.tenant_id OR NEW.workspace_id <> OLD.workspace_id OR NEW.id <> OLD.id
    OR NEW.employee_record_id <> OLD.employee_record_id OR NEW.directory_user_id IS DISTINCT FROM OLD.directory_user_id
    OR NEW.entered_at <> OLD.entered_at OR NEW.entered_by <> OLD.entered_by OR NEW.source <> OLD.source
    OR NEW.access_transferred IS DISTINCT FROM OLD.access_transferred OR NEW.credentials_transferred IS DISTINCT FROM OLD.credentials_transferred
    OR (OLD.planned_on IS NOT NULL AND NEW.planned_on IS DISTINCT FROM OLD.planned_on)
    OR (OLD.start_on IS NOT NULL AND NEW.start_on IS DISTINCT FROM OLD.start_on)
    OR (OLD.leaving_on IS NOT NULL AND NEW.leaving_on IS DISTINCT FROM OLD.leaving_on)
    OR (OLD.left_on IS NOT NULL AND NEW.left_on IS DISTINCT FROM OLD.left_on)
 THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Staff lifecycle identity and recorded dates are immutable'; END IF;
 IF NEW.state IS DISTINCT FROM OLD.state AND NOT (
    (OLD.state = 'planned' AND NEW.state = 'start') OR
    (OLD.state = 'start' AND NEW.state = 'active') OR
    (OLD.state = 'active' AND NEW.state = 'leaving') OR
    (OLD.state = 'leaving' AND NEW.state = 'left')
 ) THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Staff lifecycle state transition is not allowed'; END IF;
 IF OLD.handover_state = 'complete' AND (
    NEW.handover_state <> 'complete' OR NEW.recipient_user_id IS DISTINCT FROM OLD.recipient_user_id
    OR NEW.exceptions_acknowledged IS DISTINCT FROM OLD.exceptions_acknowledged
    OR NEW.exception_note IS DISTINCT FROM OLD.exception_note
    OR NEW.outstanding_snapshot IS DISTINCT FROM OLD.outstanding_snapshot
 ) THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='A recorded handover is not rewritten'; END IF;
 IF NEW.access_revoked IS TRUE AND OLD.access_revoked IS NOT TRUE AND NOT EXISTS(
    SELECT 1 FROM hs_staff_lifecycle_events
    WHERE tenant_id = NEW.tenant_id AND lifecycle_id = NEW.id AND evidence_class = 'identity-evidence' AND access_revoked = true
 ) THEN RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Access revoked cannot be claimed without identity-service evidence'; END IF;
 IF NEW.access_revoked IS NOT TRUE AND OLD.access_revoked IS TRUE THEN
  RAISE EXCEPTION USING ERRCODE='23514', MESSAGE='Identity-service evidence is not silently cleared';
 END IF;
 RETURN NEW;
END $$;
DROP TRIGGER IF EXISTS hs_staff_lifecycle_guard ON hs_staff_lifecycles;
CREATE TRIGGER hs_staff_lifecycle_guard BEFORE INSERT OR UPDATE ON hs_staff_lifecycles FOR EACH ROW EXECUTE FUNCTION hs_staff_lifecycle_guard();
