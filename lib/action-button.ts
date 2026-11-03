import { randomUUID } from "node:crypto";
import type { Actor } from "./auth";
import type { Sql } from "./database";
import { DocumentError } from "./document";
import { formatIst } from "./ist-label";
import type { Repository } from "./repository";
import { recordHash, standardRecordFields, type RecordField } from "./shared-record-types";
import {
  actionButtonAccounts,
  actionButtonAssignment,
  actionButtonAuthority,
  actionButtonBoundary,
  actionButtonDocument,
  actionButtonLabel,
  actionButtonLimits,
  actionButtonReview,
  actionButtonSchedules,
  actionButtonSource,
  actionImpact,
  buttonAvailability,
  compileActionButton,
  definitionFields,
  isDeprecatedAction,
  isDeprecatedLink,
  peekActionButton,
  redactActionButton,
  resolveActionInputs,
  type ActionButtonDefinition,
  type ActionButtonLink,
  type ActionButtonStatus,
  type ActionButtonTarget,
} from "./action-button-plan";

export {
  actionButtonAccounts,
  actionButtonAssignment,
  actionButtonAuthority,
  actionButtonBoundary,
  actionButtonReview,
  actionButtonSchedules,
  actionButtonSource,
};

const unavailable = () => new DocumentError("Action buttons are restricted or unavailable.", "not_found", 404);
const pausedError = () => new DocumentError("This action button is draft or paused.", "action_button_paused", 409);
const disabledError = () => new DocumentError("This action target is disabled.", "action_button_disabled", 409);
const previewError = () => new DocumentError("Review the impact again. The action button changed.", "action_button_preview", 409);
const conflict = () => new DocumentError("The action button version changed. The draft is kept.", "action_button_conflict", 409);
const staleError = () => new DocumentError("This record changed. Review the action again.", "action_button_stale", 409);
const invalid = () => new DocumentError("Check the action button request.", "action_button_validation", 422);
const mismatch = () => new DocumentError("This attempt was reused with different fields.", "operation_mismatch", 409);
const readOnly = () => new DocumentError("This action button is read only.", "read_only", 403);
const managementRequired = () => new DocumentError("Action button configuration authority is required.", "management_required", 403);
const forbidden = () => new DocumentError("This action is not permitted.", "action_forbidden", 403);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const pageIdPattern = /^[A-Za-z0-9_-]{1,80}$/;

type Scope = { workspaceId: string; tenantId: string; role: string };
type PreviewKind = "activate" | "pause" | "version-change" | "rollback" | "invoke";
type ButtonRow = {
  id: string; tenant_id: string; collection: string; label: string; status: ActionButtonStatus;
  version: number | string; definition: unknown; created_by: string;
};
type RecordRow = {
  id: string; collection: string; name: string; version: number | string; field_values: unknown;
  state: string; parent_organisation_id: string | null;
};
type ReceiptRow = {
  id: string; tenant_id: string; button_id: string; revision: number | string; record_id: string;
  operation_id: string; actor_id: string; action_id: string; action_status: "succeeded" | "failed";
  link_status: "none" | "succeeded" | "failed"; link_error: string | null; follows: string | null;
  source: string; detail: unknown; created_at: string | Date;
};
type FieldRow = {
  field_key: string; label: string; kind: RecordField["kind"]; required: boolean | string; choices: unknown;
  sensitive: boolean | string; unique_value: boolean | string; deprecated: boolean | string; version: number | string;
};
type InvokeDetail = {
  recordId: string; recordVersion: number; inputs: Record<string, unknown>; pageId: string | null;
  actionId: string; field: string; linkId: string | null; linkKind: "record" | "page" | null; linkTarget: string | null;
};
export type ActionDraftView = { baseVersion: number; definition: ActionButtonDefinition };
export type ActionButtonView = {
  id: string; collection: string; label: string; status: ActionButtonStatus; version: number;
  definition: ActionButtonDefinition; availability: { enabled: boolean; reason: string | null };
  recoverableDraft?: ActionDraftView | null; createdBy?: string;
};
export type ActionPreviewView = {
  previewId: string; action: PreviewKind; review: string; version: number; status: ActionButtonStatus;
  definition: ActionButtonDefinition;
  plan: { actionId: string; field: string; before?: unknown; after?: unknown; linkId: string | null; audience: "current-user"; rights: { record: "edit"; field: "write"; action: string } } | null;
  schedules: string;
};
export type ActionReceipt = {
  id: string; buttonId: string; revision: number; operationId: string; actionId: string;
  actionStatus: "succeeded" | "failed"; linkStatus: "none" | "succeeded" | "failed"; linkError: string | null;
  recoverable: true; source: typeof actionButtonSource; atIst: string; replayed: boolean; follows: string | null;
  recordId?: string; pageId?: string; openedRecordId?: string;
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
function definitionOf(value: unknown) { return asJson<ActionButtonDefinition>(value); }

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
    [randomUUID(), actor.id, action, subjectId, JSON.stringify({ source: actionButtonSource, operationId, atIst: formatIst(new Date()), ...after }), operationId],
  );
}

async function track(tx: Sql, tenantId: string, actor: Actor, action: string, operationId: string, buttonId: string | null, receiptId: string | null, detail: Record<string, unknown>) {
  await tx.query(
    "INSERT INTO hs_action_button_events(id,tenant_id,button_id,receipt_id,action,actor_id,operation_id,source,detail) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [randomUUID(), tenantId, buttonId, receiptId, action, actor.id, operationId, actionButtonSource, JSON.stringify(detail)],
  );
}

async function prior<T extends object>(tx: Sql, actorId: string, operationId: string, requestHash: string): Promise<(T & { replayed: true }) | null> {
  const row = await tx.query<{ request_hash: string; result: unknown }>("SELECT request_hash, result FROM hs_action_button_operations WHERE actor_id=$1 AND operation_id=$2", [actorId, operationId]);
  if (!row.rows[0]) return null;
  if (row.rows[0].request_hash !== requestHash) throw mismatch();
  return { ...asJson<T>(row.rows[0].result), replayed: true };
}

async function remember<T extends object>(tx: Sql, actorId: string, operationId: string, requestHash: string, result: T) {
  const replayed = "replayed" in result && (result as { replayed?: boolean }).replayed === true;
  const stored = { ...result, replayed };
  await tx.query("INSERT INTO hs_action_button_operations(actor_id,operation_id,request_hash,result) VALUES($1,$2,$3,$4)", [actorId, operationId, requestHash, JSON.stringify(stored)]);
  return stored;
}

async function hold(tx: Sql, tenantId: string) {
  await tx.query("SELECT id FROM hs_data_tenants WHERE id=$1 FOR UPDATE", [tenantId]);
}

async function isManager(tx: Sql, here: Scope, actor: Actor) {
  if (here.role === "owner" || here.role === "admin") return true;
  if (here.role === "observer") return false;
  const row = await tx.query("SELECT 1 FROM hs_action_button_managers WHERE workspace_id=$1 AND user_id=$2", [here.workspaceId, actor.id]);
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
  const deprecatedKeys = new Set(custom.filter(field => field.deprecated).map(field => field.key));
  const fields = [nameField(), ...standardRecordFields(collection), ...custom.filter(field => !field.deprecated)];
  return { fields, deprecatedKeys };
}

async function fieldAllowed(tx: Sql, tenantId: string, collection: string, field: RecordField, userId: string, action: "view" | "write") {
  if (!field.sensitive) return true;
  const row = await tx.query<{ can_view: boolean; can_write: boolean }>("SELECT can_view, can_write FROM hs_data_field_permissions WHERE tenant_id=$1 AND collection=$2 AND field_key=$3 AND user_id=$4", [tenantId, collection, field.key, userId]);
  const permission = row.rows[0];
  if (!permission || !on(permission.can_view)) return false;
  return action === "view" ? true : on(permission.can_write);
}

async function visibleFields(tx: Sql, tenantId: string, collection: string, userId: string) {
  const loaded = await loadFieldRows(tx, tenantId, collection);
  const visible: RecordField[] = [];
  for (const field of loaded.fields) if (await fieldAllowed(tx, tenantId, collection, field, userId, "view")) visible.push(field);
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

function valuesOf(row: { name: string; field_values: unknown }): Record<string, unknown> {
  return { name: row.name, ...asJson<Record<string, unknown>>(row.field_values) };
}

async function loadButton(tx: Sql, tenantId: string, id: string, lock = false) {
  if (!uuidPattern.test(id)) throw unavailable();
  const row = await tx.query<ButtonRow>(`SELECT id, tenant_id, collection, label, status, version, definition, created_by FROM hs_action_buttons WHERE id=$1 AND tenant_id=$2${lock ? " FOR UPDATE" : ""}`, [id, tenantId]);
  if (!row.rows[0]) throw unavailable();
  return row.rows[0];
}

async function draftFor(tx: Sql, buttonId: string, actorId: string): Promise<ActionDraftView | null> {
  const row = await tx.query<{ base_version: number | string; definition: unknown }>("SELECT base_version, definition FROM hs_action_button_drafts WHERE button_id=$1 AND actor_id=$2", [buttonId, actorId]);
  if (!row.rows[0]) return null;
  return { baseVersion: num(row.rows[0].base_version), definition: definitionOf(row.rows[0].definition) };
}

async function canOpenPage(tx: Sql, here: Scope, actor: Actor, pageId: string) {
  if (!pageIdPattern.test(pageId)) return false;
  const row = await tx.query<{ visibility: string; owner_id: string; granted: boolean }>(
    `SELECT p.visibility, p.owner_id, EXISTS(SELECT 1 FROM hs_grants g WHERE g.page_id=p.id AND g.subject=$3) AS granted
     FROM hs_pages p WHERE p.id=$1 AND p.workspace_id=$2 AND p.deleted_at IS NULL`,
    [pageId, here.workspaceId, actor.id],
  );
  const page = row.rows[0];
  if (!page) return false;
  if (page.owner_id === actor.id || here.role === "owner" || here.role === "admin") return true;
  if (on(page.granted)) return true;
  return page.visibility === "space";
}

function targetDeprecated(definition: ActionButtonDefinition, deprecatedKeys: ReadonlySet<string>) {
  return isDeprecatedAction(definition.target.actionId) || isDeprecatedLink(definition.link?.linkId) || deprecatedKeys.has(definition.target.field) || definition.inputs.some(input => deprecatedKeys.has(input.field));
}

async function availabilityFor(tx: Sql, here: Scope, actor: Actor, row: ButtonRow, manager: boolean, record: RecordRow | null, pageId: string | null) {
  const loaded = await loadFieldRows(tx, here.tenantId, row.collection);
  const definition = definitionOf(row.definition);
  const peeked = peekActionButton(definition);
  const deprecated = targetDeprecated(definition, loaded.deprecatedKeys) || isDeprecatedAction(peeked.actionId) || isDeprecatedLink(peeked.linkId);
  let contextMatches = true;
  if (record && record.collection !== row.collection) contextMatches = false;
  if (definition.context.placement === "page" && pageId && !await canOpenPage(tx, here, actor, pageId)) contextMatches = false;
  let canAct = here.role !== "observer";
  if (record && canAct) {
    const rights = await recordFlags(tx, here.tenantId, record.id, actor.id);
    const field = loaded.fields.find(item => item.key === definition.target.field);
    const write = field ? await fieldAllowed(tx, here.tenantId, row.collection, field, actor.id, "write") : false;
    canAct = rights.canEdit && write && rights.canView;
  }
  if (!manager && here.role === "observer") canAct = false;
  return buttonAvailability({
    status: row.status,
    contractDeprecated: deprecated,
    fieldDeprecated: false,
    contextMatches,
    canAct,
    stale: false,
  });
}

async function present(tx: Sql, here: Scope, actor: Actor, row: ButtonRow, manager: boolean, record: RecordRow | null, pageId: string | null): Promise<ActionButtonView> {
  const { visible } = await visibleFields(tx, here.tenantId, row.collection, actor.id);
  const keys = new Set(visible.map(field => field.key));
  const definition = redactActionButton(definitionOf(row.definition), keys);
  const draft = manager ? await draftFor(tx, row.id, actor.id) : null;
  const view: ActionButtonView = {
    id: row.id, collection: row.collection, label: row.label, status: row.status, version: num(row.version),
    definition, availability: await availabilityFor(tx, here, actor, row, manager, record, pageId),
  };
  if (manager) {
    view.createdBy = row.created_by;
    view.recoverableDraft = draft ? { baseVersion: draft.baseVersion, definition: redactActionButton(draft.definition, keys) } : null;
  }
  return view;
}

async function visibleTo(tx: Sql, here: Scope, actor: Actor, row: ButtonRow, manager: boolean) {
  if (!manager && row.status === "draft") return false;
  if (manager) return true;
  return canViewCollection(tx, here.tenantId, row.collection, actor.id);
}

async function compileFor(tx: Sql, here: Scope, actor: Actor, collection: string, input: unknown) {
  const known = await tx.query<{ id: string }>("SELECT id FROM hs_data_collections WHERE tenant_id=$1 AND id=$2 AND deprecated=false", [here.tenantId, collection]);
  if (!known.rows[0]) throw unavailable();
  const { visible } = await visibleFields(tx, here.tenantId, collection, actor.id);
  try { return compileActionButton(input, visible, collection); }
  catch (error) { if (error instanceof DocumentError) throw error; throw invalid(); }
}

async function compileSaved(tx: Sql, tenantId: string, collection: string, input: unknown) {
  const { fields, deprecatedKeys } = await loadFieldRows(tx, tenantId, collection);
  const peeked = peekActionButton(input);
  if (isDeprecatedAction(peeked.actionId) || isDeprecatedLink(peeked.linkId) || (peeked.field && deprecatedKeys.has(peeked.field))) throw disabledError();
  if ([peeked.field, ...((input as { inputs?: { field?: string }[] })?.inputs ?? []).map(item => item?.field)].some(field => field && deprecatedKeys.has(field))) throw disabledError();
  try { return compileActionButton(input, fields, collection); }
  catch (error) {
    if (error instanceof DocumentError && error.code === "action_button_field") throw disabledError();
    if (error instanceof DocumentError) throw error;
    throw invalid();
  }
}

async function writeRevision(tx: Sql, row: ButtonRow, action: string, actor: Actor, operationId: string) {
  await tx.query(
    "INSERT INTO hs_action_button_revisions(button_id,version,status,label,definition,action,actor_id,operation_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
    [row.id, num(row.version), row.status, row.label, JSON.stringify(definitionOf(row.definition)), action, actor.id, operationId],
  );
}

async function knownCollections(tx: Sql, tenantId: string) {
  const row = await tx.query<{ id: string; name: string }>("SELECT id, name FROM hs_data_collections WHERE tenant_id=$1 AND deprecated=false ORDER BY name, id", [tenantId]);
  return row.rows;
}

async function scopedRecord(tx: Sql, here: Scope, actor: Actor, recordId: string | null) {
  if (!recordId) return null;
  if (!uuidPattern.test(recordId)) throw unavailable();
  const record = await lockRecord(tx, here.tenantId, recordId);
  if (!record || !(await recordFlags(tx, here.tenantId, record.id, actor.id)).canView) throw unavailable();
  return record;
}

export async function actionButtonCatalogue(r: Repository, actor: Actor, workspaceId: string, scope: { recordId?: string | null; pageId?: string | null } = {}) {
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    const manager = await isManager(tx, here, actor);
    const record = await scopedRecord(tx, here, actor, scope.recordId ?? null);
    const pageId = scope.pageId ?? null;
    if (pageId && !pageIdPattern.test(pageId)) throw invalid();
    const rows = await tx.query<ButtonRow>("SELECT id, tenant_id, collection, label, status, version, definition, created_by FROM hs_action_buttons WHERE tenant_id=$1 ORDER BY label_search, id", [here.tenantId]);
    const buttons: ActionButtonView[] = [];
    for (const row of rows.rows) if (await visibleTo(tx, here, actor, row, manager)) buttons.push(await present(tx, here, actor, row, manager, record, pageId));
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
    return {
      manage: manager, boundary: actionButtonBoundary, assignment: actionButtonAssignment, authority: actionButtonAuthority,
      review: actionButtonReview, schedules: actionButtonSchedules, accounts: actionButtonAccounts, buttons, collections, fields, colleagues,
    };
  });
}

export async function readActionButton(r: Repository, actor: Actor, workspaceId: string, buttonId: string) {
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    const manager = await isManager(tx, here, actor);
    const row = await loadButton(tx, here.tenantId, buttonId);
    if (!await visibleTo(tx, here, actor, row, manager)) throw unavailable();
    return present(tx, here, actor, row, manager, null, null);
  });
}

export async function searchActionButtons(r: Repository, actor: Actor, workspaceId: string, query: string) {
  const needle = query.trim().toLowerCase();
  if (!needle || needle.length > actionButtonLimits.label || /[\p{Cc}]/u.test(needle)) throw invalid();
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    const manager = await isManager(tx, here, actor);
    const rows = await tx.query<ButtonRow>("SELECT id, tenant_id, collection, label, status, version, definition, created_by FROM hs_action_buttons WHERE tenant_id=$1 AND strpos(label_search, $2)>0 ORDER BY label_search, id LIMIT 200", [here.tenantId, needle]);
    const results = [];
    for (const row of rows.rows) {
      if (!await visibleTo(tx, here, actor, row, manager)) continue;
      results.push({ id: row.id, label: row.label, collection: row.collection, status: row.status, version: num(row.version) });
      if (results.length === 50) break;
    }
    return { results };
  });
}

function linkVisible(detail: { linkKind?: string | null; linkTarget?: string | null }, status: string, allowed: boolean) {
  return status === "succeeded" && allowed && typeof detail.linkTarget === "string";
}

function presentReceipt(row: ReceiptRow, recordVisible: boolean, targetVisible: boolean): ActionReceipt | null {
  if (!recordVisible) return null;
  const detail = asJson<{ linkKind?: "record" | "page" | null; linkTarget?: string | null }>(row.detail);
  const view: ActionReceipt = {
    id: row.id, buttonId: row.button_id, revision: num(row.revision), operationId: row.operation_id, actionId: row.action_id,
    actionStatus: row.action_status, linkStatus: row.link_status, linkError: row.link_error, recoverable: true,
    source: actionButtonSource, atIst: formatIst(row.created_at), replayed: false, follows: row.follows,
    recordId: row.record_id,
  };
  if (linkVisible(detail, row.link_status, targetVisible)) {
    if (detail.linkKind === "page") view.pageId = detail.linkTarget ?? undefined;
    if (detail.linkKind === "record") view.openedRecordId = detail.linkTarget ?? undefined;
  }
  return view;
}

async function targetAllowed(tx: Sql, here: Scope, actor: Actor, detail: { linkKind?: string | null; linkTarget?: string | null }, status: string) {
  if (status !== "succeeded" || typeof detail.linkTarget !== "string") return false;
  if (detail.linkKind === "page") return canOpenPage(tx, here, actor, detail.linkTarget);
  if (detail.linkKind === "record") return (await recordFlags(tx, here.tenantId, detail.linkTarget, actor.id)).canView;
  return false;
}

export async function actionButtonHistory(r: Repository, actor: Actor, workspaceId: string, buttonId: string) {
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    const manager = await isManager(tx, here, actor);
    const button = await loadButton(tx, here.tenantId, buttonId);
    if (!await visibleTo(tx, here, actor, button, manager)) throw unavailable();
    const events = await tx.query<{ action: string; actor_id: string; actor_name: string; operation_id: string; source: string; created_at: string | Date; detail: unknown }>(
      `SELECT e.action, e.actor_id, u.name AS actor_name, e.operation_id::text, e.source, e.created_at, e.detail
       FROM hs_action_button_events e JOIN hs_users u ON u.id=e.actor_id
       WHERE e.tenant_id=$1 AND e.button_id=$2 ORDER BY e.created_at DESC, e.id DESC LIMIT 50`,
      [here.tenantId, buttonId],
    );
    const receipts = await tx.query<ReceiptRow>("SELECT * FROM hs_action_button_receipts WHERE tenant_id=$1 AND button_id=$2 ORDER BY created_at DESC, id DESC LIMIT 50", [here.tenantId, buttonId]);
    const visibleReceipts: ActionReceipt[] = [];
    for (const receipt of receipts.rows) {
      if (!(await recordFlags(tx, here.tenantId, receipt.record_id, actor.id)).canView) continue;
      const detail = asJson<{ linkKind?: string | null; linkTarget?: string | null }>(receipt.detail);
      const shown = presentReceipt(receipt, true, await targetAllowed(tx, here, actor, detail, receipt.link_status));
      if (shown) visibleReceipts.push(shown);
    }
    return {
      events: events.rows.map(event => {
        const detail = asJson<Record<string, unknown>>(event.detail);
        const revision = [detail.revision, detail.version].map(value => typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : null).find(value => value !== null) ?? null;
        return {
          action: event.action, actorId: event.actor_id, actorName: event.actor_name, operationId: event.operation_id,
          source: event.source, atIst: formatIst(event.created_at), revision,
          actionId: typeof detail.actionId === "string" ? detail.actionId : null,
          outcome: typeof detail.linkStatus === "string" ? detail.linkStatus : typeof detail.status === "string" ? detail.status : null,
        };
      }),
      receipts: visibleReceipts,
    };
  });
}

export async function readActionReceipt(r: Repository, actor: Actor, workspaceId: string, receiptId: string) {
  if (!uuidPattern.test(receiptId)) throw unavailable();
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    const row = await tx.query<ReceiptRow>("SELECT * FROM hs_action_button_receipts WHERE id=$1 AND tenant_id=$2", [receiptId, here.tenantId]);
    const receipt = row.rows[0];
    if (!receipt || !(await recordFlags(tx, here.tenantId, receipt.record_id, actor.id)).canView) throw unavailable();
    const manager = await isManager(tx, here, actor);
    const button = await loadButton(tx, here.tenantId, receipt.button_id);
    if (!await visibleTo(tx, here, actor, button, manager)) throw unavailable();
    const detail = asJson<{ linkKind?: string | null; linkTarget?: string | null }>(receipt.detail);
    const shown = presentReceipt(receipt, true, await targetAllowed(tx, here, actor, detail, receipt.link_status));
    if (!shown) throw unavailable();
    return shown;
  });
}

export async function createActionButton(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; collection: string; label: string; definition: unknown }) {
  const requestHash = recordHash({ kind: "create", workspaceId, collection: input.collection, label: input.label, definition: input.definition });
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await hold(tx, here.tenantId);
    const replay = await prior<ActionButtonView>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    await requireManager(tx, here, actor);
    const count = await tx.query<{ n: number | string }>("SELECT count(*)::int AS n FROM hs_action_buttons WHERE tenant_id=$1", [here.tenantId]);
    if (num(count.rows[0]?.n) >= actionButtonLimits.buttons) throw new DocumentError("The action button catalogue is full.", "action_button_limit", 422);
    const label = actionButtonLabel(input.label);
    const definition = await compileFor(tx, here, actor, input.collection, input.definition);
    const id = randomUUID();
    try {
      await tx.query(
        "INSERT INTO hs_action_buttons(id,tenant_id,collection,label,status,version,definition,created_by) VALUES($1,$2,$3,$4,'draft',1,$5,$6)",
        [id, here.tenantId, input.collection, label, JSON.stringify(definition), actor.id],
      );
    } catch (error) { if (uniqueViolation(error)) throw new DocumentError("An action button with that label already exists.", "action_button_conflict", 409); throw error; }
    const row = await loadButton(tx, here.tenantId, id);
    await writeRevision(tx, row, "create", actor, input.operationId);
    await audit(tx, actor, "action-button.create", input.operationId, id, { workspaceId, version: 1, status: "draft", actionId: definition.target.actionId });
    await track(tx, here.tenantId, actor, "create", input.operationId, id, null, { version: 1, status: "draft", actionId: definition.target.actionId });
    return remember(tx, actor.id, input.operationId, requestHash, await present(tx, here, actor, row, true, null, null));
  });
}

export async function stashActionButton(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; buttonId: string; expectedVersion: number; definition: unknown }) {
  const requestHash = recordHash({ kind: "stash", workspaceId, buttonId: input.buttonId, expectedVersion: input.expectedVersion, definition: input.definition });
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await hold(tx, here.tenantId);
    const replay = await prior<{ id: string; version: number; conflict: boolean; recoverableDraft: ActionDraftView }>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    await requireManager(tx, here, actor);
    const row = await loadButton(tx, here.tenantId, input.buttonId, true);
    const definition = await compileFor(tx, here, actor, row.collection, input.definition);
    const version = num(row.version);
    await tx.query(
      `INSERT INTO hs_action_button_drafts(button_id,actor_id,base_version,definition,operation_id)
       VALUES($1,$2,$3,$4,$5)
       ON CONFLICT (button_id, actor_id) DO UPDATE SET base_version=EXCLUDED.base_version, definition=EXCLUDED.definition, operation_id=EXCLUDED.operation_id, updated_at=clock_timestamp()`,
      [row.id, actor.id, input.expectedVersion > 0 ? input.expectedVersion : version, JSON.stringify(definition), input.operationId],
    );
    const draft = await draftFor(tx, row.id, actor.id);
    const result = { id: row.id, version, conflict: version !== input.expectedVersion, recoverableDraft: draft!, replayed: false as const };
    await audit(tx, actor, "action-button.stash", input.operationId, row.id, { workspaceId, version, conflict: result.conflict });
    return remember(tx, actor.id, input.operationId, requestHash, result);
  });
}

export async function discardActionButtonDraft(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; buttonId: string }) {
  const requestHash = recordHash({ kind: "discard-draft", workspaceId, buttonId: input.buttonId });
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await hold(tx, here.tenantId);
    const replay = await prior<{ id: string; discarded: true }>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    await requireManager(tx, here, actor);
    const row = await loadButton(tx, here.tenantId, input.buttonId);
    await tx.query("DELETE FROM hs_action_button_drafts WHERE button_id=$1 AND actor_id=$2", [row.id, actor.id]);
    await audit(tx, actor, "action-button.discard-draft", input.operationId, row.id, { workspaceId });
    return remember(tx, actor.id, input.operationId, requestHash, { id: row.id, discarded: true as const });
  });
}

function assertPreviewShape(kind: PreviewKind, detail: { definition?: unknown; label?: string; targetVersion?: number; recordId?: string; pageId?: string; inputs?: unknown }) {
  const extra = (keys: string[]) => keys.some(key => detail[key as keyof typeof detail] !== undefined);
  if (kind === "version-change") {
    if (detail.definition === undefined || extra(["recordId", "pageId", "targetVersion", "inputs"])) throw invalid();
  } else if (kind === "rollback") {
    if (!Number.isInteger(detail.targetVersion) || (detail.targetVersion ?? 0) < 1 || extra(["definition", "label", "recordId", "pageId", "inputs"])) throw invalid();
  } else if (kind === "invoke") {
    if (!detail.recordId || !uuidPattern.test(detail.recordId) || extra(["definition", "label", "targetVersion"])) throw invalid();
    if (detail.pageId !== undefined && !pageIdPattern.test(detail.pageId)) throw invalid();
  } else if (kind === "activate" || kind === "pause") {
    if (extra(["definition", "label", "recordId", "pageId", "targetVersion", "inputs"])) throw invalid();
  } else throw invalid();
}

async function invokePlan(tx: Sql, here: Scope, actor: Actor, row: ButtonRow, input: { recordId?: string; pageId?: string; inputs?: unknown }) {
  if (here.role === "observer") throw readOnly();
  if (row.status !== "active") throw pausedError();
  const definition = await compileSaved(tx, here.tenantId, row.collection, definitionOf(row.definition));
  const record = await lockRecord(tx, here.tenantId, input.recordId!);
  if (!record || record.collection !== row.collection) throw unavailable();
  const rights = await recordFlags(tx, here.tenantId, record.id, actor.id);
  if (!rights.canView) throw unavailable();
  if (!rights.canEdit) throw forbidden();
  if (definition.context.placement === "page") {
    if (!input.pageId) throw invalid();
    if (!await canOpenPage(tx, here, actor, input.pageId)) throw unavailable();
  } else if (input.pageId) throw invalid();
  const { fields } = await loadFieldRows(tx, here.tenantId, row.collection);
  const resolved = resolveActionInputs(definition, input.inputs, fields);
  const targetField = fields.find(field => field.key === definition.target.field);
  if (!targetField || !await fieldAllowed(tx, here.tenantId, row.collection, targetField, actor.id, "write")) throw forbidden();
  for (const fieldKey of definitionFields(definition)) {
    const field = fields.find(item => item.key === fieldKey);
    if (!field || !await fieldAllowed(tx, here.tenantId, row.collection, field, actor.id, "view")) throw forbidden();
  }
  const current = valuesOf(record)[targetField.key];
  const supplied = definition.target.actionId === "hs.record.clear-field" ? undefined : resolved[definition.target.inputId];
  let after: unknown;
  try { after = actionImpact(targetField, current, definition.target, supplied); }
  catch (error) { if (error instanceof DocumentError) throw error; throw invalid(); }
  const link = linkTarget(definition.link, resolved);
  const detail: InvokeDetail = {
    recordId: record.id, recordVersion: num(record.version), inputs: resolved, pageId: input.pageId ?? null,
    actionId: definition.target.actionId, field: targetField.key, linkId: definition.link?.linkId ?? null,
    linkKind: link.kind, linkTarget: link.target,
  };
  return {
    detail,
    plan: {
      actionId: definition.target.actionId, field: targetField.key, before: current ?? null, after: after ?? null,
      linkId: definition.link?.linkId ?? null, audience: "current-user" as const,
      rights: { record: "edit" as const, field: "write" as const, action: definition.target.actionId },
    },
  };
}

function linkTarget(link: ActionButtonLink | null, resolved: Record<string, unknown>) {
  if (!link) return { kind: null, target: null };
  if (link.linkId === "hs.page.open") return { kind: "page" as const, target: link.pageId };
  const value = resolved[link.inputId];
  return { kind: "record" as const, target: typeof value === "string" ? value : null };
}

export async function previewActionButton(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; buttonId: string; kind: PreviewKind; expectedVersion: number; definition?: unknown; label?: string; targetVersion?: number; recordId?: string; pageId?: string; inputs?: unknown }): Promise<ActionPreviewView> {
  const requestHash = recordHash({ workspaceId, action: "preview", buttonId: input.buttonId, previewKind: input.kind, expectedVersion: input.expectedVersion, definition: input.definition ?? null, label: input.label ?? null, targetVersion: input.targetVersion ?? null, recordId: input.recordId ?? null, pageId: input.pageId ?? null, inputs: input.inputs ?? null });
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await hold(tx, here.tenantId);
    const replay = await prior<ActionPreviewView>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    assertPreviewShape(input.kind, input);
    if (input.kind !== "invoke") await requireManager(tx, here, actor);
    const row = await loadButton(tx, here.tenantId, input.buttonId, true);
    if (num(row.version) !== input.expectedVersion) throw conflict();
    let detail: Record<string, unknown> = {};
    let plan: ActionPreviewView["plan"] = null;
    if (input.kind === "version-change") {
      const definition = await compileFor(tx, here, actor, row.collection, input.definition);
      detail = { definition, label: input.label ? actionButtonLabel(input.label) : row.label };
    } else if (input.kind === "rollback") {
      const revision = await tx.query<{ definition: unknown; label: string }>("SELECT definition, label FROM hs_action_button_revisions WHERE button_id=$1 AND version=$2", [row.id, input.targetVersion]);
      if (!revision.rows[0] || input.targetVersion === num(row.version)) throw invalid();
      detail = { targetVersion: input.targetVersion, label: revision.rows[0].label, definition: await compileFor(tx, here, actor, row.collection, definitionOf(revision.rows[0].definition)) };
    } else if (input.kind === "invoke") {
      const reviewed = await invokePlan(tx, here, actor, row, input);
      detail = reviewed.detail;
      plan = reviewed.plan;
    } else if (input.kind === "activate" && row.status === "active") throw conflict();
    else if (input.kind === "pause" && row.status !== "active") throw conflict();
    const seal = recordHash({ version: num(row.version), status: row.status, label: row.label, definition: definitionOf(row.definition), action: input.kind, detail });
    const previewId = randomUUID();
    await tx.query(
      "INSERT INTO hs_action_button_previews(id,tenant_id,actor_id,button_id,action,button_version,seal,detail) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [previewId, here.tenantId, actor.id, row.id, input.kind, num(row.version), seal, JSON.stringify(detail)],
    );
    const view = await present(tx, here, actor, row, input.kind !== "invoke" || await isManager(tx, here, actor), null, input.pageId ?? null);
    const result = { previewId, action: input.kind, review: actionButtonReview, version: view.version, status: view.status, definition: view.definition, plan, schedules: actionButtonSchedules };
    await audit(tx, actor, "action-button.preview", input.operationId, row.id, { workspaceId, action: input.kind, version: view.version, actionId: definitionOf(row.definition).target.actionId });
    return remember(tx, actor.id, input.operationId, requestHash, result);
  });
}

async function publish(tx: Sql, here: Scope, actor: Actor, row: ButtonRow, status: ActionButtonStatus, definition: ActionButtonDefinition, label: string, action: string, operationId: string) {
  const version = num(row.version) + 1;
  try {
    await tx.query("UPDATE hs_action_buttons SET status=$3, version=$4, definition=$5, label=$6, updated_at=clock_timestamp() WHERE id=$1 AND tenant_id=$2", [row.id, here.tenantId, status, version, JSON.stringify(definition), label]);
  } catch (error) { if (uniqueViolation(error)) throw new DocumentError("An action button with that label already exists.", "action_button_conflict", 409); throw error; }
  if (action === "version-change" || action === "rollback") await tx.query("DELETE FROM hs_action_button_drafts WHERE button_id=$1 AND actor_id=$2", [row.id, actor.id]);
  const saved = await loadButton(tx, here.tenantId, row.id);
  await writeRevision(tx, saved, action, actor, operationId);
  await audit(tx, actor, `action-button.${action}`, operationId, row.id, { workspaceId: here.workspaceId, version, status, actionId: definition.target.actionId });
  await track(tx, here.tenantId, actor, action, operationId, row.id, null, { version, status, actionId: definition.target.actionId, outcome: status });
  return present(tx, here, actor, saved, true, null, null);
}

async function resolveStoredLink(tx: Sql, here: Scope, actor: Actor, detail: InvokeDetail) {
  if (!detail.linkId || !detail.linkKind) return { status: "none" as const, error: null, visible: false };
  if (detail.linkKind === "page") {
    const pageId = detail.linkTarget;
    if (!pageId || !await canOpenPage(tx, here, actor, pageId)) return { status: "failed" as const, error: "unavailable", visible: false };
    return { status: "succeeded" as const, error: null, visible: true };
  }
  const target = detail.linkTarget;
  if (!target || !uuidPattern.test(target)) return { status: "failed" as const, error: "unavailable", visible: false };
  const row = await tx.query<{ id: string }>("SELECT id FROM hs_data_records WHERE id=$1 AND tenant_id=$2 AND state='active' AND merged_into_id IS NULL", [target, here.tenantId]);
  if (!row.rows[0] || !(await recordFlags(tx, here.tenantId, target, actor.id)).canView) return { status: "failed" as const, error: "unavailable", visible: false };
  return { status: "succeeded" as const, error: null, visible: true };
}

async function writeReceipt(tx: Sql, here: Scope, actor: Actor, row: ButtonRow, detail: InvokeDetail, operationId: string, follows: string | null, revision: number, link: { status: "none" | "succeeded" | "failed"; error: string | null; visible: boolean }) {
  const id = randomUUID();
  const stored = {
    actionId: detail.actionId, field: detail.field, linkId: detail.linkId, linkKind: detail.linkKind, linkTarget: detail.linkTarget,
  };
  const inserted = await tx.query<ReceiptRow>(
    `INSERT INTO hs_action_button_receipts(id,tenant_id,button_id,revision,record_id,operation_id,actor_id,action_id,action_status,link_status,link_error,follows,source,detail)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,'succeeded',$9,$10,$11,$12,$13) RETURNING *`,
    [id, here.tenantId, row.id, revision, detail.recordId, operationId, actor.id, detail.actionId, link.status, link.error, follows, actionButtonSource, JSON.stringify(stored)],
  );
  await audit(tx, actor, follows ? "action-button.retry-link" : "action-button.invoke", operationId, row.id, { workspaceId: here.workspaceId, version: revision, revision, actionId: detail.actionId, actionStatus: "succeeded", linkStatus: link.status });
  await track(tx, here.tenantId, actor, follows ? "retry-link" : "invoke", operationId, row.id, id, { version: revision, revision, actionId: detail.actionId, actionStatus: "succeeded", linkStatus: link.status });
  const shown = presentReceipt(inserted.rows[0], true, link.visible);
  if (!shown) throw unavailable();
  return shown;
}

async function applyInvoke(tx: Sql, here: Scope, actor: Actor, row: ButtonRow, detail: InvokeDetail, operationId: string) {
  if (here.role === "observer") throw readOnly();
  if (row.status !== "active") throw pausedError();
  const definition = await compileSaved(tx, here.tenantId, row.collection, definitionOf(row.definition));
  if (definition.target.actionId !== detail.actionId || definition.target.field !== detail.field) throw previewError();
  const record = await lockRecord(tx, here.tenantId, detail.recordId);
  if (!record || record.collection !== row.collection) throw unavailable();
  if (num(record.version) !== detail.recordVersion) throw staleError();
  const rights = await recordFlags(tx, here.tenantId, record.id, actor.id);
  if (!rights.canView) throw unavailable();
  if (!rights.canEdit) throw forbidden();
  if (definition.context.placement === "page") {
    if (!detail.pageId) throw invalid();
    if (!await canOpenPage(tx, here, actor, detail.pageId)) throw unavailable();
  }
  const { fields } = await loadFieldRows(tx, here.tenantId, row.collection);
  const targetField = fields.find(field => field.key === definition.target.field);
  if (!targetField || !await fieldAllowed(tx, here.tenantId, row.collection, targetField, actor.id, "write")) throw forbidden();
  for (const fieldKey of definitionFields(definition)) {
    const field = fields.find(item => item.key === fieldKey);
    if (!field || !await fieldAllowed(tx, here.tenantId, row.collection, field, actor.id, "view")) throw forbidden();
  }
  const resolved = resolveActionInputs(definition, detail.inputs, fields);
  if (recordHash(resolved) !== recordHash(detail.inputs)) throw previewError();
  const supplied = definition.target.actionId === "hs.record.clear-field" ? undefined : resolved[definition.target.inputId];
  let next: unknown;
  try { next = actionImpact(targetField, valuesOf(record)[targetField.key], definition.target as ActionButtonTarget, supplied); }
  catch { throw previewError(); }
  const before = { name: record.name, values: asJson<Record<string, unknown>>(record.field_values), parentOrganisationId: record.parent_organisation_id, state: record.state };
  const name = targetField.key === "name" ? String(next) : record.name;
  const stored = { ...asJson<Record<string, unknown>>(record.field_values) };
  if (targetField.key !== "name") stored[targetField.key] = next;
  const written = await tx.query<{ version: number | string }>(
    "UPDATE hs_data_records SET name=$3, field_values=$4, version=version+1, updated_by=$5, updated_at=clock_timestamp() WHERE id=$1 AND tenant_id=$2 AND version=$6 RETURNING version",
    [record.id, here.tenantId, name, JSON.stringify(stored), actor.id, num(record.version)],
  );
  if (!written.rows[0]) throw staleError();
  const version = num(written.rows[0].version);
  const after = { name, values: stored, parentOrganisationId: record.parent_organisation_id, state: record.state };
  const eventId = randomUUID();
  const policy = Object.fromEntries((await loadFieldRows(tx, here.tenantId, record.collection)).fields.map(item => [item.key, item.sensitive]));
  await tx.query(
    "INSERT INTO hs_data_events(id,tenant_id,record_id,record_version,actor_id,source_app,operation_id,kind,before_value,after_value,field_policy,service_subject) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,NULL)",
    [eventId, here.tenantId, record.id, version, actor.id, actionButtonSource, operationId, "action-button.invoke", JSON.stringify(before), JSON.stringify(after), JSON.stringify(policy)],
  );
  await tx.query(
    "INSERT INTO hs_data_change_events(id,tenant_id,record_id,record_version,collection,operation_id,source_app,actor_id,service_subject,kind) VALUES($1,$2,$3,$4,$5,$6,$7,$8,NULL,$9)",
    [eventId, here.tenantId, record.id, version, record.collection, operationId, actionButtonSource, actor.id, "action-button.invoke"],
  );
  const link = await resolveStoredLink(tx, here, actor, detail);
  return writeReceipt(tx, here, actor, row, detail, operationId, null, num(row.version), link);
}

export async function applyActionButtonPreview(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; previewId: string; expectedVersion: number }) {
  const requestHash = recordHash({ kind: "apply", workspaceId, previewId: input.previewId, expectedVersion: input.expectedVersion });
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await hold(tx, here.tenantId);
    const replay = await prior<ActionButtonView | ActionReceipt>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    if (!uuidPattern.test(input.previewId)) throw unavailable();
    const preview = await tx.query<{ button_id: string; action: PreviewKind; button_version: number | string; seal: string; detail: unknown; actor_id: string }>("SELECT button_id, action, button_version, seal, detail, actor_id FROM hs_action_button_previews WHERE id=$1 AND tenant_id=$2", [input.previewId, here.tenantId]);
    const review = preview.rows[0];
    if (!review || review.actor_id !== actor.id) throw unavailable();
    if (review.action !== "invoke") await requireManager(tx, here, actor);
    const row = await loadButton(tx, here.tenantId, review.button_id, true);
    if (num(row.version) !== input.expectedVersion) throw conflict();
    const detail = asJson<Record<string, unknown>>(review.detail);
    const seal = recordHash({ version: num(row.version), status: row.status, label: row.label, definition: definitionOf(row.definition), action: review.action, detail });
    if (seal !== review.seal || num(review.button_version) !== num(row.version)) throw previewError();
    if (review.action === "invoke") {
      const saved = await applyInvoke(tx, here, actor, row, detail as InvokeDetail, input.operationId);
      return remember(tx, actor.id, input.operationId, requestHash, saved);
    }
    const current = definitionOf(row.definition);
    let status: ActionButtonStatus = row.status;
    let definition = current;
    let label = row.label;
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
      label = typeof detail.label === "string" ? actionButtonLabel(detail.label) : row.label;
      status = row.status === "active" || review.action === "rollback" ? "paused" : row.status;
    } else throw invalid();
    const saved = await publish(tx, here, actor, row, status, definition, label, review.action, input.operationId);
    return remember(tx, actor.id, input.operationId, requestHash, saved);
  });
}

export async function retryActionButtonLink(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; receiptId: string }) {
  const requestHash = recordHash({ kind: "retry-link", workspaceId, receiptId: input.receiptId });
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await hold(tx, here.tenantId);
    const replay = await prior<ActionReceipt>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    if (here.role === "observer") throw readOnly();
    if (!uuidPattern.test(input.receiptId)) throw unavailable();
    const found = await tx.query<ReceiptRow>("SELECT * FROM hs_action_button_receipts WHERE id=$1 AND tenant_id=$2", [input.receiptId, here.tenantId]);
    const receipt = found.rows[0];
    if (!receipt || receipt.action_status !== "succeeded") throw unavailable();
    if (!(await recordFlags(tx, here.tenantId, receipt.record_id, actor.id)).canView) throw unavailable();
    const row = await loadButton(tx, here.tenantId, receipt.button_id, true);
    const manager = await isManager(tx, here, actor);
    if (!await visibleTo(tx, here, actor, row, manager)) throw unavailable();
    const stored = asJson<{ actionId: string; field: string; linkId: string | null; linkKind: "record" | "page" | null; linkTarget: string | null }>(receipt.detail);
    const detail: InvokeDetail = {
      recordId: receipt.record_id, recordVersion: num(receipt.revision), inputs: {}, pageId: null,
      actionId: stored.actionId, field: stored.field, linkId: stored.linkId, linkKind: stored.linkKind, linkTarget: stored.linkTarget,
    };
    const link = await resolveStoredLink(tx, here, actor, detail);
    const saved = await writeReceipt(tx, here, actor, row, detail, input.operationId, receipt.id, num(receipt.revision), link);
    return remember(tx, actor.id, input.operationId, requestHash, saved);
  });
}

async function visibleReceiptLines(tx: Sql, here: Scope, actor: Actor, buttonId: string) {
  const receipts = await tx.query<ReceiptRow>("SELECT * FROM hs_action_button_receipts WHERE tenant_id=$1 AND button_id=$2 ORDER BY created_at, id LIMIT 50", [here.tenantId, buttonId]);
  const lines = [];
  for (const receipt of receipts.rows) {
    if (!(await recordFlags(tx, here.tenantId, receipt.record_id, actor.id)).canView) continue;
    lines.push({ revision: num(receipt.revision), actionStatus: receipt.action_status, linkStatus: receipt.link_status, atIst: formatIst(receipt.created_at) });
  }
  return lines;
}

export async function downloadActionButton(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; buttonId: string; expectedVersion: number }) {
  const requestHash = recordHash({ kind: "download", workspaceId, buttonId: input.buttonId, expectedVersion: input.expectedVersion });
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await hold(tx, here.tenantId);
    const replay = await prior<{ filename: string; contentType: string; body: string; version: number }>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    const manager = await isManager(tx, here, actor);
    const row = await loadButton(tx, here.tenantId, input.buttonId);
    if (!await visibleTo(tx, here, actor, row, manager)) throw unavailable();
    if (num(row.version) !== input.expectedVersion) throw conflict();
    const view = await present(tx, here, actor, row, manager, null, null);
    const body = actionButtonDocument({ label: view.label, status: view.status, version: view.version, collection: view.collection, definition: view.definition }, await visibleReceiptLines(tx, here, actor, row.id));
    await audit(tx, actor, "action-button.download", input.operationId, row.id, { workspaceId, version: view.version, actionId: view.definition.target.actionId });
    return remember(tx, actor.id, input.operationId, requestHash, { filename: "action-button.md", contentType: "text/markdown; charset=utf-8", body, version: view.version });
  });
}

export async function grantActionButtonManager(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; userId: string }) {
  const requestHash = recordHash({ kind: "grant-manager", workspaceId, userId: input.userId });
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await hold(tx, here.tenantId);
    const replay = await prior<{ granted: true; userId: string }>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    await requireManager(tx, here, actor, true);
    const member = await activeMember(tx, here.workspaceId, input.userId);
    if (!member || member.role === "observer") throw unavailable();
    await tx.query("INSERT INTO hs_action_button_managers(workspace_id,user_id,granted_by) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [here.workspaceId, input.userId, actor.id]);
    await audit(tx, actor, "action-button.grant-manager", input.operationId, input.userId, { workspaceId });
    return remember(tx, actor.id, input.operationId, requestHash, { granted: true as const, userId: input.userId });
  });
}

export async function revokeActionButtonManager(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; userId: string }) {
  const requestHash = recordHash({ kind: "revoke-manager", workspaceId, userId: input.userId });
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await hold(tx, here.tenantId);
    const replay = await prior<{ revoked: true; userId: string }>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    await requireManager(tx, here, actor, true);
    await tx.query("DELETE FROM hs_action_button_managers WHERE workspace_id=$1 AND user_id=$2", [here.workspaceId, input.userId]);
    await audit(tx, actor, "action-button.revoke-manager", input.operationId, input.userId, { workspaceId });
    return remember(tx, actor.id, input.operationId, requestHash, { revoked: true as const, userId: input.userId });
  });
}
