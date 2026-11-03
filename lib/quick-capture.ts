import { randomUUID } from "node:crypto";
import type { Actor } from "./auth";
import type { Sql } from "./database";
import { DocumentError, validateDocument } from "./document";
import { formatIst } from "./ist-label";
import type { Repository } from "./repository";
import { recordHash } from "./shared-record-types";
import { quickCaptureOfflinePolicy, sourceAccessMessage, type QuickCaptureSourceAccess } from "./quick-capture-local";
import {
  assertCapturePolicy,
  captureDestinationKind,
  captureDocument,
  captureKinds,
  captureQuery,
  prepareCapture,
  quickCaptureActions,
  quickCaptureAssets,
  quickCaptureAssignment,
  quickCaptureBoundary,
  quickCaptureOffline,
  quickCaptureProvenance,
  quickCaptureRecoverable,
  quickCaptureSchedules,
  quickCaptureSharing,
  quickCaptureSource,
  quickCaptureVisibility,
  type CaptureAsset,
  type PreparedCapture,
  type QuickCaptureAction,
  type QuickCaptureDestination,
} from "./quick-capture-plan";

const unavailable = () => new DocumentError("Quick capture is restricted or unavailable.", "not_found", 404);
const forbidden = () => new DocumentError("This action is not permitted.", "action_forbidden", 403);
const mismatch = () => new DocumentError("This attempt was reused with different fields.", "operation_mismatch", 409);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Scope = { workspaceId: string; tenantId: string; role: string };
type FieldFlags = { sensitive: boolean; explicit: boolean; view: boolean; write: boolean; history: boolean };
type Destination = { kind: QuickCaptureDestination; id: string; name: string; collection: string | null; version: number | null };
type CaptureDetail = {
  kind: PreparedCapture["kind"];
  title: string;
  text: string;
  links: { href: string; label: string }[];
  assets: CaptureAsset[];
  excluded: string[];
  sourceUrl: string | null;
  sourceTitle: string | null;
  sourcePageId: string | null;
  sourceAccess: QuickCaptureSourceAccess;
  destinationKind: QuickCaptureDestination;
  destinationId: string;
  destinationName: string;
  formVersion: number | null;
  draftKey: string;
  policyVersion: number;
};
type CaptureRow = {
  id: string;
  kind: string;
  title: string;
  body: string;
  source_url: string | null;
  source_title: string | null;
  source_page_id: string | null;
  source_access: QuickCaptureSourceAccess;
  destination_kind: QuickCaptureDestination;
  destination_id: string;
  page_id: string | null;
  record_id: string | null;
  visibility: string;
  external_share: boolean;
  assets: unknown;
  excluded: unknown;
  version: number | string;
  policy_version: number | string;
  owner_id: string;
  created_at: string | Date;
};
type Shown = { row: CaptureRow; field: FieldFlags; history: boolean; download: boolean };
type Outcome = { conflict?: boolean; failed?: boolean; previewStale?: boolean; message?: string; code?: string };
export type CaptureCommand = {
  kind: string;
  title: string;
  body?: string;
  sourceUrl?: string;
  sourceTitle?: string;
  sourcePageId?: string;
  sourceAccess?: string;
  destinationKind?: string;
  destinationId?: string;
  assets?: { name: string; selected: boolean }[];
  draftKey?: string;
};
type CaptureAttempt = CaptureCommand & { operationId: string; expectedVersion: number };
export type CapturePreview = {
  previewId: string;
  action: "capture";
  version: number;
  review: string;
  text: string;
  audience: typeof quickCaptureVisibility;
  externalShare: false;
  sourceAccess: QuickCaptureSourceAccess;
  sourceStatement: string;
  excluded: string[];
  assets: CaptureAsset[];
  destinationKind: QuickCaptureDestination;
  destinationName: string;
  replayed: boolean;
};
export type SavedCapture = ReturnType<typeof viewOf>;

const copy = () => ({
  boundary: quickCaptureBoundary,
  assignment: quickCaptureAssignment,
  sharing: quickCaptureSharing,
  offline: quickCaptureOffline,
  schedules: quickCaptureSchedules,
  recoverable: quickCaptureRecoverable,
  provenance: quickCaptureProvenance,
  assets: quickCaptureAssets,
});

function settle<T extends object>(result: T): T {
  const value = result as T & Outcome;
  if (value.previewStale) throw new DocumentError("Review the capture again. The destination or source changed. The draft is kept.", "quick_capture_preview", 409);
  if (value.failed) throw new DocumentError(value.message ?? "The source page is not available to you. Nothing was fetched.", value.code ?? "quick_capture_source", 409);
  if (value.conflict) throw new DocumentError("The capture version changed. The draft is kept.", "quick_capture_conflict", 409);
  return result;
}
function on(value: unknown) { return value === true || value === "t" || value === "true" || value === 1; }
function num(value: number | string | null | undefined) { return Number(value ?? 0); }
function asJson<T>(value: unknown): T { return (typeof value === "string" ? JSON.parse(value) : value) as T; }
function textList(value: unknown) {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
}
function assetsOf(value: unknown): CaptureAsset[] {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  if (!Array.isArray(parsed)) return [];
  return parsed.flatMap(item => {
    if (!item || typeof item !== "object") return [];
    const name = (item as { name?: unknown }).name;
    return typeof name === "string" && name ? [{ name, imported: true as const, fetched: false as const }] : [];
  });
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
async function audit(tx: Sql, actor: Actor, action: string, operationId: string, subjectId: string, pageId: string | null, after: Record<string, unknown>) {
  await tx.query(
    "INSERT INTO hs_audit(id,actor_id,action,page_id,subject_id,after_value,correlation_id) VALUES($1,$2,$3,$4,$5,$6,$7)",
    [randomUUID(), actor.id, action, pageId, subjectId, JSON.stringify({ source: quickCaptureSource, operationId, atIst: formatIst(new Date()), visibility: quickCaptureVisibility, externalShare: false, ...after }), operationId],
  );
}
async function track(tx: Sql, tenantId: string, actor: Actor, action: string, operationId: string, captureId: string | null, detail: Record<string, unknown>) {
  await tx.query(
    "INSERT INTO hs_quick_capture_events(id,tenant_id,capture_id,action,actor_id,operation_id,source,detail) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
    [randomUUID(), tenantId, captureId, action, actor.id, operationId, quickCaptureSource, JSON.stringify(detail)],
  );
}
async function prior<T extends object>(tx: Sql, actorId: string, operationId: string, requestHash: string): Promise<(T & { replayed: true }) | null> {
  const row = await tx.query<{ request_hash: string; result: unknown }>("SELECT request_hash, result FROM hs_quick_capture_operations WHERE actor_id=$1 AND operation_id=$2", [actorId, operationId]);
  if (!row.rows[0]) return null;
  if (row.rows[0].request_hash !== requestHash) throw mismatch();
  return { ...asJson<T>(row.rows[0].result), replayed: true };
}
async function remember<T extends object>(tx: Sql, actorId: string, operationId: string, requestHash: string, result: T) {
  const stored = { ...result, replayed: false as const };
  await tx.query("INSERT INTO hs_quick_capture_operations(actor_id,operation_id,request_hash,result) VALUES($1,$2,$3,$4)", [actorId, operationId, requestHash, JSON.stringify(stored)]);
  return stored;
}
async function fieldFlags(tx: Sql, tenantId: string, userId: string): Promise<FieldFlags> {
  const policy = await tx.query<{ sensitive: boolean }>("SELECT sensitive FROM hs_quick_capture_field_policy WHERE tenant_id=$1", [tenantId]);
  const access = await tx.query<{ can_view: boolean; can_write: boolean; can_history: boolean }>("SELECT can_view, can_write, can_history FROM hs_quick_capture_field_access WHERE tenant_id=$1 AND user_id=$2", [tenantId, userId]);
  const sensitive = policy.rows[0] ? on(policy.rows[0].sensitive) : false;
  const row = access.rows[0];
  if (!row) return { sensitive, explicit: false, view: !sensitive, write: false, history: !sensitive };
  return { sensitive, explicit: true, view: on(row.can_view), write: on(row.can_write), history: on(row.can_history) };
}
function canRead(field: FieldFlags) { return field.sensitive || field.explicit ? field.view : true; }
function canWrite(field: FieldFlags) { return field.sensitive || field.explicit ? field.write : true; }
function canHistory(field: FieldFlags) { return field.sensitive || field.explicit ? field.history : true; }
async function actionAllowed(tx: Sql, tenantId: string, userId: string, action: QuickCaptureAction, base: boolean) {
  if (!base) return false;
  const rows = await tx.query<{ action: string }>("SELECT action FROM hs_quick_capture_actions WHERE tenant_id=$1 AND user_id=$2", [tenantId, userId]);
  if (!rows.rows.length) return true;
  return rows.rows.some(row => row.action === action);
}
async function policyOf(tx: Sql, tenantId: string) {
  const row = await tx.query<{ version: number | string; default_destination: QuickCaptureDestination; visibility: string; inherit_external: boolean; offline_policy: string; kinds: unknown }>(
    "SELECT version, default_destination, visibility, inherit_external, offline_policy, kinds FROM hs_quick_capture_policies WHERE tenant_id=$1",
    [tenantId],
  );
  const policy = row.rows[0];
  if (!policy) return null;
  return {
    version: num(policy.version),
    defaultDestination: policy.default_destination,
    visibility: quickCaptureVisibility,
    inheritExternal: false as const,
    offlinePolicy: quickCaptureOfflinePolicy,
    kinds: textList(policy.kinds),
  };
}
async function policyDraft(tx: Sql, tenantId: string, actorId: string) {
  const row = await tx.query<{ base_version: number | string; default_destination: string; kinds: unknown }>(
    "SELECT base_version, default_destination, kinds FROM hs_quick_capture_policy_drafts WHERE tenant_id=$1 AND actor_id=$2",
    [tenantId, actorId],
  );
  if (!row.rows[0]) return null;
  return { baseVersion: num(row.rows[0].base_version), defaultDestination: row.rows[0].default_destination, kinds: textList(row.rows[0].kinds) };
}
async function listSpaces(tx: Sql, workspaceId: string, actorId: string) {
  const rows = await tx.query<{ id: string; name: string }>(
    `SELECT s.id, s.name FROM hs_spaces s
     JOIN hs_members m ON m.workspace_id=s.workspace_id AND m.user_id=$2 AND m.active=true
     WHERE s.workspace_id=$1 AND s.archived_at IS NULL AND m.role <> 'observer'
     AND (s.directory_visibility <> 'private' OR m.role IN ('owner','admin') OR EXISTS (
       SELECT 1 FROM hs_space_members sm WHERE sm.space_id=s.id AND sm.user_id=$2 AND sm.active=true))
     ORDER BY s.name, s.id`,
    [workspaceId, actorId],
  );
  return rows.rows;
}
async function listForms(tx: Sql, tenantId: string, actorId: string) {
  const rows = await tx.query<{ id: string; name: string; collection: string; version: number | string }>(
    `SELECT f.id::text, f.name, f.collection, f.version
     FROM hs_data_intake_forms f
     JOIN hs_data_collection_grants g ON g.tenant_id=f.tenant_id AND g.collection=f.collection AND g.user_id=$2
     WHERE f.tenant_id=$1 AND f.deprecated=false AND f.collection NOT IN ('accounts','contracts')
     AND 'view'=ANY(g.capabilities) AND 'create'=ANY(g.capabilities)
     ORDER BY f.name, f.id`,
    [tenantId, actorId],
  );
  return rows.rows.map(row => ({ id: row.id, name: row.name, collection: row.collection, version: num(row.version) }));
}
async function resolveDestination(tx: Sql, here: Scope, actor: Actor, kind: QuickCaptureDestination | null, id: string | null, fallback: QuickCaptureDestination): Promise<Destination> {
  const spaces = await listSpaces(tx, here.workspaceId, actor.id);
  const forms = await listForms(tx, here.tenantId, actor.id);
  if (id) {
    if (kind === "space") {
      const space = spaces.find(item => item.id === id);
      if (!space) throw new DocumentError("That destination is not permitted.", "quick_capture_destination", 409);
      return { kind: "space", id: space.id, name: space.name, collection: null, version: null };
    }
    const form = forms.find(item => item.id === id);
    if (!form) throw new DocumentError("That destination is not permitted.", "quick_capture_destination", 409);
    return { kind: "intake", id: form.id, name: form.name, collection: form.collection, version: form.version };
  }
  if ((kind ?? fallback) === "intake" && forms[0]) return { kind: "intake", id: forms[0].id, name: forms[0].name, collection: forms[0].collection, version: forms[0].version };
  if ((kind ?? fallback) === "space" && spaces[0]) return { kind: "space", id: spaces[0].id, name: spaces[0].name, collection: null, version: null };
  if (spaces[0]) return { kind: "space", id: spaces[0].id, name: spaces[0].name, collection: null, version: null };
  throw new DocumentError("No permitted private destination.", "quick_capture_destination", 409);
}
async function assessSource(r: Repository, tx: Sql, here: Scope, actor: Actor, pageId: string | null): Promise<QuickCaptureSourceAccess> {
  if (!pageId) return "not-opened";
  try {
    const page = await r.access(tx, pageId, actor);
    return page.workspace_id === here.workspaceId ? "permitted" : "unavailable";
  } catch (error) {
    if (error instanceof DocumentError && error.status === 404) return "unavailable";
    throw error;
  }
}
function detailOf(prepared: PreparedCapture, destination: Destination, policyVersion: number): CaptureDetail {
  return {
    kind: prepared.kind, title: prepared.title, text: prepared.text, links: prepared.links, assets: prepared.assets, excluded: prepared.excluded,
    sourceUrl: prepared.sourceUrl, sourceTitle: prepared.sourceTitle, sourcePageId: prepared.sourcePageId, sourceAccess: prepared.sourceAccess,
    destinationKind: destination.kind, destinationId: destination.id, destinationName: destination.name, formVersion: destination.version,
    draftKey: prepared.draftKey, policyVersion,
  };
}
function sealOf(detail: CaptureDetail) {
  return recordHash({ ...detail, visibility: quickCaptureVisibility, inheritExternal: false, offlinePolicy: quickCaptureOfflinePolicy, fetched: false });
}
function plainBody(detail: CaptureDetail, capturedAt: string) {
  return [
    detail.text,
    ...detail.assets.map(asset => `Selected asset: ${asset.name}`),
    ...detail.links.map(link => link.href),
    detail.sourceTitle ? `Source title: ${detail.sourceTitle}` : "",
    detail.sourceUrl ? `Source address: ${detail.sourceUrl}` : "",
    `Source access: ${detail.sourceAccess}.`,
    sourceAccessMessage(detail.sourceAccess, detail.sourceUrl ?? ""),
    `Captured ${capturedAt}.`,
  ].filter(Boolean).join("\n");
}
async function saveDraft(tx: Sql, tenantId: string, actorId: string, detail: CaptureDetail, operationId: string, baseVersion: number) {
  await tx.query(
    `INSERT INTO hs_quick_capture_drafts(tenant_id,actor_id,draft_key,base_version,payload,operation_id)
     VALUES($1,$2,$3,$4,$5,$6)
     ON CONFLICT (tenant_id, actor_id, draft_key)
     DO UPDATE SET base_version=$4, payload=$5, operation_id=$6, updated_at=clock_timestamp()`,
    [tenantId, actorId, detail.draftKey, baseVersion, JSON.stringify(detail), operationId],
  );
}
function viewOf(row: CaptureRow, replayed = false) {
  const assets = assetsOf(row.assets);
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    body: row.body,
    sourceUrl: row.source_url,
    sourceTitle: row.source_title,
    sourceAccess: row.source_access,
    sourceStatement: sourceAccessMessage(row.source_access, row.source_url ?? ""),
    destinationKind: row.destination_kind,
    destinationId: row.destination_id,
    pageId: row.page_id,
    recordId: row.record_id,
    visibility: quickCaptureVisibility,
    externalShare: false as const,
    assets,
    excluded: textList(row.excluded),
    version: num(row.version),
    policyVersion: num(row.policy_version),
    ownerId: row.owner_id,
    capturedAt: formatIst(row.created_at),
    provenance: quickCaptureProvenance,
    sharing: quickCaptureSharing,
    replayed,
  };
}
async function showCapture(r: Repository, tx: Sql, here: Scope, actor: Actor, row: CaptureRow): Promise<Shown | null> {
  const field = await fieldFlags(tx, here.tenantId, actor.id);
  if (!canRead(field)) return null;
  if (row.page_id) {
    try {
      const page = await r.access(tx, row.page_id, actor);
      if (page.workspace_id !== here.workspaceId) return null;
      const elevated = page.role === "owner" || page.role === "editor";
      return { row, field, history: elevated, download: elevated };
    } catch (error) {
      if (error instanceof DocumentError && error.status === 404) return null;
      throw error;
    }
  }
  if (!row.record_id || !uuidPattern.test(row.record_id)) return null;
  const record = await tx.query<{ view: boolean; history: boolean; download: boolean }>(
    `SELECT
       ('view'=ANY(g.capabilities) OR EXISTS(SELECT 1 FROM hs_data_record_grants rg WHERE rg.tenant_id=r.tenant_id AND rg.record_id=r.id AND rg.user_id=$3 AND 'view'=ANY(rg.capabilities))) AS view,
       ('history'=ANY(g.capabilities) OR EXISTS(SELECT 1 FROM hs_data_record_grants rg WHERE rg.tenant_id=r.tenant_id AND rg.record_id=r.id AND rg.user_id=$3 AND 'history'=ANY(rg.capabilities))) AS history,
       ('export'=ANY(g.capabilities) OR EXISTS(SELECT 1 FROM hs_data_record_grants rg WHERE rg.tenant_id=r.tenant_id AND rg.record_id=r.id AND rg.user_id=$3 AND 'export'=ANY(rg.capabilities))) AS download
     FROM hs_data_records r
     LEFT JOIN hs_data_collection_grants g ON g.tenant_id=r.tenant_id AND g.user_id=$3 AND g.collection=r.collection
     WHERE r.id=$1 AND r.tenant_id=$2 AND r.state='active'`,
    [row.record_id, here.tenantId, actor.id],
  );
  const access = record.rows[0];
  if (!access || !on(access.view)) return null;
  return { row, field, history: on(access.history), download: on(access.download) };
}
async function requireShown(r: Repository, tx: Sql, here: Scope, actor: Actor, captureId: string) {
  if (!uuidPattern.test(captureId)) throw unavailable();
  const row = await tx.query<CaptureRow>("SELECT * FROM hs_quick_captures WHERE id=$1 AND tenant_id=$2", [captureId, here.tenantId]);
  if (!row.rows[0]) throw unavailable();
  const shown = await showCapture(r, tx, here, actor, row.rows[0]);
  if (!shown) throw unavailable();
  return shown;
}
async function createPrivatePage(r: Repository, tx: Sql, actor: Actor, workspaceId: string, spaceId: string, title: string, detail: CaptureDetail, capturedAt: string) {
  const space = await tx.query<{ workspace_id: string }>(
    `SELECT s.workspace_id FROM hs_spaces s
     JOIN hs_members m ON m.workspace_id=s.workspace_id AND m.user_id=$2 AND m.active=true
     WHERE s.id=$1 AND s.workspace_id=$3 AND s.archived_at IS NULL AND m.role <> 'observer'
     AND (s.directory_visibility <> 'private' OR m.role IN ('owner','admin') OR EXISTS (
       SELECT 1 FROM hs_space_members sm WHERE sm.space_id=s.id AND sm.user_id=$2 AND sm.active=true))`,
    [spaceId, actor.id, workspaceId],
  );
  if (!space.rows[0]) throw new DocumentError("That destination is not permitted.", "quick_capture_destination", 409);
  const pageId = randomUUID();
  await tx.query("INSERT INTO hs_pages(id,workspace_id,space_id,parent_id,owner_id,title,visibility) VALUES($1,$2,$3,NULL,$4,$5,'private')", [pageId, workspaceId, spaceId, actor.id, title]);
  const document = validateDocument(captureDocument({
    text: detail.text, links: detail.links, assets: detail.assets, sourceUrl: detail.sourceUrl, sourceTitle: detail.sourceTitle,
    sourceAccess: detail.sourceAccess, capturedAt,
  }, () => randomUUID()));
  await r.writeDocument(tx, pageId, document, 1, title, actor.id, quickCaptureSource);
  const created = await tx.query<{ visibility: string; grants: number | string }>("SELECT visibility, (SELECT count(*) FROM hs_grants g WHERE g.page_id=p.id) AS grants FROM hs_pages p WHERE p.id=$1", [pageId]);
  if (created.rows[0]?.visibility !== "private" || num(created.rows[0]?.grants) !== 0) throw new DocumentError(quickCaptureSharing, "quick_capture_sharing", 409);
  return pageId;
}
async function createIntakeRecord(tx: Sql, tenantId: string, actor: Actor, detail: CaptureDetail, capturedAt: string) {
  const form = await tx.query<{ collection: string; version: number | string; deprecated: boolean }>(
    "SELECT collection, version, deprecated FROM hs_data_intake_forms WHERE id=$1 AND tenant_id=$2",
    [detail.destinationId, tenantId],
  );
  const current = form.rows[0];
  if (!current || on(current.deprecated) || current.collection === "accounts" || current.collection === "contracts" || num(current.version) !== detail.formVersion) return null;
  const allowed = await tx.query(
    "SELECT 1 FROM hs_data_collection_grants WHERE tenant_id=$1 AND user_id=$2 AND collection=$3 AND 'view'=ANY(capabilities) AND 'create'=ANY(capabilities)",
    [tenantId, actor.id, current.collection],
  );
  if (!allowed.rows.length) return null;
  const recordId = randomUUID();
  await tx.query(
    "INSERT INTO hs_data_records(id,tenant_id,collection,name,field_values,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$6)",
    [recordId, tenantId, current.collection, detail.title, JSON.stringify({ "core:notes": plainBody(detail, capturedAt) }), actor.id],
  );
  const grants = await tx.query<{ n: number | string }>("SELECT count(*) AS n FROM hs_data_record_grants WHERE record_id=$1", [recordId]);
  if (num(grants.rows[0]?.n) !== 0) throw new DocumentError(quickCaptureSharing, "quick_capture_sharing", 409);
  return recordId;
}

export async function quickCaptureCatalogue(r: Repository, actor: Actor, workspaceId: string) {
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    const policy = await policyOf(tx, here.tenantId);
    const draft = await policyDraft(tx, here.tenantId, actor.id);
    const spaces = await listSpaces(tx, here.workspaceId, actor.id);
    const forms = await listForms(tx, here.tenantId, actor.id);
    const prefer = policy?.defaultDestination ?? "space";
    const fallback = prefer === "intake" && forms[0] ? { kind: "intake" as const, id: forms[0].id, name: forms[0].name } : spaces[0] ? { kind: "space" as const, id: spaces[0].id, name: spaces[0].name } : null;
    const operator = (await tx.query("SELECT 1 FROM hs_quick_capture_operators WHERE workspace_id=$1 AND user_id=$2", [here.workspaceId, actor.id])).rows.length > 0;
    const rows = await tx.query<CaptureRow>("SELECT * FROM hs_quick_captures WHERE tenant_id=$1 ORDER BY created_at DESC, id LIMIT 100", [here.tenantId]);
    const captures = [];
    for (const row of rows.rows) {
      const shown = await showCapture(r, tx, here, actor, row);
      if (!shown) continue;
      captures.push({ id: row.id, title: row.title, kind: row.kind, destinationKind: row.destination_kind, sourceAccess: row.source_access, version: num(row.version), visibility: quickCaptureVisibility, externalShare: false as const });
      if (captures.length >= 50) break;
    }
    const drafts = await tx.query<{ draft_key: string; base_version: number | string; payload: unknown }>("SELECT draft_key, base_version, payload FROM hs_quick_capture_drafts WHERE tenant_id=$1 AND actor_id=$2 ORDER BY draft_key", [here.tenantId, actor.id]);
    return {
      ...copy(),
      actorId: actor.id,
      manage: here.role === "owner" || here.role === "admin",
      operator,
      policy: { version: policy?.version ?? 0, defaultDestination: policy?.defaultDestination ?? "space", visibility: quickCaptureVisibility, inheritExternal: false as const, offlinePolicy: quickCaptureOfflinePolicy, kinds: policy?.kinds ?? ["text", "link", "note"], recoverableDraft: draft },
      destinations: { spaces, forms },
      defaultDestination: fallback,
      captures,
      drafts: drafts.rows.map(item => ({ draftKey: item.draft_key, baseVersion: num(item.base_version), payload: asJson<CaptureDetail>(item.payload) })),
    };
  });
}

export async function readQuickCapture(r: Repository, actor: Actor, workspaceId: string, captureId: string) {
  return r.db.transaction(async tx => viewOf((await requireShown(r, tx, await scopeOf(tx, workspaceId, actor), actor, captureId)).row));
}

export async function searchQuickCapture(r: Repository, actor: Actor, workspaceId: string, query: string) {
  const needle = captureQuery(query);
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    if (!await actionAllowed(tx, here.tenantId, actor.id, "search", true)) throw forbidden();
    const rows = await tx.query<CaptureRow>("SELECT * FROM hs_quick_captures WHERE tenant_id=$1 ORDER BY created_at DESC, id LIMIT 200", [here.tenantId]);
    const results = [];
    for (const row of rows.rows) {
      const shown = await showCapture(r, tx, here, actor, row);
      if (!shown || !await actionAllowed(tx, here.tenantId, actor.id, "search", true)) continue;
      const hay = `${row.title}\n${row.source_title ?? ""}\n${row.kind}\n${canRead(shown.field) ? row.body : ""}`.toLocaleLowerCase();
      if (!hay.includes(needle)) continue;
      results.push({ id: row.id, title: row.title, kind: row.kind, sourceAccess: row.source_access, visibility: quickCaptureVisibility, externalShare: false as const });
      if (results.length >= 50) break;
    }
    return { results, assignment: quickCaptureAssignment };
  });
}

export async function quickCaptureHistory(r: Repository, actor: Actor, workspaceId: string, captureId: string) {
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    const shown = await requireShown(r, tx, here, actor, captureId);
    if (!canHistory(shown.field) || !await actionAllowed(tx, here.tenantId, actor.id, "history", shown.history)) throw forbidden();
    const events = await tx.query<{ action: string; actor_id: string; actor_name: string; operation_id: string; source: string; created_at: string | Date; detail: unknown }>(
      `SELECT e.action, e.actor_id, u.name AS actor_name, e.operation_id::text, e.source, e.created_at, e.detail
       FROM hs_quick_capture_events e JOIN hs_users u ON u.id=e.actor_id
       WHERE e.tenant_id=$1 AND e.capture_id=$2 ORDER BY e.created_at, e.id`,
      [here.tenantId, captureId],
    );
    return {
      events: events.rows.map(event => {
        const detail = asJson<{ sourceAccess?: string }>(event.detail);
        return { action: event.action, actorId: event.actor_id, actorName: event.actor_name, operationId: event.operation_id, source: event.source, atIst: formatIst(event.created_at), sourceAccess: detail.sourceAccess ?? null };
      }),
      capture: { id: shown.row.id, title: shown.row.title, visibility: quickCaptureVisibility },
    };
  });
}

export async function quickCaptureSourcePreview(r: Repository, actor: Actor, workspaceId: string, captureId: string) {
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    const shown = await requireShown(r, tx, here, actor, captureId);
    if (!await actionAllowed(tx, here.tenantId, actor.id, "preview", true)) throw forbidden();
    return {
      title: shown.row.title,
      text: shown.row.body,
      sourceAccess: shown.row.source_access,
      sourceStatement: sourceAccessMessage(shown.row.source_access, shown.row.source_url ?? ""),
      assets: assetsOf(shown.row.assets),
      excluded: textList(shown.row.excluded),
      visibility: quickCaptureVisibility,
      externalShare: false as const,
      provenance: quickCaptureProvenance,
    };
  });
}

export async function downloadQuickCapture(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; captureId: string; expectedVersion: number }) {
  const requestHash = recordHash({ kind: "download", workspaceId, captureId: input.captureId, expectedVersion: input.expectedVersion });
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    const replay = await prior<{ body: string; version: number }>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    const shown = await requireShown(r, tx, here, actor, input.captureId);
    if (num(shown.row.version) !== input.expectedVersion) throw new DocumentError("The capture version changed. Nothing was overwritten.", "quick_capture_conflict", 409);
    if (!canRead(shown.field) || !await actionAllowed(tx, here.tenantId, actor.id, "download", shown.download)) throw forbidden();
    const body = [`# ${shown.row.title}`, "", shown.row.body, "", "Audience: private.", "External sharing: none.", quickCaptureProvenance].join("\n");
    await audit(tx, actor, "quick-capture.download", input.operationId, shown.row.id, shown.row.page_id, { sourceAccess: shown.row.source_access });
    return remember(tx, actor.id, input.operationId, requestHash, { body, version: num(shown.row.version), visibility: quickCaptureVisibility, externalShare: false as const });
  });
}

async function preparedFrom(tx: Sql, here: Scope, input: CaptureCommand) {
  const policy = await policyOf(tx, here.tenantId);
  const version = policy?.version ?? 0;
  const allowed = policy?.kinds ?? ["text", "link", "note"];
  const prepared = prepareCapture({ ...input, allowedKinds: allowed });
  return { prepared, version, fallback: policy?.defaultDestination ?? "space" as const };
}

export async function previewQuickCapture(r: Repository, actor: Actor, workspaceId: string, input: CaptureAttempt): Promise<CapturePreview> {
  const outcome = await r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await hold(tx, here.tenantId);
    if (here.role === "observer") throw unavailable();
    const { prepared, version, fallback } = await preparedFrom(tx, here, input);
    const field = await fieldFlags(tx, here.tenantId, actor.id);
    if (!canWrite(field) || !await actionAllowed(tx, here.tenantId, actor.id, "preview", true)) throw forbidden();
    const actual = await assessSource(r, tx, here, actor, prepared.sourcePageId);
    const claimed = input.sourceAccess && input.sourceAccess !== actual;
    prepared.sourceAccess = actual;
    if (claimed || actual === "unavailable") {
      const detail = detailOf(prepared, { kind: prepared.destinationKind ?? fallback, id: prepared.destinationId ?? "unresolved", name: "Unresolved", collection: null, version: null }, version);
      const requestHash = recordHash({ kind: "preview-source", workspaceId, expectedVersion: input.expectedVersion, detail });
      const replay = await prior<Outcome>(tx, actor.id, input.operationId, requestHash);
      if (replay) return replay;
      await saveDraft(tx, here.tenantId, actor.id, detail, input.operationId, version);
      return remember(tx, actor.id, input.operationId, requestHash, { failed: true as const, code: "quick_capture_source", message: sourceAccessMessage(actual, prepared.sourceUrl ?? ""), recoverable: true as const });
    }
    let destination: Destination;
    try { destination = await resolveDestination(tx, here, actor, prepared.destinationKind, prepared.destinationId, fallback); }
    catch (error) {
      if (!(error instanceof DocumentError)) throw error;
      const detail = detailOf(prepared, { kind: prepared.destinationKind ?? fallback, id: prepared.destinationId ?? "unresolved", name: "Unresolved", collection: null, version: null }, version);
      const requestHash = recordHash({ kind: "preview-destination", workspaceId, expectedVersion: input.expectedVersion, detail });
      const replay = await prior<Outcome>(tx, actor.id, input.operationId, requestHash);
      if (replay) return replay;
      await saveDraft(tx, here.tenantId, actor.id, detail, input.operationId, version);
      return remember(tx, actor.id, input.operationId, requestHash, { failed: true as const, code: "quick_capture_destination", message: `${error.message} The draft is kept.`, recoverable: true as const });
    }
    const detail = detailOf(prepared, destination, version);
    const requestHash = recordHash({ kind: "preview", workspaceId, expectedVersion: input.expectedVersion, detail });
    const replay = await prior<{ previewId: string }>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    if (version !== input.expectedVersion) {
      await saveDraft(tx, here.tenantId, actor.id, detail, input.operationId, input.expectedVersion);
      return remember(tx, actor.id, input.operationId, requestHash, { conflict: true as const, recoverable: true as const, version });
    }
    const previewId = randomUUID();
    await tx.query("INSERT INTO hs_quick_capture_previews(id,tenant_id,actor_id,expected_version,seal,detail) VALUES($1,$2,$3,$4,$5,$6)", [previewId, here.tenantId, actor.id, version, sealOf(detail), JSON.stringify(detail)]);
    const review = [`Save this ${detail.kind} to ${destination.name}.`, "Audience: private. External sharing is not inherited.", sourceAccessMessage(detail.sourceAccess, detail.sourceUrl ?? ""), detail.excluded.length ? `Removed: ${detail.excluded.join(", ")}.` : "Nothing hidden was kept.", detail.assets.length ? "Selected assets are cited and were not downloaded." : "No source asset was imported."].join(" ");
    return remember(tx, actor.id, input.operationId, requestHash, {
      previewId, action: "capture" as const, version, review, text: detail.text, audience: quickCaptureVisibility, externalShare: false as const,
      sourceAccess: detail.sourceAccess, sourceStatement: sourceAccessMessage(detail.sourceAccess, detail.sourceUrl ?? ""), excluded: detail.excluded,
      assets: detail.assets, destinationKind: destination.kind, destinationName: destination.name,
    });
  });
  return settle(outcome) as CapturePreview;
}

export async function applyQuickCapture(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; previewId: string; expectedVersion: number }): Promise<SavedCapture> {
  const requestHash = recordHash({ kind: "apply", workspaceId, previewId: input.previewId, expectedVersion: input.expectedVersion });
  const outcome = await r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await hold(tx, here.tenantId);
    if (here.role === "observer") throw unavailable();
    const replay = await prior<Outcome & { id?: string }>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    if (!uuidPattern.test(input.previewId)) throw unavailable();
    const preview = await tx.query<{ expected_version: number | string; seal: string; detail: unknown; actor_id: string }>("SELECT expected_version, seal, detail, actor_id FROM hs_quick_capture_previews WHERE id=$1 AND tenant_id=$2", [input.previewId, here.tenantId]);
    const stored = preview.rows[0];
    if (!stored || stored.actor_id !== actor.id) throw unavailable();
    const detail = asJson<CaptureDetail>(stored.detail);
    const field = await fieldFlags(tx, here.tenantId, actor.id);
    if (!canWrite(field) || !await actionAllowed(tx, here.tenantId, actor.id, "commit", true)) throw forbidden();
    const policy = await policyOf(tx, here.tenantId);
    const version = policy?.version ?? 0;
    const actual = await assessSource(r, tx, here, actor, detail.sourcePageId);
    const stale = version !== input.expectedVersion || num(stored.expected_version) !== input.expectedVersion || actual !== detail.sourceAccess || sealOf({ ...detail, policyVersion: version }) !== stored.seal;
    if (actual === "unavailable" || stale) {
      await saveDraft(tx, here.tenantId, actor.id, { ...detail, sourceAccess: actual, policyVersion: version }, input.operationId, input.expectedVersion);
      if (actual === "unavailable") return remember(tx, actor.id, input.operationId, requestHash, { failed: true as const, code: "quick_capture_source", message: sourceAccessMessage("unavailable", detail.sourceUrl ?? ""), recoverable: true as const });
      return remember(tx, actor.id, input.operationId, requestHash, { previewStale: true as const, recoverable: true as const });
    }
    let destination: Destination;
    try { destination = await resolveDestination(tx, here, actor, detail.destinationKind, detail.destinationId, policy?.defaultDestination ?? "space"); }
    catch (error) {
      if (!(error instanceof DocumentError)) throw error;
      await saveDraft(tx, here.tenantId, actor.id, detail, input.operationId, version);
      return remember(tx, actor.id, input.operationId, requestHash, { failed: true as const, code: "quick_capture_destination", message: `${error.message} The draft is kept.`, recoverable: true as const });
    }
    if (destination.id !== detail.destinationId || destination.version !== detail.formVersion) {
      await saveDraft(tx, here.tenantId, actor.id, detail, input.operationId, version);
      return remember(tx, actor.id, input.operationId, requestHash, { previewStale: true as const, recoverable: true as const });
    }
    const used = await tx.query("SELECT id FROM hs_quick_captures WHERE preview_id=$1", [input.previewId]);
    if (used.rows.length) return remember(tx, actor.id, input.operationId, requestHash, { previewStale: true as const, recoverable: true as const });
    const capturedAt = formatIst(new Date());
    const body = plainBody(detail, capturedAt);
    const pageId = destination.kind === "space" ? await createPrivatePage(r, tx, actor, here.workspaceId, destination.id, detail.title, detail, capturedAt) : null;
    const recordId = destination.kind === "intake" ? await createIntakeRecord(tx, here.tenantId, actor, detail, capturedAt) : null;
    if (destination.kind === "intake" && !recordId) {
      await saveDraft(tx, here.tenantId, actor.id, detail, input.operationId, version);
      return remember(tx, actor.id, input.operationId, requestHash, { failed: true as const, code: "quick_capture_destination", message: "That intake destination is not permitted. The draft is kept.", recoverable: true as const });
    }
    const id = randomUUID();
    await tx.query(
      `INSERT INTO hs_quick_captures(id,tenant_id,kind,title,body,source_url,source_title,source_page_id,source_access,destination_kind,destination_id,page_id,record_id,visibility,external_share,assets,excluded,version,policy_version,preview_id,owner_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'private',false,$14,$15,1,$16,$17,$18)`,
      [id, here.tenantId, detail.kind, detail.title, body, detail.sourceUrl, detail.sourceTitle, detail.sourcePageId, detail.sourceAccess, destination.kind, destination.id, pageId, recordId, JSON.stringify(detail.assets), JSON.stringify(detail.excluded), version, input.previewId, actor.id],
    );
    await tx.query("INSERT INTO hs_quick_capture_revisions(capture_id,version,body,source_access,actor_id,operation_id) VALUES($1,1,$2,$3,$4,$5)", [id, body, detail.sourceAccess, actor.id, input.operationId]);
    await tx.query("DELETE FROM hs_quick_capture_drafts WHERE tenant_id=$1 AND actor_id=$2 AND draft_key=$3", [here.tenantId, actor.id, detail.draftKey]);
    await track(tx, here.tenantId, actor, "commit", input.operationId, id, { sourceAccess: detail.sourceAccess, destinationKind: destination.kind, visibility: quickCaptureVisibility });
    await audit(tx, actor, "quick-capture.commit", input.operationId, id, pageId, { sourceAccess: detail.sourceAccess, destinationKind: destination.kind });
    const row = (await tx.query<CaptureRow>("SELECT * FROM hs_quick_captures WHERE id=$1", [id])).rows[0];
    return remember(tx, actor.id, input.operationId, requestHash, viewOf(row));
  });
  return settle(outcome) as SavedCapture;
}

export async function stashQuickCapture(r: Repository, actor: Actor, workspaceId: string, input: CaptureAttempt) {
  const outcome = await r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    if (here.role === "observer") throw unavailable();
    const { prepared, version, fallback } = await preparedFrom(tx, here, input);
    prepared.sourceAccess = await assessSource(r, tx, here, actor, prepared.sourcePageId);
    const detail = detailOf(prepared, { kind: prepared.destinationKind ?? fallback, id: prepared.destinationId ?? "unresolved", name: "Unresolved", collection: null, version: null }, version);
    const requestHash = recordHash({ kind: "stash", workspaceId, expectedVersion: input.expectedVersion, detail });
    const replay = await prior<{ kept: true }>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    await saveDraft(tx, here.tenantId, actor.id, detail, input.operationId, input.expectedVersion);
    await audit(tx, actor, "quick-capture.stash", input.operationId, here.tenantId, null, { sourceAccess: prepared.sourceAccess });
    return remember(tx, actor.id, input.operationId, requestHash, { kept: true as const, recoverable: true as const, conflict: version !== input.expectedVersion, sourceAccess: prepared.sourceAccess, sourceStatement: sourceAccessMessage(prepared.sourceAccess, prepared.sourceUrl ?? "") });
  });
  return settle(outcome);
}

export async function discardQuickCaptureDraft(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; draftKey?: string }) {
  const draftKey = input.draftKey?.trim() || "current";
  const requestHash = recordHash({ kind: "discard-draft", workspaceId, operationId: input.operationId, draftKey });
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    const replay = await prior<{ discarded: true }>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    await tx.query("DELETE FROM hs_quick_capture_drafts WHERE tenant_id=$1 AND actor_id=$2 AND draft_key=$3", [here.tenantId, actor.id, draftKey]);
    await audit(tx, actor, "quick-capture.discard-draft", input.operationId, here.tenantId, null, {});
    return remember(tx, actor.id, input.operationId, requestHash, { discarded: true as const });
  });
}

export async function saveQuickCapturePolicy(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; expectedVersion: number; kinds: string[]; defaultDestination: string; offlinePolicy?: string; visibility?: string; inheritExternal?: boolean }) {
  assertCapturePolicy(input);
  const kinds = captureKinds(input.kinds);
  const defaultDestination = captureDestinationKind(input.defaultDestination);
  const requestHash = recordHash({ kind: "policy", workspaceId, expectedVersion: input.expectedVersion, kinds, defaultDestination });
  const outcome = await r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await hold(tx, here.tenantId);
    if (here.role !== "owner" && here.role !== "admin") throw forbidden();
    if (!await actionAllowed(tx, here.tenantId, actor.id, "configure", true)) throw forbidden();
    const replay = await prior<{ version: number }>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    const policy = await policyOf(tx, here.tenantId);
    const version = policy?.version ?? 0;
    if (version !== input.expectedVersion) {
      await tx.query(
        `INSERT INTO hs_quick_capture_policy_drafts(tenant_id,actor_id,base_version,default_destination,kinds,operation_id)
         VALUES($1,$2,$3,$4,$5,$6)
         ON CONFLICT (tenant_id, actor_id) DO UPDATE SET base_version=$3, default_destination=$4, kinds=$5, operation_id=$6, updated_at=clock_timestamp()`,
        [here.tenantId, actor.id, input.expectedVersion, defaultDestination, JSON.stringify(kinds), input.operationId],
      );
      return remember(tx, actor.id, input.operationId, requestHash, { conflict: true as const, recoverable: true as const, version });
    }
    const next = version + 1;
    await tx.query(
      `INSERT INTO hs_quick_capture_policies(tenant_id,version,default_destination,visibility,inherit_external,offline_policy,kinds)
       VALUES($1,$2,$3,'private',false,'local-draft',$4)
       ON CONFLICT (tenant_id) DO UPDATE SET version=$2, default_destination=$3, kinds=$4, updated_at=clock_timestamp()`,
      [here.tenantId, next, defaultDestination, JSON.stringify(kinds)],
    );
    await tx.query("INSERT INTO hs_quick_capture_policy_revisions(tenant_id,version,default_destination,kinds,actor_id,operation_id) VALUES($1,$2,$3,$4,$5,$6)", [here.tenantId, next, defaultDestination, JSON.stringify(kinds), actor.id, input.operationId]);
    await tx.query("DELETE FROM hs_quick_capture_policy_drafts WHERE tenant_id=$1 AND actor_id=$2", [here.tenantId, actor.id]);
    await track(tx, here.tenantId, actor, "configure", input.operationId, null, { version: next });
    await audit(tx, actor, "quick-capture.configure", input.operationId, here.tenantId, null, { version: next });
    return remember(tx, actor.id, input.operationId, requestHash, { version: next, defaultDestination, kinds, visibility: quickCaptureVisibility, inheritExternal: false as const, offlinePolicy: quickCaptureOfflinePolicy });
  });
  return settle(outcome);
}

export async function stashQuickCapturePolicy(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; expectedVersion: number; kinds: string[]; defaultDestination: string }) {
  const kinds = captureKinds(input.kinds);
  const defaultDestination = captureDestinationKind(input.defaultDestination);
  const requestHash = recordHash({ kind: "stash-policy", workspaceId, ...input, kinds, defaultDestination });
  const outcome = await r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await hold(tx, here.tenantId);
    if (here.role !== "owner" && here.role !== "admin") throw forbidden();
    const replay = await prior<{ kept: true }>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    await tx.query(
      `INSERT INTO hs_quick_capture_policy_drafts(tenant_id,actor_id,base_version,default_destination,kinds,operation_id)
       VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT (tenant_id, actor_id) DO UPDATE SET base_version=$3, default_destination=$4, kinds=$5, operation_id=$6, updated_at=clock_timestamp()`,
      [here.tenantId, actor.id, input.expectedVersion, defaultDestination, JSON.stringify(kinds), input.operationId],
    );
    const policy = await policyOf(tx, here.tenantId);
    const mismatched = (policy?.version ?? 0) !== input.expectedVersion;
    await audit(tx, actor, "quick-capture.stash-policy", input.operationId, here.tenantId, null, { version: policy?.version ?? 0 });
    return remember(tx, actor.id, input.operationId, requestHash, { kept: true as const, recoverable: true as const, conflict: mismatched });
  });
  return settle(outcome);
}

export async function discardQuickCapturePolicy(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string }) {
  const requestHash = recordHash({ kind: "discard-policy", workspaceId, operationId: input.operationId });
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    if (here.role !== "owner" && here.role !== "admin") throw forbidden();
    const replay = await prior<{ discarded: true }>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    await tx.query("DELETE FROM hs_quick_capture_policy_drafts WHERE tenant_id=$1 AND actor_id=$2", [here.tenantId, actor.id]);
    await audit(tx, actor, "quick-capture.discard-policy", input.operationId, here.tenantId, null, {});
    return remember(tx, actor.id, input.operationId, requestHash, { discarded: true as const });
  });
}

export async function saveQuickCaptureFieldPolicy(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; expectedVersion: number; sensitive: boolean; access: { userId: string; canView: boolean; canWrite: boolean; canHistory: boolean }[] }) {
  const requestHash = recordHash({ kind: "field-policy", workspaceId, expectedVersion: input.expectedVersion, sensitive: input.sensitive, access: input.access });
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await hold(tx, here.tenantId);
    if (here.role !== "owner" && here.role !== "admin") throw forbidden();
    const replay = await prior<{ version: number }>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    const current = await tx.query<{ version: number | string }>("SELECT version FROM hs_quick_capture_field_policy WHERE tenant_id=$1", [here.tenantId]);
    const version = current.rows[0] ? num(current.rows[0].version) : 0;
    if (version !== input.expectedVersion) throw new DocumentError("The capture version changed. Nothing was overwritten.", "quick_capture_conflict", 409);
    const next = version + 1;
    await tx.query("INSERT INTO hs_quick_capture_field_policy(tenant_id,sensitive,version) VALUES($1,$2,$3) ON CONFLICT (tenant_id) DO UPDATE SET sensitive=$2, version=$3", [here.tenantId, input.sensitive === true, next]);
    await tx.query("DELETE FROM hs_quick_capture_field_access WHERE tenant_id=$1", [here.tenantId]);
    for (const entry of input.access) {
      const member = await tx.query("SELECT 1 FROM hs_members WHERE workspace_id=$1 AND user_id=$2 AND active=true", [here.workspaceId, entry.userId]);
      if (!member.rows.length) throw unavailable();
      await tx.query("INSERT INTO hs_quick_capture_field_access(tenant_id,user_id,can_view,can_write,can_history) VALUES($1,$2,$3,$4,$5)", [here.tenantId, entry.userId, entry.canView === true, entry.canWrite === true, entry.canHistory === true]);
    }
    await audit(tx, actor, "quick-capture.field-policy", input.operationId, here.tenantId, null, { version: next, sensitive: input.sensitive === true });
    return remember(tx, actor.id, input.operationId, requestHash, { version: next, sensitive: input.sensitive === true });
  });
}

export async function setQuickCaptureActions(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; userId: string; expectedVersion: number; actions: string[] }) {
  const actions: QuickCaptureAction[] = [];
  for (const action of input.actions) {
    if (!quickCaptureActions.includes(action as QuickCaptureAction) || actions.includes(action as QuickCaptureAction)) throw new DocumentError("Check the capture.", "quick_capture_validation", 422);
    actions.push(action as QuickCaptureAction);
  }
  const requestHash = recordHash({ kind: "actions", workspaceId, userId: input.userId, expectedVersion: input.expectedVersion, actions });
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await hold(tx, here.tenantId);
    if (here.role !== "owner" && here.role !== "admin") throw forbidden();
    const member = await tx.query("SELECT 1 FROM hs_members WHERE workspace_id=$1 AND user_id=$2 AND active=true", [here.workspaceId, input.userId]);
    if (!member.rows.length) throw unavailable();
    const replay = await prior<{ version: number }>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    const current = await tx.query<{ version: number | string }>("SELECT version FROM hs_quick_capture_action_sets WHERE tenant_id=$1 AND user_id=$2", [here.tenantId, input.userId]);
    const version = current.rows[0] ? num(current.rows[0].version) : 0;
    if (version !== input.expectedVersion) throw new DocumentError("The capture version changed. Nothing was overwritten.", "quick_capture_conflict", 409);
    const next = version + 1;
    await tx.query("INSERT INTO hs_quick_capture_action_sets(tenant_id,user_id,version) VALUES($1,$2,$3) ON CONFLICT (tenant_id, user_id) DO UPDATE SET version=$3", [here.tenantId, input.userId, next]);
    await tx.query("DELETE FROM hs_quick_capture_actions WHERE tenant_id=$1 AND user_id=$2", [here.tenantId, input.userId]);
    for (const action of actions) await tx.query("INSERT INTO hs_quick_capture_actions(tenant_id,user_id,action,granted_by) VALUES($1,$2,$3,$4)", [here.tenantId, input.userId, action, actor.id]);
    await audit(tx, actor, "quick-capture.actions", input.operationId, input.userId, null, { version: next, actions });
    return remember(tx, actor.id, input.operationId, requestHash, { version: next, actions });
  });
}

export async function grantQuickCaptureOperator(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; userId: string }) {
  const requestHash = recordHash({ kind: "grant-operator", workspaceId, userId: input.userId });
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    if (here.role !== "owner" && here.role !== "admin") throw forbidden();
    const member = await tx.query("SELECT 1 FROM hs_members WHERE workspace_id=$1 AND user_id=$2 AND active=true", [here.workspaceId, input.userId]);
    if (!member.rows.length) throw unavailable();
    const replay = await prior<{ granted: true }>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    await tx.query("INSERT INTO hs_quick_capture_operators(workspace_id,user_id,granted_by) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [here.workspaceId, input.userId, actor.id]);
    await audit(tx, actor, "quick-capture.grant-operator", input.operationId, input.userId, null, { assignment: quickCaptureAssignment });
    return remember(tx, actor.id, input.operationId, requestHash, { granted: true as const, assignment: quickCaptureAssignment });
  });
}

export async function revokeQuickCaptureOperator(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; userId: string }) {
  const requestHash = recordHash({ kind: "revoke-operator", workspaceId, userId: input.userId });
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    if (here.role !== "owner" && here.role !== "admin") throw forbidden();
    const replay = await prior<{ revoked: true }>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    await tx.query("DELETE FROM hs_quick_capture_operators WHERE workspace_id=$1 AND user_id=$2", [here.workspaceId, input.userId]);
    await audit(tx, actor, "quick-capture.revoke-operator", input.operationId, input.userId, null, {});
    return remember(tx, actor.id, input.operationId, requestHash, { revoked: true as const });
  });
}
