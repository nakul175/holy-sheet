import { randomUUID } from "node:crypto";
import type { Actor } from "./auth";
import type { Sql } from "./database";
import { DocumentError } from "./document";
import { formatIst } from "./ist-label";
import type { Repository } from "./repository";
import { recordHash } from "./shared-record-types";
import {
  assertPlacement,
  hierarchyAssignment,
  hierarchyBoundary,
  hierarchyDepthLimit,
  hierarchyDocument,
  hierarchyLimits,
  hierarchyReview,
  subtreeIds,
} from "./collection-hierarchy-plan";

export { hierarchyAssignment, hierarchyBoundary, hierarchyReview };

const source = "collection-hierarchy";
const accountRelationship = "Accounts still require an Organisation. This hierarchy does not replace that link.";
const unavailable = () => new DocumentError("Collection hierarchy is restricted or unavailable.", "not_found", 404);
const refused = () => new DocumentError("This action is not permitted.", "hierarchy_forbidden", 403);
const mismatch = () => new DocumentError("This attempt was reused with different fields.", "operation_mismatch", 409);
const conflict = () => new DocumentError("The hierarchy version changed. Review it and try again.", "hierarchy_conflict", 409);
const invalid = () => new DocumentError("Check the hierarchy request.", "hierarchy_validation", 422);
const readOnly = () => new DocumentError("This hierarchy is read only.", "read_only", 403);
const managementRequired = () => new DocumentError("Hierarchy configuration authority is required.", "management_required", 403);
const parentRejected = () => new DocumentError("Choose a parent in this collection that does not create a cycle, cross a tenant, or pass the depth limit.", "hierarchy_parent", 422);
const rootsRejected = () => new DocumentError("This collection does not allow a record without a parent.", "hierarchy_parent", 422);
const coreRejected = () => new DocumentError("Hierarchy applies to custom collections. Account to Organisation links stay as they are.", "hierarchy_parent", 422);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Scope = { workspaceId: string; tenantId: string; role: string };
type ConfigRow = { collection: string; enabled: boolean; allow_roots: boolean; depth_limit: number | string; version: number | string };
type RecordRow = {
  id: string; collection: string; name: string; state: string; version: number | string; field_values: unknown; parent_organisation_id: string | null;
  can_view: boolean; can_edit: boolean; can_archive: boolean; can_delete: boolean; can_export: boolean; can_history: boolean;
};
export type ConfigDraftView = { enabled: boolean; allowRoots: boolean; depthLimit: number; baseVersion: number };
export type PlacementDraftView = { parentId: string | null; baseVersion: number };
export type ConfigView = {
  collection: string; name: string; eligible: boolean; enabled: boolean; allowRoots: boolean; depthLimit: number; version: number;
  recoverableDraft?: ConfigDraftView | null;
};
type ActionName = "reparent" | "archive" | "delete";
type CapabilityName = "view" | "edit" | "archive" | "delete" | "export" | "history";

const capabilities: CapabilityName[] = ["view", "edit", "archive", "delete", "export", "history"];

function on(value: unknown) { return value === true || value === "t" || value === "true" || value === 1; }
function num(value: number | string | null | undefined) { return Number(value ?? 0); }
function asRecord(value: unknown) { return (typeof value === "string" ? JSON.parse(value) : value ?? {}) as Record<string, unknown>; }
function errorText(error: unknown) {
  const value = error as { message?: string; cause?: { message?: string } };
  return `${value?.message ?? ""} ${value?.cause?.message ?? ""}`;
}
function uniqueViolation(error: unknown) {
  const value = error as { code?: string; cause?: { code?: string } };
  return value?.code === "23505" || value?.cause?.code === "23505";
}
function raise(error: unknown): never {
  const text = errorText(error);
  if (/hierarchy roots/.test(text)) throw rootsRejected();
  if (/hierarchy custom collection|hierarchy identity/.test(text)) throw coreRejected();
  if (/hierarchy/.test(text)) throw parentRejected();
  if (uniqueViolation(error)) throw conflict();
  throw error;
}
function grant(alias: string, actorParam: string, capability: CapabilityName) {
  if (!capabilities.includes(capability)) throw invalid();
  return `(EXISTS(SELECT 1 FROM hs_data_collection_grants g WHERE g.tenant_id=${alias}.tenant_id AND g.user_id=${actorParam} AND g.collection=${alias}.collection AND '${capability}'=ANY(g.capabilities)) OR EXISTS(SELECT 1 FROM hs_data_record_grants g WHERE g.tenant_id=${alias}.tenant_id AND g.record_id=${alias}.id AND g.user_id=${actorParam} AND '${capability}'=ANY(g.capabilities)))`;
}
function likePattern(query: string) {
  return `%${query.toLowerCase().replace(/[\\%_]/g, character => `\\${character}`)}%`;
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
    [randomUUID(), actor.id, action, subjectId, JSON.stringify({ source, operationId, atIst: formatIst(new Date()), ...after }), operationId],
  );
}

async function prior<T extends object>(tx: Sql, actorId: string, operationId: string, requestHash: string): Promise<(T & { replayed: true }) | null> {
  if (!uuidPattern.test(operationId)) throw invalid();
  const row = await tx.query<{ request_hash: string; result: unknown }>("SELECT request_hash, result FROM hs_collection_hierarchy_operations WHERE actor_id=$1 AND operation_id=$2", [actorId, operationId]);
  if (!row.rows[0]) return null;
  if (row.rows[0].request_hash !== requestHash) throw mismatch();
  return { ...(asRecord(row.rows[0].result) as T), replayed: true };
}

async function remember(tx: Sql, actorId: string, operationId: string, requestHash: string, result: object) {
  await tx.query("INSERT INTO hs_collection_hierarchy_operations(actor_id,operation_id,request_hash,result) VALUES($1,$2,$3,$4)", [actorId, operationId, requestHash, JSON.stringify(result)]);
}

async function hold(tx: Sql, tenantId: string) {
  await tx.query("SELECT id FROM hs_data_tenants WHERE id=$1 FOR UPDATE", [tenantId]);
}

async function isManager(tx: Sql, here: Scope, actor: Actor) {
  if (here.role === "owner" || here.role === "admin") return true;
  if (here.role === "observer") return false;
  const row = await tx.query("SELECT 1 FROM hs_collection_hierarchy_managers WHERE workspace_id=$1 AND user_id=$2", [here.workspaceId, actor.id]);
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

function collectionKey(value: string) {
  const collection = value.trim();
  if (!collection || collection.length > 100) throw invalid();
  return collection;
}

async function fieldAllows(tx: Sql, tenantId: string, collection: string, actorId: string, flag: "can_view" | "can_assign" | "can_history") {
  const policy = await tx.query<{ sensitive: boolean }>("SELECT sensitive FROM hs_collection_hierarchy_field_policy WHERE tenant_id=$1 AND collection=$2", [tenantId, collection]);
  const access = await tx.query<{ can_view: boolean; can_assign: boolean; can_history: boolean }>("SELECT can_view, can_assign, can_history FROM hs_collection_hierarchy_field_access WHERE tenant_id=$1 AND collection=$2 AND user_id=$3", [tenantId, collection, actorId]);
  const sensitive = policy.rows[0] ? on(policy.rows[0].sensitive) : false;
  const row = access.rows[0];
  if (sensitive) return row ? on(row[flag]) : false;
  if (!row) return true;
  return on(row[flag]);
}

async function canViewCollection(tx: Sql, tenantId: string, collection: string, actorId: string) {
  const row = await tx.query(
    `SELECT 1 WHERE EXISTS(SELECT 1 FROM hs_data_collection_grants g WHERE g.tenant_id=$1 AND g.user_id=$3 AND g.collection=$2 AND 'view'=ANY(g.capabilities))
      OR EXISTS(SELECT 1 FROM hs_data_records r JOIN hs_data_record_grants g ON g.tenant_id=r.tenant_id AND g.record_id=r.id WHERE r.tenant_id=$1 AND r.collection=$2 AND g.user_id=$3 AND 'view'=ANY(g.capabilities))`,
    [tenantId, collection, actorId],
  );
  return row.rows.length > 0;
}

async function loadCollection(tx: Sql, tenantId: string, collection: string) {
  const row = await tx.query<{ id: string; name: string; core: boolean; removed_at: string | null }>(
    `SELECT c.id, c.name, c.core, s.removed_at
     FROM hs_data_collections c
     LEFT JOIN hs_data_collection_settings s ON s.tenant_id=c.tenant_id AND s.collection=c.id
     WHERE c.tenant_id=$1 AND c.id=$2`,
    [tenantId, collection],
  );
  const found = row.rows[0];
  if (!found || found.removed_at) throw unavailable();
  return { ...found, core: on(found.core) };
}

async function loadConfig(tx: Sql, tenantId: string, collection: string, lock = false) {
  const row = await tx.query<ConfigRow>(
    `SELECT collection, enabled, allow_roots, depth_limit, version FROM hs_collection_hierarchy WHERE tenant_id=$1 AND collection=$2${lock ? " FOR UPDATE" : ""}`,
    [tenantId, collection],
  );
  return row.rows[0] ?? null;
}

function presentConfig(row: ConfigRow | null, name: string, eligible: boolean): ConfigView {
  return {
    collection: row?.collection ?? name,
    name,
    eligible,
    enabled: row ? on(row.enabled) : false,
    allowRoots: row ? on(row.allow_roots) : true,
    depthLimit: row ? num(row.depth_limit) : hierarchyLimits.depth,
    version: row ? num(row.version) : 0,
  };
}

async function configDraft(tx: Sql, tenantId: string, actorId: string, collection: string): Promise<ConfigDraftView | null> {
  const row = await tx.query<{ enabled: boolean; allow_roots: boolean; depth_limit: number | string; base_version: number | string }>(
    "SELECT enabled, allow_roots, depth_limit, base_version FROM hs_collection_hierarchy_drafts WHERE actor_id=$1 AND tenant_id=$2 AND kind='config' AND collection=$3 AND record_key=''",
    [actorId, tenantId, collection],
  );
  const draft = row.rows[0];
  if (!draft) return null;
  return { enabled: on(draft.enabled), allowRoots: on(draft.allow_roots), depthLimit: num(draft.depth_limit), baseVersion: num(draft.base_version) };
}

async function placementDraft(tx: Sql, tenantId: string, actorId: string, collection: string, recordId: string): Promise<PlacementDraftView | null> {
  const row = await tx.query<{ parent_id: string | null; base_version: number | string }>(
    "SELECT parent_id, base_version FROM hs_collection_hierarchy_drafts WHERE actor_id=$1 AND tenant_id=$2 AND kind='placement' AND collection=$3 AND record_key=$4",
    [actorId, tenantId, collection, recordId],
  );
  const draft = row.rows[0];
  return draft ? { parentId: draft.parent_id, baseVersion: num(draft.base_version) } : null;
}

async function lockLinks(tx: Sql, tenantId: string, collection: string) {
  await tx.query("SELECT record_id FROM hs_collection_hierarchy_links WHERE tenant_id=$1 AND collection=$2 FOR UPDATE", [tenantId, collection]);
}

async function loadNodes(tx: Sql, tenantId: string, collection: string) {
  const row = await tx.query<{ record_id: string; parent_id: string | null }>("SELECT record_id, parent_id FROM hs_collection_hierarchy_links WHERE tenant_id=$1 AND collection=$2", [tenantId, collection]);
  return row.rows.map(item => ({ id: item.record_id, parentId: item.parent_id }));
}

async function openRecord(tx: Sql, tenantId: string, recordId: string, actorId: string, required: CapabilityName) {
  if (!uuidPattern.test(recordId)) throw unavailable();
  const row = await tx.query<RecordRow>(
    `SELECT r.id, r.collection, r.name, r.state, r.version, r.field_values, r.parent_organisation_id,
      ${grant("r", "$3", "view")} AS can_view, ${grant("r", "$3", "edit")} AS can_edit, ${grant("r", "$3", "archive")} AS can_archive,
      ${grant("r", "$3", "delete")} AS can_delete, ${grant("r", "$3", "export")} AS can_export, ${grant("r", "$3", "history")} AS can_history
     FROM hs_data_records r WHERE r.id=$1 AND r.tenant_id=$2 AND r.merged_into_id IS NULL FOR UPDATE`,
    [recordId, tenantId, actorId],
  );
  const found = row.rows[0];
  if (!found || !on(found.can_view)) throw unavailable();
  const flags = { view: on(found.can_view), edit: on(found.can_edit), archive: on(found.can_archive), delete: on(found.can_delete), export: on(found.can_export), history: on(found.can_history) };
  if (!flags[required]) throw refused();
  return { ...found, version: num(found.version), flags };
}

async function linkVersion(tx: Sql, tenantId: string, recordId: string) {
  const row = await tx.query<{ version: number | string; parent_id: string | null }>("SELECT version, parent_id FROM hs_collection_hierarchy_links WHERE tenant_id=$1 AND record_id=$2", [tenantId, recordId]);
  return { version: row.rows[0] ? num(row.rows[0].version) : 0, parentId: row.rows[0]?.parent_id ?? null };
}

async function subtree(tx: Sql, tenantId: string, collection: string, recordId: string) {
  const nodes = await loadNodes(tx, tenantId, collection);
  if (!nodes.some(node => node.id === recordId)) nodes.push({ id: recordId, parentId: null });
  return subtreeIds(nodes, recordId);
}

type ReferenceKey = { recordId: string; kind: "reference" | "page"; sourceApp: string; sourceType: string; sourceId: string };

async function referenceKeys(tx: Sql, tenantId: string, ids: string[]) {
  if (!ids.length) return [] as ReferenceKey[];
  const refs = await tx.query<{ record_id: string; source_app: string; source_type: string; source_id: string }>(
    "SELECT record_id::text, source_app, source_type, source_id FROM hs_data_references WHERE tenant_id=$1 AND record_id = ANY($2::uuid[])",
    [tenantId, ids],
  );
  const docs = await tx.query<{ record_id: string; page_id: string | null }>(
    "SELECT record_id::text, page_id FROM hs_data_documents WHERE tenant_id=$1 AND record_id = ANY($2::uuid[])",
    [tenantId, ids],
  );
  return [
    ...refs.rows.map(item => ({ recordId: item.record_id, kind: "reference" as const, sourceApp: item.source_app, sourceType: item.source_type, sourceId: item.source_id })),
    ...docs.rows.flatMap(item => item.page_id ? [{ recordId: item.record_id, kind: "page" as const, sourceApp: "holy-sheet", sourceType: "page", sourceId: item.page_id }] : []),
  ].sort((a, b) => `${a.recordId}${a.kind}${a.sourceApp}${a.sourceType}${a.sourceId}`.localeCompare(`${b.recordId}${b.kind}${b.sourceApp}${b.sourceType}${b.sourceId}`));
}

async function visibleIds(tx: Sql, tenantId: string, actorId: string, ids: string[]) {
  if (!ids.length) return new Set<string>();
  const row = await tx.query<{ id: string }>(
    `SELECT r.id FROM hs_data_records r WHERE r.tenant_id=$1 AND r.id = ANY($2::uuid[]) AND r.state='active' AND r.merged_into_id IS NULL AND ${grant("r", "$3", "view")}`,
    [tenantId, ids, actorId],
  );
  return new Set(row.rows.map(item => item.id));
}

async function writeRecordEvent(tx: Sql, tenantId: string, actor: Actor, operationId: string, before: { id: string; collection: string; name: string; state: string; version: number; field_values: unknown; parent_organisation_id: string | null }, kind: string) {
  const next = await tx.query<{ version: number | string; state: string }>("SELECT version, state FROM hs_data_records WHERE tenant_id=$1 AND id=$2", [tenantId, before.id]);
  const saved = next.rows[0];
  const values = asRecord(before.field_values);
  const snap = (state: string) => JSON.stringify({ name: before.name, values, parentOrganisationId: before.parent_organisation_id, state });
  await tx.query(
    "INSERT INTO hs_data_events(id,tenant_id,record_id,record_version,actor_id,source_app,operation_id,kind,before_value,after_value,field_policy) VALUES($1,$2,$3,$4,$5,'holy-sheet',$6,$7,$8,$9,'{}')",
    [randomUUID(), tenantId, before.id, num(saved.version), actor.id, operationId, kind, snap(before.state), snap(saved.state)],
  );
  await tx.query(
    "INSERT INTO hs_data_change_events(id,tenant_id,record_id,record_version,collection,operation_id,source_app,actor_id,kind) VALUES($1,$2,$3,$4,$5,$6,'holy-sheet',$7,$8)",
    [randomUUID(), tenantId, before.id, num(saved.version), before.collection, operationId, actor.id, kind],
  );
}

async function hierarchyEvent(tx: Sql, tenantId: string, collection: string, recordId: string | null, action: string, parentId: string | null, actor: Actor, operationId: string) {
  await tx.query(
    "INSERT INTO hs_collection_hierarchy_events(id,tenant_id,collection,record_id,action,parent_id,actor_id,operation_id,source) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [randomUUID(), tenantId, collection, recordId, action, parentId, actor.id, operationId, source],
  );
}

export async function hierarchyCatalogue(r: Repository, actor: Actor, workspaceId: string) {
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    const manager = await isManager(tx, here, actor);
    const rows = await tx.query<{ id: string; name: string; core: boolean; enabled: boolean | null; allow_roots: boolean | null; depth_limit: number | null; version: number | null }>(
      `SELECT c.id, c.name, c.core, h.enabled, h.allow_roots, h.depth_limit, h.version
       FROM hs_data_collections c
       LEFT JOIN hs_data_collection_settings s ON s.tenant_id=c.tenant_id AND s.collection=c.id
       LEFT JOIN hs_collection_hierarchy h ON h.tenant_id=c.tenant_id AND h.collection=c.id
       WHERE c.tenant_id=$1 AND s.removed_at IS NULL
         AND (
           ($2::boolean AND c.core=false)
           OR (h.enabled=true AND (
             EXISTS(SELECT 1 FROM hs_data_collection_grants g WHERE g.tenant_id=c.tenant_id AND g.user_id=$3 AND g.collection=c.id AND 'view'=ANY(g.capabilities))
             OR EXISTS(SELECT 1 FROM hs_data_records rr JOIN hs_data_record_grants g ON g.tenant_id=rr.tenant_id AND g.record_id=rr.id WHERE rr.tenant_id=c.tenant_id AND rr.collection=c.id AND g.user_id=$3 AND 'view'=ANY(g.capabilities))
           ))
         )
       ORDER BY c.name, c.id`,
      [here.tenantId, manager, actor.id],
    );
    const configs: ConfigView[] = [];
    for (const row of rows.rows) {
      const eligible = !on(row.core);
      const config = presentConfig(row.version == null ? null : { collection: row.id, enabled: on(row.enabled), allow_roots: row.allow_roots ?? true, depth_limit: row.depth_limit ?? hierarchyLimits.depth, version: row.version }, row.name, eligible);
      config.collection = row.id;
      config.name = row.name;
      if (manager && eligible) config.recoverableDraft = await configDraft(tx, here.tenantId, actor.id, row.id);
      if (!manager && !config.enabled) continue;
      configs.push(config);
    }
    return { manage: manager, boundary: hierarchyBoundary, assignment: hierarchyAssignment, accountRelationship, configs };
  });
}

export async function saveHierarchyConfig(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; collection: string; expectedVersion: number; enabled: boolean; allowRoots: boolean; depthLimit: number }) {
  const collection = collectionKey(input.collection);
  const depthLimit = hierarchyDepthLimit(input.depthLimit);
  const requestHash = recordHash({ kind: "config", workspaceId, collection, expectedVersion: input.expectedVersion, enabled: input.enabled, allowRoots: input.allowRoots, depthLimit });
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    const replay = await prior<ConfigView & { grantsCreated: false }>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    await hold(tx, here.tenantId);
    await requireManager(tx, here, actor);
    const found = await loadCollection(tx, here.tenantId, collection);
    if (found.core) throw coreRejected();
    const current = await loadConfig(tx, here.tenantId, collection, true);
    if (num(current?.version ?? 0) !== input.expectedVersion) throw conflict();
    const depth = await tx.query<{ depth: number | string }>("SELECT hs_collection_hierarchy_max_depth($1,$2) AS depth", [here.tenantId, collection]);
    if (num(depth.rows[0]?.depth) > depthLimit) throw parentRejected();
    if (!input.allowRoots) {
      const roots = await tx.query("SELECT 1 FROM hs_collection_hierarchy_links WHERE tenant_id=$1 AND collection=$2 AND parent_id IS NULL LIMIT 1", [here.tenantId, collection]);
      if (roots.rows.length) throw rootsRejected();
    }
    const version = input.expectedVersion + 1;
    try {
      if (current) {
        await tx.query("UPDATE hs_collection_hierarchy SET enabled=$3, allow_roots=$4, depth_limit=$5, version=$6, updated_at=clock_timestamp() WHERE tenant_id=$1 AND collection=$2", [here.tenantId, collection, input.enabled, input.allowRoots, depthLimit, version]);
      } else {
        await tx.query("INSERT INTO hs_collection_hierarchy(tenant_id,collection,enabled,allow_roots,depth_limit,version,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)", [here.tenantId, collection, input.enabled, input.allowRoots, depthLimit, version, actor.id]);
      }
    } catch (error) { raise(error); }
    await tx.query(
      "INSERT INTO hs_collection_hierarchy_revisions(tenant_id,collection,version,enabled,allow_roots,depth_limit,actor_id,operation_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [here.tenantId, collection, version, input.enabled, input.allowRoots, depthLimit, actor.id, input.operationId],
    );
    await tx.query("DELETE FROM hs_collection_hierarchy_drafts WHERE actor_id=$1 AND tenant_id=$2 AND kind='config' AND collection=$3 AND record_key=''", [actor.id, here.tenantId, collection]);
    await hierarchyEvent(tx, here.tenantId, collection, null, "config", null, actor, input.operationId);
    await audit(tx, actor, "collection-hierarchy.config", input.operationId, collection, { workspaceId, collection, version, enabled: input.enabled });
    const result = { ...presentConfig({ collection, enabled: input.enabled, allow_roots: input.allowRoots, depth_limit: depthLimit, version }, found.name, true), grantsCreated: false as const };
    await remember(tx, actor.id, input.operationId, requestHash, result);
    return { ...result, replayed: false as const };
  });
}

export async function stashHierarchyConfig(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; collection: string; expectedVersion: number; enabled: boolean; allowRoots: boolean; depthLimit: number }) {
  const collection = collectionKey(input.collection);
  const depthLimit = hierarchyDepthLimit(input.depthLimit);
  const requestHash = recordHash({ kind: "stash-config", workspaceId, collection, expectedVersion: input.expectedVersion, enabled: input.enabled, allowRoots: input.allowRoots, depthLimit });
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    const replay = await prior<{ collection: string; version: number; recoverableDraft: ConfigDraftView }>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    await requireManager(tx, here, actor);
    const found = await loadCollection(tx, here.tenantId, collection);
    if (found.core) throw coreRejected();
    const current = await loadConfig(tx, here.tenantId, collection);
    if (num(current?.version ?? 0) !== input.expectedVersion) throw conflict();
    const draft = { enabled: input.enabled === true, allowRoots: input.allowRoots === true, depthLimit, baseVersion: input.expectedVersion };
    await tx.query(
      `INSERT INTO hs_collection_hierarchy_drafts(actor_id,tenant_id,kind,collection,record_key,base_version,enabled,allow_roots,depth_limit,operation_id)
       VALUES($1,$2,'config',$3,'',$4,$5,$6,$7,$8)
       ON CONFLICT (actor_id, tenant_id, kind, collection, record_key)
       DO UPDATE SET base_version=EXCLUDED.base_version, enabled=EXCLUDED.enabled, allow_roots=EXCLUDED.allow_roots, depth_limit=EXCLUDED.depth_limit, operation_id=EXCLUDED.operation_id, updated_at=clock_timestamp()`,
      [actor.id, here.tenantId, collection, input.expectedVersion, draft.enabled, draft.allowRoots, draft.depthLimit, input.operationId],
    );
    const result = { collection, version: input.expectedVersion, recoverableDraft: draft };
    await remember(tx, actor.id, input.operationId, requestHash, result);
    return { ...result, replayed: false as const };
  });
}

export async function stashHierarchyPlacement(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; collection: string; recordId: string; parentId: string | null; expectedVersion: number }) {
  const collection = collectionKey(input.collection);
  const requestHash = recordHash({ kind: "stash-placement", workspaceId, collection, recordId: input.recordId, parentId: input.parentId, expectedVersion: input.expectedVersion });
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    const replay = await prior<{ recordId: string; version: number; recoverableDraft: PlacementDraftView }>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    if (here.role === "observer") throw readOnly();
    const record = await openRecord(tx, here.tenantId, input.recordId, actor.id, "edit");
    if (record.collection !== collection) throw unavailable();
    if (record.version !== input.expectedVersion) throw conflict();
    if (!(await fieldAllows(tx, here.tenantId, collection, actor.id, "can_assign"))) throw refused();
    const parentId = input.parentId || null;
    if (parentId && !uuidPattern.test(parentId)) throw invalid();
    const draft = { parentId, baseVersion: input.expectedVersion };
    await tx.query(
      `INSERT INTO hs_collection_hierarchy_drafts(actor_id,tenant_id,kind,collection,record_key,base_version,parent_id,operation_id)
       VALUES($1,$2,'placement',$3,$4,$5,$6,$7)
       ON CONFLICT (actor_id, tenant_id, kind, collection, record_key)
       DO UPDATE SET base_version=EXCLUDED.base_version, parent_id=EXCLUDED.parent_id, operation_id=EXCLUDED.operation_id, updated_at=clock_timestamp()`,
      [actor.id, here.tenantId, collection, input.recordId, input.expectedVersion, parentId, input.operationId],
    );
    const result = { recordId: input.recordId, version: record.version, recoverableDraft: draft };
    await remember(tx, actor.id, input.operationId, requestHash, result);
    return { ...result, replayed: false as const };
  });
}

export async function discardHierarchyDraft(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; collection: string; kind: "config" | "placement"; recordId?: string | null }) {
  const collection = collectionKey(input.collection);
  const recordKey = input.kind === "placement" ? input.recordId ?? "" : "";
  const requestHash = recordHash({ kind: "discard", workspaceId, collection, draftKind: input.kind, recordKey });
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    const replay = await prior<{ discarded: true }>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    if (input.kind === "config") await requireManager(tx, here, actor);
    else if (here.role === "observer") throw readOnly();
    await tx.query("DELETE FROM hs_collection_hierarchy_drafts WHERE actor_id=$1 AND tenant_id=$2 AND kind=$3 AND collection=$4 AND record_key=$5", [actor.id, here.tenantId, input.kind, collection, recordKey]);
    const result = { discarded: true as const };
    await remember(tx, actor.id, input.operationId, requestHash, result);
    return { ...result, replayed: false as const };
  });
}

async function names(tx: Sql, tenantId: string, ids: string[]) {
  if (!ids.length) return new Map<string, string>();
  const row = await tx.query<{ id: string; name: string }>("SELECT id::text, name FROM hs_data_records WHERE tenant_id=$1 AND id = ANY($2::uuid[])", [tenantId, ids]);
  return new Map(row.rows.map(item => [item.id, item.name]));
}

export async function previewHierarchyImpact(r: Repository, actor: Actor, workspaceId: string, input: { collection: string; recordId: string; action: ActionName; parentId?: string | null }) {
  const collection = collectionKey(input.collection);
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    if (here.role === "observer") throw readOnly();
    const required: CapabilityName = input.action === "reparent" ? "edit" : input.action === "archive" ? "archive" : "delete";
    const record = await openRecord(tx, here.tenantId, input.recordId, actor.id, required);
    if (record.collection !== collection || record.state === "trashed") throw unavailable();
    if (input.action === "archive" && record.state !== "active") throw conflict();
    const config = await loadConfig(tx, here.tenantId, collection);
    if (!config || !on(config.enabled)) throw unavailable();
    if (input.action === "reparent" && !await fieldAllows(tx, here.tenantId, collection, actor.id, "can_assign")) throw refused();
    if (!await fieldAllows(tx, here.tenantId, collection, actor.id, "can_view")) throw unavailable();
    const parentId = input.action === "reparent" ? input.parentId || null : null;
    if (input.action === "reparent") {
      if (parentId && !uuidPattern.test(parentId)) throw invalid();
      const nodes = await loadNodes(tx, here.tenantId, collection);
      if (parentId) {
        const parent = await openRecord(tx, here.tenantId, parentId, actor.id, "view");
        if (parent.collection !== collection || parent.state !== "active") throw parentRejected();
        if (!nodes.some(node => node.id === parentId)) nodes.push({ id: parentId, parentId: null });
      }
      assertPlacement(nodes, record.id, parentId, num(config.depth_limit), on(config.allow_roots));
    }
    const ids = await subtree(tx, here.tenantId, collection, record.id);
    const keys = await referenceKeys(tx, here.tenantId, ids);
    const link = await linkVersion(tx, here.tenantId, record.id);
    const visible = await visibleIds(tx, here.tenantId, actor.id, ids);
    const labels = await names(tx, here.tenantId, [...visible]);
    const shownIds = ids.filter(id => visible.has(id)).slice(0, hierarchyLimits.preview);
    const subtreeMore = ids.filter(id => visible.has(id)).length > hierarchyLimits.preview;
    const references: { recordId: string; recordName: string; sourceApp: string; sourceType: string; sourceId: string }[] = [];
    let visibleReferenceCount = 0;
    for (const key of keys) {
      if (!visible.has(key.recordId)) continue;
      if (key.kind === "page") {
        try { await r.get(key.sourceId, actor, tx); } catch (error) { if (error instanceof DocumentError && error.status === 404) continue; throw error; }
      }
      visibleReferenceCount += 1;
      if (references.length < hierarchyLimits.preview) references.push({ recordId: key.recordId, recordName: labels.get(key.recordId) ?? record.name, sourceApp: key.sourceApp, sourceType: key.sourceType, sourceId: key.sourceId });
    }
    let parent: { id: string; name: string } | null = null;
    if (parentId && visible.has(parentId)) parent = { id: parentId, name: labels.get(parentId) ?? "" };
    else if (parentId) {
      const parentRecord = await openRecord(tx, here.tenantId, parentId, actor.id, "view");
      parent = { id: parentRecord.id, name: parentRecord.name };
    }
    const previewId = randomUUID();
    await tx.query(
      `INSERT INTO hs_collection_hierarchy_previews(id,tenant_id,actor_id,collection,action,record_id,parent_id,record_version,link_version,subtree_hash,reference_hash)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [previewId, here.tenantId, actor.id, collection, input.action, record.id, parentId, record.version, link.version, recordHash([...ids].sort()), recordHash(keys)],
    );
    return {
      previewId, action: input.action, review: hierarchyReview, version: record.version, linkVersion: link.version,
      record: { id: record.id, name: record.name }, parent, cascade: false, inheritsPermissions: false,
      subtree: shownIds.map(id => ({ id, name: labels.get(id) ?? "" })), subtreeMore,
      references, referencesMore: visibleReferenceCount > hierarchyLimits.preview,
    };
  });
}

export async function applyHierarchyImpact(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; previewId: string; expectedVersion: number }) {
  const requestHash = recordHash({ kind: "apply", workspaceId, previewId: input.previewId, expectedVersion: input.expectedVersion });
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    const replay = await prior<{ id: string; version: number; linkVersion: number; state: string; parentId: string | null; grantsCreated: false }>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    if (here.role === "observer") throw readOnly();
    if (!uuidPattern.test(input.previewId)) throw unavailable();
    await hold(tx, here.tenantId);
    const preview = await tx.query<{ collection: string; action: ActionName; record_id: string; parent_id: string | null; record_version: number | string; link_version: number | string; subtree_hash: string; reference_hash: string }>(
      "SELECT collection, action, record_id, parent_id, record_version, link_version, subtree_hash, reference_hash FROM hs_collection_hierarchy_previews WHERE id=$1 AND tenant_id=$2 AND actor_id=$3",
      [input.previewId, here.tenantId, actor.id],
    );
    const review = preview.rows[0];
    if (!review) throw conflict();
    await lockLinks(tx, here.tenantId, review.collection);
    const required: CapabilityName = review.action === "reparent" ? "edit" : review.action === "archive" ? "archive" : "delete";
    const record = await openRecord(tx, here.tenantId, review.record_id, actor.id, required);
    if (record.collection !== review.collection || record.version !== input.expectedVersion || record.version !== num(review.record_version)) throw conflict();
    const link = await linkVersion(tx, here.tenantId, record.id);
    if (link.version !== num(review.link_version)) throw conflict();
    const ids = await subtree(tx, here.tenantId, review.collection, record.id);
    const keys = await referenceKeys(tx, here.tenantId, ids);
    if (recordHash([...ids].sort()) !== review.subtree_hash || recordHash(keys) !== review.reference_hash) throw conflict();
    const config = await loadConfig(tx, here.tenantId, review.collection, true);
    if (!config || !on(config.enabled)) throw conflict();
    let parentId = link.parentId;
    if (review.action === "reparent") {
      if (!await fieldAllows(tx, here.tenantId, review.collection, actor.id, "can_assign")) throw refused();
      parentId = review.parent_id;
      const nodes = await loadNodes(tx, here.tenantId, review.collection);
      if (parentId) {
        const parent = await openRecord(tx, here.tenantId, parentId, actor.id, "view");
        if (parent.collection !== review.collection || parent.state !== "active") throw parentRejected();
        if (!nodes.some(node => node.id === parentId)) nodes.push({ id: parentId, parentId: null });
      }
      assertPlacement(nodes, record.id, parentId, num(config.depth_limit), on(config.allow_roots));
      const nextVersion = link.version + 1;
      try {
        if (link.version === 0) {
          await tx.query("INSERT INTO hs_collection_hierarchy_links(tenant_id,record_id,collection,parent_id,version) VALUES($1,$2,$3,$4,1)", [here.tenantId, record.id, review.collection, parentId]);
        } else {
          const updated = await tx.query("UPDATE hs_collection_hierarchy_links SET parent_id=$3, version=version+1 WHERE tenant_id=$1 AND record_id=$2 AND version=$4 RETURNING version", [here.tenantId, record.id, parentId, link.version]);
          if (!updated.rows.length) throw conflict();
        }
      } catch (error) { if (error instanceof DocumentError) throw error; raise(error); }
      await tx.query(
        "INSERT INTO hs_collection_hierarchy_link_revisions(tenant_id,record_id,version,collection,parent_id,action,actor_id,operation_id) VALUES($1,$2,$3,$4,$5,'reparent',$6,$7)",
        [here.tenantId, record.id, link.version === 0 ? 1 : nextVersion, review.collection, parentId, actor.id, input.operationId],
      );
    } else if (review.action === "archive") {
      if (record.state !== "active") throw conflict();
      await tx.query("UPDATE hs_data_records SET state='archived', version=version+1, updated_by=$3, updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 AND state='active'", [here.tenantId, record.id, actor.id]);
      await writeRecordEvent(tx, here.tenantId, actor, input.operationId, record, "archive");
    } else {
      if (record.state === "trashed") throw conflict();
      await tx.query(
        "UPDATE hs_data_records SET before_trash_state=state, state='trashed', deleted_at=statement_timestamp(), trash_deadline=statement_timestamp()+interval '30 days', deleted_by=$3, version=version+1, updated_by=$3, updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2 AND state<>'trashed'",
        [here.tenantId, record.id, actor.id],
      );
      await writeRecordEvent(tx, here.tenantId, actor, input.operationId, record, "trash");
    }
    await tx.query("DELETE FROM hs_collection_hierarchy_drafts WHERE actor_id=$1 AND tenant_id=$2 AND kind='placement' AND collection=$3 AND record_key=$4", [actor.id, here.tenantId, review.collection, record.id]);
    await hierarchyEvent(tx, here.tenantId, review.collection, record.id, review.action, review.action === "reparent" ? parentId : link.parentId, actor, input.operationId);
    await audit(tx, actor, `collection-hierarchy.${review.action}`, input.operationId, record.id, { workspaceId, collection: review.collection, recordId: record.id });
    const saved = await tx.query<{ version: number | string; state: string }>("SELECT version, state FROM hs_data_records WHERE tenant_id=$1 AND id=$2", [here.tenantId, record.id]);
    const placed = await linkVersion(tx, here.tenantId, record.id);
    const result = { id: record.id, version: num(saved.rows[0].version), linkVersion: placed.version, state: saved.rows[0].state, parentId: placed.parentId, grantsCreated: false as const };
    await remember(tx, actor.id, input.operationId, requestHash, result);
    return { ...result, replayed: false as const };
  });
}

async function anchor(tx: Sql, tenantId: string, actorId: string, afterId: string | null) {
  if (!afterId) return null;
  if (!uuidPattern.test(afterId)) throw invalid();
  const row = await tx.query<{ id: string; name_search: string }>(
    `SELECT r.id::text, r.name_search FROM hs_data_records r WHERE r.tenant_id=$1 AND r.id=$2 AND r.state='active' AND r.merged_into_id IS NULL AND ${grant("r", "$3", "view")}`,
    [tenantId, afterId, actorId],
  );
  if (!row.rows[0]) throw unavailable();
  return row.rows[0];
}

export async function hierarchyNodes(r: Repository, actor: Actor, workspaceId: string, input: { collection: string; view: "tree" | "list"; parentId?: string | null; afterId?: string | null }) {
  const collection = collectionKey(input.collection);
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    const found = await loadCollection(tx, here.tenantId, collection);
    const config = await loadConfig(tx, here.tenantId, collection);
    if (!config || !on(config.enabled) || !await canViewCollection(tx, here.tenantId, collection, actor.id)) throw unavailable();
    const fieldView = await fieldAllows(tx, here.tenantId, collection, actor.id, "can_view");
    if (input.view === "tree" && !fieldView) throw unavailable();
    const parentId = input.view === "tree" ? input.parentId || null : null;
    if (parentId) {
      const parent = await openRecord(tx, here.tenantId, parentId, actor.id, "view");
      if (parent.collection !== collection || parent.state !== "active") throw unavailable();
    }
    const cursor = await anchor(tx, here.tenantId, actor.id, input.afterId ?? null);
    const rows = await tx.query<{ id: string; name: string; version: number | string; parent_id: string | null; link_version: number | string | null }>(
      `SELECT r.id::text, r.name, r.version, l.parent_id::text, l.version AS link_version
       FROM hs_data_records r
       LEFT JOIN hs_collection_hierarchy_links l ON l.tenant_id=r.tenant_id AND l.record_id=r.id
       WHERE r.tenant_id=$1 AND r.collection=$2 AND r.state='active' AND r.merged_into_id IS NULL AND ${grant("r", "$3", "view")}
         AND ($4::uuid IS NULL OR ($4::uuid IS NOT NULL AND l.parent_id=$4))
         AND ($5::boolean OR $4::uuid IS NOT NULL OR l.parent_id IS NULL OR NOT EXISTS (
           SELECT 1 FROM hs_data_records p
           WHERE p.tenant_id=r.tenant_id AND p.id=l.parent_id AND p.state='active' AND p.merged_into_id IS NULL AND ${grant("p", "$3", "view")}
         ))
         AND ($6::text IS NULL OR (r.name_search, r.id) > ($6, $7::uuid))
       ORDER BY r.name_search COLLATE "C", r.id
       LIMIT 51`,
      [here.tenantId, collection, actor.id, input.view === "tree" ? parentId : null, input.view === "list", cursor?.name_search ?? null, cursor?.id ?? null],
    );
    const page = rows.rows.slice(0, hierarchyLimits.siblings);
    const childIds = page.map(item => item.id);
    const children = childIds.length && fieldView
      ? await tx.query<{ parent_id: string }>(
        `SELECT DISTINCT l.parent_id::text FROM hs_collection_hierarchy_links l
         JOIN hs_data_records child ON child.tenant_id=l.tenant_id AND child.id=l.record_id
         WHERE l.tenant_id=$1 AND l.parent_id = ANY($2::uuid[]) AND child.state='active' AND child.merged_into_id IS NULL AND ${grant("child", "$3", "view")}`,
        [here.tenantId, childIds, actor.id],
      )
      : { rows: [] as { parent_id: string }[] };
    const withChildren = new Set(children.rows.map(item => item.parent_id));
    const visibleParents = fieldView ? await visibleIds(tx, here.tenantId, actor.id, page.flatMap(item => item.parent_id ? [item.parent_id] : [])) : new Set<string>();
    return {
      collection: found.id,
      parentId,
      more: rows.rows.length > hierarchyLimits.siblings,
      entries: page.map(item => ({
        id: item.id,
        name: item.name,
        version: num(item.version),
        linkVersion: item.link_version == null ? 0 : num(item.link_version),
        parentId: item.parent_id && visibleParents.has(item.parent_id) ? item.parent_id : null,
        child: withChildren.has(item.id),
      })),
    };
  });
}

export async function searchHierarchy(r: Repository, actor: Actor, workspaceId: string, input: { collection: string; query: string }) {
  const collection = collectionKey(input.collection);
  const query = input.query.trim();
  if (!query || query.length > 200) throw invalid();
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await loadCollection(tx, here.tenantId, collection);
    const config = await loadConfig(tx, here.tenantId, collection);
    if (!config || !on(config.enabled) || !await canViewCollection(tx, here.tenantId, collection, actor.id)) throw unavailable();
    const fieldView = await fieldAllows(tx, here.tenantId, collection, actor.id, "can_view");
    const rows = await tx.query<{ id: string; name: string; parent_id: string | null }>(
      `SELECT r.id::text, r.name, l.parent_id::text
       FROM hs_data_records r
       LEFT JOIN hs_collection_hierarchy_links l ON l.tenant_id=r.tenant_id AND l.record_id=r.id
       WHERE r.tenant_id=$1 AND r.collection=$2 AND r.state='active' AND r.merged_into_id IS NULL AND ${grant("r", "$3", "view")}
         AND r.name_search LIKE $4 ESCAPE '\\'
       ORDER BY r.name_search COLLATE "C", r.id
       LIMIT 51`,
      [here.tenantId, collection, actor.id, likePattern(query)],
    );
    const page = rows.rows.slice(0, hierarchyLimits.siblings);
    const visibleParents = fieldView ? await visibleIds(tx, here.tenantId, actor.id, page.flatMap(item => item.parent_id ? [item.parent_id] : [])) : new Set<string>();
    return {
      more: rows.rows.length > hierarchyLimits.siblings,
      results: page.map(item => ({ id: item.id, name: item.name, parentId: item.parent_id && visibleParents.has(item.parent_id) ? item.parent_id : null })),
    };
  });
}

export async function hierarchyHistory(r: Repository, actor: Actor, workspaceId: string, input: { collection: string; recordId?: string | null }) {
  const collection = collectionKey(input.collection);
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    const config = await loadConfig(tx, here.tenantId, collection);
    if (!config || !(await loadCollection(tx, here.tenantId, collection))) throw unavailable();
    if (input.recordId) {
      const record = await openRecord(tx, here.tenantId, input.recordId, actor.id, "history");
      if (record.collection !== collection) throw unavailable();
      if (!await fieldAllows(tx, here.tenantId, collection, actor.id, "can_history")) throw unavailable();
      const rows = await tx.query<{ action: string; parent_id: string | null; operation_id: string; source: string; created_at: string; actor_name: string }>(
        `SELECT e.action, e.parent_id::text, e.operation_id::text, e.source, e.created_at, u.name AS actor_name
         FROM hs_collection_hierarchy_events e JOIN hs_users u ON u.id=e.actor_id
         WHERE e.tenant_id=$1 AND e.record_id=$2 ORDER BY e.created_at, e.id`,
        [here.tenantId, input.recordId],
      );
      const parentIds = rows.rows.flatMap(item => item.parent_id ? [item.parent_id] : []);
      const visibleParents = await visibleIds(tx, here.tenantId, actor.id, parentIds);
      return {
        events: rows.rows.map(item => ({
          action: item.action, actorName: item.actor_name, atIst: formatIst(item.created_at), source: item.source, operationId: item.operation_id,
          parentId: item.parent_id && visibleParents.has(item.parent_id) ? item.parent_id : null,
        })),
      };
    }
    await requireManager(tx, here, actor);
    const rows = await tx.query<{ action: string; operation_id: string; source: string; created_at: string; actor_name: string }>(
      `SELECT e.action, e.operation_id::text, e.source, e.created_at, u.name AS actor_name
       FROM hs_collection_hierarchy_events e JOIN hs_users u ON u.id=e.actor_id
       WHERE e.tenant_id=$1 AND e.collection=$2 AND e.record_id IS NULL ORDER BY e.created_at, e.id`,
      [here.tenantId, collection],
    );
    return { events: rows.rows.map(item => ({ action: item.action, actorName: item.actor_name, atIst: formatIst(item.created_at), source: item.source, operationId: item.operation_id })) };
  });
}

export async function downloadHierarchy(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; collection: string }) {
  const collection = collectionKey(input.collection);
  const requestHash = recordHash({ kind: "download", workspaceId, collection });
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    const replay = await prior<{ body: string }>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    const found = await loadCollection(tx, here.tenantId, collection);
    const config = await loadConfig(tx, here.tenantId, collection);
    if (!config || !on(config.enabled)) throw unavailable();
    const allowed = await tx.query<{ id: string }>(
      `SELECT r.id FROM hs_data_records r WHERE r.tenant_id=$1 AND r.collection=$2 AND r.state='active' AND r.merged_into_id IS NULL AND ${grant("r", "$3", "export")} LIMIT 1`,
      [here.tenantId, collection, actor.id],
    );
    if (!allowed.rows.length) throw refused();
    const fieldView = await fieldAllows(tx, here.tenantId, collection, actor.id, "can_view");
    const rows = await tx.query<{ id: string; name: string; parent_id: string | null }>(
      `SELECT r.id::text, r.name, l.parent_id::text
       FROM hs_data_records r
       LEFT JOIN hs_collection_hierarchy_links l ON l.tenant_id=r.tenant_id AND l.record_id=r.id
       WHERE r.tenant_id=$1 AND r.collection=$2 AND r.state='active' AND r.merged_into_id IS NULL AND ${grant("r", "$3", "view")} AND ${grant("r", "$3", "export")}
       ORDER BY r.name_search COLLATE "C", r.id
       LIMIT 501`,
      [here.tenantId, collection, actor.id],
    );
    const page = rows.rows.slice(0, 500);
    const visibleParents = fieldView ? await visibleIds(tx, here.tenantId, actor.id, page.flatMap(item => item.parent_id ? [item.parent_id] : [])) : new Set<string>();
    const labels = await names(tx, here.tenantId, [...visibleParents]);
    const lines = hierarchyDocument(found.name, page.map(item => ({
      name: item.name,
      parentName: item.parent_id && visibleParents.has(item.parent_id) ? labels.get(item.parent_id) ?? null : null,
    })));
    const body = rows.rows.length > 500 ? `${lines}\n\nMore visible records are available in the tree.` : lines;
    await audit(tx, actor, "collection-hierarchy.download", input.operationId, collection, { workspaceId, collection });
    const result = { body };
    await remember(tx, actor.id, input.operationId, requestHash, result);
    return { ...result, replayed: false as const };
  });
}

export async function grantHierarchyManager(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; userId: string }) {
  const requestHash = recordHash({ kind: "grant-manager", workspaceId, userId: input.userId });
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    const replay = await prior<{ userId: string; grantsCreated: false }>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    await requireManager(tx, here, actor, true);
    const member = await activeMember(tx, here.workspaceId, input.userId);
    if (!member || member.role === "observer") throw unavailable();
    await tx.query(
      "INSERT INTO hs_collection_hierarchy_managers(workspace_id,user_id,granted_by) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
      [here.workspaceId, input.userId, actor.id],
    );
    await audit(tx, actor, "collection-hierarchy.grant-manager", input.operationId, input.userId, { workspaceId });
    const result = { userId: input.userId, grantsCreated: false as const };
    await remember(tx, actor.id, input.operationId, requestHash, result);
    return { ...result, replayed: false as const };
  });
}

export async function revokeHierarchyManager(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; userId: string }) {
  const requestHash = recordHash({ kind: "revoke-manager", workspaceId, userId: input.userId });
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    const replay = await prior<{ userId: string }>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    await requireManager(tx, here, actor, true);
    await tx.query("DELETE FROM hs_collection_hierarchy_managers WHERE workspace_id=$1 AND user_id=$2", [here.workspaceId, input.userId]);
    await audit(tx, actor, "collection-hierarchy.revoke-manager", input.operationId, input.userId, { workspaceId });
    const result = { userId: input.userId };
    await remember(tx, actor.id, input.operationId, requestHash, result);
    return { ...result, replayed: false as const };
  });
}

export async function saveHierarchyFieldPolicy(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; collection: string; sensitive: boolean; expectedVersion: number; access: { userId: string; canView: boolean; canAssign: boolean; canHistory: boolean }[] }) {
  const collection = collectionKey(input.collection);
  const requestHash = recordHash({ kind: "field-policy", workspaceId, collection, sensitive: input.sensitive, expectedVersion: input.expectedVersion, access: input.access });
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    const replay = await prior<{ collection: string; version: number; grantsCreated: false }>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    await requireManager(tx, here, actor);
    const found = await loadCollection(tx, here.tenantId, collection);
    if (found.core) throw coreRejected();
    const current = await tx.query<{ version: number | string }>("SELECT version FROM hs_collection_hierarchy_field_policy WHERE tenant_id=$1 AND collection=$2 FOR UPDATE", [here.tenantId, collection]);
    if (num(current.rows[0]?.version ?? 0) !== input.expectedVersion) throw conflict();
    const version = input.expectedVersion + 1;
    if (current.rows[0]) await tx.query("UPDATE hs_collection_hierarchy_field_policy SET sensitive=$3, version=$4 WHERE tenant_id=$1 AND collection=$2", [here.tenantId, collection, input.sensitive, version]);
    else await tx.query("INSERT INTO hs_collection_hierarchy_field_policy(tenant_id,collection,sensitive,version) VALUES($1,$2,$3,$4)", [here.tenantId, collection, input.sensitive, version]);
    await tx.query("DELETE FROM hs_collection_hierarchy_field_access WHERE tenant_id=$1 AND collection=$2", [here.tenantId, collection]);
    for (const entry of input.access) {
      const member = await activeMember(tx, here.workspaceId, entry.userId);
      if (!member) throw unavailable();
      await tx.query(
        "INSERT INTO hs_collection_hierarchy_field_access(tenant_id,collection,user_id,can_view,can_assign,can_history) VALUES($1,$2,$3,$4,$5,$6)",
        [here.tenantId, collection, entry.userId, entry.canView, entry.canAssign, entry.canHistory],
      );
    }
    await audit(tx, actor, "collection-hierarchy.field-policy", input.operationId, collection, { workspaceId, collection, version, sensitive: input.sensitive });
    const result = { collection, version, grantsCreated: false as const };
    await remember(tx, actor.id, input.operationId, requestHash, result);
    return { ...result, replayed: false as const };
  });
}

export async function readHierarchyRecord(r: Repository, actor: Actor, workspaceId: string, collection: string, recordId: string) {
  const key = collectionKey(collection);
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    const record = await openRecord(tx, here.tenantId, recordId, actor.id, "view");
    if (record.collection !== key) throw unavailable();
    const link = await linkVersion(tx, here.tenantId, record.id);
    const fieldView = await fieldAllows(tx, here.tenantId, key, actor.id, "can_view");
    let parent: { id: string; name: string } | null = null;
    if (fieldView && link.parentId) {
      const visible = await visibleIds(tx, here.tenantId, actor.id, [link.parentId]);
      if (visible.has(link.parentId)) {
        const labels = await names(tx, here.tenantId, [link.parentId]);
        parent = { id: link.parentId, name: labels.get(link.parentId) ?? "" };
      }
    }
    const draft = record.flags.edit ? await placementDraft(tx, here.tenantId, actor.id, key, record.id) : null;
    return {
      id: record.id, name: record.name, version: record.version, linkVersion: link.version, state: record.state, parent,
      canEdit: record.flags.edit, canArchive: record.flags.archive, canDelete: record.flags.delete, canExport: record.flags.export, canHistory: record.flags.history,
      recoverableDraft: draft,
    };
  });
}
