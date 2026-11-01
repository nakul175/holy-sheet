import { createHash, randomUUID } from "node:crypto";
import type { Actor } from "./auth";
import type { Sql } from "./database";
import { DocumentError, mergeDocuments, schemaVersion, stableStringify, type RichNode } from "./document";
import { formatIst } from "./ist-label";
import type { Repository } from "./repository";
import { canEdit } from "./types";
import {
  SYNCED_CONFLICT_MESSAGE,
  SYNCED_EDIT_HINT,
  SYNCED_POLL_MS,
  SYNCED_RESTRICTED_LABEL,
  SYNCED_TRASH_LABEL,
  SYNCED_UNAVAILABLE_LABEL,
  deleteAllCopy,
  syncedEditedSurface,
  syncedPlacementLabel,
  type SyncedConflictDetails,
} from "./synced-block-copy";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type BlockRow = {
  id: string;
  workspace_id: string;
  source_page_id: string;
  content: RichNode;
  version: number;
  updated_by: string;
  updated_at: string;
  previous_content: RichNode | null;
  previous_version: number | null;
  deleted_at: string | null;
  purge_after: string | null;
  kind: string;
};
type PageMeta = { id: string; workspace_id: string; owner_id: string; title: string; deleted_at: string | null; schema_version: number };
export type SyncedPublicView =
  | { state: "restricted"; label: typeof SYNCED_RESTRICTED_LABEL; canUndo?: true }
  | { state: "unavailable"; label: typeof SYNCED_UNAVAILABLE_LABEL }
  | { state: "trash"; label: typeof SYNCED_TRASH_LABEL; canRestore: true }
  | {
      state: "live";
      label: string;
      blockId: string;
      syncedId: string;
      version: number;
      content: RichNode[];
      pages: { id: string; title: string }[];
      placementCount: number;
      canEdit: boolean;
      hint: string | null;
      updatedAtIst: string;
    };

const hidden = () => new DocumentError("Synced block is restricted or unavailable", "not_found", 404);
const readOnly = () => new DocumentError(SYNCED_EDIT_HINT, "synced_read_only", 403);
const conflictError = (details: SyncedConflictDetails) => new DocumentError(SYNCED_CONFLICT_MESSAGE, "synced_conflict", 409, details);

export function stripSyncedContent(document: RichNode): RichNode {
  function walk(node: RichNode): RichNode {
    if (node.type === "syncedBlock") {
      const attrs: Record<string, unknown> = {};
      if (typeof node.attrs?.id === "string") attrs.id = node.attrs.id;
      if (typeof node.attrs?.syncedId === "string" && node.attrs.syncedId) attrs.syncedId = node.attrs.syncedId;
      if (typeof node.attrs?.snippetId === "string" && node.attrs.snippetId) attrs.snippetId = node.attrs.snippetId;
      if (typeof node.attrs?.pinVersion === "number") attrs.pinVersion = node.attrs.pinVersion;
      return { type: "syncedBlock", attrs };
    }
    if (!node.content) return node;
    return { ...node, content: node.content.map(walk) };
  }
  return walk(document);
}

export function overlaySyncedContent(shell: RichNode, source: RichNode): RichNode {
  const byId = new Map<string, RichNode>();
  function collect(node: RichNode) {
    if (node.type === "syncedBlock" && typeof node.attrs?.id === "string") byId.set(node.attrs.id, node);
    node.content?.forEach(collect);
  }
  collect(source);
  function walk(node: RichNode): RichNode {
    if (node.type === "syncedBlock") return byId.get(String(node.attrs?.id ?? "")) ?? node;
    if (!node.content) return node;
    return { ...node, content: node.content.map(walk) };
  }
  return walk(shell);
}

export function collectSyncedIds(document: RichNode) {
  const ids: string[] = [];
  function walk(node: RichNode) {
    if (node.type === "syncedBlock" && typeof node.attrs?.syncedId === "string" && uuidPattern.test(node.attrs.syncedId)) ids.push(node.attrs.syncedId);
    node.content?.forEach(walk);
  }
  walk(document);
  return ids;
}

function contentDoc(content: RichNode[] | undefined): RichNode | null {
  return content?.length ? { type: "doc", content } : null;
}

async function storedDocument(tx: Sql, pageId: string): Promise<RichNode> {
  const { rows } = await tx.query<{ node: RichNode }>("SELECT node FROM hs_blocks WHERE page_id=$1 AND parent_id IS NULL ORDER BY position", [pageId]);
  return { type: "doc", content: rows.map(row => row.node) };
}

async function pageMeta(tx: Sql, pageId: string) {
  const { rows } = await tx.query<PageMeta>("SELECT id,workspace_id,owner_id,title,deleted_at,schema_version FROM hs_pages WHERE id=$1", [pageId]);
  return rows[0] ?? null;
}

async function loadBlock(tx: Sql, syncedId: string, lock = false) {
  const { rows } = await tx.query<BlockRow>(`SELECT id,workspace_id,source_page_id,content,version,updated_by,updated_at,previous_content,previous_version,deleted_at,purge_after,kind FROM hs_synced_blocks WHERE id=$1${lock ? " FOR UPDATE" : ""}`, [syncedId]);
  const row = rows[0];
  if (!row) return null;
  if (row.deleted_at && row.purge_after && new Date(row.purge_after).getTime() <= Date.now()) {
    await tx.query("UPDATE hs_synced_blocks SET content=$2::jsonb,previous_content=NULL WHERE id=$1 AND purge_after<=clock_timestamp()", [syncedId, JSON.stringify({ type: "doc", content: [] })]);
    row.content = { type: "doc", content: [] };
    row.previous_content = null;
  }
  return row;
}

async function audit(tx: Sql, actor: Actor, pageId: string | null, action: string, after: Record<string, unknown>, operationId: string) {
  await tx.query("INSERT INTO hs_audit(id,actor_id,action,page_id,after_value,correlation_id) VALUES($1,$2,$3,$4,$5,$6)", [randomUUID(), actor.id, action, pageId, JSON.stringify({ ...after, atIst: formatIst(new Date()) }), operationId]);
}

async function event(tx: Sql, row: { id: string; workspace_id: string }, originPageId: string, version: number, actor: Actor, kind: string) {
  await tx.query("INSERT INTO hs_synced_events(id,synced_id,workspace_id,origin_page_id,version,actor_id,kind) VALUES($1,$2,$3,$4,$5,$6,$7)", [randomUUID(), row.id, row.workspace_id, originPageId, version, actor.id, kind]);
}

async function sourceRights(r: Repository, tx: Sql, actor: Actor, row: BlockRow) {
  const source = await pageMeta(tx, row.source_page_id);
  const trashed = !!source?.deleted_at;
  let readable = false;
  let editable = false;
  if (source && !trashed && source.workspace_id === row.workspace_id) {
    try {
      const page = await r.access(tx, source.id, actor, false);
      if (page.workspace_id === row.workspace_id) {
        readable = true;
        editable = canEdit(page.role);
      }
    } catch (error) {
      if (!(error instanceof DocumentError) || error.status !== 404) throw error;
    }
  }
  const grant = await tx.query<{ role: string }>("SELECT role FROM hs_synced_grants WHERE synced_id=$1 AND subject=$2", [row.id, actor.id]);
  if (grant.rows[0]?.role === "editor") {
    readable = true;
    editable = true;
  } else if (grant.rows[0]?.role === "viewer") readable = true;
  const member = source
    ? await tx.query<{ role: string }>("SELECT role FROM hs_members WHERE workspace_id=$1 AND user_id=$2 AND active=true", [source.workspace_id, actor.id])
    : { rows: [] as { role: string }[] };
  const canRestore = !!source && trashed && !!member.rows.length && (source.owner_id === actor.id || member.rows[0].role === "owner" || member.rows[0].role === "admin");
  return { source, trashed, readable, editable, canRestore };
}

async function placementPages(tx: Sql, syncedId: string) {
  return (await tx.query<{ page_id: string; title: string }>("SELECT pl.page_id,p.title FROM hs_synced_placements pl JOIN hs_pages p ON p.id=pl.page_id WHERE pl.synced_id=$1 ORDER BY p.title,pl.page_id", [syncedId])).rows;
}

async function readablePlacements(r: Repository, tx: Sql, actor: Actor, syncedId: string) {
  const rows = await placementPages(tx, syncedId);
  const pages: { id: string; title: string }[] = [];
  let hiddenCount = 0;
  for (const row of rows) {
    try {
      await r.access(tx, row.page_id, actor, false);
      pages.push({ id: row.page_id, title: row.title });
    } catch (error) {
      if (!(error instanceof DocumentError) || error.status !== 404) throw error;
      hiddenCount += 1;
    }
  }
  return { pages, hiddenCount, placementCount: rows.length };
}

function restricted(canUndo = false): SyncedPublicView {
  return canUndo ? { state: "restricted", label: SYNCED_RESTRICTED_LABEL, canUndo: true } : { state: "restricted", label: SYNCED_RESTRICTED_LABEL };
}

export async function describeSyncedBlock(r: Repository, tx: Sql, actor: Actor, pageId: string, blockId: string, syncedId: string | null): Promise<SyncedPublicView> {
  await r.access(tx, pageId, actor, false);
  if (!syncedId || !uuidPattern.test(syncedId)) return restricted();
  const row = await loadBlock(tx, syncedId);
  const page = await pageMeta(tx, pageId);
  if (!row || !page || row.workspace_id !== page.workspace_id || row.kind !== "sync") return restricted();
  const rights = await sourceRights(r, tx, actor, row);
  if (row.deleted_at) return restricted(rights.editable);
  if (rights.trashed) return rights.canRestore ? { state: "trash", label: SYNCED_TRASH_LABEL, canRestore: true } : { state: "unavailable", label: SYNCED_UNAVAILABLE_LABEL };
  if (!rights.readable) return restricted();
  const listed = await readablePlacements(r, tx, actor, row.id);
  return {
    state: "live",
    label: syncedPlacementLabel(listed.placementCount),
    blockId,
    syncedId: row.id,
    version: row.version,
    content: row.content.content ?? [],
    pages: listed.pages,
    placementCount: listed.placementCount,
    canEdit: rights.editable,
    hint: rights.editable ? null : SYNCED_EDIT_HINT,
    updatedAtIst: formatIst(row.updated_at),
  };
}

export async function presentSyncedDocument(r: Repository, tx: Sql, actor: Actor, pageId: string, document: RichNode): Promise<RichNode> {
  async function walk(node: RichNode): Promise<RichNode> {
    if (node.type !== "syncedBlock") {
      if (!node.content) return node;
      const content: RichNode[] = [];
      for (const child of node.content) content.push(await walk(child));
      return { ...node, content };
    }
    const blockId = String(node.attrs?.id ?? "");
    if (typeof node.attrs?.snippetId === "string" && node.attrs.snippetId) return node;
    const syncedId = typeof node.attrs?.syncedId === "string" ? node.attrs.syncedId : null;
    if (!syncedId) return node;
    const view = await describeSyncedBlock(r, tx, actor, pageId, blockId, syncedId);
    if (view.state === "live") {
      return { type: "syncedBlock", attrs: { id: blockId, syncedId: view.syncedId, syncVersion: view.version, syncState: "live", syncLocked: !view.canEdit }, content: view.content };
    }
    const attrs: Record<string, unknown> = { id: blockId, syncState: view.state === "trash" ? "trash" : view.state === "unavailable" ? "unavailable" : "restricted" };
    if (view.state === "restricted" && view.canUndo) attrs.syncUndo = true;
    return { type: "syncedBlock", attrs };
  }
  return walk(document);
}

export async function prelockSyncedPages(tx: Sql, document: RichNode) {
  const ids = [...new Set(collectSyncedIds(document))].sort();
  if (!ids.length) return;
  if (ids.length > 100) throw new DocumentError("Too many synced blocks on this page");
  await tx.query("SELECT id FROM hs_synced_blocks WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE", [ids]);
  const placements = await tx.query<{ page_id: string }>("SELECT page_id FROM hs_synced_placements WHERE synced_id = ANY($1::text[]) ORDER BY page_id FOR UPDATE", [ids]);
  const pageIds = [...new Set(placements.rows.map(row => row.page_id))].sort();
  if (pageIds.length) await tx.query("SELECT id FROM hs_pages WHERE id = ANY($1::text[]) ORDER BY id FOR UPDATE", [pageIds]);
}

async function remember(tx: Sql, syncedId: string, actor: Actor, operationId: string, hash: string, result: unknown) {
  const prior = await tx.query<{ actor_id: string; request_hash: string; result: unknown }>("SELECT actor_id,request_hash,result FROM hs_synced_operations WHERE synced_id=$1 AND operation_id=$2", [syncedId, operationId]);
  if (prior.rows[0]) {
    if (prior.rows[0].actor_id !== actor.id || prior.rows[0].request_hash !== hash) throw new DocumentError("Operation ID was reused with a different synced block change", "operation_mismatch", 409);
    return prior.rows[0].result;
  }
  await tx.query("INSERT INTO hs_synced_operations(synced_id,operation_id,actor_id,request_hash,result) VALUES($1,$2,$3,$4,$5)", [syncedId, operationId, actor.id, hash, JSON.stringify(result)]);
  return null;
}

async function writeVersion(tx: Sql, row: BlockRow, incoming: RichNode, actor: Actor, expected: number | null) {
  const same = stableStringify(incoming) === stableStringify(row.content);
  if (same) return { version: row.version, changed: false, content: row.content };
  let next = incoming;
  if (expected !== row.version) {
    if (expected != null && expected === row.previous_version && row.previous_content) {
      const merged = mergeDocuments(row.previous_content, row.content, incoming);
      if (!merged) throw conflictError({ server: { version: row.version, content: row.content }, client: { version: expected, content: incoming } });
      next = merged;
    } else {
      throw conflictError({ server: { version: row.version, content: row.content }, client: { version: expected ?? row.version, content: incoming } });
    }
  }
  const updated = await tx.query<{ version: number }>("UPDATE hs_synced_blocks SET previous_content=content,previous_version=version,content=$2::jsonb,version=version+1,updated_by=$3,updated_at=clock_timestamp() WHERE id=$1 AND version=$4 RETURNING version", [row.id, JSON.stringify(next), actor.id, row.version]);
  if (!updated.rows[0]) throw conflictError({ server: { version: row.version, content: row.content }, client: { version: expected ?? row.version, content: incoming } });
  return { version: updated.rows[0].version, changed: true, content: next };
}

async function recordEdited(r: Repository, tx: Sql, actor: Actor, row: BlockRow, originPageId: string, originTitle: string, version: number, operationId: string) {
  const surface = syncedEditedSurface(originTitle);
  const peers = await placementPages(tx, row.id);
  for (const peer of peers) {
    if (peer.page_id === originPageId) continue;
    const meta = await pageMeta(tx, peer.page_id);
    if (!meta || meta.schema_version !== schemaVersion) continue;
    const versionNext = (await tx.query<{ version: number }>("SELECT version FROM hs_pages WHERE id=$1", [peer.page_id])).rows[0]?.version;
    if (!versionNext) continue;
    const document = await storedDocument(tx, peer.page_id);
    const nextVersion = versionNext + 1;
    await r.writeDocument(tx, peer.page_id, document, nextVersion, meta.title, actor.id, surface);
    await tx.query("UPDATE hs_pages SET version=$2,updated_at=clock_timestamp() WHERE id=$1", [peer.page_id, nextVersion]);
  }
  await event(tx, row, originPageId, version, actor, "edited");
  await audit(tx, actor, originPageId, "synced-block.edit", { syncedId: row.id, version, originPageId, placementPageIds: peers.map(peer => peer.page_id) }, operationId);
  return surface;
}

export async function commitSyncedPlacements(r: Repository, tx: Sql, actor: Actor, pageId: string, next: RichNode, operationId: string) {
  const origin = await pageMeta(tx, pageId);
  if (!origin) throw hidden();
  const previous = await storedDocument(tx, pageId);
  const previousIds = new Set<string>();
  function rememberPrevious(node: RichNode) {
    if (node.type === "syncedBlock" && typeof node.attrs?.id === "string") previousIds.add(node.attrs.id);
    node.content?.forEach(rememberPrevious);
  }
  rememberPrevious(previous);
  const kept = new Set<string>();
  let contentChanged = false;
  let surface: string | null = null;
  async function walk(node: RichNode): Promise<RichNode> {
    if (node.type !== "syncedBlock") {
      if (!node.content) return node;
      const content: RichNode[] = [];
      for (const child of node.content) content.push(await walk(child));
      return { ...node, content };
    }
    const blockId = String(node.attrs?.id ?? "");
    if (!blockId) throw new DocumentError("Synced block is missing its placement id");
    if (typeof node.attrs?.snippetId === "string" && node.attrs.snippetId) {
      const attrs: Record<string, unknown> = { id: blockId, snippetId: node.attrs.snippetId };
      if (typeof node.attrs.pinVersion === "number") attrs.pinVersion = node.attrs.pinVersion;
      return { type: "syncedBlock", attrs };
    }
    kept.add(blockId);
    let syncedId = typeof node.attrs?.syncedId === "string" ? node.attrs.syncedId : "";
    const incoming = contentDoc(node.content);
    const expected = typeof node.attrs?.syncVersion === "number" ? node.attrs.syncVersion : null;
    if (!syncedId) {
      if (!incoming) throw new DocumentError("Select at least one block to sync");
      syncedId = randomUUID();
      await tx.query("INSERT INTO hs_synced_blocks(id,workspace_id,source_page_id,content,version,updated_by,kind) VALUES($1,$2,$3,$4::jsonb,1,$5,'sync')", [syncedId, origin.workspace_id, pageId, JSON.stringify(incoming), actor.id]);
      await tx.query("INSERT INTO hs_synced_placements(page_id,block_id,synced_id) VALUES($1,$2,$3)", [pageId, blockId, syncedId]);
      await event(tx, { id: syncedId, workspace_id: origin.workspace_id }, pageId, 1, actor, "created");
      await audit(tx, actor, pageId, "synced-block.create", { syncedId, originPageId: pageId, blockId, version: 1 }, operationId);
    } else {
      if (!uuidPattern.test(syncedId)) throw hidden();
      const row = await loadBlock(tx, syncedId, true);
      const existing = previousIds.has(blockId);
      if (!row || row.workspace_id !== origin.workspace_id || row.kind !== "sync") throw hidden();
      if (!existing) {
        if (row.deleted_at) throw hidden();
        const rights = await sourceRights(r, tx, actor, row);
        if (!rights.readable || rights.trashed) throw hidden();
        await tx.query("INSERT INTO hs_synced_placements(page_id,block_id,synced_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [pageId, blockId, syncedId]);
        await audit(tx, actor, pageId, "synced-block.place", { syncedId, blockId, originPageId: pageId }, operationId);
      }
      if (incoming && stableStringify(incoming) !== stableStringify(row.content)) {
        if (row.deleted_at) throw hidden();
        const rights = await sourceRights(r, tx, actor, row);
        if (rights.trashed) throw new DocumentError(SYNCED_UNAVAILABLE_LABEL, "synced_unavailable", 409);
        if (!rights.editable) throw readOnly();
        const written = await writeVersion(tx, row, incoming, actor, expected);
        if (written.changed) {
          contentChanged = true;
          surface = await recordEdited(r, tx, actor, row, pageId, origin.title, written.version, operationId);
        }
      }
    }
    return { type: "syncedBlock", attrs: { id: blockId, syncedId } };
  }
  const content: RichNode[] = [];
  for (const child of next.content ?? []) content.push(await walk(child));
  const removed = await tx.query<{ block_id: string; synced_id: string }>("SELECT block_id,synced_id FROM hs_synced_placements WHERE page_id=$1", [pageId]);
  for (const placement of removed.rows) {
    if (kept.has(placement.block_id)) continue;
    await tx.query("DELETE FROM hs_synced_placements WHERE page_id=$1 AND block_id=$2", [pageId, placement.block_id]);
    await audit(tx, actor, pageId, "synced-block.delete-placement", { syncedId: placement.synced_id, blockId: placement.block_id }, operationId);
  }
  return { stored: { type: "doc", content } as RichNode, contentChanged, surface };
}

async function placed(tx: Sql, pageId: string, blockId: string) {
  const { rows } = await tx.query<{ synced_id: string }>("SELECT synced_id FROM hs_synced_placements WHERE page_id=$1 AND block_id=$2", [pageId, blockId]);
  return rows[0]?.synced_id ?? null;
}

function hashCommand(value: unknown) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

async function replacePageDocument(r: Repository, tx: Sql, actor: Actor, pageId: string, document: RichNode, surface: string) {
  const page = await r.access(tx, pageId, actor, true, true);
  if (page.schema_version !== schemaVersion) throw new DocumentError("This document requires a newer editor", "schema_version", 409);
  const version = page.version + 1;
  await r.writeDocument(tx, pageId, document, version, page.title, actor.id, surface);
  await tx.query("UPDATE hs_pages SET version=$2,updated_at=clock_timestamp() WHERE id=$1", [pageId, version]);
  return version;
}

export async function listSyncedViews(r: Repository, actor: Actor, pageId: string) {
  return r.db.transaction(async tx => {
    await r.access(tx, pageId, actor, false);
    const document = await storedDocument(tx, pageId);
    const blocks: SyncedPublicView[] = [];
    async function walk(node: RichNode) {
      if (node.type === "syncedBlock") {
        blocks.push(await describeSyncedBlock(r, tx, actor, pageId, String(node.attrs?.id ?? ""), typeof node.attrs?.syncedId === "string" ? node.attrs.syncedId : null));
        return;
      }
      for (const child of node.content ?? []) await walk(child);
    }
    await walk(document);
    return { blocks, pollMs: SYNCED_POLL_MS };
  });
}

export async function unsyncPlacement(r: Repository, actor: Actor, pageId: string, input: { operationId: string; blockId: string }) {
  const hash = hashCommand({ action: "unsync", ...input, pageId });
  return r.db.transaction(async tx => {
    await r.access(tx, pageId, actor, true, true);
    const syncedId = await placed(tx, pageId, input.blockId);
    if (!syncedId) throw hidden();
    const replay = await remember(tx, syncedId, actor, input.operationId, hash, null);
    if (replay) return replay;
    const row = await loadBlock(tx, syncedId, true);
    const page = await pageMeta(tx, pageId);
    if (!row || !page || row.workspace_id !== page.workspace_id) throw hidden();
    const rights = await sourceRights(r, tx, actor, row);
    if (!rights.readable || row.deleted_at || rights.trashed) throw hidden();
    const sourceContent = row.content;
    const document = await storedDocument(tx, pageId);
    let replaced = false;
    function walk(node: RichNode): RichNode[] {
      if (node.type === "syncedBlock" && node.attrs?.id === input.blockId) {
        replaced = true;
        const copy = structuredClone(sourceContent);
        return (copy.content ?? []).map(child => freshIds(child));
      }
      if (!node.content) return [node];
      return [{ ...node, content: node.content.flatMap(walk) }];
    }
    function freshIds(node: RichNode): RichNode {
      const attrs = { ...node.attrs };
      if (attrs.id) attrs.id = randomUUID();
      return { ...node, ...(Object.keys(attrs).length ? { attrs } : {}), ...(node.content ? { content: node.content.map(freshIds) } : {}) };
    }
    const content = (document.content ?? []).flatMap(walk);
    if (!replaced) throw hidden();
    const countBefore = (await placementPages(tx, syncedId)).length;
    await tx.query("DELETE FROM hs_synced_placements WHERE page_id=$1 AND block_id=$2", [pageId, input.blockId]);
    await replacePageDocument(r, tx, actor, pageId, { type: "doc", content: content.length ? content : [{ type: "paragraph", attrs: { id: randomUUID() } }] }, "unsynced-block");
    const countAfter = (await placementPages(tx, syncedId)).length;
    const result = { unsynced: true, placementCount: countAfter, removedFrom: pageId, previousCount: countBefore };
    await tx.query("UPDATE hs_synced_operations SET result=$3::jsonb WHERE synced_id=$1 AND operation_id=$2", [syncedId, input.operationId, JSON.stringify(result)]);
    await event(tx, row, pageId, row.version, actor, "unsynced");
    await audit(tx, actor, pageId, "synced-block.unsync", { syncedId, blockId: input.blockId, placementCount: countAfter }, input.operationId);
    return result;
  });
}

export async function deleteSyncedPlacement(r: Repository, actor: Actor, pageId: string, input: { operationId: string; blockId: string }) {
  const hash = hashCommand({ action: "delete-placement", ...input, pageId });
  return r.db.transaction(async tx => {
    await r.access(tx, pageId, actor, true, true);
    const syncedId = await placed(tx, pageId, input.blockId);
    if (!syncedId) throw hidden();
    const replay = await remember(tx, syncedId, actor, input.operationId, hash, null);
    if (replay) return replay;
    const document = await storedDocument(tx, pageId);
    function without(nodes: RichNode[]): RichNode[] {
      return nodes.flatMap(node => {
        if (node.type === "syncedBlock" && node.attrs?.id === input.blockId) return [];
        if (!node.content) return [node];
        return [{ ...node, content: without(node.content) }];
      });
    }
    const content = without(document.content ?? []);
    await tx.query("DELETE FROM hs_synced_placements WHERE page_id=$1 AND block_id=$2", [pageId, input.blockId]);
    await replacePageDocument(r, tx, actor, pageId, { type: "doc", content: content.length ? content : [{ type: "paragraph", attrs: { id: randomUUID() } }] }, "synced-placement-deleted");
    const placementCount = (await placementPages(tx, syncedId)).length;
    const result = { deleted: "placement", syncedId, placementCount };
    await tx.query("UPDATE hs_synced_operations SET result=$3::jsonb WHERE synced_id=$1 AND operation_id=$2", [syncedId, input.operationId, JSON.stringify(result)]);
    await audit(tx, actor, pageId, "synced-block.delete-placement", { syncedId, blockId: input.blockId, placementCount }, input.operationId);
    return result;
  });
}

export async function previewDeleteAll(r: Repository, actor: Actor, pageId: string, blockId: string) {
  return r.db.transaction(async tx => {
    await r.access(tx, pageId, actor, false);
    const syncedId = await placed(tx, pageId, blockId);
    if (!syncedId) throw hidden();
    const row = await loadBlock(tx, syncedId);
    if (!row) throw hidden();
    const rights = await sourceRights(r, tx, actor, row);
    if (!rights.editable || row.deleted_at) throw hidden();
    const listed = await readablePlacements(r, tx, actor, syncedId);
    const titles = listed.pages.map(page => page.title).sort();
    return { syncedId, titles, hiddenCount: listed.hiddenCount, placementCount: listed.placementCount, confirm: deleteAllCopy(titles, listed.hiddenCount) };
  });
}

export async function deleteAllSyncedCopies(r: Repository, actor: Actor, pageId: string, input: { operationId: string; blockId: string; confirm: true; titles: string[]; hiddenCount: number }) {
  const hash = hashCommand({ action: "delete-all", pageId, blockId: input.blockId, titles: [...input.titles].sort(), hiddenCount: input.hiddenCount });
  return r.db.transaction(async tx => {
    await r.access(tx, pageId, actor, false);
    const syncedId = await placed(tx, pageId, input.blockId);
    if (!syncedId) throw hidden();
    const replay = await remember(tx, syncedId, actor, input.operationId, hash, null);
    if (replay) return replay;
    const row = await loadBlock(tx, syncedId, true);
    if (!row) throw hidden();
    const rights = await sourceRights(r, tx, actor, row);
    if (!rights.editable) throw hidden();
    const listed = await readablePlacements(r, tx, actor, syncedId);
    const titles = listed.pages.map(page => page.title).sort();
    const expected = [...input.titles].sort();
    if (listed.hiddenCount !== input.hiddenCount || stableStringify(titles) !== stableStringify(expected)) throw new DocumentError("The page list changed. Review the confirmation again.", "synced_confirm_stale", 409);
    await tx.query("UPDATE hs_synced_blocks SET deleted_at=clock_timestamp(),deleted_by=$2,purge_after=clock_timestamp()+interval '30 days',updated_by=$2,updated_at=clock_timestamp() WHERE id=$1", [syncedId, actor.id]);
    const result = { deleted: "all", syncedId, undoDays: 30, placementCount: listed.placementCount };
    await tx.query("UPDATE hs_synced_operations SET result=$3::jsonb WHERE synced_id=$1 AND operation_id=$2", [syncedId, input.operationId, JSON.stringify(result)]);
    await event(tx, row, pageId, row.version, actor, "deleted");
    await audit(tx, actor, pageId, "synced-block.delete-all", { syncedId, placementPageIds: (await placementPages(tx, syncedId)).map(page => page.page_id), hiddenCount: listed.hiddenCount, undoDays: 30 }, input.operationId);
    return result;
  });
}

export async function undoDeleteAll(r: Repository, actor: Actor, pageId: string, input: { operationId: string; blockId: string }) {
  const hash = hashCommand({ action: "undo-delete", ...input, pageId });
  return r.db.transaction(async tx => {
    await r.access(tx, pageId, actor, false);
    const syncedId = await placed(tx, pageId, input.blockId);
    if (!syncedId) throw hidden();
    const replay = await remember(tx, syncedId, actor, input.operationId, hash, null);
    if (replay) return replay;
    const row = await loadBlock(tx, syncedId, true);
    if (!row || !row.deleted_at) throw hidden();
    const rights = await sourceRights(r, tx, actor, row);
    if (!rights.editable) throw hidden();
    if (row.purge_after && new Date(row.purge_after).getTime() <= Date.now()) throw new DocumentError("The 30-day undo window has ended", "synced_undo_expired", 409);
    await tx.query("UPDATE hs_synced_blocks SET deleted_at=NULL,deleted_by=NULL,purge_after=NULL,updated_by=$2,updated_at=clock_timestamp() WHERE id=$1", [syncedId, actor.id]);
    const result = { restored: true, syncedId };
    await tx.query("UPDATE hs_synced_operations SET result=$3::jsonb WHERE synced_id=$1 AND operation_id=$2", [syncedId, input.operationId, JSON.stringify(result)]);
    await event(tx, row, pageId, row.version, actor, "restored");
    await audit(tx, actor, pageId, "synced-block.undo-delete", { syncedId }, input.operationId);
    return result;
  });
}

export async function restoreSyncedSource(r: Repository, actor: Actor, pageId: string, input: { operationId: string; blockId: string }) {
  const hash = hashCommand({ action: "restore-source", ...input, pageId });
  return r.db.transaction(async tx => {
    await r.access(tx, pageId, actor, false);
    const syncedId = await placed(tx, pageId, input.blockId);
    if (!syncedId) throw hidden();
    const replay = await remember(tx, syncedId, actor, input.operationId, hash, null);
    if (replay) return replay;
    const row = await loadBlock(tx, syncedId, true);
    if (!row) throw hidden();
    const rights = await sourceRights(r, tx, actor, row);
    if (!rights.canRestore || !rights.source) throw hidden();
    await tx.query("UPDATE hs_pages SET deleted_at=NULL,deletion_batch_id=NULL,acl_version=acl_version+1 WHERE id=$1", [rights.source.id]);
    const result = { restoredSource: true, syncedId, sourcePageId: rights.source.id };
    await tx.query("UPDATE hs_synced_operations SET result=$3::jsonb WHERE synced_id=$1 AND operation_id=$2", [syncedId, input.operationId, JSON.stringify(result)]);
    await event(tx, row, pageId, row.version, actor, "source-restored");
    await audit(tx, actor, rights.source.id, "synced-block.restore-source", { syncedId, sourcePageId: rights.source.id }, input.operationId);
    return result;
  });
}

export async function grantSyncedAccess(r: Repository, actor: Actor, pageId: string, input: { operationId: string; blockId: string; subject: string; role: "viewer" | "editor" }) {
  const hash = hashCommand({ action: "grant", ...input, pageId });
  return r.db.transaction(async tx => {
    await r.access(tx, pageId, actor, false);
    const syncedId = await placed(tx, pageId, input.blockId);
    if (!syncedId) throw hidden();
    const replay = await remember(tx, syncedId, actor, input.operationId, hash, null);
    if (replay) return replay;
    const row = await loadBlock(tx, syncedId, true);
    if (!row || row.deleted_at) throw hidden();
    const rights = await sourceRights(r, tx, actor, row);
    if (!rights.editable) throw hidden();
    const member = await tx.query("SELECT user_id FROM hs_members WHERE workspace_id=$1 AND user_id=$2 AND active=true", [row.workspace_id, input.subject]);
    if (!member.rows.length) throw hidden();
    await tx.query("INSERT INTO hs_synced_grants(synced_id,subject,role) VALUES($1,$2,$3) ON CONFLICT(synced_id,subject) DO UPDATE SET role=EXCLUDED.role", [syncedId, input.subject, input.role]);
    const result = { granted: true, syncedId, role: input.role };
    await tx.query("UPDATE hs_synced_operations SET result=$3::jsonb WHERE synced_id=$1 AND operation_id=$2", [syncedId, input.operationId, JSON.stringify(result)]);
    await audit(tx, actor, pageId, "synced-block.grant", { syncedId, subject: input.subject, role: input.role }, input.operationId);
    return result;
  });
}

export async function resolveSyncedProbe(r: Repository, actor: Actor, pageId: string, syncedId: string) {
  return r.db.transaction(async tx => {
    await r.access(tx, pageId, actor, false);
    const page = await pageMeta(tx, pageId);
    const row = uuidPattern.test(syncedId) ? await loadBlock(tx, syncedId) : null;
    if (!row || !page || row.workspace_id !== page.workspace_id || row.kind !== "sync" || row.deleted_at) return restricted();
    const rights = await sourceRights(r, tx, actor, row);
    if (rights.trashed) return rights.canRestore ? { state: "trash" as const, label: SYNCED_TRASH_LABEL, canRestore: true as const } : { state: "unavailable" as const, label: SYNCED_UNAVAILABLE_LABEL };
    if (!rights.readable) return restricted();
    const listed = await readablePlacements(r, tx, actor, row.id);
    return { state: "live" as const, label: syncedPlacementLabel(listed.placementCount), version: row.version, placementCount: listed.placementCount, pages: listed.pages, canEdit: rights.editable, hint: rights.editable ? null : SYNCED_EDIT_HINT, updatedAtIst: formatIst(row.updated_at) };
  });
}
