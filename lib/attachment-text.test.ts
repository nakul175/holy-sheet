import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import {
  attachmentTextHistory,
  downloadAttachmentText,
  grantAttachmentTextManager,
  previewAttachmentText,
  readAttachmentTextConfig,
  reindexAttachmentText,
  saveAttachmentTextConfig,
  searchAttachmentText,
  stashAttachmentTextConfig,
} from "./attachment-text";
import { fixtureBrokenPdf, fixturePdfText, fixturePng } from "./attachment-text-extract";
import { localActor as owner, type Actor } from "./auth";
import { createDatabase, type Database } from "./database";
import { DocumentError } from "./document";
import { registerLinkedFile } from "./document-record-links";
import { putObject } from "./media";
import { Repository } from "./repository";
import { recordCapabilities } from "./shared-record-types";
import { SharedRecordRepository, type RecordContext } from "./shared-records";

let db: Database;
let pages: Repository;
let records: SharedRecordRepository;
let ctx: RecordContext;
const viewer: Actor = { id: "attachment-text-viewer", name: "Viewer" };
const editor: Actor = { id: "attachment-text-editor", name: "Editor" };
const exporter: Actor = { id: "attachment-text-exporter", name: "Exporter" };
const historian: Actor = { id: "attachment-text-historian", name: "Historian" };
const outsider: Actor = { id: "attachment-text-outsider", name: "Outsider" };
const authority = { verify: async (context: RecordContext) => ({ subject: context.actor.id, tenantId: context.tenantId, workspaceId: context.workspaceId, active: true, tenantAdministrator: context.actor.id === owner.id, revision: "attachment-text" }) };

beforeAll(async () => {
  db = await createDatabase(":memory:");
  pages = new Repository(db);
  await pages.seedLocal();
  for (const actor of [viewer, editor, exporter, historian, outsider]) await db.query("INSERT INTO hs_users(id,name) VALUES($1,$2)", [actor.id, actor.name]);
  records = new SharedRecordRepository(pages, authority);
});
beforeEach(async () => {
  ctx = { actor: owner, tenantId: randomUUID(), workspaceId: `text-${randomUUID()}` };
  await db.query("INSERT INTO hs_workspaces(id,name) VALUES($1,$1)", [ctx.workspaceId]);
  await db.query("INSERT INTO hs_members(workspace_id,user_id,role) VALUES($1,$2,'admin')", [ctx.workspaceId, owner.id]);
  for (const actor of [viewer, editor, exporter, historian]) await db.query("INSERT INTO hs_members(workspace_id,user_id,role) VALUES($1,$2,'member')", [ctx.workspaceId, actor.id]);
  await db.query("INSERT INTO hs_data_tenants(id,name) VALUES($1,'Acme Health')", [ctx.tenantId]);
  await db.query("INSERT INTO hs_data_workspaces(workspace_id,tenant_id,review_reference) VALUES($1,$2,'synthetic')", [ctx.workspaceId, ctx.tenantId]);
  await db.query("INSERT INTO hs_data_collections(tenant_id,id,name,core) VALUES($1,'organisations','Clients',true)", [ctx.tenantId]);
  await db.query("INSERT INTO hs_data_collection_grants(tenant_id,user_id,collection,capabilities) VALUES($1,$2,'organisations',$3)", [ctx.tenantId, owner.id, [...recordCapabilities]]);
});
afterAll(async () => { await db.close(); });

async function organisation(name: string) {
  const version = Number((await db.query<{ schema_version: number }>("SELECT schema_version FROM hs_data_tenants WHERE id=$1", [ctx.tenantId])).rows[0].schema_version);
  return (await records.create(ctx, { operationId: randomUUID(), collection: "organisations", name, schemaVersion: version, values: {} })).record;
}
async function store(recordId: string, name: string, mime: string, bytes: Uint8Array, versionNo = 1) {
  const registered = versionNo === 1 ? await registerLinkedFile(pages, owner, ctx.workspaceId, { operationId: randomUUID(), tenantId: ctx.tenantId, name, recordId }) : null;
  const fileId = registered?.fileId ?? (await db.query<{ id: string }>("SELECT id FROM hs_linked_files WHERE tenant_id=$1 AND name=$2", [ctx.tenantId, name])).rows[0].id;
  const versionId = randomUUID();
  const blobKey = randomUUID();
  const checksum = createHash("sha256").update(bytes).digest("hex");
  await putObject(blobKey, bytes, mime);
  await db.query(
    `INSERT INTO hs_attachment_versions(id,file_id,workspace_id,tenant_id,version_no,blob_key,checksum,size,mime,name,scan_status,uploader_id,scanned_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'clean',$11,clock_timestamp())`,
    [versionId, fileId, ctx.workspaceId, ctx.tenantId, versionNo, blobKey, checksum, bytes.length, mime, name, owner.id],
  );
  await db.query("UPDATE hs_linked_files SET current_version_id=$2 WHERE id=$1", [fileId, versionId]);
  return { fileId, versionId, checksum };
}
async function source(versionId: string) {
  return (await db.query<{ checksum: string; size: string; blob_key: string; name: string }>("SELECT checksum, size::text, blob_key, name FROM hs_attachment_versions WHERE id=$1", [versionId])).rows[0];
}
async function recordVersion(recordId: string) {
  return (await db.query<{ version: number; field_values: unknown }>("SELECT version, field_values FROM hs_data_records WHERE id=$1", [recordId])).rows[0];
}
function statements(sql: string) {
  const parts: string[] = [];
  let current = "";
  let dollar = false;
  for (const line of sql.split("\n")) {
    current += `${line}\n`;
    if ((line.split("$$").length - 1) % 2 === 1) dollar = !dollar;
    if (!dollar && line.trim().endsWith(";")) {
      if (current.replace(/^\s*--.*$/gm, "").trim()) parts.push(current.trim());
      current = "";
    }
  }
  return parts;
}

it("replays the attachment text migration", async () => {
  const sql = await readFile("db/124_attachment_text.sql", "utf8");
  for (const statement of statements(sql)) await db.query(statement);
  for (const statement of statements(sql)) await db.query(statement);
  expect((await db.query("SELECT to_regclass('public.hs_attachment_text_indexes') AS name")).rows[0].name).toBe("hs_attachment_text_indexes");
});

it("indexes permitted files, searches the exact version, and keeps OCR errors visible", async () => {
  vi.stubGlobal("fetch", () => Promise.reject(new Error("external")));
  const record = await organisation("Ward clinic");
  const before = await recordVersion(record.id);
  const text = await store(record.id, "notes.txt", "text/plain", new TextEncoder().encode("alpha needle\fbeta needle"));
  const pdf = await store(record.id, "policy.pdf", "application/pdf", fixturePdfText(["policy needle"]));
  const image = await store(record.id, "scan.png", "image/png", fixturePng("WARD", true));
  const older = await store(record.id, "pinned.txt", "text/plain", new TextEncoder().encode("pinned alpha needle"), 1);
  const newer = await store(record.id, "pinned.txt", "text/plain", new TextEncoder().encode("current beta needle"), 2);
  await db.query(
    "INSERT INTO hs_attachment_pins(id,workspace_id,tenant_id,file_id,record_id,source_kind,source_id,pinned_version_no,created_by) VALUES($1,$2,$3,$4,$5,'record',$6,1,$7)",
    [randomUUID(), ctx.workspaceId, ctx.tenantId, older.fileId, record.id, record.id, owner.id],
  );
  const input = { operationId: randomUUID(), items: [
    { recordId: record.id, fileId: text.fileId },
    { recordId: record.id, fileId: pdf.fileId },
    { recordId: record.id, fileId: image.fileId },
    { recordId: record.id, fileId: older.fileId, versionNo: 1 },
    { recordId: record.id, fileId: newer.fileId, versionNo: 2 },
  ] };
  const indexed = await reindexAttachmentText(pages, owner, ctx.workspaceId, input);
  const again = await reindexAttachmentText(pages, owner, ctx.workspaceId, input);
  expect(again.replayed).toBe(true);
  expect(indexed.items.map(item => item.status).sort()).toEqual(["extracted", "extracted", "extracted", "extracted", "ocr-error"]);
  expect(await source(text.versionId)).toMatchObject({ checksum: text.checksum, name: "notes.txt" });
  expect(await recordVersion(record.id)).toEqual(before);
  const found = await searchAttachmentText(pages, owner, ctx.workspaceId, "alpha needle");
  expect(found.hits.map(hit => hit.filename).sort()).toEqual(["notes.txt", "pinned.txt"]);
  const pinned = found.hits.find(hit => hit.filename === "pinned.txt");
  expect(pinned).toMatchObject({ page: 1, versionNo: 1, language: "en", status: "extracted", exact: true, pinned: true });
  expect(pinned?.snippet).toContain("alpha needle");
  const opened = await previewAttachmentText(pages, owner, ctx.workspaceId, { recordId: record.id, versionId: pinned!.versionId, page: 1 });
  expect(opened.text).toContain("pinned alpha needle");
  expect(opened.text).not.toContain("current beta");
  const current = await previewAttachmentText(pages, owner, ctx.workspaceId, { recordId: record.id, versionId: newer.versionId, page: 1 });
  expect(current).toMatchObject({ versionNo: 2, exact: true, pinned: false });
  expect(current.text).toContain("current beta needle");
  const scan = (await searchAttachmentText(pages, owner, ctx.workspaceId, "WARD")).hits[0];
  expect(scan).toMatchObject({ filename: "scan.png", page: 1, language: "en", status: "ocr-error", recognition: "ocr", ocrError: true });
  expect(scan.ocrErrors[0]).toMatch(/Unrecognized mark/);
  const stored = JSON.stringify((await db.query("SELECT result FROM hs_attachment_text_operations WHERE operation_id=$1", [input.operationId])).rows);
  const audit = JSON.stringify((await db.query("SELECT after_value FROM hs_audit WHERE correlation_id=$1", [input.operationId])).rows);
  expect(stored).not.toContain("alpha needle");
  expect(audit).not.toContain("alpha needle");
  expect(audit).toContain("attachment-text");
  vi.unstubAllGlobals();
});

it("does not let a parse failure mutate the source or block another record", async () => {
  const good = await organisation("Good record");
  const bad = await organisation("Bad record");
  const notes = await store(good.id, "good.txt", "text/plain", new TextEncoder().encode("surrounding needle"));
  const broken = await store(bad.id, "broken.pdf", "application/pdf", fixtureBrokenPdf());
  const beforeGood = await source(notes.versionId);
  const beforeBad = await source(broken.versionId);
  const beforeRecords = [await recordVersion(good.id), await recordVersion(bad.id)];
  const indexed = await reindexAttachmentText(pages, owner, ctx.workspaceId, { operationId: randomUUID(), items: [{ recordId: bad.id, fileId: broken.fileId }, { recordId: good.id, fileId: notes.fileId }] });
  expect(indexed.items.find(item => item.fileId === broken.fileId)?.status).toBe("failed");
  expect(indexed.items.find(item => item.fileId === notes.fileId)?.status).toBe("extracted");
  expect(await source(notes.versionId)).toEqual(beforeGood);
  expect(await source(broken.versionId)).toEqual(beforeBad);
  expect([await recordVersion(good.id), await recordVersion(bad.id)]).toEqual(beforeRecords);
  expect((await searchAttachmentText(pages, owner, ctx.workspaceId, "surrounding needle")).hits).toHaveLength(1);
  let version = 1;
  for (let attempt = 2; attempt <= 5; attempt += 1) {
    const retry = await reindexAttachmentText(pages, owner, ctx.workspaceId, { operationId: randomUUID(), items: [{ recordId: bad.id, fileId: broken.fileId, expectedVersion: version }] });
    expect(retry.items[0]).toMatchObject({ status: "failed", attempts: attempt, version: attempt });
    version = attempt;
  }
  const bounded = await reindexAttachmentText(pages, owner, ctx.workspaceId, { operationId: randomUUID(), items: [{ recordId: bad.id, fileId: broken.fileId, expectedVersion: 5 }] });
  expect(bounded.items[0]).toMatchObject({ status: "failed", attempts: 5, version: 5, idempotent: true });
  const stale = await reindexAttachmentText(pages, owner, ctx.workspaceId, { operationId: randomUUID(), items: [{ recordId: bad.id, fileId: broken.fileId, expectedVersion: 1 }] });
  expect(stale.items[0]).toMatchObject({ status: "skipped", code: "attachment_text_conflict" });
  expect((await db.query<{ attempts: number }>("SELECT attempts FROM hs_attachment_text_indexes WHERE version_id=$1", [broken.versionId])).rows[0].attempts).toBe(5);
  expect(await source(broken.versionId)).toEqual(beforeBad);
});

it("keeps index text behind record, field, action, and tenant rights", async () => {
  const record = await organisation("Visible clinic");
  const hidden = await organisation("Hidden clinic");
  const fieldKey = randomUUID();
  await db.query("INSERT INTO hs_data_fields(tenant_id,collection,field_key,label,kind,sensitive,created_by) VALUES($1,'organisations',$2,'Brief','attachment',true,$3)", [ctx.tenantId, fieldKey, owner.id]);
  const openFile = await store(record.id, "open.txt", "text/plain", new TextEncoder().encode("open needle"));
  const secret = await store(record.id, "secret.txt", "text/plain", new TextEncoder().encode("secret needle"));
  const hiddenFile = await store(hidden.id, "hidden.txt", "text/plain", new TextEncoder().encode("hidden needle"));
  await db.query("UPDATE hs_linked_files SET field_key=$2 WHERE id=$1", [secret.fileId, fieldKey]);
  await db.query("INSERT INTO hs_data_field_permissions(tenant_id,collection,field_key,user_id,can_view,can_write,can_history) VALUES($1,'organisations',$2,$3,true,true,true)", [ctx.tenantId, fieldKey, owner.id]);
  await reindexAttachmentText(pages, owner, ctx.workspaceId, { operationId: randomUUID(), items: [openFile, secret, hiddenFile].map(file => ({ recordId: file === hiddenFile ? hidden.id : record.id, fileId: file.fileId })) });
  await db.query("DELETE FROM hs_data_collection_grants WHERE tenant_id=$1 AND user_id=$2 AND collection='organisations'", [ctx.tenantId, owner.id]);
  await db.query("INSERT INTO hs_data_record_grants(tenant_id,record_id,user_id,capabilities) VALUES($1,$2,$3,ARRAY['view','edit','export','history'])", [ctx.tenantId, record.id, owner.id]);
  const ownerHits = await searchAttachmentText(pages, owner, ctx.workspaceId, "needle");
  expect(ownerHits.hits.map(hit => hit.filename).sort()).toEqual(["open.txt", "secret.txt"]);
  expect(JSON.stringify(ownerHits)).not.toContain("hidden needle");
  await db.query("INSERT INTO hs_data_collection_grants(tenant_id,user_id,collection,capabilities) VALUES($1,$2,'organisations',ARRAY['view']),($1,$3,'organisations',ARRAY['view','edit']),($1,$4,'organisations',ARRAY['view','export']),($1,$5,'organisations',ARRAY['view','history'])", [ctx.tenantId, viewer.id, editor.id, exporter.id, historian.id]);
  expect(JSON.stringify(await searchAttachmentText(pages, viewer, ctx.workspaceId, "secret needle"))).not.toContain("secret needle");
  await db.query("INSERT INTO hs_data_field_permissions(tenant_id,collection,field_key,user_id,can_view,can_write,can_history) VALUES($1,'organisations',$2,$3,true,false,false)", [ctx.tenantId, fieldKey, viewer.id]);
  expect((await searchAttachmentText(pages, viewer, ctx.workspaceId, "secret needle")).hits.map(hit => hit.filename)).toEqual(["secret.txt"]);
  await db.query("UPDATE hs_data_field_permissions SET can_view=false WHERE user_id=$1 AND field_key=$2", [viewer.id, fieldKey]);
  expect(await searchAttachmentText(pages, viewer, ctx.workspaceId, "secret needle")).toEqual({ hits: [] });
  expect((await db.query("SELECT id FROM hs_attachment_text_indexes WHERE version_id=$1", [secret.versionId])).rows).toHaveLength(1);
  await expect(previewAttachmentText(pages, viewer, ctx.workspaceId, { recordId: record.id, versionId: secret.versionId, page: 1 })).rejects.toMatchObject({ code: "not_found" });
  await expect(downloadAttachmentText(pages, viewer, ctx.workspaceId, { operationId: randomUUID(), recordId: record.id, versionId: openFile.versionId })).rejects.toMatchObject({ code: "attachment_text_forbidden" });
  await expect(attachmentTextHistory(pages, viewer, ctx.workspaceId, { recordId: record.id, fileId: openFile.fileId })).rejects.toMatchObject({ code: "attachment_text_forbidden" });
  const downloaded = await downloadAttachmentText(pages, exporter, ctx.workspaceId, { operationId: randomUUID(), recordId: record.id, versionId: openFile.versionId });
  expect(downloaded.headers.get("cache-control")).toContain("no-store");
  expect(downloaded.headers.get("x-hs-attachment-version")).toBe("1");
  expect(await downloaded.text()).toContain("open needle");
  const history = await attachmentTextHistory(pages, historian, ctx.workspaceId, { recordId: record.id, fileId: openFile.fileId });
  expect(history.events[0]).toMatchObject({ actorId: owner.id, source: "attachment-text" });
  expect(history.events[0].atIst).toMatch(/IST$/);
  expect(JSON.stringify(history)).not.toContain("open needle");
  await db.query("DELETE FROM hs_data_collection_grants WHERE user_id=$1", [viewer.id]);
  expect(JSON.stringify(await searchAttachmentText(pages, viewer, ctx.workspaceId, "open needle"))).not.toContain("open needle");
  const other = `other-${randomUUID()}`;
  const otherTenant = randomUUID();
  await db.query("INSERT INTO hs_workspaces(id,name) VALUES($1,$1)", [other]);
  await db.query("INSERT INTO hs_members(workspace_id,user_id,role) VALUES($1,$2,'admin')", [other, outsider.id]);
  await db.query("INSERT INTO hs_data_tenants(id,name) VALUES($1,'Bolt')", [otherTenant]);
  await db.query("INSERT INTO hs_data_workspaces(workspace_id,tenant_id,review_reference) VALUES($1,$2,'synthetic')", [other, otherTenant]);
  await expect(searchAttachmentText(pages, outsider, ctx.workspaceId, "open needle")).rejects.toMatchObject({ code: "not_found" });
  expect(await searchAttachmentText(pages, outsider, other, "open needle")).toEqual({ hits: [] });
});

it("versions configuration without letting assignment grant file access", async () => {
  const grants = (await db.query("SELECT count(*)::int AS n FROM hs_data_collection_grants WHERE tenant_id=$1", [ctx.tenantId])).rows[0];
  const pageGrants = (await db.query("SELECT count(*)::int AS n FROM hs_grants")).rows[0];
  await grantAttachmentTextManager(pages, owner, ctx.workspaceId, { operationId: randomUUID(), userId: viewer.id });
  expect((await db.query("SELECT count(*)::int AS n FROM hs_data_collection_grants WHERE tenant_id=$1", [ctx.tenantId])).rows[0]).toEqual(grants);
  expect((await db.query("SELECT count(*)::int AS n FROM hs_grants")).rows[0]).toEqual(pageGrants);
  const record = await organisation("Assigned clinic");
  const file = await store(record.id, "assigned.txt", "text/plain", new TextEncoder().encode("assigned needle"));
  await reindexAttachmentText(pages, owner, ctx.workspaceId, { operationId: randomUUID(), items: [{ recordId: record.id, fileId: file.fileId }] });
  expect(await searchAttachmentText(pages, viewer, ctx.workspaceId, "assigned needle")).toEqual({ hits: [] });
  const stashed = await stashAttachmentTextConfig(pages, viewer, ctx.workspaceId, { operationId: randomUUID(), expectedVersion: 0, enabled: false, language: "en" });
  expect(stashed.replayed).toBe(false);
  await expect(saveAttachmentTextConfig(pages, viewer, ctx.workspaceId, { operationId: randomUUID(), expectedVersion: 4, enabled: false, language: "en" })).rejects.toMatchObject({ code: "attachment_text_conflict" });
  expect((await readAttachmentTextConfig(pages, viewer, ctx.workspaceId)).recoverableDraft).toMatchObject({ enabled: false, baseVersion: 0 });
  expect((await readAttachmentTextConfig(pages, viewer, ctx.workspaceId)).version).toBe(0);
  const operationId = randomUUID();
  const saved = await saveAttachmentTextConfig(pages, viewer, ctx.workspaceId, { operationId, expectedVersion: 0, enabled: true, language: "en" });
  const replay = await saveAttachmentTextConfig(pages, viewer, ctx.workspaceId, { operationId, expectedVersion: 0, enabled: true, language: "en" });
  expect(replay.replayed).toBe(true);
  expect(saved.version).toBe(1);
  expect((await db.query("SELECT count(*)::int AS n FROM hs_attachment_text_config_revisions WHERE workspace_id=$1", [ctx.workspaceId])).rows[0].n).toBe(1);
  expect((await readAttachmentTextConfig(pages, viewer, ctx.workspaceId)).recoverableDraft).toBeNull();
  const audit = (await db.query<{ actor_id: string; after_value: { source?: string; atIst?: string; operationId?: string } | string }>("SELECT actor_id, after_value FROM hs_audit WHERE action='attachment-text.save' AND correlation_id=$1", [operationId])).rows[0];
  const after = typeof audit.after_value === "string" ? JSON.parse(audit.after_value) as { source: string; atIst: string; operationId: string } : audit.after_value;
  expect(audit.actor_id).toBe(viewer.id);
  expect(after).toMatchObject({ source: "attachment-text", operationId });
  expect(after.atIst).toMatch(/IST$/);
  await expect(reindexAttachmentText(pages, viewer, ctx.workspaceId, { operationId: randomUUID(), items: [{ recordId: record.id, fileId: file.fileId }] })).resolves.toMatchObject({ items: [expect.objectContaining({ status: "skipped" })] });
});

it("rejects a reused index operation that changes its target", async () => {
  const record = await organisation("Retry clinic");
  const file = await store(record.id, "retry.txt", "text/plain", new TextEncoder().encode("retry needle"));
  const operationId = randomUUID();
  await reindexAttachmentText(pages, owner, ctx.workspaceId, { operationId, items: [{ recordId: record.id, fileId: file.fileId }] });
  await expect(reindexAttachmentText(pages, owner, ctx.workspaceId, { operationId, items: [{ recordId: record.id, fileId: file.fileId, versionNo: 1 }] })).rejects.toBeInstanceOf(DocumentError);
  expect((await db.query("SELECT count(*)::int AS n FROM hs_attachment_text_indexes WHERE file_id=$1", [file.fileId])).rows[0].n).toBe(1);
});
