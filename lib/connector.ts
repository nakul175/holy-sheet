import { randomUUID } from "node:crypto";
import type { Actor } from "./auth";
import type { Sql } from "./database";
import { DocumentError } from "./document";
import {
  assertMappedItems,
  compileConnector,
  compileSyncItems,
  connectorActivation,
  connectorActorActions,
  connectorAssignment,
  connectorBoundary,
  connectorCanonical,
  connectorDelegation,
  connectorEdge,
  connectorInventory,
  connectorName,
  connectorQuery,
  connectorRecoverable,
  connectorReport,
  connectorSchedules,
  connectorSecrets,
  connectorSharing,
  connectorSource,
  effectiveRights,
  nextConnectorStatus,
  planMerge,
  planSyncBatch,
  publicConnector,
  redactConnector,
  storedDefinition,
  type ConnectorActorAction,
  type ConnectorDefinition,
  type ConnectorStatus,
  type LedgerRow,
  type SyncIncoming,
} from "./connector-plan";
import { formatIst } from "./ist-label";
import type { Repository } from "./repository";
import { recordHash } from "./shared-record-types";

const unavailable = () => new DocumentError("Connectors are restricted or unavailable.", "not_found", 404);
const forbidden = () => new DocumentError("This action is not permitted.", "action_forbidden", 403);
const mismatch = () => new DocumentError("This attempt was reused with different fields.", "operation_mismatch", 409);
const conflictMessage = "The connector version changed. The draft is kept.";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const appPattern = /^app:[a-z][a-z0-9-]{0,40}$/;

type Scope = { workspaceId: string; tenantId: string; role: string };
type ConnectorRow = {
  id: string;
  name: string;
  status: ConnectorStatus;
  sharing: string;
  version: number | string;
  cache_generation: number | string;
  definition: unknown;
  secret_ref: string | null;
  created_by: string;
};
type RecordAccess = {
  id: string;
  collection: string;
  name: string;
  version: number;
  values: Record<string, unknown>;
  view: boolean;
  edit: boolean;
  export: boolean;
  history: boolean;
};
type Outcome = { conflict?: boolean; failed?: boolean; message?: string; code?: string };
type SyncInput = {
  operationId: string;
  connectorId: string;
  expectedVersion: number;
  mode: "initial" | "incremental";
  checkpoint: string | null;
  items: unknown;
  failed?: boolean;
};

const copy = () => ({
  boundary: connectorBoundary,
  assignment: connectorAssignment,
  secrets: connectorSecrets,
  delegation: connectorDelegation,
  activation: connectorActivation,
  schedules: connectorSchedules,
  recoverable: connectorRecoverable,
  edge: connectorEdge,
  canonical: connectorCanonical,
  sharing: connectorSharing,
  accessGranted: false as const,
  credentialsStored: false as const,
  liveActivation: false as const,
  connectionAuthorised: false as const,
    secretVisible: false as const,
    secretStore: "suite-secret-store" as const,
    activated: false as const,
});

function settle<T extends object>(result: T): T {
  const value = result as T & Outcome;
  if (value.failed) throw new DocumentError(value.message ?? "Check the connector.", value.code ?? "connector_validation", 409);
  if (value.conflict) throw new DocumentError(conflictMessage, "connector_conflict", 409);
  return result;
}
function on(value: unknown) { return value === true || value === "t" || value === "true" || value === 1; }
function num(value: number | string | null | undefined) { return Number(value ?? 0); }
function asJson<T>(value: unknown): T { return (typeof value === "string" ? JSON.parse(value) : value) as T; }
function flags(extra: Record<string, unknown> = {}) {
  return {
    sharing: connectorSharing, accessGranted: false as const, credentialsStored: false as const, liveActivation: false as const,
    connectionAuthorised: false as const, secretVisible: false as const, secretStore: "suite-secret-store" as const,
    canonicalPreserved: true as const, canonicalWrites: false as const, cache: "no-store" as const, schedulesPaused: true as const, ...extra,
  };
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
async function hold(tx: Sql, tenantId: string) {
  await tx.query("SELECT id FROM hs_data_tenants WHERE id=$1 FOR UPDATE", [tenantId]);
}
async function isManager(tx: Sql, here: Scope, actor: Actor) {
  if (here.role === "owner" || here.role === "admin") return true;
  if (here.role === "observer") return false;
  const row = await tx.query("SELECT 1 FROM hs_connector_managers WHERE workspace_id=$1 AND user_id=$2", [here.workspaceId, actor.id]);
  return row.rows.length > 0;
}
async function requireManager(tx: Sql, here: Scope, actor: Actor) {
  if (!await isManager(tx, here, actor)) throw unavailable();
}
async function actionAllowed(tx: Sql, tenantId: string, userId: string, action: ConnectorActorAction, manager: boolean) {
  const rows = await tx.query<{ action: string }>("SELECT action FROM hs_connector_actor_actions WHERE tenant_id=$1 AND user_id=$2", [tenantId, userId]);
  if (!rows.rows.length) return manager;
  return rows.rows.some(row => row.action === action);
}
async function prior<T extends object>(tx: Sql, actorId: string, operationId: string, requestHash: string): Promise<(T & { replayed: true }) | null> {
  const row = await tx.query<{ request_hash: string; result: unknown }>("SELECT request_hash, result FROM hs_connector_operations WHERE actor_id=$1 AND operation_id=$2", [actorId, operationId]);
  if (!row.rows[0]) return null;
  if (row.rows[0].request_hash !== requestHash) throw mismatch();
  return { ...asJson<T>(row.rows[0].result), replayed: true };
}
async function remember<T extends object>(tx: Sql, actorId: string, operationId: string, requestHash: string, result: T) {
  const stored = redactConnector({ ...result, replayed: false as const });
  await tx.query("INSERT INTO hs_connector_operations(actor_id,operation_id,request_hash,result) VALUES($1,$2,$3,$4::jsonb)", [actorId, operationId, requestHash, JSON.stringify(stored)]);
  return stored;
}
async function audit(tx: Sql, actor: Actor, action: string, operationId: string, connectorId: string, after: Record<string, unknown>) {
  const body = redactConnector({ source: connectorSource, operationId, atIst: formatIst(new Date()), ...flags(after) });
  await tx.query(
    "INSERT INTO hs_audit(id,actor_id,action,page_id,subject_id,after_value,correlation_id) VALUES($1,$2,$3,NULL,$4,$5::jsonb,$6)",
    [randomUUID(), actor.id, action, connectorId, JSON.stringify(body), operationId],
  );
}
async function track(tx: Sql, tenantId: string, connectorId: string, actor: Actor, action: string, operationId: string, cacheGeneration: number, detail: Record<string, unknown>) {
  await tx.query(
    "INSERT INTO hs_connector_events(id,tenant_id,connector_id,action,actor_id,operation_id,source,cache_generation,detail) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)",
    [randomUUID(), tenantId, connectorId, action, actor.id, operationId, connectorSource, cacheGeneration, JSON.stringify(redactConnector(flags(detail)))],
  );
}
async function saveDraft(tx: Sql, tenantId: string, actorId: string, connectorKey: string, kind: string, baseVersion: number, payload: Record<string, unknown>, operationId: string) {
  const body = redactConnector(payload);
  await tx.query(
    `INSERT INTO hs_connector_drafts(tenant_id,actor_id,connector_key,kind,base_version,payload,operation_id)
     VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)
     ON CONFLICT (tenant_id, actor_id, connector_key, kind)
     DO UPDATE SET base_version=$5, payload=$6::jsonb, operation_id=$7, updated_at=clock_timestamp()`,
    [tenantId, actorId, connectorKey, kind, baseVersion, JSON.stringify(body), operationId],
  );
}
function definitionOf(row: ConnectorRow) {
  const stored = asJson<Record<string, unknown>>(row.definition);
  return compileConnector({ ...stored, secretRef: row.secret_ref });
}
function present(row: ConnectorRow, definition: ConnectorDefinition, replayed = false) {
  return {
    ...flags(),
    ...publicConnector(definition),
    id: row.id,
    name: row.name,
    status: row.status,
    version: num(row.version),
    cacheGeneration: num(row.cache_generation),
    dryRun: true as const,
    replayed,
  };
}
async function loadConnector(tx: Sql, tenantId: string, connectorId: string) {
  if (!uuidPattern.test(connectorId)) throw unavailable();
  const row = await tx.query<ConnectorRow>(
    "SELECT id, name, status, sharing, version, cache_generation, definition, secret_ref, created_by FROM hs_connectors WHERE id=$1 AND tenant_id=$2",
    [connectorId, tenantId],
  );
  if (!row.rows[0] || row.rows[0].sharing !== "off") throw unavailable();
  return row.rows[0];
}
async function revise(tx: Sql, row: ConnectorRow, actor: Actor, operationId: string, action: string) {
  await tx.query(
    "INSERT INTO hs_connector_revisions(connector_id,version,status,name,definition,cache_generation,action,actor_id,operation_id) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9)",
    [row.id, num(row.version), row.status, row.name, JSON.stringify(storedDefinition(definitionOf(row))), num(row.cache_generation), action, actor.id, operationId],
  );
}
async function fieldDecision(tx: Sql, tenantId: string, collection: string, key: string, userId: string, mode: "view" | "write" | "history") {
  const policy = await tx.query<{ sensitive: boolean }>("SELECT sensitive FROM hs_data_fields WHERE tenant_id=$1 AND collection=$2 AND field_key=$3", [tenantId, collection, key]);
  if (!policy.rows[0]) return true;
  const explicit = await tx.query("SELECT 1 FROM hs_data_field_permissions WHERE tenant_id=$1 AND collection=$2 AND field_key=$3 LIMIT 1", [tenantId, collection, key]);
  if (!on(policy.rows[0].sensitive) && !explicit.rows.length) return true;
  const access = await tx.query<{ can_view: boolean; can_write: boolean; can_history: boolean }>(
    "SELECT can_view, can_write, can_history FROM hs_data_field_permissions WHERE tenant_id=$1 AND collection=$2 AND field_key=$3 AND user_id=$4",
    [tenantId, collection, key, userId],
  );
  const row = access.rows[0];
  if (!row) return false;
  if (mode === "write") return on(row.can_write);
  if (mode === "history") return on(row.can_history);
  return on(row.can_view);
}
async function recordAccess(tx: Sql, tenantId: string, recordId: string, userId: string): Promise<RecordAccess | null> {
  if (!uuidPattern.test(recordId)) return null;
  const row = await tx.query<{ collection: string; name: string; version: number | string; field_values: unknown; view: boolean; edit: boolean; export: boolean; history: boolean }>(
    `SELECT r.collection, r.name, r.version, r.field_values,
       (EXISTS (SELECT 1 FROM hs_data_collection_grants g WHERE g.tenant_id=r.tenant_id AND g.user_id=$3 AND g.collection=r.collection AND 'view'=ANY(g.capabilities))
        OR EXISTS (SELECT 1 FROM hs_data_record_grants rg WHERE rg.tenant_id=r.tenant_id AND rg.record_id=r.id AND rg.user_id=$3 AND 'view'=ANY(rg.capabilities))) AS view,
       (EXISTS (SELECT 1 FROM hs_data_collection_grants g WHERE g.tenant_id=r.tenant_id AND g.user_id=$3 AND g.collection=r.collection AND 'edit'=ANY(g.capabilities))
        OR EXISTS (SELECT 1 FROM hs_data_record_grants rg WHERE rg.tenant_id=r.tenant_id AND rg.record_id=r.id AND rg.user_id=$3 AND 'edit'=ANY(rg.capabilities))) AS edit,
       (EXISTS (SELECT 1 FROM hs_data_collection_grants g WHERE g.tenant_id=r.tenant_id AND g.user_id=$3 AND g.collection=r.collection AND 'export'=ANY(g.capabilities))
        OR EXISTS (SELECT 1 FROM hs_data_record_grants rg WHERE rg.tenant_id=r.tenant_id AND rg.record_id=r.id AND rg.user_id=$3 AND 'export'=ANY(rg.capabilities))) AS export,
       (EXISTS (SELECT 1 FROM hs_data_collection_grants g WHERE g.tenant_id=r.tenant_id AND g.user_id=$3 AND g.collection=r.collection AND 'history'=ANY(g.capabilities))
        OR EXISTS (SELECT 1 FROM hs_data_record_grants rg WHERE rg.tenant_id=r.tenant_id AND rg.record_id=r.id AND rg.user_id=$3 AND 'history'=ANY(rg.capabilities))) AS history
     FROM hs_data_records r
     WHERE r.id=$1 AND r.tenant_id=$2 AND r.state='active'`,
    [recordId, tenantId, userId],
  );
  const found = row.rows[0];
  if (!found) return null;
  return {
    id: recordId, collection: found.collection, name: found.name, version: num(found.version), values: asJson<Record<string, unknown>>(found.field_values ?? {}),
    view: on(found.view), edit: on(found.edit), export: on(found.export), history: on(found.history),
  };
}
async function requireScope(tx: Sql, tenantId: string, actor: Actor, definition: ConnectorDefinition) {
  const collection = await tx.query("SELECT 1 FROM hs_data_collections WHERE tenant_id=$1 AND id=$2 AND deprecated=false", [tenantId, definition.scope.collection]);
  if (!collection.rows.length) throw unavailable();
  for (const recordId of definition.scope.recordIds) {
    const record = await recordAccess(tx, tenantId, recordId, actor.id);
    if (!record || record.collection !== definition.scope.collection || !record.view) throw unavailable();
  }
}
async function liveRights(tx: Sql, tenantId: string, actorId: string, definition: ConnectorDefinition, field: string) {
  const record = definition.scope.recordIds[0];
  const access = record ? await recordAccess(tx, tenantId, record, actorId) : null;
  const view = Boolean(access?.view) && await fieldDecision(tx, tenantId, definition.scope.collection, field, actorId, "view");
  const write = Boolean(access?.edit) && await fieldDecision(tx, tenantId, definition.scope.collection, field, actorId, "write");
  const history = Boolean(access?.history) && await fieldDecision(tx, tenantId, definition.scope.collection, field, actorId, "history");
  return { view, write, history };
}
async function conflictCount(tx: Sql, connectorId: string) {
  const row = await tx.query<{ n: number | string }>("SELECT count(*)::int AS n FROM hs_connector_sync_items WHERE connector_id=$1 AND state='conflict'", [connectorId]);
  return num(row.rows[0]?.n);
}
async function visibleLines(tx: Sql, tenantId: string, actorId: string, definition: ConnectorDefinition) {
  const lines: string[] = [];
  for (const stable of definition.stableIds) {
    const record = await recordAccess(tx, tenantId, stable.recordId, actorId);
    if (!record || record.collection !== definition.scope.collection || !record.view) continue;
    lines.push(`## ${record.name}`);
    for (const mapping of definition.mappings) {
      if (!await fieldDecision(tx, tenantId, record.collection, mapping.field, actorId, "view")) continue;
      const value = record.values[mapping.field];
      if (typeof value === "string") lines.push(`${mapping.externalField}: ${value}`);
    }
  }
  return lines;
}
async function canSeeConnector(tx: Sql, tenantId: string, actorId: string, definition: ConnectorDefinition) {
  for (const recordId of definition.scope.recordIds) {
    const record = await recordAccess(tx, tenantId, recordId, actorId);
    if (record && record.collection === definition.scope.collection && record.view) return true;
  }
  return false;
}

async function writeConnector(tx: Sql, here: Scope, actor: Actor, operationId: string, action: string, connectorId: string, expectedVersion: number, patch: { status?: ConnectorStatus; name?: string; definition?: ConnectorDefinition }) {
  const current = await loadConnector(tx, here.tenantId, connectorId);
  const definition = patch.definition ?? definitionOf(current);
  if (num(current.version) !== expectedVersion) {
    await saveDraft(tx, here.tenantId, actor.id, connectorId, action === "delegate" ? "delegate" : "configure", expectedVersion, { name: patch.name ?? current.name, definition: storedDefinition(definition) }, operationId);
    return { conflict: true as const, version: num(current.version) };
  }
  if (current.status === "disconnected" && action !== "preview" && action !== "disconnect") {
    await saveDraft(tx, here.tenantId, actor.id, connectorId, "configure", expectedVersion, { name: current.name, definition: storedDefinition(definition), rejected: action }, operationId);
    return { failed: true as const, code: "connector_disconnected", message: "This connector is disconnected. Canonical data is unchanged." };
  }
  const status = patch.status ?? current.status;
  const name = patch.name ?? current.name;
  const updated = await tx.query<ConnectorRow>(
    `UPDATE hs_connectors SET status=$2, name=$3, connector_type=$4, definition=$5::jsonb, secret_ref=$6, version=version+1, cache_generation=cache_generation+1, updated_at=clock_timestamp()
     WHERE id=$1 AND tenant_id=$7 AND version=$8
     RETURNING id, name, status, sharing, version, cache_generation, definition, secret_ref, created_by`,
    [connectorId, status, name, definition.type, JSON.stringify(storedDefinition(definition)), definition.secretRef, here.tenantId, expectedVersion],
  );
  const row = updated.rows[0];
  if (!row) return { conflict: true as const, version: num(current.version) };
  await revise(tx, row, actor, operationId, action);
  await audit(tx, actor, `governed-connector.${action}`, operationId, row.id, { status: row.status, cacheGeneration: num(row.cache_generation), version: num(row.version) });
  await track(tx, here.tenantId, row.id, actor, action, operationId, num(row.cache_generation), { status: row.status, version: num(row.version) });
  return present(row, definitionOf(row));
}

export async function connectorCatalogue(r: Repository, actor: Actor, workspaceId: string) {
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    const manage = await isManager(tx, here, actor);
    const allowed = await actionAllowed(tx, here.tenantId, actor.id, "search", manage);
    const rows = await tx.query<ConnectorRow>("SELECT id, name, status, sharing, version, cache_generation, definition, secret_ref, created_by FROM hs_connectors WHERE tenant_id=$1 ORDER BY name_search, id", [here.tenantId]);
    const connectors = [];
    for (const row of rows.rows) {
      const definition = definitionOf(row);
      if (!manage && (!allowed || !await canSeeConnector(tx, here.tenantId, actor.id, definition))) continue;
      const inventory = connectorInventory(row.status, await conflictCount(tx, row.id));
      connectors.push({
        id: row.id, name: row.name, status: row.status, version: num(row.version), cacheGeneration: num(row.cache_generation),
        type: definition.type, direction: definition.direction, source: definition.scope.source, sharing: connectorSharing,
        accessGranted: false as const, ...inventory,
      });
    }
    const drafts = await tx.query<{ connector_key: string; kind: string; base_version: number | string; payload: unknown }>(
      "SELECT connector_key, kind, base_version, payload FROM hs_connector_drafts WHERE tenant_id=$1 AND actor_id=$2 ORDER BY connector_key, kind",
      [here.tenantId, actor.id],
    );
    return {
      ...copy(),
      actorId: actor.id,
      manage,
      connectors,
      inventory: { residency: "tenant" as const, schedulesPaused: true as const, liveActivation: false as const, secretVisible: false as const },
      drafts: drafts.rows.map(draft => ({ connectorKey: draft.connector_key, kind: draft.kind, baseVersion: num(draft.base_version), payload: redactConnector(asJson(draft.payload)) })),
    };
  });
}

export async function readConnector(r: Repository, actor: Actor, workspaceId: string, connectorId: string) {
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    const row = await loadConnector(tx, here.tenantId, connectorId);
    const definition = definitionOf(row);
    const manage = await isManager(tx, here, actor);
    if (!manage && (!await actionAllowed(tx, here.tenantId, actor.id, "search", false) || !await canSeeConnector(tx, here.tenantId, actor.id, definition))) throw unavailable();
    return { ...present(row, definition), inventory: connectorInventory(row.status, await conflictCount(tx, row.id)) };
  });
}

export async function searchConnectors(r: Repository, actor: Actor, workspaceId: string, query: string) {
  const needle = connectorQuery(query);
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    const manage = await isManager(tx, here, actor);
    if (!await actionAllowed(tx, here.tenantId, actor.id, "search", manage)) throw forbidden();
    const rows = await tx.query<ConnectorRow>("SELECT id, name, status, sharing, version, cache_generation, definition, secret_ref, created_by FROM hs_connectors WHERE tenant_id=$1 ORDER BY name_search, id", [here.tenantId]);
    const results = [];
    for (const row of rows.rows) {
      const definition = definitionOf(row);
      if (!manage && !await canSeeConnector(tx, here.tenantId, actor.id, definition)) continue;
      const lines = await visibleLines(tx, here.tenantId, actor.id, definition);
      const hay = [row.name, row.status, definition.scope.source, definition.direction, ...lines].join("\n").toLocaleLowerCase();
      if (!hay.includes(needle)) continue;
      results.push({ id: row.id, name: row.name, status: row.status, sharing: connectorSharing, accessGranted: false as const, secretVisible: false as const });
    }
    return { results, ...flags({ assignment: connectorAssignment }) };
  });
}

export async function connectorHistory(r: Repository, actor: Actor, workspaceId: string, connectorId: string) {
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    const row = await loadConnector(tx, here.tenantId, connectorId);
    const definition = definitionOf(row);
    const manage = await isManager(tx, here, actor);
    if (!manage && !await canSeeConnector(tx, here.tenantId, actor.id, definition)) throw unavailable();
    if (!await actionAllowed(tx, here.tenantId, actor.id, "history", manage)) throw forbidden();
    const records = [];
    for (const recordId of definition.scope.recordIds) {
      const record = await recordAccess(tx, here.tenantId, recordId, actor.id);
      if (record && record.view) records.push(record);
    }
    if (records.length && records.every(record => !record.history)) throw forbidden();
    for (const mapping of definition.mappings) {
      const sensitive = await tx.query("SELECT 1 FROM hs_data_fields WHERE tenant_id=$1 AND collection=$2 AND field_key=$3 AND sensitive=true", [here.tenantId, definition.scope.collection, mapping.field]);
      if (sensitive.rows.length && !await fieldDecision(tx, here.tenantId, definition.scope.collection, mapping.field, actor.id, "history")) throw forbidden();
    }
    const events = await tx.query<{ action: string; actor_id: string; actor_name: string; operation_id: string; source: string; cache_generation: number | string; created_at: string | Date }>(
      `SELECT e.action, e.actor_id, u.name AS actor_name, e.operation_id::text, e.source, e.cache_generation, e.created_at
       FROM hs_connector_events e JOIN hs_users u ON u.id=e.actor_id
       WHERE e.tenant_id=$1 AND e.connector_id=$2 ORDER BY e.created_at, e.id`,
      [here.tenantId, connectorId],
    );
    return {
      ...flags(),
      events: events.rows.map(event => ({ action: event.action, actorId: event.actor_id, actorName: event.actor_name, operationId: event.operation_id, source: event.source, cacheGeneration: num(event.cache_generation), atIst: formatIst(event.created_at) })),
      connector: { id: row.id, name: row.name, status: row.status, sharing: connectorSharing },
    };
  });
}

export async function connectorInventoryView(r: Repository, actor: Actor, workspaceId: string) {
  const catalogue = await connectorCatalogue(r, actor, workspaceId);
  return { ...catalogue.inventory, connectors: catalogue.connectors.map(item => ({ id: item.id, name: item.name, residency: item.residency, health: item.health, writesStopped: item.writesStopped, liveActivation: item.liveActivation, secretVisible: item.secretVisible, schedulesPaused: item.schedulesPaused, canonicalPreserved: item.canonicalPreserved })) };
}

export async function saveConnector(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; connectorId?: string; expectedVersion: number; name: string; definition: unknown }) {
  const name = connectorName(input.name);
  const definition = compileConnector(input.definition);
  const requestHash = recordHash({ kind: "configure", workspaceId, connectorId: input.connectorId ?? null, expectedVersion: input.expectedVersion, name, definition: storedDefinition(definition), secretRef: definition.secretRef });
  const outcome = await r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await hold(tx, here.tenantId);
    await requireManager(tx, here, actor);
    if (!await actionAllowed(tx, here.tenantId, actor.id, "configure", true)) throw forbidden();
    const replay = await prior<Outcome & { id?: string }>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    await requireScope(tx, here.tenantId, actor, definition);
    if (!input.connectorId) {
      if (input.expectedVersion !== 0) {
        await saveDraft(tx, here.tenantId, actor.id, "new", "configure", input.expectedVersion, { name, definition: storedDefinition(definition) }, input.operationId);
        return { conflict: true as const, version: 0 };
      }
      const id = randomUUID();
      const inserted = await tx.query<ConnectorRow>(
        `INSERT INTO hs_connectors(id,tenant_id,name,connector_type,status,sharing,activated,live_activation,connection_authorised,credentials_stored,secret_ref,version,cache_generation,definition,created_by)
         VALUES($1,$2,$3,$4,'draft','off',false,false,false,false,$5,1,1,$6::jsonb,$7)
         RETURNING id, name, status, sharing, version, cache_generation, definition, secret_ref, created_by`,
        [id, here.tenantId, name, definition.type, definition.secretRef, JSON.stringify(storedDefinition(definition)), actor.id],
      );
      const row = inserted.rows[0];
      await revise(tx, row, actor, input.operationId, "configure");
      await audit(tx, actor, "governed-connector.configure", input.operationId, row.id, { status: "draft", cacheGeneration: 1, version: 1 });
      await track(tx, here.tenantId, row.id, actor, "configure", input.operationId, 1, { status: "draft", version: 1 });
      return remember(tx, actor.id, input.operationId, requestHash, { ...present(row, definitionOf(row)), dryRun: true as const, canonicalMutated: false as const });
    }
    const saved = await writeConnector(tx, here, actor, input.operationId, "configure", input.connectorId, input.expectedVersion, { name, definition });
    if ("conflict" in saved || "failed" in saved) return remember(tx, actor.id, input.operationId, requestHash, saved);
    return remember(tx, actor.id, input.operationId, requestHash, { ...saved, dryRun: true as const, canonicalMutated: false as const });
  });
  return settle(outcome);
}

export async function stashConnector(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; connectorId: string; expectedVersion: number; name: string; definition: unknown }) {
  const name = connectorName(input.name);
  const definition = compileConnector(input.definition);
  const requestHash = recordHash({ kind: "stash", workspaceId, connectorId: input.connectorId, expectedVersion: input.expectedVersion, name, definition: storedDefinition(definition), secretRef: definition.secretRef });
  const outcome = await r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await requireManager(tx, here, actor);
    const replay = await prior<{ version: number }>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    await loadConnector(tx, here.tenantId, input.connectorId);
    await saveDraft(tx, here.tenantId, actor.id, input.connectorId, "configure", input.expectedVersion, { name, definition: storedDefinition(definition) }, input.operationId);
    return remember(tx, actor.id, input.operationId, requestHash, flags({ version: input.expectedVersion, stashed: true as const }));
  });
  return settle(outcome);
}

export async function discardConnectorDraft(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; connectorId: string }) {
  const requestHash = recordHash({ kind: "discard-draft", workspaceId, connectorId: input.connectorId });
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await requireManager(tx, here, actor);
    const replay = await prior<{ discarded: true }>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    await tx.query("DELETE FROM hs_connector_drafts WHERE tenant_id=$1 AND actor_id=$2 AND connector_key=$3", [here.tenantId, actor.id, input.connectorId]);
    return remember(tx, actor.id, input.operationId, requestHash, flags({ discarded: true as const }));
  });
}

export async function previewConnector(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; connectorId: string; expectedVersion: number }) {
  const requestHash = recordHash({ kind: "preview", workspaceId, connectorId: input.connectorId, expectedVersion: input.expectedVersion });
  const outcome = await r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await hold(tx, here.tenantId);
    await requireManager(tx, here, actor);
    if (!await actionAllowed(tx, here.tenantId, actor.id, "preview", true)) throw forbidden();
    const replay = await prior<Outcome>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    const current = await loadConnector(tx, here.tenantId, input.connectorId);
    if (num(current.version) !== input.expectedVersion) {
      await saveDraft(tx, here.tenantId, actor.id, input.connectorId, "configure", input.expectedVersion, { rejected: "preview" }, input.operationId);
      return remember(tx, actor.id, input.operationId, requestHash, { conflict: true as const, version: num(current.version) });
    }
    const definition = definitionOf(current);
    const lines = await visibleLines(tx, here.tenantId, actor.id, definition);
    await audit(tx, actor, "governed-connector.preview", input.operationId, current.id, { status: current.status, cacheGeneration: num(current.cache_generation), version: num(current.version), dryRun: true });
    await track(tx, here.tenantId, current.id, actor, "preview", input.operationId, num(current.cache_generation), { status: current.status, dryRun: true });
    return remember(tx, actor.id, input.operationId, requestHash, {
      ...present(current, definition), dryRun: true as const, canonicalMutated: false as const, writesStopped: current.status !== "enabled",
      inventory: connectorInventory(current.status, await conflictCount(tx, current.id)), lines,
    });
  });
  return settle(outcome);
}

async function setStatus(r: Repository, actor: Actor, workspaceId: string, action: "enable" | "pause" | "disconnect", input: { operationId: string; connectorId: string; expectedVersion: number }) {
  const requestHash = recordHash({ kind: action, workspaceId, connectorId: input.connectorId, expectedVersion: input.expectedVersion });
  const outcome = await r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await hold(tx, here.tenantId);
    await requireManager(tx, here, actor);
    if (!await actionAllowed(tx, here.tenantId, actor.id, action, true)) throw forbidden();
    const replay = await prior<Outcome>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    const current = await loadConnector(tx, here.tenantId, input.connectorId);
    const move = nextConnectorStatus(current.status, action);
    if (!move.ok) {
      await saveDraft(tx, here.tenantId, actor.id, input.connectorId, "configure", input.expectedVersion, { rejected: action }, input.operationId);
      return remember(tx, actor.id, input.operationId, requestHash, { failed: true as const, code: move.code, message: move.message, version: num(current.version) });
    }
    if (move.unchanged && num(current.version) === input.expectedVersion) {
      return remember(tx, actor.id, input.operationId, requestHash, { ...present(current, definitionOf(current)), unchanged: true as const, inventory: connectorInventory(current.status, await conflictCount(tx, current.id)) });
    }
    const saved = await writeConnector(tx, here, actor, input.operationId, action, input.connectorId, input.expectedVersion, { status: move.status });
    if ("conflict" in saved || "failed" in saved) return remember(tx, actor.id, input.operationId, requestHash, saved);
    return remember(tx, actor.id, input.operationId, requestHash, { ...saved, inventory: connectorInventory(move.status, await conflictCount(tx, input.connectorId)) });
  });
  return settle(outcome);
}

export function enableConnector(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; connectorId: string; expectedVersion: number }) {
  return setStatus(r, actor, workspaceId, "enable", input);
}
export function pauseConnector(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; connectorId: string; expectedVersion: number }) {
  return setStatus(r, actor, workspaceId, "pause", input);
}
export function disconnectConnector(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; connectorId: string; expectedVersion: number }) {
  return setStatus(r, actor, workspaceId, "disconnect", input);
}

export async function activateConnector(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; connectorId: string; expectedVersion: number }) {
  const requestHash = recordHash({ kind: "activate", workspaceId, connectorId: input.connectorId, expectedVersion: input.expectedVersion });
  const outcome = await r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await hold(tx, here.tenantId);
    await requireManager(tx, here, actor);
    const replay = await prior<Outcome>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    const current = await loadConnector(tx, here.tenantId, input.connectorId);
    if (num(current.version) !== input.expectedVersion) {
      await saveDraft(tx, here.tenantId, actor.id, input.connectorId, "configure", input.expectedVersion, { rejected: "activate" }, input.operationId);
      return { conflict: true as const, version: num(current.version) };
    }
    await audit(tx, actor, "governed-connector.activate-refused", input.operationId, current.id, { status: current.status, cacheGeneration: num(current.cache_generation), version: num(current.version) });
    return remember(tx, actor.id, input.operationId, requestHash, { failed: true as const, code: "connector_activation", message: connectorActivation, version: num(current.version), cacheGeneration: num(current.cache_generation) });
  });
  return settle(outcome);
}

export async function delegateConnector(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; connectorId: string; expectedVersion: number; subjectKind: "user" | "app"; subjectId: string; field: string }) {
  const subjectId = input.subjectId.trim();
  const requestHash = recordHash({ kind: "delegate", workspaceId, connectorId: input.connectorId, expectedVersion: input.expectedVersion, subjectKind: input.subjectKind, subjectId, field: input.field });
  const outcome = await r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await hold(tx, here.tenantId);
    await requireManager(tx, here, actor);
    if (!await actionAllowed(tx, here.tenantId, actor.id, "delegate", true)) throw forbidden();
    const replay = await prior<Outcome>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    const current = await loadConnector(tx, here.tenantId, input.connectorId);
    const definition = definitionOf(current);
    if (!definition.mappings.some(mapping => mapping.field === input.field)) throw unavailable();
    if (input.subjectKind === "app") {
      if (!appPattern.test(subjectId)) throw unavailable();
    } else if (input.subjectKind === "user") {
      const member = await tx.query("SELECT 1 FROM hs_members WHERE workspace_id=$1 AND user_id=$2 AND active=true", [here.workspaceId, subjectId]);
      if (!member.rows.length) throw unavailable();
    } else throw unavailable();
    if (num(current.version) !== input.expectedVersion) {
      await saveDraft(tx, here.tenantId, actor.id, input.connectorId, "delegate", input.expectedVersion, { subjectKind: input.subjectKind, subjectId, field: input.field }, input.operationId);
      return remember(tx, actor.id, input.operationId, requestHash, { conflict: true as const, version: num(current.version) });
    }
    const usersBefore = await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM hs_users");
    await tx.query(
      `INSERT INTO hs_connector_delegations(connector_id,subject_kind,subject_id,field_key,access_granted,version,delegated_by)
       VALUES($1,$2,$3,$4,false,$5,$6)
       ON CONFLICT (connector_id, subject_kind, subject_id, field_key) DO NOTHING`,
      [input.connectorId, input.subjectKind, subjectId, input.field, num(current.version), actor.id],
    );
    const usersAfter = await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM hs_users");
    if (num(usersAfter.rows[0].n) !== num(usersBefore.rows[0].n)) throw unavailable();
    const saved = await writeConnector(tx, here, actor, input.operationId, "delegate", input.connectorId, input.expectedVersion, {});
    if ("conflict" in saved || "failed" in saved) return remember(tx, actor.id, input.operationId, requestHash, saved);
    const live = input.subjectKind === "user" ? await liveRights(tx, here.tenantId, subjectId, definition, input.field) : { view: false, write: false, history: false };
    const rights = effectiveRights({ kind: input.subjectKind, live, fieldOwned: true });
    return remember(tx, actor.id, input.operationId, requestHash, { ...saved, subjectKind: input.subjectKind, subjectId, field: input.field, rights, delegated: true as const });
  });
  return settle(outcome);
}

async function ledgerRows(tx: Sql, connectorId: string) {
  const rows = await tx.query<{ external_id: string; external_field: string; value: string; proposed_value: string | null; external_version: number | string; canonical_version: number | string | null; state: LedgerRow["state"]; attempt_count: number | string; merged_into: string | null }>(
    "SELECT external_id, external_field, value, proposed_value, external_version, canonical_version, state, attempt_count, merged_into FROM hs_connector_sync_items WHERE connector_id=$1",
    [connectorId],
  );
  return rows.rows.map(row => ({
    externalId: row.external_id, externalField: row.external_field, value: row.value, proposedValue: row.proposed_value,
    externalVersion: num(row.external_version), canonicalVersion: row.canonical_version === null ? null : num(row.canonical_version),
    state: row.state, attempts: num(row.attempt_count), mergedInto: row.merged_into,
  }));
}

export async function syncConnector(r: Repository, actor: Actor, workspaceId: string, input: SyncInput) {
  const items = compileSyncItems(input.items);
  const failed = input.failed === true;
  const requestHash = recordHash({ kind: failed ? "retry" : "sync", workspaceId, connectorId: input.connectorId, expectedVersion: input.expectedVersion, mode: input.mode, checkpoint: input.checkpoint, items, failed });
  const outcome = await r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await hold(tx, here.tenantId);
    await requireManager(tx, here, actor);
    if (!await actionAllowed(tx, here.tenantId, actor.id, "sync", true)) throw forbidden();
    const replay = await prior<Outcome>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    const current = await loadConnector(tx, here.tenantId, input.connectorId);
    const definition = definitionOf(current);
    if (num(current.version) !== input.expectedVersion) {
      await saveDraft(tx, here.tenantId, actor.id, input.connectorId, "sync", input.expectedVersion, { mode: input.mode, checkpoint: input.checkpoint, failed }, input.operationId);
      return remember(tx, actor.id, input.operationId, requestHash, { conflict: true as const, version: num(current.version) });
    }
    assertMappedItems(definition, items);
    const checkpoint = await tx.query<{ cursor: string; generation: number | string; mode: "initial" | "incremental" }>("SELECT cursor, generation, mode FROM hs_connector_checkpoints WHERE connector_id=$1", [input.connectorId]);
    const stored = checkpoint.rows[0];
    const canonical = [];
    for (const stable of definition.stableIds) {
      const record = await recordAccess(tx, here.tenantId, stable.recordId, actor.id);
      if (!record || !record.view || record.collection !== definition.scope.collection) throw unavailable();
      for (const mapping of definition.mappings) {
        if (!await fieldDecision(tx, here.tenantId, record.collection, mapping.field, actor.id, "view")) continue;
        const value = record.values[mapping.field];
        canonical.push({ externalId: stable.externalId, externalField: mapping.externalField, version: record.version, value: typeof value === "string" ? value : null });
      }
    }
    const plan = planSyncBatch({
      status: current.status, direction: definition.direction, mode: input.mode, checkpoint: input.checkpoint,
      storedCheckpoint: stored?.cursor ?? null, generation: stored ? num(stored.generation) : 0, items, ledger: await ledgerRows(tx, current.id),
      canonical, bound: definition.retry.bound, failed,
    });
    if (!plan.ok) {
      await saveDraft(tx, here.tenantId, actor.id, input.connectorId, "sync", input.expectedVersion, { mode: input.mode, checkpoint: input.checkpoint, failed, rejected: plan.code }, input.operationId);
      return remember(tx, actor.id, input.operationId, requestHash, { failed: true as const, code: plan.code, message: plan.message, writesStopped: plan.writesStopped, canonicalPreserved: true as const, checkpoint: plan.checkpoint });
    }
    for (const effect of plan.effects) {
      const stable = definition.stableIds.find(item => item.externalId === effect.externalId)!;
      const mapping = definition.mappings.find(item => item.externalField === effect.externalField)!;
      const record = await recordAccess(tx, here.tenantId, stable.recordId, actor.id);
      const owned = await tx.query("SELECT 1 FROM hs_connector_delegations WHERE connector_id=$1 AND subject_kind='user' AND subject_id=$2 AND field_key=$3 AND access_granted=false", [current.id, actor.id, mapping.field]);
      const rights = effectiveRights({ kind: "user", live: { view: Boolean(record?.view) && await fieldDecision(tx, here.tenantId, definition.scope.collection, mapping.field, actor.id, "view"), write: Boolean(record?.edit) && await fieldDecision(tx, here.tenantId, definition.scope.collection, mapping.field, actor.id, "write"), history: Boolean(record?.history) }, fieldOwned: owned.rows.length > 0 });
      const writing = effect.insert || effect.state === "tombstone" || effect.state === "failed";
      if (!rights.view || (writing && !rights.write)) {
        await saveDraft(tx, here.tenantId, actor.id, input.connectorId, "sync", input.expectedVersion, { rejected: "field", field: mapping.field }, input.operationId);
        return remember(tx, actor.id, input.operationId, requestHash, { failed: true as const, code: owned.rows.length ? "connector_field" : "connector_delegation", message: "That field is not delegated for this action. Nothing was saved.", canonicalPreserved: true as const });
      }
    }
    for (const effect of plan.effects) {
      const stable = definition.stableIds.find(item => item.externalId === effect.externalId)!;
      const mapping = definition.mappings.find(item => item.externalField === effect.externalField)!;
      if (effect.insert) {
        await tx.query(
          `INSERT INTO hs_connector_sync_items(id,tenant_id,connector_id,external_id,external_field,field_key,record_id,value,proposed_value,external_version,canonical_version,state,attempt_count,canonical_mutated,operation_id)
           VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,false,$14)`,
          [randomUUID(), here.tenantId, current.id, effect.externalId, effect.externalField, mapping.field, stable.recordId, effect.value, effect.proposedValue, effect.externalVersion, effect.canonicalVersion, effect.state, effect.attempts, input.operationId],
        );
      } else if (!effect.deduped) {
        await tx.query(
          `UPDATE hs_connector_sync_items SET state=$4, proposed_value=$5, external_version=$6, canonical_version=$7, attempt_count=$8, operation_id=$9, updated_at=clock_timestamp()
           WHERE connector_id=$1 AND external_id=$2 AND external_field=$3 AND value=$10`,
          [current.id, effect.externalId, effect.externalField, effect.state, effect.proposedValue, effect.externalVersion, effect.canonicalVersion, effect.attempts, input.operationId, effect.value],
        );
      }
    }
    if (plan.advanced && plan.checkpoint) {
      await tx.query(
        `INSERT INTO hs_connector_checkpoints(connector_id,mode,cursor,generation) VALUES($1,$2,$3,$4)
         ON CONFLICT (connector_id) DO UPDATE SET mode=$2, cursor=$3, generation=$4, updated_at=clock_timestamp()`,
        [current.id, input.mode, plan.checkpoint, plan.generation],
      );
    }
    const apps = await tx.query<{ subject_id: string }>("SELECT subject_id FROM hs_connector_delegations WHERE connector_id=$1 AND subject_kind='app' ORDER BY subject_id", [current.id]);
    await audit(tx, actor, failed ? "governed-connector.retry" : "governed-connector.sync", input.operationId, current.id, { mode: input.mode, checkpoint: plan.checkpoint, items: plan.effects.length, canonicalMutated: false, apps: apps.rows.map(row => row.subject_id) });
    await track(tx, here.tenantId, current.id, actor, failed ? "retry" : "sync", input.operationId, num(current.cache_generation), { mode: input.mode, checkpoint: plan.checkpoint, canonicalMutated: false });
    return remember(tx, actor.id, input.operationId, requestHash, flags({
      id: current.id, mode: input.mode, checkpoint: plan.checkpoint, generation: plan.generation, advanced: plan.advanced, failedAttempt: failed,
      canonicalMutated: false as const, overwritten: false as const, effects: plan.effects.map(effect => ({ externalId: effect.externalId, externalField: effect.externalField, state: effect.state, deduped: effect.deduped, attempts: effect.attempts, overwritten: false as const })),
    }));
  });
  return settle(outcome);
}

async function resolveConflict(r: Repository, actor: Actor, workspaceId: string, decision: "keep-canonical" | "accept-external" | "merge", input: { operationId: string; connectorId: string; expectedVersion: number; externalId: string; externalField: string; survivorExternalId?: string | null }) {
  const requestHash = recordHash({ kind: decision, workspaceId, connectorId: input.connectorId, expectedVersion: input.expectedVersion, externalId: input.externalId, externalField: input.externalField, survivorExternalId: input.survivorExternalId ?? null });
  const outcome = await r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await hold(tx, here.tenantId);
    await requireManager(tx, here, actor);
    if (!await actionAllowed(tx, here.tenantId, actor.id, decision === "merge" ? "merge" : "review", true)) throw forbidden();
    const replay = await prior<Outcome>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    const current = await loadConnector(tx, here.tenantId, input.connectorId);
    if (current.status !== "enabled") {
      await saveDraft(tx, here.tenantId, actor.id, input.connectorId, decision === "merge" ? "merge" : "review", input.expectedVersion, { rejected: current.status }, input.operationId);
      return remember(tx, actor.id, input.operationId, requestHash, { failed: true as const, code: "connector_writes_stopped", message: connectorCanonical, canonicalPreserved: true as const });
    }
    if (num(current.version) !== input.expectedVersion) {
      await saveDraft(tx, here.tenantId, actor.id, input.connectorId, decision === "merge" ? "merge" : "review", input.expectedVersion, { externalId: input.externalId, externalField: input.externalField }, input.operationId);
      return { conflict: true as const, version: num(current.version) };
    }
    const definition = definitionOf(current);
    const row = (await ledgerRows(tx, current.id)).find(item => item.externalId === input.externalId && item.externalField === input.externalField);
    if (!row) throw unavailable();
    const stable = definition.stableIds.find(item => item.externalId === input.externalId);
    const mapping = definition.mappings.find(item => item.externalField === input.externalField);
    if (!stable || !mapping) throw unavailable();
    if (decision === "merge" && !definition.stableIds.some(item => item.externalId === input.survivorExternalId)) throw unavailable();
    const record = await recordAccess(tx, here.tenantId, stable.recordId, actor.id);
    const canonicalValue = record && typeof record.values[mapping.field] === "string" ? record.values[mapping.field] as string : null;
    const plan = planMerge({ row, decision, survivorExternalId: input.survivorExternalId ?? null, canonicalValue });
    if (!plan.ok) {
      await saveDraft(tx, here.tenantId, actor.id, input.connectorId, decision === "merge" ? "merge" : "review", input.expectedVersion, { rejected: plan.code }, input.operationId);
      return remember(tx, actor.id, input.operationId, requestHash, { failed: true as const, code: plan.code, message: plan.message, canonicalPreserved: true as const });
    }
    await tx.query(
      `UPDATE hs_connector_sync_items SET state=$4, value=$5, proposed_value=NULL, merged_into=$6, operation_id=$7, updated_at=clock_timestamp()
       WHERE connector_id=$1 AND external_id=$2 AND external_field=$3 AND state IN ('conflict','tombstone')`,
      [current.id, input.externalId, input.externalField, plan.state, plan.value, plan.mergedInto, input.operationId],
    );
    await audit(tx, actor, `governed-connector.${decision}`, input.operationId, current.id, { externalId: input.externalId, externalField: input.externalField, canonicalMutated: false });
    await track(tx, here.tenantId, current.id, actor, decision, input.operationId, num(current.cache_generation), { externalId: input.externalId, externalField: input.externalField, canonicalMutated: false });
    return remember(tx, actor.id, input.operationId, requestHash, flags({ id: current.id, state: plan.state, mergedInto: plan.mergedInto, canonicalMutated: false as const, overwritten: false as const }));
  });
  return settle(outcome);
}

export function reviewConnectorConflict(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; connectorId: string; expectedVersion: number; externalId: string; externalField: string; decision: "keep-canonical" | "accept-external" }) {
  return resolveConflict(r, actor, workspaceId, input.decision, input);
}
export function mergeConnector(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; connectorId: string; expectedVersion: number; externalId: string; externalField: string; survivorExternalId: string }) {
  return resolveConflict(r, actor, workspaceId, "merge", input);
}

export async function downloadConnectorReport(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; connectorId: string; expectedVersion: number }) {
  const requestHash = recordHash({ kind: "download", workspaceId, connectorId: input.connectorId, expectedVersion: input.expectedVersion });
  const outcome = await r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    const replay = await prior<{ body: string; version: number }>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    const row = await loadConnector(tx, here.tenantId, input.connectorId);
    const definition = definitionOf(row);
    if (num(row.version) !== input.expectedVersion) throw new DocumentError("The connector version changed. Nothing was overwritten.", "connector_conflict", 409);
    const manage = await isManager(tx, here, actor);
    if (!manage && !await canSeeConnector(tx, here.tenantId, actor.id, definition)) throw unavailable();
    if (!await actionAllowed(tx, here.tenantId, actor.id, "download", manage)) throw forbidden();
    const records = [];
    for (const recordId of definition.scope.recordIds) {
      const record = await recordAccess(tx, here.tenantId, recordId, actor.id);
      if (record && record.view) records.push(record);
    }
    if (records.some(record => !record.export)) throw forbidden();
    const inventory = connectorInventory(row.status, await conflictCount(tx, row.id));
    const body = connectorReport(definition, row.name, [
      `Health: ${inventory.health}.`,
      `Residency: ${inventory.residency}.`,
      `Writes stopped: ${inventory.writesStopped ? "yes" : "no"}.`,
      `Canonical preserved: yes.`,
      ...await visibleLines(tx, here.tenantId, actor.id, definition),
    ]);
    await audit(tx, actor, "governed-connector.download", input.operationId, row.id, { cacheGeneration: num(row.cache_generation), version: num(row.version) });
    return remember(tx, actor.id, input.operationId, requestHash, flags({ body, version: num(row.version), cacheGeneration: num(row.cache_generation), secretVisible: false as const }));
  });
  return settle(outcome);
}

export async function setConnectorActions(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; userId: string; expectedVersion: number; actions: string[] }) {
  const actions: ConnectorActorAction[] = [];
  for (const action of input.actions) {
    if (!connectorActorActions.includes(action as ConnectorActorAction) || actions.includes(action as ConnectorActorAction)) throw new DocumentError("Check the connector.", "connector_validation", 422);
    actions.push(action as ConnectorActorAction);
  }
  const requestHash = recordHash({ kind: "actions", workspaceId, userId: input.userId, expectedVersion: input.expectedVersion, actions });
  const outcome = await r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await hold(tx, here.tenantId);
    await requireManager(tx, here, actor);
    const replay = await prior<{ version: number }>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    const member = await tx.query("SELECT 1 FROM hs_members WHERE workspace_id=$1 AND user_id=$2 AND active=true", [here.workspaceId, input.userId]);
    if (!member.rows.length) throw unavailable();
    const current = await tx.query<{ version: number | string }>("SELECT version FROM hs_connector_actor_sets WHERE tenant_id=$1 AND user_id=$2", [here.tenantId, input.userId]);
    const version = current.rows[0] ? num(current.rows[0].version) : 0;
    if (version !== input.expectedVersion) {
      await saveDraft(tx, here.tenantId, actor.id, input.userId, "actions", input.expectedVersion, { actions }, input.operationId);
      return { conflict: true as const, version };
    }
    const next = version + 1;
    if (!current.rows[0]) await tx.query("INSERT INTO hs_connector_actor_sets(tenant_id,user_id,version) VALUES($1,$2,$3)", [here.tenantId, input.userId, next]);
    else await tx.query("UPDATE hs_connector_actor_sets SET version=$3 WHERE tenant_id=$1 AND user_id=$2", [here.tenantId, input.userId, next]);
    await tx.query("DELETE FROM hs_connector_actor_actions WHERE tenant_id=$1 AND user_id=$2", [here.tenantId, input.userId]);
    for (const action of actions) await tx.query("INSERT INTO hs_connector_actor_actions(tenant_id,user_id,action,granted_by) VALUES($1,$2,$3,$4)", [here.tenantId, input.userId, action, actor.id]);
    await audit(tx, actor, "governed-connector.actions", input.operationId, input.userId, { version: next, actions });
    return remember(tx, actor.id, input.operationId, requestHash, flags({ userId: input.userId, version: next, actions }));
  });
  return settle(outcome);
}

async function managerChange(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; userId: string }, grant: boolean) {
  const requestHash = recordHash({ kind: grant ? "grant-manager" : "revoke-manager", workspaceId, userId: input.userId });
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    if (here.role !== "owner" && here.role !== "admin") throw unavailable();
    const replay = await prior<{ userId: string }>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    const member = await tx.query("SELECT 1 FROM hs_members WHERE workspace_id=$1 AND user_id=$2 AND active=true", [here.workspaceId, input.userId]);
    if (!member.rows.length) throw unavailable();
    if (grant) await tx.query("INSERT INTO hs_connector_managers(workspace_id,user_id,granted_by) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [here.workspaceId, input.userId, actor.id]);
    else await tx.query("DELETE FROM hs_connector_managers WHERE workspace_id=$1 AND user_id=$2", [here.workspaceId, input.userId]);
    await audit(tx, actor, grant ? "governed-connector.grant-manager" : "governed-connector.revoke-manager", input.operationId, input.userId, { userId: input.userId });
    return remember(tx, actor.id, input.operationId, requestHash, flags({ userId: input.userId, manager: grant }));
  });
}
export function grantConnectorManager(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; userId: string }) {
  return managerChange(r, actor, workspaceId, input, true);
}
export function revokeConnectorManager(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; userId: string }) {
  return managerChange(r, actor, workspaceId, input, false);
}
