import { afterAll, beforeAll, expect, it } from "vitest";
import { localActor } from "./auth";
import { ancestryQuery, readPageAncestry, readPageAncestryForPage } from "./breadcrumb";
import { BREADCRUMB_REFRESH_MS, BREADCRUMB_SIBLING_LIMIT, BREADCRUMB_TRASH, BREADCRUMB_UNAVAILABLE, type BreadcrumbView } from "./breadcrumb-model";
import { createDatabase, type Database } from "./database";
import { Repository } from "./repository";

let db: Database;
let r: Repository;
const owner = localActor;
const editor = { id: "crumb-editor", name: "Crumb editor" };
const ext = { id: "crumb-ext", name: "Crumb external" };
const outsider = { id: "crumb-outsider", name: "Crumb outsider" };
const ws = "ws-aplyd";
const none = { siblingsOf: null, allSiblings: false };

beforeAll(async () => {
  db = await createDatabase(":memory:");
  r = new Repository(db);
  await r.seedLocal();
  for (const user of [editor, ext, outsider]) await db.query("INSERT INTO hs_users(id, name) VALUES($1,$2)", [user.id, user.name]);
  await db.query("INSERT INTO hs_members(workspace_id, user_id, role) VALUES($1,$2,'member'),($1,$3,'member')", [ws, editor.id, ext.id]);
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
  try { await run(); } catch (error) { return shape(error); }
  throw new Error("expected a refusal");
}
async function chain(titles: string[]) {
  const pages = [];
  let parent: string | null = null;
  for (const title of titles) {
    const page = await r.create(owner, title, "space-product", parent);
    pages.push(page);
    parent = page.id;
  }
  return pages;
}
async function grant(pageId: string, userId: string, role = "editor") {
  await db.query("INSERT INTO hs_grants(page_id, subject, role) VALUES($1,$2,$3)", [pageId, userId, role]);
}
function labels(view: BreadcrumbView) {
  if (view.state !== "ready") return [];
  return view.segments.map(segment => (segment.readable ? segment.title : "…"));
}

it("rejects a malformed sibling query before reading a page", () => {
  expect(ancestryQuery(new URL("https://hs.example/ancestry"))).toEqual(none);
  expect(ancestryQuery(new URL("https://hs.example/ancestry?siblingsOf=page-1&all=1"))).toEqual({ siblingsOf: "page-1", allSiblings: true });
  expect(() => ancestryQuery(new URL("https://hs.example/ancestry?all=yes"))).toThrow(expect.objectContaining({ status: 404, code: "not_found", message: BREADCRUMB_UNAVAILABLE }));
  expect(() => ancestryQuery(new URL(`https://hs.example/ancestry?siblingsOf=${"x".repeat(201)}`))).toThrow(expect.objectContaining({ status: 404, message: BREADCRUMB_UNAVAILABLE }));
});

it("shows Space › ancestors › current for a depth-4 page the editor can read", async () => {
  const [root, middle, leaf] = await chain(["P-100", "P-103", "P-105"]);
  await grant(root.id, editor.id);
  const view = await readPageAncestry(r, editor, ws, leaf.id, none);
  expect(view.state).toBe("ready");
  if (view.state !== "ready") return;
  expect(labels(view)).toEqual(["Product", "P-100", "P-103", "P-105"]);
  expect(view.segments.map(segment => segment.readable && segment.current)).toEqual([false, false, false, true]);
  const current = view.segments[3];
  expect(current.readable && current.href).toBe(`/pages/${encodeURIComponent(leaf.id)}`);
  expect(view.segments.slice(0, 3).every(segment => segment.readable && segment.href.length > 0)).toBe(true);
  expect(BREADCRUMB_REFRESH_MS).toBeLessThanOrEqual(5_000);
});

it("returns every readable segment of a depth-9 page for the client to collapse", async () => {
  const titles = Array.from({ length: 8 }, (_, index) => `Depth ${index + 1}`);
  const pages = await chain(titles);
  await grant(pages[0].id, editor.id);
  const view = await readPageAncestry(r, editor, ws, pages[7].id, none);
  expect(view.state).toBe("ready");
  if (view.state !== "ready") return;
  expect(labels(view)).toEqual(["Product", ...titles]);
  expect(view.segments).toHaveLength(9);
});

it("lists at most 20 readable siblings and omits a sibling the reader cannot open", async () => {
  const parent = await r.create(owner, "Sibling parent", "space-product");
  const secret = await r.create(owner, "Secret sibling title", "space-product", parent.id);
  const visible: { id: string; title: string }[] = [];
  for (let index = 0; index < 22; index += 1) {
    const page = await r.create(owner, `Sibling ${String(index).padStart(2, "0")}`, "space-product", parent.id);
    await grant(page.id, ext.id);
    visible.push({ id: page.id, title: page.title });
  }
  const current = visible[0].id;
  const preview = await readPageAncestry(r, ext, ws, current, none);
  expect(preview.state).toBe("ready");
  if (preview.state !== "ready") return;
  const leaf = preview.segments.find(segment => segment.readable && segment.current);
  expect(leaf?.readable && leaf.siblings).toHaveLength(BREADCRUMB_SIBLING_LIMIT);
  expect(leaf?.readable && leaf.siblingsTruncated).toBe(true);
  expect(JSON.stringify(preview)).not.toContain(secret.id);
  expect(JSON.stringify(preview)).not.toContain("Secret sibling title");
  expect(JSON.stringify(preview)).not.toContain(parent.id);
  expect(JSON.stringify(preview)).not.toContain("Sibling parent");
  const hiddenQuery = await fails(() => readPageAncestry(r, ext, ws, current, { siblingsOf: secret.id, allSiblings: true }));
  const randomQuery = await fails(() => readPageAncestry(r, ext, ws, current, { siblingsOf: crypto.randomUUID(), allSiblings: true }));
  expect(hiddenQuery).toEqual(randomQuery);
  expect(hiddenQuery).toEqual({ status: 404, code: "not_found", message: BREADCRUMB_UNAVAILABLE });
  const all = await readPageAncestry(r, ext, ws, current, { siblingsOf: current, allSiblings: true });
  expect(all.state).toBe("ready");
  if (all.state !== "ready") return;
  const expanded = all.segments.find(segment => segment.readable && segment.current);
  expect(expanded?.readable && expanded.siblingsTruncated).toBe(false);
  expect(expanded?.readable && expanded.siblings.map(sibling => sibling.title).sort()).toEqual(visible.slice(1).map(page => page.title).sort());
  expect(JSON.stringify(all)).not.toContain(secret.id);
  expect(JSON.stringify(all)).not.toContain("Secret sibling title");
});

it("refreshes the trail after a rename and a move", async () => {
  const oldParent = await r.create(owner, "Old crumb parent", "space-product");
  const nextParent = await r.create(owner, "New crumb parent", "space-product");
  const leaf = await r.create(owner, "Crumb before rename", "space-product", oldParent.id);
  const before = await readPageAncestry(r, owner, ws, leaf.id, none);
  expect(labels(before)).toEqual(["Product", "Old crumb parent", "Crumb before rename"]);
  await db.query("UPDATE hs_pages SET title = $2 WHERE id = $1", [leaf.id, "Crumb after rename"]);
  const renamed = await readPageAncestry(r, owner, ws, leaf.id, none);
  expect(labels(renamed)).toEqual(["Product", "Old crumb parent", "Crumb after rename"]);
  await db.query("UPDATE hs_pages SET parent_id = $2 WHERE id = $1", [leaf.id, nextParent.id]);
  const moved = await readPageAncestry(r, owner, ws, leaf.id, none);
  expect(labels(moved)).toEqual(["Product", "New crumb parent", "Crumb after rename"]);
  expect(moved.state === "ready" && moved.segments[1]).toMatchObject({ readable: true, id: nextParent.id, title: "New crumb parent" });
  const audits = await db.query("SELECT id FROM hs_audit WHERE action LIKE 'breadcrumb.%'");
  expect(audits.rows).toEqual([]);
});

it("hides ancestor titles and ids when the reader has only a direct grant on the leaf", async () => {
  const [root, middle, leaf] = await chain(["Hidden root title", "Hidden middle title", "Visible leaf"]);
  await grant(leaf.id, ext.id);
  const view = await readPageAncestry(r, ext, ws, leaf.id, none);
  expect(view.state).toBe("ready");
  if (view.state !== "ready") return;
  expect(labels(view)).toEqual(["…", "Visible leaf"]);
  expect(view.segments[0]).toEqual({ readable: false });
  const body = JSON.stringify(view);
  for (const secret of [root.id, middle.id, root.title, middle.title, "Product", "Aplyd", "space-product"]) expect(body).not.toContain(secret);
  const ancestor = await fails(() => readPageAncestry(r, ext, ws, root.id, none));
  const missing = await fails(() => readPageAncestry(r, ext, ws, crypto.randomUUID(), none));
  expect(ancestor).toEqual(missing);
  expect(ancestor).toEqual({ status: 404, code: "not_found", message: BREADCRUMB_UNAVAILABLE });
  const byPage = await readPageAncestryForPage(r, ext, leaf.id, none);
  expect(JSON.stringify(byPage)).toBe(body);
});

it("turns a revoked middle ancestor into an ellipsis and keeps the direct leaf grant", async () => {
  const [root, middle, leaf] = await chain(["Kept root", "Revoked middle", "Kept leaf"]);
  await grant(middle.id, editor.id);
  await grant(leaf.id, editor.id);
  expect(labels(await readPageAncestry(r, editor, ws, leaf.id, none))).toEqual(["Product", "…", "Revoked middle", "Kept leaf"]);
  await db.query("DELETE FROM hs_grants WHERE page_id = $1 AND subject = $2", [middle.id, editor.id]);
  const view = await readPageAncestry(r, editor, ws, leaf.id, none);
  expect(labels(view)).toEqual(["…", "Kept leaf"]);
  expect(view.state === "ready" && view.segments[0]).toEqual({ readable: false });
  const body = JSON.stringify(view);
  expect(body).not.toContain(middle.id);
  expect(body).not.toContain(root.id);
  expect(body).not.toContain("Revoked middle");
  expect(body).not.toContain("Kept root");
  expect(body).not.toContain("Product");
  expect(body).toContain("Kept leaf");
});

it("returns trash for the owner and the same not-found as a missing page for everyone else", async () => {
  const [root, , leaf] = await chain(["Trashed ancestor title", "Trashed child title", "Trashed leaf title"]);
  await grant(leaf.id, ext.id);
  await db.query("UPDATE hs_pages SET deleted_at = clock_timestamp() WHERE id = ANY($1::text[])", [[root.id, leaf.id]]);
  const ownerView = await readPageAncestry(r, owner, ws, leaf.id, none);
  expect(ownerView).toEqual({ state: "trash", message: BREADCRUMB_TRASH });
  expect(JSON.stringify(ownerView)).not.toContain("Trashed ancestor title");
  expect(JSON.stringify(ownerView)).not.toContain(root.id);
  const reader = await fails(() => readPageAncestry(r, ext, ws, leaf.id, none));
  const missing = await fails(() => readPageAncestry(r, ext, ws, crypto.randomUUID(), none));
  const byPage = await fails(() => readPageAncestryForPage(r, ext, leaf.id, none));
  const missingPage = await fails(() => readPageAncestryForPage(r, ext, crypto.randomUUID(), none));
  expect(reader).toEqual(missing);
  expect(byPage).toEqual(missingPage);
  expect(reader).toEqual({ status: 404, code: "not_found", message: BREADCRUMB_UNAVAILABLE });
});

it("uses one not-found shape for a cross-tenant ancestry request and a missing id", async () => {
  const local = await r.create(owner, "Local crumb", "space-product");
  const foreign = await r.create(outsider, "Bolt secret crumb", "space-b");
  const foreignWorkspace = await fails(() => readPageAncestry(r, outsider, ws, local.id, none));
  const missingWorkspace = await fails(() => readPageAncestry(r, outsider, crypto.randomUUID(), local.id, none));
  const missingPage = await fails(() => readPageAncestry(r, outsider, "ws-b", crypto.randomUUID(), none));
  const foreignPage = await fails(() => readPageAncestry(r, owner, ws, foreign.id, none));
  const unknownPage = await fails(() => readPageAncestry(r, owner, ws, crypto.randomUUID(), none));
  const foreignByPage = await fails(() => readPageAncestryForPage(r, outsider, local.id, none));
  const unknownByPage = await fails(() => readPageAncestryForPage(r, outsider, crypto.randomUUID(), none));
  expect(foreignWorkspace).toEqual(missingWorkspace);
  expect(foreignWorkspace).toEqual(missingPage);
  expect(foreignPage).toEqual(unknownPage);
  expect(foreignByPage).toEqual(unknownByPage);
  expect(foreignWorkspace).toEqual({ status: 404, code: "not_found", message: BREADCRUMB_UNAVAILABLE });
  expect(JSON.stringify(foreignPage)).not.toContain("Bolt secret crumb");
  expect(JSON.stringify(foreignByPage)).not.toContain(local.title);
});
