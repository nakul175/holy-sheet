import { readFileSync } from "node:fs";
import { afterAll, beforeAll, expect, it } from "vitest";
import { createDatabase, type Database } from "./database";
import { DocumentError, plainText } from "./document";
import { Repository } from "./repository";
import { changeSpaceHome, readSpaceHome } from "./space-home";
import { dropPin, movePin, SPACE_HOME_DESCRIPTION, SPACE_HOME_LCP_BUDGET_MS, SPACE_HOME_PAGE_UNAVAILABLE, SPACE_HOME_START, SPACE_HOME_TEMPLATE_ID, SPACE_HOME_TITLE, SPACE_HOME_UNAVAILABLE } from "./space-home-shared";

let db: Database;
let r: Repository;
const workspace = "ws-aplyd";
const foreignWorkspace = "ws-bolt";
const admin = { id: "n38-admin", name: "U-ADM" };
const viewer = { id: "n38-viewer", name: "U-VI" };
const editor = { id: "n38-editor", name: "U-ED" };
const outsider = { id: "n38-out", name: "U-OUT" };
const foreign = { id: "n38-foreign", name: "U-B" };
const hiddenOwner = { id: "n38-hidden-owner", name: "Hidden Owner Name" };

beforeAll(async () => {
  db = await createDatabase(":memory:");
  r = new Repository(db);
  await r.seedLocal();
  for (const user of [admin, viewer, editor, outsider, foreign, hiddenOwner]) await db.query("INSERT INTO hs_users(id, name) VALUES($1,$2)", [user.id, user.name]);
  await db.query("INSERT INTO hs_members(workspace_id, user_id, role) VALUES($1,$2,'owner'),($1,$3,'member'),($1,$4,'member'),($1,$5,'member'),($1,$6,'member')", [workspace, admin.id, viewer.id, editor.id, outsider.id, hiddenOwner.id]);
  await db.query("INSERT INTO hs_workspaces(id, name) VALUES($1,'Bolt')", [foreignWorkspace]);
  await db.query("INSERT INTO hs_members(workspace_id, user_id, role) VALUES($1,$2,'owner')", [foreignWorkspace, foreign.id]);
});
afterAll(async () => db.close());

async function fail(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    return error as DocumentError;
  }
  throw new Error("expected failure");
}
function shape(error: unknown) {
  const document = error as DocumentError;
  return { status: document.status, code: document.code, message: document.message };
}
async function space(name = "Ops") {
  return r.createSpace(admin, `${name} ${crypto.randomUUID().slice(0, 8)}`, workspace);
}
async function join(spaceId: string, userId: string, role: "leader" | "editor" | "viewer") {
  await db.query("INSERT INTO hs_space_members(space_id, user_id, role, granted_by) VALUES($1,$2,$3,$4) ON CONFLICT(space_id, user_id) DO UPDATE SET role = EXCLUDED.role, active = true", [spaceId, userId, role, admin.id]);
}
async function share(pageId: string, userId: string) {
  await db.query("INSERT INTO hs_grants(page_id, subject, role) VALUES($1,$2,'viewer')", [pageId, userId]);
}

it("moves and drops pin order without losing ids", () => {
  expect(movePin(["a", "b", "c"], "a", 1)).toEqual(["b", "a", "c"]);
  expect(movePin(["a", "b", "c"], "a", -1)).toEqual(["a", "b", "c"]);
  expect(dropPin(["a", "b", "c"], "a", "c")).toEqual(["b", "c", "a"]);
});

it("creates a Space home template page with the four widgets", async () => {
  const created = await space("SP-NEW");
  await join(created.id, viewer.id, "viewer");
  const home = await readSpaceHome(r, admin, workspace, created.id);
  expect(home.home).toMatchObject({ title: SPACE_HOME_TITLE, templateName: SPACE_HOME_TITLE });
  expect(home.home?.summary).toContain(SPACE_HOME_DESCRIPTION);
  expect(home.home?.headings).toContain(SPACE_HOME_START);
  expect(Object.keys(home.widgets).sort()).toEqual(["owners", "pinned", "recent", "recordViews"]);
  expect(home.widgets.owners).toContainEqual(expect.objectContaining({ userId: admin.id, role: "leader" }));
  expect(plainText((await r.get(home.home!.pageId, admin)).document)).toContain(SPACE_HOME_START);
  expect((await db.query<{ template_id: string; home_page_id: string }>("SELECT src.template_id, s.home_page_id FROM hs_page_template_sources src JOIN hs_spaces s ON s.home_page_id = src.page_id WHERE s.id = $1", [created.id])).rows).toEqual([{ template_id: SPACE_HOME_TEMPLATE_ID, home_page_id: home.home!.pageId }]);
  expect((await readSpaceHome(r, viewer, workspace, created.id)).home?.title).toBe(SPACE_HOME_TITLE);
  expect((await r.get(home.home!.pageId, viewer)).role).toBe("viewer");
  const audit = JSON.stringify((await db.query("SELECT after_value FROM hs_audit WHERE action = 'space-home.provision' AND page_id = $1", [home.home!.pageId])).rows);
  expect(audit).toContain("IST");
  expect(audit).not.toContain(SPACE_HOME_DESCRIPTION);
  expect(audit).not.toContain(SPACE_HOME_START);
});

it("sets another page as home and keeps the previous page", async () => {
  const created = await space("SP-OPS");
  await join(created.id, viewer.id, "viewer");
  const before = await readSpaceHome(r, admin, workspace, created.id);
  const previous = before.home!.pageId;
  const next = await r.create(admin, "P-100", created.id);
  const operationId = crypto.randomUUID();
  const updated = await changeSpaceHome(r, admin, workspace, created.id, { action: "set-home", operationId, pageId: next.id });
  expect(updated.home?.pageId).toBe(next.id);
  expect(updated.home?.title).toBe("P-100");
  expect(updated.widgets.pinned).toEqual([]);
  expect((await r.get(previous, admin)).title).toBe(SPACE_HOME_TITLE);
  expect((await changeSpaceHome(r, admin, workspace, created.id, { action: "set-home", operationId, pageId: next.id })).replayed).toBe(true);
  expect((await db.query("SELECT id FROM hs_audit WHERE correlation_id = $1", [operationId])).rows).toHaveLength(1);
  const hiddenFromViewer = await readSpaceHome(r, viewer, workspace, created.id);
  expect(hiddenFromViewer.home).toBeNull();
  expect(JSON.stringify(hiddenFromViewer)).not.toContain("P-100");
  expect(hiddenFromViewer.widgets.recent).toEqual(expect.any(Array));
  await expect(r.get(previous, viewer)).rejects.toMatchObject({ status: 404 });
  await share(next.id, viewer.id);
  expect((await readSpaceHome(r, viewer, workspace, created.id)).home?.title).toBe("P-100");
  const audit = JSON.stringify((await db.query("SELECT after_value FROM hs_audit WHERE correlation_id = $1", [operationId])).rows);
  expect(audit).not.toContain("P-100");
  expect(audit).toContain("IST");
});

it("pins six pages and keeps the reordered sequence", async () => {
  const created = await space("Pins");
  const ids: string[] = [];
  for (let index = 0; index < 6; index += 1) {
    const page = await r.create(admin, `Pin ${index}`, created.id);
    ids.push(page.id);
    await changeSpaceHome(r, admin, workspace, created.id, { action: "pin", operationId: crypto.randomUUID(), pageId: page.id });
  }
  const reversed = [...ids].reverse();
  await changeSpaceHome(r, admin, workspace, created.id, { action: "reorder", operationId: crypto.randomUUID(), pageIds: reversed });
  const home = await readSpaceHome(r, admin, workspace, created.id);
  expect(home.widgets.pinned.map(pin => pin.pageId)).toEqual(reversed);
  expect(home.widgets.pinned.every(pin => pin.icon === "document" && pin.title.startsWith("Pin "))).toBe(true);
  await join(created.id, viewer.id, "viewer");
  await expect(changeSpaceHome(r, viewer, workspace, created.id, { action: "reorder", operationId: crypto.randomUUID(), pageIds: ids })).rejects.toMatchObject({ status: 403, code: "not_allowed" });
});

it("shows the last ten readable updates with the editor and IST time", async () => {
  const created = await space("Recent");
  await join(created.id, viewer.id, "viewer");
  await join(created.id, hiddenOwner.id, "viewer");
  const homeId = (await readSpaceHome(r, admin, workspace, created.id)).home!.pageId;
  await db.query("UPDATE hs_pages SET updated_at = '2019-01-01T00:00:00Z' WHERE id = $1", [homeId]);
  for (let index = 0; index < 12; index += 1) {
    const page = await r.create(editor, `Visible ${index}`, created.id);
    await share(page.id, viewer.id);
    await db.query("UPDATE hs_pages SET updated_at = $2 WHERE id = $1", [page.id, new Date(Date.UTC(2026, 10, 1, 0, index)).toISOString()]);
  }
  const secret = await r.create(hiddenOwner, "Secret Recent Page", created.id);
  await db.query("UPDATE hs_pages SET updated_at = '2026-12-01T00:00:00Z' WHERE id = $1", [secret.id]);
  const recent = (await readSpaceHome(r, viewer, workspace, created.id)).widgets.recent;
  expect(recent.map(item => item.title)).toEqual(Array.from({ length: 10 }, (_, index) => `Visible ${11 - index}`));
  expect(recent.every(item => item.editorName === "U-ED" && item.updatedAtIst.includes("IST"))).toBe(true);
  const body = JSON.stringify(recent);
  expect(body).not.toContain("Secret Recent Page");
  expect(body).not.toContain("Hidden Owner Name");
});

it("lists a readable record view and readable page owners only", async () => {
  const created = await space("Views");
  await join(created.id, viewer.id, "viewer");
  await join(created.id, hiddenOwner.id, "viewer");
  const viewId = "00000000-0000-4000-8000-000000000281";
  const visible = await r.create(editor, "Readable view page", created.id);
  await share(visible.id, viewer.id);
  const secret = await r.create(hiddenOwner, "Hidden Clinic Page", created.id);
  const viewNode = (id: string, collectionId: string, layout: "table" | "list", limit: number) => JSON.stringify({ type: "recordView", attrs: { id: crypto.randomUUID(), nodeVersion: 1, viewId: id, collectionId, layout, columns: ["name"], limit } });
  await db.query("INSERT INTO hs_blocks(id, page_id, parent_id, position, type, node, version) VALUES($1,$2,NULL,1,'recordView',$3,1)", [crypto.randomUUID(), visible.id, viewNode(viewId, "organisations", "table", 10)]);
  await db.query("INSERT INTO hs_blocks(id, page_id, parent_id, position, type, node, version) VALUES($1,$2,NULL,1,'recordView',$3,1)", [crypto.randomUUID(), secret.id, viewNode("00000000-0000-4000-8000-000000000282", "secretcollection", "list", 5)]);
  const home = await readSpaceHome(r, viewer, workspace, created.id);
  expect(home.widgets.recordViews).toEqual([expect.objectContaining({ pageId: visible.id, pageTitle: "Readable view page", collectionId: "organisations", layout: "table" })]);
  expect(home.widgets.owners.map(owner => owner.name)).toContain("U-ED");
  expect(home.widgets.owners.map(owner => owner.name)).not.toContain("Hidden Owner Name");
  const body = JSON.stringify(home);
  expect(body).not.toContain("secretcollection");
  expect(body).not.toContain("Hidden Clinic Page");
  expect(home.pinCandidates).toEqual([]);
});

it("uses one not-found shape for outsiders, unknown spaces, and other tenants", async () => {
  const created = await space("Denied");
  const unknown = await fail(() => readSpaceHome(r, outsider, workspace, crypto.randomUUID()));
  const denied = await fail(() => readSpaceHome(r, outsider, workspace, created.id));
  const cross = await fail(() => readSpaceHome(r, foreign, workspace, created.id));
  const swapped = await fail(() => readSpaceHome(r, foreign, foreignWorkspace, created.id));
  expect(shape(denied)).toEqual(shape(unknown));
  expect(shape(cross)).toEqual(shape(unknown));
  expect(shape(swapped)).toEqual(shape(unknown));
  expect(shape(denied)).toEqual({ status: 404, code: "not_found", message: SPACE_HOME_UNAVAILABLE });
  expect(JSON.stringify(shape(denied))).not.toContain(created.name);
  const homeId = (await readSpaceHome(r, admin, workspace, created.id)).home!.pageId;
  await expect(r.get(homeId, outsider)).rejects.toMatchObject({ status: 404, code: "not_found" });
  await expect(r.get(homeId, foreign)).rejects.toMatchObject({ status: 404, code: "not_found" });
});

it("clears a revoked reader and rejects the same mutation", async () => {
  const created = await space("Revoke");
  await join(created.id, viewer.id, "viewer");
  expect((await readSpaceHome(r, viewer, workspace, created.id)).spaceName).toBe(created.name);
  await db.query("UPDATE hs_space_members SET active = false WHERE space_id = $1 AND user_id = $2", [created.id, viewer.id]);
  const revoked = await fail(() => readSpaceHome(r, viewer, workspace, created.id));
  const unknown = await fail(() => readSpaceHome(r, viewer, workspace, crypto.randomUUID()));
  expect(shape(revoked)).toEqual(shape(unknown));
  const page = await r.create(admin, "Still private", created.id);
  await expect(changeSpaceHome(r, viewer, workspace, created.id, { action: "pin", operationId: crypto.randomUUID(), pageId: page.id })).rejects.toMatchObject({ status: 404, code: "not_found", message: SPACE_HOME_UNAVAILABLE });
  expect((await db.query("SELECT page_id FROM hs_space_pins WHERE space_id = $1 AND page_id = $2", [created.id, page.id])).rows).toEqual([]);
  await db.query("UPDATE hs_members SET active = false WHERE workspace_id = $1 AND user_id = $2", [workspace, viewer.id]);
  try {
    expect(shape(await fail(() => readSpaceHome(r, viewer, workspace, created.id)))).toEqual(shape(unknown));
  } finally {
    await db.query("UPDATE hs_members SET active = true WHERE workspace_id = $1 AND user_id = $2", [workspace, viewer.id]);
  }
});

it("omits trashed and hidden pins without a placeholder count", async () => {
  const created = await space("Omit");
  await join(created.id, viewer.id, "viewer");
  const shown = await r.create(admin, "Shown pin", created.id);
  const secret = await r.create(admin, "Hidden Clinic Page", created.id);
  const doomed = await r.create(admin, "Trashed Pin Title", created.id);
  await share(shown.id, viewer.id);
  await share(doomed.id, viewer.id);
  for (const pageId of [shown.id, secret.id, doomed.id]) await changeSpaceHome(r, admin, workspace, created.id, { action: "pin", operationId: crypto.randomUUID(), pageId });
  await db.query("UPDATE hs_pages SET deleted_at = clock_timestamp() WHERE id = $1", [doomed.id]);
  const home = await readSpaceHome(r, viewer, workspace, created.id);
  expect(home.widgets.pinned.map(pin => pin.title)).toEqual(["Shown pin"]);
  const body = JSON.stringify(home);
  expect(body).not.toContain("Hidden Clinic Page");
  expect(body).not.toContain("Trashed Pin Title");
  expect(body).not.toMatch(/omitted|hiddenCount|placeholder/i);
  const missing = await fail(() => changeSpaceHome(r, admin, workspace, created.id, { action: "pin", operationId: crypto.randomUUID(), pageId: crypto.randomUUID() }));
  const trashed = await fail(() => changeSpaceHome(r, admin, workspace, created.id, { action: "set-home", operationId: crypto.randomUUID(), pageId: doomed.id }));
  const other = await space("Elsewhere");
  const elsewhere = await r.create(admin, "Other space page", other.id);
  const wrongSpace = await fail(() => changeSpaceHome(r, admin, workspace, created.id, { action: "pin", operationId: crypto.randomUUID(), pageId: elsewhere.id }));
  expect(shape(missing)).toEqual(shape(trashed));
  expect(shape(wrongSpace)).toEqual(shape(missing));
  expect(shape(missing).message).toBe(SPACE_HOME_PAGE_UNAVAILABLE);
  expect(JSON.stringify(shape(wrongSpace))).not.toContain("Other space page");
});

it("documents the responsive stack and the unmeasured LCP budget", () => {
  const css = readFileSync("app/globals.css", "utf8");
  expect(css).toContain(".space-home-widgets{display:grid;grid-template-columns:1fr 1fr;");
  expect(css).toMatch(/@media \(max-width: 420px\)\{\s*\.space-home-widgets\{grid-template-columns:1fr\}/);
  const note = readFileSync("deployment/HOLY-72-SPACE-HOME.md", "utf8");
  expect(note).toContain("under 2.0 seconds");
  expect(note).toMatch(/does not record a staging Lighthouse run/i);
  expect(SPACE_HOME_LCP_BUDGET_MS).toBe(2000);
});
