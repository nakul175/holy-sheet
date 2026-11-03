import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { localActor as owner } from "./auth";
import {
  applyHierarchyImpact,
  downloadHierarchy,
  grantHierarchyManager,
  hierarchyCatalogue,
  hierarchyHistory,
  hierarchyNodes,
  previewHierarchyImpact,
  saveHierarchyConfig,
  saveHierarchyFieldPolicy,
  searchHierarchy,
  stashHierarchyConfig,
} from "./collection-hierarchy";
import { createDatabase, type Database } from "./database";
import { Repository } from "./repository";

let db: Database;
let r: Repository;
const editor = { id: "hierarchy-editor", name: "Ed Editor" };
const reader = { id: "hierarchy-reader", name: "Rae Reader" };
const observer = { id: "hierarchy-observer", name: "Olivia Observer" };
const outsider = { id: "hierarchy-outsider", name: "Bolt User" };
const workspace = "ws-aplyd";
let tenant = "";
let otherTenant = "";

beforeAll(async () => {
  db = await createDatabase(":memory:");
  r = new Repository(db);
  await r.seedLocal();
  await db.query("UPDATE hs_members SET role='admin' WHERE workspace_id=$1 AND user_id=$2", [workspace, owner.id]);
  for (const actor of [editor, reader, observer, outsider]) await db.query("INSERT INTO hs_users(id, name) VALUES($1,$2)", [actor.id, actor.name]);
  await db.query("INSERT INTO hs_members(workspace_id, user_id, role) VALUES($1,$2,'member'),($1,$3,'member'),($1,$4,'observer')", [workspace, editor.id, reader.id, observer.id]);
  await db.query("INSERT INTO hs_workspaces(id, name) VALUES('ws-b','Bolt Logistics')");
  await db.query("INSERT INTO hs_members(workspace_id, user_id, role) VALUES('ws-b',$1,'admin')", [outsider.id]);
  tenant = randomUUID();
  otherTenant = randomUUID();
  await db.query("INSERT INTO hs_data_tenants(id, name) VALUES($1,'Acme'),($2,'Bolt')", [tenant, otherTenant]);
  await db.query("INSERT INTO hs_data_workspaces(workspace_id, tenant_id, review_reference) VALUES($1,$2,'synthetic'),('ws-b',$3,'synthetic')", [workspace, tenant, otherTenant]);
  await db.query("INSERT INTO hs_data_collections(tenant_id, id, name, core) VALUES($1,'accounts','Accounts',true),($1,'organisations','Organisations',true),($2,'assets','Bolt assets',false)", [tenant, otherTenant]);
});
afterAll(async () => db.close());

async function collection(name: string) {
  const id = randomUUID();
  await db.query("INSERT INTO hs_data_collections(tenant_id, id, name, core) VALUES($1,$2,$3,false)", [tenant, id, name]);
  await db.query("INSERT INTO hs_data_collection_grants(tenant_id, user_id, collection, capabilities) VALUES($1,$2,$3,$4)", [tenant, owner.id, id, ["view", "edit", "archive", "delete", "export", "history"]]);
  return id;
}

async function record(collectionId: string, name: string, viewers: { id: string; capabilities: string[] }[] = []) {
  const id = randomUUID();
  await db.query("INSERT INTO hs_data_records(id, tenant_id, collection, name, created_by, updated_by) VALUES($1,$2,$3,$4,$5,$5)", [id, tenant, collectionId, name, owner.id]);
  for (const viewer of viewers) await db.query("INSERT INTO hs_data_record_grants(tenant_id, record_id, user_id, capabilities) VALUES($1,$2,$3,$4)", [tenant, id, viewer.id, viewer.capabilities]);
  return id;
}

function enable(collectionId: string, extra: Record<string, unknown> = {}) {
  return saveHierarchyConfig(r, owner, workspace, { operationId: randomUUID(), collection: collectionId, expectedVersion: 0, enabled: true, allowRoots: true, depthLimit: 20, ...extra });
}

async function place(actor: typeof owner, collectionId: string, recordId: string, parentId: string | null, version = 1) {
  const preview = await previewHierarchyImpact(r, actor, workspace, { collection: collectionId, recordId, action: "reparent", parentId });
  return applyHierarchyImpact(r, actor, workspace, { operationId: randomUUID(), previewId: preview.previewId, expectedVersion: version });
}

async function grants() {
  const [records, collections, fields, pages] = await Promise.all([
    db.query("SELECT record_id::text, user_id, capabilities FROM hs_data_record_grants ORDER BY 1,2"),
    db.query("SELECT collection, user_id, capabilities FROM hs_data_collection_grants ORDER BY 1,2"),
    db.query("SELECT field_key, user_id FROM hs_data_field_permissions ORDER BY 1,2"),
    db.query("SELECT page_id, subject, role FROM hs_grants ORDER BY 1,2,3"),
  ]);
  return JSON.stringify({ records: records.rows, collections: collections.rows, fields: fields.rows, pages: pages.rows });
}

it("lets an admin enable one-parent hierarchy with depth 20 and optional roots", async () => {
  const assets = await collection("Clinic assets");
  const before = await grants();
  const operationId = randomUUID();
  const saved = await saveHierarchyConfig(r, owner, workspace, { operationId, collection: assets, expectedVersion: 0, enabled: true, allowRoots: true, depthLimit: 20 });
  const again = await saveHierarchyConfig(r, owner, workspace, { operationId, collection: assets, expectedVersion: 0, enabled: true, allowRoots: true, depthLimit: 20 });
  expect(again).toMatchObject({ replayed: true, version: 1, enabled: true, allowRoots: true, depthLimit: 20, grantsCreated: false });
  expect(saved.version).toBe(1);
  await expect(saveHierarchyConfig(r, owner, workspace, { operationId, collection: assets, expectedVersion: 0, enabled: false, allowRoots: true, depthLimit: 20 })).rejects.toMatchObject({ code: "operation_mismatch" });
  await expect(saveHierarchyConfig(r, editor, workspace, { operationId: randomUUID(), collection: assets, expectedVersion: 1, enabled: true, allowRoots: true, depthLimit: 20 })).rejects.toMatchObject({ code: "management_required" });
  await expect(saveHierarchyConfig(r, observer, workspace, { operationId: randomUUID(), collection: assets, expectedVersion: 1, enabled: true, allowRoots: true, depthLimit: 20 })).rejects.toMatchObject({ code: "read_only" });
  await expect(saveHierarchyConfig(r, outsider, workspace, { operationId: randomUUID(), collection: assets, expectedVersion: 0, enabled: true, allowRoots: true, depthLimit: 20 })).rejects.toMatchObject({ status: 404 });
  await expect(saveHierarchyConfig(r, owner, workspace, { operationId: randomUUID(), collection: "accounts", expectedVersion: 0, enabled: true, allowRoots: false, depthLimit: 20 })).rejects.toMatchObject({ code: "hierarchy_parent" });
  expect((await db.query("SELECT count(*)::int AS n FROM hs_collection_hierarchy WHERE collection='accounts'")).rows[0].n).toBe(0);
  await expect(db.query("INSERT INTO hs_data_records(id, tenant_id, collection, name, created_by, updated_by) VALUES($1,$2,'accounts','Bare account',$3,$3)", [randomUUID(), tenant, owner.id])).rejects.toThrow(/check|organisation/i);
  const root = await record(assets, "Root clinic");
  const child = await record(assets, "Child clinic");
  await place(owner, assets, root, null);
  await place(owner, assets, child, root);
  expect((await db.query<{ parent_organisation_id: string | null }>("SELECT parent_organisation_id FROM hs_data_records WHERE id=$1", [child])).rows[0].parent_organisation_id).toBeNull();
  expect(await grants()).toBe(before);
  const catalogue = await hierarchyCatalogue(r, owner, workspace);
  expect(catalogue.accountRelationship).toMatch(/Organisation/);
  expect(catalogue.configs.find(item => item.collection === assets)).toMatchObject({ enabled: true, depthLimit: 20, allowRoots: true });
  expect(JSON.stringify(await hierarchyCatalogue(r, outsider, "ws-b"))).not.toContain(assets);
});

it("rejects self, descendant, and cross-tenant parents, including a raced move", async () => {
  const assets = await collection("Move assets");
  await enable(assets);
  const root = await record(assets, "Move root");
  const child = await record(assets, "Move child");
  const grand = await record(assets, "Move grand");
  const foreign = randomUUID();
  await db.query("INSERT INTO hs_data_records(id, tenant_id, collection, name, created_by, updated_by) VALUES($1,$2,'assets','Foreign',$3,$3)", [foreign, otherTenant, owner.id]);
  await place(owner, assets, root, null);
  await place(owner, assets, child, root);
  await place(owner, assets, grand, child);
  await expect(place(owner, assets, root, root)).rejects.toMatchObject({ code: "hierarchy_parent" });
  await expect(place(owner, assets, root, grand)).rejects.toMatchObject({ code: "hierarchy_parent" });
  await expect(place(owner, assets, child, foreign)).rejects.toMatchObject({ status: 404 });
  expect((await db.query("SELECT parent_id FROM hs_collection_hierarchy_links WHERE record_id=$1", [root])).rows[0].parent_id).toBeNull();
  await expect(db.query("UPDATE hs_collection_hierarchy_links SET parent_id=$2 WHERE record_id=$1", [child, child])).rejects.toThrow(/hierarchy|parent/i);
  const left = await record(assets, "Race left");
  const right = await record(assets, "Race right");
  const leftPreview = await previewHierarchyImpact(r, owner, workspace, { collection: assets, recordId: left, action: "reparent", parentId: right });
  const rightPreview = await previewHierarchyImpact(r, owner, workspace, { collection: assets, recordId: right, action: "reparent", parentId: left });
  const raced = await Promise.allSettled([
    applyHierarchyImpact(r, owner, workspace, { operationId: randomUUID(), previewId: leftPreview.previewId, expectedVersion: 1 }),
    applyHierarchyImpact(r, owner, workspace, { operationId: randomUUID(), previewId: rightPreview.previewId, expectedVersion: 1 }),
  ]);
  expect(raced.filter(item => item.status === "fulfilled")).toHaveLength(1);
  expect(raced.filter(item => item.status === "rejected")).toHaveLength(1);
  const links = await db.query<{ record_id: string; parent_id: string | null }>("SELECT record_id::text, parent_id::text FROM hs_collection_hierarchy_links WHERE record_id=ANY($1::uuid[])", [[left, right]]);
  const edge = new Map(links.rows.map(item => [item.record_id, item.parent_id]));
  expect(edge.get(left) === right && edge.get(right) === left).toBe(false);
});

it("stops a chain at depth 20", async () => {
  const assets = await collection("Deep assets");
  await enable(assets, { depthLimit: 20 });
  let parent: string | null = null;
  for (let index = 0; index < 20; index += 1) {
    const id = await record(assets, `Depth ${String(index).padStart(2, "0")}`);
    await place(owner, assets, id, parent);
    parent = id;
  }
  const extra = await record(assets, "Depth 20");
  await expect(place(owner, assets, extra, parent)).rejects.toMatchObject({ code: "hierarchy_parent" });
  await expect(saveHierarchyConfig(r, owner, workspace, { operationId: randomUUID(), collection: assets, expectedVersion: 1, enabled: true, allowRoots: false, depthLimit: 20 })).rejects.toMatchObject({ code: "hierarchy_parent" });
  expect((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM hs_collection_hierarchy_links WHERE collection=$1", [assets])).rows[0].n).toBe(20);
});

it("pages 50 visible siblings and omits hidden ancestry without a count", async () => {
  const assets = await collection("Paged assets");
  await enable(assets);
  const ids: string[] = [];
  for (let index = 0; index < 55; index += 1) ids.push(await record(assets, `sib-${String(index).padStart(2, "0")}`, [{ id: reader.id, capabilities: ["view"] }]));
  const secret = await record(assets, "zzsecretrecord");
  await place(owner, assets, secret, ids[0]);
  const first = await hierarchyNodes(r, reader, workspace, { collection: assets, view: "tree" });
  expect(first.entries).toHaveLength(50);
  expect(first.more).toBe(true);
  expect(first).not.toHaveProperty("total");
  expect(first).not.toHaveProperty("count");
  expect(JSON.stringify(first)).not.toContain("zzsecretrecord");
  expect(JSON.stringify(first)).not.toMatch(/hidden|total|count/i);
  const second = await hierarchyNodes(r, reader, workspace, { collection: assets, view: "tree", afterId: first.entries.at(-1)?.id });
  expect(second.entries.map(entry => entry.name)).toEqual(["sib-50", "sib-51", "sib-52", "sib-53", "sib-54"]);
  expect(second.more).toBe(false);
  const seen = new Set([...first.entries, ...second.entries].map(entry => entry.id));
  expect(seen.size).toBe(55);
  expect(seen.has(secret)).toBe(false);
  const parent = await record(assets, "Hidden parent");
  const child = await record(assets, "Visible child", [{ id: reader.id, capabilities: ["view", "history", "export"] }]);
  await place(owner, assets, parent, null);
  await place(owner, assets, child, parent);
  const found = await searchHierarchy(r, reader, workspace, { collection: assets, query: "Visible child" });
  expect(found.results).toEqual([{ id: child, name: "Visible child", parentId: null }]);
  expect(JSON.stringify(found)).not.toContain("Hidden parent");
  expect(JSON.stringify(found)).not.toContain(parent);
  const ownerRoots = await hierarchyNodes(r, owner, workspace, { collection: assets, view: "tree", parentId: parent });
  expect(ownerRoots.entries.map(entry => entry.id)).toContain(child);
});

it("previews subtree and app references without inheriting access or cascading", async () => {
  const assets = await collection("Impact assets");
  await enable(assets);
  const parent = await record(assets, "Impact parent", [{ id: reader.id, capabilities: ["view", "archive"] }]);
  const child = await record(assets, "Impact child", [{ id: reader.id, capabilities: ["view"] }]);
  const hidden = await record(assets, "Impact hidden");
  await place(owner, assets, parent, null);
  await place(owner, assets, child, parent);
  await place(owner, assets, hidden, parent);
  const reference = randomUUID();
  await db.query("INSERT INTO hs_data_references(id, tenant_id, record_id, source_app, source_type, source_id) VALUES($1,$2,$3,'ledger','project','project-42')", [reference, tenant, parent]);
  const before = await grants();
  const reparent = await previewHierarchyImpact(r, owner, workspace, { collection: assets, recordId: child, action: "reparent", parentId: null });
  expect(reparent.cascade).toBe(false);
  expect(reparent.inheritsPermissions).toBe(false);
  expect(reparent.review).toMatch(/own permissions/);
  expect(reparent.subtree.map(item => item.name)).toContain("Impact child");
  expect(reparent.subtree.map(item => item.name)).not.toContain("Impact hidden");
  const removal = await previewHierarchyImpact(r, owner, workspace, { collection: assets, recordId: parent, action: "archive" });
  expect(removal.subtree.map(item => item.name)).toEqual(expect.arrayContaining(["Impact parent", "Impact child", "Impact hidden"]));
  expect(removal.references).toEqual([expect.objectContaining({ sourceApp: "ledger", sourceType: "project", sourceId: "project-42", recordName: "Impact parent" })]);
  const readerPreview = await previewHierarchyImpact(r, reader, workspace, { collection: assets, recordId: parent, action: "archive" });
  expect(readerPreview.subtree.map(item => item.name)).toEqual(expect.arrayContaining(["Impact parent", "Impact child"]));
  expect(readerPreview.subtree.map(item => item.name)).not.toContain("Impact hidden");
  expect(JSON.stringify(readerPreview)).not.toContain("Impact hidden");
  await expect(previewHierarchyImpact(r, editor, workspace, { collection: assets, recordId: parent, action: "archive" })).rejects.toMatchObject({ status: 404 });
  const archived = await applyHierarchyImpact(r, reader, workspace, { operationId: randomUUID(), previewId: readerPreview.previewId, expectedVersion: readerPreview.version });
  expect(archived.state).toBe("archived");
  expect((await db.query<{ state: string }>("SELECT state FROM hs_data_records WHERE id=$1", [child])).rows[0].state).toBe("active");
  expect((await db.query<{ state: string }>("SELECT state FROM hs_data_records WHERE id=$1", [hidden])).rows[0].state).toBe("active");
  const deletion = await previewHierarchyImpact(r, owner, workspace, { collection: assets, recordId: parent, action: "delete" });
  const trashed = await applyHierarchyImpact(r, owner, workspace, { operationId: randomUUID(), previewId: deletion.previewId, expectedVersion: deletion.version });
  expect(trashed.state).toBe("trashed");
  expect((await db.query<{ state: string }>("SELECT state FROM hs_data_records WHERE id=ANY($1::uuid[])", [[child, hidden]])).rows.map(item => item.state)).toEqual(["active", "active"]);
  expect((await db.query("SELECT source_id FROM hs_data_references WHERE id=$1", [reference])).rows[0].source_id).toBe("project-42");
  expect(await grants()).toBe(before);
});

it("enforces record, field, and action permissions without granting access", async () => {
  const assets = await collection("Guarded assets");
  const before = await grants();
  await enable(assets);
  expect(await grants()).toBe(before);
  const parent = await record(assets, "Guarded parent");
  const child = await record(assets, "Guarded child", [{ id: reader.id, capabilities: ["view", "export"] }]);
  await place(owner, assets, parent, null);
  await place(owner, assets, child, parent);
  const placed = await grants();
  await expect(hierarchyNodes(r, editor, workspace, { collection: assets, view: "tree" })).rejects.toMatchObject({ status: 404 });
  await grantHierarchyManager(r, owner, workspace, { operationId: randomUUID(), userId: editor.id });
  expect(await grants()).toBe(placed);
  await expect(hierarchyNodes(r, editor, workspace, { collection: assets, view: "tree" })).rejects.toMatchObject({ status: 404 });
  await saveHierarchyFieldPolicy(r, owner, workspace, { operationId: randomUUID(), collection: assets, sensitive: true, expectedVersion: 0, access: [{ userId: owner.id, canView: true, canAssign: true, canHistory: true }, { userId: reader.id, canView: false, canAssign: false, canHistory: false }] });
  expect(await grants()).toBe(placed);
  await expect(hierarchyNodes(r, reader, workspace, { collection: assets, view: "tree" })).rejects.toMatchObject({ status: 404 });
  const found = await searchHierarchy(r, reader, workspace, { collection: assets, query: "Guarded child" });
  expect(found.results).toEqual([{ id: child, name: "Guarded child", parentId: null }]);
  expect(JSON.stringify(found)).not.toContain(parent);
  const downloaded = await downloadHierarchy(r, reader, workspace, { operationId: randomUUID(), collection: assets });
  expect(downloaded.body).toContain("Guarded child");
  expect(downloaded.body).not.toContain("Guarded parent");
  expect(downloaded.body).toContain("does not grant access");
  await expect(downloadHierarchy(r, editor, workspace, { operationId: randomUUID(), collection: assets })).rejects.toMatchObject({ code: "hierarchy_forbidden" });
  await expect(hierarchyHistory(r, reader, workspace, { collection: assets, recordId: child })).rejects.toMatchObject({ code: "hierarchy_forbidden" });
  const history = await hierarchyHistory(r, owner, workspace, { collection: assets, recordId: child });
  expect(history.events[0]).toMatchObject({ action: "reparent", source: "collection-hierarchy", actorName: owner.name });
  expect(history.events[0].atIst).toMatch(/IST$/);
  expect(history.events[0].operationId).toMatch(/[0-9a-f-]{36}/);
  await expect(hierarchyHistory(r, outsider, "ws-b", { collection: assets, recordId: child })).rejects.toMatchObject({ status: 404 });
});

it("versions configuration, keeps a recoverable draft, and audits the actor", async () => {
  const assets = await collection("Draft assets");
  const saved = await enable(assets);
  const operationId = randomUUID();
  const stashed = await stashHierarchyConfig(r, owner, workspace, { operationId, collection: assets, expectedVersion: saved.version, enabled: false, allowRoots: true, depthLimit: 12 });
  expect(stashed.recoverableDraft).toMatchObject({ enabled: false, depthLimit: 12, baseVersion: saved.version });
  await expect(saveHierarchyConfig(r, owner, workspace, { operationId: randomUUID(), collection: assets, expectedVersion: saved.version + 4, enabled: false, allowRoots: false, depthLimit: 3 })).rejects.toMatchObject({ code: "hierarchy_conflict" });
  expect((await hierarchyCatalogue(r, owner, workspace)).configs.find(item => item.collection === assets)?.recoverableDraft).toMatchObject({ depthLimit: 12 });
  expect((await db.query<{ enabled: boolean; version: number }>("SELECT enabled, version FROM hs_collection_hierarchy WHERE collection=$1", [assets])).rows[0]).toMatchObject({ enabled: true, version: 1 });
  const changed = await saveHierarchyConfig(r, owner, workspace, { operationId: randomUUID(), collection: assets, expectedVersion: saved.version, enabled: true, allowRoots: true, depthLimit: 12 });
  expect(changed.version).toBe(2);
  expect((await hierarchyCatalogue(r, owner, workspace)).configs.find(item => item.collection === assets)?.recoverableDraft).toBeNull();
  const audit = await db.query<{ actor_id: string; after_value: { source?: string; operationId?: string; atIst?: string } }>("SELECT actor_id, after_value FROM hs_audit WHERE action='collection-hierarchy.config' AND subject_id=$1 ORDER BY created_at DESC LIMIT 1", [assets]);
  expect(audit.rows[0].actor_id).toBe(owner.id);
  expect(audit.rows[0].after_value.source).toBe("collection-hierarchy");
  expect(audit.rows[0].after_value.operationId).toBeTruthy();
  expect(audit.rows[0].after_value.atIst).toMatch(/IST$/);
  await expect(db.query("UPDATE hs_collection_hierarchy_revisions SET depth_limit=1 WHERE collection=$1", [assets])).rejects.toThrow(/immutable/i);
});
