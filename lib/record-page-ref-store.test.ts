import { beforeAll, afterAll, beforeEach, expect, it } from "vitest";
import { createDatabase, type Database } from "./database";
import { Repository } from "./repository";
import { localActor as owner, type Actor } from "./auth";
import { ensureIds } from "./document";
import { createExport, downloadExport } from "./page-exports";
import { SharedRecordRepository, type RecordContext } from "./shared-records";
import { SharedRecordSchemaRepository } from "./shared-record-schema";
import { SharedRecordViewRepository } from "./shared-record-views";
import { recordCapabilities } from "./shared-record-types";
import { exportRecordPageRefs, pollRecordPageRefs, requestRecordPageAccess, resolveRecordPageRefs, restoreRecordPageRef } from "./record-page-ref-store";
import { restrictedRecordPlaceholder } from "./record-page-refs";

let db: Database, pages: Repository, records: SharedRecordRepository, schemas: SharedRecordSchemaRepository, views: SharedRecordViewRepository, ctx: RecordContext;
const viewer: Actor = { id: "record-ref-viewer" }, outsider: Actor = { id: "record-ref-outsider" };
const authority = { verify: async (c: RecordContext) => ({ subject: c.actor.id, tenantId: c.tenantId, workspaceId: c.workspaceId, active: true, tenantAdministrator: c.actor.id === owner.id, revision: "record-ref-authority" }) };
const as = (actor: Actor) => ({ ...ctx, actor });

beforeAll(async () => {
  db = await createDatabase(":memory:");
  pages = new Repository(db);
  await pages.seedLocal();
  for (const actor of [viewer, outsider]) await db.query("INSERT INTO hs_users(id,name) VALUES($1,$2)", [actor.id, actor.id]);
  records = new SharedRecordRepository(pages, authority);
  schemas = new SharedRecordSchemaRepository(pages, authority);
  views = new SharedRecordViewRepository(pages, authority);
});
beforeEach(async () => {
  ctx = { actor: owner, tenantId: crypto.randomUUID(), workspaceId: "refs-" + crypto.randomUUID() };
  await db.query("INSERT INTO hs_workspaces(id,name) VALUES($1,$1)", [ctx.workspaceId]);
  for (const actor of [owner, viewer, outsider]) await db.query("INSERT INTO hs_members(workspace_id,user_id) VALUES($1,$2)", [ctx.workspaceId, actor.id]);
  await db.query("INSERT INTO hs_data_tenants(id,name) VALUES($1,'Acme')", [ctx.tenantId]);
  await db.query("INSERT INTO hs_data_workspaces(workspace_id,tenant_id,review_reference) VALUES($1,$2,'synthetic')", [ctx.workspaceId, ctx.tenantId]);
  await db.query("INSERT INTO hs_data_collections(tenant_id,id,name,core) VALUES($1,'organisations','Clients',true)", [ctx.tenantId]);
  await db.query("INSERT INTO hs_data_collection_grants(tenant_id,user_id,collection,capabilities) VALUES($1,$2,'organisations',$3),($1,$4,'organisations',$5)", [ctx.tenantId, owner.id, [...recordCapabilities], viewer.id, ["view"]]);
});
afterAll(async () => { await db.close(); });

async function version() { return Number((await db.query<{ schema_version: number }>("SELECT schema_version FROM hs_data_tenants WHERE id=$1", [ctx.tenantId])).rows[0].schema_version); }
async function secretField() {
  const preview = await schemas.previewSchema(ctx, { prepareId: crypto.randomUUID(), collection: "organisations", expectedSchemaVersion: await version(), definition: { label: "Contract Value", kind: "number", sensitive: true } });
  await schemas.applySchema(ctx, { previewId: preview.previewId, reviewHash: preview.reviewHash, operationId: crypto.randomUUID() });
  await db.query("INSERT INTO hs_data_field_permissions(tenant_id,collection,field_key,user_id,can_view,can_write,can_history) VALUES($1,'organisations',$2,$3,true,true,true)", [ctx.tenantId, preview.fieldKey, owner.id]);
  return preview.fieldKey;
}
async function organisation(name: string, values: Record<string, unknown> = {}) {
  return (await records.create(ctx, { operationId: crypto.randomUUID(), collection: "organisations", name, schemaVersion: await version(), values })).record;
}
async function space() { return (await pages.createSpace(owner, "Ops " + crypto.randomUUID().slice(0, 8), ctx.workspaceId)).id; }
function chip(recordId: string, fields: string[] = []) { return { type: "recordRef", attrs: { id: crypto.randomUUID(), nodeVersion: 1, recordId, collectionId: "organisations", display: fields.length ? "card" : "chip", fields } }; }
function viewBlock(viewId: string, columns: string[]) { return { type: "recordView", attrs: { id: crypto.randomUUID(), nodeVersion: 1, viewId, collectionId: "organisations", layout: "table", columns, limit: 10 } }; }

it("stores ids and config only, and rejects a foreign record the same way as a missing one", async () => {
  const record = await organisation("Northwind", { "core:notes": "Visible note" });
  const page = await pages.create(owner, "P-100", await space());
  const saved = await pages.save(page.id, owner, { operationId: crypto.randomUUID(), baseVersion: page.version, title: page.title, document: ensureIds({ type: "doc", content: [chip(record.id), chip(record.id, ["core:notes"])] }) });
  const revision = await db.query<{ document: { content: { attrs: Record<string, unknown> }[] } }>("SELECT document FROM hs_revisions WHERE page_id=$1 AND version=$2", [page.id, saved.page.version]);
  expect(JSON.stringify(revision.rows[0].document)).not.toContain("Visible note");
  expect(revision.rows[0].document.content[1].attrs.fields).toEqual(["core:notes"]);
  const other = "refs-other-" + crypto.randomUUID();
  await db.query("INSERT INTO hs_workspaces(id,name) VALUES($1,$1)", [other]);
  await db.query("INSERT INTO hs_members(workspace_id,user_id) VALUES($1,$2)", [other, owner.id]);
  const otherTenant = crypto.randomUUID();
  await db.query("INSERT INTO hs_data_tenants(id,name) VALUES($1,'Bolt')", [otherTenant]);
  await db.query("INSERT INTO hs_data_workspaces(workspace_id,tenant_id,review_reference) VALUES($1,$2,'synthetic')", [other, otherTenant]);
  await db.query("INSERT INTO hs_data_collections(tenant_id,id,name,core) VALUES($1,'organisations','Clients',true)", [otherTenant]);
  await db.query("INSERT INTO hs_data_collection_grants(tenant_id,user_id,collection,capabilities) VALUES($1,$2,'organisations',$3)", [otherTenant, owner.id, ["view", "create"]]);
  const foreign = await records.create({ ...ctx, workspaceId: other, tenantId: otherTenant }, { operationId: crypto.randomUUID(), collection: "organisations", name: "Foreign record", schemaVersion: 1, values: {} });
  const randomId = crypto.randomUUID();
  const input = (recordId: string) => ({ operationId: crypto.randomUUID(), baseVersion: saved.page.version, title: page.title, document: ensureIds({ type: "doc", content: [chip(recordId)] }) });
  const foreignError = await pages.save(page.id, owner, input(foreign.record.id)).then(() => null, error => error);
  const missingError = await pages.save(page.id, owner, input(randomId)).then(() => null, error => error);
  expect(foreignError).toMatchObject({ status: 422, code: "reference_unavailable" });
  expect(missingError).toMatchObject({ status: foreignError.status, code: foreignError.code, message: foreignError.message });
  expect((await db.query("SELECT version FROM hs_pages WHERE id=$1", [page.id])).rows[0].version).toBe(saved.page.version);
});

it("returns one neutral placeholder for hidden, missing and foreign records", async () => {
  const visible = await organisation("Northwind");
  const hidden = await organisation("Restricted Clinic");
  await db.query("DELETE FROM hs_data_collection_grants WHERE tenant_id=$1 AND user_id=$2", [ctx.tenantId, viewer.id]);
  await db.query("INSERT INTO hs_data_record_grants(tenant_id,record_id,user_id,capabilities) VALUES($1,$2,$3,$4)", [ctx.tenantId, visible.id, viewer.id, ["view"]]);
  const randomId = crypto.randomUUID();
  const result = await pages.db.transaction(tx => resolveRecordPageRefs(tx, viewer, ctx.workspaceId, { records: [hidden, { recordId: randomId, collectionId: "organisations" }].map(item => ({ recordId: "id" in item ? item.id : item.recordId, collectionId: "organisations", fields: ["core:notes"] })), views: [] }));
  expect(result.records[0]).toEqual(result.records[1]);
  expect(result.records[0]).toEqual(restrictedRecordPlaceholder);
  const body = JSON.stringify(result);
  expect(body).not.toContain("Restricted Clinic");
  expect(body).not.toContain("Clients");
  expect(body).not.toContain("core:notes");
  const allowed = await pages.db.transaction(tx => resolveRecordPageRefs(tx, viewer, ctx.workspaceId, { records: [{ recordId: visible.id, collectionId: "organisations", fields: [] }], views: [] }));
  expect(allowed.records[0]).toMatchObject({ status: "visible", title: "Northwind" });
});

it("masks a restricted field without changing readable sort order", async () => {
  const key = await secretField();
  const alpha = await organisation("Alpha", { [key]: 1 });
  const zebra = await organisation("Zebra", { [key]: 250000 });
  const viewId = crypto.randomUUID();
  await views.saveView(ctx, { id: viewId, operationId: crypto.randomUUID(), collection: "organisations", scope: "workspace", name: "Renewals this quarter", expectedVersion: 0, definition: { columns: ["name", key], filters: [], sort: [{ field: key, direction: "desc" }] } });
  const ownerRows = await pages.db.transaction(tx => resolveRecordPageRefs(tx, owner, ctx.workspaceId, { records: [], views: [{ viewId, collectionId: "organisations", layout: "table", columns: ["name", key], limit: 10 }] }));
  const viewerRows = await pages.db.transaction(tx => resolveRecordPageRefs(tx, viewer, ctx.workspaceId, { records: [{ recordId: zebra.id, collectionId: "organisations", fields: [key] }], views: [{ viewId, collectionId: "organisations", layout: "table", columns: ["name", key], limit: 10 }] }));
  expect(ownerRows.views[0]).toMatchObject({ status: "visible" });
  if (ownerRows.views[0].status === "visible") expect(ownerRows.views[0].rows.map(row => row.name)).toEqual(["Zebra", "Alpha"]);
  expect(viewerRows.views[0]).toMatchObject({ status: "visible" });
  if (viewerRows.views[0].status === "visible") {
    expect(viewerRows.views[0].rows.map(row => row.name)).toEqual(["Alpha", "Zebra"]);
    expect(viewerRows.views[0].columns.map(column => column.label)).toContain("Contract Value");
    expect(viewerRows.views[0].countLabel).toContain("you can see");
    expect(viewerRows.views[0].viewAllLabel).toBe("View all in Clients");
    expect(viewerRows.views[0].chips.join(" ")).not.toContain("250000");
  }
  expect(JSON.stringify(viewerRows)).not.toContain("250000");
  const card = viewerRows.records[0];
  expect(card).toMatchObject({ status: "visible", fields: [{ key, label: "Contract Value", access: "hidden" }] });
  expect(JSON.stringify(card)).not.toContain("250000");
  expect(alpha.id).not.toBe(zebra.id);
});

it("shows archived records only to someone who can restore them, then live values after restore", async () => {
  const record = await organisation("Archived clinic");
  await db.query("UPDATE hs_data_records SET state='archived' WHERE id=$1", [record.id]);
  const input = { records: [{ recordId: record.id, collectionId: "organisations", fields: ["core:notes"] }], views: [] };
  const hidden = await pages.db.transaction(tx => resolveRecordPageRefs(tx, viewer, ctx.workspaceId, input));
  const restorable = await pages.db.transaction(tx => resolveRecordPageRefs(tx, owner, ctx.workspaceId, input));
  expect(hidden.records[0]).toEqual(restrictedRecordPlaceholder);
  expect(restorable.records[0]).toEqual({ status: "archived" });
  expect(JSON.stringify(hidden)).not.toContain("Archived clinic");
  await pages.db.transaction(tx => restoreRecordPageRef(tx, owner, ctx.workspaceId, { operationId: crypto.randomUUID(), recordId: record.id }));
  const restored = await pages.db.transaction(tx => resolveRecordPageRefs(tx, viewer, ctx.workspaceId, input));
  expect(restored.records[0]).toMatchObject({ status: "visible", title: "Archived clinic" });
  await expect(pages.db.transaction(tx => restoreRecordPageRef(tx, viewer, ctx.workspaceId, { operationId: crypto.randomUUID(), recordId: record.id }))).rejects.toMatchObject({ status: 404 });
});

it("excludes archived rows from a live view and keeps an empty label", async () => {
  const live = await organisation("Live client");
  const archived = await organisation("Old client");
  await db.query("UPDATE hs_data_records SET state='archived' WHERE id=$1", [archived.id]);
  const viewId = crypto.randomUUID();
  await views.saveView(ctx, { id: viewId, operationId: crypto.randomUUID(), collection: "organisations", scope: "workspace", name: "Renewals this quarter", expectedVersion: 0, definition: { columns: ["name"], filters: [], sort: [{ field: "name", direction: "asc" }] } });
  const result = await pages.db.transaction(tx => resolveRecordPageRefs(tx, viewer, ctx.workspaceId, { records: [], views: [{ viewId, collectionId: "organisations", layout: "table", columns: ["name"], limit: 10 }] }));
  expect(result.views[0]).toMatchObject({ status: "visible" });
  if (result.views[0].status === "visible") expect(result.views[0].rows.map(row => row.name)).toEqual([live.name]);
  await db.query("UPDATE hs_data_records SET state='archived' WHERE id=$1", [live.id]);
  const empty = await pages.db.transaction(tx => resolveRecordPageRefs(tx, viewer, ctx.workspaceId, { records: [], views: [{ viewId, collectionId: "organisations", layout: "table", columns: ["name"], limit: 10 }] }));
  if (empty.views[0].status === "visible") expect(empty.views[0].emptyLabel).toBe("No records you can access match this view");
});

it("refreshes values without a new page revision and purges access through the change poll", async () => {
  const record = await organisation("Northwind", { "core:notes": "Active" });
  const page = await pages.create(owner, "P-100", await space());
  const saved = await pages.save(page.id, owner, { operationId: crypto.randomUUID(), baseVersion: page.version, title: page.title, document: ensureIds({ type: "doc", content: [chip(record.id, ["core:notes"])] }) });
  const before = await pages.db.transaction(tx => pollRecordPageRefs(tx, viewer, ctx.workspaceId, { recordIds: [record.id], viewIds: [], cursor: "0" }));
  await records.update(ctx, record.id, { operationId: crypto.randomUUID(), expectedVersion: record.version, schemaVersion: await version(), values: { "core:notes": "On hold" } });
  const after = await pages.db.transaction(tx => resolveRecordPageRefs(tx, viewer, ctx.workspaceId, { records: [{ recordId: record.id, collectionId: "organisations", fields: ["core:notes"] }], views: [] }));
  expect(after.records[0]).toMatchObject({ status: "visible", fields: [{ value: "On hold" }] });
  expect((await pages.get(page.id, owner)).version).toBe(saved.page.version);
  const poll = await pages.db.transaction(tx => pollRecordPageRefs(tx, viewer, ctx.workspaceId, { recordIds: [record.id, crypto.randomUUID()], viewIds: [], cursor: before.cursor }));
  expect(poll.changed).toBe(true);
  expect(JSON.stringify(poll)).not.toContain("On hold");
  expect(JSON.stringify(poll)).not.toContain(record.id);
  await db.query("DELETE FROM hs_data_collection_grants WHERE tenant_id=$1 AND user_id=$2", [ctx.tenantId, viewer.id]);
  const revoked = await pages.db.transaction(tx => pollRecordPageRefs(tx, viewer, ctx.workspaceId, { recordIds: [record.id], viewIds: [], cursor: poll.cursor }));
  expect(revoked.accessRevision).not.toBe(poll.accessRevision);
  const hidden = await pages.db.transaction(tx => resolveRecordPageRefs(tx, viewer, ctx.workspaceId, { records: [{ recordId: record.id, collectionId: "organisations", fields: ["core:notes"] }], views: [] }));
  expect(hidden.records[0]).toEqual(restrictedRecordPlaceholder);
});

it("exports only values the exporter can read", async () => {
  const record = await organisation("Northwind", { "core:notes": "Shown note" });
  const hidden = await organisation("Restricted Clinic");
  await db.query("DELETE FROM hs_data_collection_grants WHERE tenant_id=$1 AND user_id=$2", [ctx.tenantId, viewer.id]);
  await db.query("INSERT INTO hs_data_record_grants(tenant_id,record_id,user_id,capabilities) VALUES($1,$2,$3,$4)", [ctx.tenantId, record.id, viewer.id, ["view"]]);
  const page = await pages.create(owner, "Export page", await space());
  await db.query("INSERT INTO hs_grants(page_id,subject,role) VALUES($1,$2,'viewer')", [page.id, viewer.id]);
  const saved = await pages.save(page.id, owner, { operationId: crypto.randomUUID(), baseVersion: page.version, title: page.title, document: ensureIds({ type: "doc", content: [chip(record.id, ["core:notes"]), chip(hidden.id)] }) });
  const job = await createExport(pages, viewer, page.id, { id: crypto.randomUUID(), expectedVersion: saved.page.version, format: "markdown" });
  const text = (await downloadExport(pages, viewer, job.id, { reviewHash: job.reviewHash, confirmOmissions: true })).bytes.toString();
  expect(text).toContain("[Record: Northwind](");
  expect(text).toContain("Shown note");
  expect(text).toContain("Restricted record");
  expect(text).not.toContain("Restricted Clinic");
  const slices = await pages.db.transaction(tx => exportRecordPageRefs(tx, outsider, ctx.workspaceId, saved.page.document, "https://hs.example"));
  expect(JSON.stringify(slices)).not.toContain("Northwind");
  const request = await pages.db.transaction(tx => requestRecordPageAccess(tx, outsider, ctx.workspaceId, { operationId: crypto.randomUUID(), recordId: hidden.id }));
  const missing = await pages.db.transaction(tx => requestRecordPageAccess(tx, outsider, ctx.workspaceId, { operationId: crypto.randomUUID(), recordId: crypto.randomUUID() }));
  expect(request.requested).toBe(missing.requested);
  expect((await db.query("SELECT after_value FROM hs_audit WHERE action='record-ref.request-access' AND actor_id=$1", [outsider.id])).rows.map(row => JSON.stringify(row))).not.toEqual(expect.arrayContaining([expect.stringContaining("Restricted Clinic")]));
});
