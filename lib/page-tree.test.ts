import { afterAll, beforeAll, expect, it } from "vitest";
import { createDatabase, type Database } from "./database";
import { localActor } from "./auth";
import { dropPlacement, mergeSiblingOrder, PAGE_TREE_CREATE_DENIED, PAGE_TREE_EXPAND_BUDGET_MS, PAGE_TREE_ROW_PX, PAGE_TREE_UNAVAILABLE, PAGE_TREE_UNDO_MS, pageTreeWindow, siblingDestination } from "./page-tree-model";
import { applyPageTreeMove, cancelEmptyPageTreePage, createPageTreeChild, listPageTreeChildren, previewPageTreeMove, renamePageTreePage } from "./page-tree";
import { Repository } from "./repository";

let db: Database;
let r: Repository;
const owner = localActor;
const viewer = { id: "tree-viewer", name: "Tree viewer" };
const editor = { id: "tree-editor", name: "Tree editor" };
const outsider = { id: "tree-outsider", name: "Tree outsider" };
const ws = "ws-aplyd";

beforeAll(async () => {
  db = await createDatabase(":memory:");
  r = new Repository(db);
  await r.seedLocal();
  for (const user of [viewer, editor, outsider]) await db.query("INSERT INTO hs_users(id, name) VALUES($1,$2)", [user.id, user.name]);
  await db.query("INSERT INTO hs_members(workspace_id, user_id, role) VALUES($1,$2,'member'),($1,$3,'member')", [ws, viewer.id, editor.id]);
  await db.query("INSERT INTO hs_workspaces(id, name) VALUES('ws-b','Bolt')");
  await db.query("INSERT INTO hs_spaces(id, workspace_id, name) VALUES('space-b','ws-b','Ops')");
  await db.query("INSERT INTO hs_members(workspace_id, user_id, role) VALUES('ws-b',$1,'member')", [outsider.id]);
});
afterAll(() => db.close());

const shape = (error: unknown) => {
  const failed = error as { status?: number; code?: string; message?: string };
  return { status: failed.status, code: failed.code, message: failed.message };
};
async function fails(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    return shape(error);
  }
  throw new Error("expected a refusal");
}

it("keeps the virtual window and drop zones inside the N39 budgets", () => {
  expect(PAGE_TREE_EXPAND_BUDGET_MS).toBe(300);
  expect(PAGE_TREE_UNDO_MS).toBe(10_000);
  expect(pageTreeWindow(0, 360, 2000)).toEqual({ start: 0, end: Math.ceil(360 / PAGE_TREE_ROW_PX) + 6 });
  expect(pageTreeWindow(0, 360, 2000).end).toBeLessThan(40);
  expect(dropPlacement(1, 36)).toBe("before");
  expect(dropPlacement(18, 36)).toBe("inside");
  expect(dropPlacement(34, 36)).toBe("after");
  expect(siblingDestination(["a", "b", "c"], "a", "b", "after")).toBe(1);
  expect(mergeSiblingOrder(["h1", "v1", "h2", "v2", "h3"], ["v1", "v2"], "x", 1)).toEqual(["h1", "v1", "h2", "x", "v2", "h3"]);
  expect(mergeSiblingOrder(["v1", "v2"], ["v1", "v2"], "x", 5)).toBeNull();
});

it("does not reveal hidden children, counts, or grandchild payloads", async () => {
  const parent = await r.create(owner, "P-100", "space-product");
  const hidden = await r.create(owner, "P-200 hidden secret", "space-product", parent.id);
  const shown = await r.create(owner, "P-201 visible", "space-product", parent.id);
  const grandchild = await r.create(owner, "P-300 grandchild", "space-product", shown.id);
  await db.query("UPDATE hs_spaces SET home_page_id = $1 WHERE id = 'space-product'", [parent.id]);
  await db.query("INSERT INTO hs_page_template_sources(page_id, template_id, template_revision) VALUES($1,'starter-space-home',1)", [parent.id]);
  await db.query("INSERT INTO hs_space_members(space_id, user_id, role, granted_by) VALUES('space-product',$1,'viewer',$2)", [viewer.id, owner.id]);
  await db.query("INSERT INTO hs_grants(page_id, subject, role) VALUES($1,$2,'viewer')", [shown.id, viewer.id]);
  expect((await r.get(parent.id, viewer)).role).toBe("viewer");
  await expect(r.get(hidden.id, viewer)).rejects.toMatchObject({ status: 404, code: "not_found" });
  const roots = await listPageTreeChildren(r, viewer, ws, { spaceId: "space-product", parentId: null });
  const row = roots.nodes.find(node => node.id === parent.id);
  expect(row).toMatchObject({ hasVisibleChildren: true, role: "viewer" });
  expect(row && Object.keys(row).sort()).toEqual(["hasVisibleChildren", "id", "parentId", "position", "role", "spaceId", "title", "version"]);
  expect(JSON.stringify(roots)).not.toContain(hidden.id);
  expect(JSON.stringify(roots)).not.toContain("P-200 hidden secret");
  expect(JSON.stringify(roots)).not.toMatch(/childCount|hiddenCount/);
  const children = await listPageTreeChildren(r, viewer, ws, { spaceId: "space-product", parentId: parent.id });
  expect(children.nodes.map(node => node.id)).toEqual([shown.id]);
  expect(JSON.stringify(children)).not.toContain(hidden.id);
  expect(JSON.stringify(children)).not.toContain(grandchild.id);
  const ownerRoots = await listPageTreeChildren(r, owner, ws, { spaceId: "space-product", parentId: null });
  expect(ownerRoots.nodes.find(node => node.id === parent.id)?.hasVisibleChildren).toBe(true);
  const ownerChildren = await listPageTreeChildren(r, owner, ws, { spaceId: "space-product", parentId: parent.id });
  expect(ownerChildren.nodes.map(node => node.id).sort()).toEqual([hidden.id, shown.id].sort());
  expect(ownerChildren.nodes.find(node => node.id === shown.id)?.hasVisibleChildren).toBe(true);
  const nested = await listPageTreeChildren(r, owner, ws, { spaceId: "space-product", parentId: shown.id });
  expect(nested.nodes.map(node => node.id)).toEqual([grandchild.id]);
  const hiddenParent = await fails(() => listPageTreeChildren(r, viewer, ws, { spaceId: "space-product", parentId: hidden.id }));
  const missingParent = await fails(() => listPageTreeChildren(r, viewer, ws, { spaceId: "space-product", parentId: crypto.randomUUID() }));
  expect(hiddenParent).toEqual(missingParent);
  expect(hiddenParent).toEqual({ status: 404, code: "not_found", message: PAGE_TREE_UNAVAILABLE });
  const first = await listPageTreeChildren(r, owner, ws, { spaceId: "space-product", parentId: parent.id, pageSize: 1 });
  expect(first.nodes).toHaveLength(1);
  expect(first.nextCursor).toBe(first.nodes[0].id);
  const second = await listPageTreeChildren(r, owner, ws, { spaceId: "space-product", parentId: parent.id, pageSize: 1, cursor: first.nextCursor });
  expect(second.nodes.map(node => node.id)).not.toContain(first.nodes[0].id);
});

it("returns one not-found shape for cross-tenant, missing, and unreadable targets", async () => {
  const local = await r.create(owner, "Local tree page", "space-product");
  const foreign = await r.create(outsider, "Foreign tree page", "space-b");
  const missingSpace = await fails(() => listPageTreeChildren(r, owner, ws, { spaceId: crypto.randomUUID(), parentId: null }));
  const foreignSpace = await fails(() => listPageTreeChildren(r, owner, ws, { spaceId: "space-b", parentId: null }));
  const foreignWorkspace = await fails(() => listPageTreeChildren(r, outsider, ws, { spaceId: "space-product", parentId: null }));
  const missingWorkspace = await fails(() => listPageTreeChildren(r, outsider, crypto.randomUUID(), { spaceId: "space-product", parentId: null }));
  expect(missingSpace).toEqual(foreignSpace);
  expect(foreignWorkspace).toEqual(missingWorkspace);
  expect(foreignSpace).toEqual({ status: 404, code: "not_found", message: PAGE_TREE_UNAVAILABLE });
  const foreignParent = await fails(() => previewPageTreeMove(r, owner, ws, { pageId: local.id, spaceId: "space-product", parentId: foreign.id, index: 0 }));
  const missingParent = await fails(() => previewPageTreeMove(r, owner, ws, { pageId: local.id, spaceId: "space-product", parentId: crypto.randomUUID(), index: 0 }));
  const foreignPage = await fails(() => previewPageTreeMove(r, outsider, "ws-b", { pageId: local.id, spaceId: "space-b", parentId: null, index: 0 }));
  const missingPage = await fails(() => previewPageTreeMove(r, outsider, "ws-b", { pageId: crypto.randomUUID(), spaceId: "space-b", parentId: null, index: 0 }));
  expect(foreignParent).toEqual(missingParent);
  expect(foreignPage).toEqual(missingPage);
  expect(foreignParent).toEqual({ status: 404, code: "not_found", message: PAGE_TREE_UNAVAILABLE });
  const emptyId = crypto.randomUUID();
  await db.query("INSERT INTO hs_spaces(id, workspace_id, name) VALUES($1,$2,'Empty tree space')", [emptyId, ws]);
  expect((await listPageTreeChildren(r, owner, ws, { spaceId: emptyId, parentId: null })).nodes).toEqual([]);
});

it("moves with an idempotent operation, confirms inherited access, and keeps titles out of the audit", async () => {
  const first = await r.create(owner, "Order alpha", "space-product");
  const second = await r.create(owner, "TreeSecretTitleZZ", "space-product");
  const before = await r.get(second.id, owner);
  const preview = await previewPageTreeMove(r, owner, ws, { pageId: second.id, spaceId: "space-product", parentId: null, index: 0 });
  expect(preview.expandsAccess).toBe(false);
  const input = { pageId: second.id, spaceId: "space-product", parentId: null, index: 0, operationId: crypto.randomUUID(), expectedTreeVersion: preview.treeVersion, previewDigest: preview.digest, confirmExpanded: false };
  const ack = await applyPageTreeMove(r, owner, ws, input);
  const again = await applyPageTreeMove(r, owner, ws, input);
  expect(again).toMatchObject({ replayed: true, treeVersion: ack.treeVersion, pageId: second.id });
  expect(ack.atIst).toMatch(/IST$/);
  expect((await listPageTreeChildren(r, owner, ws, { spaceId: "space-product", parentId: null })).nodes[0].id).toBe(second.id);
  expect((await r.get(second.id, owner)).document).toEqual(before.document);
  expect((await r.get(second.id, owner)).version).toBe(before.version);
  expect((await db.query("SELECT id FROM hs_audit WHERE correlation_id = $1 AND action = 'page.tree.move'", [input.operationId])).rows).toHaveLength(1);
  expect(JSON.stringify((await db.query("SELECT after_value FROM hs_audit WHERE correlation_id = $1", [input.operationId])).rows)).not.toContain("TreeSecretTitleZZ");
  await expect(applyPageTreeMove(r, owner, ws, { ...input, index: 1 })).rejects.toMatchObject({ code: "operation_mismatch", status: 409 });
  expect((await r.get(second.id, owner)).id).toBe(second.id);
  void first;

  const oldParent = await r.create(owner, "Old access parent", "space-product");
  const newParent = await r.create(owner, "New access parent", "space-private");
  const moving = await r.create(owner, "Inherited move", "space-product", oldParent.id);
  await db.query("INSERT INTO hs_grants(page_id, subject, role) VALUES($1,$2,'viewer'),($3,$4,'editor')", [oldParent.id, viewer.id, newParent.id, editor.id]);
  const expansion = await previewPageTreeMove(r, owner, ws, { pageId: moving.id, spaceId: "space-private", parentId: newParent.id, index: 0 });
  expect(expansion.expandsAccess).toBe(true);
  expect(expansion.changes).toContainEqual(expect.objectContaining({ pageId: moving.id, recipientId: editor.id, after: "editor" }));
  const command = { pageId: moving.id, spaceId: "space-private", parentId: newParent.id, index: 0, operationId: crypto.randomUUID(), expectedTreeVersion: expansion.treeVersion, previewDigest: expansion.digest, confirmExpanded: false };
  await expect(applyPageTreeMove(r, owner, ws, command)).rejects.toMatchObject({ code: "access_confirmation_required" });
  expect((await r.get(moving.id, owner)).parentPageId).toBe(oldParent.id);
  const applied = await applyPageTreeMove(r, owner, ws, { ...command, confirmExpanded: true });
  expect(applied.replayed).toBe(false);
  expect((await r.get(moving.id, editor)).role).toBe("editor");
});

it("refuses a revoked or read-only move and a trashed destination with the neutral not-found", async () => {
  const source = await r.create(owner, "Revoke source", "space-product");
  const destination = await r.create(owner, "Revoke destination", "space-product");
  await db.query("INSERT INTO hs_grants(page_id, subject, role) VALUES($1,$2,'editor'),($3,$2,'editor')", [source.id, editor.id, destination.id]);
  const preview = await previewPageTreeMove(r, editor, ws, { pageId: source.id, spaceId: "space-product", parentId: destination.id, index: 0 });
  await db.query("DELETE FROM hs_grants WHERE subject = $1 AND page_id = ANY($2::text[])", [editor.id, [source.id, destination.id]]);
  const revoked = await fails(() => applyPageTreeMove(r, editor, ws, { pageId: source.id, spaceId: "space-product", parentId: destination.id, index: 0, operationId: crypto.randomUUID(), expectedTreeVersion: preview.treeVersion, previewDigest: preview.digest, confirmExpanded: true }));
  const missing = await fails(() => applyPageTreeMove(r, editor, ws, { pageId: crypto.randomUUID(), spaceId: "space-product", parentId: destination.id, index: 0, operationId: crypto.randomUUID(), expectedTreeVersion: preview.treeVersion, previewDigest: preview.digest, confirmExpanded: true }));
  expect(revoked).toEqual(missing);
  expect(revoked).toEqual({ status: 404, code: "not_found", message: PAGE_TREE_UNAVAILABLE });
  expect((await listPageTreeChildren(r, editor, ws, { spaceId: "space-product", parentId: null })).nodes.some(node => node.id === source.id)).toBe(false);

  const readable = await r.create(owner, "Commenter page", "space-product");
  await db.query("INSERT INTO hs_grants(page_id, subject, role) VALUES($1,$2,'commenter')", [readable.id, editor.id]);
  await expect(previewPageTreeMove(r, editor, ws, { pageId: readable.id, spaceId: "space-product", parentId: null, index: 0 })).rejects.toMatchObject({ status: 403, code: "read_only" });

  const trashed = await r.create(owner, "Trashed destination", "space-product");
  const held = await r.create(owner, "Held page", "space-product");
  await db.query("UPDATE hs_pages SET deleted_at = clock_timestamp() WHERE id = $1", [trashed.id]);
  const trashedDrop = await fails(() => previewPageTreeMove(r, owner, ws, { pageId: held.id, spaceId: "space-product", parentId: trashed.id, index: 0 }));
  const unknownDrop = await fails(() => previewPageTreeMove(r, owner, ws, { pageId: held.id, spaceId: "space-product", parentId: crypto.randomUUID(), index: 0 }));
  expect(trashedDrop).toEqual(unknownDrop);
  expect((await listPageTreeChildren(r, owner, ws, { spaceId: "space-product", parentId: null })).nodes.some(node => node.id === trashed.id)).toBe(false);
  await expect(previewPageTreeMove(r, owner, ws, { pageId: trashed.id, spaceId: "space-product", parentId: null, index: 0 })).rejects.toMatchObject({ status: 404, code: "not_found", message: PAGE_TREE_UNAVAILABLE });
});

it("explains a destination without create rights and does not move the page", async () => {
  const page = await r.create(owner, "Restricted space move", "space-product");
  await db.query("UPDATE hs_workspaces SET access_model_version = 2 WHERE id = $1", [ws]);
  try {
    await expect(previewPageTreeMove(r, owner, ws, { pageId: page.id, spaceId: "space-product", parentId: null, index: 0 })).rejects.toMatchObject({ status: 403, code: "destination_create_required", message: PAGE_TREE_CREATE_DENIED });
    expect((await r.get(page.id, owner)).spaceId).toBe("space-product");
    expect((await r.get(page.id, owner)).parentPageId).toBeNull();
  } finally {
    await db.query("UPDATE hs_workspaces SET access_model_version = 1 WHERE id = $1", [ws]);
  }
});

it("creates through a creation intent, cancels an empty page, and renames without logging the title", async () => {
  const parent = await r.create(owner, "Create parent", "space-product");
  const operationId = crypto.randomUUID();
  const created = await createPageTreeChild(r, owner, ws, { spaceId: "space-product", parentId: parent.id, operationId });
  const replay = await createPageTreeChild(r, owner, ws, { spaceId: "space-product", parentId: parent.id, operationId });
  expect(replay).toMatchObject({ pageId: created.pageId, replayed: true });
  expect((await db.query("SELECT id FROM hs_pages WHERE parent_id = $1 AND title = 'Untitled' AND deleted_at IS NULL", [parent.id])).rows).toHaveLength(1);
  const cancelled = await cancelEmptyPageTreePage(r, owner, ws, operationId);
  expect(cancelled.replayed).toBe(false);
  expect((await cancelEmptyPageTreePage(r, owner, ws, operationId)).replayed).toBe(true);
  await expect(r.get(created.pageId, owner)).rejects.toMatchObject({ status: 404 });
  expect((await listPageTreeChildren(r, owner, ws, { spaceId: "space-product", parentId: parent.id })).nodes.some(node => node.id === created.pageId)).toBe(false);
  expect((await db.query("SELECT id FROM hs_audit WHERE correlation_id = $1 AND action = 'page.tree.cancel'", [operationId])).rows).toHaveLength(1);

  const renameOperation = crypto.randomUUID();
  const kept = await createPageTreeChild(r, owner, ws, { spaceId: "space-product", parentId: parent.id, operationId: crypto.randomUUID() });
  await renamePageTreePage(r, owner, ws, { pageId: kept.pageId, title: "Renamed secret title", baseVersion: kept.version, operationId: renameOperation });
  const renamedAgain = await renamePageTreePage(r, owner, ws, { pageId: kept.pageId, title: "Renamed secret title", baseVersion: kept.version, operationId: renameOperation });
  expect(renamedAgain.replayed).toBe(true);
  expect((await r.get(kept.pageId, owner)).title).toBe("Renamed secret title");
  const audit = JSON.stringify((await db.query("SELECT after_value FROM hs_audit WHERE correlation_id = $1", [renameOperation])).rows);
  expect(audit).not.toContain("Renamed secret title");
  expect(audit).not.toContain("\"doc\"");
  await expect(cancelEmptyPageTreePage(r, owner, ws, kept.pageId ? (await db.query<{ operation_id: string }>("SELECT operation_id FROM hs_page_creations WHERE page_id = $1", [kept.pageId])).rows[0].operation_id : "")).rejects.toMatchObject({ code: "page_not_empty" });
});
