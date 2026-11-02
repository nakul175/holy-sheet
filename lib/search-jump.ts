import { createHash, randomUUID } from "node:crypto";
import type { Actor } from "./auth";
import type { Sql } from "./database";
import { DocumentError, documentBlocks, plainText, validateDocument, type RichNode } from "./document";
import { formatIst } from "./ist-label";
import { personalNavigation } from "./personal-navigation";
import { recordPageHref } from "./record-page-refs";
import type { Repository } from "./repository";
import {
  SEARCH_JUMP_UNAVAILABLE,
  SEARCH_RECENT_LIMIT,
  blockJumpHref,
  createPageActionLabel,
  createRecordActionLabel,
  headingMatches,
  pageQueryMatches,
  parseJumpQuery,
  type SearchCreateAction,
  type SearchHeadingHit,
  type SearchQuickAction,
  type SearchRecentHit,
} from "./search-jump-model";
import type { CurrentSuiteTenantAuthority } from "./shared-records";
import { SharedRecordRepository } from "./shared-records";

export { SEARCH_JUMP_UNAVAILABLE };

const unavailable = () => new DocumentError(SEARCH_JUMP_UNAVAILABLE, "not_found", 404);
const invalid = () => new DocumentError("Invalid search action.", "search_action_validation", 400);
const mismatch = () => new DocumentError("This search action was reused with different fields.", "operation_mismatch", 409);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const pageIdPattern = /^[a-zA-Z0-9_-]{1,100}$/;
const collectionPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,99}$/;

type JumpResult = { pageId: string; blockId: string; version: number; linkId: string | null; recordId: string | null; targetPageId: string | null; display: "chip" | "card" | null; collection: string };

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

async function audit(tx: Sql, actor: Actor, action: string, operationId: string, pageId: string | null, after: Record<string, unknown>) {
  const prior = await tx.query("SELECT id FROM hs_audit WHERE actor_id=$1 AND action=$2 AND correlation_id=$3", [actor.id, action, operationId]);
  if (prior.rows.length) return;
  await tx.query("INSERT INTO hs_audit(id,actor_id,action,page_id,after_value,correlation_id) VALUES($1,$2,$3,$4,$5::jsonb,$6)", [randomUUID(), actor.id, action, pageId, JSON.stringify({ ...after, atIst: formatIst(new Date()) }), operationId]);
}

async function member(tx: Sql, workspaceId: string, actorId: string) {
  const rows = await tx.query("SELECT role FROM hs_members WHERE workspace_id=$1 AND user_id=$2 AND active=true", [workspaceId, actorId]);
  return rows.rows[0] as { role: string } | undefined;
}

async function tenantFor(tx: Sql, workspaceId: string) {
  const rows = await tx.query<{ tenant_id: string; schema_version: number }>(
    "SELECT w.tenant_id, t.schema_version FROM hs_data_workspaces w JOIN hs_data_tenants t ON t.id=w.tenant_id WHERE w.workspace_id=$1",
    [workspaceId],
  );
  return rows.rows[0] ?? null;
}

function deny(error: unknown) {
  if (error instanceof DocumentError && (error.status === 404 || error.status === 403 || error.code === "read_only" || error.code === "record_not_found" || error.code === "record_forbidden")) return true;
  return false;
}

export type { SearchCreateAction, SearchHeadingHit, SearchQuickAction, SearchRecentHit };

export async function searchCommandPalette(r: Repository, actor: Actor, workspaceId: string, input: { query?: string; pageId?: string }) {
  if (!workspaceId || workspaceId.length > 200) throw unavailable();
  const query = (input.query ?? "").trim();
  if (query.length > 512) throw invalid();
  if (input.pageId && !pageIdPattern.test(input.pageId)) throw unavailable();
  const role = await r.db.transaction(async tx => member(tx, workspaceId, actor.id));
  if (!role) throw unavailable();
  const jump = parseJumpQuery(query);
  const headings = jump || input.pageId ? await r.db.transaction(tx => headingHits(tx, actor.id, workspaceId, jump?.pageQuery ?? "", jump?.headingQuery ?? "", input.pageId)) : [];
  const creates = !jump && query ? await r.db.transaction(tx => createActions(tx, actor.id, workspaceId, role.role, query)) : [];
  if (query) return { recents: [] as SearchRecentHit[], quickActions: [] as SearchQuickAction[], headings, creates };
  const navigation = await personalNavigation(r, actor, workspaceId);
  const recents = navigation.recents.slice(0, SEARCH_RECENT_LIMIT).map(item => ({ id: item.id, title: item.title, href: `/pages/${encodeURIComponent(item.id)}`, spaceName: item.spaceName }));
  const actions = await r.db.transaction(tx => quickActions(tx, actor.id, workspaceId, role.role));
  return { recents, quickActions: actions, headings, creates };
}

async function headingHits(tx: Sql, actorId: string, workspaceId: string, pageQuery: string, headingQuery: string, pageId?: string): Promise<SearchHeadingHit[]> {
  const pages = await tx.query<{ id: string; title: string }>(
    `WITH RECURSIVE permitted(id) AS (
      SELECT p.id FROM hs_pages p JOIN hs_members m ON m.workspace_id=p.workspace_id AND m.user_id=$2 AND m.active=true
      WHERE p.workspace_id=$1 AND p.deleted_at IS NULL AND (m.role IN ('owner','admin') OR p.owner_id=$2 OR EXISTS(SELECT 1 FROM hs_grants g WHERE g.page_id=p.id AND (g.subject=$2 OR (p.visibility='space' AND g.subject='space'))))
      UNION SELECT p.id FROM hs_pages p JOIN permitted a ON a.id=p.parent_id WHERE p.workspace_id=$1 AND p.deleted_at IS NULL
    ) SELECT p.id, p.title FROM hs_pages p JOIN permitted a ON a.id=p.id
      WHERE NOT EXISTS(SELECT 1 FROM hs_document_workflows w WHERE w.page_id=p.id) AND ($3::text IS NULL OR p.id=$3)
      ORDER BY p.updated_at DESC, p.id LIMIT 2000`,
    [workspaceId, actorId, pageId ?? null],
  );
  const matched = pages.rows.filter(page => pageId ? page.id === pageId : pageQueryMatches(page.title, pageQuery)).slice(0, 20);
  if (!matched.length) return [];
  const blocks = await tx.query<{ id: string; page_id: string; position: number; node: RichNode | string }>(
    "SELECT id, page_id, position, node FROM hs_blocks WHERE type='heading' AND page_id = ANY($1::text[]) ORDER BY page_id, position, id",
    [matched.map(page => page.id)],
  );
  const titles = new Map(matched.map(page => [page.id, page.title]));
  const hits: SearchHeadingHit[] = [];
  for (const block of blocks.rows) {
    const node = typeof block.node === "string" ? JSON.parse(block.node) as RichNode : block.node;
    const level = Number(node?.attrs?.level);
    if (![1, 2, 3].includes(level)) continue;
    const text = plainText(node).replace(/\s+/g, " ").trim();
    if (headingQuery && !headingMatches(text || "Untitled heading", headingQuery)) continue;
    hits.push({ pageId: block.page_id, pageTitle: titles.get(block.page_id) ?? "", blockId: block.id, level, text: text || "Untitled heading", href: blockJumpHref(block.page_id, block.id) });
  }
  return hits.slice(0, 50);
}

async function creatableSpaces(tx: Sql, actorId: string, workspaceId: string, role: string) {
  if (role === "observer") return [];
  const rows = await tx.query<{ id: string; name: string }>("SELECT id, name FROM hs_spaces WHERE workspace_id=$1 ORDER BY name, id", [workspaceId]);
  return rows.rows;
}

async function creatableCollections(tx: Sql, actorId: string, workspaceId: string) {
  const rows = await tx.query<{ id: string; name: string }>(
    `SELECT c.id, c.name FROM hs_data_collections c
     JOIN hs_data_workspaces w ON w.tenant_id=c.tenant_id
     JOIN hs_data_collection_grants g ON g.tenant_id=c.tenant_id AND g.collection=c.id AND g.user_id=$2
     WHERE w.workspace_id=$1 AND 'view'=ANY(g.capabilities) AND 'create'=ANY(g.capabilities)
       AND NOT EXISTS(SELECT 1 FROM hs_data_collection_settings s WHERE s.tenant_id=c.tenant_id AND s.collection=c.id AND s.removed_at IS NOT NULL)
     ORDER BY c.name, c.id`,
    [workspaceId, actorId],
  );
  return rows.rows;
}

async function createActions(tx: Sql, actorId: string, workspaceId: string, role: string, title: string): Promise<SearchCreateAction[]> {
  const label = title.normalize("NFC").trim();
  if (!label || [...label].length > 200) return [];
  const actions: SearchCreateAction[] = [];
  for (const space of await creatableSpaces(tx, actorId, workspaceId, role)) actions.push({ kind: "page", label: createPageActionLabel(label, space.name), spaceId: space.id, title: label });
  for (const collection of await creatableCollections(tx, actorId, workspaceId)) actions.push({ kind: "record", label: createRecordActionLabel(label, collection.name), collection: collection.id, title: label });
  return actions;
}

async function quickActions(tx: Sql, actorId: string, workspaceId: string, role: string): Promise<SearchQuickAction[]> {
  const spaces = await tx.query<{ id: string; name: string }>("SELECT id, name FROM hs_spaces WHERE workspace_id=$1 ORDER BY name, id", [workspaceId]);
  const actions: SearchQuickAction[] = [];
  if (role !== "observer") for (const space of spaces.rows) actions.push({ id: `new-page:${space.id}`, label: spaces.rows.length === 1 ? "New page" : `New page in ${space.name}`, kind: "new-page", spaceId: space.id });
  for (const collection of await creatableCollections(tx, actorId, workspaceId)) actions.push({ id: `new-record:${collection.id}`, label: "New record", kind: "new-record", collection: collection.id });
  for (const space of spaces.rows) actions.push({ id: `home:${space.id}`, label: "Go to space home", kind: "space-home", href: `/workspaces/${encodeURIComponent(workspaceId)}/spaces/${encodeURIComponent(space.id)}`, spaceId: space.id });
  return actions;
}

type InsertRequest = { operationId: string; recordId: string | null; targetPageId: string | null; display: "chip" | "card"; stage: boolean };

function insertRequest(body: unknown): InsertRequest {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw invalid();
  const value = body as Record<string, unknown>;
  if (typeof value.operationId !== "string" || !uuid.test(value.operationId)) throw invalid();
  const recordRaw = value.record_id ?? value.recordId;
  const pageRaw = value.target_page_id ?? value.targetPageId;
  const recordId = recordRaw === undefined ? null : recordRaw;
  const targetPageId = pageRaw === undefined ? null : pageRaw;
  if (recordId !== null && (typeof recordId !== "string" || !uuid.test(recordId))) throw unavailable();
  if (targetPageId !== null && (typeof targetPageId !== "string" || !pageIdPattern.test(targetPageId))) throw unavailable();
  if (!recordId === !targetPageId) throw invalid();
  const display = value.display === undefined ? "chip" : value.display;
  if (display !== "chip" && display !== "card") throw invalid();
  if (value.stage !== undefined && typeof value.stage !== "boolean") throw invalid();
  return { operationId: value.operationId, recordId, targetPageId, display, stage: value.stage === true };
}

function referenceNode(blockId: string, request: InsertRequest, collection: string): RichNode {
  if (request.recordId) return { type: "recordRef", attrs: { id: blockId, nodeVersion: 1, recordId: request.recordId, collectionId: collection, display: request.display, fields: [] } };
  return { type: "pageLink", attrs: { id: blockId, pageId: request.targetPageId } };
}

async function visibleRecord(tx: Sql, tenantId: string, actorId: string, recordId: string) {
  const rows = await tx.query<{ collection: string }>(
    `SELECT r.collection FROM hs_data_records r
     WHERE r.id=$1 AND r.tenant_id=$2 AND r.merged_into_id IS NULL AND r.state<>'trashed'
       AND (EXISTS(SELECT 1 FROM hs_data_collection_grants g WHERE g.tenant_id=r.tenant_id AND g.user_id=$3 AND g.collection=r.collection AND 'view'=ANY(g.capabilities))
         OR EXISTS(SELECT 1 FROM hs_data_record_grants g WHERE g.tenant_id=r.tenant_id AND g.record_id=r.id AND g.user_id=$3 AND 'view'=ANY(g.capabilities)))`,
    [recordId, tenantId, actorId],
  );
  return rows.rows[0]?.collection ?? null;
}

/** Records a live reference and its backlink when the actor can still read the target. */
export async function syncRecordReferenceLinks(tx: Sql, actor: Actor, workspaceId: string, pageId: string, document: RichNode, operationId: string) {
  const refs = documentBlocks(document).filter(block => block.type === "recordRef");
  if (!refs.length || !uuid.test(operationId)) return [];
  const tenant = await tenantFor(tx, workspaceId);
  if (!tenant) return [];
  const linked: { recordId: string; linkId: string; created: boolean }[] = [];
  for (const block of refs) {
    const recordId = String(block.node.attrs?.recordId ?? "");
    if (!uuid.test(recordId)) continue;
    const inserted = await tx.query<{ id: string }>(
      `INSERT INTO hs_document_record_links(id,workspace_id,tenant_id,doc_type,doc_id,record_id,created_by)
       SELECT $1,$2,$3,'page',$4,r.id,$6 FROM hs_data_records r
       WHERE r.id=$5 AND r.tenant_id=$3 AND r.merged_into_id IS NULL AND r.state<>'trashed'
       ON CONFLICT (workspace_id, doc_type, doc_id, record_id) DO NOTHING
       RETURNING id`,
      [randomUUID(), workspaceId, tenant.tenant_id, pageId, recordId, actor.id],
    );
    const existing = inserted.rows[0] ?? (await tx.query<{ id: string }>("SELECT id FROM hs_document_record_links WHERE workspace_id=$1 AND doc_type='page' AND doc_id=$2 AND record_id=$3", [workspaceId, pageId, recordId])).rows[0];
    if (!existing) continue;
    linked.push({ recordId, linkId: existing.id, created: inserted.rows.length > 0 });
  }
  const created = linked.filter(item => item.created);
  if (created.length) await audit(tx, actor, "search-jump.backlink", operationId, pageId, { pageId, recordIds: created.map(item => item.recordId), linkIds: created.map(item => item.linkId) });
  return linked;
}

export async function insertSearchReference(r: Repository, actor: Actor, pageId: string, body: unknown) {
  if (!pageIdPattern.test(pageId)) throw unavailable();
  const request = insertRequest(body);
  const requestHash = hash({ pageId, recordId: request.recordId, targetPageId: request.targetPageId, display: request.display });
  const outcome = await r.db.transaction(async tx => {
    const user = await tx.query("SELECT id FROM hs_users WHERE id=$1 FOR NO KEY UPDATE", [actor.id]);
    if (!user.rows.length) return { ok: false as const };
    const prior = await tx.query<{ request_hash: string; result: JumpResult | string }>("SELECT request_hash, result FROM hs_search_jump_operations WHERE actor_id=$1 AND operation_id=$2", [actor.id, request.operationId]);
    if (prior.rows.length) {
      if (prior.rows[0].request_hash !== requestHash) throw mismatch();
      const stored = typeof prior.rows[0].result === "string" ? JSON.parse(prior.rows[0].result) as JumpResult : prior.rows[0].result;
      return { ok: true as const, replayed: true, stored };
    }
    let editable;
    try { editable = await r.access(tx, pageId, actor, true, true); }
    catch (error) {
      if (!deny(error)) throw error;
      await audit(tx, actor, "search-jump.denied", request.operationId, pageIdPattern.test(pageId) ? pageId : null, { pageId, recordId: request.recordId, targetPageId: request.targetPageId });
      return { ok: false as const };
    }
    const tenant = await tenantFor(tx, editable.workspace_id);
    let collection = "";
    if (request.recordId) {
      collection = tenant ? await visibleRecord(tx, tenant.tenant_id, actor.id, request.recordId) ?? "" : "";
      if (!collection) {
        await audit(tx, actor, "search-jump.denied", request.operationId, pageId, { pageId, recordId: request.recordId });
        return { ok: false as const };
      }
    } else if (request.targetPageId) {
      try { const target = await r.get(request.targetPageId, actor, tx, undefined, false); if (target.workspaceId !== editable.workspace_id) throw unavailable(); }
      catch (error) {
        if (!deny(error) && !(error instanceof DocumentError && error.status === 404)) throw error;
        await audit(tx, actor, "search-jump.denied", request.operationId, pageId, { pageId, targetPageId: request.targetPageId });
        return { ok: false as const };
      }
    }
    const blockId = randomUUID();
    const node = referenceNode(blockId, request, collection);
    const current = await r.get(pageId, actor, tx, undefined, false);
    const document = validateDocument({ type: "doc", content: [...(current.document.content ?? []), node] });
    if (request.stage) return { ok: true as const, replayed: false, staged: true as const, node, pageId, workspaceId: editable.workspace_id };
    const version = editable.version + 1;
    await r.writeDocument(tx, pageId, document, version, current.title, actor.id, "api", undefined, request.operationId);
    await tx.query("UPDATE hs_pages SET version=$2, updated_at=clock_timestamp() WHERE id=$1", [pageId, version]);
    const links = request.recordId ? await syncRecordReferenceLinks(tx, actor, editable.workspace_id, pageId, document, request.operationId) : [];
    const stored: JumpResult = { pageId, blockId, version, linkId: links.find(item => item.recordId === request.recordId)?.linkId ?? null, recordId: request.recordId, targetPageId: request.targetPageId, display: request.recordId ? request.display : null, collection };
    await tx.query("INSERT INTO hs_search_jump_operations(actor_id,operation_id,request_hash,result) VALUES($1,$2,$3,$4::jsonb)", [actor.id, request.operationId, requestHash, JSON.stringify(stored)]);
    await audit(tx, actor, "search-jump.insert", request.operationId, pageId, { pageId, blockId, recordId: request.recordId, targetPageId: request.targetPageId, linkId: stored.linkId, version });
    return { ok: true as const, replayed: false, staged: false as const, node, stored };
  });
  if (!outcome.ok) throw unavailable();
  if ("staged" in outcome && outcome.staged) return { staged: true, replayed: false, node: outcome.node, pageId: outcome.pageId };
  const stored = outcome.stored;
  const node = "node" in outcome && outcome.node ? outcome.node : referenceNode(stored.blockId, { ...request, recordId: stored.recordId, targetPageId: stored.targetPageId, display: stored.display ?? "chip" }, stored.collection);
  return { staged: false, replayed: outcome.replayed, pageId: stored.pageId, blockId: stored.blockId, version: stored.version, linkId: stored.linkId, recordId: stored.recordId, node };
}

export async function jumpSearchHeading(r: Repository, actor: Actor, workspaceId: string, pageId: string, blockId: string) {
  if (!workspaceId || workspaceId.length > 200 || !pageIdPattern.test(pageId) || !pageIdPattern.test(blockId)) throw unavailable();
  try {
    const page = await r.get(pageId, actor);
    if (page.workspaceId !== workspaceId) throw unavailable();
    const block = documentBlocks(page.document).find(item => item.id === blockId && (item.type === "heading" || item.type === "paragraph"));
    if (!block) throw unavailable();
    return { href: blockJumpHref(pageId, blockId), pageId, blockId };
  } catch (error) {
    if (deny(error) || error instanceof DocumentError && error.code === "not_found") throw unavailable();
    throw error;
  }
}

export async function peekSearchRecord(r: Repository, actor: Actor, workspaceId: string, recordId: string) {
  if (!workspaceId || workspaceId.length > 200 || !uuid.test(recordId)) throw unavailable();
  return r.db.transaction(async tx => {
    if (!await member(tx, workspaceId, actor.id)) throw unavailable();
    const tenant = await tenantFor(tx, workspaceId);
    const collection = tenant ? await visibleRecord(tx, tenant.tenant_id, actor.id, recordId) : null;
    if (!tenant || !collection) throw unavailable();
    const name = await tx.query<{ name: string }>("SELECT name FROM hs_data_records WHERE id=$1 AND tenant_id=$2 AND state='active'", [recordId, tenant.tenant_id]);
    if (!name.rows.length) throw unavailable();
    return { title: name.rows[0].name, href: recordPageHref(workspaceId, tenant.tenant_id, collection, recordId), collection, recordId, tenantId: tenant.tenant_id };
  });
}

function commandBody(body: unknown) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw invalid();
  return body as Record<string, unknown>;
}

export async function createSearchPage(r: Repository, actor: Actor, workspaceId: string, body: unknown) {
  const value = commandBody(body);
  if (typeof value.operationId !== "string" || !uuid.test(value.operationId)) throw invalid();
  if (typeof value.spaceId !== "string" || !pageIdPattern.test(value.spaceId)) throw unavailable();
  if (typeof value.title !== "string") throw invalid();
  const title = value.title.normalize("NFC").trim();
  if (!title || [...title].length > 240) throw invalid();
  const seen = await r.db.query("SELECT id FROM hs_audit WHERE actor_id=$1 AND action='search-jump.create-page' AND correlation_id=$2", [actor.id, value.operationId]);
  const allowed = await r.db.transaction(async tx => {
    const role = await member(tx, workspaceId, actor.id);
    if (!role || role.role === "observer") return false;
    const space = await tx.query("SELECT id FROM hs_spaces WHERE id=$1 AND workspace_id=$2", [value.spaceId, workspaceId]);
    return space.rows.length > 0;
  });
  if (!allowed) throw unavailable();
  let page;
  try { page = await r.create(actor, title, value.spaceId, null, value.operationId); }
  catch (error) { if (deny(error)) throw unavailable(); throw error; }
  if (page.workspaceId !== workspaceId) throw unavailable();
  await r.db.transaction(async tx => { await audit(tx, actor, "search-jump.create-page", value.operationId as string, page.id, { pageId: page.id, spaceId: page.spaceId }); });
  return { pageId: page.id, title: page.title, href: `/pages/${encodeURIComponent(page.id)}`, replayed: seen.rows.length > 0 };
}

export async function createSearchRecord(r: Repository, actor: Actor, authority: CurrentSuiteTenantAuthority, workspaceId: string, body: unknown) {
  const value = commandBody(body);
  if (typeof value.operationId !== "string" || !uuid.test(value.operationId)) throw invalid();
  if (typeof value.collection !== "string" || !collectionPattern.test(value.collection)) throw unavailable();
  if (typeof value.title !== "string") throw invalid();
  const title = value.title.normalize("NFC").trim();
  if (!title || [...title].length > 200) throw invalid();
  const tenant = await r.db.transaction(async tx => {
    const role = await member(tx, workspaceId, actor.id);
    if (!role) return null;
    const collections = await creatableCollections(tx, actor.id, workspaceId);
    if (!collections.some(item => item.id === value.collection)) return null;
    return tenantFor(tx, workspaceId);
  });
  if (!tenant) throw unavailable();
  let created;
  try {
    created = await new SharedRecordRepository(r, authority).create(
      { actor, workspaceId, tenantId: tenant.tenant_id },
      { operationId: value.operationId as string, collection: value.collection, name: title, schemaVersion: tenant.schema_version, values: {} },
    );
  } catch (error) { if (deny(error)) throw unavailable(); throw error; }
  await r.db.transaction(async tx => { await audit(tx, actor, "search-jump.create-record", value.operationId as string, null, { recordId: created.record.id, collection: value.collection }); });
  return { recordId: created.record.id, title: created.record.name, href: recordPageHref(workspaceId, tenant.tenant_id, value.collection, created.record.id), replayed: created.replayed };
}

export async function runSearchCommand(r: Repository, actor: Actor, authority: CurrentSuiteTenantAuthority | null, workspaceId: string, body: unknown) {
  const value = commandBody(body);
  if (value.action === "create-page") return createSearchPage(r, actor, workspaceId, body);
  if (value.action === "create-record") {
    if (!authority) throw unavailable();
    return createSearchRecord(r, actor, authority, workspaceId, body);
  }
  if (value.action === "jump") {
    if (typeof value.pageId !== "string" || typeof value.blockId !== "string") throw unavailable();
    return jumpSearchHeading(r, actor, workspaceId, value.pageId, value.blockId);
  }
  if (value.action === "peek") {
    if (typeof value.recordId !== "string") throw unavailable();
    return peekSearchRecord(r, actor, workspaceId, value.recordId);
  }
  throw invalid();
}
