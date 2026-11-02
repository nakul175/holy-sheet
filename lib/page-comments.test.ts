import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { EditorState, type Transaction } from "@tiptap/pm/state";
import { localActor, type Actor } from "./auth";
import { createDatabase, type Database } from "./database";
import { ensureIds, type RichNode } from "./document";
import { changeDiscussion, discussions } from "./discussions";
import { beginCollaboration, submitCollaboration } from "./collaboration";
import { readNotification } from "./notifications";
import { readRecordBacklinks, type MentionList } from "./record-backlinks";
import { Repository } from "./repository";
import { richSchema } from "./rich-schema";
import { changeSharing } from "./sharing";

const state = vi.hoisted(() => ({ repo: null as Repository | null }));
vi.mock("./auth", async () => {
  const actual = await vi.importActual<typeof import("./auth")>("./auth");
  return { ...actual, localPreview: () => true };
});
vi.mock("./repository", async () => {
  const actual = await vi.importActual<typeof import("./repository")>("./repository");
  return { ...actual, repository: async () => { if (!state.repo) throw new Error("repository unavailable"); return state.repo; } };
});
import { GET, POST } from "../app/api/v1/pages/[id]/discussions/route";

let db: Database;
let r: Repository;
const owner = localActor;
const editor: Actor = { id: "n44-editor" };
const viewer: Actor = { id: "n44-viewer" };
const outsider: Actor = { id: "n44-outsider" };
const bolt: Actor = { id: "n44-bolt" };
let tenant = "";
let record = "";
let foreignRecord = "";

beforeAll(async () => {
  db = await createDatabase(":memory:");
  r = new Repository(db);
  state.repo = r;
  await r.seedLocal();
  for (const user of [[editor, "Editor"], [viewer, "Viewer"], [outsider, "Outsider"], [bolt, "Bolt"]] as const) {
    await db.query("INSERT INTO hs_users(id,name) VALUES($1,$2)", [user[0].id, user[1]]);
  }
  await db.query("INSERT INTO hs_members(workspace_id,user_id) VALUES('ws-aplyd',$1),('ws-aplyd',$2),('ws-aplyd',$3)", [editor.id, viewer.id, outsider.id]);
  await db.query("INSERT INTO hs_workspaces(id,name) VALUES('ws-bolt','Bolt')");
  await db.query("INSERT INTO hs_members(workspace_id,user_id) VALUES('ws-bolt',$1)", [bolt.id]);
  tenant = crypto.randomUUID();
  const boltTenant = crypto.randomUUID();
  await db.query("INSERT INTO hs_data_tenants(id,name) VALUES($1,'Acme'),($2,'Bolt')", [tenant, boltTenant]);
  await db.query("INSERT INTO hs_data_workspaces(workspace_id,tenant_id,review_reference) VALUES('ws-aplyd',$1,'acme'),('ws-bolt',$2,'bolt')", [tenant, boltTenant]);
  await db.query("INSERT INTO hs_data_collections(tenant_id,id,name,core) VALUES($1,'organisations','Clients',true),($2,'organisations','Clients',true)", [tenant, boltTenant]);
  await db.query("INSERT INTO hs_data_collection_grants(tenant_id,user_id,collection,capabilities) VALUES($1,$2,'organisations',ARRAY['view','create']),($1,$3,'organisations',ARRAY['view'])", [tenant, owner.id, editor.id]);
  record = crypto.randomUUID();
  foreignRecord = crypto.randomUUID();
  await db.query("INSERT INTO hs_data_records(id,tenant_id,collection,name,created_by,updated_by) VALUES($1,$2,'organisations','R-100',$3,$3),($4,$5,'organisations','R-900',$6,$6)", [record, tenant, owner.id, foreignRecord, boltTenant, bolt.id]);
}, 30000);

afterAll(async () => { await db.close(); });

async function page(title = "P-100") {
  const made = await r.create(owner, title, "space-product");
  const blockId = crypto.randomUUID();
  const document = ensureIds({ type: "doc", content: [{ type: "paragraph", attrs: { id: blockId }, content: [{ type: "text", text: "aaa XXX bbb" }] }] });
  const saved = await r.save(made.id, owner, { operationId: crypto.randomUUID(), baseVersion: made.version, title, document });
  for (const [id, role] of [[editor.id, "editor"], [viewer.id, "viewer"]] as const) await db.query("INSERT INTO hs_grants(page_id,subject,role) VALUES($1,$2,$3)", [saved.page.id, id, role]);
  return { ...saved.page, blockId };
}

function stepsFrom(document: RichNode, edit: (state: EditorState) => Transaction) {
  const schema = richSchema();
  const state = EditorState.create({ schema, doc: schema.nodeFromJSON(document) });
  return edit(state).steps.map(step => step.toJSON());
}

it("anchors a selection, remaps it through collaboration steps, and detaches deleted text with the original quote", async () => {
  const made = await page();
  const created = await changeDiscussion(r, editor, made.id, { kind: "create", operationId: crypto.randomUUID(), body: "Please check XXX", mentionIds: [], baseVersion: made.version, anchors: [{ blockId: made.blockId, start: 4, end: 7 }] });
  expect(created.threads.find(thread => thread.id === created.threadId)?.anchors[0]).toMatchObject({ quote: "XXX", status: "attached", start: 4, end: 7 });
  const clientId = crypto.randomUUID();
  const session = await beginCollaboration(r, owner, made.id, clientId);
  const around = stepsFrom(session.document, state => state.tr.delete(1, 2).insertText("Z", state.tr.delete(1, 2).doc.content.size - 1));
  await submitCollaboration(r, owner, made.id, { sessionId: session.sessionId, epoch: session.epoch, clientId, operationId: crypto.randomUUID(), baseStepVersion: 0, steps: around });
  const shifted = (await discussions(r, viewer, made.id)).threads[0].anchors[0];
  expect(shifted).toMatchObject({ quote: "XXX", status: "attached" });
  expect(shifted.start).not.toBe(4);
  const current = await r.get(made.id, owner);
  const live = await beginCollaboration(r, owner, made.id, clientId);
  const remove = stepsFrom(current.document, state => state.tr.delete(1 + shifted.start, 1 + shifted.end));
  await submitCollaboration(r, owner, made.id, { sessionId: live.sessionId, epoch: live.epoch, clientId, operationId: crypto.randomUUID(), baseStepVersion: live.stepVersion, steps: remove });
  expect((await discussions(r, viewer, made.id)).threads[0].anchors[0]).toMatchObject({ quote: "XXX", status: "detached" });
});

it("resolves and reopens with activity and one audit row per operation, without comment text", async () => {
  const made = await page("Activity page");
  const secret = "SECRET_RESOLVE_BODY";
  const created = await changeDiscussion(r, editor, made.id, { kind: "create", operationId: crypto.randomUUID(), body: secret, mentionIds: [], baseVersion: made.version, anchors: [] });
  const resolve = { kind: "resolve" as const, operationId: crypto.randomUUID(), threadId: created.threadId, expectedVersion: created.threads[0].version };
  const resolved = await changeDiscussion(r, editor, made.id, resolve);
  expect((await changeDiscussion(r, editor, made.id, resolve)).replayed).toBe(true);
  const hidden = await discussions(r, viewer, made.id);
  expect(hidden.threads[0].status).toBe("resolved");
  expect(hidden.threads[0].activity[0].label).toMatch(/resolved this discussion · .+ IST$/);
  expect(hidden.threads[0].activity[0].label).not.toContain(secret);
  const audit = await db.query<{ n: number; after_value: unknown }>("SELECT count(*)::integer AS n, max(after_value::text) AS after_value FROM hs_audit WHERE correlation_id=$1", [resolve.operationId]);
  expect(audit.rows[0].n).toBe(1);
  expect(String(audit.rows[0].after_value)).not.toContain(secret);
  const reopened = await changeDiscussion(r, owner, made.id, { kind: "reopen", operationId: crypto.randomUUID(), threadId: created.threadId, expectedVersion: resolved.threads[0].version });
  expect(reopened.threads[0].status).toBe("open");
  expect(reopened.threads[0].activity.some(item => item.kind === "reopened" && item.label.includes("IST"))).toBe(true);
});

it("mentions a readable person, warns when they cannot see the page, and rejects a cross-tenant mention", async () => {
  const made = await page("Mention page");
  const secret = "SECRET_MENTION_BODY";
  const posted = await changeDiscussion(r, editor, made.id, { kind: "create", operationId: crypto.randomUUID(), body: `${secret} @Viewer`, mentionIds: [viewer.id], baseVersion: made.version, anchors: [] });
  expect(posted.mentionWarnings).toEqual([]);
  const mail = await db.query<{ subject: string; body: string }>("SELECT subject, body FROM hs_discussion_email_outbox WHERE recipient_id=$1 AND page_id=$2", [viewer.id, made.id]);
  expect(mail.rows[0]).toMatchObject({ subject: "You were mentioned on a page" });
  expect(mail.rows[0].body.startsWith("You were mentioned on a page\n")).toBe(true);
  expect(mail.rows[0].body).not.toContain(secret);
  expect(mail.rows[0].body).not.toContain("Mention page");
  const blocked = await changeDiscussion(r, editor, made.id, { kind: "reply", operationId: crypto.randomUUID(), threadId: posted.threadId, body: "Hello @Outsider", mentionIds: [outsider.id] });
  expect(blocked.mentionWarnings).toEqual(["Outsider can't see this page — Share?"]);
  const space = await r.createSpace(bolt, "Bolt ops", "ws-bolt");
  const foreignPage = await r.create(bolt, "Bolt page", space.id);
  const foreignId = editor.id;
  const randomId = crypto.randomUUID();
  const rejected = await changeDiscussion(r, bolt, foreignPage.id, { kind: "create", operationId: crypto.randomUUID(), body: "Hello", mentionIds: [foreignId], baseVersion: foreignPage.version, anchors: [] }).catch(error => error);
  const unknown = await changeDiscussion(r, bolt, foreignPage.id, { kind: "create", operationId: crypto.randomUUID(), body: "Hello", mentionIds: [randomId], baseVersion: foreignPage.version, anchors: [] }).catch(error => error);
  expect(rejected).toMatchObject({ status: 422, code: "mention_rejected", message: unknown.message });
  expect(rejected.message).not.toContain("Editor");
  expect((await discussions(r, bolt, foreignPage.id)).threads).toEqual([]);
});

it("renders a live record chip and keeps a comment backlink across a later document save", async () => {
  const made = await page("Record mention");
  const secret = "SECRET_RECORD_COMMENT";
  const token = `@[record:${record}]`;
  const posted = await changeDiscussion(r, editor, made.id, { kind: "create", operationId: crypto.randomUUID(), body: `${secret} ${token}`, mentionIds: [], recordMentionIds: [record], baseVersion: made.version, anchors: [] });
  const chip = posted.threads[0].comments[0].records[0];
  expect(chip).toMatchObject({ id: record, status: "visible", title: "R-100" });
  expect(chip.href).toContain(`record=${record}`);
  const hidden = (await discussions(r, viewer, made.id)).threads[0].comments[0].records[0];
  expect(hidden).toMatchObject({ status: "restricted", title: null, href: null });
  expect(JSON.stringify(hidden)).not.toContain("R-100");
  const links = await readRecordBacklinks(r, editor, record, { workspaceId: "ws-aplyd", tenantId: tenant, sort: "edited", order: "desc", spaceId: null, cursor: null, includeTrash: false, section: "mentions", openPageId: null }) as MentionList;
  const item = links.items.find(entry => entry.pageId === made.id);
  expect(item?.referenceLabel).toBe("Comment");
  expect(item?.href).toContain(`#discussion-${posted.threadId}`);
  expect(item?.snippet).not.toContain(secret);
  const current = await r.get(made.id, owner);
  const withChip = ensureIds({ type: "doc", content: [...(current.document.content ?? []), { type: "recordRef", attrs: { nodeVersion: 1, recordId: record, collectionId: "organisations", display: "chip", fields: [] } }] });
  await r.save(made.id, owner, { operationId: crypto.randomUUID(), baseVersion: current.version, title: current.title, document: withChip });
  const stored = await db.query<{ ref_type: string }>("SELECT ref_type FROM hs_record_backlinks WHERE page_id=$1 AND record_id=$2 ORDER BY ref_type", [made.id, record]);
  expect(stored.rows.map(row => row.ref_type)).toEqual(["chip", "comment"]);
  const other = crypto.randomUUID();
  await expect(changeDiscussion(r, editor, made.id, { kind: "reply", operationId: crypto.randomUUID(), threadId: posted.threadId, body: `Nope @[record:${other}]`, mentionIds: [], recordMentionIds: [other] })).rejects.toMatchObject({ code: "mention_rejected" });
  await expect(changeDiscussion(r, editor, made.id, { kind: "reply", operationId: crypto.randomUUID(), threadId: posted.threadId, body: `Nope @[record:${foreignRecord}]`, mentionIds: [], recordMentionIds: [foreignRecord] })).rejects.toMatchObject({ code: "mention_rejected", message: "A mentioned record is unavailable" });
});

it("returns one generic not-found shape for an unreadable page and a missing page", async () => {
  const made = await page("Hidden title SECRET_PAGE");
  const denied = await discussions(r, outsider, made.id).catch(error => error);
  const missing = await discussions(r, outsider, crypto.randomUUID()).catch(error => error);
  expect(denied).toMatchObject({ status: 404, code: "not_found", message: missing.message });
  expect(JSON.stringify(denied)).not.toContain("SECRET_PAGE");
  const posted = await changeDiscussion(r, outsider, made.id, { kind: "create", operationId: crypto.randomUUID(), body: "nope", mentionIds: [], baseVersion: made.version, anchors: [] }).catch(error => error);
  const postedMissing = await changeDiscussion(r, outsider, crypto.randomUUID(), { kind: "create", operationId: crypto.randomUUID(), body: "nope", mentionIds: [], baseVersion: 1, anchors: [] }).catch(error => error);
  expect(posted).toMatchObject({ status: 404, message: postedMissing.message });
  expect(JSON.stringify(posted)).not.toContain("SECRET_PAGE");
  const hidden = await r.create(editor, "Hidden title SECRET_PAGE", "space-product");
  const request = (id: string, method = "GET", body?: unknown) => new Request(`http://localhost/api/v1/pages/${id}/discussions`, { method, headers: { host: "localhost", origin: "http://localhost", "content-type": "application/json" }, body: body ? JSON.stringify(body) : undefined });
  const missingId = crypto.randomUUID();
  const deniedResponse = await GET(request(hidden.id), { params: Promise.resolve({ id: hidden.id }) });
  const missingResponse = await GET(request(missingId), { params: Promise.resolve({ id: missingId }) });
  expect(deniedResponse.status).toBe(missingResponse.status);
  expect(await deniedResponse.json()).toEqual(await missingResponse.json());
  const again = await GET(request(hidden.id), { params: Promise.resolve({ id: hidden.id }) });
  expect(again.status).toBe(404);
  expect(JSON.stringify(await again.json())).not.toContain("SECRET_PAGE");
  const postDenied = await POST(request(hidden.id, "POST", { kind: "create", operationId: crypto.randomUUID(), body: "nope", mentionIds: [], baseVersion: hidden.version, anchors: [] }), { params: Promise.resolve({ id: hidden.id }) });
  const postMissing = await POST(request(missingId, "POST", { kind: "create", operationId: crypto.randomUUID(), body: "nope", mentionIds: [], baseVersion: 1, anchors: [] }), { params: Promise.resolve({ id: missingId }) });
  expect(postDenied.status).toBe(404);
  expect(await postDenied.json()).toEqual(await postMissing.json());
});

it("rejects a comment after access is revoked and keeps mention mail free of comment text", async () => {
  const made = await page("Revoke page");
  const secret = "SECRET_REVOKE_COMMENT";
  const posted = await changeDiscussion(r, editor, made.id, { kind: "create", operationId: crypto.randomUUID(), body: `${secret} @Viewer`, mentionIds: [viewer.id], baseVersion: made.version, anchors: [] });
  await changeSharing(r, owner, made.id, { operationId: crypto.randomUUID(), expectedVersion: 1, recipientId: viewer.id, role: null });
  await expect(changeDiscussion(r, viewer, made.id, { kind: "reply", operationId: crypto.randomUUID(), threadId: posted.threadId, body: "too late", mentionIds: [] })).rejects.toMatchObject({ status: 404 });
  expect((await db.query("SELECT id FROM hs_comments WHERE body='too late'")).rows).toEqual([]);
  const mail = await db.query<{ body: string }>("SELECT body FROM hs_discussion_email_outbox WHERE page_id=$1 AND recipient_id=$2", [made.id, viewer.id]);
  expect(mail.rows[0].body).not.toContain(secret);
  const note = await db.query<{ id: string }>("SELECT id FROM hs_notifications WHERE page_id=$1 AND recipient_id=$2", [made.id, viewer.id]);
  await expect(readNotification(r, viewer, note.rows[0].id)).rejects.toMatchObject({ status: 404, code: "not_found" });
  await expect(discussions(r, viewer, made.id)).rejects.toMatchObject({ status: 404 });
});
