import { afterAll, beforeAll, expect, it } from "vitest";
import { localActor } from "./auth";
import { createDatabase, type Database } from "./database";
import { ensureIds, type RichNode } from "./document";
import { updatePersonalNavigation } from "./personal-navigation";
import { Repository } from "./repository";
import { SEARCH_JUMP_UNAVAILABLE } from "./search-jump-model";
import { createSearchPage, createSearchRecord, insertSearchReference, jumpSearchHeading, peekSearchRecord, searchCommandPalette } from "./search-jump";
import type { CurrentSuiteTenantAuthority, RecordContext } from "./shared-records";

let db: Database;
let r: Repository;
const owner = localActor;
const editor = { id: "holy86-editor", name: "Editor" };
const outsider = { id: "holy86-out", name: "Outside" };
const observer = { id: "holy86-view", name: "Viewer" };
const other = { id: "holy86-bolt", name: "Bolt" };
const ws = "ws-aplyd";
let tenant = "";
let otherTenant = "";
const authority: CurrentSuiteTenantAuthority = { verify: async (ctx: RecordContext) => ({ subject: ctx.actor.id, tenantId: ctx.tenantId, workspaceId: ctx.workspaceId, active: true, tenantAdministrator: false, revision: "holy86-authority" }) };

beforeAll(async () => {
  db = await createDatabase(":memory:");
  r = new Repository(db);
  await r.seedLocal();
  for (const user of [editor, outsider, observer, other]) await db.query("INSERT INTO hs_users(id,name) VALUES($1,$2)", [user.id, user.name]);
  await db.query("INSERT INTO hs_members(workspace_id,user_id,role) VALUES($1,$2,'member'),($1,$3,'member'),($1,$4,'observer')", [ws, editor.id, outsider.id, observer.id]);
  await db.query("INSERT INTO hs_workspaces(id,name) VALUES('ws-b','Bolt')");
  await db.query("INSERT INTO hs_spaces(id,workspace_id,name) VALUES('space-b','ws-b','Ops')");
  await db.query("INSERT INTO hs_members(workspace_id,user_id,role) VALUES('ws-b',$1,'member')", [other.id]);
  tenant = crypto.randomUUID();
  otherTenant = crypto.randomUUID();
  await db.query("INSERT INTO hs_data_tenants(id,name) VALUES($1,'Acme'),($2,'Bolt secret tenant')", [tenant, otherTenant]);
  await db.query("INSERT INTO hs_data_workspaces(workspace_id,tenant_id,review_reference) VALUES($1,$2,'acme'),('ws-b',$3,'bolt')", [ws, tenant, otherTenant]);
  for (const [id, name] of [["organisations", "Organisations"], ["contacts", "Contacts"]] as const) {
    await db.query("INSERT INTO hs_data_collections(tenant_id,id,name,core) VALUES($1,$2,$3,true),($4,$2,$3,true)", [tenant, id, name, otherTenant]);
  }
  await db.query("INSERT INTO hs_data_collection_grants(tenant_id,user_id,collection,capabilities) VALUES($1,$2,'organisations',ARRAY['view','create']),($1,$3,'organisations',ARRAY['view','create'])", [tenant, owner.id, editor.id]);
});
afterAll(() => db.close());

const shape = (error: unknown) => {
  const failed = error as { status?: number; code?: string; message?: string; details?: unknown };
  return { status: failed.status, code: failed.code, message: failed.message, details: failed.details ?? null };
};
async function fails(run: () => Promise<unknown>) {
  try { await run(); } catch (error) { return shape(error); }
  throw new Error("expected a refusal");
}
async function record(name: string, tenantId = tenant, actor = owner.id) {
  const id = crypto.randomUUID();
  await db.query("INSERT INTO hs_data_records(id,tenant_id,collection,name,created_by,updated_by) VALUES($1,$2,'organisations',$3,$4,$4)", [id, tenantId, name, actor]);
  return id;
}
async function headings(title: string) {
  const page = await r.create(owner, title, "space-product");
  const document = ensureIds({ type: "doc", content: [
    { type: "heading", attrs: { level: 1 }, content: [{ type: "text", text: "Setup" }] },
    { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Accounts" }] },
    { type: "details", content: [{ type: "detailsSummary", content: [{ type: "text", text: "Fold" }] }, { type: "detailsContent", content: [{ type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Escalation" }] }] }] },
  ] } as RichNode);
  await r.save(page.id, owner, { operationId: crypto.randomUUID(), baseVersion: page.version, title, document });
  return { page, document };
}
function insertBody(recordId: string, operationId = crypto.randomUUID(), extra: Record<string, unknown> = {}) {
  return { operationId, record_id: recordId, display: "card", ...extra };
}

it("lists headings after > and opens the matching block fragment", async () => {
  const secret = await headings("Secret runbook");
  const visible = await headings("Client runbook");
  await db.query("INSERT INTO hs_grants(page_id,subject,role) VALUES($1,$2,'editor')", [visible.page.id, editor.id]);
  const found = await searchCommandPalette(r, editor, ws, { query: "runbook > esc" });
  expect(found.headings.map(item => item.text)).toEqual(["Escalation"]);
  expect(found.headings[0].href).toBe(`/pages/${encodeURIComponent(visible.page.id)}#block-${encodeURIComponent(found.headings[0].blockId)}`);
  expect(JSON.stringify(found)).not.toContain(secret.page.id);
  expect(JSON.stringify(found)).not.toContain("Secret runbook");
  const jump = await jumpSearchHeading(r, editor, ws, visible.page.id, found.headings[0].blockId);
  expect(jump.href).toContain(`#block-${found.headings[0].blockId}`);
  await db.query("UPDATE hs_pages SET deleted_at=now() WHERE id=$1", [visible.page.id]);
  expect(await fails(() => jumpSearchHeading(r, editor, ws, visible.page.id, found.headings[0].blockId))).toEqual({ status: 404, code: "not_found", message: SEARCH_JUMP_UNAVAILABLE, details: null });
});

it("inserts a live reference and backlink once, including when save follows a staged insert", async () => {
  const page = await r.create(owner, "Editing page", "space-product");
  const id = await record("Acme Hospital");
  const operationId = crypto.randomUUID();
  const first = await insertSearchReference(r, owner, page.id, insertBody(id, operationId));
  const second = await insertSearchReference(r, owner, page.id, insertBody(id, operationId));
  expect(second.replayed).toBe(true);
  expect(second.blockId).toBe(first.blockId);
  expect((await db.query("SELECT id FROM hs_blocks WHERE page_id=$1 AND type='recordRef'", [page.id])).rows).toHaveLength(1);
  expect((await db.query("SELECT id FROM hs_document_record_links WHERE doc_id=$1 AND record_id=$2", [page.id, id])).rows).toHaveLength(1);
  const stagedPage = await r.create(owner, "Staged page", "space-product");
  const staged = await insertSearchReference(r, owner, stagedPage.id, insertBody(id, crypto.randomUUID(), { stage: true }));
  expect(staged.staged).toBe(true);
  expect((await db.query("SELECT id FROM hs_document_record_links WHERE doc_id=$1", [stagedPage.id])).rows).toHaveLength(0);
  const current = await r.get(stagedPage.id, owner);
  await r.save(stagedPage.id, owner, { operationId: crypto.randomUUID(), baseVersion: current.version, title: current.title, document: { type: "doc", content: [...(current.document.content ?? []), staged.node] } });
  expect((await db.query("SELECT id FROM hs_document_record_links WHERE doc_id=$1 AND record_id=$2", [stagedPage.id, id])).rows).toHaveLength(1);
});

it("creates one page or record for a repeated intent and does not describe a hidden same-title item", async () => {
  const hidden = await r.create(owner, "Vendor offboarding", "space-product");
  await r.save(hidden.id, owner, { operationId: crypto.randomUUID(), baseVersion: hidden.version, title: hidden.title, document: ensureIds({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Hidden vendor token" }] }] }) });
  const offered = await searchCommandPalette(r, editor, ws, { query: "Vendor offboarding" });
  expect(offered.creates.some(item => item.label === 'Create page "Vendor offboarding" in Product')).toBe(true);
  expect(JSON.stringify(offered)).not.toContain(hidden.id);
  expect(JSON.stringify(offered)).not.toContain("Hidden vendor token");
  expect(JSON.stringify(offered).toLowerCase()).not.toMatch(/hidden|already exists/);
  const operationId = crypto.randomUUID();
  const [one, two] = await Promise.all([
    createSearchPage(r, editor, ws, { action: "create-page", operationId, spaceId: "space-product", title: "Vendor offboarding" }),
    createSearchPage(r, editor, ws, { action: "create-page", operationId, spaceId: "space-product", title: "Vendor offboarding" }),
  ]);
  expect(one.pageId).toBe(two.pageId);
  expect(one.title).toBe("Vendor offboarding");
  expect((await db.query("SELECT id FROM hs_pages WHERE title='Vendor offboarding' AND owner_id=$1", [editor.id])).rows).toHaveLength(1);
  const recordOperation = crypto.randomUUID();
  const created = await Promise.all([1, 2].map(() => createSearchRecord(r, editor, authority, ws, { action: "create-record", operationId: recordOperation, collection: "organisations", title: "Vendor offboarding" })));
  expect(created[0].recordId).toBe(created[1].recordId);
  expect(created.filter(item => item.replayed)).toHaveLength(1);
  expect((await db.query("SELECT id FROM hs_data_records WHERE tenant_id=$1 AND name='Vendor offboarding'", [tenant])).rows).toHaveLength(1);
  expect(await searchCommandPalette(r, observer, ws, { query: "Vendor offboarding" })).toMatchObject({ creates: [] });
});

it("shows at most five permitted recents and quick actions, then drops a revoked recent", async () => {
  const pages = [];
  for (let index = 0; index < 6; index += 1) {
    const page = await r.create(owner, `Opened ${index}`, "space-product");
    await db.query("INSERT INTO hs_grants(page_id,subject,role) VALUES($1,$2,'editor')", [page.id, editor.id]);
    await updatePersonalNavigation(r, editor, { action: "opened", pageId: page.id });
    await db.query("UPDATE hs_recents SET opened_at = timestamptz '2026-11-01' + ($3 || ' minutes')::interval WHERE user_id=$1 AND page_id=$2", [editor.id, page.id, String(index)]);
    pages.push(page);
  }
  const open = await searchCommandPalette(r, editor, ws, {});
  expect(open.recents).toHaveLength(5);
  expect(open.recents.map(item => item.id)).not.toContain(pages[0].id);
  expect(open.recents[0].id).toBe(pages[5].id);
  expect(open.quickActions.some(item => item.label.startsWith("New page"))).toBe(true);
  expect(open.quickActions.some(item => item.label === "New record")).toBe(true);
  expect(open.quickActions.some(item => item.label === "Go to space home")).toBe(true);
  await db.query("DELETE FROM hs_grants WHERE page_id=$1 AND subject=$2", [pages[5].id, editor.id]);
  const revoked = await searchCommandPalette(r, editor, ws, {});
  expect(revoked.recents.map(item => item.id)).not.toContain(pages[5].id);
  expect(JSON.stringify(revoked)).not.toContain("Opened 5");
  const viewer = await searchCommandPalette(r, observer, ws, {});
  expect(viewer.quickActions.some(item => item.kind === "new-page" || item.kind === "new-record")).toBe(false);
  expect(viewer.quickActions.some(item => item.label === "Go to space home")).toBe(true);
});

it("rechecks permission, revoke, trash, and cross-tenant inserts without leaking metadata", async () => {
  const page = await r.create(owner, "Open page", "space-product");
  await db.query("INSERT INTO hs_grants(page_id,subject,role) VALUES($1,$2,'editor')", [page.id, outsider.id]);
  const visible = await record("Visible hospital");
  const hidden = await record("Restricted hospital");
  await db.query("DELETE FROM hs_data_collection_grants WHERE tenant_id=$1 AND user_id=$2", [tenant, outsider.id]);
  const denied = await fails(() => insertSearchReference(r, outsider, page.id, insertBody(hidden)));
  expect(denied).toEqual({ status: 404, code: "not_found", message: SEARCH_JUMP_UNAVAILABLE, details: null });
  expect((await db.query("SELECT id FROM hs_document_record_links WHERE record_id=$1", [hidden])).rows).toHaveLength(0);
  expect((await db.query("SELECT id FROM hs_blocks WHERE page_id=$1 AND type='recordRef'", [page.id])).rows).toHaveLength(0);
  const audit = JSON.stringify((await db.query("SELECT after_value FROM hs_audit WHERE action='search-jump.denied' AND actor_id=$1", [outsider.id])).rows);
  expect(audit).toContain(hidden);
  expect(audit).not.toContain("Restricted hospital");
  await db.query("INSERT INTO hs_data_collection_grants(tenant_id,user_id,collection,capabilities) VALUES($1,$2,'organisations',ARRAY['view'])", [tenant, outsider.id]);
  await db.query("DELETE FROM hs_data_collection_grants WHERE tenant_id=$1 AND user_id=$2", [tenant, outsider.id]);
  expect(await fails(() => insertSearchReference(r, outsider, page.id, insertBody(visible)))).toMatchObject({ message: SEARCH_JUMP_UNAVAILABLE });
  expect((await db.query("SELECT id FROM hs_document_record_links WHERE record_id=$1 AND doc_id=$2", [visible, page.id])).rows).toHaveLength(0);
  const trashed = await record("Trashed hospital");
  await db.query("UPDATE hs_data_records SET state='trashed',deleted_at=now(),trash_deadline=now()+interval '30 days',deleted_by=$2,before_trash_state='active' WHERE id=$1", [trashed, owner.id]);
  expect(await fails(() => insertSearchReference(r, owner, page.id, insertBody(trashed)))).toMatchObject({ status: 404, message: SEARCH_JUMP_UNAVAILABLE });
  await db.query("UPDATE hs_pages SET deleted_at=now() WHERE id=$1", [page.id]);
  expect(await fails(() => insertSearchReference(r, owner, page.id, insertBody(visible)))).toMatchObject({ status: 404, message: SEARCH_JUMP_UNAVAILABLE });
  const acmeSecret = await record("Bolt secret hospital");
  const boltPage = await r.create(other, "Bolt page", "space-b");
  const foreignError = await fails(() => insertSearchReference(r, other, boltPage.id, insertBody(acmeSecret)));
  const missingError = await fails(() => insertSearchReference(r, other, boltPage.id, insertBody(crypto.randomUUID())));
  expect(foreignError).toEqual(missingError);
  expect(JSON.stringify(foreignError)).not.toContain("Bolt secret hospital");
  expect(JSON.stringify((await db.query("SELECT after_value FROM hs_audit WHERE actor_id=$1 AND action='search-jump.denied'", [other.id])).rows)).not.toContain("Bolt secret hospital");
  expect((await db.query("SELECT id FROM hs_document_record_links WHERE record_id=$1", [acmeSecret])).rows).toHaveLength(0);
  const peekDenied = await fails(() => peekSearchRecord(r, other, "ws-b", acmeSecret));
  const peekMissing = await fails(() => peekSearchRecord(r, other, "ws-b", crypto.randomUUID()));
  expect(peekDenied).toEqual(peekMissing);
  expect(JSON.stringify(peekDenied)).not.toContain("Bolt secret hospital");
  const boltRecord = await record("Bolt local hospital", otherTenant, other.id);
  await db.query("INSERT INTO hs_data_collection_grants(tenant_id,user_id,collection,capabilities) VALUES($1,$2,'organisations',ARRAY['view'])", [otherTenant, other.id]);
  const peeked = await peekSearchRecord(r, other, "ws-b", boltRecord);
  expect(peeked.title).toBe("Bolt local hospital");
  expect(await fails(() => searchCommandPalette(r, other, ws, { query: "runbook > esc" }))).toMatchObject({ status: 404, message: SEARCH_JUMP_UNAVAILABLE });
});
