import { randomUUID } from "node:crypto";
import type { Actor } from "./auth";
import type { Sql } from "./database";
import { DocumentError } from "./document";
import {
  assertGuestText,
  compileGuestPortal,
  evaluateGuestAccess,
  guestFileCitation,
  guestPortalActivation,
  guestPortalActorActions,
  guestPortalAssignment,
  guestPortalAuthority,
  guestPortalBoundary,
  guestPortalDocument,
  guestPortalEdge,
  guestPortalName,
  guestPortalQuery,
  guestPortalRecoverable,
  guestPortalSchedules,
  guestPortalSharing,
  guestPortalSource,
  type AccessClaim,
  type GuestPortalActorAction,
  type GuestPortalDefinition,
  type GuestPortalStatus,
} from "./guest-portal-plan";
import { formatIst } from "./ist-label";
import type { Repository } from "./repository";
import { recordHash } from "./shared-record-types";

const unavailable = () => new DocumentError("Guest portals are restricted or unavailable.", "not_found", 404);
const forbidden = () => new DocumentError("This action is not permitted.", "action_forbidden", 403);
const mismatch = () => new DocumentError("This attempt was reused with different fields.", "operation_mismatch", 409);
const conflictMessage = "The portal version changed. The draft is kept.";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Scope = { workspaceId: string; tenantId: string; role: string };
type PortalRow = {
  id: string;
  name: string;
  status: GuestPortalStatus;
  sharing: string;
  version: number | string;
  cache_generation: number | string;
  definition: unknown;
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
type ClaimInput = { urlToken?: string | null; domain?: string | null };

const copy = () => ({
  boundary: guestPortalBoundary,
  assignment: guestPortalAssignment,
  authority: guestPortalAuthority,
  activation: guestPortalActivation,
  schedules: guestPortalSchedules,
  recoverable: guestPortalRecoverable,
  edge: guestPortalEdge,
  sharing: guestPortalSharing,
  accessGranted: false as const,
  invitationSent: false as const,
  credentialsStored: false as const,
  liveActivation: false as const,
});

function settle<T extends object>(result: T): T {
  const value = result as T & Outcome;
  if (value.failed) throw new DocumentError(value.message ?? "Check the portal.", value.code ?? "guest_portal_validation", 409);
  if (value.conflict) throw new DocumentError(conflictMessage, "guest_portal_conflict", 409);
  return result;
}
function on(value: unknown) { return value === true || value === "t" || value === "true" || value === 1; }
function num(value: number | string | null | undefined) { return Number(value ?? 0); }
function asJson<T>(value: unknown): T { return (typeof value === "string" ? JSON.parse(value) : value) as T; }
function flags(extra: Record<string, unknown> = {}) {
  return { sharing: guestPortalSharing, accessGranted: false as const, invitationSent: false as const, credentialsStored: false as const, liveActivation: false as const, cache: "no-store" as const, ...extra };
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
  const row = await tx.query("SELECT 1 FROM hs_guest_portal_managers WHERE workspace_id=$1 AND user_id=$2", [here.workspaceId, actor.id]);
  return row.rows.length > 0;
}
async function requireManager(tx: Sql, here: Scope, actor: Actor) {
  if (!await isManager(tx, here, actor)) throw unavailable();
}
async function actionAllowed(tx: Sql, tenantId: string, userId: string, action: GuestPortalActorAction, base: boolean) {
  if (!base) return false;
  const rows = await tx.query<{ action: string }>("SELECT action FROM hs_guest_portal_actor_actions WHERE tenant_id=$1 AND user_id=$2", [tenantId, userId]);
  if (!rows.rows.length) return true;
  return rows.rows.some(row => row.action === action);
}
async function prior<T extends object>(tx: Sql, actorId: string, operationId: string, requestHash: string): Promise<(T & { replayed: true }) | null> {
  const row = await tx.query<{ request_hash: string; result: unknown }>("SELECT request_hash, result FROM hs_guest_portal_operations WHERE actor_id=$1 AND operation_id=$2", [actorId, operationId]);
  if (!row.rows[0]) return null;
  if (row.rows[0].request_hash !== requestHash) throw mismatch();
  return { ...asJson<T>(row.rows[0].result), replayed: true };
}
async function remember<T extends object>(tx: Sql, actorId: string, operationId: string, requestHash: string, result: T) {
  const stored = { ...result, replayed: false as const };
  await tx.query("INSERT INTO hs_guest_portal_operations(actor_id,operation_id,request_hash,result) VALUES($1,$2,$3,$4)", [actorId, operationId, requestHash, JSON.stringify(stored)]);
  return stored;
}
async function audit(tx: Sql, actor: Actor, action: string, operationId: string, portalId: string, after: Record<string, unknown>) {
  const body = { source: guestPortalSource, operationId, atIst: formatIst(new Date()), ...flags(after) };
  await tx.query(
    "INSERT INTO hs_audit(id,actor_id,action,page_id,subject_id,after_value,correlation_id) VALUES($1,$2,$3,NULL,$4,$5,$6)",
    [randomUUID(), actor.id, action, portalId, JSON.stringify(body), operationId],
  );
}
async function track(tx: Sql, tenantId: string, portalId: string, actor: Actor, action: string, operationId: string, cacheGeneration: number, detail: Record<string, unknown>) {
  await tx.query(
    "INSERT INTO hs_guest_portal_events(id,tenant_id,portal_id,action,actor_id,operation_id,source,cache_generation,detail) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [randomUUID(), tenantId, portalId, action, actor.id, operationId, guestPortalSource, cacheGeneration, JSON.stringify(flags(detail))],
  );
}
async function saveDraft(tx: Sql, tenantId: string, actorId: string, portalKey: string, kind: string, baseVersion: number, payload: Record<string, unknown>, operationId: string) {
  await tx.query(
    `INSERT INTO hs_guest_portal_drafts(tenant_id,actor_id,portal_key,kind,base_version,payload,operation_id)
     VALUES($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (tenant_id, actor_id, portal_key, kind)
     DO UPDATE SET base_version=$5, payload=$6, operation_id=$7, updated_at=clock_timestamp()`,
    [tenantId, actorId, portalKey, kind, baseVersion, JSON.stringify(payload), operationId],
  );
}
function definitionOf(value: unknown) {
  return compileGuestPortal(asJson(value));
}
function present(row: PortalRow, definition: GuestPortalDefinition, replayed = false) {
  return {
    ...flags(),
    id: row.id,
    name: row.name,
    status: row.status,
    version: num(row.version),
    cacheGeneration: num(row.cache_generation),
    definition,
    guestPreview: definition.guestPreview,
    expiry: definition.expiry,
    screens: definition.screens,
    scope: definition.scope,
    fields: definition.fields,
    actions: definition.actions,
    domain: definition.domain,
    replayed,
  };
}
async function loadPortal(tx: Sql, tenantId: string, portalId: string) {
  if (!uuidPattern.test(portalId)) throw unavailable();
  const row = await tx.query<PortalRow>("SELECT id, name, status, sharing, version, cache_generation, definition, created_by FROM hs_guest_portals WHERE id=$1 AND tenant_id=$2", [portalId, tenantId]);
  if (!row.rows[0] || row.rows[0].sharing !== "off") throw unavailable();
  return row.rows[0];
}
async function revise(tx: Sql, row: PortalRow, actor: Actor, operationId: string, action: string) {
  await tx.query(
    "INSERT INTO hs_guest_portal_revisions(portal_id,version,status,name,definition,cache_generation,action,actor_id,operation_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
    [row.id, num(row.version), row.status, row.name, JSON.stringify(asJson(row.definition)), num(row.cache_generation), action, actor.id, operationId],
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
async function visibleRecords(tx: Sql, tenantId: string, actorId: string, definition: GuestPortalDefinition) {
  const records = [];
  for (const recordId of definition.scope.recordIds) {
    const record = await recordAccess(tx, tenantId, recordId, actorId);
    if (!record || record.collection !== definition.scope.collection || !record.view) continue;
    const values: Record<string, string> = {};
    for (const field of definition.fields) {
      if (!await fieldDecision(tx, tenantId, record.collection, field.key, actorId, "view")) continue;
      const value = record.values[field.key];
      if (typeof value === "string") values[field.key] = value;
    }
    records.push({ id: record.id, name: record.name, version: record.version, values, edit: record.edit, export: record.export, history: record.history });
  }
  return records;
}
async function member(tx: Sql, workspaceId: string, userId: string) {
  const row = await tx.query("SELECT 1 FROM hs_members WHERE workspace_id=$1 AND user_id=$2 AND active=true", [workspaceId, userId]);
  return row.rows.length > 0;
}
async function factsFor(tx: Sql, here: Scope, actor: Actor, row: PortalRow, definition: GuestPortalDefinition) {
  const identity = await tx.query("SELECT 1 FROM hs_guest_portal_identities WHERE portal_id=$1 AND suite_subject=$2 AND credentials_stored=false AND invitation_sent=false AND access_granted=false", [row.id, actor.id]);
  const grant = await tx.query<{ state: "current" | "revoked" | "expired"; starts_at: string | Date; expires_at: string | Date }>(
    "SELECT state, starts_at, expires_at FROM hs_guest_portal_grants WHERE tenant_id=$1 AND portal_id=$2 AND suite_subject=$3 ORDER BY starts_at DESC LIMIT 1",
    [here.tenantId, row.id, actor.id],
  );
  const current = grant.rows[0];
  let state: "current" | "revoked" | "expired" | "missing" = "missing";
  let expiredByPolicy = false;
  if (current) {
    const expires = new Date(current.expires_at).getTime();
    const policyEnd = new Date(current.starts_at).getTime() + definition.expiry.hours * 3_600_000;
    expiredByPolicy = Number.isFinite(policyEnd) && policyEnd <= Date.now();
    if (current.state === "revoked") state = "revoked";
    else if (current.state === "expired" || !Number.isFinite(expires) || expires <= Date.now()) state = "expired";
    else state = "current";
  }
  return {
    status: row.status,
    suiteSubject: identity.rows.length ? actor.id : null,
    identityLinked: identity.rows.length > 0,
    grant: state,
    expiredByPolicy,
    audienceDomain: definition.domain,
  };
}
function claimFor(actor: Actor, accountAssigned: boolean, claim: ClaimInput): AccessClaim {
  return {
    authenticated: true,
    suiteSubject: actor.id,
    urlToken: claim.urlToken?.trim() || null,
    domain: claim.domain?.trim() || null,
    accountAssigned,
  };
}
async function admit(tx: Sql, here: Scope, actor: Actor, row: PortalRow, definition: GuestPortalDefinition, claim: ClaimInput) {
  const decision = evaluateGuestAccess(claimFor(actor, await member(tx, here.workspaceId, actor.id), claim), await factsFor(tx, here, actor, row, definition));
  if (!decision.allowed) throw unavailable();
  return decision;
}
async function requireScope(tx: Sql, tenantId: string, actor: Actor, definition: GuestPortalDefinition) {
  const collection = await tx.query("SELECT 1 FROM hs_data_collections WHERE tenant_id=$1 AND id=$2 AND deprecated=false", [tenantId, definition.scope.collection]);
  if (!collection.rows.length) throw unavailable();
  for (const recordId of definition.scope.recordIds) {
    const record = await recordAccess(tx, tenantId, recordId, actor.id);
    if (!record || record.collection !== definition.scope.collection || !record.view) throw unavailable();
  }
}
function guestView(row: PortalRow, definition: GuestPortalDefinition, records: { id: string; name: string; version: number; values: Record<string, string> }[], reason: string) {
  return {
    ...present(row, definition),
    admitted: true as const,
    reason,
    audience: "guest" as const,
    records: records.map(record => ({ id: record.id, name: record.name, version: record.version, values: record.values })),
    validUntil: definition.expiry.hours,
  };
}

export async function guestPortalCatalogue(r: Repository, actor: Actor, workspaceId: string) {
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    const manage = await isManager(tx, here, actor);
    const rows = await tx.query<PortalRow>("SELECT id, name, status, sharing, version, cache_generation, definition, created_by FROM hs_guest_portals WHERE tenant_id=$1 ORDER BY name_search, id", [here.tenantId]);
    const portals = [];
    for (const row of rows.rows) {
      const definition = definitionOf(row.definition);
      const admitted = evaluateGuestAccess(claimFor(actor, await member(tx, here.workspaceId, actor.id), {}), await factsFor(tx, here, actor, row, definition)).allowed;
      if (!manage && !admitted) continue;
      portals.push({ id: row.id, name: row.name, status: row.status, version: num(row.version), cacheGeneration: num(row.cache_generation), sharing: guestPortalSharing, accessGranted: false as const, admitted });
    }
    const drafts = await tx.query<{ portal_key: string; kind: string; base_version: number | string; payload: unknown }>("SELECT portal_key, kind, base_version, payload FROM hs_guest_portal_drafts WHERE tenant_id=$1 AND actor_id=$2 ORDER BY portal_key, kind", [here.tenantId, actor.id]);
    return {
      ...copy(),
      actorId: actor.id,
      manage,
      portals,
      drafts: drafts.rows.map(draft => ({ portalKey: draft.portal_key, kind: draft.kind, baseVersion: num(draft.base_version), payload: asJson(draft.payload) })),
    };
  });
}

export async function readGuestPortal(r: Repository, actor: Actor, workspaceId: string, portalId: string) {
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    const row = await loadPortal(tx, here.tenantId, portalId);
    const definition = definitionOf(row.definition);
    if (await isManager(tx, here, actor)) return { ...present(row, definition), audience: "admin" as const, admitted: false as const };
    const decision = await admit(tx, here, actor, row, definition, {});
    return guestView(row, definition, await visibleRecords(tx, here.tenantId, actor.id, definition), decision.reason);
  });
}

export async function openGuestPortal(r: Repository, actor: Actor, workspaceId: string, portalId: string, claim: ClaimInput = {}) {
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    const row = await loadPortal(tx, here.tenantId, portalId);
    const definition = definitionOf(row.definition);
    const decision = await admit(tx, here, actor, row, definition, claim);
    if (!definition.actions.includes("view")) throw forbidden();
    return guestView(row, definition, await visibleRecords(tx, here.tenantId, actor.id, definition), decision.reason);
  });
}

export async function searchGuestPortals(r: Repository, actor: Actor, workspaceId: string, query: string) {
  const needle = guestPortalQuery(query);
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    if (!await actionAllowed(tx, here.tenantId, actor.id, "search", true)) throw forbidden();
    const manage = await isManager(tx, here, actor);
    const rows = await tx.query<PortalRow>("SELECT id, name, status, sharing, version, cache_generation, definition, created_by FROM hs_guest_portals WHERE tenant_id=$1 ORDER BY name_search, id", [here.tenantId]);
    const results = [];
    for (const row of rows.rows) {
      const definition = definitionOf(row.definition);
      const admitted = evaluateGuestAccess(claimFor(actor, await member(tx, here.workspaceId, actor.id), {}), await factsFor(tx, here, actor, row, definition)).allowed;
      if (!manage && !admitted) continue;
      const records = await visibleRecords(tx, here.tenantId, actor.id, definition);
      const hay = [row.name, row.status, ...records.flatMap(record => [record.name, ...Object.values(record.values)])].join("\n").toLocaleLowerCase();
      if (!hay.includes(needle)) continue;
      results.push({ id: row.id, name: row.name, status: row.status, sharing: guestPortalSharing, accessGranted: false as const });
    }
    return { results, ...flags({ assignment: guestPortalAssignment }) };
  });
}

export async function guestPortalHistory(r: Repository, actor: Actor, workspaceId: string, portalId: string) {
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    const row = await loadPortal(tx, here.tenantId, portalId);
    const definition = definitionOf(row.definition);
    const manage = await isManager(tx, here, actor);
    const admitted = evaluateGuestAccess(claimFor(actor, await member(tx, here.workspaceId, actor.id), {}), await factsFor(tx, here, actor, row, definition)).allowed;
    if (!manage && !admitted) throw unavailable();
    if (!definition.actions.includes("history") || !await actionAllowed(tx, here.tenantId, actor.id, "history", true)) throw forbidden();
    const records = await visibleRecords(tx, here.tenantId, actor.id, definition);
    if (records.length && records.every(record => !record.history)) throw forbidden();
    for (const field of definition.fields) {
      if (!await fieldDecision(tx, here.tenantId, definition.scope.collection, field.key, actor.id, "history") && await tx.query("SELECT 1 FROM hs_data_fields WHERE tenant_id=$1 AND collection=$2 AND field_key=$3 AND sensitive=true", [here.tenantId, definition.scope.collection, field.key]).then(found => found.rows.length > 0)) {
        throw forbidden();
      }
    }
    const events = await tx.query<{ action: string; actor_id: string; actor_name: string; operation_id: string; source: string; cache_generation: number | string; created_at: string | Date }>(
      `SELECT e.action, e.actor_id, u.name AS actor_name, e.operation_id::text, e.source, e.cache_generation, e.created_at
       FROM hs_guest_portal_events e JOIN hs_users u ON u.id=e.actor_id
       WHERE e.tenant_id=$1 AND e.portal_id=$2 ORDER BY e.created_at, e.id`,
      [here.tenantId, portalId],
    );
    return {
      ...flags(),
      events: events.rows.map(event => ({ action: event.action, actorId: event.actor_id, actorName: event.actor_name, operationId: event.operation_id, source: event.source, cacheGeneration: num(event.cache_generation), atIst: formatIst(event.created_at) })),
      portal: { id: row.id, name: row.name, status: row.status, sharing: guestPortalSharing },
    };
  });
}

async function writePortal(tx: Sql, here: Scope, actor: Actor, operationId: string, action: string, portalId: string, expectedVersion: number, patch: { status?: GuestPortalStatus; name?: string; definition?: GuestPortalDefinition }) {
  const current = await loadPortal(tx, here.tenantId, portalId);
  const definition = patch.definition ?? definitionOf(current.definition);
  if (num(current.version) !== expectedVersion) {
    await saveDraft(tx, here.tenantId, actor.id, portalId, "configure", expectedVersion, { name: patch.name ?? current.name, definition }, operationId);
    return { conflict: true as const, version: num(current.version) };
  }
  if (current.status === "revoked" && action !== "preview") {
    await saveDraft(tx, here.tenantId, actor.id, portalId, "configure", expectedVersion, { name: current.name, definition, rejected: action }, operationId);
    return { failed: true as const, code: "guest_portal_revoked", message: "This portal is revoked. The draft is kept." };
  }
  const status = patch.status ?? current.status;
  const name = patch.name ?? current.name;
  const updated = await tx.query<PortalRow>(
    `UPDATE hs_guest_portals SET status=$2, name=$3, definition=$4::jsonb, version=version+1, cache_generation=cache_generation+1, updated_at=clock_timestamp()
     WHERE id=$1 AND tenant_id=$5 AND version=$6
     RETURNING id, name, status, sharing, version, cache_generation, definition, created_by`,
    [portalId, status, name, JSON.stringify(definition), here.tenantId, expectedVersion],
  );
  const row = updated.rows[0];
  if (!row) return { conflict: true as const, version: num(current.version) };
  await revise(tx, row, actor, operationId, action);
  await audit(tx, actor, `guest-portal.${action}`, operationId, row.id, { status: row.status, cacheGeneration: num(row.cache_generation), version: num(row.version) });
  await track(tx, here.tenantId, row.id, actor, action, operationId, num(row.cache_generation), { status: row.status, version: num(row.version) });
  return present(row, definitionOf(row.definition));
}

export async function saveGuestPortal(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; portalId?: string; expectedVersion: number; name: string; definition: unknown }) {
  const name = guestPortalName(input.name);
  const definition = compileGuestPortal(input.definition);
  const requestHash = recordHash({ kind: "configure", workspaceId, portalId: input.portalId ?? null, expectedVersion: input.expectedVersion, name, definition });
  const outcome = await r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await hold(tx, here.tenantId);
    await requireManager(tx, here, actor);
    if (!await actionAllowed(tx, here.tenantId, actor.id, "configure", true)) throw forbidden();
    const replay = await prior<Outcome & { id?: string }>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    await requireScope(tx, here.tenantId, actor, definition);
    if (!input.portalId) {
      if (input.expectedVersion !== 0) {
        await saveDraft(tx, here.tenantId, actor.id, "new", "configure", input.expectedVersion, { name, definition }, input.operationId);
        return { conflict: true as const, version: 0 };
      }
      const id = randomUUID();
      const inserted = await tx.query<PortalRow>(
        `INSERT INTO hs_guest_portals(id,tenant_id,name,status,sharing,version,cache_generation,definition,created_by)
         VALUES($1,$2,$3,'draft','off',1,1,$4::jsonb,$5)
         RETURNING id, name, status, sharing, version, cache_generation, definition, created_by`,
        [id, here.tenantId, name, JSON.stringify(definition), actor.id],
      );
      const row = inserted.rows[0];
      await revise(tx, row, actor, input.operationId, "configure");
      await audit(tx, actor, "guest-portal.configure", input.operationId, row.id, { status: "draft", cacheGeneration: 1, version: 1 });
      await track(tx, here.tenantId, row.id, actor, "configure", input.operationId, 1, { status: "draft", version: 1 });
      const saved = definitionOf(row.definition);
      return remember(tx, actor.id, input.operationId, requestHash, { ...present(row, saved), audience: "guest-preview" as const, guestPreviewView: { screens: saved.screens, scope: saved.scope, fields: saved.fields, actions: saved.actions, expiry: saved.expiry, edge: saved.edge, domain: saved.domain, sharing: guestPortalSharing, accessGranted: false as const } });
    }
    const saved = await writePortal(tx, here, actor, input.operationId, "configure", input.portalId, input.expectedVersion, { name, definition });
    if ("conflict" in saved || "failed" in saved) return remember(tx, actor.id, input.operationId, requestHash, saved);
    return remember(tx, actor.id, input.operationId, requestHash, { ...saved, audience: "guest-preview" as const, guestPreviewView: { screens: definition.screens, scope: definition.scope, fields: definition.fields, actions: definition.actions, expiry: definition.expiry, edge: definition.edge, domain: definition.domain, sharing: guestPortalSharing, accessGranted: false as const } });
  });
  return settle(outcome);
}

export async function stashGuestPortal(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; portalId: string; expectedVersion: number; name: string; definition: unknown }) {
  const name = guestPortalName(input.name);
  const definition = compileGuestPortal(input.definition);
  const requestHash = recordHash({ kind: "stash", workspaceId, portalId: input.portalId, expectedVersion: input.expectedVersion, name, definition });
  const outcome = await r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await requireManager(tx, here, actor);
    const replay = await prior<{ version: number }>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    await loadPortal(tx, here.tenantId, input.portalId);
    await saveDraft(tx, here.tenantId, actor.id, input.portalId, "configure", input.expectedVersion, { name, definition }, input.operationId);
    return remember(tx, actor.id, input.operationId, requestHash, flags({ version: input.expectedVersion, stashed: true as const }));
  });
  return settle(outcome);
}

export async function discardGuestPortalDraft(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; portalId: string }) {
  const requestHash = recordHash({ kind: "discard-draft", workspaceId, portalId: input.portalId });
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await requireManager(tx, here, actor);
    const replay = await prior<{ discarded: true }>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    await tx.query("DELETE FROM hs_guest_portal_drafts WHERE tenant_id=$1 AND actor_id=$2 AND portal_key=$3", [here.tenantId, actor.id, input.portalId]);
    return remember(tx, actor.id, input.operationId, requestHash, flags({ discarded: true as const }));
  });
}

export async function previewGuestPortal(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; portalId: string; expectedVersion: number }) {
  const requestHash = recordHash({ kind: "preview", workspaceId, portalId: input.portalId, expectedVersion: input.expectedVersion });
  const outcome = await r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await hold(tx, here.tenantId);
    await requireManager(tx, here, actor);
    if (!await actionAllowed(tx, here.tenantId, actor.id, "preview", true)) throw forbidden();
    const replay = await prior<Outcome>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    const current = await loadPortal(tx, here.tenantId, input.portalId);
    const definition = definitionOf(current.definition);
    const status = current.status === "draft" ? "preview" as const : current.status;
    const saved = await writePortal(tx, here, actor, input.operationId, "preview", input.portalId, input.expectedVersion, { status });
    if ("conflict" in saved || "failed" in saved) return remember(tx, actor.id, input.operationId, requestHash, saved);
    const records = await visibleRecords(tx, here.tenantId, actor.id, definition);
    return remember(tx, actor.id, input.operationId, requestHash, { ...saved, audience: "admin-preview" as const, admitted: false as const, records: records.map(record => ({ id: record.id, name: record.name, version: record.version, values: record.values })) });
  });
  return settle(outcome);
}

export async function pauseGuestPortal(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; portalId: string; expectedVersion: number }) {
  const requestHash = recordHash({ kind: "pause", workspaceId, portalId: input.portalId, expectedVersion: input.expectedVersion });
  const outcome = await r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await hold(tx, here.tenantId);
    await requireManager(tx, here, actor);
    if (!await actionAllowed(tx, here.tenantId, actor.id, "pause", true)) throw forbidden();
    const replay = await prior<Outcome>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    const current = await loadPortal(tx, here.tenantId, input.portalId);
    if (current.status === "paused" && num(current.version) === input.expectedVersion) return remember(tx, actor.id, input.operationId, requestHash, { ...present(current, definitionOf(current.definition)), unchanged: true as const });
    const saved = await writePortal(tx, here, actor, input.operationId, "pause", input.portalId, input.expectedVersion, { status: "paused" });
    return remember(tx, actor.id, input.operationId, requestHash, saved);
  });
  return settle(outcome);
}

export async function revokeGuestPortal(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; portalId: string; expectedVersion: number }) {
  const requestHash = recordHash({ kind: "revoke", workspaceId, portalId: input.portalId, expectedVersion: input.expectedVersion });
  const outcome = await r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await hold(tx, here.tenantId);
    await requireManager(tx, here, actor);
    if (!await actionAllowed(tx, here.tenantId, actor.id, "revoke", true)) throw forbidden();
    const replay = await prior<Outcome>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    const saved = await writePortal(tx, here, actor, input.operationId, "revoke", input.portalId, input.expectedVersion, { status: "revoked" });
    return remember(tx, actor.id, input.operationId, requestHash, saved);
  });
  return settle(outcome);
}

export async function activateGuestPortal(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; portalId: string; expectedVersion: number }) {
  const requestHash = recordHash({ kind: "activate", workspaceId, portalId: input.portalId, expectedVersion: input.expectedVersion });
  const outcome = await r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await hold(tx, here.tenantId);
    await requireManager(tx, here, actor);
    const replay = await prior<Outcome>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    const current = await loadPortal(tx, here.tenantId, input.portalId);
    if (num(current.version) !== input.expectedVersion) {
      await saveDraft(tx, here.tenantId, actor.id, input.portalId, "configure", input.expectedVersion, { rejected: "activate" }, input.operationId);
      return { conflict: true as const, version: num(current.version) };
    }
    await audit(tx, actor, "guest-portal.activate-refused", input.operationId, current.id, { status: current.status, cacheGeneration: num(current.cache_generation), version: num(current.version) });
    return remember(tx, actor.id, input.operationId, requestHash, { failed: true as const, code: "guest_portal_sharing", message: guestPortalActivation, version: num(current.version), cacheGeneration: num(current.cache_generation) });
  });
  return settle(outcome);
}

export async function linkGuestIdentity(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; portalId: string; expectedVersion: number; suiteSubject: string }) {
  const suiteSubject = input.suiteSubject.trim();
  if (!suiteSubject || suiteSubject.length > 200) throw unavailable();
  const requestHash = recordHash({ kind: "link-identity", workspaceId, portalId: input.portalId, expectedVersion: input.expectedVersion, suiteSubject });
  const outcome = await r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await hold(tx, here.tenantId);
    await requireManager(tx, here, actor);
    if (!await actionAllowed(tx, here.tenantId, actor.id, "link", true)) throw forbidden();
    const replay = await prior<Outcome>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    const current = await loadPortal(tx, here.tenantId, input.portalId);
    const subject = await tx.query("SELECT 1 FROM hs_users WHERE id=$1", [suiteSubject]);
    if (!subject.rows.length) throw unavailable();
    if (num(current.version) !== input.expectedVersion) {
      await saveDraft(tx, here.tenantId, actor.id, input.portalId, "link", input.expectedVersion, { suiteSubject }, input.operationId);
      return { conflict: true as const, version: num(current.version) };
    }
    const existing = await tx.query("SELECT 1 FROM hs_guest_portal_identities WHERE portal_id=$1 AND suite_subject=$2", [input.portalId, suiteSubject]);
    if (!existing.rows.length) {
      await tx.query(
        `INSERT INTO hs_guest_portal_identities(portal_id,suite_subject,credentials_stored,invitation_sent,access_granted,version,linked_by)
         VALUES($1,$2,false,false,false,$3,$4)`,
        [input.portalId, suiteSubject, num(current.version), actor.id],
      );
    }
    const saved = await writePortal(tx, here, actor, input.operationId, "link-identity", input.portalId, input.expectedVersion, {});
    if ("conflict" in saved || "failed" in saved) return remember(tx, actor.id, input.operationId, requestHash, saved);
    return remember(tx, actor.id, input.operationId, requestHash, { ...saved, suiteSubject, identityConfigured: false as const });
  });
  return settle(outcome);
}

export async function setGuestPortalActions(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; userId: string; expectedVersion: number; actions: string[] }) {
  const actions: GuestPortalActorAction[] = [];
  for (const action of input.actions) {
    if (!guestPortalActorActions.includes(action as GuestPortalActorAction) || actions.includes(action as GuestPortalActorAction)) throw new DocumentError("Check the portal.", "guest_portal_validation", 422);
    actions.push(action as GuestPortalActorAction);
  }
  const requestHash = recordHash({ kind: "actions", workspaceId, userId: input.userId, expectedVersion: input.expectedVersion, actions });
  const outcome = await r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await hold(tx, here.tenantId);
    await requireManager(tx, here, actor);
    const replay = await prior<{ version: number }>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    if (!await member(tx, here.workspaceId, input.userId)) throw unavailable();
    const current = await tx.query<{ version: number | string }>("SELECT version FROM hs_guest_portal_actor_sets WHERE tenant_id=$1 AND user_id=$2", [here.tenantId, input.userId]);
    const version = current.rows[0] ? num(current.rows[0].version) : 0;
    if (version !== input.expectedVersion) {
      await saveDraft(tx, here.tenantId, actor.id, input.userId, "actions", input.expectedVersion, { actions }, input.operationId);
      return { conflict: true as const, version };
    }
    const next = version + 1;
    if (!current.rows[0]) await tx.query("INSERT INTO hs_guest_portal_actor_sets(tenant_id,user_id,version) VALUES($1,$2,$3)", [here.tenantId, input.userId, next]);
    else await tx.query("UPDATE hs_guest_portal_actor_sets SET version=$3 WHERE tenant_id=$1 AND user_id=$2", [here.tenantId, input.userId, next]);
    await tx.query("DELETE FROM hs_guest_portal_actor_actions WHERE tenant_id=$1 AND user_id=$2", [here.tenantId, input.userId]);
    for (const action of actions) await tx.query("INSERT INTO hs_guest_portal_actor_actions(tenant_id,user_id,action,granted_by) VALUES($1,$2,$3,$4)", [here.tenantId, input.userId, action, actor.id]);
    await audit(tx, actor, "guest-portal.actions", input.operationId, input.userId, { version: next, actions });
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
    if (!await member(tx, here.workspaceId, input.userId)) throw unavailable();
    if (grant) await tx.query("INSERT INTO hs_guest_portal_managers(workspace_id,user_id,granted_by) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [here.workspaceId, input.userId, actor.id]);
    else await tx.query("DELETE FROM hs_guest_portal_managers WHERE workspace_id=$1 AND user_id=$2", [here.workspaceId, input.userId]);
    await audit(tx, actor, grant ? "guest-portal.grant-manager" : "guest-portal.revoke-manager", input.operationId, input.userId, { userId: input.userId });
    return remember(tx, actor.id, input.operationId, requestHash, flags({ userId: input.userId, manager: grant }));
  });
}
export function grantGuestPortalManager(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; userId: string }) {
  return managerChange(r, actor, workspaceId, input, true);
}
export function revokeGuestPortalManager(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; userId: string }) {
  return managerChange(r, actor, workspaceId, input, false);
}

export async function submitGuestForm(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; portalId: string; recordId: string; expectedVersion: number; recordVersion: number; values: Record<string, string>; urlToken?: string | null; domain?: string | null }) {
  const requestHash = recordHash({ kind: "form", workspaceId, portalId: input.portalId, recordId: input.recordId, expectedVersion: input.expectedVersion, recordVersion: input.recordVersion, values: input.values });
  const outcome = await r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await hold(tx, here.tenantId);
    const replay = await prior<Outcome & { id?: string }>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    const row = await loadPortal(tx, here.tenantId, input.portalId);
    const definition = definitionOf(row.definition);
    await admit(tx, here, actor, row, definition, input);
    if (num(row.version) !== input.expectedVersion) {
      await saveDraft(tx, here.tenantId, actor.id, input.portalId, "form", input.expectedVersion, { recordId: input.recordId, rejected: "version" }, input.operationId);
      return { conflict: true as const, version: num(row.version) };
    }
    if (!definition.actions.includes("form") || !await actionAllowed(tx, here.tenantId, actor.id, "form", true)) throw forbidden();
    if (!definition.scope.recordIds.includes(input.recordId.toLowerCase())) throw unavailable();
    const record = await recordAccess(tx, here.tenantId, input.recordId.toLowerCase(), actor.id);
    if (!record || !record.view || !record.edit || record.collection !== definition.scope.collection) throw unavailable();
    if (record.version !== input.recordVersion) {
      await saveDraft(tx, here.tenantId, actor.id, input.portalId, "form", input.expectedVersion, { recordId: input.recordId, rejected: "record-version" }, input.operationId);
      return { conflict: true as const, version: num(row.version) };
    }
    const accepted: Record<string, string> = {};
    for (const [key, value] of Object.entries(input.values)) {
      const field = definition.fields.find(item => item.key.toLowerCase() === key.toLowerCase());
      const onForm = definition.screens.some(screen => screen.actions.includes("form") && screen.fields.some(item => item.toLowerCase() === key.toLowerCase()));
      if (!field || field.mode !== "edit" || !onForm || !await fieldDecision(tx, here.tenantId, record.collection, field.key, actor.id, "write")) {
        await saveDraft(tx, here.tenantId, actor.id, input.portalId, "form", input.expectedVersion, { recordId: input.recordId, rejected: "field" }, input.operationId);
        return { failed: true as const, code: "guest_portal_field", message: "That field is not permitted. Nothing was saved." };
      }
      try { accepted[field.key] = assertGuestText(value); }
      catch (error) {
        if (!(error instanceof DocumentError)) throw error;
        await saveDraft(tx, here.tenantId, actor.id, input.portalId, "form", input.expectedVersion, { recordId: input.recordId, rejected: "link" }, input.operationId);
        return { failed: true as const, code: "guest_portal_link", message: `${error.message} The draft is kept.` };
      }
    }
    if (!Object.keys(accepted).length) throw new DocumentError("Check the portal.", "guest_portal_validation", 422);
    const id = randomUUID();
    await tx.query(
      "INSERT INTO hs_guest_portal_submissions(id,tenant_id,portal_id,record_id,actor_id,version,portal_version,values,operation_id) VALUES($1,$2,$3,$4,$5,1,$6,$7::jsonb,$8)",
      [id, here.tenantId, row.id, input.recordId, actor.id, num(row.version), JSON.stringify(accepted), input.operationId],
    );
    await audit(tx, actor, "guest-portal.form", input.operationId, row.id, { recordId: input.recordId, fields: Object.keys(accepted), cacheGeneration: num(row.cache_generation) });
    await track(tx, here.tenantId, row.id, actor, "form", input.operationId, num(row.cache_generation), { recordId: input.recordId, fields: Object.keys(accepted) });
    return remember(tx, actor.id, input.operationId, requestHash, flags({ id, recordId: input.recordId, version: 1, portalVersion: num(row.version), values: accepted }));
  });
  return settle(outcome);
}

export async function addGuestComment(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; portalId: string; recordId: string; expectedVersion: number; body: string; urlToken?: string | null; domain?: string | null }) {
  const requestHash = recordHash({ kind: "comment", workspaceId, portalId: input.portalId, recordId: input.recordId, expectedVersion: input.expectedVersion, body: input.body });
  const outcome = await r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await hold(tx, here.tenantId);
    const replay = await prior<Outcome & { id?: string }>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    const row = await loadPortal(tx, here.tenantId, input.portalId);
    const definition = definitionOf(row.definition);
    await admit(tx, here, actor, row, definition, input);
    if (!definition.actions.includes("comment") || !await actionAllowed(tx, here.tenantId, actor.id, "comment", true)) throw forbidden();
    if (!definition.scope.recordIds.includes(input.recordId.toLowerCase())) throw unavailable();
    const record = await recordAccess(tx, here.tenantId, input.recordId.toLowerCase(), actor.id);
    if (!record || !record.view) throw unavailable();
    if (num(row.version) !== input.expectedVersion) {
      await saveDraft(tx, here.tenantId, actor.id, input.portalId, "comment", input.expectedVersion, { recordId: input.recordId, rejected: "version" }, input.operationId);
      return { conflict: true as const };
    }
    let body = "";
    try { body = assertGuestText(input.body); }
    catch (error) {
      if (!(error instanceof DocumentError)) throw error;
      await saveDraft(tx, here.tenantId, actor.id, input.portalId, "comment", input.expectedVersion, { recordId: input.recordId, rejected: "link" }, input.operationId);
      return { failed: true as const, code: "guest_portal_link", message: `${error.message} The draft is kept.` };
    }
    const id = randomUUID();
    await tx.query("INSERT INTO hs_guest_portal_comments(id,tenant_id,portal_id,record_id,actor_id,body,operation_id) VALUES($1,$2,$3,$4,$5,$6,$7)", [id, here.tenantId, row.id, input.recordId, actor.id, body, input.operationId]);
    await audit(tx, actor, "guest-portal.comment", input.operationId, row.id, { recordId: input.recordId, cacheGeneration: num(row.cache_generation) });
    await track(tx, here.tenantId, row.id, actor, "comment", input.operationId, num(row.cache_generation), { recordId: input.recordId });
    return remember(tx, actor.id, input.operationId, requestHash, flags({ id, recordId: input.recordId, body }));
  });
  return settle(outcome);
}

export async function citeGuestFile(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; portalId: string; recordId: string; expectedVersion: number; name: string; urlToken?: string | null; domain?: string | null }) {
  const requestHash = recordHash({ kind: "file", workspaceId, portalId: input.portalId, recordId: input.recordId, expectedVersion: input.expectedVersion, name: input.name });
  const outcome = await r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await hold(tx, here.tenantId);
    const replay = await prior<Outcome & { id?: string }>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    const row = await loadPortal(tx, here.tenantId, input.portalId);
    const definition = definitionOf(row.definition);
    await admit(tx, here, actor, row, definition, input);
    if (!definition.actions.includes("file") || !await actionAllowed(tx, here.tenantId, actor.id, "file", true)) throw forbidden();
    if (!definition.scope.recordIds.includes(input.recordId.toLowerCase())) throw unavailable();
    const record = await recordAccess(tx, here.tenantId, input.recordId.toLowerCase(), actor.id);
    if (!record || !record.view) throw unavailable();
    let cited: { name: string; fetched: false };
    try { cited = guestFileCitation(input.name); }
    catch (error) {
      if (!(error instanceof DocumentError)) throw error;
      await saveDraft(tx, here.tenantId, actor.id, input.portalId, "file", input.expectedVersion, { recordId: input.recordId, rejected: "link" }, input.operationId);
      return { failed: true as const, code: "guest_portal_link", message: `${error.message} The draft is kept.` };
    }
    const id = randomUUID();
    await tx.query("INSERT INTO hs_guest_portal_files(id,tenant_id,portal_id,record_id,actor_id,name,fetched,operation_id) VALUES($1,$2,$3,$4,$5,$6,false,$7)", [id, here.tenantId, row.id, input.recordId, actor.id, cited.name, input.operationId]);
    await audit(tx, actor, "guest-portal.file", input.operationId, row.id, { recordId: input.recordId, fetched: false, cacheGeneration: num(row.cache_generation) });
    await track(tx, here.tenantId, row.id, actor, "file", input.operationId, num(row.cache_generation), { recordId: input.recordId, fetched: false });
    return remember(tx, actor.id, input.operationId, requestHash, flags({ id, name: cited.name, fetched: false as const }));
  });
  return settle(outcome);
}

export async function downloadGuestPortal(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; portalId: string; expectedVersion: number; urlToken?: string | null; domain?: string | null }) {
  const requestHash = recordHash({ kind: "download", workspaceId, portalId: input.portalId, expectedVersion: input.expectedVersion });
  const outcome = await r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    const replay = await prior<{ body: string; version: number }>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    const row = await loadPortal(tx, here.tenantId, input.portalId);
    const definition = definitionOf(row.definition);
    if (num(row.version) !== input.expectedVersion) throw new DocumentError("The portal version changed. Nothing was overwritten.", "guest_portal_conflict", 409);
    const manage = await isManager(tx, here, actor);
    const admitted = evaluateGuestAccess(claimFor(actor, await member(tx, here.workspaceId, actor.id), input), await factsFor(tx, here, actor, row, definition)).allowed;
    if (!manage && !admitted) throw unavailable();
    if (!definition.actions.includes("export") || !await actionAllowed(tx, here.tenantId, actor.id, "download", true) || !await actionAllowed(tx, here.tenantId, actor.id, "export", true)) throw forbidden();
    const records = await visibleRecords(tx, here.tenantId, actor.id, definition);
    if (records.some(record => !record.export)) throw forbidden();
    const lines = [guestPortalDocument(definition, row.name), "", `Cache generation: ${num(row.cache_generation)}.`, "Cache: no-store."];
    for (const record of records) {
      lines.push(`## ${record.name}`);
      for (const [key, value] of Object.entries(record.values)) lines.push(`${key}: ${value}`);
    }
    const body = lines.join("\n");
    await audit(tx, actor, "guest-portal.download", input.operationId, row.id, { cacheGeneration: num(row.cache_generation), version: num(row.version) });
    return remember(tx, actor.id, input.operationId, requestHash, flags({ body, version: num(row.version), cacheGeneration: num(row.cache_generation) }));
  });
  return settle(outcome);
}
