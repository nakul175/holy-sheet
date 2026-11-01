import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { createDatabase, type Database } from "./database";
import { DocumentError } from "./document";
import { linkDocumentRecord, listDocumentRecords, listPageRecords, listRecordDocuments, listUnlinkedFiles, registerLinkedFile, unlinkDocumentRecord } from "./document-record-links";
import { Repository } from "./repository";
import { localActor as owner, type Actor } from "./auth";
import { SharedRecordRepository, type RecordContext } from "./shared-records";
import { recordCapabilities } from "./shared-record-types";

let db: Database, pages: Repository, records: SharedRecordRepository, ctx: RecordContext;
const editor: Actor = { id: "document-link-editor" };
const viewer: Actor = { id: "document-link-viewer" };
const bolt: Actor = { id: "document-link-bolt" };
const authority = { verify: async (c: RecordContext) => ({ subject: c.actor.id, tenantId: c.tenantId, workspaceId: c.workspaceId, active: true, tenantAdministrator: c.actor.id === owner.id, revision: "document-link-authority" }) };

beforeAll(async () => {
  db = await createDatabase(":memory:");
  pages = new Repository(db);
  await pages.seedLocal();
  for (const actor of [editor, viewer, bolt]) await db.query("INSERT INTO hs_users(id,name) VALUES($1,$2)", [actor.id, actor.id]);
  records = new SharedRecordRepository(pages, authority);
});
beforeEach(async () => {
  ctx = { actor: owner, tenantId: crypto.randomUUID(), workspaceId: "links-" + crypto.randomUUID() };
  await db.query("INSERT INTO hs_workspaces(id,name) VALUES($1,$1)", [ctx.workspaceId]);
  for (const actor of [owner, editor, viewer]) await db.query("INSERT INTO hs_members(workspace_id,user_id) VALUES($1,$2)", [ctx.workspaceId, actor.id]);
  await db.query("INSERT INTO hs_data_tenants(id,name) VALUES($1,'Acme Health')", [ctx.tenantId]);
  await db.query("INSERT INTO hs_data_workspaces(workspace_id,tenant_id,review_reference) VALUES($1,$2,'synthetic')", [ctx.workspaceId, ctx.tenantId]);
  await db.query("INSERT INTO hs_data_collections(tenant_id,id,name,core) VALUES($1,'organisations','Clients',true)", [ctx.tenantId]);
  await db.query("INSERT INTO hs_data_collection_grants(tenant_id,user_id,collection,capabilities) VALUES($1,$2,'organisations',$3)", [ctx.tenantId, owner.id, [...recordCapabilities]]);
});
afterAll(async () => { await db.close(); });

async function version() {
  return Number((await db.query<{ schema_version: number }>("SELECT schema_version FROM hs_data_tenants WHERE id=$1", [ctx.tenantId])).rows[0].schema_version);
}
async function organisation(name: string) {
  return (await records.create(ctx, { operationId: crypto.randomUUID(), collection: "organisations", name, schemaVersion: await version(), values: {} })).record;
}
async function space() {
  return (await pages.createSpace(owner, "Ops " + crypto.randomUUID().slice(0, 8), ctx.workspaceId)).id;
}
async function makePage(title: string, role?: "viewer" | "editor", subject?: Actor) {
  const page = await pages.create(owner, title, await space());
  if (role && subject) await db.query("INSERT INTO hs_grants(page_id,subject,role) VALUES($1,$2,$3)", [page.id, subject.id, role]);
  return page;
}
async function fail(run: () => Promise<unknown>) {
  try { await run(); return null; } catch (error) { return error as DocumentError; }
}
function shape(error: unknown) {
  const caught = error as DocumentError;
  return { status: caught.status, code: caught.code, message: caught.message };
}

it("replays the association migration without a backfill", async () => {
  const sql = await readFile("db/096_document_record_links.sql", "utf8");
  for (const statement of sql.split(";").map(part => part.trim()).filter(Boolean)) await db.query(statement);
  expect((await db.query("SELECT to_regclass('public.hs_file_versions') AS name")).rows[0].name).toBeNull();
});

it("links one page to many records and lists it from each documents tab", async () => {
  const [first, second] = [await organisation("R-100"), await organisation("R-101")];
  await db.query("INSERT INTO hs_data_record_grants(tenant_id,record_id,user_id,capabilities) VALUES($1,$2,$3,$4),($1,$5,$3,$4)", [ctx.tenantId, first.id, editor.id, ["view", "link"], second.id]);
  const page = await makePage("P-100", "editor", editor);
  const operationId = crypto.randomUUID();
  const linked = await linkDocumentRecord(pages, editor, ctx.workspaceId, { operationId, tenantId: ctx.tenantId, docType: "page", docId: page.id, recordId: first.id });
  expect(linked.replayed).toBe(false);
  expect(await linkDocumentRecord(pages, editor, ctx.workspaceId, { operationId, tenantId: ctx.tenantId, docType: "page", docId: page.id, recordId: first.id })).toMatchObject({ replayed: true, linkId: linked.linkId });
  await linkDocumentRecord(pages, editor, ctx.workspaceId, { operationId: crypto.randomUUID(), tenantId: ctx.tenantId, docType: "page", docId: page.id, recordId: second.id });
  expect((await db.query("SELECT id FROM hs_document_record_links WHERE doc_id=$1", [page.id])).rows).toHaveLength(2);
  for (const record of [first, second]) {
    const documents = await listRecordDocuments(pages, editor, ctx.workspaceId, { tenantId: ctx.tenantId, recordId: record.id });
    expect(documents.items.map(item => item.title)).toEqual(["P-100"]);
    expect(documents.countLabel).toBe("1 you can see");
    expect(documents.items[0].linkedAtLabel).toContain("IST");
  }
  const sidebar = await listPageRecords(pages, editor, page.id);
  expect(sidebar.items.map(item => item.title).sort()).toEqual(["R-100", "R-101"]);
  expect(sidebar.canLink).toBe(true);
  const audit = JSON.stringify((await db.query("SELECT action, after_value FROM hs_audit WHERE correlation_id=$1", [operationId])).rows);
  expect(audit).toContain("document-link.link");
  expect(audit).not.toContain("P-100");
  expect(audit).not.toContain("R-100");
  await expect(linkDocumentRecord(pages, editor, ctx.workspaceId, { operationId, tenantId: ctx.tenantId, docType: "page", docId: page.id, recordId: second.id })).rejects.toMatchObject({ code: "operation_mismatch" });
});

it("links one file to many records without copying it or inventing versions", async () => {
  const targets = [await organisation("R-100"), await organisation("R-101"), await organisation("R-102")];
  const registered = await registerLinkedFile(pages, owner, ctx.workspaceId, { operationId: crypto.randomUUID(), tenantId: ctx.tenantId, name: "contract.pdf", recordId: targets[0].id });
  for (const record of targets.slice(1)) await linkDocumentRecord(pages, owner, ctx.workspaceId, { operationId: crypto.randomUUID(), tenantId: ctx.tenantId, docType: "file", docId: registered.fileId, recordId: record.id });
  await db.query("UPDATE hs_linked_files SET name='contract-v2.pdf', updated_at=clock_timestamp() WHERE id=$1", [registered.fileId]);
  for (const record of targets) {
    const documents = await listRecordDocuments(pages, owner, ctx.workspaceId, { tenantId: ctx.tenantId, recordId: record.id });
    expect(documents.items).toEqual([expect.objectContaining({ docType: "file", docId: registered.fileId, title: "contract-v2.pdf" })]);
  }
  expect((await db.query("SELECT id FROM hs_linked_files WHERE id=$1", [registered.fileId])).rows).toHaveLength(1);
  expect((await db.query("SELECT to_regclass('public.hs_file_versions') AS name")).rows[0].name).toBeNull();
  const audit = JSON.stringify((await db.query("SELECT after_value FROM hs_audit WHERE action='document-link.register-file' AND actor_id=$1", [owner.id])).rows);
  expect(audit).not.toContain("contract.pdf");
});

it("unlinks one record and asks before the last file link is removed", async () => {
  const targets = [await organisation("R-100"), await organisation("R-101"), await organisation("R-102")];
  const registered = await registerLinkedFile(pages, owner, ctx.workspaceId, { operationId: crypto.randomUUID(), tenantId: ctx.tenantId, name: "contract.pdf", recordId: targets[0].id });
  for (const record of targets.slice(1)) await linkDocumentRecord(pages, owner, ctx.workspaceId, { operationId: crypto.randomUUID(), tenantId: ctx.tenantId, docType: "file", docId: registered.fileId, recordId: record.id });
  await unlinkDocumentRecord(pages, owner, ctx.workspaceId, { operationId: crypto.randomUUID(), tenantId: ctx.tenantId, docType: "file", docId: registered.fileId, recordId: targets[2].id });
  expect((await listRecordDocuments(pages, owner, ctx.workspaceId, { tenantId: ctx.tenantId, recordId: targets[2].id })).items).toEqual([]);
  expect((await listRecordDocuments(pages, owner, ctx.workspaceId, { tenantId: ctx.tenantId, recordId: targets[0].id })).items).toHaveLength(1);
  await unlinkDocumentRecord(pages, owner, ctx.workspaceId, { operationId: crypto.randomUUID(), tenantId: ctx.tenantId, docType: "file", docId: registered.fileId, recordId: targets[1].id });
  await expect(unlinkDocumentRecord(pages, owner, ctx.workspaceId, { operationId: crypto.randomUUID(), tenantId: ctx.tenantId, docType: "file", docId: registered.fileId, recordId: targets[0].id })).rejects.toMatchObject({ status: 422, code: "unlink_choice_required" });
  expect((await listRecordDocuments(pages, owner, ctx.workspaceId, { tenantId: ctx.tenantId, recordId: targets[0].id })).items).toHaveLength(1);
  await unlinkDocumentRecord(pages, owner, ctx.workspaceId, { operationId: crypto.randomUUID(), tenantId: ctx.tenantId, docType: "file", docId: registered.fileId, recordId: targets[0].id, disposition: "keep" });
  const bin = await listUnlinkedFiles(pages, owner, ctx.workspaceId, { tenantId: ctx.tenantId });
  expect(bin.items.map(item => item.name)).toEqual(["contract.pdf"]);
  const stored = (await db.query<{ unlinked_at: string; purge_after: string }>("SELECT unlinked_at, purge_after FROM hs_linked_files WHERE id=$1", [registered.fileId])).rows[0];
  expect(new Date(stored.purge_after).getTime() - new Date(stored.unlinked_at).getTime()).toBeGreaterThan(29 * 24 * 60 * 60 * 1000);
  expect((await listUnlinkedFiles(pages, viewer, ctx.workspaceId, { tenantId: ctx.tenantId })).items).toEqual([]);
  const again = await registerLinkedFile(pages, owner, ctx.workspaceId, { operationId: crypto.randomUUID(), tenantId: ctx.tenantId, name: "notes.pdf", recordId: targets[0].id });
  await unlinkDocumentRecord(pages, owner, ctx.workspaceId, { operationId: crypto.randomUUID(), tenantId: ctx.tenantId, docType: "file", docId: again.fileId, recordId: targets[0].id, disposition: "delete" });
  expect((await db.query("SELECT deleted_at FROM hs_linked_files WHERE id=$1", [again.fileId])).rows[0].deleted_at).toBeTruthy();
  expect((await listUnlinkedFiles(pages, owner, ctx.workspaceId, { tenantId: ctx.tenantId })).items.map(item => item.name)).toEqual(["contract.pdf"]);
});

it("filters and paginates a record document list on the server", async () => {
  const record = await organisation("R-100");
  const place = await space();
  const pageIds: string[] = [];
  for (let index = 0; index < 25; index += 1) {
    const page = await pages.create(owner, `Page ${index}`, place);
    pageIds.push(page.id);
    await db.query("UPDATE hs_pages SET updated_at='2026-01-15T09:00:00Z' WHERE id=$1", [page.id]);
    await linkDocumentRecord(pages, owner, ctx.workspaceId, { operationId: crypto.randomUUID(), tenantId: ctx.tenantId, docType: "page", docId: page.id, recordId: record.id });
  }
  for (let index = 0; index < 5; index += 1) {
    const file = await registerLinkedFile(pages, owner, ctx.workspaceId, { operationId: crypto.randomUUID(), tenantId: ctx.tenantId, name: `file-${index}.pdf`, recordId: record.id });
    await db.query("UPDATE hs_linked_files SET updated_at='2026-06-15T09:00:00Z' WHERE id=$1", [file.fileId]);
  }
  const all = await listRecordDocuments(pages, owner, ctx.workspaceId, { tenantId: ctx.tenantId, recordId: record.id });
  expect(all.countLabel).toBe("30 you can see");
  expect(all.items).toHaveLength(20);
  expect(all.nextCursor).toBeTruthy();
  const rest = await listRecordDocuments(pages, owner, ctx.workspaceId, { tenantId: ctx.tenantId, recordId: record.id, cursor: all.nextCursor ?? undefined });
  expect(rest.items).toHaveLength(10);
  expect(rest.nextCursor).toBeNull();
  const pagesOnly = await listRecordDocuments(pages, owner, ctx.workspaceId, { tenantId: ctx.tenantId, recordId: record.id, type: "page" });
  expect(pagesOnly.countLabel).toBe("25 you can see");
  expect(pagesOnly.items.every(item => item.docType === "page")).toBe(true);
  const files = await listRecordDocuments(pages, owner, ctx.workspaceId, { tenantId: ctx.tenantId, recordId: record.id, type: "file", owner: owner.id, updatedFrom: "2026-05-01", updatedTo: "2026-07-01" });
  expect(files.countLabel).toBe("5 you can see");
  expect(files.items.every(item => item.docType === "file" && item.ownerId === owner.id)).toBe(true);
  expect((await listRecordDocuments(pages, owner, ctx.workspaceId, { tenantId: ctx.tenantId, recordId: record.id, owner: viewer.id })).items).toEqual([]);
  expect(pageIds).toHaveLength(25);
});

it("refuses a link unless the actor can edit the document and link the record", async () => {
  const record = await organisation("R-100");
  const page = await makePage("P-100", "viewer", viewer);
  await db.query("INSERT INTO hs_data_record_grants(tenant_id,record_id,user_id,capabilities) VALUES($1,$2,$3,$4)", [ctx.tenantId, record.id, viewer.id, ["view"]]);
  const denied = await fail(() => linkDocumentRecord(pages, viewer, ctx.workspaceId, { operationId: crypto.randomUUID(), tenantId: ctx.tenantId, docType: "page", docId: page.id, recordId: record.id }));
  expect(denied).toMatchObject({ status: 403, code: "document_link_forbidden" });
  expect((await db.query("SELECT id FROM hs_document_record_links WHERE doc_id=$1", [page.id])).rows).toEqual([]);
  const documents = await listRecordDocuments(pages, viewer, ctx.workspaceId, { tenantId: ctx.tenantId, recordId: record.id });
  expect(documents.canLink).toBe(false);
  await db.query("UPDATE hs_data_record_grants SET capabilities=$4 WHERE tenant_id=$1 AND record_id=$2 AND user_id=$3", [ctx.tenantId, record.id, viewer.id, ["view", "link"]]);
  await expect(linkDocumentRecord(pages, viewer, ctx.workspaceId, { operationId: crypto.randomUUID(), tenantId: ctx.tenantId, docType: "page", docId: page.id, recordId: record.id })).rejects.toMatchObject({ code: "document_link_forbidden" });
  const sidebar = await listPageRecords(pages, viewer, page.id);
  expect(sidebar.canLink).toBe(false);
});

it("omits hidden documents and hidden records without their titles", async () => {
  const visible = await organisation("R-100");
  const hiddenRecord = await organisation("R-200 secret");
  const visiblePage = await makePage("P-100", "editor", editor);
  const hiddenPage = await makePage("P-200 secret");
  await db.query("INSERT INTO hs_data_record_grants(tenant_id,record_id,user_id,capabilities) VALUES($1,$2,$3,$4)", [ctx.tenantId, visible.id, editor.id, ["view", "link"]]);
  await linkDocumentRecord(pages, owner, ctx.workspaceId, { operationId: crypto.randomUUID(), tenantId: ctx.tenantId, docType: "page", docId: visiblePage.id, recordId: visible.id });
  await linkDocumentRecord(pages, owner, ctx.workspaceId, { operationId: crypto.randomUUID(), tenantId: ctx.tenantId, docType: "page", docId: hiddenPage.id, recordId: visible.id });
  await linkDocumentRecord(pages, owner, ctx.workspaceId, { operationId: crypto.randomUUID(), tenantId: ctx.tenantId, docType: "page", docId: visiblePage.id, recordId: hiddenRecord.id });
  const documents = await listRecordDocuments(pages, editor, ctx.workspaceId, { tenantId: ctx.tenantId, recordId: visible.id });
  const sidebar = await listPageRecords(pages, editor, visiblePage.id);
  const body = JSON.stringify({ documents, sidebar });
  expect(documents.items.map(item => item.title)).toEqual(["P-100"]);
  expect(documents.countLabel).toContain("you can see");
  expect(sidebar.items.map(item => item.title)).toEqual(["R-100"]);
  expect(body).not.toContain("P-200 secret");
  expect(body).not.toContain("R-200 secret");
});

it("drops a revoked document on refresh and reports the same not-found as a missing page", async () => {
  const record = await organisation("R-100");
  const page = await makePage("P-100", "editor", editor);
  await db.query("INSERT INTO hs_data_record_grants(tenant_id,record_id,user_id,capabilities) VALUES($1,$2,$3,$4)", [ctx.tenantId, record.id, editor.id, ["view", "link"]]);
  await linkDocumentRecord(pages, editor, ctx.workspaceId, { operationId: crypto.randomUUID(), tenantId: ctx.tenantId, docType: "page", docId: page.id, recordId: record.id });
  await db.query("DELETE FROM hs_grants WHERE page_id=$1 AND subject=$2", [page.id, editor.id]);
  const documents = await listRecordDocuments(pages, editor, ctx.workspaceId, { tenantId: ctx.tenantId, recordId: record.id });
  expect(documents.items).toEqual([]);
  expect(JSON.stringify(documents)).not.toContain("P-100");
  const revoked = await fail(() => pages.get(page.id, editor));
  const missing = await fail(() => pages.get(crypto.randomUUID(), editor));
  expect(shape(revoked)).toEqual(shape(missing));
});

it("hides trashed pages and archived records from readers and labels them for restorers", async () => {
  const record = await organisation("R-100");
  const archived = await organisation("R-archived secret");
  const page = await makePage("P-100", "viewer", viewer);
  await db.query("INSERT INTO hs_data_record_grants(tenant_id,record_id,user_id,capabilities) VALUES($1,$2,$3,$4),($1,$5,$3,$6)", [ctx.tenantId, record.id, viewer.id, ["view"], archived.id, ["view"]]);
  await linkDocumentRecord(pages, owner, ctx.workspaceId, { operationId: crypto.randomUUID(), tenantId: ctx.tenantId, docType: "page", docId: page.id, recordId: record.id });
  await linkDocumentRecord(pages, owner, ctx.workspaceId, { operationId: crypto.randomUUID(), tenantId: ctx.tenantId, docType: "page", docId: page.id, recordId: archived.id });
  await db.query("UPDATE hs_data_records SET state='archived' WHERE id=$1", [archived.id]);
  const whilePageIsReadable = await listPageRecords(pages, viewer, page.id);
  expect(whilePageIsReadable.items.map(item => item.recordId)).toEqual([record.id]);
  expect(JSON.stringify(whilePageIsReadable)).not.toContain("R-archived secret");
  const restorerSidebar = await listPageRecords(pages, owner, page.id);
  expect(restorerSidebar.items.find(item => item.recordId === archived.id)).toMatchObject({ label: "In trash", title: "R-archived secret" });
  await db.query("UPDATE hs_pages SET deleted_at=clock_timestamp() WHERE id=$1", [page.id]);
  const readerDocuments = await listRecordDocuments(pages, viewer, ctx.workspaceId, { tenantId: ctx.tenantId, recordId: record.id });
  expect(readerDocuments.items).toEqual([]);
  expect(JSON.stringify(readerDocuments)).not.toContain("P-100");
  const ownerDocuments = await listRecordDocuments(pages, owner, ctx.workspaceId, { tenantId: ctx.tenantId, recordId: record.id });
  expect(ownerDocuments.items.find(item => item.docId === page.id)).toMatchObject({ label: "In trash", title: "P-100" });
  const hiddenPage = await fail(() => listPageRecords(pages, viewer, page.id));
  const missingPage = await fail(() => listPageRecords(pages, viewer, crypto.randomUUID()));
  expect(shape(hiddenPage)).toEqual(shape(missingPage));
});

it("rejects a foreign-tenant record with the same not-found as a random id", async () => {
  const local = await organisation("R-100");
  const page = await makePage("P-100");
  const otherWorkspace = "links-other-" + crypto.randomUUID();
  const otherTenant = crypto.randomUUID();
  await db.query("INSERT INTO hs_workspaces(id,name) VALUES($1,$1)", [otherWorkspace]);
  await db.query("INSERT INTO hs_members(workspace_id,user_id) VALUES($1,$2)", [otherWorkspace, owner.id]);
  await db.query("INSERT INTO hs_data_tenants(id,name) VALUES($1,'Bolt Logistics')", [otherTenant]);
  await db.query("INSERT INTO hs_data_workspaces(workspace_id,tenant_id,review_reference) VALUES($1,$2,'synthetic')", [otherWorkspace, otherTenant]);
  await db.query("INSERT INTO hs_data_collections(tenant_id,id,name,core) VALUES($1,'organisations','Clients',true)", [otherTenant]);
  await db.query("INSERT INTO hs_data_collection_grants(tenant_id,user_id,collection,capabilities) VALUES($1,$2,'organisations',$3)", [otherTenant, owner.id, ["view", "create", "link"]]);
  const foreign = await records.create({ ...ctx, workspaceId: otherWorkspace, tenantId: otherTenant }, { operationId: crypto.randomUUID(), collection: "organisations", name: "Bolt secret record", schemaVersion: 1, values: {} });
  const input = (recordId: string) => linkDocumentRecord(pages, owner, ctx.workspaceId, { operationId: crypto.randomUUID(), tenantId: ctx.tenantId, docType: "page", docId: page.id, recordId });
  const foreignError = await fail(() => input(foreign.record.id));
  const randomError = await fail(() => input(crypto.randomUUID()));
  expect(shape(foreignError)).toEqual(shape(randomError));
  expect(shape(foreignError)).toEqual({ status: 404, code: "not_found", message: "This item is restricted or unavailable." });
  const outsiderForeign = await fail(() => linkDocumentRecord(pages, bolt, ctx.workspaceId, { operationId: crypto.randomUUID(), tenantId: ctx.tenantId, docType: "page", docId: page.id, recordId: local.id }));
  const outsiderRandom = await fail(() => linkDocumentRecord(pages, bolt, ctx.workspaceId, { operationId: crypto.randomUUID(), tenantId: ctx.tenantId, docType: "page", docId: page.id, recordId: crypto.randomUUID() }));
  expect(shape(outsiderForeign)).toEqual(shape(outsiderRandom));
  expect(JSON.stringify([foreignError, outsiderForeign])).not.toContain("Bolt secret record");
  expect((await db.query("SELECT id FROM hs_document_record_links WHERE record_id=$1 OR record_id=$2", [foreign.record.id, local.id])).rows).toEqual([]);
});
