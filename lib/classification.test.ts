import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { localActor as owner } from "./auth";
import {
  applyClassificationChange,
  assignClassification,
  classificationCatalogue,
  classificationFacets,
  classificationHistory,
  createClassificationTag,
  deprecateClassificationTag,
  downloadClassification,
  grantClassificationManager,
  previewClassification,
  readClassificationTag,
  saveClassificationFieldPolicy,
  saveClassificationTag,
  searchClassification,
  stashClassificationTag,
} from "./classification";
import { createDatabase, type Database } from "./database";
import { Repository } from "./repository";

let db: Database;
let r: Repository;
const editor = { id: "classification-editor", name: "Ed Editor" };
const reader = { id: "classification-reader", name: "Rae Reader" };
const observer = { id: "classification-observer", name: "Olivia Observer" };
const outsider = { id: "classification-outsider", name: "Bolt User" };
const workspace = "ws-aplyd";
const space = "space-product";
const visibleRecord = "00000000-0000-4000-8000-00000000c101";
const secretRecord = "00000000-0000-4000-8000-00000000c102";
let tenant = "";

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
  const other = randomUUID();
  await db.query("INSERT INTO hs_data_tenants(id, name) VALUES($1,'Acme'),($2,'Bolt')", [tenant, other]);
  await db.query("INSERT INTO hs_data_workspaces(workspace_id, tenant_id, review_reference) VALUES($1,$2,'synthetic'),('ws-b',$3,'synthetic')", [workspace, tenant, other]);
  await db.query("INSERT INTO hs_data_collections(tenant_id, id, name, core) VALUES($1,'contacts','Contacts',true),($1,'organisations','Organisations',true)", [tenant]);
  await db.query("INSERT INTO hs_data_collection_grants(tenant_id, user_id, collection, capabilities) VALUES($1,$2,'contacts',$3)", [tenant, owner.id, ["view", "edit", "export", "history"]]);
  await db.query("INSERT INTO hs_data_records(id, tenant_id, collection, name, created_by, updated_by) VALUES($1,$2,'contacts','Visible clinic',$3,$3),($4,$2,'contacts','zzsecretrecord',$3,$3)", [visibleRecord, tenant, owner.id, secretRecord]);
  await db.query("INSERT INTO hs_data_record_grants(tenant_id, record_id, user_id, capabilities) VALUES($1,$2,$3,$4),($1,$5,$3,$6),($1,$2,$7,$8),($1,$2,$9,$10)", [tenant, visibleRecord, owner.id, ["view", "edit", "export", "history"], secretRecord, ["view", "edit", "export", "history"], editor.id, ["view", "edit", "history"], reader.id, ["view", "history", "export"]]);
});
afterAll(async () => db.close());

async function page(title: string, readerId?: string) {
  const created = await r.create(owner, title, space);
  if (readerId) await db.query("INSERT INTO hs_grants(page_id, subject, role) VALUES($1,$2,'editor')", [created.id, readerId]);
  return created;
}

function tagInput(code: string, extra: Record<string, unknown> = {}) {
  return { operationId: randomUUID(), code, expectedVersion: 0, label: code, parentId: null, documents: true, collections: ["contacts"], handling: "metadata" as const, clearedUserIds: [] as string[], ...extra };
}

async function grants() {
  const [pages, records, collections, fields] = await Promise.all([
    db.query("SELECT page_id, subject, role FROM hs_grants ORDER BY 1,2,3"),
    db.query("SELECT record_id::text, user_id, capabilities FROM hs_data_record_grants ORDER BY 1,2"),
    db.query("SELECT collection, user_id, capabilities FROM hs_data_collection_grants ORDER BY 1,2"),
    db.query("SELECT field_key, user_id FROM hs_data_field_permissions ORDER BY 1,2"),
  ]);
  return JSON.stringify({ pages: pages.rows, records: records.rows, collections: collections.rows, fields: fields.rows });
}

it("lets a taxonomy admin define stable codes, labels, hierarchy, and scope", async () => {
  const operationId = randomUUID();
  const created = await createClassificationTag(r, owner, workspace, { ...tagInput("clinic"), operationId, label: "Clinic" });
  const again = await createClassificationTag(r, owner, workspace, { ...tagInput("clinic"), operationId, label: "Clinic" });
  expect(again).toMatchObject({ replayed: true, id: created.id, code: "CLINIC" });
  expect(await db.query("SELECT count(*)::int AS n FROM hs_classification_revisions WHERE tag_id=$1", [created.id])).toMatchObject({ rows: [{ n: 1 }] });
  await expect(createClassificationTag(r, owner, workspace, { ...tagInput("other"), operationId, label: "Other" })).rejects.toMatchObject({ code: "operation_mismatch" });
  await expect(createClassificationTag(r, editor, workspace, tagInput("needs-admin"))).rejects.toMatchObject({ code: "management_required" });
  await expect(createClassificationTag(r, observer, workspace, tagInput("observer"))).rejects.toMatchObject({ code: "read_only" });
  await expect(createClassificationTag(r, outsider, workspace, tagInput("outside"))).rejects.toMatchObject({ status: 404 });
  const child = await createClassificationTag(r, owner, workspace, tagInput("desk", { label: "Front desk", parentId: created.id, documents: true, collections: ["contacts"] }));
  expect(child.parentId).toBe(created.id);
  await expect(saveClassificationTag(r, owner, workspace, created.id, { operationId: randomUUID(), expectedVersion: created.version, label: "Clinic", parentId: child.id, documents: true, collections: ["contacts"], handling: "metadata", clearedUserIds: [] })).rejects.toMatchObject({ code: "classification_hierarchy" });
  await expect(db.query("UPDATE hs_classification_tags SET code='RENAMED' WHERE id=$1", [created.id])).rejects.toThrow(/stable/);
  const renamed = await saveClassificationTag(r, owner, workspace, created.id, { operationId: randomUUID(), expectedVersion: created.version, label: "Clinic desk", parentId: null, documents: true, collections: ["contacts", "organisations"], handling: "metadata", clearedUserIds: [] });
  expect(renamed).toMatchObject({ id: created.id, code: "CLINIC", label: "Clinic desk" });
  expect(await db.query("SELECT code FROM hs_classification_tags WHERE id=$1", [created.id])).toMatchObject({ rows: [{ code: "CLINIC" }] });
  const other = await classificationCatalogue(r, outsider, "ws-b");
  expect(other.tags).toEqual([]);
  expect(JSON.stringify(other)).not.toContain(created.id);
});

it("audits multiselect assignment without granting access", async () => {
  const visible = await page("Visible clinic page", editor.id);
  await db.query("INSERT INTO hs_grants(page_id, subject, role) VALUES($1,$2,'viewer')", [visible.id, reader.id]);
  const hidden = await page("zzhiddenpage");
  const clinic = (await classificationCatalogue(r, owner, workspace)).tags.find(tag => tag.code === "CLINIC")!;
  const desk = (await classificationCatalogue(r, owner, workspace)).tags.find(tag => tag.code === "DESK")!;
  const before = await grants();
  const operationId = randomUUID();
  const assigned = await assignClassification(r, editor, workspace, { operationId, targetKind: "page", targetId: visible.id, expectedVersion: 0, tagIds: [clinic.id, desk.id] });
  const replay = await assignClassification(r, editor, workspace, { operationId, targetKind: "page", targetId: visible.id, expectedVersion: 0, tagIds: [clinic.id, desk.id] });
  expect(replay.replayed).toBe(true);
  expect(assigned.tags.map(tag => tag.id).sort()).toEqual([clinic.id, desk.id].sort());
  expect(await grants()).toBe(before);
  const events = (await db.query<{ action: string; actor_id: string; source: string; operation_id: string }>("SELECT action, actor_id, source, operation_id::text FROM hs_classification_assignment_events WHERE operation_id=$1 ORDER BY action", [operationId])).rows;
  expect(events).toHaveLength(2);
  expect(events.every(event => event.actor_id === editor.id && event.source === "classification" && event.action === "assign")).toBe(true);
  await expect(assignClassification(r, reader, workspace, { operationId: randomUUID(), targetKind: "page", targetId: visible.id, expectedVersion: assigned.version, tagIds: [clinic.id] })).rejects.toMatchObject({ code: "classification_forbidden" });
  await expect(assignClassification(r, editor, workspace, { operationId: randomUUID(), targetKind: "page", targetId: hidden.id, expectedVersion: 0, tagIds: [clinic.id] })).rejects.toMatchObject({ status: 404 });
  const record = await assignClassification(r, owner, workspace, { operationId: randomUUID(), targetKind: "record", targetId: visibleRecord, expectedVersion: 0, tagIds: [clinic.id] });
  expect(record.tags.map(tag => tag.code)).toEqual(["CLINIC"]);
  expect(await grants()).toBe(before);
  const removed = await assignClassification(r, editor, workspace, { operationId: randomUUID(), targetKind: "page", targetId: visible.id, expectedVersion: assigned.version, tagIds: [clinic.id] });
  expect(removed.tags.map(tag => tag.code)).toEqual(["CLINIC"]);
  const removal = (await db.query<{ action: string }>("SELECT action FROM hs_classification_assignment_events WHERE target_id=$1 AND tag_id=$2 ORDER BY created_at DESC LIMIT 1", [visible.id, desk.id])).rows[0];
  expect(removal.action).toBe("remove");
  const history = await classificationHistory(r, editor, workspace, { targetKind: "page", targetId: visible.id });
  expect(history.events[0]).toMatchObject({ source: "classification", actorId: editor.id });
  expect(history.events[0].atIst).toMatch(/IST$/);
  expect(history.events[0].operationId).toBeTruthy();
  expect(JSON.stringify(history)).not.toContain("zzhiddenpage");
  expect(JSON.stringify(history)).not.toContain(hidden.id);
});

it("searches by stable tag id and keeps hidden tags out of facets", async () => {
  const catalogue = await classificationCatalogue(r, owner, workspace);
  const clinic = catalogue.tags.find(tag => tag.code === "CLINIC")!;
  await assignClassification(r, owner, workspace, { operationId: randomUUID(), targetKind: "record", targetId: secretRecord, expectedVersion: 0, tagIds: [clinic.id] });
  const hidden = (await db.query<{ id: string }>("SELECT id FROM hs_pages WHERE title='zzhiddenpage'")).rows[0].id;
  await assignClassification(r, owner, workspace, { operationId: randomUUID(), targetKind: "page", targetId: hidden, expectedVersion: 0, tagIds: [clinic.id] });
  const renamed = await saveClassificationTag(r, owner, workspace, clinic.id, { operationId: randomUUID(), expectedVersion: (await readClassificationTag(r, owner, workspace, clinic.id)).version, label: "Renamed clinic", parentId: null, documents: true, collections: ["contacts"], handling: "metadata", clearedUserIds: [] });
  const found = await searchClassification(r, reader, workspace, clinic.id);
  expect(found).toMatchObject({ tagId: clinic.id, code: "CLINIC", label: "Renamed clinic" });
  expect(found.results.map(result => result.id)).toContain(visibleRecord);
  expect(found.results.map(result => result.id)).not.toContain(secretRecord);
  expect(JSON.stringify(found)).not.toContain("zzsecretrecord");
  expect(JSON.stringify(found)).not.toContain("zzhiddenpage");
  const recordFacets = await classificationFacets(r, reader, workspace, { kind: "record", collection: "contacts" });
  expect(recordFacets.facets.find(facet => facet.tagId === clinic.id)?.count).toBe(1);
  expect(JSON.stringify(recordFacets)).not.toContain(secretRecord);
  expect(JSON.stringify(recordFacets)).not.toContain("zzsecretrecord");
  const pageFacets = await classificationFacets(r, editor, workspace, { kind: "page" });
  expect(pageFacets.facets.find(facet => facet.tagId === clinic.id)?.count).toBe(1);
  expect(JSON.stringify(pageFacets)).not.toContain(hidden);
  expect(JSON.stringify(pageFacets)).not.toContain("zzhiddenpage");
  expect(renamed.code).toBe("CLINIC");
});

it("deprecates without erasing history and remaps every reference atomically", async () => {
  const old = await createClassificationTag(r, owner, workspace, tagInput("legacy", { label: "Legacy", documents: true, collections: ["contacts"] }));
  const next = await createClassificationTag(r, owner, workspace, tagInput("current", { label: "Current", documents: true, collections: ["contacts"] }));
  const visible = (await db.query<{ id: string }>("SELECT id FROM hs_pages WHERE title='Visible clinic page'")).rows[0].id;
  const hidden = (await db.query<{ id: string }>("SELECT id FROM hs_pages WHERE title='zzhiddenpage'")).rows[0].id;
  await assignClassification(r, owner, workspace, { operationId: randomUUID(), targetKind: "page", targetId: hidden, expectedVersion: (await classificationCatalogue(r, owner, workspace, { pageId: hidden })).page!.version, tagIds: [old.id] });
  const visibleVersion = (await classificationCatalogue(r, editor, workspace, { pageId: visible })).page!.version;
  const visibleTags = (await classificationCatalogue(r, editor, workspace, { pageId: visible })).page!.tags.map(tag => tag.id);
  await assignClassification(r, editor, workspace, { operationId: randomUUID(), targetKind: "page", targetId: visible, expectedVersion: visibleVersion, tagIds: [...visibleTags, old.id] });
  await assignClassification(r, owner, workspace, { operationId: randomUUID(), targetKind: "record", targetId: secretRecord, expectedVersion: (await classificationCatalogue(r, owner, workspace, { recordId: secretRecord })).record!.version, tagIds: [old.id] });
  const deprecated = await deprecateClassificationTag(r, owner, workspace, old.id, { operationId: randomUUID(), expectedVersion: old.version });
  expect(deprecated.status).toBe("deprecated");
  const choices = (await classificationCatalogue(r, editor, workspace, { pageId: visible })).page!;
  expect(choices.choices.map(choice => choice.id)).not.toContain(old.id);
  expect(choices.tags.map(tag => tag.id)).toContain(old.id);
  const fresh = await page("Fresh clinic page", editor.id);
  await expect(assignClassification(r, editor, workspace, { operationId: randomUUID(), targetKind: "page", targetId: fresh.id, expectedVersion: 0, tagIds: [old.id] })).rejects.toMatchObject({ code: "classification_validation" });
  await assignClassification(r, editor, workspace, { operationId: randomUUID(), targetKind: "page", targetId: visible, expectedVersion: choices.version, tagIds: [old.id] });
  const before = await grants();
  await grantClassificationManager(r, owner, workspace, { operationId: randomUUID(), userId: editor.id });
  expect(await grants()).toBe(before);
  const preview = await previewClassification(r, editor, workspace, { tagId: old.id, action: "merge", intoId: next.id });
  expect(preview.references.map(item => item.title)).toContain("Visible clinic page");
  expect(JSON.stringify(preview)).not.toContain("zzhiddenpage");
  expect(JSON.stringify(preview)).not.toContain("zzsecretrecord");
  expect(JSON.stringify(preview)).not.toContain(hidden);
  expect(JSON.stringify(preview)).not.toContain(secretRecord);
  const mergeOperation = randomUUID();
  const applied = await applyClassificationChange(r, editor, workspace, { operationId: mergeOperation, previewId: preview.previewId, expectedVersion: preview.version });
  const replay = await applyClassificationChange(r, editor, workspace, { operationId: mergeOperation, previewId: preview.previewId, expectedVersion: preview.version });
  expect(applied.status).toBe("merged");
  expect(replay.replayed).toBe(true);
  expect((await db.query("SELECT tag_id FROM hs_classification_assignments WHERE target_id=$1 AND tag_id=$2", [hidden, old.id])).rows).toEqual([]);
  expect((await db.query("SELECT tag_id FROM hs_classification_assignments WHERE target_id=$1 AND tag_id=$2", [secretRecord, next.id])).rows).toHaveLength(1);
  expect((await db.query("SELECT tag_id FROM hs_classification_assignments WHERE target_id=$1 AND tag_id=$2", [visible, next.id])).rows).toHaveLength(1);
  expect((await readClassificationTag(r, owner, workspace, old.id)).status).toBe("merged");
  const history = await classificationHistory(r, owner, workspace, { tagId: old.id });
  expect(history.events.some(event => event.action === "classification.deprecate")).toBe(true);
  expect(JSON.stringify(history)).not.toContain("zzsecretrecord");
  const removal = await previewClassification(r, owner, workspace, { tagId: next.id, action: "remove" });
  await applyClassificationChange(r, owner, workspace, { operationId: randomUUID(), previewId: removal.previewId, expectedVersion: removal.version });
  expect((await db.query("SELECT id FROM hs_classification_assignments WHERE tag_id=$1", [next.id])).rows).toEqual([]);
  expect((await db.query("SELECT count(*)::int AS n FROM hs_classification_revisions WHERE tag_id=$1", [next.id])).rows[0].n).toBeGreaterThan(1);
});

it("enforces tenant, record, field, and action permissions without granting access", async () => {
  const clinic = (await classificationCatalogue(r, owner, workspace)).tags.find(tag => tag.code === "CLINIC")!;
  await expect(searchClassification(r, outsider, "ws-b", clinic.id)).rejects.toMatchObject({ status: 404 });
  await expect(classificationCatalogue(r, outsider, workspace)).rejects.toMatchObject({ status: 404 });
  const before = await grants();
  await saveClassificationFieldPolicy(r, owner, workspace, { operationId: randomUUID(), scopeKey: "contacts", sensitive: true, expectedVersion: 0, access: [{ userId: owner.id, canView: true, canAssign: true, canHistory: true }] });
  expect(await grants()).toBe(before);
  const hiddenFacets = await classificationFacets(r, reader, workspace, { kind: "record", collection: "contacts" });
  expect(hiddenFacets.facets).toEqual([]);
  expect(JSON.stringify(hiddenFacets)).not.toContain(clinic.id);
  await expect(downloadClassification(r, reader, workspace, { operationId: randomUUID(), targetKind: "record", targetId: visibleRecord, expectedVersion: 1 })).rejects.toMatchObject({ status: 404 });
  await expect(classificationHistory(r, reader, workspace, { targetKind: "record", targetId: visibleRecord })).rejects.toMatchObject({ status: 404 });
  const ownerDownload = await downloadClassification(r, owner, workspace, { operationId: randomUUID(), targetKind: "record", targetId: visibleRecord, expectedVersion: (await classificationCatalogue(r, owner, workspace, { recordId: visibleRecord })).record!.version });
  expect(ownerDownload.body).toContain("CLINIC");
  expect(ownerDownload.body).not.toContain("zzsecretrecord");
  const restricted = await createClassificationTag(r, owner, workspace, tagInput("restricted", { label: "Restricted mark", handling: "restrict", clearedUserIds: [] }));
  const readerCatalogue = await classificationCatalogue(r, reader, workspace);
  expect(readerCatalogue.tags.map(tag => tag.code)).not.toContain("RESTRICTED");
  expect(JSON.stringify(readerCatalogue)).not.toContain(restricted.id);
  await expect(searchClassification(r, reader, workspace, restricted.id)).rejects.toMatchObject({ status: 404 });
  await saveClassificationTag(r, owner, workspace, restricted.id, { operationId: randomUUID(), expectedVersion: restricted.version, label: "Restricted mark", parentId: null, documents: false, collections: ["contacts"], handling: "restrict", clearedUserIds: [reader.id] });
  const cleared = await searchClassification(r, reader, workspace, restricted.id);
  expect(JSON.stringify(cleared)).not.toContain("zzsecretrecord");
  expect(cleared.results.map(result => result.id)).not.toContain(secretRecord);
  expect(await grants()).toBe(before);
  await expect(downloadClassification(r, editor, workspace, { operationId: randomUUID(), targetKind: "record", targetId: visibleRecord, expectedVersion: 1 })).rejects.toMatchObject({ status: 403, code: "classification_forbidden" });
});

it("versions configuration, keeps a conflicting draft, and audits the save", async () => {
  const created = await createClassificationTag(r, owner, workspace, tagInput("drafted", { label: "Drafted", documents: true, collections: ["contacts"] }));
  await stashClassificationTag(r, owner, workspace, created.id, { operationId: randomUUID(), expectedVersion: created.version, label: "Recoverable label", parentId: null, documents: true, collections: ["contacts"], handling: "metadata", clearedUserIds: [] });
  await expect(saveClassificationTag(r, owner, workspace, created.id, { operationId: randomUUID(), expectedVersion: created.version + 4, label: "Silent overwrite", parentId: null, documents: false, collections: [], handling: "metadata", clearedUserIds: [] })).rejects.toMatchObject({ code: "classification_conflict" });
  const kept = await readClassificationTag(r, owner, workspace, created.id);
  expect(kept.label).toBe("Drafted");
  expect(kept.recoverableDraft).toMatchObject({ label: "Recoverable label", baseVersion: created.version });
  const saved = await saveClassificationTag(r, owner, workspace, created.id, { operationId: randomUUID(), expectedVersion: created.version, label: "Drafted saved", parentId: null, documents: true, collections: ["contacts"], handling: "metadata", clearedUserIds: [] });
  expect(saved.version).toBe(created.version + 1);
  await expect(saveClassificationTag(r, owner, workspace, created.id, { operationId: randomUUID(), expectedVersion: created.version, label: "Stale", parentId: null, documents: true, collections: ["contacts"], handling: "metadata", clearedUserIds: [] })).rejects.toMatchObject({ code: "classification_conflict" });
  expect((await readClassificationTag(r, owner, workspace, created.id)).label).toBe("Drafted saved");
  const audit = (await db.query<{ actor_id: string; after_value: { source?: string; atIst?: string; operationId?: string } | string }>("SELECT actor_id, after_value FROM hs_audit WHERE action='classification.save' AND subject_id=$1 ORDER BY created_at DESC LIMIT 1", [created.id])).rows[0];
  const after = typeof audit.after_value === "string" ? JSON.parse(audit.after_value) as { source?: string; atIst?: string; operationId?: string } : audit.after_value;
  expect(audit.actor_id).toBe(owner.id);
  expect(after).toMatchObject({ source: "classification" });
  expect(after.atIst).toMatch(/IST$/);
  expect(after.operationId).toBeTruthy();
});
