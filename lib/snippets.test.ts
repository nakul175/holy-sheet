import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, expect, it } from "vitest";
import { localActor } from "./auth";
import { createDatabase, type Database } from "./database";
import { DocumentError, ensureIds, type RichNode } from "./document";
import { Repository } from "./repository";
import { SNIPPET_DELETED_BADGE, SNIPPET_HIDDEN_MESSAGE, SNIPPET_RETIRED_BADGE, SNIPPET_UPDATE_LABEL, snippetUsageCsv } from "./snippet-copy";
import {
  approveSnippetVersion,
  createSnippet,
  deleteSnippet,
  detachSnippetPlacement,
  draftSnippetVersion,
  getSnippet,
  insertSnippetPlacement,
  listSnippetLibrary,
  listSnippetPicker,
  listSnippetPlacements,
  previewSnippetRetire,
  restoreSnippet,
  retireSnippet,
  revokeSnippetRole,
  snippetUsageReport,
  submitSnippetVersion,
  updateSnippetPlacement,
} from "./snippets";

let db: Database;
let r: Repository;
const owner = localActor;
const admin = { id: "snippet-admin" };
const editor = { id: "snippet-editor" };
const viewer = { id: "snippet-viewer" };
const outsider = { id: "snippet-outsider" };
const reviewer = { id: "snippet-reviewer" };
const other = { id: "snippet-other" };
const v1 = "SECRET_SNIPPET_V1";
const v2 = "SECRET_SNIPPET_V2";
const draft = "SECRET_SNIPPET_DRAFT";

beforeAll(async () => {
  db = await createDatabase(":memory:");
  r = new Repository(db);
  await r.seedLocal();
  for (const actor of [admin, editor, viewer, outsider, reviewer, other]) await db.query("INSERT INTO hs_users(id,name) VALUES($1,$1)", [actor.id]);
  for (const actor of [admin, editor, viewer, outsider, reviewer]) await db.query("INSERT INTO hs_members(workspace_id,user_id) VALUES('ws-aplyd',$1)", [actor.id]);
  await db.query("UPDATE hs_members SET role='admin' WHERE workspace_id='ws-aplyd' AND user_id=$1", [admin.id]);
  await db.query("INSERT INTO hs_workspaces(id,name) VALUES('ws-b','Bolt Logistics')");
  await db.query("INSERT INTO hs_spaces(id,workspace_id,name) VALUES('space-b','ws-b','Other space')");
  await db.query("INSERT INTO hs_members(workspace_id,user_id,role) VALUES('ws-b',$1,'owner')", [other.id]);
  for (const [user, role] of [[owner.id, "manager"], [admin.id, "approver"], [reviewer.id, "reviewer"]] as const) {
    await db.query("INSERT INTO hs_snippet_roles(space_id,user_id,role,granted_by) VALUES('space-product',$1,$2,$3)", [user, role, owner.id]);
  }
});
afterAll(async () => { await db.close(); });

function wording(text: string): RichNode {
  return { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] };
}
async function save(actor: { id: string }, pageId: string, document: RichNode) {
  const page = await r.get(pageId, actor);
  return r.save(pageId, actor, { operationId: crypto.randomUUID(), baseVersion: page.version, title: page.title, document });
}
async function page(actor: { id: string }, title: string, space = actor.id === other.id ? "space-b" : "space-product") {
  return r.create(actor, title, space);
}
async function grant(pageId: string, actor: { id: string }, role: "viewer" | "editor") {
  await db.query("INSERT INTO hs_grants(page_id,subject,role) VALUES($1,$2,$3)", [pageId, actor.id, role]);
}
async function approvedSnippet(title: string, text = v1) {
  const created = await createSnippet(r, owner, "ws-aplyd", { operationId: crypto.randomUUID(), spaceId: "space-product", title, content: wording(text) });
  await submitSnippetVersion(r, owner, "ws-aplyd", created.snippetId, { operationId: crypto.randomUUID(), versionNumber: 1 });
  await approveSnippetVersion(r, admin, "ws-aplyd", created.snippetId, { operationId: crypto.randomUUID(), versionNumber: 1, note: "Approved for regulated reuse" });
  return created.snippetId;
}
async function failure(run: () => Promise<unknown>) {
  try {
    await run();
    return { ok: true as const };
  } catch (error) {
    const err = error as DocumentError;
    return { message: err.message, code: err.code, status: err.status };
  }
}
async function audits() {
  return JSON.stringify((await db.query("SELECT action,after_value FROM hs_audit WHERE action LIKE 'snippet.%'")).rows);
}

it("replays the snippet migration", async () => {
  const sql = await readFile("db/101_content_snippets.sql", "utf8");
  expect(sql).toContain("CREATE TABLE IF NOT EXISTS hs_snippets");
  expect(sql).toContain("CREATE TABLE IF NOT EXISTS hs_snippet_versions");
  expect(sql).toContain("CREATE TABLE IF NOT EXISTS hs_snippet_placements");
  expect(sql).toContain("pin_version");
  const parts: string[] = [];
  let current = "";
  for (const line of sql.split("\n")) {
    current += `${line}\n`;
    if (line.trim().endsWith(";")) {
      if (current.replace(/^\s*--.*$/gm, "").trim()) parts.push(current.trim());
      current = "";
    }
  }
  for (const statement of parts) await db.query(statement);
  for (const statement of parts) await db.query(statement);
  const columns = await db.query<{ column_name: string }>("SELECT column_name FROM information_schema.columns WHERE table_name='hs_snippet_versions' ORDER BY column_name");
  expect(columns.rows.map(row => row.column_name)).toEqual(expect.arrayContaining(["state", "approved_by", "approved_at"]));
});

it("quotes usage csv cells and keeps the body out of the export", () => {
  const csv = snippetUsageCsv([{ pageId: "p", pageTitle: "=cmd", pageOwnerId: "u", pageOwnerName: "Ada", versionMode: "latest", versionNumber: 1 }]);
  expect(csv.startsWith("page_id,page_title,page_owner_id,page_owner_name,version_mode,version_number\n")).toBe(true);
  expect(csv).toContain(`"'=cmd"`);
  expect(csv).not.toContain(v1);
});

it("moves a snippet from draft to approved and shows it in the picker only then", async () => {
  const operationId = crypto.randomUUID();
  const created = await createSnippet(r, owner, "ws-aplyd", { operationId, spaceId: "space-product", title: "Medical disclaimer", content: wording(v1) });
  const replay = await createSnippet(r, owner, "ws-aplyd", { operationId, spaceId: "space-product", title: "Medical disclaimer", content: wording(v1) });
  expect(replay.snippetId).toBe(created.snippetId);
  expect((await db.query("SELECT id FROM hs_snippets WHERE title='Medical disclaimer'")).rows).toHaveLength(1);
  const home = await page(editor, "Picker page");
  expect((await listSnippetPicker(r, editor, home.id)).snippets.map(item => item.title)).not.toContain("Medical disclaimer");
  await submitSnippetVersion(r, owner, "ws-aplyd", created.snippetId, { operationId: crypto.randomUUID(), versionNumber: 1 });
  expect((await getSnippet(r, owner, "ws-aplyd", created.snippetId)).versions[0].state).toBe("in review");
  const approved = await approveSnippetVersion(r, admin, "ws-aplyd", created.snippetId, { operationId: crypto.randomUUID(), versionNumber: 1, note: "Use on clinical pages" });
  expect(approved.approvedBy).toBe(admin.id);
  expect(approved.approvedAtIst).toContain("IST");
  const detail = await getSnippet(r, owner, "ws-aplyd", created.snippetId);
  expect(detail.state).toBe("approved");
  expect(detail.versions[0]).toMatchObject({ state: "approved", note: "Use on clinical pages", approvedBy: admin.id });
  expect(detail.versions[0].approvedAtIst).toContain("IST");
  expect((await listSnippetPicker(r, editor, home.id)).snippets.map(item => item.title)).toContain("Medical disclaimer");
  const log = await audits();
  expect(log).toContain("atIst");
  expect(log).not.toContain(v1);
  expect(log).not.toContain("Use on clinical pages");
});

it("follows the latest approved version or keeps a pin with an update banner", async () => {
  const snippetId = await approvedSnippet("Follow or pin");
  const follow = await page(owner, "P-100");
  const pinned = await page(owner, "P-101");
  await grant(follow.id, editor, "editor");
  await grant(pinned.id, editor, "editor");
  await insertSnippetPlacement(r, editor, follow.id, { operationId: crypto.randomUUID(), snippetId, pinVersion: null });
  await insertSnippetPlacement(r, editor, pinned.id, { operationId: crypto.randomUUID(), snippetId, pinVersion: 1 });
  await draftSnippetVersion(r, owner, "ws-aplyd", snippetId, { operationId: crypto.randomUUID(), content: wording(v2) });
  await submitSnippetVersion(r, owner, "ws-aplyd", snippetId, { operationId: crypto.randomUUID(), versionNumber: 2 });
  await approveSnippetVersion(r, admin, "ws-aplyd", snippetId, { operationId: crypto.randomUUID(), versionNumber: 2, note: "Second approval" });
  expect(JSON.stringify((await r.get(follow.id, editor)).document)).toContain(v2);
  const pinDocument = JSON.stringify((await r.get(pinned.id, editor)).document);
  expect(pinDocument).toContain(v1);
  expect(pinDocument).not.toContain(v2);
  const pinView = (await listSnippetPlacements(r, editor, pinned.id)).placements[0];
  expect(pinView).toMatchObject({ state: "live", versionNumber: 1, mode: "pinned", updateLabel: SNIPPET_UPDATE_LABEL });
  await updateSnippetPlacement(r, editor, pinned.id, { operationId: crypto.randomUUID(), blockId: pinView.state === "live" ? pinView.blockId : "" });
  expect(JSON.stringify((await r.get(pinned.id, editor)).document)).toContain(v2);
  expect((await listSnippetPlacements(r, editor, pinned.id)).placements[0]).toMatchObject({ versionNumber: 2, updateLabel: null });
});

it("discards in-place edits and logs detach without the body", async () => {
  const snippetId = await approvedSnippet("Read only placement");
  const host = await page(owner, "Detach page");
  await grant(host.id, editor, "editor");
  const inserted = await insertSnippetPlacement(r, editor, host.id, { operationId: crypto.randomUUID(), snippetId, pinVersion: null });
  const current = await r.get(host.id, editor);
  const edited = structuredClone(current.document);
  const snippet = edited.content!.find(node => node.attrs?.snippetId === snippetId)!;
  snippet.content = [{ type: "paragraph", attrs: { id: crypto.randomUUID() }, content: [{ type: "text", text: "HACKED_SNIPPET" }] }];
  await save(editor, host.id, edited);
  const stored = JSON.stringify((await db.query("SELECT node FROM hs_blocks WHERE page_id=$1", [host.id])).rows);
  expect(stored).not.toContain("HACKED_SNIPPET");
  expect(stored).not.toContain(v1);
  expect(JSON.stringify((await r.get(host.id, editor)).document)).toContain(v1);
  expect(JSON.stringify((await r.get(host.id, editor)).document)).not.toContain("HACKED_SNIPPET");
  await detachSnippetPlacement(r, editor, host.id, { operationId: crypto.randomUUID(), blockId: inserted.blockId });
  const detached = JSON.stringify((await r.get(host.id, editor)).document);
  expect(detached).toContain(v1);
  expect(detached).not.toContain(snippetId);
  const log = await audits();
  expect(log).toContain("snippet.detach");
  expect(log).not.toContain(v1);
  expect((await db.query("SELECT 1 FROM hs_snippet_placements WHERE page_id=$1 AND block_id=$2", [host.id, inserted.blockId])).rows).toHaveLength(0);
});

it("shows readers the approved text and keeps the draft in the manager library", async () => {
  const snippetId = await approvedSnippet("Draft stays backstage");
  const host = await page(owner, "Reader page");
  await grant(host.id, viewer, "viewer");
  await grant(host.id, editor, "editor");
  await insertSnippetPlacement(r, owner, host.id, { operationId: crypto.randomUUID(), snippetId, pinVersion: null });
  await draftSnippetVersion(r, owner, "ws-aplyd", snippetId, { operationId: crypto.randomUUID(), content: wording(draft) });
  expect(JSON.stringify((await r.get(host.id, viewer)).document)).toContain(v1);
  expect(JSON.stringify((await r.get(host.id, viewer)).document)).not.toContain(draft);
  expect(JSON.stringify(await listSnippetLibrary(r, editor, "ws-aplyd", "space-product"))).not.toContain(draft);
  expect(JSON.stringify(await getSnippet(r, owner, "ws-aplyd", snippetId))).toContain(draft);
  expect(JSON.stringify(await getSnippet(r, reviewer, "ws-aplyd", snippetId))).toContain(draft);
  expect((await listSnippetPicker(r, editor, host.id)).snippets.find(item => item.id === snippetId)?.versions.map(version => version.number)).toEqual([1]);
});

it("retires a snippet across readable and hidden pages", async () => {
  const snippetId = await approvedSnippet("Retire me");
  const readable = [];
  for (let index = 0; index < 10; index += 1) {
    const created = await page(owner, `Visible ${index}`);
    await insertSnippetPlacement(r, owner, created.id, { operationId: crypto.randomUUID(), snippetId, pinVersion: null });
    readable.push(created);
  }
  const hiddenTitle = "HIDDEN_RETIRE_TITLE";
  for (let index = 0; index < 2; index += 1) {
    const created = await page(editor, `${hiddenTitle} ${index}`);
    await insertSnippetPlacement(r, editor, created.id, { operationId: crypto.randomUUID(), snippetId, pinVersion: null });
  }
  const preview = await previewSnippetRetire(r, owner, "ws-aplyd", snippetId);
  expect(preview.titles).toHaveLength(10);
  expect(preview.hiddenCount).toBe(2);
  expect(preview.confirm).not.toContain(hiddenTitle);
  expect(preview.confirm).toContain("2 other pages without titles");
  await expect(retireSnippet(r, owner, "ws-aplyd", snippetId, { operationId: crypto.randomUUID(), titles: [], hiddenCount: 0 })).rejects.toMatchObject({ code: "snippet_confirm_stale" });
  await retireSnippet(r, owner, "ws-aplyd", snippetId, { operationId: crypto.randomUUID(), titles: preview.titles, hiddenCount: preview.hiddenCount });
  await grant(readable[0].id, editor, "editor");
  await grant(readable[0].id, viewer, "viewer");
  expect((await listSnippetPlacements(r, editor, readable[0].id)).placements[0]).toMatchObject({ state: "live", badge: SNIPPET_RETIRED_BADGE });
  expect((await listSnippetPlacements(r, viewer, readable[0].id)).placements[0]).toMatchObject({ state: "live", badge: null });
  expect(JSON.stringify((await r.get(readable[0].id, viewer)).document)).toContain(v1);
  expect((await listSnippetPicker(r, editor, readable[0].id)).snippets.map(item => item.id)).not.toContain(snippetId);
});

it("lists readable usage and exports csv without hidden titles or bodies", async () => {
  const snippetId = await approvedSnippet("Usage snippet", "USAGE_SECRET_BODY");
  const visible = await page(owner, "Usage visible");
  const concealed = await page(editor, "USAGE_HIDDEN_TITLE");
  await insertSnippetPlacement(r, owner, visible.id, { operationId: crypto.randomUUID(), snippetId, pinVersion: 1 });
  await insertSnippetPlacement(r, editor, concealed.id, { operationId: crypto.randomUUID(), snippetId, pinVersion: null });
  const report = await snippetUsageReport(r, owner, "ws-aplyd", snippetId);
  expect(report.placements.map(row => row.pageTitle)).toContain("Usage visible");
  expect(report.placements.map(row => row.pageTitle)).not.toContain("USAGE_HIDDEN_TITLE");
  expect(report.placements.find(row => row.pageTitle === "Usage visible")).toMatchObject({ versionMode: "pinned", versionNumber: 1, pageOwnerId: owner.id });
  const csv = snippetUsageCsv(report.placements);
  expect(csv).toContain("Usage visible");
  expect(csv).not.toContain("USAGE_HIDDEN_TITLE");
  expect(csv).not.toContain("USAGE_SECRET_BODY");
  await expect(snippetUsageReport(r, editor, "ws-aplyd", snippetId)).rejects.toMatchObject({ code: "not_found" });
});

it("rejects an unreadable snippet insert with the same not-found as an unknown id", async () => {
  const snippetId = await approvedSnippet("Ops only");
  const host = await page(outsider, "Outside page", "space-private");
  const denied = await failure(() => insertSnippetPlacement(r, outsider, host.id, { operationId: crypto.randomUUID(), snippetId, pinVersion: null }));
  const unknown = await failure(() => insertSnippetPlacement(r, outsider, host.id, { operationId: crypto.randomUUID(), snippetId: crypto.randomUUID(), pinVersion: null }));
  expect(denied).toEqual(unknown);
  expect(denied).toEqual({ message: SNIPPET_HIDDEN_MESSAGE, code: "not_found", status: 404 });
  expect((await db.query("SELECT 1 FROM hs_snippet_placements WHERE page_id=$1", [host.id])).rows).toHaveLength(0);
});

it("rejects approval after the approver role is removed and leaves the version in review", async () => {
  const temp = { id: "snippet-temp-approver" };
  await db.query("INSERT INTO hs_users(id,name) VALUES($1,$1)", [temp.id]);
  await db.query("INSERT INTO hs_members(workspace_id,user_id,role) VALUES('ws-aplyd',$1,'admin')", [temp.id]);
  await db.query("INSERT INTO hs_snippet_roles(space_id,user_id,role,granted_by) VALUES('space-product',$1,'approver',$2)", [temp.id, admin.id]);
  const created = await createSnippet(r, owner, "ws-aplyd", { operationId: crypto.randomUUID(), spaceId: "space-product", title: "Needs a second look", content: wording(v2) });
  await submitSnippetVersion(r, owner, "ws-aplyd", created.snippetId, { operationId: crypto.randomUUID(), versionNumber: 1 });
  await revokeSnippetRole(r, admin, "ws-aplyd", { operationId: crypto.randomUUID(), spaceId: "space-product", userId: temp.id, role: "approver" });
  const denied = await failure(() => approveSnippetVersion(r, temp, "ws-aplyd", created.snippetId, { operationId: crypto.randomUUID(), versionNumber: 1, note: "Too late" }));
  const unknown = await failure(() => approveSnippetVersion(r, temp, "ws-aplyd", crypto.randomUUID(), { operationId: crypto.randomUUID(), versionNumber: 1, note: "Too late" }));
  expect(denied).toEqual(unknown);
  expect(denied).toEqual({ message: SNIPPET_HIDDEN_MESSAGE, code: "not_found", status: 404 });
  expect((await getSnippet(r, owner, "ws-aplyd", created.snippetId)).versions[0].state).toBe("in review");
  expect(JSON.stringify(await getSnippet(r, owner, "ws-aplyd", created.snippetId))).not.toContain("Too late");
});

it("keeps deleted snippet text for 30 days, badges it for editors, and restores it", async () => {
  const snippetId = await approvedSnippet("Soft delete");
  const host = await page(owner, "Delete page");
  await grant(host.id, editor, "editor");
  await grant(host.id, viewer, "viewer");
  await insertSnippetPlacement(r, owner, host.id, { operationId: crypto.randomUUID(), snippetId, pinVersion: null });
  await deleteSnippet(r, owner, "ws-aplyd", snippetId, { operationId: crypto.randomUUID() });
  expect(JSON.stringify((await r.get(host.id, viewer)).document)).toContain(v1);
  expect((await listSnippetPlacements(r, viewer, host.id)).placements[0]).toMatchObject({ badge: null });
  expect((await listSnippetPlacements(r, editor, host.id)).placements[0]).toMatchObject({ badge: SNIPPET_DELETED_BADGE });
  await restoreSnippet(r, owner, "ws-aplyd", snippetId, { operationId: crypto.randomUUID() });
  expect((await listSnippetPlacements(r, editor, host.id)).placements[0]).toMatchObject({ state: "live", badge: null });
  expect(JSON.stringify((await r.get(host.id, viewer)).document)).toContain(v1);
  await deleteSnippet(r, owner, "ws-aplyd", snippetId, { operationId: crypto.randomUUID() });
  await db.query("UPDATE hs_snippets SET purge_after=clock_timestamp()-interval '1 day' WHERE id=$1", [snippetId]);
  const expired = JSON.stringify((await r.get(host.id, editor)).document);
  expect(expired).not.toContain(v1);
  expect((await listSnippetPlacements(r, editor, host.id)).placements[0]).toMatchObject({ state: "restricted", label: "Restricted content" });
  await expect(restoreSnippet(r, owner, "ws-aplyd", snippetId, { operationId: crypto.randomUUID() })).rejects.toMatchObject({ code: "snippet_restore_expired" });
});

it("rejects a cross-tenant snippet id with the same generic not-found as an unknown id", async () => {
  const snippetId = await approvedSnippet("Tenant boundary");
  const host = await page(other, "Bolt page");
  const before = (await r.get(host.id, other)).version;
  const foreign = ensureIds({ type: "doc", content: [{ type: "syncedBlock", attrs: { id: crypto.randomUUID(), snippetId }, content: [{ type: "paragraph", content: [{ type: "text", text: "FOREIGN_BODY" }] }] }] });
  const missing = ensureIds({ type: "doc", content: [{ type: "syncedBlock", attrs: { id: crypto.randomUUID(), snippetId: crypto.randomUUID() }, content: [{ type: "paragraph", content: [{ type: "text", text: "FOREIGN_BODY" }] }] }] });
  const denied = await failure(() => save(other, host.id, foreign));
  const unknown = await failure(() => save(other, host.id, missing));
  expect(denied).toEqual(unknown);
  expect(denied).toEqual({ message: SNIPPET_HIDDEN_MESSAGE, code: "not_found", status: 404 });
  expect((await r.get(host.id, other)).version).toBe(before);
  expect((await db.query("SELECT 1 FROM hs_snippet_placements WHERE snippet_id=$1 AND page_id=$2", [snippetId, host.id])).rows).toHaveLength(0);
  expect(JSON.stringify((await db.query("SELECT node FROM hs_blocks WHERE page_id=$1", [host.id])).rows)).not.toContain("FOREIGN_BODY");
  expect(JSON.stringify((await db.query("SELECT node FROM hs_blocks WHERE page_id=$1", [host.id])).rows)).not.toContain(snippetId);
});
