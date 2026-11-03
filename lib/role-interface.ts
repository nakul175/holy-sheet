import { randomUUID } from "node:crypto";
import { isDeprecatedAction, isDeprecatedLink, peekActionButton } from "./action-button-plan";
import type { Actor } from "./auth";
import type { Sql } from "./database";
import { DocumentError } from "./document";
import { decorateKnowledgeVerification } from "./knowledge-verification";
import { formatIst } from "./ist-label";
import type { Repository } from "./repository";
import { recordHash, recordInputValues, recordName, standardRecordFields, type RecordField } from "./shared-record-types";
import {
  assessBinding,
  compileRoleInterface,
  definitionFieldKeys,
  interfaceButtonState,
  redactRoleInterface,
  roleInterfaceAccounts,
  roleInterfaceAssignment,
  roleInterfaceAuthority,
  roleInterfaceBoundary,
  roleInterfaceDocument,
  roleInterfaceLimits,
  roleInterfaceName,
  roleInterfaceReview,
  roleInterfaceSchedules,
  roleInterfaceSharing,
  roleInterfaceSource,
  type InterfaceCompileContext,
  type InterfaceDefinition,
  type InterfaceFieldBinding,
  type InterfaceStatus,
} from "./role-interface-plan";

export {
  roleInterfaceAccounts,
  roleInterfaceAssignment,
  roleInterfaceAuthority,
  roleInterfaceBoundary,
  roleInterfaceReview,
  roleInterfaceSchedules,
  roleInterfaceSharing,
  roleInterfaceSource,
};

const unavailable = () => new DocumentError("Interfaces are restricted or unavailable.", "not_found", 404);
const pausedError = () => new DocumentError("This interface is not published.", "role_interface_paused", 409);
const previewError = () => new DocumentError("Review the impact again. The interface changed.", "role_interface_preview", 409);
const conflict = () => new DocumentError("The interface version changed. The draft is kept.", "role_interface_conflict", 409);
const staleError = () => new DocumentError("This record changed. Review the form again.", "role_interface_stale", 409);
const schemaError = () => new DocumentError("The collection schema changed. Review the form again.", "role_interface_schema", 409);
const invalid = () => new DocumentError("Check the interface request.", "role_interface_validation", 422);
const mismatch = () => new DocumentError("This attempt was reused with different fields.", "operation_mismatch", 409);
const readOnly = () => new DocumentError("This interface is read only.", "read_only", 403);
const managementRequired = () => new DocumentError("Interface configuration authority is required.", "management_required", 403);
const forbidden = () => new DocumentError("This action is not permitted.", "action_forbidden", 403);
const approvalError = () => new DocumentError("This record is waiting for approval.", "role_interface_approval", 409);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Scope = { workspaceId: string; tenantId: string; role: string };
type PreviewKind = "stage" | "publish" | "version-change" | "rollback" | "submit";
type InterfaceRow = {
  id: string; tenant_id: string; name: string; status: InterfaceStatus; sharing: string;
  version: number | string; definition: unknown; created_by: string;
};
type RecordRow = { id: string; collection: string; name: string; version: number | string; field_values: unknown; state: string; parent_organisation_id: string | null };
type FieldRow = {
  field_key: string; label: string; kind: RecordField["kind"]; required: boolean | string; choices: unknown;
  sensitive: boolean | string; unique_value: boolean | string; deprecated: boolean | string; version: number | string;
};
type ButtonRow = { id: string; collection: string; label: string; status: "draft" | "paused" | "active"; definition: unknown };
type SubmissionRow = {
  id: string; interface_id: string; component_id: string; record_id: string; record_version: number | string;
  operation_id: string; source: string; created_at: string | Date;
};
type SubmitDetail = { componentId: string; recordId: string; recordVersion: number; schemaVersion: number; values: Record<string, unknown> };
export type InterfaceDraftView = { baseVersion: number; definition: InterfaceDefinition };
export type InterfaceComponentHealth = { id: string; kind: string; status: "ready" | "broken"; reason: string | null };
export type InterfaceView = {
  id: string; name: string; status: InterfaceStatus; version: number; sharing: "private";
  definition: InterfaceDefinition; screens: { id: string; name: string; components: InterfaceComponentHealth[] }[];
  recoverableDraft?: InterfaceDraftView | null; createdBy?: string;
};
export type InterfacePreview = {
  previewId: string; action: PreviewKind; review: string; version: number; status: InterfaceStatus;
  definition: InterfaceDefinition; sharing: "private"; schedules: string;
  plan: { componentId: string; recordId: string; recordVersion: number; fields: string[]; before: Record<string, unknown>; after: Record<string, unknown>; audience: "current-user"; rights: { record: "edit"; field: "write"; action: "role-interface.submit" } } | null;
};
export type InterfaceSubmission = {
  id: string; interfaceId: string; componentId: string; recordId: string; recordVersion: number;
  source: typeof roleInterfaceSource; atIst: string; replayed: boolean; recoverable: true;
};
export type RenderedComponent = {
  id: string; kind: string; status: "ready" | "broken"; reason: string | null; browse: false;
  records?: { id: string; name: string; version: number; values: Record<string, unknown>; verification?: { status: string; label: string; owner: string; basis: string; expiresAt: string; revision: number; titleOnlyPolicy: "preserve"; statement: string } | null }[];
  record?: { id: string; name: string; version: number; values: Record<string, unknown>; approval: "pending" | null; verification?: { status: string; label: string; owner: string; basis: string; expiresAt: string; revision: number; titleOnlyPolicy: "preserve"; statement: string } | null } | null;
  fields?: { key: string; writable: boolean }[];
  groups?: { value: string; visible: number }[];
  button?: { id: string; label: string; enabled: boolean; reason: string | null };
};

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
function nameField(): RecordField {
  return { key: "name", label: "Name", kind: "text", required: true, choices: [], sensitive: false, unique: false, deprecated: false, core: true, version: 1 };
}
function definitionOf(value: unknown) { return asJson<InterfaceDefinition>(value); }
function valuesOf(row: { field_values: unknown }) { return asJson<Record<string, unknown>>(row.field_values); }

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
    [randomUUID(), actor.id, action, subjectId, JSON.stringify({ source: roleInterfaceSource, operationId, atIst: formatIst(new Date()), ...after }), operationId],
  );
}

async function track(tx: Sql, tenantId: string, actor: Actor, action: string, operationId: string, interfaceId: string | null, submissionId: string | null, detail: Record<string, unknown>) {
  await tx.query(
    "INSERT INTO hs_role_interface_events(id,tenant_id,interface_id,submission_id,action,actor_id,operation_id,source,detail) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [randomUUID(), tenantId, interfaceId, submissionId, action, actor.id, operationId, roleInterfaceSource, JSON.stringify(detail)],
  );
}

async function prior<T extends object>(tx: Sql, actorId: string, operationId: string, requestHash: string): Promise<(T & { replayed: true }) | null> {
  const row = await tx.query<{ request_hash: string; result: unknown }>("SELECT request_hash, result FROM hs_role_interface_operations WHERE actor_id=$1 AND operation_id=$2", [actorId, operationId]);
  if (!row.rows[0]) return null;
  if (row.rows[0].request_hash !== requestHash) throw mismatch();
  return { ...asJson<T>(row.rows[0].result), replayed: true };
}

async function remember<T extends object>(tx: Sql, actorId: string, operationId: string, requestHash: string, result: T) {
  const replayed = "replayed" in result && (result as { replayed?: boolean }).replayed === true;
  const stored = { ...result, replayed };
  await tx.query("INSERT INTO hs_role_interface_operations(actor_id,operation_id,request_hash,result) VALUES($1,$2,$3,$4)", [actorId, operationId, requestHash, JSON.stringify(stored)]);
  return stored;
}

async function hold(tx: Sql, tenantId: string) {
  await tx.query("SELECT id FROM hs_data_tenants WHERE id=$1 FOR UPDATE", [tenantId]);
}

async function isManager(tx: Sql, here: Scope, actor: Actor) {
  if (here.role === "owner" || here.role === "admin") return true;
  if (here.role === "observer") return false;
  const row = await tx.query("SELECT 1 FROM hs_role_interface_managers WHERE workspace_id=$1 AND user_id=$2", [here.workspaceId, actor.id]);
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

async function loadFieldRows(tx: Sql, tenantId: string, collection: string) {
  const rows = await tx.query<FieldRow>("SELECT field_key, label, kind, required, choices, sensitive, unique_value, deprecated, version FROM hs_data_fields WHERE tenant_id=$1 AND collection=$2 ORDER BY field_key", [tenantId, collection]);
  const custom: RecordField[] = rows.rows.map(field => ({
    key: field.field_key, label: field.label, kind: field.kind, required: on(field.required), choices: textList(field.choices),
    sensitive: on(field.sensitive), unique: on(field.unique_value), deprecated: on(field.deprecated), core: false, version: num(field.version),
  }));
  const byKey = new Map(custom.map(field => [field.key, field]));
  const fields = [nameField(), ...standardRecordFields(collection), ...custom.filter(field => !field.deprecated)];
  return { fields, byKey };
}

async function calculatedKeys(tx: Sql, tenantId: string, collection: string) {
  const rows = await tx.query<{ field_key: string }>("SELECT field_key::text FROM hs_data_formula_fields WHERE tenant_id=$1 AND collection=$2", [tenantId, collection]);
  return new Set(rows.rows.map(row => row.field_key));
}

async function ownedKeys(tx: Sql, tenantId: string, collection: string) {
  const rows = await tx.query<{ field_key: string }>("SELECT field_key::text FROM hs_data_rollup_fields WHERE tenant_id=$1 AND collection=$2", [tenantId, collection]);
  return new Set(rows.rows.map(row => row.field_key));
}

async function fieldAllowed(tx: Sql, tenantId: string, collection: string, field: RecordField, userId: string, action: "view" | "write") {
  if (!field.sensitive) return true;
  const row = await tx.query<{ can_view: boolean; can_write: boolean }>("SELECT can_view, can_write FROM hs_data_field_permissions WHERE tenant_id=$1 AND collection=$2 AND field_key=$3 AND user_id=$4", [tenantId, collection, field.key, userId]);
  const permission = row.rows[0];
  if (!permission || !on(permission.can_view)) return false;
  return action === "view" ? true : on(permission.can_write);
}

async function visibleFieldMap(tx: Sql, tenantId: string, collection: string, userId: string) {
  const loaded = await loadFieldRows(tx, tenantId, collection);
  const visible = new Map<string, RecordField>();
  for (const field of loaded.fields) if (await fieldAllowed(tx, tenantId, collection, field, userId, "view")) visible.set(field.key, field);
  for (const field of loaded.byKey.values()) if (!visible.has(field.key) && await fieldAllowed(tx, tenantId, collection, field, userId, "view")) visible.set(field.key, field);
  return { ...loaded, visible };
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

async function readRecord(tx: Sql, tenantId: string, recordId: string) {
  if (!uuidPattern.test(recordId)) return null;
  const row = await tx.query<RecordRow>(
    "SELECT id, collection, name, version, field_values, state, parent_organisation_id FROM hs_data_records WHERE id=$1 AND tenant_id=$2 AND state='active' AND merged_into_id IS NULL",
    [recordId, tenantId],
  );
  return row.rows[0] ?? null;
}

async function loadInterface(tx: Sql, tenantId: string, id: string, lock = false) {
  if (!uuidPattern.test(id)) throw unavailable();
  const row = await tx.query<InterfaceRow>(`SELECT id, tenant_id, name, status, sharing, version, definition, created_by FROM hs_role_interfaces WHERE id=$1 AND tenant_id=$2${lock ? " FOR UPDATE" : ""}`, [id, tenantId]);
  if (!row.rows[0] || row.rows[0].sharing !== "private") throw unavailable();
  return row.rows[0];
}

async function draftFor(tx: Sql, interfaceId: string, actorId: string): Promise<InterfaceDraftView | null> {
  const row = await tx.query<{ base_version: number | string; definition: unknown }>("SELECT base_version, definition FROM hs_role_interface_drafts WHERE interface_id=$1 AND actor_id=$2", [interfaceId, actorId]);
  if (!row.rows[0]) return null;
  return { baseVersion: num(row.rows[0].base_version), definition: definitionOf(row.rows[0].definition) };
}

async function visibleTo(tx: Sql, here: Scope, row: InterfaceRow, manager: boolean) {
  if (row.sharing !== "private") return false;
  if (manager) return true;
  if (row.status === "draft") return false;
  const assigned = await tx.query("SELECT 1 FROM hs_role_interface_roles WHERE interface_id=$1 AND role=$2", [row.id, here.role]);
  return assigned.rows.length > 0;
}

async function knownCollections(tx: Sql, tenantId: string) {
  const row = await tx.query<{ id: string; name: string; deprecated: boolean | string }>("SELECT id, name, deprecated FROM hs_data_collections WHERE tenant_id=$1 ORDER BY name, id", [tenantId]);
  return row.rows;
}

async function compileContext(tx: Sql, here: Scope, actor: Actor, visibleOnly: boolean): Promise<InterfaceCompileContext> {
  const collections = new Map<string, { fields: RecordField[]; calculated: Set<string>; owned: Set<string> }>();
  for (const collection of await knownCollections(tx, here.tenantId)) {
    if (on(collection.deprecated)) continue;
    const fields = visibleOnly
      ? [...(await visibleFieldMap(tx, here.tenantId, collection.id, actor.id)).visible.values()]
      : (await loadFieldRows(tx, here.tenantId, collection.id)).fields;
    collections.set(collection.id, { fields, calculated: await calculatedKeys(tx, here.tenantId, collection.id), owned: await ownedKeys(tx, here.tenantId, collection.id) });
  }
  const views = await tx.query<{ id: string; collection: string }>("SELECT id::text, collection FROM hs_data_views WHERE tenant_id=$1 AND workspace_id=$2 AND deleted=false", [here.tenantId, here.workspaceId]);
  const buttons = await tx.query<{ id: string }>("SELECT id::text FROM hs_action_buttons WHERE tenant_id=$1", [here.tenantId]);
  return {
    collections,
    views: new Map(views.rows.map(view => [view.id, { collection: view.collection }])),
    buttons: new Set(buttons.rows.map(button => button.id)),
  };
}

async function compileFor(tx: Sql, here: Scope, actor: Actor, input: unknown) {
  try { return compileRoleInterface(input, await compileContext(tx, here, actor, true)); }
  catch (error) { if (error instanceof DocumentError) throw error; throw invalid(); }
}

async function compileSaved(tx: Sql, here: Scope, actor: Actor, input: unknown) {
  try { return compileRoleInterface(input, await compileContext(tx, here, actor, false)); }
  catch (error) {
    if (error instanceof DocumentError && (error.code === "role_interface_calculated" || error.code === "role_interface_owned" || error.code === "role_interface_public")) throw error;
    if (error instanceof DocumentError && error.code === "role_interface_field") throw schemaError();
    if (error instanceof DocumentError) throw error;
    throw invalid();
  }
}

async function syncRoles(tx: Sql, interfaceId: string, roles: readonly string[], actorId: string) {
  await tx.query("DELETE FROM hs_role_interface_roles WHERE interface_id=$1", [interfaceId]);
  for (const role of roles) await tx.query("INSERT INTO hs_role_interface_roles(interface_id,role,assigned_by) VALUES($1,$2,$3)", [interfaceId, role, actorId]);
}

async function syncDependencies(tx: Sql, tenantId: string, interfaceId: string, definition: InterfaceDefinition) {
  await tx.query("DELETE FROM hs_data_schema_dependencies WHERE interface_id=$1", [interfaceId]);
  const seen = new Set<string>();
  for (const screen of definition.screens) {
    for (const component of screen.components) {
      if (component.kind === "button") continue;
      const pairs = component.kind === "chart" ? [{ collection: component.collection, key: component.field.key }] : component.fields.map(field => ({ collection: component.collection, key: field.key }));
      for (const pair of pairs) {
        if (!uuidPattern.test(pair.key) || seen.has(`${pair.collection}:${pair.key}`)) continue;
        const known = await tx.query("SELECT 1 FROM hs_data_fields WHERE tenant_id=$1 AND collection=$2 AND field_key=$3", [tenantId, pair.collection, pair.key]);
        if (!known.rows[0]) continue;
        seen.add(`${pair.collection}:${pair.key}`);
        await tx.query(
          "INSERT INTO hs_data_schema_dependencies(id,tenant_id,collection,field_key,kind,label,interface_id) VALUES($1,$2,$3,$4,'interface','Role interface',$5)",
          [randomUUID(), tenantId, pair.collection, pair.key, interfaceId],
        );
      }
    }
  }
}

async function writeRevision(tx: Sql, row: InterfaceRow, action: string, actor: Actor, operationId: string) {
  await tx.query(
    "INSERT INTO hs_role_interface_revisions(interface_id,version,status,name,definition,action,actor_id,operation_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
    [row.id, num(row.version), row.status, row.name, JSON.stringify(definitionOf(row.definition)), action, actor.id, operationId],
  );
}

async function viewVisibility(tx: Sql, here: Scope, actor: Actor, manager: boolean) {
  const rows = await tx.query<{ id: string; collection: string; scope: string; owner_id: string; deleted: boolean | string }>(
    "SELECT id::text, collection, scope, owner_id, deleted FROM hs_data_views WHERE tenant_id=$1 AND workspace_id=$2",
    [here.tenantId, here.workspaceId],
  );
  const visible = new Set<string>();
  const byId = new Map(rows.rows.map(view => [view.id, view]));
  for (const view of rows.rows) {
    if (on(view.deleted)) continue;
    if (view.scope === "workspace" || view.owner_id === actor.id || manager) visible.add(view.id);
  }
  return { visible, byId };
}

async function componentHealth(tx: Sql, here: Scope, actor: Actor, manager: boolean, definition: InterfaceDefinition): Promise<{ id: string; name: string; components: InterfaceComponentHealth[] }[]> {
  const collections = new Map((await knownCollections(tx, here.tenantId)).map(collection => [collection.id, collection]));
  const views = await viewVisibility(tx, here, actor, manager);
  const screens = [];
  for (const screen of definition.screens) {
    const components: InterfaceComponentHealth[] = [];
    for (const component of screen.components) {
      try {
        if (component.kind === "button") {
          const button = uuidPattern.test(component.buttonId)
            ? (await tx.query<ButtonRow>("SELECT id::text, collection, label, status, definition FROM hs_action_buttons WHERE id=$1 AND tenant_id=$2", [component.buttonId, here.tenantId])).rows[0]
            : undefined;
          const peeked = button ? peekActionButton(asJson(button.definition)) : {};
          const loaded = button ? await loadFieldRows(tx, here.tenantId, button.collection) : null;
          const target = peeked.field && loaded ? loaded.fields.find(field => field.key === peeked.field) ?? loaded.byKey.get(peeked.field) : undefined;
          const calculated = button && peeked.field ? (await calculatedKeys(tx, here.tenantId, button.collection)).has(peeked.field) : false;
          const owned = button && peeked.field ? (await ownedKeys(tx, here.tenantId, button.collection)).has(peeked.field) : false;
          const assessed = assessBinding({
            collectionPresent: true, collectionDeprecated: false, viewBound: false, viewPresent: true, viewVisible: true, fields: [],
            buttonBound: true, buttonPresent: !!button,
            buttonDeprecated: !!button && (isDeprecatedAction(peeked.actionId) || isDeprecatedLink(peeked.linkId) || !!target?.deprecated),
            buttonCalculated: calculated, buttonOwned: owned,
          });
          components.push({ id: component.id, kind: component.kind, ...assessed });
          continue;
        }
        const collection = collections.get(component.collection);
        const loaded = collection ? await loadFieldRows(tx, here.tenantId, component.collection) : null;
        const calculated = collection ? await calculatedKeys(tx, here.tenantId, component.collection) : new Set<string>();
        const owned = collection ? await ownedKeys(tx, here.tenantId, component.collection) : new Set<string>();
        const bound = component.kind === "chart" ? [component.field] : component.fields;
        const viewId = component.kind === "list" || component.kind === "chart" ? component.viewId : null;
        const view = viewId ? views.byId.get(viewId) : undefined;
        const assessed = assessBinding({
          collectionPresent: !!collection,
          collectionDeprecated: collection ? on(collection.deprecated) : false,
          viewBound: !!viewId,
          viewPresent: !!view && !on(view.deleted) && view.collection === component.collection,
          viewVisible: !!view && views.visible.has(view.id),
          fields: bound.map(item => fieldAssessment(loaded, calculated, owned, item)),
          buttonBound: false, buttonPresent: true, buttonDeprecated: false, buttonCalculated: false, buttonOwned: false,
        });
        components.push({ id: component.id, kind: component.kind, ...assessed });
      } catch {
        components.push({ id: component.id, kind: component.kind, status: "broken", reason: "unavailable" });
      }
    }
    screens.push({ id: screen.id, name: screen.name, components });
  }
  return screens;
}

function fieldAssessment(loaded: { fields: RecordField[]; byKey: Map<string, RecordField> } | null, calculated: ReadonlySet<string>, owned: ReadonlySet<string>, binding: InterfaceFieldBinding) {
  const live = loaded?.fields.find(field => field.key === binding.key) ?? loaded?.byKey.get(binding.key);
  return {
    present: !!live, deprecated: !!live?.deprecated, version: live?.version ?? 0, boundVersion: binding.version,
    calculated: calculated.has(binding.key), owned: owned.has(binding.key) || ["parent_organisation_id", "created_by", "updated_by"].includes(binding.key),
  };
}

async function present(tx: Sql, here: Scope, actor: Actor, row: InterfaceRow, manager: boolean): Promise<InterfaceView> {
  const definition = definitionOf(row.definition);
  const visible = new Set<string>();
  for (const key of definitionFieldKeys(definition)) {
    const collection = definition.screens.flatMap(screen => screen.components).find(component => component.kind !== "button" && (component.kind === "chart" ? component.field.key === key : component.fields.some(field => field.key === key)));
    if (!collection || collection.kind === "button") continue;
    const loaded = await visibleFieldMap(tx, here.tenantId, collection.collection, actor.id);
    if (loaded.visible.has(key)) visible.add(key);
  }
  const views = await viewVisibility(tx, here, actor, manager);
  const draft = manager ? await draftFor(tx, row.id, actor.id) : null;
  const view: InterfaceView = {
    id: row.id, name: row.name, status: row.status, version: num(row.version), sharing: "private",
    definition: redactRoleInterface(definition, visible, views.visible),
    screens: await componentHealth(tx, here, actor, manager, definition),
  };
  if (manager) {
    view.createdBy = row.created_by;
    view.recoverableDraft = draft ? { baseVersion: draft.baseVersion, definition: redactRoleInterface(draft.definition, visible, views.visible) } : null;
  }
  return view;
}

async function cataloguePayload(tx: Sql, here: Scope, actor: Actor, manager: boolean) {
  const rows = await tx.query<InterfaceRow>("SELECT id, tenant_id, name, status, sharing, version, definition, created_by FROM hs_role_interfaces WHERE tenant_id=$1 ORDER BY name_search, id", [here.tenantId]);
  const interfaces: InterfaceView[] = [];
  for (const row of rows.rows) if (await visibleTo(tx, here, row, manager)) interfaces.push(await present(tx, here, actor, row, manager));
  const collections = [];
  const fields: { collection: string; key: string; label: string; kind: string; writable: boolean }[] = [];
  for (const collection of await knownCollections(tx, here.tenantId)) {
    if (on(collection.deprecated)) continue;
    if (!manager && !await canViewCollection(tx, here.tenantId, collection.id, actor.id)) continue;
    collections.push({ id: collection.id, name: collection.name });
    const loaded = await visibleFieldMap(tx, here.tenantId, collection.id, actor.id);
    const calculated = await calculatedKeys(tx, here.tenantId, collection.id);
    const owned = await ownedKeys(tx, here.tenantId, collection.id);
    for (const field of loaded.visible.values()) {
      if (field.deprecated || calculated.has(field.key) || owned.has(field.key)) continue;
      fields.push({ collection: collection.id, key: field.key, label: field.label, kind: field.kind, writable: field.kind !== "attachment" && field.kind !== "record" && !["parent_organisation_id", "created_by", "updated_by"].includes(field.key) });
    }
  }
  const viewRows = manager ? await viewVisibility(tx, here, actor, true) : await viewVisibility(tx, here, actor, false);
  const viewList = [];
  for (const id of viewRows.visible) {
    const view = viewRows.byId.get(id);
    if (view) viewList.push({ id, collection: view.collection });
  }
  const buttonRows = manager ? await tx.query<{ id: string; label: string; status: string }>("SELECT id::text, label, status FROM hs_action_buttons WHERE tenant_id=$1 ORDER BY label_search, id", [here.tenantId]) : { rows: [] };
  const colleagues = manager ? (await tx.query<{ id: string; name: string }>("SELECT u.id, u.name FROM hs_members m JOIN hs_users u ON u.id=m.user_id WHERE m.workspace_id=$1 AND m.active=true AND m.role<>'observer' ORDER BY u.name, u.id", [here.workspaceId])).rows : [];
  return {
    manage: manager, boundary: roleInterfaceBoundary, assignment: roleInterfaceAssignment, authority: roleInterfaceAuthority,
    review: roleInterfaceReview, schedules: roleInterfaceSchedules, accounts: roleInterfaceAccounts, sharing: roleInterfaceSharing,
    interfaces, collections, fields, views: viewList, buttons: buttonRows.rows, colleagues,
  };
}

export async function roleInterfaceCatalogue(r: Repository, actor: Actor, workspaceId: string) {
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    return cataloguePayload(tx, here, actor, await isManager(tx, here, actor));
  });
}

export async function readRoleInterface(r: Repository, actor: Actor, workspaceId: string, interfaceId: string) {
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    const manager = await isManager(tx, here, actor);
    const row = await loadInterface(tx, here.tenantId, interfaceId);
    if (!await visibleTo(tx, here, row, manager)) throw unavailable();
    return present(tx, here, actor, row, manager);
  });
}

export async function searchRoleInterfaces(r: Repository, actor: Actor, workspaceId: string, query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle || needle.length > roleInterfaceLimits.name || /[\p{Cc}]/u.test(needle)) throw invalid();
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    const manager = await isManager(tx, here, actor);
    const rows = await tx.query<InterfaceRow>("SELECT id, tenant_id, name, status, sharing, version, definition, created_by FROM hs_role_interfaces WHERE tenant_id=$1 AND strpos(name_search, $2)>0 ORDER BY name_search, id LIMIT 200", [here.tenantId, needle]);
    const results = [];
    for (const row of rows.rows) {
      if (!await visibleTo(tx, here, row, manager)) continue;
      results.push({ id: row.id, name: row.name, status: row.status, version: num(row.version), sharing: "private" as const });
      if (results.length === 50) break;
    }
    return { results };
  });
}

async function pendingApproval(tx: Sql, tenantId: string, recordId: string) {
  const row = await tx.query("SELECT 1 FROM hs_data_reviews WHERE tenant_id=$1 AND record_id=$2 AND status='pending' LIMIT 1", [tenantId, recordId]);
  return row.rows.length > 0;
}

async function visibleRecords(tx: Sql, here: Scope, actor: Actor, collection: string, needle: string) {
  const rows = await tx.query<RecordRow>(
    `SELECT r.id::text, r.collection, r.name, r.version, r.field_values, r.state, r.parent_organisation_id
     FROM hs_data_records r
     WHERE r.tenant_id=$1 AND r.collection=$2 AND r.state='active' AND r.merged_into_id IS NULL
       AND ${grant("view")}
       AND ($4='' OR strpos(r.name_search, $4)>0)
     ORDER BY r.name_search, r.id LIMIT 50`,
    [here.tenantId, collection, actor.id, needle],
  );
  return rows.rows;
}

async function projectValues(tx: Sql, here: Scope, actor: Actor, collection: string, row: RecordRow, keys: readonly string[]) {
  const loaded = await visibleFieldMap(tx, here.tenantId, collection, actor.id);
  const raw = valuesOf(row);
  const values: Record<string, unknown> = {};
  for (const key of keys) {
    if (!loaded.visible.has(key)) continue;
    if (key === "name") values.name = row.name;
    else if (Object.prototype.hasOwnProperty.call(raw, key)) values[key] = raw[key];
  }
  return values;
}

async function renderComponent(tx: Sql, here: Scope, actor: Actor, manager: boolean, row: InterfaceRow, component: InterfaceDefinition["screens"][number]["components"][number], recordId: string | null, needle: string): Promise<RenderedComponent> {
  const definition = definitionOf(row.definition);
  const health = (await componentHealth(tx, here, actor, manager, definition)).flatMap(screen => screen.components).find(item => item.id === component.id);
  if (!health || health.status === "broken") return { id: component.id, kind: component.kind, status: "broken", reason: health?.reason ?? "unavailable", browse: false };
  if (component.kind === "button") {
    const button = (await tx.query<ButtonRow>("SELECT id::text, collection, label, status, definition FROM hs_action_buttons WHERE id=$1 AND tenant_id=$2", [component.buttonId, here.tenantId])).rows[0];
    const peeked = button ? peekActionButton(asJson(button.definition)) : {};
    let canAct = false;
    if (button && recordId && here.role !== "observer") {
      const record = await readRecord(tx, here.tenantId, recordId);
      const rights = record && record.collection === button.collection ? await recordFlags(tx, here.tenantId, record.id, actor.id) : { canView: false, canEdit: false };
      const loaded = await loadFieldRows(tx, here.tenantId, button.collection);
      const field = peeked.field ? loaded.fields.find(item => item.key === peeked.field) : undefined;
      canAct = !!rights.canView && rights.canEdit && !!field && await fieldAllowed(tx, here.tenantId, button.collection, field, actor.id, "write");
    }
    const state = interfaceButtonState({ status: button?.status ?? "draft", canAct, hasRecord: !!recordId });
    return { id: component.id, kind: "button", status: "ready", reason: null, browse: false, button: { id: button?.id ?? component.buttonId, label: button?.label ?? "", enabled: state.enabled, reason: state.reason } };
  }
  const keys = component.kind === "chart" ? [component.field.key] : component.fields.map(field => field.key);
  if (component.kind === "list" || component.kind === "chart") {
    const records = await visibleRecords(tx, here, actor, component.collection, needle);
    if (component.kind === "chart") {
      const groups = new Map<string, number>();
      for (const record of records) {
        const values = await projectValues(tx, here, actor, component.collection, record, keys);
        const value = values[component.field.key];
        if (value === undefined || value === null || value === "") continue;
        const label = typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? String(value) : "";
        if (!label) continue;
        groups.set(label, (groups.get(label) ?? 0) + 1);
      }
      return { id: component.id, kind: "chart", status: "ready", reason: null, browse: false, groups: [...groups.entries()].slice(0, 50).map(([value, visible]) => ({ value, visible })) };
    }
    const listed = [];
    for (const record of records) listed.push({ id: record.id, name: record.name, version: num(record.version), values: await projectValues(tx, here, actor, component.collection, record, keys) });
    return { id: component.id, kind: "list", status: "ready", reason: null, browse: false, records: listed };
  }
  const record = recordId ? await readRecord(tx, here.tenantId, recordId) : null;
  const rights = record && record.collection === component.collection ? await recordFlags(tx, here.tenantId, record.id, actor.id) : { canView: false, canEdit: false };
  const shown = record && rights.canView ? record : null;
  const approval = shown && await pendingApproval(tx, here.tenantId, shown.id) ? "pending" as const : null;
  const loaded = await visibleFieldMap(tx, here.tenantId, component.collection, actor.id);
  const fields = [];
  for (const key of keys) {
    const field = loaded.visible.get(key);
    if (!field) continue;
    const calculated = (await calculatedKeys(tx, here.tenantId, component.collection)).has(key);
    const owned = (await ownedKeys(tx, here.tenantId, component.collection)).has(key);
    const writable = component.kind === "form" && row.status === "published" && !!shown && rights.canEdit && !approval && !calculated && !owned && here.role !== "observer" && field.kind !== "attachment" && field.kind !== "record" && await fieldAllowed(tx, here.tenantId, component.collection, field, actor.id, "write");
    fields.push({ key, writable });
  }
  return {
    id: component.id, kind: component.kind, status: "ready", reason: null, browse: false, fields,
    record: shown ? { id: shown.id, name: shown.name, version: num(shown.version), values: await projectValues(tx, here, actor, component.collection, shown, keys), approval } : null,
  };
}

export async function renderRoleInterface(r: Repository, actor: Actor, workspaceId: string, interfaceId: string, options: { recordId?: string | null; q?: string | null; screenId?: string | null } = {}) {
  const needle = (options.q ?? "").trim().toLowerCase();
  if (needle.length > roleInterfaceLimits.name || /[\p{Cc}]/u.test(needle)) throw invalid();
  if (options.recordId && !uuidPattern.test(options.recordId)) throw unavailable();
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    const manager = await isManager(tx, here, actor);
    const row = await loadInterface(tx, here.tenantId, interfaceId);
    if (!await visibleTo(tx, here, row, manager)) throw unavailable();
    const definition = definitionOf(row.definition);
    const screens = options.screenId ? definition.screens.filter(screen => screen.id === options.screenId) : definition.screens;
    if (options.screenId && !screens.length) throw invalid();
    const rendered = [];
    for (const screen of screens) {
      const components: RenderedComponent[] = [];
      for (const component of screen.components) {
        try { components.push(await renderComponent(tx, here, actor, manager, row, component, options.recordId ?? null, needle)); }
        catch { components.push({ id: component.id, kind: component.kind, status: "broken", reason: "unavailable", browse: false }); }
      }
      rendered.push({ id: screen.id, name: screen.name, components });
    }
    await decorateKnowledgeVerification(tx, here.tenantId, here.workspaceId, actor, rendered);
    return {
      id: row.id, name: row.name, status: row.status, version: num(row.version), sharing: "private" as const, browse: false as const,
      assignment: roleInterfaceAssignment, authority: roleInterfaceAuthority, screens: rendered,
    };
  });
}

function presentSubmission(row: SubmissionRow): InterfaceSubmission {
  return {
    id: row.id, interfaceId: row.interface_id, componentId: row.component_id, recordId: row.record_id,
    recordVersion: num(row.record_version), source: roleInterfaceSource, atIst: formatIst(row.created_at), replayed: false, recoverable: true,
  };
}

export async function roleInterfaceHistory(r: Repository, actor: Actor, workspaceId: string, interfaceId: string) {
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    const manager = await isManager(tx, here, actor);
    const row = await loadInterface(tx, here.tenantId, interfaceId);
    if (!await visibleTo(tx, here, row, manager)) throw unavailable();
    const events = await tx.query<{ action: string; actor_id: string; actor_name: string; operation_id: string; source: string; created_at: string | Date; detail: unknown }>(
      `SELECT e.action, e.actor_id, u.name AS actor_name, e.operation_id::text, e.source, e.created_at, e.detail
       FROM hs_role_interface_events e JOIN hs_users u ON u.id=e.actor_id
       WHERE e.tenant_id=$1 AND e.interface_id=$2 ORDER BY e.created_at DESC, e.id DESC LIMIT 50`,
      [here.tenantId, interfaceId],
    );
    const submissions = await tx.query<SubmissionRow>("SELECT id, interface_id, component_id, record_id::text, record_version, operation_id::text, source, created_at FROM hs_role_interface_submissions WHERE tenant_id=$1 AND interface_id=$2 ORDER BY created_at DESC, id DESC LIMIT 50", [here.tenantId, interfaceId]);
    const visibleEvents = [];
    for (const event of events.rows) {
      const detail = asJson<Record<string, unknown>>(event.detail);
      if (typeof detail.recordId === "string" && !(await recordFlags(tx, here.tenantId, detail.recordId, actor.id)).canView) continue;
      const revision = typeof detail.version === "number" ? detail.version : typeof detail.revision === "number" ? detail.revision : null;
      visibleEvents.push({ action: event.action, actorId: event.actor_id, actorName: event.actor_name, operationId: event.operation_id, source: event.source, atIst: formatIst(event.created_at), revision });
    }
    const visibleSubmissions: InterfaceSubmission[] = [];
    for (const submission of submissions.rows) {
      if (!(await recordFlags(tx, here.tenantId, submission.record_id, actor.id)).canView) continue;
      visibleSubmissions.push(presentSubmission(submission));
    }
    return { events: visibleEvents, submissions: visibleSubmissions };
  });
}

export async function createRoleInterface(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; name: string; definition: unknown }) {
  const requestHash = recordHash({ kind: "create", workspaceId, name: input.name, definition: input.definition });
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await hold(tx, here.tenantId);
    const replay = await prior<InterfaceView>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    await requireManager(tx, here, actor);
    const count = await tx.query<{ n: number | string }>("SELECT count(*)::int AS n FROM hs_role_interfaces WHERE tenant_id=$1", [here.tenantId]);
    if (num(count.rows[0]?.n) >= roleInterfaceLimits.interfaces) throw new DocumentError("The interface catalogue is full.", "role_interface_limit", 422);
    const name = roleInterfaceName(input.name);
    const definition = await compileFor(tx, here, actor, input.definition);
    const id = randomUUID();
    try {
      await tx.query(
        "INSERT INTO hs_role_interfaces(id,tenant_id,name,status,sharing,version,definition,created_by) VALUES($1,$2,$3,'draft','private',1,$4,$5)",
        [id, here.tenantId, name, JSON.stringify(definition), actor.id],
      );
    } catch (error) { if (uniqueViolation(error)) throw new DocumentError("An interface with that name already exists.", "role_interface_conflict", 409); throw error; }
    const row = await loadInterface(tx, here.tenantId, id);
    await syncRoles(tx, id, definition.roles, actor.id);
    await syncDependencies(tx, here.tenantId, id, definition);
    await writeRevision(tx, row, "create", actor, input.operationId);
    await audit(tx, actor, "role-interface.create", input.operationId, id, { workspaceId, version: 1, status: "draft" });
    await track(tx, here.tenantId, actor, "create", input.operationId, id, null, { version: 1, status: "draft" });
    return remember(tx, actor.id, input.operationId, requestHash, await present(tx, here, actor, row, true));
  });
}

export async function stashRoleInterface(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; interfaceId: string; expectedVersion: number; definition: unknown }) {
  const requestHash = recordHash({ kind: "stash", workspaceId, interfaceId: input.interfaceId, expectedVersion: input.expectedVersion, definition: input.definition });
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await hold(tx, here.tenantId);
    const replay = await prior<{ id: string; version: number; conflict: boolean; recoverableDraft: InterfaceDraftView }>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    await requireManager(tx, here, actor);
    const row = await loadInterface(tx, here.tenantId, input.interfaceId, true);
    const definition = await compileFor(tx, here, actor, input.definition);
    const version = num(row.version);
    await tx.query(
      `INSERT INTO hs_role_interface_drafts(interface_id,actor_id,base_version,definition,operation_id)
       VALUES($1,$2,$3,$4,$5)
       ON CONFLICT (interface_id, actor_id) DO UPDATE SET base_version=EXCLUDED.base_version, definition=EXCLUDED.definition, operation_id=EXCLUDED.operation_id, updated_at=clock_timestamp()`,
      [row.id, actor.id, input.expectedVersion, JSON.stringify(definition), input.operationId],
    );
    const draft = await draftFor(tx, row.id, actor.id);
    const result = { id: row.id, version, conflict: version !== input.expectedVersion, recoverableDraft: draft!, replayed: false as const };
    await audit(tx, actor, "role-interface.stash", input.operationId, row.id, { workspaceId, version, conflict: result.conflict });
    return remember(tx, actor.id, input.operationId, requestHash, result);
  });
}

export async function discardRoleInterfaceDraft(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; interfaceId: string }) {
  const requestHash = recordHash({ kind: "discard-draft", workspaceId, interfaceId: input.interfaceId });
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await hold(tx, here.tenantId);
    const replay = await prior<{ id: string; discarded: true }>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    await requireManager(tx, here, actor);
    const row = await loadInterface(tx, here.tenantId, input.interfaceId);
    await tx.query("DELETE FROM hs_role_interface_drafts WHERE interface_id=$1 AND actor_id=$2", [row.id, actor.id]);
    await audit(tx, actor, "role-interface.discard-draft", input.operationId, row.id, { workspaceId });
    return remember(tx, actor.id, input.operationId, requestHash, { id: row.id, discarded: true as const });
  });
}

function assertPreviewShape(kind: PreviewKind, detail: { definition?: unknown; name?: string; targetVersion?: number; componentId?: string; recordId?: string; schemaVersion?: number; values?: unknown }) {
  const extra = (keys: string[]) => keys.some(key => detail[key as keyof typeof detail] !== undefined);
  if (kind === "version-change") {
    if (detail.definition === undefined || extra(["targetVersion", "componentId", "recordId", "schemaVersion", "values"])) throw invalid();
  } else if (kind === "rollback") {
    if (!Number.isInteger(detail.targetVersion) || (detail.targetVersion ?? 0) < 1 || extra(["definition", "name", "componentId", "recordId", "schemaVersion", "values"])) throw invalid();
  } else if (kind === "submit") {
    if (!detail.componentId || !detail.recordId || !uuidPattern.test(detail.recordId) || !Number.isInteger(detail.schemaVersion) || detail.values === undefined || extra(["definition", "name", "targetVersion"])) throw invalid();
  } else if (kind === "stage" || kind === "publish") {
    if (extra(["definition", "name", "targetVersion", "componentId", "recordId", "schemaVersion", "values"])) throw invalid();
  } else throw invalid();
}

function findComponent(definition: InterfaceDefinition, componentId: string) {
  for (const screen of definition.screens) {
    const component = screen.components.find(item => item.id === componentId);
    if (component) return component;
  }
  return null;
}

async function reviewSubmit(tx: Sql, here: Scope, actor: Actor, row: InterfaceRow, input: { componentId?: string; recordId?: string; schemaVersion?: number; values?: unknown }) {
  if (here.role === "observer") throw readOnly();
  if (row.status !== "published") throw pausedError();
  const definition = definitionOf(row.definition);
  const component = findComponent(definition, input.componentId ?? "");
  if (!component || component.kind !== "form") throw invalid();
  const schema = await tx.query<{ schema_version: number | string }>("SELECT schema_version FROM hs_data_tenants WHERE id=$1", [here.tenantId]);
  if (num(schema.rows[0]?.schema_version) !== input.schemaVersion) throw schemaError();
  const record = await lockRecord(tx, here.tenantId, input.recordId!);
  if (!record || record.collection !== component.collection) throw unavailable();
  const rights = await recordFlags(tx, here.tenantId, record.id, actor.id);
  if (!rights.canView) throw unavailable();
  if (!rights.canEdit) throw forbidden();
  if (await pendingApproval(tx, here.tenantId, record.id)) throw approvalError();
  const loaded = await loadFieldRows(tx, here.tenantId, component.collection);
  const calculated = await calculatedKeys(tx, here.tenantId, component.collection);
  const owned = await ownedKeys(tx, here.tenantId, component.collection);
  if (!input.values || typeof input.values !== "object" || Array.isArray(input.values)) throw invalid();
  const patch = input.values as Record<string, unknown>;
  const keys = Object.keys(patch);
  if (!keys.length || keys.length > roleInterfaceLimits.fields) throw invalid();
  for (const key of keys) {
    if (calculated.has(key)) throw new DocumentError("Calculated fields are read-only.", "role_interface_calculated", 422);
    if (owned.has(key) || ["parent_organisation_id", "created_by", "updated_by"].includes(key)) throw new DocumentError("Owned fields are read-only.", "role_interface_owned", 422);
    const binding = component.fields.find(field => field.key === key);
    const live = loaded.fields.find(field => field.key === key);
    if (!binding || !live || live.deprecated || live.version !== binding.version) throw schemaError();
    if (!await fieldAllowed(tx, here.tenantId, component.collection, live, actor.id, "write")) throw forbidden();
  }
  let validated: { data: Record<string, unknown>; changed: string[] };
  try { validated = recordInputValues(loaded.fields, patch, { name: record.name, ...valuesOf(record) }, false); }
  catch (error) { if (error instanceof DocumentError) throw error; throw invalid(); }
  const values: Record<string, unknown> = {};
  for (const key of validated.changed) values[key] = key === "name" ? recordName(validated.data.name) : validated.data[key];
  if (recordHash(values) !== recordHash(Object.fromEntries(keys.map(key => [key, values[key]])))) throw invalid();
  const before = Object.fromEntries(Object.keys(values).map(key => [key, key === "name" ? record.name : valuesOf(record)[key] ?? null]));
  const detail: SubmitDetail = { componentId: component.id, recordId: record.id, recordVersion: num(record.version), schemaVersion: input.schemaVersion!, values };
  return {
    detail,
    plan: {
      componentId: component.id, recordId: record.id, recordVersion: num(record.version), fields: Object.keys(values), before, after: values,
      audience: "current-user" as const, rights: { record: "edit" as const, field: "write" as const, action: "role-interface.submit" as const },
    },
  };
}

export async function previewRoleInterface(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; interfaceId: string; kind: PreviewKind; expectedVersion: number; definition?: unknown; name?: string; targetVersion?: number; componentId?: string; recordId?: string; schemaVersion?: number; values?: unknown }): Promise<InterfacePreview> {
  const requestHash = recordHash({ workspaceId, action: "preview", interfaceId: input.interfaceId, previewKind: input.kind, expectedVersion: input.expectedVersion, definition: input.definition ?? null, name: input.name ?? null, targetVersion: input.targetVersion ?? null, componentId: input.componentId ?? null, recordId: input.recordId ?? null, schemaVersion: input.schemaVersion ?? null, values: input.values ?? null });
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await hold(tx, here.tenantId);
    const replay = await prior<InterfacePreview>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    assertPreviewShape(input.kind, input);
    if (input.kind !== "submit") await requireManager(tx, here, actor);
    const row = await loadInterface(tx, here.tenantId, input.interfaceId, true);
    if (num(row.version) !== input.expectedVersion) throw conflict();
    let detail: Record<string, unknown> = {};
    let plan: InterfacePreview["plan"] = null;
    if (input.kind === "version-change") {
      const definition = await compileFor(tx, here, actor, input.definition);
      detail = { definition, name: input.name ? roleInterfaceName(input.name) : row.name };
    } else if (input.kind === "rollback") {
      const revision = await tx.query<{ definition: unknown; name: string }>("SELECT definition, name FROM hs_role_interface_revisions WHERE interface_id=$1 AND version=$2", [row.id, input.targetVersion]);
      if (!revision.rows[0] || input.targetVersion === num(row.version)) throw invalid();
      detail = { targetVersion: input.targetVersion, name: revision.rows[0].name, definition: await compileSaved(tx, here, actor, definitionOf(revision.rows[0].definition)) };
    } else if (input.kind === "submit") {
      const reviewed = await reviewSubmit(tx, here, actor, row, input);
      detail = reviewed.detail;
      plan = reviewed.plan;
    } else if (input.kind === "stage" && row.status !== "draft") throw conflict();
    else if (input.kind === "publish" && row.status !== "preview") throw conflict();
    const seal = recordHash({ version: num(row.version), status: row.status, name: row.name, definition: definitionOf(row.definition), action: input.kind, detail });
    const previewId = randomUUID();
    await tx.query(
      "INSERT INTO hs_role_interface_previews(id,tenant_id,actor_id,interface_id,action,interface_version,seal,detail) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [previewId, here.tenantId, actor.id, row.id, input.kind, num(row.version), seal, JSON.stringify(detail)],
    );
    const view = await present(tx, here, actor, row, input.kind !== "submit" || await isManager(tx, here, actor));
    const result = { previewId, action: input.kind, review: roleInterfaceReview, version: view.version, status: view.status, definition: view.definition, sharing: "private" as const, schedules: roleInterfaceSchedules, plan };
    await audit(tx, actor, "role-interface.preview", input.operationId, row.id, { workspaceId, action: input.kind, version: view.version });
    return remember(tx, actor.id, input.operationId, requestHash, result);
  });
}

async function saveInterface(tx: Sql, here: Scope, actor: Actor, row: InterfaceRow, status: InterfaceStatus, definition: InterfaceDefinition, name: string, action: string, operationId: string) {
  const version = num(row.version) + 1;
  try {
    await tx.query("UPDATE hs_role_interfaces SET status=$3, version=$4, definition=$5, name=$6, updated_at=clock_timestamp() WHERE id=$1 AND tenant_id=$2", [row.id, here.tenantId, status, version, JSON.stringify(definition), name]);
  } catch (error) { if (uniqueViolation(error)) throw new DocumentError("An interface with that name already exists.", "role_interface_conflict", 409); throw error; }
  if (action === "version-change" || action === "rollback") await tx.query("DELETE FROM hs_role_interface_drafts WHERE interface_id=$1 AND actor_id=$2", [row.id, actor.id]);
  const saved = await loadInterface(tx, here.tenantId, row.id);
  await syncRoles(tx, saved.id, definition.roles, actor.id);
  await syncDependencies(tx, here.tenantId, saved.id, definition);
  await writeRevision(tx, saved, action, actor, operationId);
  await audit(tx, actor, `role-interface.${action}`, operationId, row.id, { workspaceId: here.workspaceId, version, status });
  await track(tx, here.tenantId, actor, action, operationId, row.id, null, { version, status });
  return present(tx, here, actor, saved, true);
}

async function applySubmit(tx: Sql, here: Scope, actor: Actor, row: InterfaceRow, detail: SubmitDetail, operationId: string) {
  const reviewed = await reviewSubmit(tx, here, actor, row, detail);
  if (reviewed.detail.recordVersion !== detail.recordVersion) throw staleError();
  if (recordHash(reviewed.detail.values) !== recordHash(detail.values) || reviewed.detail.componentId !== detail.componentId) throw previewError();
  const record = await lockRecord(tx, here.tenantId, detail.recordId);
  if (!record || num(record.version) !== detail.recordVersion) throw staleError();
  const before = { name: record.name, values: valuesOf(record), parentOrganisationId: record.parent_organisation_id, state: record.state };
  const stored = { ...valuesOf(record) };
  let name = record.name;
  for (const [key, value] of Object.entries(detail.values)) {
    if (key === "name") name = recordName(value);
    else stored[key] = value;
  }
  const written = await tx.query<{ version: number | string }>(
    "UPDATE hs_data_records SET name=$3, field_values=$4, version=version+1, updated_by=$5, updated_at=clock_timestamp() WHERE id=$1 AND tenant_id=$2 AND version=$6 RETURNING version",
    [record.id, here.tenantId, name, JSON.stringify(stored), actor.id, num(record.version)],
  );
  if (!written.rows[0]) throw staleError();
  const version = num(written.rows[0].version);
  const after = { name, values: stored, parentOrganisationId: record.parent_organisation_id, state: record.state };
  const eventId = randomUUID();
  const loaded = await loadFieldRows(tx, here.tenantId, record.collection);
  const policy = Object.fromEntries(loaded.fields.map(item => [item.key, item.sensitive]));
  await tx.query(
    "INSERT INTO hs_data_events(id,tenant_id,record_id,record_version,actor_id,source_app,operation_id,kind,before_value,after_value,field_policy,service_subject) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NULL)",
    [eventId, here.tenantId, record.id, version, actor.id, roleInterfaceSource, operationId, "role-interface.submit", JSON.stringify(before), JSON.stringify(after), JSON.stringify(policy)],
  );
  await tx.query(
    "INSERT INTO hs_data_change_events(id,tenant_id,record_id,record_version,collection,operation_id,source_app,actor_id,service_subject,kind) VALUES($1,$2,$3,$4,$5,$6,$7,$8,NULL,$9)",
    [eventId, here.tenantId, record.id, version, record.collection, operationId, roleInterfaceSource, actor.id, "role-interface.submit"],
  );
  const inserted = await tx.query<SubmissionRow>(
    `INSERT INTO hs_role_interface_submissions(id,tenant_id,interface_id,component_id,record_id,record_version,operation_id,actor_id,source,detail)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, interface_id, component_id, record_id::text, record_version, operation_id::text, source, created_at`,
    [randomUUID(), here.tenantId, row.id, detail.componentId, record.id, version, operationId, actor.id, roleInterfaceSource, JSON.stringify({ fieldKeys: Object.keys(detail.values) })],
  );
  await audit(tx, actor, "role-interface.submit", operationId, row.id, { workspaceId: here.workspaceId, version: num(row.version), componentId: detail.componentId, fieldKeys: Object.keys(detail.values) });
  await track(tx, here.tenantId, actor, "submit", operationId, row.id, inserted.rows[0].id, { version: num(row.version), recordId: record.id });
  return presentSubmission(inserted.rows[0]);
}

export async function applyRoleInterfacePreview(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; previewId: string; expectedVersion: number }) {
  const requestHash = recordHash({ kind: "apply", workspaceId, previewId: input.previewId, expectedVersion: input.expectedVersion });
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await hold(tx, here.tenantId);
    const replay = await prior<InterfaceView | InterfaceSubmission>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    if (!uuidPattern.test(input.previewId)) throw unavailable();
    const preview = await tx.query<{ interface_id: string; action: PreviewKind; interface_version: number | string; seal: string; detail: unknown; actor_id: string }>("SELECT interface_id, action, interface_version, seal, detail, actor_id FROM hs_role_interface_previews WHERE id=$1 AND tenant_id=$2", [input.previewId, here.tenantId]);
    const review = preview.rows[0];
    if (!review || review.actor_id !== actor.id) throw unavailable();
    if (review.action !== "submit") await requireManager(tx, here, actor);
    const row = await loadInterface(tx, here.tenantId, review.interface_id, true);
    if (num(row.version) !== input.expectedVersion) throw conflict();
    const detail = asJson<Record<string, unknown>>(review.detail);
    const seal = recordHash({ version: num(row.version), status: row.status, name: row.name, definition: definitionOf(row.definition), action: review.action, detail });
    if (seal !== review.seal || num(review.interface_version) !== num(row.version)) throw previewError();
    if (review.action === "submit") return remember(tx, actor.id, input.operationId, requestHash, await applySubmit(tx, here, actor, row, detail as SubmitDetail, input.operationId));
    const current = definitionOf(row.definition);
    let status: InterfaceStatus = row.status;
    let definition = current;
    let name = row.name;
    if (review.action === "stage") {
      if (row.status !== "draft") throw conflict();
      status = "preview";
      definition = await compileSaved(tx, here, actor, current);
    } else if (review.action === "publish") {
      if (row.status !== "preview") throw conflict();
      status = "published";
      definition = await compileSaved(tx, here, actor, current);
    } else if (review.action === "version-change" || review.action === "rollback") {
      const compiled = await compileFor(tx, here, actor, detail.definition);
      if (recordHash(compiled) !== recordHash(detail.definition)) throw previewError();
      definition = compiled;
      name = typeof detail.name === "string" ? roleInterfaceName(detail.name) : row.name;
      status = "draft";
    } else throw invalid();
    return remember(tx, actor.id, input.operationId, requestHash, await saveInterface(tx, here, actor, row, status, definition, name, review.action, input.operationId));
  });
}

async function visibleSubmissionLines(tx: Sql, here: Scope, actor: Actor, interfaceId: string) {
  const rows = await tx.query<SubmissionRow>("SELECT id, interface_id, component_id, record_id::text, record_version, operation_id::text, source, created_at FROM hs_role_interface_submissions WHERE tenant_id=$1 AND interface_id=$2 ORDER BY created_at, id LIMIT 50", [here.tenantId, interfaceId]);
  const lines = [];
  for (const submission of rows.rows) {
    if (!(await recordFlags(tx, here.tenantId, submission.record_id, actor.id)).canView) continue;
    lines.push({ recordVersion: num(submission.record_version), atIst: formatIst(submission.created_at) });
  }
  return lines;
}

export async function downloadRoleInterface(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; interfaceId: string; expectedVersion: number }) {
  const requestHash = recordHash({ kind: "download", workspaceId, interfaceId: input.interfaceId, expectedVersion: input.expectedVersion });
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await hold(tx, here.tenantId);
    const replay = await prior<{ filename: string; contentType: string; body: string; version: number }>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    const manager = await isManager(tx, here, actor);
    const row = await loadInterface(tx, here.tenantId, input.interfaceId);
    if (!await visibleTo(tx, here, row, manager)) throw unavailable();
    if (num(row.version) !== input.expectedVersion) throw conflict();
    const view = await present(tx, here, actor, row, manager);
    const body = roleInterfaceDocument({ name: view.name, status: view.status, version: view.version, sharing: view.sharing, definition: view.definition }, await visibleSubmissionLines(tx, here, actor, row.id));
    await audit(tx, actor, "role-interface.download", input.operationId, row.id, { workspaceId, version: view.version });
    return remember(tx, actor.id, input.operationId, requestHash, { filename: "role-interface.md", contentType: "text/markdown; charset=utf-8", body, version: view.version });
  });
}

export async function grantRoleInterfaceManager(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; userId: string }) {
  const requestHash = recordHash({ kind: "grant-manager", workspaceId, userId: input.userId });
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await hold(tx, here.tenantId);
    const replay = await prior<{ granted: true; userId: string }>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    await requireManager(tx, here, actor, true);
    const member = await activeMember(tx, here.workspaceId, input.userId);
    if (!member || member.role === "observer") throw unavailable();
    await tx.query("INSERT INTO hs_role_interface_managers(workspace_id,user_id,granted_by) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [here.workspaceId, input.userId, actor.id]);
    await audit(tx, actor, "role-interface.grant-manager", input.operationId, input.userId, { workspaceId });
    return remember(tx, actor.id, input.operationId, requestHash, { granted: true as const, userId: input.userId });
  });
}

export async function revokeRoleInterfaceManager(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; userId: string }) {
  const requestHash = recordHash({ kind: "revoke-manager", workspaceId, userId: input.userId });
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await hold(tx, here.tenantId);
    const replay = await prior<{ revoked: true; userId: string }>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    await requireManager(tx, here, actor, true);
    await tx.query("DELETE FROM hs_role_interface_managers WHERE workspace_id=$1 AND user_id=$2", [here.workspaceId, input.userId]);
    await audit(tx, actor, "role-interface.revoke-manager", input.operationId, input.userId, { workspaceId });
    return remember(tx, actor.id, input.operationId, requestHash, { revoked: true as const, userId: input.userId });
  });
}
