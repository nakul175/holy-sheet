import { randomUUID } from "node:crypto";
import type { Actor } from "./auth";
import type { Sql } from "./database";
import { DocumentError } from "./document";
import { formatIst } from "./ist-label";
import {
  compileKnowledgeSite,
  generationMatches,
  knowledgeSiteActions,
  knowledgeSiteAssignment,
  knowledgeSiteAudience,
  knowledgeSiteBoundary,
  knowledgeSiteCacheBound,
  knowledgeSiteCacheBoundSeconds,
  knowledgeSiteEdge,
  knowledgeSiteLive,
  knowledgeSiteName,
  knowledgeSiteQuarantine,
  knowledgeSiteQuery,
  knowledgeSiteRecoverable,
  knowledgeSiteReport,
  knowledgeSiteRetraction,
  knowledgeSiteSchedules,
  knowledgeSiteSharing,
  knowledgeSiteSource,
  projectionText,
  renderPublicSite,
  storedDefinition,
  visibleProjection,
  type DocNode,
  type KnowledgeSiteAction,
  type KnowledgeSiteDefinition,
  type KnowledgeSiteStatus,
  type PublicProjection,
  type SourceAsset,
  type SourcePage,
  type SourceRecord,
} from "./knowledge-site-plan";
import type { Repository } from "./repository";
import { recordHash } from "./shared-record-types";

const unavailable = () => new DocumentError("Knowledge sites are restricted or unavailable.", "not_found", 404);
const forbidden = () => new DocumentError("This action is not permitted.", "action_forbidden", 403);
const mismatch = () => new DocumentError("This attempt was reused with different fields.", "operation_mismatch", 409);
const conflictMessage = "The knowledge site version changed. The draft is kept.";
const pageIdPattern = /^[A-Za-z0-9_-]{1,80}$/;

type Scope = { workspaceId: string; tenantId: string; role: string };
type SiteRow = {
  id: string;
  name: string;
  status: KnowledgeSiteStatus;
  sharing: string;
  version: number | string;
  cache_generation: number | string;
  definition: unknown;
  served: unknown;
  served_snapshot_id: string | null;
  audience_confirmed: boolean | string;
  created_by: string;
};
type Outcome = { conflict?: boolean; failed?: boolean; message?: string; code?: string };
type RecordAccess = { id: string; collection: string; name: string; version: number; values: Record<string, unknown>; view: boolean; history: boolean };

const copy = () => ({
  boundary: knowledgeSiteBoundary,
  assignment: knowledgeSiteAssignment,
  audience: knowledgeSiteAudience,
  live: knowledgeSiteLive,
  schedules: knowledgeSiteSchedules,
  recoverable: knowledgeSiteRecoverable,
  edge: knowledgeSiteEdge,
  cacheBound: knowledgeSiteCacheBound,
  retraction: knowledgeSiteRetraction,
  quarantine: knowledgeSiteQuarantine,
  sharing: knowledgeSiteSharing,
  accessGranted: false as const,
  liveSite: false as const,
  publicEnabled: false as const,
  domain: null,
  cache: "no-store" as const,
  cacheBoundSeconds: knowledgeSiteCacheBoundSeconds,
});

function settle<T extends object>(result: T): T {
  const value = result as T & Outcome;
  if (value.failed) throw new DocumentError(value.message ?? "Check the knowledge site.", value.code ?? "knowledge_site_validation", 409);
  if (value.conflict) throw new DocumentError(conflictMessage, "knowledge_site_conflict", 409);
  return result;
}
function on(value: unknown) { return value === true || value === "t" || value === "true" || value === 1; }
function num(value: number | string | null | undefined) { return Number(value ?? 0); }
function asJson<T>(value: unknown): T { return (typeof value === "string" ? JSON.parse(value) : value) as T; }
function flags(extra: Record<string, unknown> = {}) {
  return {
    sharing: knowledgeSiteSharing, accessGranted: false as const, liveSite: false as const, publicEnabled: false as const, domain: null,
    cache: "no-store" as const, cacheBoundSeconds: knowledgeSiteCacheBoundSeconds, schedulesPaused: true as const,
    retraction: false as const, thirdPartyRetraction: false as const, ...extra,
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
  const row = await tx.query("SELECT 1 FROM hs_knowledge_site_managers WHERE workspace_id=$1 AND user_id=$2", [here.workspaceId, actor.id]);
  return row.rows.length > 0;
}
async function requireManager(tx: Sql, here: Scope, actor: Actor) {
  if (!await isManager(tx, here, actor)) throw unavailable();
}
async function actionAllowed(tx: Sql, tenantId: string, userId: string, action: KnowledgeSiteAction, manager: boolean) {
  const rows = await tx.query<{ action: string }>("SELECT action FROM hs_knowledge_site_actor_actions WHERE tenant_id=$1 AND user_id=$2", [tenantId, userId]);
  if (action === "publish") return rows.rows.some(row => row.action === "publish");
  if (!rows.rows.length) return manager;
  return rows.rows.some(row => row.action === action);
}
async function prior<T extends object>(tx: Sql, actorId: string, operationId: string, requestHash: string): Promise<(T & { replayed: true }) | null> {
  const row = await tx.query<{ request_hash: string; result: unknown }>("SELECT request_hash, result FROM hs_knowledge_site_operations WHERE actor_id=$1 AND operation_id=$2", [actorId, operationId]);
  if (!row.rows[0]) return null;
  if (row.rows[0].request_hash !== requestHash) throw mismatch();
  return { ...asJson<T>(row.rows[0].result), replayed: true };
}
async function remember<T extends object>(tx: Sql, actorId: string, operationId: string, requestHash: string, result: T) {
  const stored = { ...result, replayed: false as const };
  await tx.query("INSERT INTO hs_knowledge_site_operations(actor_id,operation_id,request_hash,result) VALUES($1,$2,$3,$4::jsonb)", [actorId, operationId, requestHash, JSON.stringify(stored)]);
  return stored;
}
async function audit(tx: Sql, actor: Actor, action: string, operationId: string, siteId: string, after: Record<string, unknown>) {
  const body = { source: knowledgeSiteSource, operationId, atIst: formatIst(new Date()), ...flags(after) };
  await tx.query(
    "INSERT INTO hs_audit(id,actor_id,action,page_id,subject_id,after_value,correlation_id) VALUES($1,$2,$3,NULL,$4,$5::jsonb,$6)",
    [randomUUID(), actor.id, action, siteId, JSON.stringify(body), operationId],
  );
}
async function track(tx: Sql, tenantId: string, siteId: string, actor: Actor, action: string, operationId: string, cacheGeneration: number, detail: Record<string, unknown>) {
  await tx.query(
    "INSERT INTO hs_knowledge_site_events(id,tenant_id,site_id,action,actor_id,operation_id,source,cache_generation,detail) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)",
    [randomUUID(), tenantId, siteId, action, actor.id, operationId, knowledgeSiteSource, cacheGeneration, JSON.stringify(flags(detail))],
  );
}
async function saveDraft(tx: Sql, tenantId: string, actorId: string, siteKey: string, kind: string, baseVersion: number, payload: Record<string, unknown>, operationId: string) {
  await tx.query(
    `INSERT INTO hs_knowledge_site_drafts(tenant_id,actor_id,site_key,kind,base_version,payload,operation_id)
     VALUES($1,$2,$3,$4,$5,$6::jsonb,$7)
     ON CONFLICT (tenant_id, actor_id, site_key, kind)
     DO UPDATE SET base_version=$5, payload=$6::jsonb, operation_id=$7, updated_at=clock_timestamp()`,
    [tenantId, actorId, siteKey, kind, baseVersion, JSON.stringify(payload), operationId],
  );
}
function definitionOf(row: SiteRow) {
  return compileKnowledgeSite(asJson(row.definition));
}
function servedOf(row: SiteRow) {
  if (!row.served) return null;
  return asJson<PublicProjection>(row.served);
}
function present(row: SiteRow, replayed = false) {
  return {
    ...flags(),
    id: row.id,
    name: row.name,
    status: row.status,
    version: num(row.version),
    cacheGeneration: num(row.cache_generation),
    audienceConfirmed: on(row.audience_confirmed),
    dryRun: true as const,
    replayed,
  };
}
async function loadSite(tx: Sql, tenantId: string, siteId: string) {
  if (!/^[0-9a-f-]{36}$/i.test(siteId)) throw unavailable();
  const row = await tx.query<SiteRow>(
    "SELECT id, name, status, sharing, version, cache_generation, definition, served, served_snapshot_id, audience_confirmed, created_by FROM hs_knowledge_sites WHERE id=$1 AND tenant_id=$2",
    [siteId, tenantId],
  );
  if (!row.rows[0] || row.rows[0].sharing !== "off") throw unavailable();
  return row.rows[0];
}
async function revise(tx: Sql, row: SiteRow, actor: Actor, operationId: string, action: string) {
  await tx.query(
    "INSERT INTO hs_knowledge_site_revisions(site_id,version,status,name,definition,cache_generation,action,actor_id,operation_id) VALUES($1,$2,$3,$4,$5::jsonb,$6,$7,$8,$9)",
    [row.id, num(row.version), row.status, row.name, JSON.stringify(storedDefinition(definitionOf(row))), num(row.cache_generation), action, actor.id, operationId],
  );
}
async function canViewPage(tx: Sql, workspaceId: string, pageId: string, userId: string) {
  if (!pageIdPattern.test(pageId)) return false;
  const row = await tx.query(
    `SELECT 1 FROM hs_pages p
     JOIN hs_members m ON m.workspace_id=p.workspace_id AND m.user_id=$2 AND m.active=true
     WHERE p.id=$1 AND p.workspace_id=$3 AND p.deleted_at IS NULL
       AND (m.role IN ('owner','admin') OR p.owner_id=$2
         OR EXISTS (SELECT 1 FROM hs_grants g WHERE g.page_id=p.id AND (g.subject=$2 OR (p.visibility='space' AND g.subject='space'))))`,
    [pageId, userId, workspaceId],
  );
  return row.rows.length > 0;
}
async function fieldDecision(tx: Sql, tenantId: string, collection: string, key: string, userId: string, mode: "view" | "history") {
  const policy = await tx.query<{ sensitive: boolean }>("SELECT sensitive FROM hs_data_fields WHERE tenant_id=$1 AND collection=$2 AND field_key=$3", [tenantId, collection, key]);
  if (!policy.rows[0]) return { sensitive: false, allowed: true };
  const explicit = await tx.query("SELECT 1 FROM hs_data_field_permissions WHERE tenant_id=$1 AND collection=$2 AND field_key=$3 LIMIT 1", [tenantId, collection, key]);
  const sensitive = on(policy.rows[0].sensitive);
  if (!sensitive && !explicit.rows.length) return { sensitive: false, allowed: true };
  const access = await tx.query<{ can_view: boolean; can_history: boolean }>(
    "SELECT can_view, can_history FROM hs_data_field_permissions WHERE tenant_id=$1 AND collection=$2 AND field_key=$3 AND user_id=$4",
    [tenantId, collection, key, userId],
  );
  const row = access.rows[0];
  if (!row) return { sensitive, allowed: false };
  return { sensitive, allowed: mode === "history" ? on(row.can_history) : on(row.can_view) };
}
async function recordAccess(tx: Sql, tenantId: string, recordId: string, userId: string): Promise<RecordAccess | null> {
  if (!/^[0-9a-f-]{36}$/i.test(recordId)) return null;
  const row = await tx.query<{ collection: string; name: string; version: number | string; field_values: unknown; view: boolean; history: boolean }>(
    `SELECT r.collection, r.name, r.version, r.field_values,
       (EXISTS (SELECT 1 FROM hs_data_collection_grants g WHERE g.tenant_id=r.tenant_id AND g.user_id=$3 AND g.collection=r.collection AND 'view'=ANY(g.capabilities))
        OR EXISTS (SELECT 1 FROM hs_data_record_grants rg WHERE rg.tenant_id=r.tenant_id AND rg.record_id=r.id AND rg.user_id=$3 AND 'view'=ANY(rg.capabilities))) AS view,
       (EXISTS (SELECT 1 FROM hs_data_collection_grants g WHERE g.tenant_id=r.tenant_id AND g.user_id=$3 AND g.collection=r.collection AND 'history'=ANY(g.capabilities))
        OR EXISTS (SELECT 1 FROM hs_data_record_grants rg WHERE rg.tenant_id=r.tenant_id AND rg.record_id=r.id AND rg.user_id=$3 AND 'history'=ANY(rg.capabilities))) AS history
     FROM hs_data_records r
     WHERE r.id=$1 AND r.tenant_id=$2 AND r.state='active'`,
    [recordId, tenantId, userId],
  );
  const found = row.rows[0];
  if (!found) return null;
  return { id: recordId, collection: found.collection, name: found.name, version: num(found.version), values: asJson<Record<string, unknown>>(found.field_values ?? {}), view: on(found.view), history: on(found.history) };
}
async function requireSelection(tx: Sql, here: Scope, actor: Actor, definition: KnowledgeSiteDefinition) {
  for (const page of definition.pages) {
    if (!await canViewPage(tx, here.workspaceId, page.pageId, actor.id)) throw unavailable();
    const revision = await tx.query("SELECT 1 FROM hs_revisions WHERE page_id=$1 AND version=$2", [page.pageId, page.revision]);
    const located = await tx.query("SELECT 1 FROM hs_pages WHERE id=$1 AND workspace_id=$2 AND deleted_at IS NULL", [page.pageId, here.workspaceId]);
    if (!revision.rows.length || !located.rows.length) throw unavailable();
  }
  for (const record of definition.records) {
    const access = await recordAccess(tx, here.tenantId, record.recordId, actor.id);
    if (!access?.view) throw unavailable();
  }
}
async function sourcePages(tx: Sql, here: Scope, actor: Actor, definition: KnowledgeSiteDefinition): Promise<SourcePage[]> {
  const pages: SourcePage[] = [];
  for (const selected of definition.pages) {
    if (!await canViewPage(tx, here.workspaceId, selected.pageId, actor.id)) throw unavailable();
    const page = await tx.query<{ title: string; owner_id: string; visibility: string; version: number | string; document: unknown }>(
      `SELECT r.title, p.owner_id, p.visibility, p.version, r.document
       FROM hs_pages p JOIN hs_revisions r ON r.page_id=p.id AND r.version=$2
       WHERE p.id=$1 AND p.workspace_id=$3 AND p.deleted_at IS NULL`,
      [selected.pageId, selected.revision, here.workspaceId],
    );
    const found = page.rows[0];
    if (!found) throw unavailable();
    const comments = await tx.query<{ id: string; body: string }>(
      "SELECT c.id::text, c.body FROM hs_comments c JOIN hs_threads t ON t.id=c.thread_id WHERE t.page_id=$1 AND c.deleted_at IS NULL",
      [selected.pageId],
    );
    const acl = await tx.query<{ subject: string; role: string }>("SELECT subject, role FROM hs_grants WHERE page_id=$1", [selected.pageId]);
    const history = await tx.query<{ version: number | string; title: string }>("SELECT version, title FROM hs_revisions WHERE page_id=$1 ORDER BY version", [selected.pageId]);
    const media = await tx.query<{ id: string; name: string; mime: string; state: string; object_key: string; deleted_at: string | null }>(
      "SELECT id::text, name, mime, state, object_key, deleted_at FROM hs_media WHERE page_id=$1",
      [selected.pageId],
    );
    const assets: SourceAsset[] = media.rows.map(item => ({ mediaId: item.id, name: item.name, mime: item.mime, state: item.state, objectKey: item.object_key, deleted: Boolean(item.deleted_at) }));
    pages.push({
      pageId: selected.pageId, revision: selected.revision, currentVersion: num(found.version), title: found.title,
      document: asJson<DocNode>(found.document), ownerId: found.owner_id, visibility: found.visibility,
      acl: acl.rows, comments: comments.rows, history: history.rows.map(item => ({ version: num(item.version), title: item.title })), assets,
    });
  }
  return pages;
}
async function sourceRecords(tx: Sql, tenantId: string, actorId: string, definition: KnowledgeSiteDefinition): Promise<SourceRecord[]> {
  const records: SourceRecord[] = [];
  for (const selected of definition.records) {
    const access = await recordAccess(tx, tenantId, selected.recordId, actorId);
    if (!access) {
      records.push({ recordId: selected.recordId, name: "", view: false, values: {}, fields: selected.fields.map(key => ({ key, sensitive: true, view: false })) });
      continue;
    }
    const fields = [];
    for (const key of selected.fields) {
      const policy = await fieldDecision(tx, tenantId, access.collection, key, actorId, "view");
      fields.push({ key, sensitive: policy.sensitive, view: policy.allowed });
    }
    records.push({ recordId: access.id, name: access.name, view: access.view, values: access.values, fields });
  }
  return records;
}
async function project(tx: Sql, here: Scope, actor: Actor, definition: KnowledgeSiteDefinition) {
  return renderPublicSite(definition, await sourcePages(tx, here, actor, definition), await sourceRecords(tx, here.tenantId, actor.id, definition));
}
async function visibleIds(tx: Sql, here: Scope, actorId: string, definition: KnowledgeSiteDefinition, projection: PublicProjection) {
  const pages = new Set<string>();
  for (const page of projection.pages) if (await canViewPage(tx, here.workspaceId, page.pageId, actorId)) pages.add(page.pageId);
  const records = new Set<string>();
  for (const record of projection.records) {
    const access = await recordAccess(tx, here.tenantId, record.recordId, actorId);
    if (!access?.view) continue;
    const kept = [];
    for (const field of record.fields) {
      const policy = await fieldDecision(tx, here.tenantId, access.collection, field.key, actorId, "view");
      if (!policy.sensitive && policy.allowed) kept.push(field);
    }
    if (kept.length) {
      records.add(record.recordId);
      record.fields = kept;
    } else record.fields = [];
  }
  projection.records = projection.records.filter(record => record.fields.length > 0);
  return visibleProjection(projection, pages, records);
}
async function replaceIndex(tx: Sql, siteId: string, generation: number, projection: PublicProjection) {
  await tx.query("DELETE FROM hs_knowledge_site_search WHERE site_id=$1", [siteId]);
  await tx.query("DELETE FROM hs_knowledge_site_assets WHERE site_id=$1", [siteId]);
  for (const page of projection.pages) {
    const blocks = page.blocks.flatMap(block => block.type === "text" ? [block.text] : []);
    await tx.query(
      "INSERT INTO hs_knowledge_site_search(site_id,cache_generation,page_id,path,body) VALUES($1,$2,$3,$4,$5)",
      [siteId, generation, page.pageId, page.path, [page.title, page.label, page.path, ...blocks].join("\n")],
    );
  }
  for (const asset of projection.assets) {
    await tx.query(
      `INSERT INTO hs_knowledge_site_assets(site_id,cache_generation,media_id,page_id,name,mime,scan_state,quarantined,object_key_stored,direct_url)
       VALUES($1,$2,$3,$4,$5,$6,'clean',false,false,NULL)`,
      [siteId, generation, asset.mediaId, asset.pageId, asset.name.slice(0, 200), asset.mime.slice(0, 120)],
    );
  }
}
async function clearIndex(tx: Sql, siteId: string) {
  await tx.query("DELETE FROM hs_knowledge_site_search WHERE site_id=$1", [siteId]);
  await tx.query("DELETE FROM hs_knowledge_site_assets WHERE site_id=$1", [siteId]);
}

async function writeSite(tx: Sql, here: Scope, actor: Actor, operationId: string, action: string, siteId: string, expectedVersion: number, patch: { status?: KnowledgeSiteStatus; name?: string; definition?: KnowledgeSiteDefinition; served?: PublicProjection | null; snapshotId?: string | null; audience?: boolean; bumpCache?: boolean }) {
  const current = await loadSite(tx, here.tenantId, siteId);
  const definition = patch.definition ?? definitionOf(current);
  if (num(current.version) !== expectedVersion) {
    await saveDraft(tx, here.tenantId, actor.id, siteId, action === "publish" || action === "unpublish" || action === "rollback" ? action : "configure", expectedVersion, { name: patch.name ?? current.name, rejected: action }, operationId);
    return { conflict: true as const, version: num(current.version) };
  }
  const status = patch.status ?? current.status;
  const name = patch.name ?? current.name;
  const served = patch.served === undefined ? (current.served ? asJson<PublicProjection>(current.served) : null) : patch.served;
  const snapshotId = patch.snapshotId === undefined ? current.served_snapshot_id : patch.snapshotId;
  const audience = patch.audience === undefined ? on(current.audience_confirmed) : patch.audience;
  const updated = await tx.query<SiteRow>(
    `UPDATE hs_knowledge_sites
     SET status=$2, name=$3, definition=$4::jsonb, served=$5::jsonb, served_snapshot_id=$6, audience_confirmed=$7,
         version=version+1, cache_generation=CASE WHEN $8::boolean THEN cache_generation+1 ELSE cache_generation END, updated_at=clock_timestamp()
     WHERE id=$1 AND tenant_id=$9 AND version=$10
     RETURNING id, name, status, sharing, version, cache_generation, definition, served, served_snapshot_id, audience_confirmed, created_by`,
    [siteId, status, name, JSON.stringify(storedDefinition(definition)), served === null || served === undefined ? null : JSON.stringify(served), snapshotId, audience, patch.bumpCache === true, here.tenantId, expectedVersion],
  );
  const row = updated.rows[0];
  if (!row) return { conflict: true as const, version: num(current.version) };
  await revise(tx, row, actor, operationId, action);
  await audit(tx, actor, `knowledge-site.${action}`, operationId, row.id, { status: row.status, cacheGeneration: num(row.cache_generation), version: num(row.version), audienceConfirmed: on(row.audience_confirmed) });
  await track(tx, here.tenantId, row.id, actor, action, operationId, num(row.cache_generation), { status: row.status, version: num(row.version) });
  return present(row);
}

export async function knowledgeSiteCatalogue(r: Repository, actor: Actor, workspaceId: string) {
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    const manage = await isManager(tx, here, actor);
    const allowed = await actionAllowed(tx, here.tenantId, actor.id, "search", manage);
    const rows = await tx.query<SiteRow>("SELECT id, name, status, sharing, version, cache_generation, definition, served, served_snapshot_id, audience_confirmed, created_by FROM hs_knowledge_sites WHERE tenant_id=$1 ORDER BY name_search, id", [here.tenantId]);
    const sites = [];
    for (const row of rows.rows) {
      const definition = definitionOf(row);
      let visible = manage;
      if (!visible) {
        for (const page of definition.pages) if (await canViewPage(tx, here.workspaceId, page.pageId, actor.id)) visible = true;
      }
      if (!visible || !allowed) continue;
      sites.push({
        id: row.id, name: row.name, status: row.status, version: num(row.version), cacheGeneration: num(row.cache_generation),
        paths: definition.pages.map(page => page.path), sharing: knowledgeSiteSharing, accessGranted: false as const,
        liveSite: false as const, domain: null, audienceConfirmed: on(row.audience_confirmed), schedulesPaused: true as const,
      });
    }
    const drafts = await tx.query<{ site_key: string; kind: string; base_version: number | string }>(
      "SELECT site_key, kind, base_version FROM hs_knowledge_site_drafts WHERE tenant_id=$1 AND actor_id=$2 ORDER BY site_key, kind",
      [here.tenantId, actor.id],
    );
    return { ...copy(), actorId: actor.id, manage, sites, drafts: drafts.rows.map(draft => ({ siteKey: draft.site_key, kind: draft.kind, baseVersion: num(draft.base_version) })) };
  });
}

export async function readKnowledgeSite(r: Repository, actor: Actor, workspaceId: string, siteId: string) {
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    const row = await loadSite(tx, here.tenantId, siteId);
    const definition = definitionOf(row);
    const manage = await isManager(tx, here, actor);
    let visible = manage && await actionAllowed(tx, here.tenantId, actor.id, "search", true);
    if (!visible) {
      for (const page of definition.pages) if (await canViewPage(tx, here.workspaceId, page.pageId, actor.id) && await actionAllowed(tx, here.tenantId, actor.id, "search", false)) visible = true;
    }
    if (!visible) throw unavailable();
    return { ...present(row), paths: definition.navigation };
  });
}

export async function searchKnowledgeSites(r: Repository, actor: Actor, workspaceId: string, query: string, generation: number | null = null) {
  const needle = knowledgeSiteQuery(query);
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    const manage = await isManager(tx, here, actor);
    if (!await actionAllowed(tx, here.tenantId, actor.id, "search", manage)) throw forbidden();
    const rows = await tx.query<SiteRow>("SELECT id, name, status, sharing, version, cache_generation, definition, served, served_snapshot_id, audience_confirmed, created_by FROM hs_knowledge_sites WHERE tenant_id=$1 ORDER BY name_search, id", [here.tenantId]);
    if (generation !== null && rows.rows.length && rows.rows.every(row => !generationMatches(generation, num(row.cache_generation)))) throw unavailable();
    const results = [];
    for (const row of rows.rows) {
      if (!generationMatches(generation, num(row.cache_generation))) continue;
      const definition = definitionOf(row);
      const indexed = row.status === "published"
        ? await tx.query<{ page_id: string; path: string; body: string }>("SELECT page_id, path, body FROM hs_knowledge_site_search WHERE site_id=$1 AND cache_generation=$2", [row.id, num(row.cache_generation)])
        : { rows: [] as { page_id: string; path: string; body: string }[] };
      let matched = false;
      let snippet = "";
      for (const hit of indexed.rows) {
        if (!hit.body.toLocaleLowerCase().includes(needle)) continue;
        if (!await canViewPage(tx, here.workspaceId, hit.page_id, actor.id)) continue;
        matched = true;
        snippet = hit.body.split("\n").find(line => line.toLocaleLowerCase().includes(needle)) ?? "";
      }
      if (!matched && !(manage && row.name.toLocaleLowerCase().includes(needle))) continue;
      if (!matched && manage) {
        let anyPage = false;
        for (const page of definition.pages) if (await canViewPage(tx, here.workspaceId, page.pageId, actor.id)) anyPage = true;
        if (!anyPage) snippet = "";
      }
      results.push({ id: row.id, name: row.name, status: row.status, path: matched ? indexed.rows.find(hit => hit.body.toLocaleLowerCase().includes(needle))?.path ?? "" : "", snippet, sharing: knowledgeSiteSharing, accessGranted: false as const, liveSite: false as const, cacheGeneration: num(row.cache_generation) });
    }
    return { results, ...flags({ assignment: knowledgeSiteAssignment, cacheBound: knowledgeSiteCacheBound }) };
  });
}

export async function knowledgeSiteHistory(r: Repository, actor: Actor, workspaceId: string, siteId: string) {
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    const row = await loadSite(tx, here.tenantId, siteId);
    const definition = definitionOf(row);
    const manage = await isManager(tx, here, actor);
    let visible = manage;
    if (!visible) for (const page of definition.pages) if (await canViewPage(tx, here.workspaceId, page.pageId, actor.id)) visible = true;
    if (!visible) throw unavailable();
    if (!await actionAllowed(tx, here.tenantId, actor.id, "history", manage)) throw forbidden();
    for (const selected of definition.records) {
      const access = await recordAccess(tx, here.tenantId, selected.recordId, actor.id);
      if (!access?.view) continue;
      if (!access.history) throw forbidden();
      for (const key of selected.fields) {
        const policy = await fieldDecision(tx, here.tenantId, access.collection, key, actor.id, "history");
        if (policy.sensitive && !policy.allowed) throw forbidden();
      }
    }
    const events = await tx.query<{ action: string; actor_id: string; actor_name: string; operation_id: string; source: string; cache_generation: number | string; created_at: string | Date }>(
      `SELECT e.action, e.actor_id, u.name AS actor_name, e.operation_id::text, e.source, e.cache_generation, e.created_at
       FROM hs_knowledge_site_events e JOIN hs_users u ON u.id=e.actor_id
       WHERE e.tenant_id=$1 AND e.site_id=$2 ORDER BY e.created_at, e.id`,
      [here.tenantId, siteId],
    );
    return {
      ...flags(),
      events: events.rows.map(event => ({ action: event.action, actorId: event.actor_id, actorName: event.actor_name, operationId: event.operation_id, source: event.source, cacheGeneration: num(event.cache_generation), atIst: formatIst(event.created_at) })),
      site: { id: row.id, name: row.name, status: row.status, sharing: knowledgeSiteSharing, liveSite: false as const },
    };
  });
}

export async function saveKnowledgeSite(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; siteId?: string; expectedVersion: number; name: string; definition: unknown }) {
  const name = knowledgeSiteName(input.name);
  const definition = compileKnowledgeSite(input.definition);
  const requestHash = recordHash({ kind: "configure", workspaceId, siteId: input.siteId ?? null, expectedVersion: input.expectedVersion, name, definition: storedDefinition(definition) });
  const outcome = await r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await hold(tx, here.tenantId);
    await requireManager(tx, here, actor);
    if (!await actionAllowed(tx, here.tenantId, actor.id, "configure", true)) throw forbidden();
    const replay = await prior<Outcome & { id?: string }>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    await requireSelection(tx, here, actor, definition);
    if (!input.siteId) {
      if (input.expectedVersion !== 0) {
        await saveDraft(tx, here.tenantId, actor.id, "new", "configure", input.expectedVersion, { name }, input.operationId);
        return { conflict: true as const, version: 0 };
      }
      const id = randomUUID();
      const inserted = await tx.query<SiteRow>(
        `INSERT INTO hs_knowledge_sites(id,tenant_id,name,status,sharing,live_site,public_enabled,domain,audience_confirmed,version,cache_generation,definition,served,served_snapshot_id,created_by)
         VALUES($1,$2,$3,'draft','off',false,false,NULL,false,1,1,$4::jsonb,NULL,NULL,$5)
         RETURNING id, name, status, sharing, version, cache_generation, definition, served, served_snapshot_id, audience_confirmed, created_by`,
        [id, here.tenantId, name, JSON.stringify(storedDefinition(definition)), actor.id],
      );
      const row = inserted.rows[0];
      await revise(tx, row, actor, input.operationId, "configure");
      await audit(tx, actor, "knowledge-site.configure", input.operationId, row.id, { status: "draft", cacheGeneration: 1, version: 1, audienceConfirmed: false });
      await track(tx, here.tenantId, row.id, actor, "configure", input.operationId, 1, { status: "draft", version: 1 });
      return remember(tx, actor.id, input.operationId, requestHash, present(row));
    }
    const saved = await writeSite(tx, here, actor, input.operationId, "configure", input.siteId, input.expectedVersion, { name, definition, bumpCache: false });
    if ("conflict" in saved || "failed" in saved) return remember(tx, actor.id, input.operationId, requestHash, saved);
    return remember(tx, actor.id, input.operationId, requestHash, saved);
  });
  return settle(outcome);
}

export async function previewKnowledgeSite(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; siteId: string; expectedVersion: number }) {
  const requestHash = recordHash({ kind: "preview", workspaceId, siteId: input.siteId, expectedVersion: input.expectedVersion });
  const outcome = await r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await hold(tx, here.tenantId);
    await requireManager(tx, here, actor);
    if (!await actionAllowed(tx, here.tenantId, actor.id, "preview", true)) throw forbidden();
    const replay = await prior<Outcome>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    const current = await loadSite(tx, here.tenantId, input.siteId);
    if (num(current.version) !== input.expectedVersion) {
      await saveDraft(tx, here.tenantId, actor.id, input.siteId, "configure", input.expectedVersion, { rejected: "preview" }, input.operationId);
      return remember(tx, actor.id, input.operationId, requestHash, { conflict: true as const, version: num(current.version) });
    }
    const definition = definitionOf(current);
    const projection = await project(tx, here, actor, definition);
    await audit(tx, actor, "knowledge-site.preview", input.operationId, current.id, { status: current.status, cacheGeneration: num(current.cache_generation), version: num(current.version), dryRun: true });
    await track(tx, here.tenantId, current.id, actor, "preview", input.operationId, num(current.cache_generation), { status: current.status, dryRun: true });
    return remember(tx, actor.id, input.operationId, requestHash, { ...present(current), projection, manifest: projection.manifest, publicText: projectionText(projection), pinned: true as const });
  });
  return settle(outcome);
}

export async function publishKnowledgeSite(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; siteId: string; expectedVersion: number; audience: string }) {
  const requestHash = recordHash({ kind: "publish", workspaceId, siteId: input.siteId, expectedVersion: input.expectedVersion, audience: input.audience });
  const outcome = await r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await hold(tx, here.tenantId);
    await requireManager(tx, here, actor);
    if (!await actionAllowed(tx, here.tenantId, actor.id, "publish", true)) throw forbidden();
    const replay = await prior<Outcome>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    const current = await loadSite(tx, here.tenantId, input.siteId);
    if (input.audience !== "public") {
      await saveDraft(tx, here.tenantId, actor.id, input.siteId, "publish", input.expectedVersion, { rejected: "audience" }, input.operationId);
      await audit(tx, actor, "knowledge-site.publish-refused", input.operationId, current.id, { status: current.status, cacheGeneration: num(current.cache_generation), version: num(current.version), audienceConfirmed: false });
      return remember(tx, actor.id, input.operationId, requestHash, { failed: true as const, code: "knowledge_site_audience", message: knowledgeSiteAudience, version: num(current.version) });
    }
    if (num(current.version) !== input.expectedVersion) {
      await saveDraft(tx, here.tenantId, actor.id, input.siteId, "publish", input.expectedVersion, { rejected: "publish" }, input.operationId);
      return remember(tx, actor.id, input.operationId, requestHash, { conflict: true as const, version: num(current.version) });
    }
    const definition = definitionOf(current);
    const projection = await project(tx, here, actor, definition);
    const snapshotId = randomUUID();
    const saved = await writeSite(tx, here, actor, input.operationId, "publish", input.siteId, input.expectedVersion, { status: "published", served: projection, snapshotId, audience: true, bumpCache: true });
    if ("conflict" in saved || "failed" in saved) return remember(tx, actor.id, input.operationId, requestHash, saved);
    await tx.query(
      "INSERT INTO hs_knowledge_site_snapshots(id,site_id,site_version,cache_generation,kind,projection,actor_id,operation_id) VALUES($1,$2,$3,$4,'publish',$5::jsonb,$6,$7)",
      [snapshotId, input.siteId, saved.version, saved.cacheGeneration, JSON.stringify(projection), actor.id, input.operationId],
    );
    await replaceIndex(tx, input.siteId, saved.cacheGeneration, projection);
    return remember(tx, actor.id, input.operationId, requestHash, { ...saved, dryRun: false as const, autoPublished: false as const, projection, manifest: projection.manifest });
  });
  return settle(outcome);
}

export async function unpublishKnowledgeSite(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; siteId: string; expectedVersion: number }) {
  const requestHash = recordHash({ kind: "unpublish", workspaceId, siteId: input.siteId, expectedVersion: input.expectedVersion });
  const outcome = await r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await hold(tx, here.tenantId);
    await requireManager(tx, here, actor);
    if (!await actionAllowed(tx, here.tenantId, actor.id, "unpublish", true)) throw forbidden();
    const replay = await prior<Outcome>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    const current = await loadSite(tx, here.tenantId, input.siteId);
    if (current.status !== "published") {
      await saveDraft(tx, here.tenantId, actor.id, input.siteId, "unpublish", input.expectedVersion, { rejected: "unpublish" }, input.operationId);
      return remember(tx, actor.id, input.operationId, requestHash, { failed: true as const, code: "knowledge_site_unpublished", message: "This site is not published. Nothing was changed.", version: num(current.version) });
    }
    const previousGeneration = num(current.cache_generation);
    const saved = await writeSite(tx, here, actor, input.operationId, "unpublish", input.siteId, input.expectedVersion, { status: "unpublished", bumpCache: true });
    if ("conflict" in saved || "failed" in saved) return remember(tx, actor.id, input.operationId, requestHash, saved);
    await clearIndex(tx, input.siteId);
    return remember(tx, actor.id, input.operationId, requestHash, { ...saved, invalidatedGeneration: previousGeneration, cacheBound: knowledgeSiteCacheBound, thirdPartyRetraction: false as const });
  });
  return settle(outcome);
}

export async function rollbackKnowledgeSite(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; siteId: string; expectedVersion: number }) {
  const requestHash = recordHash({ kind: "rollback", workspaceId, siteId: input.siteId, expectedVersion: input.expectedVersion });
  const outcome = await r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await hold(tx, here.tenantId);
    await requireManager(tx, here, actor);
    if (!await actionAllowed(tx, here.tenantId, actor.id, "rollback", true)) throw forbidden();
    const replay = await prior<Outcome>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    const current = await loadSite(tx, here.tenantId, input.siteId);
    if (num(current.version) !== input.expectedVersion) {
      await saveDraft(tx, here.tenantId, actor.id, input.siteId, "rollback", input.expectedVersion, { rejected: "rollback" }, input.operationId);
      return remember(tx, actor.id, input.operationId, requestHash, { conflict: true as const, version: num(current.version) });
    }
    const snapshots = await tx.query<{ id: string; projection: unknown; created_at: string }>(
      "SELECT id::text, projection, created_at FROM hs_knowledge_site_snapshots WHERE site_id=$1 ORDER BY created_at, id",
      [input.siteId],
    );
    const servedIndex = snapshots.rows.findIndex(item => item.id === current.served_snapshot_id);
    const target = current.status === "unpublished"
      ? snapshots.rows[servedIndex] ?? null
      : servedIndex > 0 ? snapshots.rows[servedIndex - 1] : null;
    if (!target) {
      await saveDraft(tx, here.tenantId, actor.id, input.siteId, "rollback", input.expectedVersion, { rejected: "rollback" }, input.operationId);
      return remember(tx, actor.id, input.operationId, requestHash, { failed: true as const, code: "knowledge_site_rollback", message: "There is no earlier approved snapshot to restore. The draft is kept.", version: num(current.version) });
    }
    const projection = asJson<PublicProjection>(target.projection);
    const previousGeneration = num(current.cache_generation);
    const saved = await writeSite(tx, here, actor, input.operationId, "rollback", input.siteId, input.expectedVersion, { status: "published", served: projection, snapshotId: target.id, bumpCache: true });
    if ("conflict" in saved || "failed" in saved) return remember(tx, actor.id, input.operationId, requestHash, saved);
    await replaceIndex(tx, input.siteId, saved.cacheGeneration, projection);
    return remember(tx, actor.id, input.operationId, requestHash, { ...saved, restoredSnapshotId: target.id, invalidatedGeneration: previousGeneration, cacheBound: knowledgeSiteCacheBound, thirdPartyRetraction: false as const });
  });
  return settle(outcome);
}

export async function activateKnowledgeSite(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; siteId: string; expectedVersion: number }) {
  const requestHash = recordHash({ kind: "activate", workspaceId, siteId: input.siteId, expectedVersion: input.expectedVersion });
  const outcome = await r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await hold(tx, here.tenantId);
    await requireManager(tx, here, actor);
    const replay = await prior<Outcome>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    const current = await loadSite(tx, here.tenantId, input.siteId);
    if (num(current.version) !== input.expectedVersion) {
      await saveDraft(tx, here.tenantId, actor.id, input.siteId, "configure", input.expectedVersion, { rejected: "activate" }, input.operationId);
      return { conflict: true as const, version: num(current.version) };
    }
    await audit(tx, actor, "knowledge-site.activate-refused", input.operationId, current.id, { status: current.status, cacheGeneration: num(current.cache_generation), version: num(current.version) });
    return remember(tx, actor.id, input.operationId, requestHash, { failed: true as const, code: "knowledge_site_live", message: knowledgeSiteLive, version: num(current.version), cacheGeneration: num(current.cache_generation) });
  });
  return settle(outcome);
}

async function servedForActor(tx: Sql, here: Scope, actor: Actor, row: SiteRow, generation: number | null) {
  if (!generationMatches(generation, num(row.cache_generation)) || row.status !== "published") throw unavailable();
  const served = servedOf(row);
  if (!served) throw unavailable();
  const visible = await visibleIds(tx, here, actor.id, definitionOf(row), structuredClone(served));
  if (!visible.pages.length) throw unavailable();
  return visible;
}

export async function renderKnowledgeSite(r: Repository, actor: Actor, workspaceId: string, siteId: string, generation: number | null = null) {
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    const row = await loadSite(tx, here.tenantId, siteId);
    const manage = await isManager(tx, here, actor);
    if (!await actionAllowed(tx, here.tenantId, actor.id, "render", manage)) throw forbidden();
    const projection = await servedForActor(tx, here, actor, row, generation);
    return { ...flags(), id: row.id, status: row.status, cacheGeneration: num(row.cache_generation), projection, liveSite: false as const };
  });
}

export async function downloadKnowledgeSite(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; siteId: string; expectedVersion: number; generation?: number | null }) {
  const generation = input.generation ?? null;
  const requestHash = recordHash({ kind: "download", workspaceId, siteId: input.siteId, expectedVersion: input.expectedVersion, generation });
  const outcome = await r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    const manage = await isManager(tx, here, actor);
    if (!await actionAllowed(tx, here.tenantId, actor.id, "download", manage)) throw forbidden();
    const replay = await prior<Outcome>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    const row = await loadSite(tx, here.tenantId, input.siteId);
    if (num(row.version) !== input.expectedVersion && generation === null) {
      await saveDraft(tx, here.tenantId, actor.id, input.siteId, "render", input.expectedVersion, { rejected: "download" }, input.operationId);
      return remember(tx, actor.id, input.operationId, requestHash, { conflict: true as const, version: num(row.version) });
    }
    const projection = await servedForActor(tx, here, actor, row, generation);
    const body = knowledgeSiteReport(row.name, projection);
    await audit(tx, actor, "knowledge-site.download", input.operationId, row.id, { cacheGeneration: num(row.cache_generation), version: num(row.version) });
    return remember(tx, actor.id, input.operationId, requestHash, flags({ body, version: num(row.version), cacheGeneration: num(row.cache_generation), cacheBound: knowledgeSiteCacheBound }));
  });
  return settle(outcome);
}

export async function readKnowledgeDownload(r: Repository, actor: Actor, workspaceId: string, siteId: string, generation: number | null = null) {
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    const manage = await isManager(tx, here, actor);
    if (!await actionAllowed(tx, here.tenantId, actor.id, "download", manage)) throw forbidden();
    const row = await loadSite(tx, here.tenantId, siteId);
    const projection = await servedForActor(tx, here, actor, row, generation);
    return flags({ body: knowledgeSiteReport(row.name, projection), version: num(row.version), cacheGeneration: num(row.cache_generation), cacheBound: knowledgeSiteCacheBound });
  });
}

export async function readKnowledgeAsset(r: Repository, actor: Actor, workspaceId: string, siteId: string, mediaId: string, generation: number | null = null) {
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    const row = await loadSite(tx, here.tenantId, siteId);
    const manage = await isManager(tx, here, actor);
    if (!await actionAllowed(tx, here.tenantId, actor.id, "download", manage)) throw forbidden();
    if (!generationMatches(generation, num(row.cache_generation)) || row.status !== "published") throw unavailable();
    const asset = await tx.query<{ name: string; mime: string; page_id: string; object_key_stored: boolean; direct_url: string | null }>(
      `SELECT name, mime, page_id, object_key_stored, direct_url FROM hs_knowledge_site_assets
       WHERE site_id=$1 AND cache_generation=$2 AND media_id=$3 AND scan_state='clean' AND quarantined=false`,
      [siteId, num(row.cache_generation), mediaId],
    );
    const found = asset.rows[0];
    if (!found || found.object_key_stored || found.direct_url) throw unavailable();
    if (!await canViewPage(tx, here.workspaceId, found.page_id, actor.id)) throw unavailable();
    return { mediaId, name: found.name, mime: found.mime, pageId: found.page_id, url: null, objectKey: null, fetched: false as const, quarantined: false as const, route: "mediated" as const, ...flags({ cacheGeneration: num(row.cache_generation) }) };
  });
}

export async function setKnowledgeSiteActions(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; userId: string; expectedVersion: number; actions: string[] }) {
  const actions: KnowledgeSiteAction[] = [];
  for (const action of input.actions) {
    if (!knowledgeSiteActions.includes(action as KnowledgeSiteAction) || actions.includes(action as KnowledgeSiteAction)) throw new DocumentError("Check the knowledge site.", "knowledge_site_validation", 422);
    actions.push(action as KnowledgeSiteAction);
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
    const current = await tx.query<{ version: number | string }>("SELECT version FROM hs_knowledge_site_actor_sets WHERE tenant_id=$1 AND user_id=$2", [here.tenantId, input.userId]);
    const version = current.rows[0] ? num(current.rows[0].version) : 0;
    if (version !== input.expectedVersion) {
      await saveDraft(tx, here.tenantId, actor.id, input.userId, "actions", input.expectedVersion, { actions }, input.operationId);
      return { conflict: true as const, version };
    }
    const next = version + 1;
    if (!current.rows[0]) await tx.query("INSERT INTO hs_knowledge_site_actor_sets(tenant_id,user_id,version) VALUES($1,$2,$3)", [here.tenantId, input.userId, next]);
    else await tx.query("UPDATE hs_knowledge_site_actor_sets SET version=$3 WHERE tenant_id=$1 AND user_id=$2", [here.tenantId, input.userId, next]);
    await tx.query("DELETE FROM hs_knowledge_site_actor_actions WHERE tenant_id=$1 AND user_id=$2", [here.tenantId, input.userId]);
    for (const action of actions) await tx.query("INSERT INTO hs_knowledge_site_actor_actions(tenant_id,user_id,action,granted_by) VALUES($1,$2,$3,$4)", [here.tenantId, input.userId, action, actor.id]);
    await audit(tx, actor, "knowledge-site.actions", input.operationId, input.userId, { version: next, actions });
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
    if (grant) await tx.query("INSERT INTO hs_knowledge_site_managers(workspace_id,user_id,granted_by) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [here.workspaceId, input.userId, actor.id]);
    else await tx.query("DELETE FROM hs_knowledge_site_managers WHERE workspace_id=$1 AND user_id=$2", [here.workspaceId, input.userId]);
    await audit(tx, actor, grant ? "knowledge-site.grant-manager" : "knowledge-site.revoke-manager", input.operationId, input.userId, { userId: input.userId });
    return remember(tx, actor.id, input.operationId, requestHash, flags({ userId: input.userId, manager: grant }));
  });
}
export function grantKnowledgeSiteManager(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; userId: string }) {
  return managerChange(r, actor, workspaceId, input, true);
}
export function revokeKnowledgeSiteManager(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; userId: string }) {
  return managerChange(r, actor, workspaceId, input, false);
}

export async function discardKnowledgeSiteDraft(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; siteId: string }) {
  const requestHash = recordHash({ kind: "discard-draft", workspaceId, siteId: input.siteId });
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await requireManager(tx, here, actor);
    const replay = await prior<{ discarded: true }>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    await tx.query("DELETE FROM hs_knowledge_site_drafts WHERE tenant_id=$1 AND actor_id=$2 AND site_key=$3", [here.tenantId, actor.id, input.siteId]);
    return remember(tx, actor.id, input.operationId, requestHash, flags({ discarded: true as const }));
  });
}
