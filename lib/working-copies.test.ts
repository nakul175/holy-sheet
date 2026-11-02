import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { localActor as owner } from "./auth";
import { createDatabase, type Database } from "./database";
import { ensureIds, type RichNode } from "./document";
import { changePublishing } from "./document-publishing";
import { listHistory } from "./history";
import { previewExport } from "./page-exports";
import { listPageTreeChildren } from "./page-tree";
import { Repository } from "./repository";
import { changeSharing } from "./sharing";
import { workspaceSearch } from "./workspace-search";
import { applyWorkingCopy, archiveWorkingCopy, abandonWorkingCopy, createWorkingCopy, reconcileWorkingCopy } from "./working-copies";

let db: Database;
let r: Repository;
const admin = { id: "working-copy-admin", name: "Ada Admin" };
const editor = { id: "working-copy-editor", name: "Ed Editor" };
const observer = { id: "working-copy-observer", name: "Olivia Observer" };
const outsider = { id: "working-copy-outsider", name: "Bolt User" };
const workspace = "ws-aplyd";
const space = "space-product";
const visibleRecord = "00000000-0000-4000-8000-00000000c095";
const secretRecord = "00000000-0000-4000-8000-00000000c096";

beforeAll(async () => {
  db = await createDatabase(":memory:");
  r = new Repository(db);
  await r.seedLocal();
  for (const actor of [admin, editor, observer, outsider]) await db.query("INSERT INTO hs_users(id, name) VALUES($1,$2)", [actor.id, actor.name]);
  await db.query("INSERT INTO hs_members(workspace_id, user_id, role) VALUES($1,$2,'admin'),($1,$3,'member'),($1,$4,'observer')", [workspace, admin.id, editor.id, observer.id]);
  await db.query("INSERT INTO hs_workspaces(id, name) VALUES('ws-b','Bolt Logistics')");
  await db.query("INSERT INTO hs_members(workspace_id, user_id, role) VALUES('ws-b',$1,'admin')", [outsider.id]);
  const tenant = randomUUID();
  await db.query("INSERT INTO hs_data_tenants(id, name) VALUES($1,'Acme')", [tenant]);
  await db.query("INSERT INTO hs_data_workspaces(workspace_id, tenant_id, review_reference) VALUES($1,$2,'synthetic')", [workspace, tenant]);
  await db.query("INSERT INTO hs_data_collections(tenant_id, id, name, core) VALUES($1,'contacts','Contacts',true)", [tenant]);
  await db.query("INSERT INTO hs_data_collection_grants(tenant_id, user_id, collection, capabilities) VALUES($1,$2,'contacts',$3)", [tenant, owner.id, ["view"]]);
  await db.query("INSERT INTO hs_data_records(id, tenant_id, collection, name, field_values, created_by, updated_by) VALUES($1,$2,'contacts',$3,$4::jsonb,$5,$5),($6,$2,'contacts',$7,$8::jsonb,$5,$5)", [visibleRecord, tenant, "Visible Clinic", JSON.stringify({ "core:job-title": "Analyst", "core:email": "hidden-r200@example.com" }), owner.id, secretRecord, "Secret Clinic", JSON.stringify({ "core:email": "secret-clinic@example.com" })]);
  await db.query("INSERT INTO hs_data_record_grants(tenant_id, record_id, user_id, capabilities) VALUES($1,$2,$3,$4)", [tenant, visibleRecord, editor.id, ["view"]]);
});
afterAll(async () => db.close());

async function sourcePage(title: string, document: RichNode, grantEditor = false) {
  const created = await r.create(owner, title, space);
  const saved = await r.save(created.id, owner, { operationId: randomUUID(), baseVersion: created.version, title, document: ensureIds(document) });
  if (grantEditor) await db.query("INSERT INTO hs_grants(page_id, subject, role) VALUES($1,$2,'viewer'),($1,$3,'viewer')", [saved.page.id, editor.id, observer.id]);
  return saved.page;
}

const text = (value: string): RichNode => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: value }] }] });

it("creates a private copy with fresh ids, provenance, and no inherited grant", async () => {
  const page = await sourcePage("Clinic notes", text("Visible clinic note"), true);
  const operationId = randomUUID();
  const created = await createWorkingCopy(r, editor, page.id, operationId);
  const again = await createWorkingCopy(r, editor, page.id, operationId);
  expect(again).toMatchObject({ replayed: true, copyPageId: created.copyPageId, baseVersion: page.version });
  expect(created.copyPageId).not.toBe(page.id);
  const sourceIds = (await db.query<{ id: string }>("SELECT id FROM hs_blocks WHERE page_id=$1", [page.id])).rows.map(row => row.id);
  const copyIds = (await db.query<{ id: string }>("SELECT id FROM hs_blocks WHERE page_id=$1", [created.copyPageId])).rows.map(row => row.id);
  expect(copyIds.some(id => sourceIds.includes(id))).toBe(false);
  expect((await db.query("SELECT subject FROM hs_grants WHERE page_id=$1", [created.copyPageId])).rows).toEqual([]);
  expect((await r.get(created.copyPageId, editor)).role).toBe("owner");
  await expect(r.get(created.copyPageId, admin)).rejects.toMatchObject({ status: 404 });
  await expect(r.get(created.copyPageId, owner)).rejects.toMatchObject({ status: 404 });
  expect((await db.query<{ version: number }>("SELECT version FROM hs_pages WHERE id=$1", [page.id])).rows[0].version).toBe(page.version);
  const audit = (await db.query<{ actor_id: string; after_value: { sourcePageId?: string; atIst?: string; copyPageId?: string } | string }>("SELECT actor_id, after_value FROM hs_audit WHERE action='working-copy.create' AND correlation_id=$1", [operationId])).rows;
  expect(audit).toHaveLength(1);
  const after = typeof audit[0].after_value === "string" ? JSON.parse(audit[0].after_value) as { sourcePageId: string; atIst: string } : audit[0].after_value;
  expect(audit[0].actor_id).toBe(editor.id);
  expect(after.sourcePageId).toBe(page.id);
  expect(after.atIst).toMatch(/IST$/);
  expect(JSON.stringify(after)).not.toContain("Visible clinic note");
  await expect(createWorkingCopy(r, outsider, page.id, randomUUID())).rejects.toMatchObject({ status: 404 });
  await expect(createWorkingCopy(r, observer, page.id, randomUUID())).rejects.toMatchObject({ status: 403, code: "read_only" });
});

it("omits records and sensitive fields the creator cannot read", async () => {
  const page = await sourcePage("Record notes", ensureIds({
    type: "doc",
    content: [
      { type: "recordRef", attrs: { nodeVersion: 1, recordId: visibleRecord, collectionId: "contacts", display: "card", fields: ["core:job-title", "core:email"] } },
      { type: "paragraph", content: [{ type: "text", text: "Secret follows" }] },
      { type: "recordRef", attrs: { nodeVersion: 1, recordId: secretRecord, collectionId: "contacts", display: "chip", fields: [] } },
    ],
  }), true);
  const created = await createWorkingCopy(r, editor, page.id, randomUUID());
  const stored = JSON.stringify((await db.query("SELECT node FROM hs_blocks WHERE page_id=$1", [created.copyPageId])).rows);
  expect(stored).toContain(visibleRecord);
  expect(stored).toContain("core:job-title");
  expect(stored).not.toContain("core:email");
  expect(stored).not.toContain(secretRecord);
  expect(stored).toContain("Restricted content");
  expect(JSON.stringify((await db.query("SELECT node FROM hs_blocks WHERE page_id=$1", [page.id])).rows)).toContain(secretRecord);
});

it("reconciles a three-way conflict, applies one revision, and does not publish", async () => {
  const page = await sourcePage("Apply target", text("Base sentence"));
  await db.query("INSERT INTO hs_document_workflows(page_id, version, reviewers, policy_version) VALUES($1,1,$2::jsonb,1)", [page.id, JSON.stringify([editor.id])]);
  const created = await createWorkingCopy(r, owner, page.id, randomUUID());
  const current = await r.get(page.id, owner);
  const originalDocument = structuredClone(current.document);
  originalDocument.content![0].content = [{ type: "text", text: "Original sentence" }];
  const edited = await r.save(page.id, owner, { operationId: randomUUID(), baseVersion: page.version, title: page.title, document: originalDocument });
  const copy = await r.get(created.copyPageId, owner);
  const copyDocument = structuredClone(copy.document);
  copyDocument.content![0].content = [{ type: "text", text: "Copy sentence" }];
  await r.save(copy.id, owner, { operationId: randomUUID(), baseVersion: copy.version, title: copy.title, document: copyDocument });
  const review = await reconcileWorkingCopy(r, owner, created.id);
  expect(review.conflicts).toHaveLength(1);
  expect(review.conflicts[0]).toMatchObject({ base: "Base sentence", original: "Original sentence", copy: "Copy sentence" });
  const revisionsBefore = Number((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM hs_revisions WHERE page_id=$1", [page.id])).rows[0].n);
  await expect(applyWorkingCopy(r, owner, created.id, { operationId: randomUUID(), expectedVersion: created.version, expectedSourceVersion: edited.page.version, choices: {} })).rejects.toMatchObject({ code: "working_copy_choice" });
  expect((await r.get(page.id, owner)).document.content?.[0].content?.[0].text).toBe("Original sentence");
  expect(Number((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM hs_revisions WHERE page_id=$1", [page.id])).rows[0].n)).toBe(revisionsBefore);
  const operationId = randomUUID();
  const applied = await applyWorkingCopy(r, owner, created.id, { operationId, expectedVersion: review.version, expectedSourceVersion: review.sourceVersion, choices: { [review.conflicts[0].key]: "copy" } });
  expect(applied).toMatchObject({ state: "applied", sourceVersion: edited.page.version + 1, replayed: false });
  expect((await r.get(page.id, owner)).document.content?.[0].content?.[0].text).toBe("Copy sentence");
  const replay = await applyWorkingCopy(r, owner, created.id, { operationId, expectedVersion: review.version, expectedSourceVersion: review.sourceVersion, choices: { [review.conflicts[0].key]: "copy" } });
  expect(replay).toMatchObject({ replayed: true, sourceVersion: applied.sourceVersion });
  expect(Number((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM hs_revisions WHERE page_id=$1", [page.id])).rows[0].n)).toBe(revisionsBefore + 1);
  expect((await db.query("SELECT publication_id FROM hs_document_workflows WHERE page_id=$1", [page.id])).rows[0].publication_id).toBeNull();
  expect((await db.query("SELECT id FROM hs_document_publications WHERE page_id=$1", [page.id])).rows).toEqual([]);
  await expect(applyWorkingCopy(r, editor, created.id, { operationId: randomUUID(), expectedVersion: review.version, expectedSourceVersion: review.sourceVersion, choices: { [review.conflicts[0].key]: "original" } })).rejects.toMatchObject({ status: 404 });
});

it("abandons and archives without changing the original and replays one audit", async () => {
  const page = await sourcePage("Keep original", text("Stay put"));
  const created = await createWorkingCopy(r, owner, page.id, randomUUID());
  const operationId = randomUUID();
  const abandoned = await abandonWorkingCopy(r, owner, created.id, { operationId, expectedVersion: created.version });
  expect(abandoned).toMatchObject({ state: "abandoned", sourceVersion: page.version, replayed: false });
  expect((await abandonWorkingCopy(r, owner, created.id, { operationId, expectedVersion: created.version })).replayed).toBe(true);
  expect((await db.query("SELECT id FROM hs_audit WHERE action='working-copy.abandon' AND correlation_id=$1", [operationId])).rows).toHaveLength(1);
  expect((await r.get(page.id, owner)).version).toBe(page.version);
  expect((await r.get(page.id, owner)).document.content?.[0].content?.[0].text).toBe("Stay put");
  const second = await createWorkingCopy(r, owner, page.id, randomUUID());
  const archived = await archiveWorkingCopy(r, owner, second.id, { operationId: randomUUID(), expectedVersion: second.version });
  expect(archived.state).toBe("archived");
  expect((await r.get(page.id, owner)).version).toBe(page.version);
  await expect(applyWorkingCopy(r, owner, second.id, { operationId: randomUUID(), expectedVersion: second.version, expectedSourceVersion: page.version, choices: {} })).rejects.toMatchObject({ code: "working_copy_closed" });
});

it("hides a working copy from admin search, tree, history, export, sharing, and publishing", async () => {
  const page = await sourcePage("Search source", text("Public source sentence"), true);
  const created = await createWorkingCopy(r, editor, page.id, randomUUID());
  const copy = await r.get(created.copyPageId, editor);
  const document = structuredClone(copy.document);
  document.content![0].content = [{ type: "text", text: "zzcopysecretneedle" }];
  await r.save(copy.id, editor, { operationId: randomUUID(), baseVersion: copy.version, title: "zzcopysecret title", document });
  expect((await workspaceSearch(r, admin, { query: "zzcopysecretneedle", workspaceId: workspace })).results.map(result => result.id)).not.toContain(created.copyPageId);
  expect((await workspaceSearch(r, editor, { query: "zzcopysecretneedle", workspaceId: workspace })).results.map(result => result.id)).toContain(created.copyPageId);
  const adminTree = await listPageTreeChildren(r, admin, workspace, { spaceId: space, parentId: null });
  const editorTree = await listPageTreeChildren(r, editor, workspace, { spaceId: space, parentId: null });
  expect(adminTree.nodes.map(node => node.id)).not.toContain(created.copyPageId);
  expect(editorTree.nodes.map(node => node.id)).toContain(created.copyPageId);
  await expect(listHistory(r, admin, created.copyPageId)).rejects.toMatchObject({ status: 404 });
  await expect(previewExport(r, admin, created.copyPageId, "markdown")).rejects.toMatchObject({ status: 404 });
  expect((await previewExport(r, editor, created.copyPageId, "markdown")).document.content?.[0].content?.[0].text).toBe("zzcopysecretneedle");
  await expect(changeSharing(r, editor, created.copyPageId, { operationId: randomUUID(), expectedVersion: 1, recipientId: admin.id, role: "viewer" })).rejects.toMatchObject({ code: "working_copy_private" });
  await expect(changePublishing(r, editor, created.copyPageId, { action: "configure", operationId: randomUUID(), expectedVersion: 0, reviewers: [admin.id] })).rejects.toMatchObject({ code: "working_copy_private" });
  await db.query("UPDATE hs_pages SET deleted_at=clock_timestamp() WHERE id=$1", [created.copyPageId]);
  const { createComplianceExport } = await import("./compliance-pack");
  const denied = { operationId: randomUUID(), scope: "page" as const, format: "markdown" as const, targetId: created.copyPageId, includeDraft: true, includeTrash: true, allAttachmentVersions: false };
  await expect(createComplianceExport(r, admin, workspace, denied, "binding", { renderPdf: async () => Buffer.from("%PDF-1.4\n") })).rejects.toMatchObject({ status: 404 });
  const packed = await createComplianceExport(r, admin, workspace, { ...denied, operationId: randomUUID(), scope: "space", targetId: space }, "binding", { renderPdf: async () => Buffer.from("%PDF-1.4\n") });
  const files = await db.query<{ content: string }>("SELECT content FROM hs_compliance_files WHERE job_id=$1", [packed.id]);
  expect(files.rows.map(row => Buffer.from(row.content, "base64").toString("utf8")).join("\n")).not.toContain("zzcopysecretneedle");
});
