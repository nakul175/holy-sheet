import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { localActor, type Actor } from "./auth";
import { createDatabase, type Database } from "./database";
import { ensureIds, type RichNode } from "./document";
import { inbox } from "./notifications";
import {
  PAGE_HIDDEN,
  REMOVED_FOLLOW,
  UNSUBSCRIBE_PAGE,
  changeFollowSettings,
  changePageFollow,
  digestWindow,
  listPageFollows,
  pageFollowState,
  runPageFollowDigests,
  signPageUnsubscribe,
  unsubscribeFromToken,
} from "./page-follows";
import { assignSpaceSlug, changePublishedPage } from "./published-pages";
import { Repository } from "./repository";
import { changeSharing } from "./sharing";
import { deletePageTree, previewPageDeletion } from "./trash";

const state = vi.hoisted(() => ({ repo: null as Repository | null }));
vi.mock("./auth", async () => {
  const actual = await vi.importActual<typeof import("./auth")>("./auth");
  return { ...actual, localPreview: () => true };
});
vi.mock("./repository", async () => {
  const actual = await vi.importActual<typeof import("./repository")>("./repository");
  return { ...actual, repository: async () => { if (!state.repo) throw new Error("repository unavailable"); return state.repo; } };
});
import { GET as followGet, POST as followPost } from "../app/api/v1/pages/[id]/follow/route";
import { GET as settingsGet } from "../app/api/v1/follows/route";
import { GET as unsubscribeGet } from "../app/follows/unsubscribe/route";

let db: Database;
let r: Repository;
const owner = localActor;
const editor: Actor = { id: "n45-editor", name: "U-ED" };
const viewer: Actor = { id: "n45-viewer", name: "U-VI" };
const outsider: Actor = { id: "n45-outsider", name: "U-OUT" };
const bolt: Actor = { id: "n45-bolt", name: "U-B" };
const ny: Actor = { id: "n45-ny", name: "U-NY" };
const ws = "ws-n45";
const boltWs = "ws-n45-b";
let ops = "";
let boltOps = "";
const monday = new Date("2026-11-09T03:30:00.000Z");
const tuesday = new Date("2026-11-10T03:30:00.000Z");
const early = new Date("2026-11-09T02:30:00.000Z");
const newYorkMorning = new Date("2026-11-09T14:00:00.000Z");

beforeAll(async () => {
  db = await createDatabase(":memory:");
  r = new Repository(db);
  state.repo = r;
  await r.seedLocal();
  await db.query("UPDATE hs_users SET name='U-OWN' WHERE id=$1", [owner.id]);
  for (const user of [editor, viewer, outsider, bolt, ny]) await db.query("INSERT INTO hs_users(id,name) VALUES($1,$2)", [user.id, user.name]);
  await db.query("INSERT INTO hs_workspaces(id,name) VALUES($1,'Acme Health'),($2,'Bolt Logistics')", [ws, boltWs]);
  await db.query(
    "INSERT INTO hs_members(workspace_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'member'),($1,$4,'member'),($1,$5,'member'),($1,$8,'member'),($6,$7,'member')",
    [ws, owner.id, editor.id, viewer.id, outsider.id, boltWs, bolt.id, ny.id],
  );
  ops = (await r.createSpace(owner, "SP-OPS", ws)).id;
  boltOps = (await r.createSpace(bolt, "SP-OPS", boltWs)).id;
  await assignSpaceSlug(r, owner, ops, "ops");
  await assignSpaceSlug(r, bolt, boltOps, "ops");
}, 30000);

afterAll(async () => { await db.close(); });

function document(ids: { heading: string; paragraph: string; extra?: string }, heading: string, text: string, extra?: string): RichNode {
  const content: RichNode[] = [
    { type: "heading", attrs: { id: ids.heading, level: 2 }, content: [{ type: "text", text: heading }] },
    { type: "paragraph", attrs: { id: ids.paragraph }, content: [{ type: "text", text }] },
  ];
  if (extra !== undefined && ids.extra) content.push({ type: "paragraph", attrs: { id: ids.extra }, content: [{ type: "text", text: extra }] });
  return ensureIds({ type: "doc", content });
}

async function makePage(title: string, parentId?: string) {
  const page = await r.create(owner, title, ops, parentId);
  await db.query("INSERT INTO hs_grants(page_id,subject,role) VALUES($1,$2,'editor'),($1,$3,'viewer')", [page.id, editor.id, viewer.id]);
  return page;
}

async function save(actor: Actor, id: string, body: RichNode, title?: string) {
  const current = await r.get(id, actor);
  return r.save(id, actor, { operationId: crypto.randomUUID(), baseVersion: current.version, title: title ?? current.title, document: body });
}

async function follow(actor: Actor, pageId: string, includeChildren = false) {
  return changePageFollow(r, actor, pageId, { action: "follow", operationId: crypto.randomUUID(), includeChildren });
}

async function publish(pageId: string, slug: string, note: string) {
  return changePublishedPage(r, owner, pageId, { action: "publish", operationId: crypto.randomUUID(), slug, note, freezeValues: false });
}

async function revoke(pageId: string, userId: string) {
  const version = (await db.query<{ acl_version: number }>("SELECT acl_version FROM hs_pages WHERE id=$1", [pageId])).rows[0].acl_version;
  await changeSharing(r, owner, pageId, { operationId: crypto.randomUUID(), expectedVersion: version, recipientId: userId, role: null });
}

async function trash(pageId: string) {
  const preview = await previewPageDeletion(r, owner, ws, pageId);
  await deletePageTree(r, owner, ws, pageId, { operationId: crypto.randomUUID(), expectedTreeVersion: preview.treeVersion, previewDigest: preview.digest });
}

async function mail(userId: string, kind?: string) {
  const rows = await db.query<{ kind: string; subject: string; body: string }>(
    `SELECT kind, subject, body FROM hs_page_digest_mail WHERE user_id=$1 ${kind ? "AND kind=$2" : ""} ORDER BY created_at`,
    kind ? [userId, kind] : [userId],
  );
  return rows.rows;
}

it("knows when 09:00 has arrived in the follower timezone", () => {
  expect(digestWindow(early, "Asia/Kolkata", "daily")).toBeNull();
  expect(digestWindow(monday, "Asia/Kolkata", "daily")).toBe("2026-11-09");
  expect(digestWindow(tuesday, "Asia/Kolkata", "weekly")).toBeNull();
  expect(digestWindow(monday, "Asia/Kolkata", "weekly")).toBe("2026-11-09");
  expect(digestWindow(monday, "America/New_York", "daily")).toBeNull();
  expect(digestWindow(newYorkMorning, "America/New_York", "daily")).toBe("2026-11-09");
});

it("follows a page or its children and lists that follow in settings", async () => {
  const page = await makePage("P-100 follow target");
  const child = await makePage("P-100 child", page.id);
  expect(await pageFollowState(r, viewer, page.id)).toEqual({ following: false, includeChildren: false, frequency: null });
  expect(await pageFollowState(r, owner, page.id)).toMatchObject({ following: true, frequency: "daily" });
  const operationId = crypto.randomUUID();
  const stored = await changePageFollow(r, viewer, page.id, { action: "follow", operationId, includeChildren: false });
  expect(stored).toMatchObject({ following: true, includeChildren: false, frequency: "daily", replayed: false });
  expect(await changePageFollow(r, viewer, page.id, { action: "follow", operationId, includeChildren: false })).toMatchObject({ replayed: true });
  const again = await follow(viewer, page.id, true);
  expect(again).toMatchObject({ following: true, includeChildren: true });
  expect((await pageFollowState(r, viewer, page.id)).includeChildren).toBe(true);
  const settings = await listPageFollows(r, viewer);
  expect(settings.timezone).toBe("Asia/Kolkata");
  expect(settings.follows).toEqual(expect.arrayContaining([expect.objectContaining({ pageId: page.id, title: "P-100 follow target", includeChildren: true, frequency: "daily" })]));
  const audit = JSON.stringify((await db.query("SELECT after_value FROM hs_audit WHERE action LIKE 'page-follow.%' AND page_id=$1", [page.id])).rows);
  expect(audit).not.toContain("P-100 follow target");
  expect(child.id).not.toBe(page.id);
});

it("sends one IST digest for meaningful edits and a publish, and skips whitespace", async () => {
  const title = "Operations handbook";
  const secret = "SECRET_PARAGRAPH_BODY";
  const note = "SECRET_NOTE_SCOPE";
  const ids = { heading: crypto.randomUUID(), paragraph: crypto.randomUUID(), extra: crypto.randomUUID() };
  const page = await makePage(title);
  const quiet = await makePage("Whitespace Only Secret Title");
  const quietIds = { heading: crypto.randomUUID(), paragraph: crypto.randomUUID() };
  await save(editor, page.id, document(ids, "Scope", "One"));
  await save(editor, quiet.id, document(quietIds, "Quiet", "Same"));
  await follow(viewer, page.id);
  await follow(viewer, quiet.id);
  await save(editor, page.id, document(ids, "Scope", `Two ${secret}`));
  await save(editor, page.id, document(ids, "Scope", `Two ${secret}   `));
  await save(editor, page.id, document(ids, "Scope updated", `Two ${secret}`));
  await save(editor, page.id, document(ids, "Scope updated", `Two ${secret}`, "Added block"));
  await save(editor, quiet.id, document(quietIds, "Quiet", "Same   "));
  const earlyRun = await runPageFollowDigests(r, early);
  expect(earlyRun.deferred).toBe(true);
  await publish(page.id, `handbook-${page.id.slice(0, 8)}`, note);
  const immediate = await mail(viewer.id, "publish");
  expect(immediate).toHaveLength(1);
  expect(immediate[0].subject).toBe("A page you follow was published");
  expect(immediate[0].body).toContain(title);
  expect(immediate[0].body).toContain(`Change note: ${note}`);
  expect(immediate[0].body).toContain("IST");
  expect(immediate[0].body).not.toContain(secret);
  expect((await mail(owner.id, "publish")).filter(row => row.body.includes(page.id))).toHaveLength(0);
  const sent = await runPageFollowDigests(r, monday);
  expect(sent.deferred).toBe(false);
  const digest = await mail(viewer.id, "digest");
  const body = digest.map(row => row.body).join("\n");
  expect(digest).toHaveLength(1);
  expect(digest[0].subject).toBe("Page changes");
  expect(body).toContain(title);
  expect(body).toContain("U-ED");
  expect(body).toContain("IST");
  expect(body).toContain("3 edits");
  expect(body).toContain("+1 / -0 blocks");
  expect(body).toContain("Headings changed: Scope updated");
  expect(body).toContain(`Published: ${note}`);
  expect(body).not.toContain(secret);
  expect(body).not.toContain("Whitespace Only Secret Title");
  const followAudit = JSON.stringify((await db.query("SELECT after_value FROM hs_audit WHERE action LIKE 'page-follow.%' AND (page_id=$1 OR page_id IS NULL)", [page.id])).rows);
  expect(followAudit).not.toContain(secret);
  expect(followAudit).not.toContain(note);
});

it("notifies followers immediately and keeps authors following", async () => {
  const page = await makePage("Published runbook");
  await follow(viewer, page.id);
  await publish(page.id, `runbook-${page.id.slice(0, 8)}`, "Ship the runbook");
  expect((await pageFollowState(r, owner, page.id)).following).toBe(true);
  const note = await db.query<{ summary: string }>("SELECT summary FROM hs_notifications WHERE recipient_id=$1 AND page_id=$2 AND kind='page-publish'", [viewer.id, page.id]);
  expect(note.rows[0].summary).toContain("Ship the runbook");
  expect(note.rows[0].summary).not.toContain("Published runbook");
  const second = await changePublishedPage(r, owner, page.id, { action: "publish", operationId: crypto.randomUUID(), slug: "ignored", note: "nope", freezeValues: false }).catch(error => error);
  expect(second).toMatchObject({ status: 409 });
  expect((await mail(viewer.id, "publish")).filter(row => row.body.includes(page.id))).toHaveLength(1);
});

it("changes frequency and unsubscribes from a signed link without naming the page", async () => {
  const ids: string[] = [];
  for (let index = 0; index < 10; index += 1) ids.push((await makePage(`Preference page ${index}`)).id);
  for (const id of ids) await follow(viewer, id);
  const weekly = await changeFollowSettings(r, viewer, { action: "frequency", operationId: crypto.randomUUID(), pageId: ids[0], frequency: "weekly" });
  expect(weekly.follows.find(row => row.pageId === ids[0])?.frequency).toBe("weekly");
  await save(editor, ids[0], document({ heading: crypto.randomUUID(), paragraph: crypto.randomUUID() }, "Weekly", "Changed"));
  await runPageFollowDigests(r, tuesday);
  expect((await mail(viewer.id, "digest")).some(row => row.body.includes("Preference page 0"))).toBe(false);
  const token = signPageUnsubscribe(viewer.id, ids[1]);
  const response = await unsubscribeGet(new Request(`http://localhost/follows/unsubscribe?token=${encodeURIComponent(token)}`));
  const text = await response.text();
  expect(response.status).toBe(200);
  expect(text).toContain(UNSUBSCRIBE_PAGE);
  expect(text).not.toContain("Preference page 1");
  expect(text).not.toContain(viewer.id);
  expect((await db.query("SELECT page_id FROM hs_page_follows WHERE user_id=$1 AND page_id=$2", [viewer.id, ids[1]])).rows).toEqual([]);
  const forged = await unsubscribeGet(new Request("http://localhost/follows/unsubscribe?token=not-a-token"));
  expect(forged.status).toBe(response.status);
  expect(await forged.text()).toBe(text);
  await unsubscribeFromToken(r, token);
  expect((await db.query("SELECT page_id FROM hs_page_follows WHERE user_id=$1 AND page_id=$2", [viewer.id, ids[1]])).rows).toEqual([]);
});

it("omits a page and drops the follow when access is gone at send", async () => {
  const title = "SECRET_REVOKED_TITLE";
  const page = await makePage(title);
  await follow(viewer, page.id);
  await save(editor, page.id, document({ heading: crypto.randomUUID(), paragraph: crypto.randomUUID() }, "Visible", "Changed"));
  await revoke(page.id, viewer.id);
  await runPageFollowDigests(r, new Date("2026-12-07T03:30:00.000Z"));
  const bodies = (await mail(viewer.id)).map(row => row.body).join("\n");
  expect(bodies).not.toContain(title);
  expect((await db.query("SELECT page_id FROM hs_page_follows WHERE user_id=$1 AND page_id=$2", [viewer.id, page.id])).rows).toEqual([]);
  const settings = await listPageFollows(r, viewer);
  expect(JSON.stringify(settings)).not.toContain(title);
});

it("drops a built digest item when access is revoked before send", async () => {
  const title = "SECRET_MIDAIR_TITLE";
  const page = await makePage(title);
  await follow(viewer, page.id);
  await save(editor, page.id, document({ heading: crypto.randomUUID(), paragraph: crypto.randomUUID() }, "Midair", "Changed"));
  const seen: string[][] = [];
  await runPageFollowDigests(r, new Date("2026-11-16T03:30:00.000Z"), {
    afterBuild: async draft => {
      if (draft.userId !== viewer.id) return;
      seen.push(draft.pageIds);
      await revoke(page.id, viewer.id);
    },
  });
  expect(seen.some(ids => ids.includes(page.id))).toBe(true);
  expect((await mail(viewer.id)).map(row => row.body).join("\n")).not.toContain(title);
  expect((await db.query("SELECT summary FROM hs_notifications WHERE recipient_id=$1 AND page_id=$2", [viewer.id, page.id])).rows).toEqual([]);
  expect((await db.query("SELECT page_id FROM hs_page_follows WHERE user_id=$1 AND page_id=$2", [viewer.id, page.id])).rows).toEqual([]);
});

it("says a followed page was removed without its title for someone who cannot restore it", async () => {
  const title = "SECRET_TRASHED_TITLE";
  const page = await makePage(title);
  await follow(viewer, page.id);
  await save(editor, page.id, document({ heading: crypto.randomUUID(), paragraph: crypto.randomUUID() }, "Gone", "Changed"));
  await trash(page.id);
  await runPageFollowDigests(r, new Date("2026-11-23T03:30:00.000Z"));
  const viewerMail = (await mail(viewer.id, "digest")).map(row => row.body).join("\n");
  const ownerMail = (await mail(owner.id, "digest")).map(row => row.body).join("\n");
  expect(viewerMail).toContain(REMOVED_FOLLOW);
  expect(viewerMail).not.toContain(title);
  expect(ownerMail).toContain(title);
  const viewerInbox = await inbox(r, viewer);
  const item = viewerInbox.notifications.find(entry => entry.pageId === page.id);
  expect(item?.pageTitle).toBe(REMOVED_FOLLOW);
  expect(JSON.stringify(item)).not.toContain(title);
  const ownerInbox = await inbox(r, owner);
  expect(ownerInbox.notifications.find(entry => entry.pageId === page.id)?.pageTitle).toBe(title);
});

it("includes a changed child when the follow covers the tree", async () => {
  const parent = await makePage("Parent handbook");
  const child = await makePage("CHILD_PAGE_TITLE", parent.id);
  await follow(viewer, parent.id, true);
  const only = await makePage("Sibling not followed");
  const nested = await makePage("NESTED_SECRET_TITLE", only.id);
  await follow(viewer, only.id, false);
  await save(editor, child.id, document({ heading: crypto.randomUUID(), paragraph: crypto.randomUUID() }, "Child", "Updated"));
  await save(editor, nested.id, document({ heading: crypto.randomUUID(), paragraph: crypto.randomUUID() }, "Nested", "Updated"));
  await runPageFollowDigests(r, new Date("2026-11-30T03:30:00.000Z"));
  const body = (await mail(viewer.id, "digest")).map(row => row.body).join("\n");
  expect(body).toContain("CHILD_PAGE_TITLE");
  expect(body).not.toContain("NESTED_SECRET_TITLE");
});

it("uses the follower timezone and still prints edit times in IST", async () => {
  const page = await makePage("New York handbook");
  await db.query("UPDATE hs_users SET timezone='America/New_York' WHERE id=$1", [ny.id]);
  await db.query("INSERT INTO hs_grants(page_id,subject,role) VALUES($1,$2,'viewer')", [page.id, ny.id]);
  await follow(ny, page.id);
  await save(editor, page.id, document({ heading: crypto.randomUUID(), paragraph: crypto.randomUUID() }, "Hours", "Updated"));
  await runPageFollowDigests(r, monday);
  expect((await mail(ny.id)).map(row => row.body).join("\n")).not.toContain("New York handbook");
  await runPageFollowDigests(r, newYorkMorning);
  const body = (await mail(ny.id, "digest")).map(row => row.body).join("\n");
  expect(body).toContain("New York handbook");
  expect(body).toContain("IST");
});

it("keeps follow audit rows when retention purge deletes the page", async () => {
  const page = await r.create(owner, "Purge follow target", ops);
  await follow(owner, page.id);
  const before = await db.query<{ id: string; action: string }>("SELECT id, action FROM hs_audit WHERE page_id=$1 AND action LIKE 'page-follow.%' ORDER BY action, id", [page.id]);
  expect(before.rows.map(row => row.action)).toEqual(expect.arrayContaining(["page-follow.auto", "page-follow.follow"]));
  await db.query("DELETE FROM hs_blocks WHERE page_id=$1", [page.id]);
  await db.query("DELETE FROM hs_revisions WHERE page_id=$1", [page.id]);
  await db.query("DELETE FROM hs_pages WHERE id=$1", [page.id]);
  const after = await db.query<{ id: string; action: string; page_id: string | null }>("SELECT id, action, page_id FROM hs_audit WHERE id = ANY($1::uuid[]) ORDER BY action, id", [before.rows.map(row => row.id)]);
  expect(after.rows.map(row => row.action)).toEqual(before.rows.map(row => row.action));
  expect(after.rows.every(row => row.page_id === null)).toBe(true);
  await expect(db.query("UPDATE hs_audit SET action='page-follow.tamper' WHERE id=$1", [before.rows[0].id])).rejects.toThrow(/append-only/i);
  await expect(db.query("DELETE FROM hs_audit WHERE id=$1", [before.rows[0].id])).rejects.toThrow(/append-only/i);
});

it("rejects a cross-tenant follow with the same not-found shape as a missing page", async () => {
  const page = await makePage("SECRET_CROSS_TITLE");
  const missingId = crypto.randomUUID();
  const denied = await changePageFollow(r, bolt, page.id, { action: "follow", operationId: crypto.randomUUID(), includeChildren: false }).catch(error => error);
  const missing = await changePageFollow(r, bolt, missingId, { action: "follow", operationId: crypto.randomUUID(), includeChildren: false }).catch(error => error);
  expect(denied).toMatchObject({ status: 404, code: "not_found", message: missing.message });
  expect(denied.message).toBe(PAGE_HIDDEN);
  expect(JSON.stringify(denied)).not.toContain("SECRET_CROSS_TITLE");
  expect((await db.query("SELECT page_id FROM hs_page_follows WHERE user_id=$1 AND page_id=$2", [bolt.id, page.id])).rows).toEqual([]);
  const request = (id: string, method = "GET", body?: unknown) => new Request(`http://localhost/api/v1/pages/${id}/follow`, { method, headers: { host: "localhost", origin: "http://localhost", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const boltPage = await r.create(bolt, "BOLT_SECRET_TITLE", boltOps);
  const deniedResponse = await followGet(request(boltPage.id), { params: Promise.resolve({ id: boltPage.id }) });
  const missingResponse = await followGet(request(missingId), { params: Promise.resolve({ id: missingId }) });
  expect(deniedResponse.status).toBe(missingResponse.status);
  expect(await deniedResponse.json()).toEqual(await missingResponse.json());
  const postDenied = await followPost(request(boltPage.id, "POST", { action: "follow", operationId: crypto.randomUUID(), includeChildren: false }), { params: Promise.resolve({ id: boltPage.id }) });
  const postMissing = await followPost(request(missingId, "POST", { action: "follow", operationId: crypto.randomUUID(), includeChildren: false }), { params: Promise.resolve({ id: missingId }) });
  const postDeniedBody = await postDenied.json();
  expect(postDenied.status).toBe(404);
  expect(postDeniedBody).toEqual(await postMissing.json());
  expect(JSON.stringify(postDeniedBody)).not.toContain("BOLT_SECRET_TITLE");
  const settings = await settingsGet(new Request("http://localhost/api/v1/follows", { headers: { host: "localhost", origin: "http://localhost" } }));
  expect(settings.status).toBe(200);
  expect(JSON.stringify(await settings.json())).not.toContain("BOLT_SECRET_TITLE");
});
