import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { localActor as owner } from "./auth";
import { createDatabase, type Database } from "./database";
import { ensureIds, type RichNode } from "./document";
import {
  archiveDocumentBundle,
  bundleHistory,
  createDocumentBundle,
  downloadDocumentBundle,
  grantBundleManager,
  listDocumentBundles,
  previewDocumentBundle,
  publishDocumentBundle,
  readDocumentBundle,
  saveDocumentBundle,
  shareDocumentBundle,
  stashDocumentBundle,
} from "./document-bundles";
import { Repository } from "./repository";
import { workspaceSearch } from "./workspace-search";

let db: Database;
let r: Repository;
const editor = { id: "bundle-editor", name: "Ed Editor" };
const observer = { id: "bundle-observer", name: "Olivia Observer" };
const outsider = { id: "bundle-outsider", name: "Bolt User" };
const workspace = "ws-aplyd";
const space = "space-product";
const visibleRecord = "00000000-0000-4000-8000-00000000b051";
const text = (value: string): RichNode => ({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: value }] }] });

beforeAll(async () => {
  db = await createDatabase(":memory:");
  r = new Repository(db);
  await r.seedLocal();
  await db.query("UPDATE hs_members SET role='admin' WHERE workspace_id=$1 AND user_id=$2", [workspace, owner.id]);
  for (const actor of [editor, observer, outsider]) await db.query("INSERT INTO hs_users(id, name) VALUES($1,$2)", [actor.id, actor.name]);
  await db.query("INSERT INTO hs_members(workspace_id, user_id, role) VALUES($1,$2,'member'),($1,$3,'observer')", [workspace, editor.id, observer.id]);
  await db.query("INSERT INTO hs_workspaces(id, name) VALUES('ws-b','Bolt Logistics')");
  await db.query("INSERT INTO hs_members(workspace_id, user_id, role) VALUES('ws-b',$1,'admin')", [outsider.id]);
  const tenant = randomUUID();
  await db.query("INSERT INTO hs_data_tenants(id, name) VALUES($1,'Acme')", [tenant]);
  await db.query("INSERT INTO hs_data_workspaces(workspace_id, tenant_id, review_reference) VALUES($1,$2,'synthetic')", [workspace, tenant]);
  await db.query("INSERT INTO hs_data_collections(tenant_id, id, name, core) VALUES($1,'contacts','Contacts',true)", [tenant]);
  await db.query("INSERT INTO hs_data_collection_grants(tenant_id, user_id, collection, capabilities) VALUES($1,$2,'contacts',$3)", [tenant, owner.id, ["view"]]);
  await db.query("INSERT INTO hs_data_records(id, tenant_id, collection, name, field_values, created_by, updated_by, retention_hold) VALUES($1,$2,'contacts',$3,$4::jsonb,$5,$5,true)", [visibleRecord, tenant, "Visible Clinic", JSON.stringify({ "core:job-title": "Analyst", "core:email": "bundle-secret-field@example.com" }), owner.id]);
  await db.query("INSERT INTO hs_data_record_grants(tenant_id, record_id, user_id, capabilities) VALUES($1,$2,$3,$4)", [tenant, visibleRecord, owner.id, ["view"]]);
});
afterAll(async () => db.close());

async function makePage(title: string, body: string | RichNode, readerId?: string) {
  const created = await r.create(owner, title, space);
  const saved = await r.save(created.id, owner, { operationId: randomUUID(), baseVersion: created.version, title, document: ensureIds(typeof body === "string" ? text(body) : body) });
  if (readerId) await db.query("INSERT INTO hs_grants(page_id, subject, role) VALUES($1,$2,'viewer')", [saved.page.id, readerId]);
  return saved.page;
}

async function publish(pageId: string, revisionVersion: number, versionNo: number) {
  await db.query(
    "INSERT INTO hs_published_versions(id, page_id, version_no, revision_id, revision_version, published_by, note) VALUES($1,$2,$3,$4,$5,$6,'Synthetic publish note')",
    [randomUUID(), pageId, versionNo, `${pageId}:${revisionVersion}`, revisionVersion, owner.id],
  );
}

async function bundleDump() {
  const queries = [
    "SELECT members::text AS value FROM hs_document_bundles",
    "SELECT members::text AS value FROM hs_document_bundle_revisions",
    "SELECT snapshot::text AS value FROM hs_document_bundle_publications",
    "SELECT members::text AS value FROM hs_document_bundle_drafts",
    "SELECT result::text AS value FROM hs_document_bundle_operations",
    "SELECT after_value::text AS value FROM hs_audit WHERE action LIKE 'document-bundle.%'",
  ];
  const rows = [];
  for (const query of queries) rows.push(...(await db.query<{ value: string }>(query)).rows);
  return rows.map(row => row.value).join("\n");
}

async function revisionCount(bundleId: string) {
  return Number((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM hs_document_bundle_revisions WHERE bundle_id=$1", [bundleId])).rows[0].n);
}

it("creates a named ordered bundle without copying document bodies", async () => {
  const first = await makePage("First clinic", "first-body-sentence");
  const second = await makePage("Second clinic", "second-body-sentence");
  await publish(first.id, first.version, 1);
  await publish(second.id, second.version, 1);
  const operationId = randomUUID();
  const created = await createDocumentBundle(r, owner, workspace, {
    operationId, name: "Clinic packet", description: "Shared references", ownerId: editor.id,
    members: [{ pageId: first.id, mode: "live" }, { pageId: second.id, mode: "pinned", pinnedVersion: 1 }],
  });
  const again = await createDocumentBundle(r, owner, workspace, {
    operationId, name: "Clinic packet", description: "Shared references", ownerId: editor.id,
    members: [{ pageId: first.id, mode: "live" }, { pageId: second.id, mode: "pinned", pinnedVersion: 1 }],
  });
  expect(again.replayed).toBe(true);
  expect(again.id).toBe(created.id);
  expect(created.members.map(member => member.pageId)).toEqual([first.id, second.id]);
  expect(created.members.map(member => member.modeLabel)).toEqual(["Live — latest published", "Pinned to published revision 1"]);
  expect(created.description).toBe("Shared references");
  expect(created.ownerId).toBe(editor.id);
  expect(await revisionCount(created.id)).toBe(1);
  const audit = (await db.query<{ actor_id: string; after_value: { source?: string; atIst?: string; operationId?: string } | string }>("SELECT actor_id, after_value FROM hs_audit WHERE action='document-bundle.create' AND correlation_id=$1", [operationId])).rows;
  expect(audit).toHaveLength(1);
  const after = typeof audit[0].after_value === "string" ? JSON.parse(audit[0].after_value) as { source: string; atIst: string; operationId: string } : audit[0].after_value;
  expect(audit[0].actor_id).toBe(owner.id);
  expect(after).toMatchObject({ source: "document-bundle", operationId });
  expect(after?.atIst).toMatch(/IST$/);
  expect(await bundleDump()).not.toContain("first-body-sentence");
  expect(await bundleDump()).not.toContain("second-body-sentence");
  await expect(createDocumentBundle(r, owner, workspace, { operationId, name: "Other name", description: "", ownerId: owner.id, members: [] })).rejects.toMatchObject({ code: "operation_mismatch" });
  expect(await revisionCount(created.id)).toBe(1);
  await expect(createDocumentBundle(r, owner, workspace, { operationId: randomUUID(), name: "", description: "", ownerId: owner.id, members: [] })).rejects.toMatchObject({ code: "bundle_name" });
  await expect(createDocumentBundle(r, owner, workspace, { operationId: randomUUID(), name: "x".repeat(101), description: "", ownerId: owner.id, members: [] })).rejects.toMatchObject({ code: "bundle_name" });
  const hundred = await createDocumentBundle(r, owner, workspace, { operationId: randomUUID(), name: "y".repeat(100), description: "d", ownerId: owner.id, members: [] });
  expect(hundred.name).toHaveLength(100);
  await expect(createDocumentBundle(r, observer, workspace, { operationId: randomUUID(), name: "Observer bundle", description: "", ownerId: observer.id, members: [] })).rejects.toMatchObject({ status: 403, code: "read_only" });
  await expect(createDocumentBundle(r, outsider, workspace, { operationId: randomUUID(), name: "Outside", description: "", ownerId: outsider.id, members: [] })).rejects.toMatchObject({ status: 404, code: "not_found" });
  await expect(createDocumentBundle(r, editor, workspace, { operationId: randomUUID(), name: "Needs authority", description: "", ownerId: editor.id, members: [] })).rejects.toMatchObject({ code: "management_required" });
  const grantsBefore = (await db.query("SELECT page_id, subject, role FROM hs_grants ORDER BY page_id, subject")).rows;
  await grantBundleManager(r, owner, workspace, { operationId: randomUUID(), userId: editor.id });
  expect((await db.query("SELECT page_id, subject, role FROM hs_grants ORDER BY page_id, subject")).rows).toEqual(grantsBefore);
  await expect(r.get(first.id, editor)).rejects.toMatchObject({ status: 404 });
});

it("evaluates each member per reader and does not expand access when the bundle is shared", async () => {
  const hidden = await makePage("zzbundlehiddentitle", "hidden-body-sentence");
  const visible = await makePage("Visible clinic bundle", "visible-body-sentence", editor.id);
  await publish(hidden.id, hidden.version, 1);
  await publish(visible.id, visible.version, 1);
  const created = await createDocumentBundle(r, owner, workspace, {
    operationId: randomUUID(), name: "Ward round", description: "Two references", ownerId: owner.id,
    members: [{ pageId: hidden.id, mode: "live" }, { pageId: visible.id, mode: "pinned", pinnedVersion: 1 }],
  });
  const grantsBefore = (await db.query("SELECT page_id, subject FROM hs_grants")).rows;
  const shared = await shareDocumentBundle(r, owner, workspace, created.id, { operationId: randomUUID(), expectedVersion: created.version, subjectId: editor.id, role: "viewer" });
  expect((await db.query("SELECT page_id, subject FROM hs_grants")).rows).toEqual(grantsBefore);
  const seen = await readDocumentBundle(r, editor, workspace, created.id);
  expect(seen.members.map(member => member.pageId)).toEqual([visible.id]);
  expect(JSON.stringify(seen)).not.toContain(hidden.id);
  expect(JSON.stringify(seen)).not.toContain("zzbundlehiddentitle");
  expect(JSON.stringify(seen)).not.toContain("hiddenCount");
  expect(seen.members).toHaveLength(1);
  await expect(r.get(hidden.id, editor)).rejects.toMatchObject({ status: 404, code: "not_found" });
  const ownerView = await readDocumentBundle(r, owner, workspace, created.id);
  expect(ownerView.members.map(member => member.title)).toEqual(["zzbundlehiddentitle", "Visible clinic bundle"]);
  const hiddenSearch = await listDocumentBundles(r, editor, workspace, "zzbundlehiddentitle");
  expect(hiddenSearch.bundles.map(bundle => bundle.id)).not.toContain(created.id);
  expect(JSON.stringify(hiddenSearch)).not.toContain("zzbundlehiddentitle");
  const named = await listDocumentBundles(r, editor, workspace, "Ward");
  expect(named.bundles.map(bundle => bundle.id)).toContain(created.id);
  expect(JSON.stringify(named)).not.toContain("zzbundlehiddentitle");
  const ownerSearch = await listDocumentBundles(r, owner, workspace, "zzbundlehiddentitle");
  expect(ownerSearch.bundles.find(bundle => bundle.id === created.id)).toMatchObject({ matchedDocumentTitle: "zzbundlehiddentitle" });
  expect((await workspaceSearch(r, editor, { query: "zzbundlehiddentitle", workspaceId: workspace })).results.map(result => result.id)).not.toContain(hidden.id);
  const history = await bundleHistory(r, editor, workspace, created.id);
  expect(JSON.stringify(history)).not.toContain(hidden.id);
  expect(JSON.stringify(history)).not.toContain("zzbundlehiddentitle");
  expect(history.events[0]).toMatchObject({ actorId: owner.id, source: "document-bundle" });
  expect(history.events[0].atIst).toMatch(/IST$/);
  expect(history.events[0].operationId).toBeTruthy();
  const missing = readDocumentBundle(r, editor, workspace, randomUUID());
  const foreign = readDocumentBundle(r, outsider, "ws-b", created.id);
  await expect(missing).rejects.toMatchObject({ status: 404, message: "Document bundle unavailable" });
  await expect(foreign).rejects.toMatchObject({ status: 404, message: "Document bundle unavailable" });
  const assigned = await saveDocumentBundle(r, owner, workspace, created.id, {
    operationId: randomUUID(), expectedVersion: shared.version, name: created.name, description: created.description, ownerId: editor.id,
    members: [{ pageId: hidden.id, mode: "live" }, { pageId: visible.id, mode: "pinned", pinnedVersion: 1 }],
  });
  expect(assigned.ownerId).toBe(editor.id);
  expect((await db.query("SELECT page_id, subject FROM hs_grants")).rows).toEqual(grantsBefore);
  await expect(r.get(hidden.id, editor)).rejects.toMatchObject({ status: 404 });
  const downloaded = await downloadDocumentBundle(r, editor, workspace, created.id, { operationId: randomUUID(), expectedVersion: assigned.version });
  expect(downloaded.body).toContain("visible-body-sentence");
  expect(downloaded.body).not.toContain("hidden-body-sentence");
  expect(downloaded.body).not.toContain("zzbundlehiddentitle");
  expect(downloaded.withheld.map(item => item.title)).not.toContain("zzbundlehiddentitle");
});

it("keeps live references current, pins an explicit revision, and freezes the published package", async () => {
  const live = await makePage("Live doc", "snapshot-alpha");
  await publish(live.id, live.version, 1);
  const pin = await makePage("Pin doc", "pin-alpha");
  await publish(pin.id, pin.version, 1);
  const pinNext = await r.save(pin.id, owner, { operationId: randomUUID(), baseVersion: pin.version, title: pin.title, document: ensureIds(text("pin-beta")) });
  await publish(pin.id, pinNext.page.version, 2);
  const created = await createDocumentBundle(r, owner, workspace, {
    operationId: randomUUID(), name: "Snapshot packet", description: "Modes", ownerId: owner.id,
    members: [{ pageId: live.id, mode: "live" }, { pageId: pin.id, mode: "pinned", pinnedVersion: 1 }],
  });
  const unpublished = await makePage("Draft only", "not-published-body");
  const blocked = await createDocumentBundle(r, owner, workspace, {
    operationId: randomUUID(), name: "Blocked packet", description: "", ownerId: owner.id,
    members: [{ pageId: unpublished.id, mode: "live" }],
  });
  await expect(publishDocumentBundle(r, owner, workspace, blocked.id, { operationId: randomUUID(), expectedVersion: blocked.version })).rejects.toMatchObject({ code: "bundle_unpublished" });
  expect(await revisionCount(blocked.id)).toBe(1);
  expect((await db.query("SELECT id FROM hs_document_bundle_publications WHERE bundle_id=$1", [blocked.id])).rows).toEqual([]);
  const packaged = await publishDocumentBundle(r, owner, workspace, created.id, { operationId: randomUUID(), expectedVersion: created.version });
  const liveNext = await r.save(live.id, owner, { operationId: randomUUID(), baseVersion: live.version, title: live.title, document: ensureIds(text("snapshot-beta")) });
  await publish(live.id, liveNext.page.version, 2);
  const draft = await previewDocumentBundle(r, owner, workspace, created.id);
  const frozen = await previewDocumentBundle(r, owner, workspace, created.id, packaged.publicationId);
  expect(draft.immutable).toBe(false);
  expect(draft.items.map(item => item.publishedVersionNo)).toEqual([2, 1]);
  expect(draft.items.map(item => item.modeLabel)).toEqual(["Live — latest published", "Pinned to published revision 1"]);
  expect(frozen.immutable).toBe(true);
  expect(frozen.items.map(item => item.publishedVersionNo)).toEqual([1, 1]);
  expect(frozen.items[0].modeLabel).toContain("frozen at published revision 1");
  const packageDownload = await downloadDocumentBundle(r, owner, workspace, created.id, { operationId: randomUUID(), expectedVersion: packaged.publicationNo ?? 1, publicationId: packaged.publicationId });
  expect(packageDownload.body).toContain("snapshot-alpha");
  expect(packageDownload.body).toContain("pin-alpha");
  expect(packageDownload.body).not.toContain("snapshot-beta");
  expect(packageDownload.body).not.toContain("pin-beta");
  const draftDownload = await downloadDocumentBundle(r, owner, workspace, created.id, { operationId: randomUUID(), expectedVersion: (await readDocumentBundle(r, owner, workspace, created.id)).version });
  expect(draftDownload.body).toContain("snapshot-beta");
  expect(draftDownload.body).toContain("pin-alpha");
  expect(draftDownload.body).not.toContain("pin-beta");
  await expect(db.query("UPDATE hs_document_bundle_publications SET name='forged' WHERE id=$1", [packaged.publicationId])).rejects.toThrow(/immutable/i);
  const stored = (await db.query<{ snapshot: { members: { revisionVersion: number }[] } | string }>("SELECT snapshot FROM hs_document_bundle_publications WHERE id=$1", [packaged.publicationId])).rows[0].snapshot;
  const snapshot = typeof stored === "string" ? JSON.parse(stored) as { members: { revisionVersion: number }[] } : stored;
  expect(snapshot.members.map(member => member.revisionVersion)).toEqual([live.version, pin.version]);
  expect(JSON.stringify(snapshot)).not.toContain("snapshot-alpha");
});

it("validates export rights, assets, and retention, and removal does not delete the document", async () => {
  const page = await makePage("Export target", "export-body-sentence");
  await publish(page.id, page.version, 1);
  const media = randomUUID();
  await db.query("INSERT INTO hs_media(id, page_id, uploader_id, operation_id, name, mime, size, object_key, state, sha256, scanned_at) VALUES($1::uuid,$2,$3,$4,'private.txt','text/plain',4,$5,'ready',$6,clock_timestamp())", [media, page.id, owner.id, randomUUID(), media, "a".repeat(64)]);
  const withFile = await r.save(page.id, owner, { operationId: randomUUID(), baseVersion: page.version, title: page.title, document: ensureIds({ type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "export-body-sentence" }] }, { type: "file", attrs: { attachmentId: media, title: "private.txt" } }] }) });
  await publish(page.id, withFile.page.version, 2);
  const recordPage = await makePage("Record target", { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "record-body-sentence" }] }, { type: "recordRef", attrs: { nodeVersion: 1, recordId: visibleRecord, collectionId: "contacts", display: "card", fields: ["core:job-title", "core:email"] } }] });
  await publish(recordPage.id, recordPage.version, 1);
  const heldPage = await makePage("Old target", "old-body-sentence");
  await publish(heldPage.id, heldPage.version, 1);
  await db.query("UPDATE hs_revisions SET superseded_at=clock_timestamp()-interval '100 days' WHERE page_id=$1 AND version=$2", [heldPage.id, heldPage.version]);
  const created = await createDocumentBundle(r, owner, workspace, {
    operationId: randomUUID(), name: "Export packet", description: "Checks", ownerId: owner.id,
    members: [
      { pageId: page.id, mode: "pinned", pinnedVersion: 2 },
      { pageId: recordPage.id, mode: "pinned", pinnedVersion: 1 },
      { pageId: heldPage.id, mode: "pinned", pinnedVersion: 1 },
    ],
  });
  await db.query("UPDATE hs_media SET state='scanning' WHERE id=$1", [media]);
  await db.query("UPDATE hs_workspaces SET export_enabled=false WHERE id=$1", [workspace]);
  try {
    const denied = await previewDocumentBundle(r, owner, workspace, created.id);
    expect(denied.items.every(item => item.reason === "export-right" && item.exportable === false)).toBe(true);
    const download = await downloadDocumentBundle(r, owner, workspace, created.id, { operationId: randomUUID(), expectedVersion: created.version });
    expect(download.body).not.toContain("export-body-sentence");
    expect(download.body).not.toContain("bundle-secret-field@example.com");
    expect(download.withheld.length).toBe(denied.items.length);
  } finally {
    await db.query("UPDATE hs_workspaces SET export_enabled=true WHERE id=$1", [workspace]);
  }
  const checked = await previewDocumentBundle(r, owner, workspace, created.id);
  expect(checked.items.find(item => item.pageId === page.id)).toMatchObject({ reason: "asset-unavailable", exportable: false, unavailableAssets: 1 });
  expect(checked.items.find(item => item.pageId === recordPage.id)?.reason).toBe("retention-hold");
  expect(checked.items.find(item => item.pageId === heldPage.id)?.reason).toBe("retention-elapsed");
  expect(JSON.stringify(checked)).not.toContain("bundle-secret-field@example.com");
  const removed = await saveDocumentBundle(r, owner, workspace, created.id, {
    operationId: randomUUID(), expectedVersion: created.version, name: created.name, description: created.description, ownerId: owner.id,
    members: [{ pageId: recordPage.id, mode: "pinned", pinnedVersion: 1 }, { pageId: heldPage.id, mode: "pinned", pinnedVersion: 1 }],
  });
  expect(removed.members.map(member => member.pageId)).not.toContain(page.id);
  expect((await r.get(page.id, owner)).document.content?.[0].content?.[0].text).toBe("export-body-sentence");
  expect((await db.query("SELECT id FROM hs_pages WHERE id=$1", [page.id])).rows).toHaveLength(1);
  const archived = await archiveDocumentBundle(r, owner, workspace, created.id, { operationId: randomUUID(), expectedVersion: removed.version });
  expect(archived.archived).toBe(true);
  expect((await r.get(page.id, owner)).title).toBe("Export target");
  await expect(readDocumentBundle(r, owner, workspace, created.id)).rejects.toMatchObject({ status: 404 });
});

it("versions configuration, replays without a second revision, and keeps a recoverable draft", async () => {
  const page = await makePage("Retry doc", "retry-body-sentence");
  await publish(page.id, page.version, 1);
  const created = await createDocumentBundle(r, owner, workspace, { operationId: randomUUID(), name: "Retry packet", description: "Start", ownerId: owner.id, members: [{ pageId: page.id, mode: "live" }] });
  const operationId = randomUUID();
  const stashed = await stashDocumentBundle(r, owner, workspace, created.id, { operationId, expectedVersion: created.version, name: "Retry packet draft", description: "Recover me", ownerId: owner.id, members: [{ pageId: page.id, mode: "live" }] });
  expect(stashed.version).toBe(created.version);
  expect(stashed.recoverableDraft?.name).toBe("Retry packet draft");
  expect((await stashDocumentBundle(r, owner, workspace, created.id, { operationId, expectedVersion: created.version, name: "Retry packet draft", description: "Recover me", ownerId: owner.id, members: [{ pageId: page.id, mode: "live" }] })).replayed).toBe(true);
  expect((await db.query("SELECT id FROM hs_audit WHERE action='document-bundle.stash' AND correlation_id=$1", [operationId])).rows).toHaveLength(1);
  const before = await revisionCount(created.id);
  await expect(saveDocumentBundle(r, owner, workspace, created.id, { operationId: randomUUID(), expectedVersion: created.version + 9, name: "Nope", description: "", ownerId: owner.id, members: [] })).rejects.toMatchObject({ code: "bundle_conflict" });
  expect(await revisionCount(created.id)).toBe(before);
  expect((await readDocumentBundle(r, owner, workspace, created.id)).recoverableDraft?.description).toBe("Recover me");
  const saveId = randomUUID();
  const saved = await saveDocumentBundle(r, owner, workspace, created.id, { operationId: saveId, expectedVersion: created.version, name: "Retry packet saved", description: "Saved", ownerId: owner.id, members: [{ pageId: page.id, mode: "pinned", pinnedVersion: 1 }] });
  expect(saved.version).toBe(created.version + 1);
  expect(saved.recoverableDraft).toBeNull();
  const replay = await saveDocumentBundle(r, owner, workspace, created.id, { operationId: saveId, expectedVersion: created.version, name: "Retry packet saved", description: "Saved", ownerId: owner.id, members: [{ pageId: page.id, mode: "pinned", pinnedVersion: 1 }] });
  expect(replay.replayed).toBe(true);
  expect(await revisionCount(created.id)).toBe(before + 1);
  expect((await db.query("SELECT id FROM hs_audit WHERE action='document-bundle.save' AND correlation_id=$1", [saveId])).rows).toHaveLength(1);
  await expect(saveDocumentBundle(r, owner, workspace, created.id, { operationId: saveId, expectedVersion: created.version, name: "Different", description: "Saved", ownerId: owner.id, members: [] })).rejects.toMatchObject({ code: "operation_mismatch" });
  expect((await r.get(page.id, owner)).document.content?.[0].content?.[0].text).toBe("retry-body-sentence");
  const sharedObserver = await shareDocumentBundle(r, owner, workspace, created.id, { operationId: randomUUID(), expectedVersion: saved.version, subjectId: observer.id, role: "viewer" });
  await expect(saveDocumentBundle(r, observer, workspace, created.id, { operationId: randomUUID(), expectedVersion: sharedObserver.version, name: "Observer edit", description: "", ownerId: owner.id, members: [] })).rejects.toMatchObject({ status: 403, code: "read_only" });
  expect(await revisionCount(created.id)).toBe(before + 2);
});
