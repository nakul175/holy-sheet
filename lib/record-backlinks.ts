import { randomUUID } from "node:crypto";
import type { Actor } from "./auth";
import type { Sql } from "./database";
import { DocumentError, plainText, type RichNode } from "./document";
import { formatIst } from "./ist-label";
import { loadPageAccessContext, pageReadable } from "./page-tree";
import type { Repository } from "./repository";
import { blockJumpHref } from "./search-jump-model";
import { compileRecordView, recordViewDefinition } from "./shared-record-view-query";
import { standardRecordFields, type RecordField } from "./shared-record-types";

export { RECORD_BACKLINK_POLL_MS, acceptedMentionList, acceptedViewMentionList } from "./record-backlink-client";
export const RECORD_BACKLINK_PAGE_SIZE = 20;
export const RECORD_VIEW_MENTION_LIMIT = 20;
export const RECORD_BACKLINK_MISSING = "Record is restricted or unavailable.";
export const PAGE_BACKLINK_MISSING = "Page is restricted or unavailable.";
export const RECORD_LINK_REJECTED = "Choose an accessible record in this workspace.";

const missing = () => new DocumentError(RECORD_BACKLINK_MISSING, "record_not_found", 404);
const pageMissing = () => new DocumentError(PAGE_BACKLINK_MISSING, "not_found", 404);
const rejected = () => new DocumentError(RECORD_LINK_REJECTED, "reference_unavailable", 422);
const invalid = () => new DocumentError("Invalid backlink request.", "backlink_validation", 400);
const cursorChanged = () => new DocumentError("This list changed. Refresh from the first page.", "backlink_cursor_changed", 409);

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const token = /^[A-Za-z0-9_-]{1,100}$/;
const VIEW_SCAN_LIMIT = 200;

export type MentionType = "chip" | "card" | "link";
export type MentionSort = "edited" | "title";
export type MentionOrder = "asc" | "desc";

export type RecordMention = { blockId: string; recordId: string; refType: MentionType };

export type BacklinkQuery = {
  workspaceId: string | null;
  tenantId: string | null;
  sort: MentionSort;
  order: MentionOrder;
  spaceId: string | null;
  cursor: string | null;
  includeTrash: boolean;
  section: "mentions" | "views";
  openPageId: string | null;
};

export type MentionItem = {
  pageId: string;
  title: string;
  spaceId: string;
  spaceName: string;
  breadcrumb: string;
  referenceType: MentionType;
  referenceTypes: MentionType[];
  referenceLabel: string;
  icon: string;
  snippet: string;
  editedAt: string;
  editedAtIst: string;
  blockId: string;
  href: string;
  trashLabel: "In trash" | null;
};

export type MentionList = {
  heading: string;
  count: number;
  items: MentionItem[];
  nextCursor: string | null;
  spaces: { id: string; name: string }[];
  canIncludeTrash: boolean;
  sort: MentionSort;
  order: MentionOrder;
  spaceId: string | null;
};

export type ViewMention = {
  pageId: string;
  title: string;
  spaceName: string;
  viewName: string;
  blockId: string;
  href: string;
};

export type ViewMentionList = {
  section: "views";
  heading: "Appears in view blocks";
  items: ViewMention[];
  limit: number;
};

export type OpenMention = { href: string; pageId: string; blockId: string };

const ICONS: Record<MentionType, string> = { chip: "▣", card: "▤", link: "↗" };
const LABELS: Record<MentionType, string> = { chip: "Chip", card: "Card", link: "Link" };
const TYPE_ORDER: MentionType[] = ["chip", "card", "link"];

type AccessRow = { id: string; tenant_id: string; workspace_id: string; role: string };
type PageRow = { id: string; title: string; space_id: string; space_name: string; parent_id: string | null; updated_at: string | Date; deleted_at: string | Date | null; workspace_id: string };
type StoredRef = { page_id: string; block_id: string; ref_type: MentionType };

export function mentionedHeading(count: number) {
  const noun = count === 1 ? "page" : "pages";
  return `Mentioned in ${count} ${noun} you can see`;
}

export function clampSnippet(text: string) {
  const chars = Array.from(text.replace(/\s+/g, " ").trim());
  return chars.length <= 120 ? chars.join("") : chars.slice(0, 120).join("");
}

export function recordIdFromHref(href: string): string | null {
  if (!href || href.length > 2048 || /[\u0000-\u0020]/.test(href)) return null;
  let url: URL;
  try { url = new URL(href, "https://holy.sheet"); } catch { return null; }
  if (!url.pathname.includes("/records")) return null;
  const query = url.searchParams.get("record");
  if (query && uuid.test(query)) return query.toLowerCase();
  const parts = url.pathname.split("/").filter(Boolean);
  const last = parts.at(-1) ?? "";
  return parts.includes("records") && uuid.test(last) ? last.toLowerCase() : null;
}

export function extractRecordMentions(document: RichNode): RecordMention[] {
  const found: RecordMention[] = [];
  const visit = (node: RichNode) => {
    if (node.type === "recordRef") {
      const recordId = String(node.attrs?.recordId ?? "");
      const blockId = String(node.attrs?.id ?? "");
      const display = node.attrs?.display;
      if (uuid.test(recordId) && token.test(blockId) && (display === "chip" || display === "card")) found.push({ blockId, recordId: recordId.toLowerCase(), refType: display });
      return;
    }
    if (node.type !== "recordView") {
      const blockId = typeof node.attrs?.id === "string" ? node.attrs.id : "";
      for (const child of node.content ?? []) {
        if (child.type !== "text") continue;
        const href = child.marks?.find(mark => mark.type === "link")?.attrs?.href;
        const recordId = typeof href === "string" ? recordIdFromHref(href) : null;
        if (recordId && token.test(blockId)) found.push({ blockId, recordId, refType: "link" });
      }
    }
    for (const child of node.content ?? []) if (child.type !== "text") visit(child);
  };
  visit(document);
  const seen = new Set<string>();
  const unique: RecordMention[] = [];
  for (const hit of found) {
    const key = `${hit.recordId}\0${hit.blockId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(hit);
  }
  return unique;
}

export function contextSnippet(blocks: { id: string; parentId: string | null; position: number; node: RichNode }[], blockId: string) {
  const block = blocks.find(item => item.id === blockId);
  if (!block) return "";
  const own = clampSnippet(plainText(block.node));
  if (own) return own;
  const siblings = blocks.filter(item => item.parentId === block.parentId).sort((a, b) => a.position - b.position || a.id.localeCompare(b.id));
  const index = siblings.findIndex(item => item.id === blockId);
  for (const step of [index - 1, index + 1]) {
    if (step < 0 || step >= siblings.length) continue;
    const text = clampSnippet(plainText(siblings[step].node));
    if (text) return text;
  }
  return "";
}

export function parseRecordBacklinkQuery(url: URL): BacklinkQuery {
  const allowed = new Set(["workspaceId", "tenantId", "sort", "order", "space", "cursor", "includeTrash", "section", "open"]);
  for (const key of url.searchParams.keys()) if (!allowed.has(key)) throw invalid();
  const workspaceId = url.searchParams.get("workspaceId");
  const tenantId = url.searchParams.get("tenantId");
  const sort = url.searchParams.get("sort") ?? "edited";
  const requestedOrder = url.searchParams.get("order");
  const spaceId = url.searchParams.get("space");
  const cursor = url.searchParams.get("cursor");
  const includeTrash = url.searchParams.get("includeTrash");
  const section = url.searchParams.get("section");
  const openPageId = url.searchParams.get("open");
  if (workspaceId !== null && (!workspaceId || workspaceId.length > 200)) throw invalid();
  if (tenantId !== null && !uuid.test(tenantId)) throw invalid();
  if ((workspaceId === null) !== (tenantId === null) && (workspaceId !== null || tenantId !== null)) {
    if (workspaceId === null || tenantId === null) throw invalid();
  }
  if (sort !== "edited" && sort !== "title") throw invalid();
  const order = requestedOrder ?? (sort === "title" ? "asc" : "desc");
  if (order !== "asc" && order !== "desc") throw invalid();
  if (spaceId !== null && !token.test(spaceId)) throw invalid();
  if (cursor !== null && (cursor.length > 800 || !/^[A-Za-z0-9_-]+$/.test(cursor))) throw invalid();
  if (includeTrash !== null && includeTrash !== "1") throw invalid();
  if (section !== null && section !== "views") throw invalid();
  if (openPageId !== null && !token.test(openPageId)) throw invalid();
  if (section === "views" && openPageId) throw invalid();
  return {
    workspaceId,
    tenantId,
    sort,
    order,
    spaceId,
    cursor,
    includeTrash: includeTrash === "1",
    section: section === "views" ? "views" : "mentions",
    openPageId,
  };
}

function asNode(value: unknown): RichNode | null {
  if (!value) return null;
  if (typeof value === "string") {
    try { return JSON.parse(value) as RichNode; } catch { return null; }
  }
  return typeof value === "object" ? value as RichNode : null;
}

function iso(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date(0).toISOString() : date.toISOString();
}

async function audit(tx: Sql, actor: Actor, action: string, operationId: string, pageId: string | null, after: Record<string, unknown>) {
  if (!uuid.test(operationId)) return;
  const prior = await tx.query("SELECT 1 FROM hs_audit WHERE actor_id=$1 AND action=$2 AND correlation_id=$3", [actor.id, action, operationId]);
  if (prior.rows.length) return;
  await tx.query("INSERT INTO hs_audit(id,actor_id,action,page_id,after_value,correlation_id) VALUES($1,$2,$3,$4,$5,$6)", [randomUUID(), actor.id, action, pageId, JSON.stringify(after), operationId]);
}

async function tenantFor(tx: Sql, workspaceId: string) {
  const row = await tx.query<{ tenant_id: string }>("SELECT tenant_id FROM hs_data_workspaces WHERE workspace_id=$1", [workspaceId]);
  return row.rows[0]?.tenant_id ?? null;
}

async function readableRecord(tx: Sql, tenantId: string, actorId: string, recordId: string) {
  const row = await tx.query(
    `SELECT 1 FROM hs_data_records r WHERE r.id=$1 AND r.tenant_id=$2 AND r.merged_into_id IS NULL AND r.state<>'trashed'
       AND (EXISTS(SELECT 1 FROM hs_data_collection_grants g WHERE g.tenant_id=r.tenant_id AND g.user_id=$3 AND g.collection=r.collection AND 'view'=ANY(g.capabilities))
         OR EXISTS(SELECT 1 FROM hs_data_record_grants g WHERE g.tenant_id=r.tenant_id AND g.record_id=r.id AND g.user_id=$3 AND 'view'=ANY(g.capabilities)))`,
    [recordId, tenantId, actorId],
  );
  return row.rows.length > 0;
}

export async function syncRecordBacklinks(tx: Sql, pageId: string, document: RichNode, actorId?: string, operationId?: string) {
  const page = await tx.query<{ workspace_id: string }>("SELECT workspace_id FROM hs_pages WHERE id=$1", [pageId]);
  const workspaceId = page.rows[0]?.workspace_id;
  if (!workspaceId) return;
  const tenantId = await tenantFor(tx, workspaceId);
  const hits = tenantId ? extractRecordMentions(document) : [];
  const kept: RecordMention[] = [];
  if (tenantId) {
    for (const hit of hits) {
      const same = await tx.query("SELECT 1 FROM hs_data_records WHERE id=$1 AND tenant_id=$2", [hit.recordId, tenantId]);
      if (same.rows.length) kept.push(hit);
    }
  }
  const before = await tx.query<{ record_id: string; block_id: string; ref_type: string }>("SELECT record_id, block_id, ref_type FROM hs_record_backlinks WHERE page_id=$1", [pageId]);
  const signature = (rows: { recordId: string; blockId: string; refType: string }[]) => rows.map(row => `${row.recordId}:${row.blockId}:${row.refType}`).sort().join("|");
  const nextKey = signature(kept);
  const prevKey = signature(before.rows.map(row => ({ recordId: row.record_id, blockId: row.block_id, refType: row.ref_type })));
  if (nextKey === prevKey) return;
  await tx.query("DELETE FROM hs_record_backlinks WHERE page_id=$1", [pageId]);
  for (const hit of kept) {
    await tx.query(
      `INSERT INTO hs_record_backlinks(workspace_id,record_id,page_id,block_id,ref_type) VALUES($1,$2,$3,$4,$5)
       ON CONFLICT (workspace_id, record_id, page_id, block_id) DO UPDATE SET ref_type=EXCLUDED.ref_type, updated_at=clock_timestamp()`,
      [workspaceId, hit.recordId, pageId, hit.blockId, hit.refType],
    );
  }
  if (actorId && operationId) await audit(tx, { id: actorId }, "record-backlink.index", operationId, pageId, { pageId, recordIds: kept.map(hit => hit.recordId), blockIds: kept.map(hit => hit.blockId), refTypes: kept.map(hit => hit.refType) });
}

export async function validateNewRecordLinks(tx: Sql, actor: Actor, workspaceId: string, next: RichNode, previous: RichNode) {
  const before = new Set(extractRecordMentions(previous).filter(hit => hit.refType === "link").map(hit => `${hit.blockId}:${hit.recordId}`));
  const fresh = extractRecordMentions(next).filter(hit => hit.refType === "link" && !before.has(`${hit.blockId}:${hit.recordId}`));
  if (!fresh.length) return;
  const tenantId = await tenantFor(tx, workspaceId);
  for (const hit of fresh) {
    if (!tenantId || !await readableRecord(tx, tenantId, actor.id, hit.recordId)) throw rejected();
  }
}

export async function noteRecordBacklinkPages(tx: Sql, actor: Actor, pageIds: string[], operationId: string, action: "record-backlink.trash" | "record-backlink.restore") {
  if (!pageIds.length || !uuid.test(operationId)) return;
  const rows = await tx.query<{ page_id: string; record_id: string; block_id: string }>("SELECT page_id, record_id, block_id FROM hs_record_backlinks WHERE page_id = ANY($1::text[]) ORDER BY page_id, record_id, block_id", [pageIds]);
  if (!rows.rows.length) return;
  const recordIds = [...new Set(rows.rows.map(row => row.record_id))];
  const blockIds = rows.rows.map(row => row.block_id);
  await audit(tx, actor, action, operationId, rows.rows[0].page_id, { pageIds: [...new Set(rows.rows.map(row => row.page_id))], recordIds, blockIds });
}

export async function purgeRecordBacklinks(tx: Sql, actor: Actor, pageId: string, operationId: string) {
  if (!token.test(pageId) || !uuid.test(operationId)) throw invalid();
  const page = await tx.query("SELECT id FROM hs_pages WHERE id=$1", [pageId]);
  if (!page.rows.length) throw pageMissing();
  const removed = await tx.query<{ record_id: string; block_id: string }>("DELETE FROM hs_record_backlinks WHERE page_id=$1 RETURNING record_id, block_id", [pageId]);
  if (removed.rows.length) await audit(tx, actor, "record-backlink.purge", operationId, pageId, { pageId, recordIds: removed.rows.map(row => row.record_id), blockIds: removed.rows.map(row => row.block_id) });
  return { purged: removed.rows.length };
}

async function requireRecord(tx: Sql, actor: Actor, recordId: string, query: Pick<BacklinkQuery, "workspaceId" | "tenantId">): Promise<AccessRow> {
  if (!uuid.test(recordId)) throw missing();
  const row = await tx.query<AccessRow>(
    `SELECT r.id, r.tenant_id, w.workspace_id, m.role
     FROM hs_data_records r
     JOIN hs_data_workspaces w ON w.tenant_id = r.tenant_id
     JOIN hs_members m ON m.workspace_id = w.workspace_id AND m.user_id = $2 AND m.active = true
     WHERE r.id = $1 AND r.merged_into_id IS NULL AND r.state <> 'trashed'
       AND ($3::text IS NULL OR w.workspace_id = $3)
       AND ($4::uuid IS NULL OR r.tenant_id = $4)
       AND (EXISTS(SELECT 1 FROM hs_data_collection_grants g WHERE g.tenant_id = r.tenant_id AND g.user_id = $2 AND g.collection = r.collection AND 'view' = ANY(g.capabilities))
         OR EXISTS(SELECT 1 FROM hs_data_record_grants g WHERE g.tenant_id = r.tenant_id AND g.record_id = r.id AND g.user_id = $2 AND 'view' = ANY(g.capabilities)))
     ORDER BY w.workspace_id
     LIMIT 1`,
    [recordId, actor.id, query.workspaceId, query.tenantId],
  );
  const access = row.rows[0];
  if (!access) throw missing();
  return access;
}

function privileged(role: string) {
  return role === "owner" || role === "admin";
}

type AccessContext = Awaited<ReturnType<typeof loadPageAccessContext>>;

function visiblePage(ctx: AccessContext, actorId: string, pageId: string, includeTrash: boolean, canIncludeTrash: boolean) {
  const stored = ctx.pages.get(pageId);
  if (!stored) return false;
  if (!stored.deleted_at) return pageReadable(ctx, actorId, stored);
  if (!includeTrash || !canIncludeTrash) return false;
  return pageReadable(ctx, actorId, { ...stored, deleted_at: null });
}

function breadcrumb(ctx: AccessContext, actorId: string, pageId: string, spaceName: string) {
  const titles: string[] = [];
  const seen = new Set<string>();
  let current = ctx.pages.get(pageId)?.parent_id;
  while (current && !seen.has(current)) {
    seen.add(current);
    const parent = ctx.pages.get(current);
    if (!parent) break;
    if (!parent.deleted_at && pageReadable(ctx, actorId, parent)) titles.push(parent.title || "Untitled");
    current = parent.parent_id;
  }
  return [spaceName, ...titles.reverse()].filter(Boolean).join(" / ");
}

type CursorPayload = { sort: MentionSort; order: MentionOrder; spaceId: string | null; trash: boolean; pageId: string };

function encodeCursor(payload: CursorPayload) {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(cursor: string, query: BacklinkQuery): CursorPayload {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<CursorPayload>;
    if (!parsed || parsed.sort !== query.sort || parsed.order !== query.order || parsed.spaceId !== query.spaceId || parsed.trash !== query.includeTrash || typeof parsed.pageId !== "string" || !token.test(parsed.pageId)) throw cursorChanged();
    return { sort: parsed.sort, order: parsed.order, spaceId: parsed.spaceId ?? null, trash: parsed.trash === true, pageId: parsed.pageId };
  } catch (error) {
    if (error instanceof DocumentError) throw error;
    throw cursorChanged();
  }
}

function compareMentions(a: { title: string; pageId: string; editedAt: string }, b: { title: string; pageId: string; editedAt: string }, sort: MentionSort, order: MentionOrder) {
  const direction = order === "asc" ? 1 : -1;
  if (sort === "title") return direction * (a.title.localeCompare(b.title, "en", { sensitivity: "variant" }) || a.pageId.localeCompare(b.pageId));
  return direction * (a.editedAt.localeCompare(b.editedAt) || a.pageId.localeCompare(b.pageId));
}

async function mentionRows(tx: Sql, workspaceId: string, recordId: string) {
  return tx.query<StoredRef & { title: string; space_id: string; space_name: string; parent_id: string | null; updated_at: string | Date; deleted_at: string | Date | null }>(
    `SELECT b.page_id, b.block_id, b.ref_type, p.title, p.space_id, s.name AS space_name, p.parent_id, p.updated_at, p.deleted_at
     FROM hs_record_backlinks b
     JOIN hs_pages p ON p.id = b.page_id AND p.workspace_id = b.workspace_id
     JOIN hs_spaces s ON s.id = p.space_id AND s.workspace_id = p.workspace_id
     WHERE b.workspace_id = $1 AND b.record_id = $2`,
    [workspaceId, recordId],
  );
}

export async function readRecordBacklinks(r: Repository, actor: Actor, recordId: string, query: BacklinkQuery): Promise<MentionList | ViewMentionList | OpenMention> {
  return r.db.transaction(async tx => {
    const access = await requireRecord(tx, actor, recordId, query);
    const ctx = await loadPageAccessContext(tx, actor, access.workspace_id);
    const canIncludeTrash = privileged(access.role);
    const includeTrash = query.includeTrash && canIncludeTrash;
    if (query.section === "views") return viewMentions(tx, actor, access, ctx, recordId);
    if (query.openPageId) return openMention(tx, actor, access, ctx, recordId, query.openPageId, includeTrash, canIncludeTrash);
    const loaded = await mentionRows(tx, access.workspace_id, recordId);
    const grouped = new Map<string, { page: PageRow; refs: StoredRef[] }>();
    for (const row of loaded.rows) {
      const page = ctx.pages.get(row.page_id);
      if (!page || page.workspace_id !== access.workspace_id || !visiblePage(ctx, actor.id, page.id, includeTrash, canIncludeTrash)) continue;
      const current = grouped.get(row.page_id) ?? { page: { ...page, space_name: row.space_name, title: page.title, updated_at: page.updated_at, deleted_at: page.deleted_at ?? null }, refs: [] };
      current.refs.push({ page_id: row.page_id, block_id: row.block_id, ref_type: row.ref_type });
      grouped.set(row.page_id, current);
    }
    const prepared = [...grouped.values()].map(group => {
      const types = TYPE_ORDER.filter(type => group.refs.some(ref => ref.ref_type === type));
      const primary = [...group.refs].sort((a, b) => TYPE_ORDER.indexOf(a.ref_type) - TYPE_ORDER.indexOf(b.ref_type) || a.block_id.localeCompare(b.block_id))[0];
      const referenceType = primary?.ref_type ?? "link";
      return {
        pageId: group.page.id,
        title: group.page.title || "Untitled",
        spaceId: group.page.space_id,
        spaceName: group.page.space_name,
        editedAt: iso(group.page.updated_at),
        deleted: Boolean(group.page.deleted_at),
        referenceType,
        referenceTypes: types.length ? types : [referenceType],
        blockId: primary?.block_id ?? "",
      };
    });
    const spaces = [...new Map(prepared.map(item => [item.spaceId, { id: item.spaceId, name: item.spaceName }])).values()].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
    const filtered = query.spaceId ? prepared.filter(item => item.spaceId === query.spaceId) : prepared;
    filtered.sort((a, b) => compareMentions(a, b, query.sort, query.order));
    let start = 0;
    if (query.cursor) {
      const decoded = decodeCursor(query.cursor, { ...query, includeTrash });
      const index = filtered.findIndex(item => item.pageId === decoded.pageId);
      if (index < 0) throw cursorChanged();
      start = index + 1;
    }
    const pageSlice = filtered.slice(start, start + RECORD_BACKLINK_PAGE_SIZE);
    const blockRows = pageSlice.length
      ? await tx.query<{ page_id: string; id: string; parent_id: string | null; position: number; node: unknown }>("SELECT page_id, id, parent_id, position, node FROM hs_blocks WHERE page_id = ANY($1::text[])", [pageSlice.map(item => item.pageId)])
      : { rows: [] };
    const byPage = new Map<string, { id: string; parentId: string | null; position: number; node: RichNode }[]>();
    for (const row of blockRows.rows) {
      const node = asNode(row.node);
      if (!node) continue;
      const list = byPage.get(row.page_id) ?? [];
      list.push({ id: row.id, parentId: row.parent_id, position: row.position, node });
      byPage.set(row.page_id, list);
    }
    const items: MentionItem[] = pageSlice.map(item => ({
      pageId: item.pageId,
      title: item.title,
      spaceId: item.spaceId,
      spaceName: item.spaceName,
      breadcrumb: breadcrumb(ctx, actor.id, item.pageId, item.spaceName),
      referenceType: item.referenceType,
      referenceTypes: item.referenceTypes,
      referenceLabel: LABELS[item.referenceType],
      icon: ICONS[item.referenceType],
      snippet: clampSnippet(contextSnippet(byPage.get(item.pageId) ?? [], item.blockId)),
      editedAt: item.editedAt,
      editedAtIst: formatIst(item.editedAt),
      blockId: item.blockId,
      href: blockJumpHref(item.pageId, item.blockId),
      trashLabel: item.deleted ? "In trash" : null,
    }));
    const last = pageSlice.at(-1);
    const nextCursor = start + RECORD_BACKLINK_PAGE_SIZE < filtered.length && last ? encodeCursor({ sort: query.sort, order: query.order, spaceId: query.spaceId, trash: includeTrash, pageId: last.pageId }) : null;
    return { heading: mentionedHeading(filtered.length), count: filtered.length, items, nextCursor, spaces, canIncludeTrash, sort: query.sort, order: query.order, spaceId: query.spaceId };
  });
}

async function openMention(tx: Sql, actor: Actor, access: AccessRow, ctx: AccessContext, recordId: string, pageId: string, includeTrash: boolean, canIncludeTrash: boolean): Promise<OpenMention> {
  const page = ctx.pages.get(pageId);
  if (!page || page.workspace_id !== access.workspace_id || !visiblePage(ctx, actor.id, page.id, includeTrash, canIncludeTrash)) throw pageMissing();
  const link = await tx.query<{ block_id: string }>("SELECT block_id FROM hs_record_backlinks WHERE workspace_id=$1 AND record_id=$2 AND page_id=$3 ORDER BY block_id LIMIT 1", [access.workspace_id, recordId, pageId]);
  const blockId = link.rows[0]?.block_id;
  if (!blockId) throw pageMissing();
  return { href: blockJumpHref(pageId, blockId), pageId, blockId };
}

async function fieldsFor(tx: Sql, tenantId: string, collection: string): Promise<RecordField[]> {
  const rows = await tx.query<{ field_key: string; label: string; kind: RecordField["kind"]; required: boolean; choices: string[] | string; sensitive: boolean; unique_value: boolean; deprecated: boolean; version: number }>(
    "SELECT field_key, label, kind, required, choices, sensitive, unique_value, deprecated, version FROM hs_data_fields WHERE tenant_id=$1 AND collection=$2",
    [tenantId, collection],
  );
  const custom = rows.rows.map(row => ({
    key: row.field_key,
    label: row.label,
    kind: row.kind,
    required: row.required,
    choices: Array.isArray(row.choices) ? row.choices : [],
    sensitive: row.sensitive,
    unique: row.unique_value,
    deprecated: row.deprecated,
    core: false,
    version: Number(row.version),
  }));
  return [...standardRecordFields(collection), ...custom];
}

async function viewMentions(tx: Sql, actor: Actor, access: AccessRow, ctx: AccessContext, recordId: string): Promise<ViewMentionList> {
  const readable = [...ctx.pages.values()].filter(page => page.workspace_id === access.workspace_id && !page.deleted_at && pageReadable(ctx, actor.id, page)).map(page => page.id);
  if (!readable.length) return { section: "views", heading: "Appears in view blocks", items: [], limit: RECORD_VIEW_MENTION_LIMIT };
  const blocks = await tx.query<{ page_id: string; id: string; node: unknown }>(
    `SELECT b.page_id, b.id, b.node FROM hs_blocks b
     JOIN hs_pages p ON p.id = b.page_id
     WHERE b.type = 'recordView' AND b.page_id = ANY($1::text[])
     ORDER BY p.title, p.id, b.id
     LIMIT $2`,
    [readable, VIEW_SCAN_LIMIT],
  );
  const items: ViewMention[] = [];
  const seenPages = new Set<string>();
  for (const block of blocks.rows) {
    if (seenPages.size >= RECORD_VIEW_MENTION_LIMIT && !seenPages.has(block.page_id)) break;
    const node = asNode(block.node);
    const viewId = String(node?.attrs?.viewId ?? "");
    const collectionId = String(node?.attrs?.collectionId ?? "");
    if (!uuid.test(viewId)) continue;
    const view = await tx.query<{ collection: string; definition: unknown; name: string }>(
      `SELECT collection, definition, name FROM hs_data_views
       WHERE id=$1 AND tenant_id=$2 AND workspace_id=$3 AND deleted=false AND (scope='workspace' OR owner_id=$4)`,
      [viewId, access.tenant_id, access.workspace_id, actor.id],
    );
    const stored = view.rows[0];
    if (!stored || stored.collection !== collectionId) continue;
    const parsedDefinition = typeof stored.definition === "string" ? JSON.parse(stored.definition) as unknown : stored.definition;
    const parsed = recordViewDefinition.safeParse({ ...(parsedDefinition as object), includeArchived: false });
    if (!parsed.success) continue;
    let matched = false;
    try {
      const fields = await fieldsFor(tx, access.tenant_id, stored.collection);
      const compiled = compileRecordView(parsed.data, fields, [access.tenant_id, stored.collection, ["active"], false, actor.id]);
      const grant = await tx.query("SELECT 1 FROM hs_data_collection_grants WHERE tenant_id=$1 AND user_id=$2 AND collection=$3 AND 'view'=ANY(capabilities)", [access.tenant_id, actor.id, stored.collection]);
      compiled.values[3] = grant.rows.length > 0;
      const values = [...compiled.values, recordId];
      const where = `r.tenant_id=$1 AND r.collection=$2 AND r.merged_into_id IS NULL AND r.state=ANY($3::text[]) AND ($4::boolean OR r.id IN (SELECT g.record_id FROM hs_data_record_grants g WHERE g.tenant_id=$1 AND g.user_id=$5 AND 'view'=ANY(g.capabilities))) AND ${compiled.predicates.join(" AND ") || "true"} AND r.id=$${values.length}`;
      const hit = await tx.query(`SELECT 1 FROM hs_data_records r WHERE ${where} LIMIT 1`, values);
      matched = hit.rows.length > 0;
    } catch { matched = false; }
    if (!matched) continue;
    const page = ctx.pages.get(block.page_id);
    if (!page) continue;
    const space = await tx.query<{ name: string }>("SELECT name FROM hs_spaces WHERE id=$1 AND workspace_id=$2", [page.space_id, access.workspace_id]);
    if (!seenPages.has(page.id)) seenPages.add(page.id);
    items.push({ pageId: page.id, title: page.title || "Untitled", spaceName: space.rows[0]?.name ?? "", viewName: stored.name, blockId: block.id, href: blockJumpHref(page.id, block.id) });
  }
  return { section: "views", heading: "Appears in view blocks", items, limit: RECORD_VIEW_MENTION_LIMIT };
}
