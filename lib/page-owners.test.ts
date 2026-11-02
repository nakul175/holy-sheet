import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { type Actor } from "./auth";
import { createDatabase, type Database } from "./database";
import { DocumentError, ensureIds, type RichNode } from "./document";
import { inbox } from "./notifications";
import {
  PAGE_HIDDEN,
  PERSON_HIDDEN,
  TRASH_OPT_IN,
  WORKSPACE_HIDDEN,
  changePageOwner,
  handoverPrompt,
  ownerlessPages,
  pageOwner,
  runPageHandover,
  type HandoverJob,
  type HandoverPreview,
} from "./page-owners";
import { Repository } from "./repository";
import { changeWorkspaceMember, previewMemberChange } from "./workspace-administration";

const state = vi.hoisted(() => ({ repo: null as Repository | null, actor: null as Actor | null }));
vi.mock("./auth", async () => {
  const actual = await vi.importActual<typeof import("./auth")>("./auth");
  const { DocumentError } = await import("./document");
  return {
    ...actual,
    api: async (request: Request, fn: (actor: Actor) => Promise<unknown>, mutation = false) => {
      try {
        if (mutation) actual.sameOrigin(request);
        if (!state.actor) throw new Error("actor unavailable");
        const result = await fn(state.actor);
        if (result instanceof Response) return result;
        return Response.json(result, { headers: { "Cache-Control": "no-store", Vary: "Cookie, Authorization" } });
      } catch (error) {
        if (error instanceof DocumentError) return Response.json({ error: error.message, code: error.code, retryable: error.status >= 500 }, { status: error.status, headers: { "Cache-Control": "no-store" } });
        return Response.json({ error: "Service temporarily unavailable", code: "service_unavailable", retryable: true }, { status: 503, headers: { "Cache-Control": "no-store" } });
      }
    },
  };
});
vi.mock("./repository", async () => {
  const actual = await vi.importActual<typeof import("./repository")>("./repository");
  return { ...actual, repository: async () => { if (!state.repo) throw new Error("repository unavailable"); return state.repo; } };
});
import { GET as ownerGet, POST as ownerPost } from "../app/api/v1/pages/[id]/owner/route";
import { POST as handoverPost } from "../app/api/v1/workspaces/[id]/page-handover/route";

let db: Database;
let r: Repository;
const admin: Actor = { id: "n46-admin", name: "U-ADM" };
const editor: Actor = { id: "n46-editor", name: "U-ED" };
const recipient: Actor = { id: "n46-owner", name: "U-OWN" };
const viewer: Actor = { id: "n46-viewer", name: "U-VI" };
const bolt: Actor = { id: "n46-bolt", name: "U-B" };
const ws = "ws-n46";
const boltWs = "ws-n46-b";
let ops = "";
const secretBody = "SECRET_BODY_SENTENCE";
const secretTitle = "P-100 handbook";

beforeAll(async () => {
  db = await createDatabase(":memory:");
  r = new Repository(db);
  state.repo = r;
  await r.seedLocal();
  for (const user of [admin, editor, recipient, viewer, bolt]) await db.query("INSERT INTO hs_users(id,name) VALUES($1,$2)", [user.id, user.name]);
  await db.query("INSERT INTO hs_workspaces(id,name) VALUES($1,'Acme Health'),($2,'Bolt Logistics')", [ws, boltWs]);
  await db.query(
    "INSERT INTO hs_members(workspace_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'member'),($1,$4,'member'),($1,$5,'member'),($6,$7,'member')",
    [ws, admin.id, editor.id, recipient.id, viewer.id, boltWs, bolt.id],
  );
  ops = (await r.createSpace(admin, "SP-OPS", ws)).id;
  await r.createSpace(bolt, "SP-OPS", boltWs);
}, 30000);

afterAll(async () => { await db.close(); });

function document(text: string): RichNode {
  return ensureIds({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text }] }] });
}

async function makePage(title: string, editors: string[] = [], viewers: string[] = []) {
  const page = await r.create(editor, title, ops);
  await r.save(page.id, editor, { operationId: crypto.randomUUID(), baseVersion: page.version, title, document: document(secretBody) });
  for (const id of editors) await db.query("INSERT INTO hs_grants(page_id,subject,role) VALUES($1,$2,'editor')", [page.id, id]);
  for (const id of viewers) await db.query("INSERT INTO hs_grants(page_id,subject,role) VALUES($1,$2,'viewer')", [page.id, id]);
  return page;
}

async function trash(pageId: string) {
  await db.query("UPDATE hs_pages SET deleted_at=clock_timestamp() WHERE id=$1", [pageId]);
}

async function ownerOf(pageId: string) {
  return (await db.query<{ owner_id: string }>("SELECT owner_id FROM hs_pages WHERE id=$1", [pageId])).rows[0].owner_id;
}

async function deactivate(workspaceId: string, actor: Actor, subjectId: string) {
  const preview = await previewMemberChange(r, actor, workspaceId, { subjectId, role: "member", active: false });
  const operationId = crypto.randomUUID();
  const applied = await changeWorkspaceMember(r, actor, workspaceId, { subjectId, role: "member", active: false, operationId, expectedVersion: preview.version, previewDigest: preview.digest });
  return { ...applied, operationId, preview };
}

function asJob(value: HandoverPreview | HandoverJob): HandoverJob {
  if (!("jobId" in value)) throw new Error("expected handover job");
  return value;
}

async function preview(fromUserId: string, toUserId: string) {
  const result = await runPageHandover(r, admin, ws, { action: "preview", fromUserId, toUserId });
  if ("jobId" in result) throw new Error("expected preview");
  return result;
}

function choices(view: HandoverPreview, includeTrashed: boolean, flagged: "grant" | "skip" = "skip") {
  const rows = includeTrashed ? [...view.pages, ...view.trashed] : view.pages;
  return rows.map(row => ({ pageId: row.pageId, decision: row.recipientCanEdit ? "transfer" as const : flagged }));
}

async function caught(run: () => Promise<unknown>) {
  try {
    await run();
    return null;
  } catch (error) {
    return error;
  }
}

function request(path: string, body?: unknown) {
  return new Request(`http://localhost${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { host: "localhost", origin: "http://localhost", "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function httpShape(response: Response) {
  return { status: response.status, cache: response.headers.get("cache-control"), type: response.headers.get("content-type"), json: await response.json() };
}

it("shows the owner and lets the owner or an admin change it to a member who can edit", async () => {
  const page = await makePage(secretTitle, [recipient.id], [viewer.id]);
  const shown = await pageOwner(r, viewer, page.id);
  expect(shown.owner).toEqual({ id: editor.id, name: "U-ED", avatar: "U" });
  expect(shown.canChange).toBe(false);
  expect(shown.candidates).toBeUndefined();
  expect(JSON.stringify(shown)).not.toContain(secretBody);

  const operationId = crypto.randomUUID();
  const changed = await changePageOwner(r, editor, page.id, { operationId, ownerId: recipient.id });
  expect(changed.replayed).toBe(false);
  expect(changed.owner.id).toBe(recipient.id);
  expect(changed.atIst).toContain("IST");
  const replayed = await changePageOwner(r, editor, page.id, { operationId, ownerId: recipient.id });
  expect(replayed.replayed).toBe(true);
  expect(await ownerOf(page.id)).toBe(recipient.id);
  const audit = JSON.stringify((await db.query("SELECT action, after_value, actor_id, correlation_id FROM hs_audit WHERE correlation_id=$1", [operationId])).rows);
  expect(audit).toContain("page-owner.change");
  expect(audit).toContain(editor.id);
  expect(audit).toContain(page.id);
  expect(audit).toContain("IST");
  expect(audit).not.toContain(secretBody);
  expect(audit).not.toContain(secretTitle);
  expect((await db.query("SELECT id FROM hs_audit WHERE correlation_id=$1", [operationId])).rows).toHaveLength(1);

  const next = await makePage("Admin reassignment", [recipient.id], [viewer.id]);
  await changePageOwner(r, admin, next.id, { operationId: crypto.randomUUID(), ownerId: recipient.id });
  expect(await ownerOf(next.id)).toBe(recipient.id);
  await expect(changePageOwner(r, admin, next.id, { operationId: crypto.randomUUID(), ownerId: viewer.id })).rejects.toMatchObject({ status: 422, code: "owner_ineligible" });
  expect(await pageOwner(r, viewer, next.id)).toMatchObject({ owner: { name: "U-OWN" }, canChange: false });
});

it("rejects a non-admin handover and hides foreign workspaces the same way as missing ones", async () => {
  const denied = await caught(() => runPageHandover(r, viewer, ws, { action: "preview", fromUserId: editor.id, toUserId: recipient.id }));
  const editorDenied = await caught(() => runPageHandover(r, editor, ws, { action: "preview", fromUserId: editor.id, toUserId: recipient.id }));
  expect(denied).toMatchObject({ status: 403, code: "admin_required" });
  expect(editorDenied).toMatchObject({ status: 403, code: "admin_required" });
  const foreign = await caught(() => runPageHandover(r, viewer, boltWs, { action: "preview", fromUserId: editor.id, toUserId: recipient.id }));
  const missing = await caught(() => runPageHandover(r, viewer, crypto.randomUUID(), { action: "preview", fromUserId: editor.id, toUserId: recipient.id }));
  expect(foreign).toMatchObject({ status: 404, code: "not_found", message: WORKSPACE_HIDDEN });
  expect(foreign).toMatchObject({ message: (missing as DocumentError).message, code: (missing as DocumentError).code, status: (missing as DocumentError).status });
  expect(JSON.stringify(foreign)).not.toContain("Bolt");
  expect(JSON.stringify(foreign)).not.toContain(secretTitle);

  const page = await makePage("Visible to viewer", [], [viewer.id]);
  const forbidden = await caught(() => changePageOwner(r, viewer, page.id, { operationId: crypto.randomUUID(), ownerId: recipient.id }));
  expect(forbidden).toMatchObject({ status: 403, code: "not_allowed", message: "You cannot change the owner of this page." });
  const boltPage = await r.create(bolt, "BOLT_SECRET_TITLE", (await db.query<{ id: string }>("SELECT id FROM hs_spaces WHERE workspace_id=$1", [boltWs])).rows[0].id);
  const hiddenPage = await caught(() => changePageOwner(r, viewer, boltPage.id, { operationId: crypto.randomUUID(), ownerId: recipient.id }));
  const absentPage = await caught(() => changePageOwner(r, viewer, crypto.randomUUID(), { operationId: crypto.randomUUID(), ownerId: recipient.id }));
  expect(hiddenPage).toMatchObject({ status: 404, code: "not_found", message: PAGE_HIDDEN });
  expect((hiddenPage as DocumentError).message).toBe((absentPage as DocumentError).message);
  expect(JSON.stringify(hiddenPage)).not.toContain("BOLT_SECRET_TITLE");
});

it("rejects a cross-tenant recipient with the same not-found shape as an unknown person", async () => {
  const foreign = await caught(() => runPageHandover(r, admin, ws, { action: "preview", fromUserId: editor.id, toUserId: bolt.id }));
  const missing = await caught(() => runPageHandover(r, admin, ws, { action: "preview", fromUserId: editor.id, toUserId: crypto.randomUUID() }));
  expect(foreign).toMatchObject({ status: 404, code: "not_found", message: PERSON_HIDDEN });
  expect(foreign).toMatchObject({ message: (missing as DocumentError).message, code: (missing as DocumentError).code, status: (missing as DocumentError).status });
  expect(JSON.stringify(foreign)).not.toContain("Bolt");
  expect(JSON.stringify(foreign)).not.toContain("U-B");
  const page = await makePage("Cross tenant owner change", [recipient.id]);
  const foreignOwner = await caught(() => changePageOwner(r, admin, page.id, { operationId: crypto.randomUUID(), ownerId: bolt.id }));
  const missingOwner = await caught(() => changePageOwner(r, admin, page.id, { operationId: crypto.randomUUID(), ownerId: crypto.randomUUID() }));
  expect(foreignOwner).toMatchObject({ status: 404, code: "not_found", message: (missingOwner as DocumentError).message });
  expect(await ownerOf(page.id)).toBe(editor.id);

  state.actor = admin;
  const foreignResponse = await handoverPost(request(`/api/v1/workspaces/${ws}/page-handover`, { action: "preview", fromUserId: editor.id, toUserId: bolt.id }), { params: Promise.resolve({ id: ws }) });
  const missingResponse = await handoverPost(request(`/api/v1/workspaces/${ws}/page-handover`, { action: "preview", fromUserId: editor.id, toUserId: crypto.randomUUID() }), { params: Promise.resolve({ id: ws }) });
  expect(await httpShape(foreignResponse)).toEqual(await httpShape(missingResponse));
  state.actor = viewer;
  const deniedResponse = await handoverPost(request(`/api/v1/workspaces/${ws}/page-handover`, { action: "preview", fromUserId: editor.id, toUserId: recipient.id }), { params: Promise.resolve({ id: ws }) });
  const foreignWorkspace = await handoverPost(request(`/api/v1/workspaces/${boltWs}/page-handover`, { action: "preview", fromUserId: editor.id, toUserId: recipient.id }), { params: Promise.resolve({ id: boltWs }) });
  const missingWorkspace = await handoverPost(request(`/api/v1/workspaces/${crypto.randomUUID()}/page-handover`, { action: "preview", fromUserId: editor.id, toUserId: recipient.id }), { params: Promise.resolve({ id: crypto.randomUUID() }) });
  expect(deniedResponse.status).toBe(403);
  expect(await httpShape(foreignWorkspace)).toEqual(await httpShape(missingWorkspace));
  const visible = await makePage("Route owner target", [recipient.id], [viewer.id]);
  const forbidden = await ownerPost(request(`/api/v1/pages/${visible.id}/owner`, { operationId: crypto.randomUUID(), ownerId: recipient.id }), { params: Promise.resolve({ id: visible.id }) });
  expect(forbidden.status).toBe(403);
  const hiddenId = crypto.randomUUID();
  const hidden = await ownerGet(request(`/api/v1/pages/${hiddenId}/owner`), { params: Promise.resolve({ id: hiddenId }) });
  const boltSpace = (await db.query<{ id: string }>("SELECT id FROM hs_spaces WHERE workspace_id=$1", [boltWs])).rows[0].id;
  const otherId = (await r.create(bolt, "OTHER_SECRET", boltSpace)).id;
  const other = await ownerGet(request(`/api/v1/pages/${otherId}/owner`), { params: Promise.resolve({ id: otherId }) });
  expect(other.status).toBe(hidden.status);
  const otherBody = await other.json();
  expect(otherBody).toEqual(await hidden.json());
  expect(JSON.stringify(otherBody)).not.toContain("OTHER_SECRET");
});

it("previews access, grants or skips, and resumes a handover exactly once", async () => {
  const source: Actor = { id: "n46-source", name: "U-SRC" };
  await db.query("INSERT INTO hs_users(id,name) VALUES($1,$2)", [source.id, source.name]);
  await db.query("INSERT INTO hs_members(workspace_id,user_id,role) VALUES($1,$2,'member')", [ws, source.id]);
  const ready = await makePage("Ready page", [recipient.id]);
  const blocked = await makePage("Blocked page");
  const third = await makePage("Third page", [recipient.id]);
  await db.query("UPDATE hs_pages SET owner_id=$2 WHERE id=ANY($1::text[])", [[ready.id, blocked.id, third.id], source.id]);
  const view = await preview(source.id, recipient.id);
  expect(view.pages.map(row => row.pageId).sort()).toEqual([ready.id, blocked.id, third.id].sort());
  expect(view.pages.find(row => row.pageId === blocked.id)?.recipientCanEdit).toBe(false);
  expect(view.pages.find(row => row.pageId === ready.id)?.recipientCanEdit).toBe(true);
  expect(JSON.stringify(view)).not.toContain(secretBody);
  const bad = choices(view, false, "grant").map(row => row.pageId === blocked.id ? { ...row, decision: "transfer" as const } : row);
  await expect(runPageHandover(r, admin, ws, {
    action: "start",
    operationId: crypto.randomUUID(),
    fromUserId: source.id,
    toUserId: recipient.id,
    includeTrashed: false,
    decisions: bad,
  })).rejects.toMatchObject({ code: "invalid_handover" });

  const operationId = crypto.randomUUID();
  const decisions = choices(view, false, "grant");
  const started = asJob(await runPageHandover(r, admin, ws, { action: "start", operationId, fromUserId: source.id, toUserId: recipient.id, includeTrashed: false, decisions }, 1));
  expect(started.state).toBe("running");
  expect(started.counts.pending).toBe(2);
  expect(started.counts.transferred + started.counts.granted).toBe(1);
  const replayed = asJob(await runPageHandover(r, admin, ws, { action: "start", operationId, fromUserId: source.id, toUserId: recipient.id, includeTrashed: false, decisions }, 1));
  expect(replayed.replayed).toBe(true);
  expect(replayed.counts).toEqual(started.counts);
  let current = started;
  let resumeOperation = "";
  while (current.state === "running") {
    resumeOperation = crypto.randomUUID();
    current = asJob(await runPageHandover(r, admin, ws, { action: "resume", operationId: resumeOperation, jobId: started.jobId }, 1));
  }
  const again = asJob(await runPageHandover(r, admin, ws, { action: "resume", operationId: resumeOperation, jobId: started.jobId }, 1));
  expect(again.replayed).toBe(true);
  expect(again.counts).toEqual(current.counts);
  expect(current.state).toBe("completed");
  expect(current.counts.pending).toBe(0);
  expect(await ownerOf(ready.id)).toBe(recipient.id);
  expect(await ownerOf(third.id)).toBe(recipient.id);
  expect(await ownerOf(blocked.id)).toBe(recipient.id);
  const selected = [ready, blocked, third];
  expect((await db.query("SELECT role FROM hs_grants WHERE page_id=$1 AND subject=$2", [blocked.id, recipient.id])).rows[0].role).toBe("editor");
  const audit = JSON.stringify((await db.query("SELECT after_value FROM hs_audit WHERE correlation_id=$1 OR (page_id=ANY($2::text[]) AND action LIKE 'page-owner.%')", [operationId, selected.map(page => page.id)])).rows);
  expect(audit).not.toContain(secretBody);
  expect(audit).not.toContain("Ready page");
  expect(audit).toContain("IST");
  const transferredAudits = await db.query("SELECT id FROM hs_audit WHERE page_id=$1 AND action='page-owner.handover' AND after_value->>'disposition'='transferred'", [ready.id]);
  expect(transferredAudits.rows).toHaveLength(1);
});

it("fails closed when the recipient is removed during handover", async () => {
  const source: Actor = { id: "n46-revoke-source", name: "U-REV" };
  await db.query("INSERT INTO hs_users(id,name) VALUES($1,$2)", [source.id, source.name]);
  await db.query("INSERT INTO hs_members(workspace_id,user_id,role) VALUES($1,$2,'member')", [ws, source.id]);
  const first = await makePage("Revoke one", [recipient.id]);
  const second = await makePage("Revoke two", [recipient.id]);
  const third = await makePage("Revoke three", [recipient.id]);
  const ids = [first.id, second.id, third.id];
  await db.query("UPDATE hs_pages SET owner_id=$2 WHERE id=ANY($1::text[])", [ids, source.id]);
  const view = await preview(source.id, recipient.id);
  const decisions = choices(view, false);
  const started = asJob(await runPageHandover(r, admin, ws, { action: "start", operationId: crypto.randomUUID(), fromUserId: source.id, toUserId: recipient.id, includeTrashed: false, decisions }, 1));
  await deactivate(ws, admin, recipient.id);
  const finished = asJob(await runPageHandover(r, admin, ws, { action: "resume", operationId: crypto.randomUUID(), jobId: started.jobId }, 10));
  expect(finished.state).toBe("completed");
  expect(finished.items.filter(item => ids.includes(item.pageId) && item.disposition === "failed").every(item => item.code === "recipient_revoked")).toBe(true);
  const moved = finished.items.filter(item => ids.includes(item.pageId) && item.disposition === "transferred");
  const held = finished.items.filter(item => ids.includes(item.pageId) && item.disposition === "failed");
  expect(moved).toHaveLength(1);
  expect(held).toHaveLength(2);
  expect(await ownerOf(moved[0].pageId)).toBe(recipient.id);
  for (const item of held) expect(await ownerOf(item.pageId)).toBe(source.id);
  await db.query("UPDATE hs_members SET active=true WHERE workspace_id=$1 AND user_id=$2", [ws, recipient.id]);
});

it("transfers trashed pages only when the admin includes trash", async () => {
  const source: Actor = { id: "n46-trash-source", name: "U-TRASH" };
  await db.query("INSERT INTO hs_users(id,name) VALUES($1,$2)", [source.id, source.name]);
  await db.query("INSERT INTO hs_members(workspace_id,user_id,role) VALUES($1,$2,'member')", [ws, source.id]);
  const live = await makePage("Live handover", [recipient.id]);
  const trashed = await makePage("Trashed handover", [recipient.id]);
  await db.query("UPDATE hs_pages SET owner_id=$2 WHERE id=ANY($1::text[])", [[live.id, trashed.id], source.id]);
  await trash(trashed.id);
  const view = await preview(source.id, recipient.id);
  expect(view.pages.some(row => row.pageId === trashed.id)).toBe(false);
  expect(view.trashed.find(row => row.pageId === trashed.id)?.title).toBe("Trashed handover");
  expect(view.pages.find(row => row.pageId === live.id)?.recipientCanEdit).toBe(true);
  await expect(runPageHandover(r, admin, ws, {
    action: "start",
    operationId: crypto.randomUUID(),
    fromUserId: source.id,
    toUserId: recipient.id,
    includeTrashed: false,
    decisions: [{ pageId: live.id, decision: "transfer" }, { pageId: trashed.id, decision: "transfer" }],
  })).rejects.toMatchObject({ message: TRASH_OPT_IN });
  const without = asJob(await runPageHandover(r, admin, ws, {
    action: "start",
    operationId: crypto.randomUUID(),
    fromUserId: source.id,
    toUserId: recipient.id,
    includeTrashed: false,
    decisions: [{ pageId: live.id, decision: "transfer" }],
  }, 10));
  expect(without.items.map(item => item.pageId)).toEqual([live.id]);
  expect(await ownerOf(live.id)).toBe(recipient.id);
  expect(await ownerOf(trashed.id)).toBe(source.id);
  const opted = asJob(await runPageHandover(r, admin, ws, {
    action: "start",
    operationId: crypto.randomUUID(),
    fromUserId: source.id,
    toUserId: recipient.id,
    includeTrashed: true,
    decisions: [{ pageId: trashed.id, decision: "transfer" }],
  }, 10));
  expect(opted.items[0]).toMatchObject({ pageId: trashed.id, trashed: true, disposition: "transferred" });
  expect(await ownerOf(trashed.id)).toBe(recipient.id);
});

it("notifies admins when a page owner is deactivated and assigns ownerless pages in bulk", async () => {
  const leaveWs = "ws-n46-leave";
  const leaver: Actor = { id: "n46-leaver", name: "U-ED" };
  const keeper: Actor = { id: "n46-keeper", name: "U-OWN" };
  await db.query("INSERT INTO hs_users(id,name) VALUES($1,$2),($3,$4)", [leaver.id, leaver.name, keeper.id, keeper.name]);
  await db.query("INSERT INTO hs_workspaces(id,name) VALUES($1,'Leave workspace')", [leaveWs]);
  await db.query("INSERT INTO hs_members(workspace_id,user_id,role) VALUES($1,$2,'admin'),($1,$3,'member'),($1,$4,'member')", [leaveWs, admin.id, leaver.id, keeper.id]);
  const space = (await r.createSpace(admin, "SP-OPS", leaveWs)).id;
  const first = await r.create(leaver, "Orphan one", space);
  const second = await r.create(leaver, "Orphan two", space);
  const trashed = await r.create(leaver, "Orphan trash", space);
  await db.query("UPDATE hs_pages SET deleted_at=clock_timestamp() WHERE id=$1", [trashed.id]);
  const leaving = await deactivate(leaveWs, admin, leaver.id);
  expect(leaving.preview.warning).toContain(handoverPrompt("U-ED", 3));
  const prompt = "U-ED owned 3 pages — start handover";
  const notes = await db.query<{ summary: string; recipient_id: string }>("SELECT summary, recipient_id FROM hs_notifications WHERE kind='page-handover' AND summary=$1", [prompt]);
  expect(notes.rows).toEqual([{ summary: prompt, recipient_id: admin.id }]);
  const replay = await changeWorkspaceMember(r, admin, leaveWs, { subjectId: leaver.id, role: "member", active: false, operationId: leaving.operationId, expectedVersion: leaving.preview.version, previewDigest: leaving.preview.digest });
  expect(replay.replayed).toBe(true);
  expect((await db.query("SELECT id FROM hs_notifications WHERE kind='page-handover' AND summary=$1", [prompt])).rows).toHaveLength(1);
  const seen = await inbox(r, admin);
  expect(seen.notifications.some(item => item.body === prompt && item.atIst?.includes("IST") && item.href === `/workspaces/${leaveWs}/handover`)).toBe(true);
  expect((await inbox(r, leaver)).notifications.some(item => item.kind === "page-handover")).toBe(false);
  const leaverAudit = JSON.stringify((await db.query("SELECT after_value FROM hs_audit WHERE action='page-owner.leaver' AND correlation_id=$1", [leaving.operationId])).rows);
  expect(leaverAudit).toContain(first.id);
  expect(leaverAudit).not.toContain("Orphan one");
  expect(leaverAudit).not.toContain(secretBody);

  const report = await ownerlessPages(r, admin, leaveWs);
  expect(report.pages.map(row => row.title).sort()).toEqual(["Orphan one", "Orphan two"]);
  expect(report.trashed.map(row => row.title)).toEqual(["Orphan trash"]);
  await expect(ownerlessPages(r, keeper, leaveWs)).rejects.toMatchObject({ status: 403, code: "admin_required" });
  const checked = await runPageHandover(r, admin, leaveWs, { action: "preview-ownerless", toUserId: keeper.id });
  if ("jobId" in checked) throw new Error("expected ownerless preview");
  expect(checked.pages.every(row => row.recipientCanEdit === false)).toBe(true);
  const assigned = asJob(await runPageHandover(r, admin, leaveWs, {
    action: "assign",
    operationId: crypto.randomUUID(),
    toUserId: keeper.id,
    includeTrashed: false,
    decisions: checked.pages.map(row => ({ pageId: row.pageId, decision: "grant" as const })),
  }, 10));
  expect(assigned.state).toBe("completed");
  expect(await ownerOf(first.id)).toBe(keeper.id);
  expect(await ownerOf(second.id)).toBe(keeper.id);
  expect(await ownerOf(trashed.id)).toBe(leaver.id);
  expect((await db.query("SELECT role FROM hs_grants WHERE page_id=$1 AND subject=$2", [first.id, keeper.id])).rows[0].role).toBe("editor");
  const after = await ownerlessPages(r, admin, leaveWs);
  expect(after.pages).toEqual([]);
  expect(after.trashed.map(row => row.pageId)).toEqual([trashed.id]);
});
