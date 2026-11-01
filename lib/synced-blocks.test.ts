import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createDatabase, type Database } from "./database";
import { ensureIds, type RichNode } from "./document";
import { listHistory } from "./history";
import { localActor } from "./auth";
import { Repository } from "./repository";
import { SYNCED_POLL_MS, deleteAllCopy, syncedEditedSurface } from "./synced-block-copy";
import { deleteAllSyncedCopies, deleteSyncedPlacement, grantSyncedAccess, previewDeleteAll, resolveSyncedProbe, restoreSyncedSource, undoDeleteAll, unsyncPlacement } from "./synced-blocks";

let db: Database;
let r: Repository;
const owner = localActor;
const editor = { id: "sync-editor" };
const viewer = { id: "sync-viewer" };
const reader = { id: "sync-reader" };
const outsider = { id: "sync-outsider" };
const other = { id: "sync-other" };
const secret = "SECRET_SYNC_BODY";
const hiddenTitle = "HIDDEN_PAGE_TITLE";

beforeAll(async () => {
  db = await createDatabase(":memory:");
  r = new Repository(db);
  await r.seedLocal();
  for (const actor of [editor, viewer, reader, outsider, other]) await db.query("INSERT INTO hs_users(id,name) VALUES($1,$1)", [actor.id]);
  for (const actor of [editor, viewer, reader, outsider]) await db.query("INSERT INTO hs_members(workspace_id,user_id) VALUES('ws-aplyd',$1)", [actor.id]);
  await db.query("INSERT INTO hs_workspaces(id,name) VALUES('ws-b','Other workspace')");
  await db.query("INSERT INTO hs_spaces(id,workspace_id,name) VALUES('space-b','ws-b','Other space')");
  await db.query("INSERT INTO hs_members(workspace_id,user_id) VALUES('ws-b',$1)", [other.id]);
});
afterAll(async () => { await db.close(); });

function paragraphs(texts: string[], syncedId?: string, version?: number, blockId = crypto.randomUUID()): RichNode {
  return ensureIds({
    type: "doc",
    content: [{
      type: "syncedBlock",
      attrs: { id: blockId, syncState: "live", ...(syncedId ? { syncedId, syncVersion: version } : {}) },
      content: texts.map(text => ({ type: "paragraph", content: text ? [{ type: "text", text }] : [] })),
    }],
  });
}
function blockId(document: RichNode) {
  return String(document.content!.find(node => node.type === "syncedBlock")!.attrs!.id);
}
function syncedText(document: RichNode) {
  return JSON.stringify(document.content!.find(node => node.type === "syncedBlock") ?? {});
}
async function save(actor: { id: string }, pageId: string, document: RichNode) {
  const page = await r.get(pageId, actor);
  return r.save(pageId, actor, { operationId: crypto.randomUUID(), baseVersion: page.version, title: page.title, document });
}
async function page(title: string, actor = owner) {
  return r.create(actor, title, actor.id === other.id ? "space-b" : "space-product");
}
async function grant(pageId: string, actor: { id: string }, role: "viewer" | "editor") {
  await db.query("INSERT INTO hs_grants(page_id,subject,role) VALUES($1,$2,$3)", [pageId, actor.id, role]);
}

it("replays the synced block migration", async () => {
  const sql = await readFile("db/100_synced_blocks.sql", "utf8");
  expect(sql).toContain("CREATE TABLE IF NOT EXISTS hs_synced_blocks");
  expect(sql).toContain("CREATE TABLE IF NOT EXISTS hs_synced_placements");
  const parts: string[] = [];
  let current = "";
  let dollar = false;
  for (const line of sql.split("\n")) {
    current += `${line}\n`;
    if ((line.split("$$").length - 1) % 2 === 1) dollar = !dollar;
    if (!dollar && line.trim().endsWith(";")) {
      if (current.replace(/^\s*--.*$/gm, "").trim()) parts.push(current.trim());
      current = "";
    }
  }
  for (const statement of parts) await db.query(statement);
  for (const statement of parts) await db.query(statement);
  const columns = await db.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_name='hs_synced_blocks' ORDER BY column_name");
  expect(columns.rows.map(row => row.column_name)).toEqual(expect.arrayContaining(["id", "workspace_id", "source_page_id", "content", "version", "updated_by"]));
});

it("propagates an edit within the poll window and records both histories without logging the body", async () => {
  expect(SYNCED_POLL_MS).toBeLessThanOrEqual(5000);
  const source = await page("P-100");
  const otherPage = await page("P-101");
  await grant(source.id, editor, "editor");
  await grant(otherPage.id, editor, "editor");
  const created = await save(owner, source.id, paragraphs([secret, "Second", "Third"]));
  const syncedId = String(created.page.document.content![0].attrs!.syncedId);
  const placed = await save(editor, otherPage.id, ensureIds({ type: "doc", content: [{ type: "paragraph" }, { type: "syncedBlock", attrs: { id: crypto.randomUUID(), syncedId } }] }));
  const current = await r.get(otherPage.id, editor);
  const edited = structuredClone(current.document);
  edited.content![1].content![0].content = [{ type: "text", text: `${secret} updated` }];
  const result = await save(editor, otherPage.id, edited);
  expect(syncedText(result.page.document)).toContain(`${secret} updated`);
  expect(syncedText((await r.get(source.id, owner)).document)).toContain(`${secret} updated`);
  expect(await resolveSyncedProbe(r, editor, otherPage.id, syncedId)).toMatchObject({ state: "live", label: "Synced to 2 pages", placementCount: 2, pages: [expect.objectContaining({ title: "P-100" }), expect.objectContaining({ title: "P-101" })] });
  const phrase = syncedEditedSurface("P-101");
  expect((await listHistory(r, owner, source.id)).versions.some(version => version.sourceSurface === phrase)).toBe(true);
  expect((await listHistory(r, editor, otherPage.id)).versions.some(version => version.sourceSurface === phrase)).toBe(true);
  const audit = JSON.stringify((await db.query("SELECT action,after_value FROM hs_audit WHERE action LIKE 'synced-block.%'")).rows);
  expect(audit).toContain("atIst");
  expect(audit).not.toContain(secret);
  const stored = JSON.stringify((await db.query("SELECT node FROM hs_blocks WHERE page_id=$1 OR page_id=$2", [source.id, otherPage.id])).rows);
  expect(stored).not.toContain(secret);
  const search = JSON.stringify((await db.query("SELECT body FROM hs_workspace_search WHERE page_id=$1 OR page_id=$2", [source.id, otherPage.id])).rows);
  expect(search).not.toContain(secret);
  expect(placed.page.document.content!.some(node => node.type === "syncedBlock")).toBe(true);
});

it("merges disjoint synced edits and refuses a silent same-block overwrite", async () => {
  const source = await page("Conflict source");
  const created = await save(owner, source.id, paragraphs(["Alpha", "Beta"]));
  const base = await r.get(source.id, owner);
  const left = structuredClone(base.document);
  const right = structuredClone(base.document);
  left.content![0].content![0].content = [{ type: "text", text: "Alpha left" }];
  right.content![0].content![1].content = [{ type: "text", text: "Beta right" }];
  await save(owner, source.id, left);
  const merged = await save(owner, source.id, right);
  expect(syncedText(merged.page.document)).toContain("Alpha left");
  expect(syncedText(merged.page.document)).toContain("Beta right");
  const again = await r.get(source.id, owner);
  const first = structuredClone(again.document);
  const second = structuredClone(again.document);
  first.content![0].content![0].content = [{ type: "text", text: "Server wins" }];
  second.content![0].content![0].content = [{ type: "text", text: "Client loses" }];
  await save(owner, source.id, first);
  await expect(save(owner, source.id, second)).rejects.toSatisfy((error: { code?: string; status?: number; details?: { server: { content: RichNode }; client: { content: RichNode } } }) => {
    const body = JSON.stringify(error.details ?? {});
    return error.code === "synced_conflict" && error.status === 409 && body.includes("Server wins") && body.includes("Client loses") && !body.includes(secret);
  });
  expect(syncedText((await r.get(source.id, owner)).document)).toContain("Server wins");
  expect(syncedText((await r.get(source.id, owner)).document)).not.toContain("Client loses");
  expect(created.page.version).toBeGreaterThan(0);
});

it("unsyncs one placement and keeps the others", async () => {
  const first = await page("Unsync A");
  const second = await page("Unsync B");
  const third = await page("Unsync C");
  const created = await save(owner, first.id, paragraphs(["Shared copy"]));
  const syncedId = String(created.page.document.content![0].attrs!.syncedId);
  const b = await save(owner, second.id, ensureIds({ type: "doc", content: [{ type: "syncedBlock", attrs: { id: crypto.randomUUID(), syncedId } }] }));
  const c = await save(owner, third.id, ensureIds({ type: "doc", content: [{ type: "syncedBlock", attrs: { id: crypto.randomUUID(), syncedId } }] }));
  const removed = await unsyncPlacement(r, owner, second.id, { operationId: crypto.randomUUID(), blockId: blockId(b.page.document) });
  expect(removed).toMatchObject({ unsynced: true, placementCount: 2 });
  expect((await r.get(second.id, owner)).document.content!.some(node => node.type === "syncedBlock")).toBe(false);
  expect(JSON.stringify((await r.get(second.id, owner)).document)).toContain("Shared copy");
  expect(String((await r.get(third.id, owner)).document.content![0].attrs!.syncedId)).toBe(syncedId);
  expect(blockId(c.page.document)).toBeTruthy();
});

it("deletes one placement, then all copies, with a 30-day undo and a hidden-page count", async () => {
  const first = await page("Visible A");
  const second = await page("Visible B");
  const third = await page(hiddenTitle, editor);
  const created = await save(owner, first.id, paragraphs([secret]));
  const syncedId = String(created.page.document.content![0].attrs!.syncedId);
  await grantSyncedAccess(r, owner, first.id, { operationId: crypto.randomUUID(), blockId: blockId(created.page.document), subject: editor.id, role: "editor" });
  const b = await save(owner, second.id, ensureIds({ type: "doc", content: [{ type: "syncedBlock", attrs: { id: crypto.randomUUID(), syncedId } }] }));
  const hidden = await save(editor, third.id, ensureIds({ type: "doc", content: [{ type: "syncedBlock", attrs: { id: crypto.randomUUID(), syncedId } }] }));
  const deletedOne = await deleteSyncedPlacement(r, owner, second.id, { operationId: crypto.randomUUID(), blockId: blockId(b.page.document) });
  expect(deletedOne).toMatchObject({ deleted: "placement", placementCount: 2 });
  expect(String((await r.get(hidden.page.id, editor)).document.content![0].attrs!.syncedId)).toBe(syncedId);
  const preview = await previewDeleteAll(r, owner, first.id, blockId(created.page.document));
  expect(preview.titles).not.toContain(hiddenTitle);
  expect(preview.hiddenCount).toBe(1);
  expect(preview.confirm).toBe(deleteAllCopy(preview.titles, 1));
  expect(preview.confirm).toContain("1 other page you can't see");
  expect(preview.confirm).not.toContain(hiddenTitle);
  expect(preview.confirm).not.toContain(secret);
  await expect(deleteAllSyncedCopies(r, owner, first.id, { operationId: crypto.randomUUID(), blockId: blockId(created.page.document), confirm: true, titles: [], hiddenCount: 0 })).rejects.toMatchObject({ code: "synced_confirm_stale" });
  await deleteAllSyncedCopies(r, owner, first.id, { operationId: crypto.randomUUID(), blockId: blockId(created.page.document), confirm: true, titles: preview.titles, hiddenCount: preview.hiddenCount });
  expect(syncedText((await r.get(first.id, owner)).document)).not.toContain(secret);
  const undone = await undoDeleteAll(r, owner, first.id, { operationId: crypto.randomUUID(), blockId: blockId(created.page.document) });
  expect(undone).toMatchObject({ restored: true });
  expect(syncedText((await r.get(first.id, owner)).document)).toContain(secret);
  await deleteAllSyncedCopies(r, owner, first.id, { operationId: crypto.randomUUID(), blockId: blockId(created.page.document), confirm: true, titles: preview.titles, hiddenCount: preview.hiddenCount });
  await db.query("UPDATE hs_synced_blocks SET purge_after=clock_timestamp()-interval '1 day' WHERE id=$1", [syncedId]);
  await expect(undoDeleteAll(r, owner, first.id, { operationId: crypto.randomUUID(), blockId: blockId(created.page.document) })).rejects.toMatchObject({ code: "synced_undo_expired" });
  expect(JSON.stringify(await r.get(first.id, owner))).not.toContain(secret);
});

it("requires source edit rights and shows the source hint until an explicit editor is granted", async () => {
  const source = await page("Source only");
  const placement = await page("Placement edit");
  await grant(source.id, reader, "viewer");
  await grant(placement.id, reader, "editor");
  const created = await save(owner, source.id, paragraphs([secret]));
  const syncedId = String(created.page.document.content![0].attrs!.syncedId);
  await save(owner, placement.id, ensureIds({ type: "doc", content: [{ type: "syncedBlock", attrs: { id: crypto.randomUUID(), syncedId } }] }));
  const visible = await r.get(placement.id, reader);
  expect(visible.document.content![0].attrs).toMatchObject({ syncLocked: true, syncState: "live" });
  expect(syncedText(visible.document)).toContain(secret);
  const attempt = structuredClone(visible.document);
  attempt.content![0].content![0].content = [{ type: "text", text: "Reader rewrite" }];
  await expect(save(reader, placement.id, attempt)).rejects.toMatchObject({ code: "synced_read_only", message: "Edit in source" });
  expect(syncedText((await r.get(source.id, owner)).document)).toContain(secret);
  await grantSyncedAccess(r, owner, source.id, { operationId: crypto.randomUUID(), blockId: blockId(created.page.document), subject: reader.id, role: "editor" });
  const allowed = await r.get(placement.id, reader);
  allowed.document.content![0].content![0].content = [{ type: "text", text: "Explicit editor" }];
  expect(syncedText((await save(reader, placement.id, allowed.document)).page.document)).toContain("Explicit editor");
});

it("uses one restricted shape for hidden, deleted and unknown ids, including revoke", async () => {
  const source = await page("Private source");
  const placement = await page("Shared placement");
  await grant(placement.id, viewer, "viewer");
  await grant(source.id, viewer, "viewer");
  const created = await save(owner, source.id, paragraphs([secret]));
  const syncedId = String(created.page.document.content![0].attrs!.syncedId);
  const block = blockId(created.page.document);
  await save(owner, placement.id, ensureIds({ type: "doc", content: [{ type: "syncedBlock", attrs: { id: crypto.randomUUID(), syncedId } }] }));
  expect(syncedText((await r.get(placement.id, viewer)).document)).toContain(secret);
  await db.query("DELETE FROM hs_grants WHERE page_id=$1 AND subject=$2", [source.id, viewer.id]);
  const revoked = await r.get(placement.id, viewer);
  const missing = await resolveSyncedProbe(r, viewer, placement.id, crypto.randomUUID());
  const hiddenView = await resolveSyncedProbe(r, viewer, placement.id, syncedId);
  expect(hiddenView).toEqual(missing);
  expect(hiddenView).toEqual({ state: "restricted", label: "Restricted content" });
  expect(JSON.stringify(revoked)).not.toContain(secret);
  expect(revoked.document.content![0].attrs).toMatchObject({ syncState: "restricted" });
  expect(revoked.document.content![0].attrs!.syncedId).toBeUndefined();
  await grant(source.id, owner, "editor");
  const preview = await previewDeleteAll(r, owner, source.id, block);
  await deleteAllSyncedCopies(r, owner, source.id, { operationId: crypto.randomUUID(), blockId: block, confirm: true, titles: preview.titles, hiddenCount: preview.hiddenCount });
  const deleted = await resolveSyncedProbe(r, viewer, placement.id, syncedId);
  expect(deleted).toEqual(missing);
  expect(JSON.stringify(await r.get(placement.id, viewer))).not.toContain(secret);
  expect(JSON.stringify((await db.query("SELECT after_value FROM hs_audit WHERE action='synced-block.delete-all'")).rows)).not.toContain(secret);
});

it("shows trash and unavailable states, then restore brings placements back", async () => {
  const source = await page("Trash source");
  const placement = await page("Trash placement");
  await grant(source.id, viewer, "viewer");
  await grant(placement.id, viewer, "viewer");
  const created = await save(owner, source.id, paragraphs([secret]));
  const syncedId = String(created.page.document.content![0].attrs!.syncedId);
  await save(owner, placement.id, ensureIds({ type: "doc", content: [{ type: "syncedBlock", attrs: { id: crypto.randomUUID(), syncedId } }] }));
  await db.query("UPDATE hs_pages SET deleted_at=clock_timestamp() WHERE id=$1", [source.id]);
  expect(await resolveSyncedProbe(r, viewer, placement.id, syncedId)).toEqual({ state: "unavailable", label: "Synced block unavailable" });
  expect(await resolveSyncedProbe(r, owner, placement.id, syncedId)).toEqual({ state: "trash", label: "Source in trash — Restore", canRestore: true });
  expect(JSON.stringify(await r.get(placement.id, viewer))).not.toContain(secret);
  await expect(restoreSyncedSource(r, viewer, placement.id, { operationId: crypto.randomUUID(), blockId: blockId((await r.get(placement.id, owner)).document) })).rejects.toMatchObject({ code: "not_found" });
  await restoreSyncedSource(r, owner, placement.id, { operationId: crypto.randomUUID(), blockId: blockId((await r.get(placement.id, owner)).document) });
  expect(syncedText((await r.get(placement.id, viewer)).document)).toContain(secret);
});

it("rejects a foreign or unknown synced id with the same generic error and stores nothing", async () => {
  const source = await page("Tenant A");
  const created = await save(owner, source.id, paragraphs([secret]));
  const syncedId = String(created.page.document.content![0].attrs!.syncedId);
  const foreign = await page("Tenant B", other);
  const before = await db.query<{ n: number }>("SELECT count(*)::int AS n FROM hs_synced_placements");
  const paste = ensureIds({ type: "doc", content: [{ type: "syncedBlock", attrs: { id: crypto.randomUUID(), syncedId } }] });
  const unknown = ensureIds({ type: "doc", content: [{ type: "syncedBlock", attrs: { id: crypto.randomUUID(), syncedId: crypto.randomUUID() } }] });
  const foreignError = save(other, foreign.id, paste);
  const unknownError = save(owner, source.id, unknown);
  await expect(foreignError).rejects.toMatchObject({ code: "not_found", message: "Synced block is restricted or unavailable" });
  await expect(unknownError).rejects.toMatchObject({ code: "not_found", message: "Synced block is restricted or unavailable" });
  const foreignMessage = await foreignError.catch(error => error.message);
  const unknownMessage = await unknownError.catch(error => error.message);
  expect(foreignMessage).toBe(unknownMessage);
  expect((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM hs_synced_placements")).rows[0].n).toBe(before.rows[0].n);
  expect(JSON.stringify(await r.get(foreign.id, other))).not.toContain(secret);
  expect(JSON.stringify((await db.query("SELECT node FROM hs_blocks WHERE page_id=$1", [foreign.id])).rows)).not.toContain(syncedId);
});
