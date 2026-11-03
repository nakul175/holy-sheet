import { randomUUID } from "node:crypto";
import type { Actor } from "./auth";
import type { Sql } from "./database";
import { DocumentError, stableStringify } from "./document";
import { formatIst } from "./ist-label";
import type { Repository } from "./repository";
import { recordHash, standardRecordFields, type RecordField } from "./shared-record-types";
import {
  applyWorkflowAction,
  assertRuntimeIdentity,
  compileWorkflowDefinition,
  definitionFields,
  evaluateWorkflowConditions,
  redactWorkflowDefinition,
  workflowAccounts,
  workflowAssignment,
  workflowBackoff,
  workflowBoundary,
  workflowDepthOutcome,
  workflowDocument,
  workflowEventKey,
  workflowLimits,
  workflowMatchesTrigger,
  workflowName,
  workflowReview,
  workflowSchedules,
  workflowSource,
  workflowStepKey,
  type WorkflowDefinition,
  type WorkflowEvent,
  type WorkflowStatus,
} from "./workflow-automation-plan";

export {
  workflowAccounts,
  workflowAssignment,
  workflowBoundary,
  workflowReview,
  workflowSchedules,
};

const unavailable = () => new DocumentError("Workflow automation is restricted or unavailable.", "not_found", 404);
const pausedError = () => new DocumentError("This workflow is draft or paused.", "workflow_paused", 409);
const previewError = () => new DocumentError("Review the impact again. The workflow changed.", "workflow_preview", 409);
const conflict = () => new DocumentError("The workflow version changed. The draft is kept.", "workflow_conflict", 409);
const invalid = () => new DocumentError("Check the workflow request.", "workflow_validation", 422);
const mismatch = () => new DocumentError("This attempt was reused with different fields.", "operation_mismatch", 409);
const readOnly = () => new DocumentError("This workflow is read only.", "read_only", 403);
const managementRequired = () => new DocumentError("Workflow configuration authority is required.", "management_required", 403);
const loopError = () => new DocumentError("This run is past the loop depth.", "workflow_loop", 409);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Scope = { workspaceId: string; tenantId: string; role: string };
type Clock = { now?: Date };
type WorkflowRow = {
  id: string; tenant_id: string; collection: string; name: string; status: WorkflowStatus;
  version: number | string; definition: unknown; created_by: string;
};
type RecordRow = {
  id: string; collection: string; name: string; version: number | string; field_values: unknown;
  state: string; parent_organisation_id: string | null;
};
type RunRow = {
  id: string; tenant_id: string; workflow_id: string; revision: number | string; record_id: string;
  event: string; event_field: string | null; event_key: string; source_key: string; depth: number | string;
  status: "running" | "retrying" | "completed" | "dead-letter"; outcome: string; attempt: number | string;
  next_attempt_at: string | Date | null; replay_of: string | null; operation_id: string;
  identity_kind: "delegated" | "service"; identity_subject: string; created_at: string | Date;
};
export type WorkflowDraftView = { baseVersion: number; definition: WorkflowDefinition };
export type PreviewView = {
  previewId: string; action: PreviewKind; review: string; version: number; status: WorkflowStatus;
  definition: WorkflowDefinition; plan: { matched: boolean; blocked: string | null; actions: { type: string; field: string; value?: unknown }[] } | null;
  schedules: string; replayed: boolean;
};
export type WorkflowView = {
  id: string; collection: string; name: string; status: WorkflowStatus; version: number;
  definition: WorkflowDefinition; identityKind: WorkflowDefinition["identity"]["kind"]; identitySubject: string;
  recoverableDraft?: WorkflowDraftView | null; createdBy?: string;
};
export type RunView = {
  id: string; workflowId: string; revision: number; status: RunRow["status"]; outcome: string;
  attempt: number; depth: number; identityKind: "delegated" | "service"; identitySubject: string;
  event: string; replayed: boolean; atIst: string; operationId: string; source: typeof workflowSource;
  recordId?: string;
};
type PreviewKind = "activate" | "pause" | "version-change" | "rollback" | "replay" | "dry-run";
type FieldRow = { field_key: string; label: string; kind: RecordField["kind"]; required: boolean | string; choices: unknown; sensitive: boolean | string; unique_value: boolean | string; deprecated: boolean | string; version: number | string };

const grant = (capability: "view" | "edit") => `(EXISTS(SELECT 1 FROM hs_data_collection_grants g WHERE g.tenant_id=r.tenant_id AND g.user_id=$3 AND g.collection=r.collection AND '${capability}'=ANY(g.capabilities)) OR EXISTS(SELECT 1 FROM hs_data_record_grants g WHERE g.tenant_id=r.tenant_id AND g.record_id=r.id AND g.user_id=$3 AND '${capability}'=ANY(g.capabilities)))`;

function on(value: unknown) { return value === true || value === "t" || value === "true" || value === 1; }
function num(value: number | string | null | undefined) { return Number(value ?? 0); }
function asJson<T>(value: unknown): T { return (typeof value === "string" ? JSON.parse(value) : value) as T; }
function textList(value: unknown) {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
}
function uniqueViolation(error: unknown) {
  const value = error as { code?: string; cause?: { code?: string } };
  return value?.code === "23505" || value?.cause?.code === "23505";
}
function instant(clock?: Clock) { return clock?.now ?? new Date(); }
function due(value: string | Date | null, now: Date) {
  if (!value) return true;
  const time = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return time <= now.getTime();
}
function nameField(): RecordField {
  return { key: "name", label: "Name", kind: "text", required: true, choices: [], sensitive: false, unique: false, deprecated: false, core: true, version: 1 };
}

async function scopeOf(tx: Sql, workspaceId: string, actor: Actor): Promise<Scope> {
  if (!workspaceId || workspaceId.length > 200) throw unavailable();
  const row = await tx.query<{ tenant_id: string | null; role: string }>(
    `SELECT b.tenant_id, m.role FROM hs_workspaces w
     JOIN hs_members m ON m.workspace_id=w.id AND m.user_id=$2 AND m.active=true
     LEFT JOIN hs_data_workspaces b ON b.workspace_id=w.id
     WHERE w.id=$1`,
    [workspaceId, actor.id],
  );
  if (!row.rows[0]?.tenant_id) throw unavailable();
  return { workspaceId, tenantId: row.rows[0].tenant_id, role: row.rows[0].role };
}

async function audit(tx: Sql, actor: Actor, action: string, operationId: string, subjectId: string, after: Record<string, unknown>) {
  await tx.query(
    "INSERT INTO hs_audit(id,actor_id,action,subject_id,after_value,correlation_id) VALUES($1,$2,$3,$4,$5,$6)",
    [randomUUID(), actor.id, action, subjectId, JSON.stringify({ source: workflowSource, operationId, atIst: formatIst(new Date()), ...after }), operationId],
  );
}

async function track(tx: Sql, tenantId: string, actor: Actor, action: string, operationId: string, workflowId: string | null, runId: string | null, detail: Record<string, unknown>) {
  await tx.query(
    "INSERT INTO hs_workflow_events(id,tenant_id,workflow_id,run_id,action,actor_id,operation_id,source,detail) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [randomUUID(), tenantId, workflowId, runId, action, actor.id, operationId, workflowSource, JSON.stringify(detail)],
  );
}

async function prior<T extends object>(tx: Sql, actorId: string, operationId: string, requestHash: string): Promise<(T & { replayed: true }) | null> {
  const row = await tx.query<{ request_hash: string; result: unknown }>("SELECT request_hash, result FROM hs_workflow_operations WHERE actor_id=$1 AND operation_id=$2", [actorId, operationId]);
  if (!row.rows[0]) return null;
  if (row.rows[0].request_hash !== requestHash) throw mismatch();
  return { ...asJson<T>(row.rows[0].result), replayed: true };
}

async function remember<T extends object>(tx: Sql, actorId: string, operationId: string, requestHash: string, result: T) {
  const replayed = "replayed" in result && (result as { replayed?: boolean }).replayed === true;
  const stored = { ...result, replayed };
  await tx.query("INSERT INTO hs_workflow_operations(actor_id,operation_id,request_hash,result) VALUES($1,$2,$3,$4)", [actorId, operationId, requestHash, JSON.stringify(stored)]);
  return stored;
}

async function hold(tx: Sql, tenantId: string) {
  await tx.query("SELECT id FROM hs_data_tenants WHERE id=$1 FOR UPDATE", [tenantId]);
}

async function isManager(tx: Sql, here: Scope, actor: Actor) {
  if (here.role === "owner" || here.role === "admin") return true;
  if (here.role === "observer") return false;
  const row = await tx.query("SELECT 1 FROM hs_workflow_managers WHERE workspace_id=$1 AND user_id=$2", [here.workspaceId, actor.id]);
  return row.rows.length > 0;
}

async function requireManager(tx: Sql, here: Scope, actor: Actor, native = false) {
  if (here.role === "observer") throw readOnly();
  if (native && here.role !== "owner" && here.role !== "admin") throw managementRequired();
  if (!await isManager(tx, here, actor)) throw managementRequired();
}

async function activeMember(tx: Sql, workspaceId: string, userId: string) {
  const row = await tx.query<{ role: string }>("SELECT role FROM hs_members WHERE workspace_id=$1 AND user_id=$2 AND active=true", [workspaceId, userId]);
  return row.rows[0] ?? null;
}

async function requireIdentity(tx: Sql, here: Scope, identity: WorkflowDefinition["identity"]) {
  const member = await activeMember(tx, here.workspaceId, identity.subjectId);
  if (!member || member.role === "observer") throw new DocumentError("Choose a delegated or service identity.", "workflow_identity", 422);
  return identity;
}

async function loadFields(tx: Sql, tenantId: string, collection: string) {
  const rows = await tx.query<FieldRow>("SELECT field_key, label, kind, required, choices, sensitive, unique_value, deprecated, version FROM hs_data_fields WHERE tenant_id=$1 AND collection=$2 ORDER BY field_key", [tenantId, collection]);
  const custom: RecordField[] = rows.rows.map(field => ({
    key: field.field_key, label: field.label, kind: field.kind, required: on(field.required), choices: textList(field.choices),
    sensitive: on(field.sensitive), unique: on(field.unique_value), deprecated: on(field.deprecated), core: false, version: num(field.version),
  }));
  return [nameField(), ...standardRecordFields(collection), ...custom].filter(field => !field.deprecated);
}

async function fieldAllowed(tx: Sql, tenantId: string, collection: string, field: RecordField, userId: string, action: "view" | "write") {
  if (!field.sensitive) return true;
  const row = await tx.query<{ can_view: boolean; can_write: boolean }>("SELECT can_view, can_write FROM hs_data_field_permissions WHERE tenant_id=$1 AND collection=$2 AND field_key=$3 AND user_id=$4", [tenantId, collection, field.key, userId]);
  const permission = row.rows[0];
  if (!permission || !on(permission.can_view)) return false;
  return action === "view" ? true : on(permission.can_write);
}

async function visibleFields(tx: Sql, tenantId: string, collection: string, userId: string) {
  const fields = await loadFields(tx, tenantId, collection);
  const visible: RecordField[] = [];
  for (const field of fields) if (await fieldAllowed(tx, tenantId, collection, field, userId, "view")) visible.push(field);
  return { fields, visible };
}

async function canViewCollection(tx: Sql, tenantId: string, collection: string, userId: string) {
  const row = await tx.query(
    `SELECT 1 FROM hs_data_collection_grants g WHERE g.tenant_id=$1 AND g.user_id=$2 AND g.collection=$3 AND 'view'=ANY(g.capabilities)
     UNION ALL
     SELECT 1 FROM hs_data_record_grants g JOIN hs_data_records r ON r.tenant_id=g.tenant_id AND r.id=g.record_id
     WHERE g.tenant_id=$1 AND g.user_id=$2 AND r.collection=$3 AND r.state='active' AND r.merged_into_id IS NULL AND 'view'=ANY(g.capabilities)
     LIMIT 1`,
    [tenantId, userId, collection],
  );
  return row.rows.length > 0;
}

async function recordFlags(tx: Sql, tenantId: string, recordId: string, userId: string) {
  const row = await tx.query<{ can_view: boolean; can_edit: boolean }>(
    `SELECT ${grant("view")} AS can_view, ${grant("edit")} AS can_edit FROM hs_data_records r WHERE r.id=$1 AND r.tenant_id=$2`,
    [recordId, tenantId, userId],
  );
  const found = row.rows[0];
  return { canView: found ? on(found.can_view) : false, canEdit: found ? on(found.can_edit) : false };
}

async function lockRecord(tx: Sql, tenantId: string, recordId: string) {
  if (!uuidPattern.test(recordId)) return null;
  const row = await tx.query<RecordRow>(
    `SELECT id, collection, name, version, field_values, state, parent_organisation_id
     FROM hs_data_records WHERE id=$1 AND tenant_id=$2 AND state='active' AND merged_into_id IS NULL FOR UPDATE`,
    [recordId, tenantId],
  );
  return row.rows[0] ?? null;
}

function valuesOf(row: { name: string; field_values: unknown }): Record<string, unknown> {
  return { name: row.name, ...asJson<Record<string, unknown>>(row.field_values) };
}

function definitionOf(value: unknown) {
  return asJson<WorkflowDefinition>(value);
}

async function loadWorkflow(tx: Sql, tenantId: string, id: string, lock = false) {
  if (!uuidPattern.test(id)) throw unavailable();
  const row = await tx.query<WorkflowRow>(`SELECT id, tenant_id, collection, name, status, version, definition, created_by FROM hs_workflows WHERE id=$1 AND tenant_id=$2${lock ? " FOR UPDATE" : ""}`, [id, tenantId]);
  if (!row.rows[0]) throw unavailable();
  return row.rows[0];
}

async function draftFor(tx: Sql, workflowId: string, actorId: string): Promise<WorkflowDraftView | null> {
  const row = await tx.query<{ base_version: number | string; definition: unknown }>("SELECT base_version, definition FROM hs_workflow_drafts WHERE workflow_id=$1 AND actor_id=$2", [workflowId, actorId]);
  if (!row.rows[0]) return null;
  return { baseVersion: num(row.rows[0].base_version), definition: definitionOf(row.rows[0].definition) };
}

async function present(tx: Sql, here: Scope, actor: Actor, row: WorkflowRow, manager: boolean): Promise<WorkflowView> {
  const { visible } = await visibleFields(tx, here.tenantId, row.collection, actor.id);
  const keys = new Set(visible.map(field => field.key));
  const definition = redactWorkflowDefinition(definitionOf(row.definition), keys);
  const draft = manager ? await draftFor(tx, row.id, actor.id) : null;
  const view: WorkflowView = {
    id: row.id, collection: row.collection, name: row.name, status: row.status, version: num(row.version),
    definition, identityKind: definition.identity.kind, identitySubject: definition.identity.subjectId,
  };
  if (manager) {
    view.createdBy = row.created_by;
    view.recoverableDraft = draft ? { baseVersion: draft.baseVersion, definition: redactWorkflowDefinition(draft.definition, keys) } : null;
  }
  return view;
}

async function visibleTo(tx: Sql, here: Scope, actor: Actor, row: WorkflowRow, manager: boolean) {
  if (manager) return true;
  return canViewCollection(tx, here.tenantId, row.collection, actor.id);
}

async function compileFor(tx: Sql, here: Scope, actor: Actor, collection: string, input: unknown) {
  const known = await tx.query<{ id: string }>("SELECT id FROM hs_data_collections WHERE tenant_id=$1 AND id=$2 AND deprecated=false", [here.tenantId, collection]);
  if (!known.rows[0]) throw unavailable();
  const { visible } = await visibleFields(tx, here.tenantId, collection, actor.id);
  let definition: WorkflowDefinition;
  try { definition = compileWorkflowDefinition(input, visible); }
  catch (error) { if (error instanceof DocumentError) throw error; throw invalid(); }
  await requireIdentity(tx, here, definition.identity);
  return definition;
}

async function writeRevision(tx: Sql, row: WorkflowRow, action: string, actor: Actor, operationId: string) {
  await tx.query(
    "INSERT INTO hs_workflow_revisions(workflow_id,version,status,definition,action,actor_id,operation_id) VALUES($1,$2,$3,$4,$5,$6,$7)",
    [row.id, num(row.version), row.status, JSON.stringify(definitionOf(row.definition)), action, actor.id, operationId],
  );
}

function presentRun(row: RunRow, replayed: boolean, recordVisible: boolean): RunView {
  const view: RunView = {
    id: row.id, workflowId: row.workflow_id, revision: num(row.revision), status: row.status, outcome: row.outcome,
    attempt: num(row.attempt), depth: num(row.depth), identityKind: row.identity_kind, identitySubject: row.identity_subject,
    event: row.event, replayed, atIst: formatIst(row.created_at), operationId: row.operation_id, source: workflowSource,
  };
  if (recordVisible) view.recordId = row.record_id;
  return view;
}

async function loadRun(tx: Sql, tenantId: string, eventKey: string) {
  const row = await tx.query<RunRow>("SELECT * FROM hs_workflow_runs WHERE tenant_id=$1 AND event_key=$2 FOR UPDATE", [tenantId, eventKey]);
  return row.rows[0] ?? null;
}

async function loadRunById(tx: Sql, tenantId: string, id: string) {
  if (!uuidPattern.test(id)) throw unavailable();
  const row = await tx.query<RunRow>("SELECT * FROM hs_workflow_runs WHERE tenant_id=$1 AND id=$2 FOR UPDATE", [tenantId, id]);
  if (!row.rows[0]) throw unavailable();
  return row.rows[0];
}

type Attempt = {
  operationId: string; record: RecordRow; event: WorkflowEvent; field?: string | null; sourceKey: string;
  depth: number; replayOf?: string | null; workflow: WorkflowRow;
};

async function settle(tx: Sql, run: RunRow, status: RunRow["status"], outcome: string, attempt: number, next: Date | null) {
  const row = await tx.query<RunRow>(
    "UPDATE hs_workflow_runs SET status=$3, outcome=$4, attempt=$5, next_attempt_at=$6, updated_at=clock_timestamp() WHERE id=$1 AND tenant_id=$2 RETURNING *",
    [run.id, run.tenant_id, status, outcome, attempt, next],
  );
  return row.rows[0];
}

async function execute(tx: Sql, here: Scope, actor: Actor, attempt: Attempt, now: Date, budget: { left: number }): Promise<RunView> {
  const eventKey = workflowEventKey({ tenantId: here.tenantId, workflowId: attempt.workflow.id, recordId: attempt.record.id, event: attempt.event, sourceKey: attempt.sourceKey });
  const existing = await loadRun(tx, here.tenantId, eventKey);
  const callerCan = (await recordFlags(tx, here.tenantId, attempt.record.id, actor.id)).canView;
  if (existing && !(existing.status === "retrying" && due(existing.next_attempt_at, now))) return presentRun(existing, true, callerCan);
  if (budget.left <= 0) throw loopError();
  budget.left -= 1;
  const depth = existing ? num(existing.depth) : attempt.depth;
  let run = existing;
  if (!run) {
    const blocked = workflowDepthOutcome(depth) === "dead-letter";
    const inserted = await tx.query<RunRow>(
      `INSERT INTO hs_workflow_runs(id,tenant_id,workflow_id,revision,record_id,event,event_field,event_key,source_key,depth,status,outcome,attempt,next_attempt_at,replay_of,operation_id,identity_kind,identity_subject)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,1,NULL,$13,$14,$15,$16) RETURNING *`,
      [randomUUID(), here.tenantId, attempt.workflow.id, num(attempt.workflow.version), attempt.record.id, attempt.event, attempt.field ?? null, eventKey, attempt.sourceKey, Math.min(depth, 11), blocked ? "dead-letter" : "running", blocked ? "loop-depth" : "running", attempt.replayOf ?? null, attempt.operationId, definitionOf(attempt.workflow.definition).identity.kind, definitionOf(attempt.workflow.definition).identity.subjectId],
    );
    run = inserted.rows[0];
    if (blocked) {
      await track(tx, here.tenantId, actor, "dead-letter", attempt.operationId, attempt.workflow.id, run.id, { outcome: "loop-depth", revision: num(run.revision), depth });
      return presentRun(run, false, callerCan);
    }
  } else {
    const started = await tx.query<RunRow>("UPDATE hs_workflow_runs SET attempt=attempt+1, status='running', outcome='running', next_attempt_at=NULL, updated_at=clock_timestamp() WHERE id=$1 RETURNING *", [run.id]);
    run = started.rows[0];
  }
  const current = await loadWorkflow(tx, here.tenantId, attempt.workflow.id, true);
  if (current.status !== "active") {
    const stopped = await settle(tx, run, "dead-letter", "paused", num(run.attempt), null);
    await track(tx, here.tenantId, actor, "dead-letter", attempt.operationId, current.id, run.id, { outcome: "paused", revision: num(run.revision) });
    return presentRun(stopped, false, callerCan);
  }
  const revision = await tx.query<{ definition: unknown }>("SELECT definition FROM hs_workflow_revisions WHERE workflow_id=$1 AND version=$2", [run.workflow_id, num(run.revision)]);
  const catalogue = await loadFields(tx, here.tenantId, attempt.record.collection);
  let definition: WorkflowDefinition;
  try { definition = compileWorkflowDefinition(definitionOf(revision.rows[0]?.definition), catalogue); }
  catch {
    const failed = await settle(tx, run, "dead-letter", "validation", num(run.attempt), null);
    return presentRun(failed, false, callerCan);
  }
  const identity = assertRuntimeIdentity(definition.identity);
  const member = await activeMember(tx, here.workspaceId, identity.subjectId);
  const fail = async (outcome: string, retryable: boolean) => {
    const wait = retryable ? workflowBackoff(num(run!.attempt)) : null;
    const status: RunRow["status"] = wait == null ? "dead-letter" : "retrying";
    const next = wait == null ? null : new Date(now.getTime() + wait);
    const saved = await settle(tx, run!, status, outcome, num(run!.attempt), next);
    await track(tx, here.tenantId, actor, status === "dead-letter" ? "dead-letter" : "retry", attempt.operationId, current.id, run!.id, { outcome, revision: num(run!.revision), attempt: num(run!.attempt) });
    return presentRun(saved, false, callerCan);
  };
  if (!member || member.role === "observer") return fail("blocked-identity", true);
  const rights = await recordFlags(tx, here.tenantId, attempt.record.id, identity.subjectId);
  if (!rights.canView) return fail("blocked-record", true);
  const withheld = new Set<string>();
  for (const fieldKey of definitionFields(definition)) {
    const field = catalogue.find(item => item.key === fieldKey);
    if (!field || !await fieldAllowed(tx, here.tenantId, attempt.record.collection, field, identity.subjectId, "view")) withheld.add(fieldKey);
  }
  const decision = evaluateWorkflowConditions(definition, valuesOf(attempt.record), withheld);
  if (decision.blocked) return fail("blocked-field", true);
  if (!decision.matched) {
    const skipped = await settle(tx, run, "completed", "skipped", num(run.attempt), null);
    await track(tx, here.tenantId, actor, "skipped", attempt.operationId, current.id, run.id, { revision: num(run.revision), outcome: "skipped" });
    return presentRun(skipped, false, callerCan);
  }
  let record = attempt.record;
  const changed: string[] = [];
  for (let index = 0; index < definition.actions.length; index += 1) {
    const action = definition.actions[index];
    const stepKey = workflowStepKey(eventKey, index);
    const step = await tx.query("SELECT 1 FROM hs_workflow_steps WHERE step_key=$1", [stepKey]);
    if (step.rows.length) continue;
    const field = catalogue.find(item => item.key === action.field);
    if (!field || !await fieldAllowed(tx, here.tenantId, record.collection, field, identity.subjectId, "write") || !rights.canEdit) return fail(field ? "blocked-action" : "validation", true);
    let next: unknown;
    try { next = applyWorkflowAction(field, valuesOf(record)[field.key], action); }
    catch { return fail("validation", true); }
    const before = { name: record.name, values: asJson<Record<string, unknown>>(record.field_values), parentOrganisationId: record.parent_organisation_id, state: record.state };
    const name = field.key === "name" ? String(next) : record.name;
    const stored = { ...asJson<Record<string, unknown>>(record.field_values) };
    if (field.key !== "name") stored[field.key] = next;
    const written = await tx.query<{ version: number | string }>(
      "UPDATE hs_data_records SET name=$3, field_values=$4, version=version+1, updated_by=$5, updated_at=clock_timestamp() WHERE id=$1 AND tenant_id=$2 AND version=$6 RETURNING version",
      [record.id, here.tenantId, name, JSON.stringify(stored), identity.subjectId, num(record.version)],
    );
    if (!written.rows[0]) return fail("conflict", true);
    const version = num(written.rows[0].version);
    record = { ...record, name, field_values: stored, version };
    const after = { name, values: stored, parentOrganisationId: record.parent_organisation_id, state: record.state };
    const eventId = randomUUID();
    const policy = Object.fromEntries(catalogue.map(item => [item.key, item.sensitive]));
    const serviceSubject = identity.kind === "service" ? identity.subjectId : null;
    await tx.query(
      "INSERT INTO hs_data_events(id,tenant_id,record_id,record_version,actor_id,source_app,operation_id,kind,before_value,after_value,field_policy,service_subject) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)",
      [eventId, here.tenantId, record.id, version, identity.subjectId, workflowSource, attempt.operationId, "workflow.action", JSON.stringify(before), JSON.stringify(after), JSON.stringify(policy), serviceSubject],
    );
    await tx.query(
      "INSERT INTO hs_data_change_events(id,tenant_id,record_id,record_version,collection,operation_id,source_app,actor_id,service_subject,kind) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
      [eventId, here.tenantId, record.id, version, record.collection, attempt.operationId, workflowSource, identity.subjectId, serviceSubject, "workflow.action"],
    );
    await tx.query("INSERT INTO hs_workflow_steps(step_key,tenant_id,run_id,action_index,outcome) VALUES($1,$2,$3,$4,'applied')", [stepKey, here.tenantId, run.id, index]);
    if (stableStringify(before) !== stableStringify(after)) changed.push(field.key);
  }
  const completed = await settle(tx, run, "completed", "completed", num(run.attempt), null);
  await track(tx, here.tenantId, actor, "completed", attempt.operationId, current.id, run.id, { revision: num(run.revision), outcome: "completed" });
  if (changed.length && depth <= workflowLimits.depth) await cascade(tx, here, actor, record, changed, completed, attempt.operationId, now, budget);
  return presentRun(completed, false, callerCan);
}

async function cascade(tx: Sql, here: Scope, actor: Actor, record: RecordRow, changed: string[], parent: RunRow, operationId: string, now: Date, budget: { left: number }) {
  const rows = await tx.query<WorkflowRow>("SELECT id, tenant_id, collection, name, status, version, definition, created_by FROM hs_workflows WHERE tenant_id=$1 AND collection=$2 AND status='active' ORDER BY id LIMIT 50 FOR UPDATE", [here.tenantId, record.collection]);
  for (const workflow of rows.rows) {
    const fresh = await lockRecord(tx, here.tenantId, record.id);
    if (!fresh) return;
    const definition = definitionOf(workflow.definition);
    if (workflowMatchesTrigger(definition, "record.updated", null)) {
      await execute(tx, here, actor, { operationId, record: fresh, event: "record.updated", sourceKey: `cascade:${parent.id}:updated`, depth: num(parent.depth) + 1, workflow }, now, budget);
    }
    for (const field of changed) {
      if (!workflowMatchesTrigger(definition, "record.field-changed", field)) continue;
      const current = await lockRecord(tx, here.tenantId, record.id);
      if (!current) return;
      await execute(tx, here, actor, { operationId, record: current, event: "record.field-changed", field, sourceKey: `cascade:${parent.id}:${field}`, depth: num(parent.depth) + 1, workflow }, now, budget);
    }
  }
}

function sourceKey(value: string) {
  const key = value.trim();
  if (!key || key.length > 200 || /[\p{Cc}]/u.test(key)) throw invalid();
  return key;
}

async function knownCollections(tx: Sql, tenantId: string) {
  const row = await tx.query<{ id: string; name: string }>("SELECT id, name FROM hs_data_collections WHERE tenant_id=$1 AND deprecated=false ORDER BY name, id", [tenantId]);
  return row.rows;
}

export async function workflowCatalogue(r: Repository, actor: Actor, workspaceId: string) {
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    const manager = await isManager(tx, here, actor);
    const rows = await tx.query<WorkflowRow>("SELECT id, tenant_id, collection, name, status, version, definition, created_by FROM hs_workflows WHERE tenant_id=$1 ORDER BY name_search, id", [here.tenantId]);
    const workflows: WorkflowView[] = [];
    for (const row of rows.rows) if (await visibleTo(tx, here, actor, row, manager)) workflows.push(await present(tx, here, actor, row, manager));
    const collections = [];
    const fields: { collection: string; key: string; label: string; kind: string; writable: boolean }[] = [];
    for (const collection of await knownCollections(tx, here.tenantId)) {
      if (!manager && !await canViewCollection(tx, here.tenantId, collection.id, actor.id)) continue;
      collections.push(collection);
      const { visible } = await visibleFields(tx, here.tenantId, collection.id, actor.id);
      for (const field of visible) {
        if (field.kind === "attachment" || field.kind === "record") continue;
        fields.push({ collection: collection.id, key: field.key, label: field.label, kind: field.kind, writable: !field.unique && !(field.required && field.key === "name") });
      }
    }
    const colleagues = manager ? (await tx.query<{ id: string; name: string }>("SELECT u.id, u.name FROM hs_members m JOIN hs_users u ON u.id=m.user_id WHERE m.workspace_id=$1 AND m.active=true AND m.role<>'observer' ORDER BY u.name, u.id", [workspaceId])).rows : [];
    return { manage: manager, boundary: workflowBoundary, assignment: workflowAssignment, review: workflowReview, schedules: workflowSchedules, accounts: workflowAccounts, workflows, collections, fields, colleagues };
  });
}

export async function readWorkflow(r: Repository, actor: Actor, workspaceId: string, workflowId: string) {
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    const manager = await isManager(tx, here, actor);
    const row = await loadWorkflow(tx, here.tenantId, workflowId);
    if (!await visibleTo(tx, here, actor, row, manager)) throw unavailable();
    return present(tx, here, actor, row, manager);
  });
}

export async function searchWorkflows(r: Repository, actor: Actor, workspaceId: string, query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle || needle.length > workflowLimits.name || /[\p{Cc}]/u.test(needle)) throw invalid();
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    const manager = await isManager(tx, here, actor);
    const rows = await tx.query<WorkflowRow>("SELECT id, tenant_id, collection, name, status, version, definition, created_by FROM hs_workflows WHERE tenant_id=$1 AND strpos(name_search, $2)>0 ORDER BY name_search, id LIMIT 200", [here.tenantId, needle]);
    const results = [];
    for (const row of rows.rows) {
      if (!await visibleTo(tx, here, actor, row, manager)) continue;
      const view = await present(tx, here, actor, row, manager);
      results.push({ id: view.id, name: view.name, collection: view.collection, status: view.status, version: view.version });
      if (results.length === 50) break;
    }
    return { results };
  });
}

export async function workflowHistory(r: Repository, actor: Actor, workspaceId: string, workflowId: string) {
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    const manager = await isManager(tx, here, actor);
    const workflow = await loadWorkflow(tx, here.tenantId, workflowId);
    if (!await visibleTo(tx, here, actor, workflow, manager)) throw unavailable();
    const events = await tx.query<{ action: string; actor_id: string; actor_name: string; operation_id: string; source: string; created_at: string | Date; detail: unknown }>(
      `SELECT e.action, e.actor_id, u.name AS actor_name, e.operation_id::text, e.source, e.created_at, e.detail
       FROM hs_workflow_events e JOIN hs_users u ON u.id=e.actor_id
       WHERE e.tenant_id=$1 AND e.workflow_id=$2 ORDER BY e.created_at DESC, e.id DESC LIMIT 50`,
      [here.tenantId, workflowId],
    );
    const runs = await tx.query<RunRow>("SELECT * FROM hs_workflow_runs WHERE tenant_id=$1 AND workflow_id=$2 ORDER BY created_at DESC, id DESC LIMIT 50", [here.tenantId, workflowId]);
    const visibleRuns: RunView[] = [];
    for (const run of runs.rows) {
      if (!(await recordFlags(tx, here.tenantId, run.record_id, actor.id)).canView) continue;
      visibleRuns.push(presentRun(run, false, true));
    }
    return {
      events: events.rows.map(event => {
        const detail = asJson<Record<string, unknown>>(event.detail);
        const revision = [detail.revision, detail.version].map(value => typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : null).find(value => value !== null) ?? null;
        return { action: event.action, actorId: event.actor_id, actorName: event.actor_name, operationId: event.operation_id, source: event.source, atIst: formatIst(event.created_at), revision, outcome: typeof detail.outcome === "string" ? detail.outcome : null };
      }),
      runs: visibleRuns,
    };
  });
}

export async function createWorkflow(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; collection: string; name: string; definition: unknown }) {
  const requestHash = recordHash({ kind: "create", workspaceId, collection: input.collection, name: input.name, definition: input.definition });
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await hold(tx, here.tenantId);
    const replay = await prior<WorkflowView>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    await requireManager(tx, here, actor);
    const count = await tx.query<{ n: number | string }>("SELECT count(*)::int AS n FROM hs_workflows WHERE tenant_id=$1", [here.tenantId]);
    if (num(count.rows[0]?.n) >= workflowLimits.workflows) throw new DocumentError("The workflow catalogue is full.", "workflow_limit", 422);
    const name = workflowName(input.name);
    const definition = await compileFor(tx, here, actor, input.collection, input.definition);
    const id = randomUUID();
    try {
      await tx.query(
        "INSERT INTO hs_workflows(id,tenant_id,collection,name,status,version,definition,created_by) VALUES($1,$2,$3,$4,'draft',1,$5,$6)",
        [id, here.tenantId, input.collection, name, JSON.stringify(definition), actor.id],
      );
    } catch (error) { if (uniqueViolation(error)) throw new DocumentError("A workflow with that name already exists.", "workflow_conflict", 409); throw error; }
    const row = await loadWorkflow(tx, here.tenantId, id);
    await writeRevision(tx, row, "create", actor, input.operationId);
    await audit(tx, actor, "workflow.create", input.operationId, id, { workspaceId, version: 1, status: "draft" });
    await track(tx, here.tenantId, actor, "create", input.operationId, id, null, { version: 1, status: "draft" });
    return remember(tx, actor.id, input.operationId, requestHash, await present(tx, here, actor, row, true));
  });
}

export async function stashWorkflow(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; workflowId: string; expectedVersion: number; definition: unknown }) {
  const requestHash = recordHash({ kind: "stash", workspaceId, workflowId: input.workflowId, expectedVersion: input.expectedVersion, definition: input.definition });
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await hold(tx, here.tenantId);
    const replay = await prior<{ id: string; version: number; conflict: boolean; recoverableDraft: WorkflowDraftView }>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    await requireManager(tx, here, actor);
    const row = await loadWorkflow(tx, here.tenantId, input.workflowId, true);
    const definition = await compileFor(tx, here, actor, row.collection, input.definition);
    const version = num(row.version);
    await tx.query(
      `INSERT INTO hs_workflow_drafts(workflow_id,actor_id,base_version,definition,operation_id)
       VALUES($1,$2,$3,$4,$5)
       ON CONFLICT (workflow_id, actor_id) DO UPDATE SET base_version=EXCLUDED.base_version, definition=EXCLUDED.definition, operation_id=EXCLUDED.operation_id, updated_at=clock_timestamp()`,
      [row.id, actor.id, input.expectedVersion > 0 ? input.expectedVersion : version, JSON.stringify(definition), input.operationId],
    );
    const draft = await draftFor(tx, row.id, actor.id);
    const result = { id: row.id, version, conflict: version !== input.expectedVersion, recoverableDraft: draft!, replayed: false as const };
    await audit(tx, actor, "workflow.stash", input.operationId, row.id, { workspaceId, version, conflict: result.conflict });
    return remember(tx, actor.id, input.operationId, requestHash, result);
  });
}

export async function discardWorkflowDraft(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; workflowId: string }) {
  const requestHash = recordHash({ kind: "discard-draft", workspaceId, workflowId: input.workflowId });
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await hold(tx, here.tenantId);
    const replay = await prior<{ id: string; discarded: true }>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    await requireManager(tx, here, actor);
    const row = await loadWorkflow(tx, here.tenantId, input.workflowId);
    await tx.query("DELETE FROM hs_workflow_drafts WHERE workflow_id=$1 AND actor_id=$2", [row.id, actor.id]);
    await audit(tx, actor, "workflow.discard-draft", input.operationId, row.id, { workspaceId });
    return remember(tx, actor.id, input.operationId, requestHash, { id: row.id, discarded: true as const });
  });
}

function assertPreviewShape(kind: PreviewKind, detail: { definition?: unknown; targetVersion?: number; runId?: string; recordId?: string; useDraft?: boolean }) {
  if (kind === "version-change" && detail.definition === undefined) throw invalid();
  if (kind === "rollback" && (!Number.isInteger(detail.targetVersion) || (detail.targetVersion ?? 0) < 1)) throw invalid();
  if (kind === "replay" && (!detail.runId || !uuidPattern.test(detail.runId))) throw invalid();
  if (kind === "dry-run" && (!detail.recordId || !uuidPattern.test(detail.recordId))) throw invalid();
}

export async function previewWorkflow(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; workflowId: string; kind: PreviewKind; expectedVersion: number; definition?: unknown; targetVersion?: number; runId?: string; recordId?: string; useDraft?: boolean }): Promise<PreviewView> {
  const requestHash = recordHash({ workspaceId, action: "preview", workflowId: input.workflowId, previewKind: input.kind, expectedVersion: input.expectedVersion, definition: input.definition ?? null, targetVersion: input.targetVersion ?? null, runId: input.runId ?? null, recordId: input.recordId ?? null, useDraft: input.useDraft === true });
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await hold(tx, here.tenantId);
    const replay = await prior<PreviewView>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    await requireManager(tx, here, actor);
    assertPreviewShape(input.kind, input);
    const row = await loadWorkflow(tx, here.tenantId, input.workflowId, true);
    if (num(row.version) !== input.expectedVersion) throw conflict();
    let detail: Record<string, unknown> = {};
    let plan: { matched: boolean; blocked: string | null; actions: { type: string; field: string; value?: unknown }[] } | null = null;
    if (input.kind === "version-change") {
      detail = { definition: await compileFor(tx, here, actor, row.collection, input.definition) };
    } else if (input.kind === "rollback") {
      const revision = await tx.query<{ definition: unknown }>("SELECT definition FROM hs_workflow_revisions WHERE workflow_id=$1 AND version=$2", [row.id, input.targetVersion]);
      if (!revision.rows[0] || input.targetVersion === num(row.version)) throw invalid();
      detail = { targetVersion: input.targetVersion, definition: await compileFor(tx, here, actor, row.collection, definitionOf(revision.rows[0].definition)) };
    } else if (input.kind === "replay") {
      const run = await loadRunById(tx, here.tenantId, input.runId!);
      if (run.workflow_id !== row.id || run.status !== "dead-letter") throw invalid();
      if (workflowDepthOutcome(num(run.depth)) === "dead-letter") throw loopError();
      if (!(await recordFlags(tx, here.tenantId, run.record_id, actor.id)).canView) throw unavailable();
      detail = { runId: run.id };
    } else if (input.kind === "dry-run") {
      const record = await lockRecord(tx, here.tenantId, input.recordId!);
      if (!record || record.collection !== row.collection || !(await recordFlags(tx, here.tenantId, record.id, actor.id)).canView) throw unavailable();
      const draft = input.useDraft ? await draftFor(tx, row.id, actor.id) : null;
      const source = draft?.definition ?? definitionOf(row.definition);
      const { fields, visible } = await visibleFields(tx, here.tenantId, row.collection, actor.id);
      const definition = compileWorkflowDefinition(source, fields);
      const identity = assertRuntimeIdentity(definition.identity);
      const withheld = new Set<string>();
      for (const fieldKey of definitionFields(definition)) {
        const field = fields.find(item => item.key === fieldKey);
        if (!field || !await fieldAllowed(tx, here.tenantId, row.collection, field, identity.subjectId, "view")) withheld.add(fieldKey);
      }
      const decision = evaluateWorkflowConditions(definition, valuesOf(record), withheld);
      const keys = new Set(visible.map(field => field.key));
      plan = {
        matched: decision.matched, blocked: decision.blocked,
        actions: definition.actions.map(action => keys.has(action.field) ? action : { type: action.type, field: "restricted" }),
      };
      detail = { recordId: record.id, useDraft: input.useDraft === true };
    } else if (input.kind === "activate" && row.status === "active") throw conflict();
    else if (input.kind === "pause" && row.status !== "active") throw conflict();
    const seal = recordHash({ version: num(row.version), status: row.status, definition: definitionOf(row.definition), action: input.kind, detail });
    const previewId = randomUUID();
    await tx.query(
      "INSERT INTO hs_workflow_previews(id,tenant_id,actor_id,workflow_id,action,workflow_version,seal,detail) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [previewId, here.tenantId, actor.id, row.id, input.kind, num(row.version), seal, JSON.stringify(detail)],
    );
    const view = await present(tx, here, actor, row, true);
    const result = { previewId, action: input.kind, review: workflowReview, version: view.version, status: view.status, definition: view.definition, plan, schedules: workflowSchedules };
    await audit(tx, actor, "workflow.preview", input.operationId, row.id, { workspaceId, action: input.kind, version: view.version });
    return remember(tx, actor.id, input.operationId, requestHash, result);
  });
}

async function publish(tx: Sql, here: Scope, actor: Actor, row: WorkflowRow, status: WorkflowStatus, definition: WorkflowDefinition, action: string, operationId: string) {
  const version = num(row.version) + 1;
  await tx.query("UPDATE hs_workflows SET status=$3, version=$4, definition=$5, updated_at=clock_timestamp() WHERE id=$1 AND tenant_id=$2", [row.id, here.tenantId, status, version, JSON.stringify(definition)]);
  if (action === "version-change" || action === "rollback") await tx.query("DELETE FROM hs_workflow_drafts WHERE workflow_id=$1 AND actor_id=$2", [row.id, actor.id]);
  const saved = await loadWorkflow(tx, here.tenantId, row.id);
  await writeRevision(tx, saved, action, actor, operationId);
  await audit(tx, actor, `workflow.${action}`, operationId, row.id, { workspaceId: here.workspaceId, version, status });
  await track(tx, here.tenantId, actor, action, operationId, row.id, null, { version, status, outcome: status });
  return present(tx, here, actor, saved, true);
}

export async function applyWorkflowPreview(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; previewId: string; expectedVersion: number }) {
  const requestHash = recordHash({ kind: "apply", workspaceId, previewId: input.previewId, expectedVersion: input.expectedVersion });
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await hold(tx, here.tenantId);
    const replay = await prior<WorkflowView | RunView>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    await requireManager(tx, here, actor);
    if (!uuidPattern.test(input.previewId)) throw unavailable();
    const preview = await tx.query<{ workflow_id: string; action: PreviewKind; workflow_version: number | string; seal: string; detail: unknown; actor_id: string }>("SELECT workflow_id, action, workflow_version, seal, detail, actor_id FROM hs_workflow_previews WHERE id=$1 AND tenant_id=$2", [input.previewId, here.tenantId]);
    const review = preview.rows[0];
    if (!review || review.actor_id !== actor.id) throw unavailable();
    const row = await loadWorkflow(tx, here.tenantId, review.workflow_id, true);
    if (num(row.version) !== input.expectedVersion) throw conflict();
    const detail = asJson<Record<string, unknown>>(review.detail);
    const seal = recordHash({ version: num(row.version), status: row.status, definition: definitionOf(row.definition), action: review.action, detail });
    if (seal !== review.seal || num(review.workflow_version) !== num(row.version)) throw previewError();
    if (review.action === "dry-run") throw previewError();
    if (review.action === "replay") {
      const run = await loadRunById(tx, here.tenantId, String(detail.runId));
      if (row.status !== "active" || run.status !== "dead-letter" || workflowDepthOutcome(num(run.depth)) === "dead-letter") throw loopError();
      const record = await lockRecord(tx, here.tenantId, run.record_id);
      if (!record || !(await recordFlags(tx, here.tenantId, record.id, actor.id)).canView) throw unavailable();
      const executed = await execute(tx, here, actor, { operationId: input.operationId, record, event: run.event as WorkflowEvent, field: run.event_field, sourceKey: `replay:${input.operationId}`, depth: num(run.depth), replayOf: run.id, workflow: row }, instant(), { left: 30 });
      return remember(tx, actor.id, input.operationId, requestHash, executed);
    }
    const current = definitionOf(row.definition);
    let status: WorkflowStatus = row.status;
    let definition = current;
    if (review.action === "activate") {
      if (row.status === "active") throw conflict();
      status = "active";
    } else if (review.action === "pause") {
      if (row.status !== "active") throw conflict();
      status = "paused";
    } else if (review.action === "version-change" || review.action === "rollback") {
      const compiled = await compileFor(tx, here, actor, row.collection, detail.definition);
      if (recordHash(compiled) !== recordHash(detail.definition)) throw previewError();
      definition = compiled;
      status = row.status === "active" || review.action === "rollback" ? "paused" : row.status;
    } else throw invalid();
    const saved = await publish(tx, here, actor, row, status, definition, review.action, input.operationId);
    return remember(tx, actor.id, input.operationId, requestHash, saved);
  });
}

export async function ingestWorkflow(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; workflowId: string; recordId: string; event: WorkflowEvent; sourceKey: string; field?: string | null }, clock?: Clock) {
  const key = sourceKey(input.sourceKey);
  const requestHash = recordHash({ kind: "ingest", workspaceId, workflowId: input.workflowId, recordId: input.recordId, event: input.event, sourceKey: key, field: input.field ?? null });
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await hold(tx, here.tenantId);
    const replay = await prior<RunView>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    await requireManager(tx, here, actor);
    const workflow = await loadWorkflow(tx, here.tenantId, input.workflowId, true);
    if (workflow.status !== "active") throw pausedError();
    const definition = definitionOf(workflow.definition);
    if (!workflowMatchesTrigger(definition, input.event, input.field ?? null)) throw invalid();
    const record = await lockRecord(tx, here.tenantId, input.recordId);
    if (!record || record.collection !== workflow.collection || !(await recordFlags(tx, here.tenantId, record.id, actor.id)).canView) throw unavailable();
    const executed = await execute(tx, here, actor, { operationId: input.operationId, record, event: input.event, field: input.field ?? null, sourceKey: key, depth: 1, workflow }, instant(clock), { left: 30 });
    return remember(tx, actor.id, input.operationId, requestHash, executed);
  });
}

export async function advanceWorkflowRun(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; runId: string }, clock?: Clock) {
  const requestHash = recordHash({ kind: "advance", workspaceId, runId: input.runId });
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await hold(tx, here.tenantId);
    const replay = await prior<RunView>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    await requireManager(tx, here, actor);
    const run = await loadRunById(tx, here.tenantId, input.runId);
    const workflow = await loadWorkflow(tx, here.tenantId, run.workflow_id, true);
    const record = await lockRecord(tx, here.tenantId, run.record_id);
    if (!record || !(await recordFlags(tx, here.tenantId, record.id, actor.id)).canView) throw unavailable();
    const now = instant(clock);
    if (run.status !== "retrying" || !due(run.next_attempt_at, now)) return remember(tx, actor.id, input.operationId, requestHash, presentRun(run, true, true));
    const executed = await execute(tx, here, actor, { operationId: input.operationId, record, event: run.event as WorkflowEvent, field: run.event_field, sourceKey: run.source_key, depth: num(run.depth), workflow }, now, { left: 30 });
    return remember(tx, actor.id, input.operationId, requestHash, executed);
  });
}

export async function downloadWorkflow(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; workflowId: string; expectedVersion: number }) {
  const requestHash = recordHash({ kind: "download", workspaceId, workflowId: input.workflowId, expectedVersion: input.expectedVersion });
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await hold(tx, here.tenantId);
    const replay = await prior<{ filename: string; contentType: string; body: string; version: number }>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    const manager = await isManager(tx, here, actor);
    const row = await loadWorkflow(tx, here.tenantId, input.workflowId);
    if (!await visibleTo(tx, here, actor, row, manager)) throw unavailable();
    if (num(row.version) !== input.expectedVersion) throw conflict();
    const view = await present(tx, here, actor, row, manager);
    const runs = await tx.query<RunRow>("SELECT * FROM hs_workflow_runs WHERE tenant_id=$1 AND workflow_id=$2 ORDER BY created_at, id LIMIT 50", [here.tenantId, row.id]);
    const visible = [];
    for (const run of runs.rows) {
      if (!(await recordFlags(tx, here.tenantId, run.record_id, actor.id)).canView) continue;
      visible.push({ revision: num(run.revision), outcome: run.outcome, status: run.status, atIst: formatIst(run.created_at) });
    }
    const body = workflowDocument({ name: view.name, status: view.status, version: view.version, collection: view.collection, definition: view.definition }, visible);
    await audit(tx, actor, "workflow.download", input.operationId, row.id, { workspaceId, version: view.version });
    return remember(tx, actor.id, input.operationId, requestHash, { filename: "workflow.md", contentType: "text/markdown; charset=utf-8", body, version: view.version });
  });
}

export async function grantWorkflowManager(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; userId: string }) {
  const requestHash = recordHash({ kind: "grant-manager", workspaceId, userId: input.userId });
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await hold(tx, here.tenantId);
    const replay = await prior<{ granted: true; userId: string }>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    await requireManager(tx, here, actor, true);
    const member = await activeMember(tx, here.workspaceId, input.userId);
    if (!member || member.role === "observer") throw unavailable();
    await tx.query(
      "INSERT INTO hs_workflow_managers(workspace_id,user_id,granted_by) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
      [here.workspaceId, input.userId, actor.id],
    );
    await audit(tx, actor, "workflow.grant-manager", input.operationId, input.userId, { workspaceId });
    return remember(tx, actor.id, input.operationId, requestHash, { granted: true as const, userId: input.userId });
  });
}

export async function revokeWorkflowManager(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; userId: string }) {
  const requestHash = recordHash({ kind: "revoke-manager", workspaceId, userId: input.userId });
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await hold(tx, here.tenantId);
    const replay = await prior<{ revoked: true; userId: string }>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    await requireManager(tx, here, actor, true);
    await tx.query("DELETE FROM hs_workflow_managers WHERE workspace_id=$1 AND user_id=$2", [here.workspaceId, input.userId]);
    await audit(tx, actor, "workflow.revoke-manager", input.operationId, input.userId, { workspaceId });
    return remember(tx, actor.id, input.operationId, requestHash, { revoked: true as const, userId: input.userId });
  });
}
