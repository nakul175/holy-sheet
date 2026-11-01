import { createServer } from "node:net";
import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import {
  assertNoDirectStorageKey,
  attachmentDeniedResponse,
  deleteAttachmentVersion,
  finishAttachmentVersion,
  issueAttachmentDownload,
  listAttachmentVersions,
  openAttachmentReference,
  pinAttachmentReference,
  redeemAttachmentDownload,
  reserveAttachmentVersion,
  restoreAttachmentVersion,
} from "./attachment-versions";
import { localActor as owner, type Actor } from "./auth";
import { createDatabase, type Database } from "./database";
import { DocumentError } from "./document";
import { linkDocumentRecord, listRecordDocuments, registerLinkedFile } from "./document-record-links";
import { Repository } from "./repository";
import { SharedRecordHistoryRepository } from "./shared-record-history";
import { SharedRecordRepository, type RecordContext } from "./shared-records";
import { recordCapabilities } from "./shared-record-types";

let db: Database, pages: Repository, records: SharedRecordRepository, ctx: RecordContext, scanner: { close(): Promise<void> };
const editor: Actor = { id: "attachment-editor" };
const viewer: Actor = { id: "attachment-viewer" };
const outsider: Actor = { id: "attachment-outsider" };
const authority = { verify: async (c: RecordContext) => ({ subject: c.actor.id, tenantId: c.tenantId, workspaceId: c.workspaceId, active: true, tenantAdministrator: c.actor.id === owner.id, revision: "attachment-authority" }) };
const text = (value: string) => new TextEncoder().encode(value);
const eicar = text("X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*");

beforeAll(async () => {
  scanner = await new Promise(resolve => {
    const server = createServer(socket => {
      const chunks: Buffer[] = [];
      socket.on("data", chunk => {
        chunks.push(chunk);
        const buf = Buffer.concat(chunks);
        if (buf.length >= 4 && buf.subarray(-4).equals(Buffer.alloc(4))) socket.write(buf.includes(Buffer.from("EICAR-STANDARD-ANTIVIRUS-TEST-FILE")) ? "stream: Eicar-Test-Signature FOUND\0" : "stream: OK\0");
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      process.env.CLAMAV_HOST = "127.0.0.1";
      process.env.CLAMAV_PORT = String(port);
      resolve({ close: () => new Promise<void>(done => server.close(() => done())) });
    });
  });
  db = await createDatabase(":memory:");
  pages = new Repository(db);
  await pages.seedLocal();
  for (const actor of [editor, viewer, outsider]) await db.query("INSERT INTO hs_users(id,name) VALUES($1,$2)", [actor.id, actor.id]);
  records = new SharedRecordRepository(pages, authority);
});
beforeEach(async () => {
  ctx = { actor: owner, tenantId: crypto.randomUUID(), workspaceId: "attach-" + crypto.randomUUID() };
  await db.query("INSERT INTO hs_workspaces(id,name) VALUES($1,$1)", [ctx.workspaceId]);
  for (const actor of [owner, editor, viewer]) await db.query("INSERT INTO hs_members(workspace_id,user_id) VALUES($1,$2)", [ctx.workspaceId, actor.id]);
  await db.query("INSERT INTO hs_data_tenants(id,name) VALUES($1,'Acme Health')", [ctx.tenantId]);
  await db.query("INSERT INTO hs_data_workspaces(workspace_id,tenant_id,review_reference) VALUES($1,$2,'synthetic')", [ctx.workspaceId, ctx.tenantId]);
  await db.query("INSERT INTO hs_data_collections(tenant_id,id,name,core) VALUES($1,'organisations','Clients',true)", [ctx.tenantId]);
  await db.query("INSERT INTO hs_data_collection_grants(tenant_id,user_id,collection,capabilities) VALUES($1,$2,'organisations',$3)", [ctx.tenantId, owner.id, [...recordCapabilities]]);
});
afterAll(async () => { await scanner.close(); await db.close(); });

async function version() {
  return Number((await db.query<{ schema_version: number }>("SELECT schema_version FROM hs_data_tenants WHERE id=$1", [ctx.tenantId])).rows[0].schema_version);
}
async function organisation(name: string) {
  return (await records.create(ctx, { operationId: crypto.randomUUID(), collection: "organisations", name, schemaVersion: await version(), values: {} })).record;
}
async function fileOn(recordId: string, name = "contract.pdf") {
  return registerLinkedFile(pages, owner, ctx.workspaceId, { operationId: crypto.randomUUID(), tenantId: ctx.tenantId, name, recordId });
}
async function upload(recordId: string, fileId: string, name: string, bytes: Uint8Array, note?: string, actor: Actor = owner) {
  const reserved = await reserveAttachmentVersion(pages, actor, ctx.workspaceId, { operationId: crypto.randomUUID(), tenantId: ctx.tenantId, recordId, fileId, name, size: bytes.length, note });
  return finishAttachmentVersion(pages, actor, ctx.workspaceId, { operationId: crypto.randomUUID(), tenantId: ctx.tenantId, recordId, reservationId: reserved.reservationId, bytes });
}
async function fail(run: () => Promise<unknown>) {
  try { await run(); return null; } catch (error) { return error as DocumentError; }
}
function shape(error: unknown) {
  const caught = error as DocumentError;
  return { status: caught.status, code: caught.code, message: caught.message };
}
function statements(sql: string) {
  const parts: string[] = [];
  let current = "";
  let dollar = false;
  for (const line of sql.split("\n")) {
    current += `${line}\n`;
    if ((line.split("$$").length - 1) % 2 === 1) dollar = !dollar;
    if (!dollar && line.trim().endsWith(";")) {
      const statement = current.trim();
      if (statement.replace(/^\s*--.*$/gm, "").trim()) parts.push(statement);
      current = "";
    }
  }
  return parts;
}

it("replays the version migration without a second attachment identity", async () => {
  const sql = await readFile("db/097_attachment_versions.sql", "utf8");
  const replay = statements(sql);
  for (const statement of replay) await db.query(statement);
  for (const statement of replay) await db.query(statement);
  expect((await db.query("SELECT to_regclass('public.hs_record_attachments') AS name")).rows[0].name).toBeNull();
  expect((await db.query("SELECT to_regclass('public.hs_attachment_versions') AS name")).rows[0].name).toBe("hs_attachment_versions");
});

it("scans a new version before it becomes current and keeps the previous one on every linked record", async () => {
  const [first, second] = [await organisation("R-100"), await organisation("R-101")];
  const registered = await fileOn(first.id);
  await linkDocumentRecord(pages, owner, ctx.workspaceId, { operationId: crypto.randomUUID(), tenantId: ctx.tenantId, docType: "file", docId: registered.fileId, recordId: second.id });
  const v1 = await upload(first.id, registered.fileId, "contract.txt", text("version one\n"), "signed copy");
  expect(v1).toMatchObject({ versionNo: 1, scanStatus: "clean", replayed: false });
  const again = await upload(first.id, registered.fileId, "contract.txt", text("version two\n"));
  expect(again.versionNo).toBe(2);
  await db.query("INSERT INTO hs_data_record_grants(tenant_id,record_id,user_id,capabilities) VALUES($1,$2,$3,$4)", [ctx.tenantId, first.id, editor.id, ["view", "edit", "history"]]);
  const editorList = await listAttachmentVersions(pages, editor, ctx.workspaceId, { tenantId: ctx.tenantId, recordId: first.id, fileId: registered.fileId });
  expect(editorList.currentVersionNo).toBe(2);
  expect(editorList.versions.map(item => item.versionNo).sort()).toEqual([1, 2]);
  const previous = editorList.versions.find(item => item.versionNo === 1);
  const current = editorList.versions.find(item => item.versionNo === 2);
  expect(previous).toMatchObject({ scanStatus: "clean", note: "signed copy" });
  expect(current).toMatchObject({ current: true, uploaderId: owner.id, size: text("version two\n").length });
  expect(current?.checksum).toHaveLength(64);
  expect(current?.atLabel).toContain("IST");
  expect(editorList.versions).toHaveLength(2);
  for (const record of [first, second]) {
    const documents = await listRecordDocuments(pages, owner, ctx.workspaceId, { tenantId: ctx.tenantId, recordId: record.id });
    expect(documents.items).toEqual([expect.objectContaining({ docId: registered.fileId, title: "contract.pdf", currentVersionNo: 2 })]);
  }
  const history = await new SharedRecordHistoryRepository(pages, authority).listRecordHistory(ctx, second.id);
  expect(history.events.map(event => event.kind)).toContain("attachment-version-2");
  expect(history.events.find(event => event.kind === "attachment-version-2")?.actorId).toBe(owner.id);
  const audit = JSON.stringify((await db.query("SELECT action, after_value FROM hs_audit WHERE action LIKE 'attachment.%' AND actor_id=$1", [owner.id])).rows);
  expect(audit).toContain("attachment.version");
  expect(audit).not.toContain("contract.pdf");
  expect(audit).not.toContain("version two");
  const stored = await db.query<{ blob_key: string }>("SELECT blob_key FROM hs_attachment_versions WHERE file_id=$1", [registered.fileId]);
  expect(audit).not.toContain(stored.rows[0].blob_key);
  expect((await db.query("SELECT id FROM hs_attachment_versions WHERE file_id=$1", [registered.fileId])).rows).toHaveLength(2);
});

it("blocks malware, oversized files and disallowed types before they become versions", async () => {
  const record = await organisation("R-100");
  const registered = await fileOn(record.id);
  const infected = await fail(() => upload(record.id, registered.fileId, "eicar.txt", eicar));
  expect(shape(infected)).toEqual({ status: 422, code: "unsafe_file", message: "File failed security scan" });
  expect((await db.query("SELECT id FROM hs_attachment_versions WHERE file_id=$1", [registered.fileId])).rows).toEqual([]);
  const before = await db.query("SELECT id FROM hs_attachment_reservations WHERE file_id=$1", [registered.fileId]);
  const oversized = await fail(() => reserveAttachmentVersion(pages, owner, ctx.workspaceId, { operationId: crypto.randomUUID(), tenantId: ctx.tenantId, recordId: record.id, fileId: registered.fileId, name: "big.pdf", size: 50_000_001 }));
  expect(shape(oversized)).toMatchObject({ status: 413, code: "file_too_large", message: "This file exceeds the 50 MB limit" });
  const mime = await fail(() => reserveAttachmentVersion(pages, owner, ctx.workspaceId, { operationId: crypto.randomUUID(), tenantId: ctx.tenantId, recordId: record.id, fileId: registered.fileId, name: "payload.exe", size: 12 }));
  expect(shape(mime).message).toBe("Unsupported file name or type");
  expect((await db.query("SELECT id FROM hs_attachment_reservations WHERE file_id=$1", [registered.fileId])).rows).toHaveLength(before.rows.length);
  expect((await listAttachmentVersions(pages, owner, ctx.workspaceId, { tenantId: ctx.tenantId, recordId: record.id, fileId: registered.fileId })).versions).toEqual([]);
});

it("restores a previous version as the next linear copy", async () => {
  const record = await organisation("R-100");
  const registered = await fileOn(record.id);
  await upload(record.id, registered.fileId, "contract.txt", text("one\n"));
  await upload(record.id, registered.fileId, "contract.txt", text("two\n"));
  await upload(record.id, registered.fileId, "contract.txt", text("three\n"));
  const restored = await restoreAttachmentVersion(pages, owner, ctx.workspaceId, { operationId: crypto.randomUUID(), tenantId: ctx.tenantId, recordId: record.id, fileId: registered.fileId, versionNo: 1 });
  expect(restored).toMatchObject({ versionNo: 4, note: "Restored from v1", replayed: false });
  const listed = await listAttachmentVersions(pages, owner, ctx.workspaceId, { tenantId: ctx.tenantId, recordId: record.id, fileId: registered.fileId });
  expect(listed.versions.map(item => item.versionNo).sort()).toEqual([1, 2, 3, 4]);
  expect(listed.currentVersionNo).toBe(4);
  const checksums = Object.fromEntries(listed.versions.map(item => [item.versionNo, item.checksum]));
  expect(checksums[4]).toBe(checksums[1]);
  expect((await db.query("SELECT id FROM hs_attachment_versions WHERE file_id=$1 AND deleted_at IS NULL", [registered.fileId])).rows).toHaveLength(4);
  const history = await new SharedRecordHistoryRepository(pages, authority).listRecordHistory(ctx, record.id);
  expect(history.events.map(event => event.kind)).toContain("attachment-restore-4");
});

it("follows the current version and keeps a pinned version labelled not latest", async () => {
  const record = await organisation("R-100");
  const registered = await fileOn(record.id);
  const space = (await pages.createSpace(owner, "Ops " + crypto.randomUUID().slice(0, 8), ctx.workspaceId)).id;
  const page = await pages.create(owner, "Evidence", space);
  await upload(record.id, registered.fileId, "contract.txt", text("v1\n"));
  await upload(record.id, registered.fileId, "contract.txt", text("v2\n"));
  await pinAttachmentReference(pages, owner, ctx.workspaceId, { operationId: crypto.randomUUID(), tenantId: ctx.tenantId, recordId: record.id, fileId: registered.fileId, sourceKind: "page", sourceId: page.id, versionNo: 2 });
  await upload(record.id, registered.fileId, "contract.txt", text("v3\n"));
  await upload(record.id, registered.fileId, "contract.txt", text("v4\n"));
  const current = await openAttachmentReference(pages, owner, ctx.workspaceId, { tenantId: ctx.tenantId, recordId: record.id, fileId: registered.fileId, sourceKind: "page", sourceId: page.id });
  const pinned = await openAttachmentReference(pages, owner, ctx.workspaceId, { tenantId: ctx.tenantId, recordId: record.id, fileId: registered.fileId, versionNo: 2 });
  expect(current).toMatchObject({ versionNo: 2, currentVersionNo: 4, notLatest: true, label: "Not latest", pinLabel: "@v2" });
  expect(pinned).toMatchObject({ versionNo: 2, label: "Not latest", pinLabel: "@v2" });
  const followed = await openAttachmentReference(pages, owner, ctx.workspaceId, { tenantId: ctx.tenantId, recordId: record.id, fileId: registered.fileId });
  expect(followed).toMatchObject({ versionNo: 4, notLatest: false, label: null, pinLabel: null });
});

it("soft-deletes a version for thirty days and refuses to delete the current one without a replacement", async () => {
  const record = await organisation("R-100");
  const registered = await fileOn(record.id);
  await upload(record.id, registered.fileId, "contract.txt", text("one\n"));
  await upload(record.id, registered.fileId, "contract.txt", text("two\n"));
  await upload(record.id, registered.fileId, "contract.txt", text("three\n"));
  const blocked = await fail(() => deleteAttachmentVersion(pages, owner, ctx.workspaceId, { operationId: crypto.randomUUID(), tenantId: ctx.tenantId, recordId: record.id, fileId: registered.fileId, versionNo: 3, reason: "wrong file" }));
  expect(shape(blocked)).toMatchObject({ status: 422, code: "attachment_current_required" });
  await deleteAttachmentVersion(pages, owner, ctx.workspaceId, { operationId: crypto.randomUUID(), tenantId: ctx.tenantId, recordId: record.id, fileId: registered.fileId, versionNo: 2, reason: "wrong file" });
  const hidden = await listAttachmentVersions(pages, owner, ctx.workspaceId, { tenantId: ctx.tenantId, recordId: record.id, fileId: registered.fileId });
  expect(hidden.versions.map(item => item.versionNo)).not.toContain(2);
  const retained = await db.query<{ purge_after: string; deleted_at: string }>("SELECT purge_after, deleted_at FROM hs_attachment_versions WHERE file_id=$1 AND version_no=2", [registered.fileId]);
  expect(new Date(retained.rows[0].purge_after).getTime() - new Date(retained.rows[0].deleted_at).getTime()).toBeGreaterThan(29 * 24 * 60 * 60 * 1000);
  await db.query("UPDATE hs_members SET role='admin' WHERE workspace_id=$1 AND user_id=$2", [ctx.workspaceId, owner.id]);
  const admin = await listAttachmentVersions(pages, owner, ctx.workspaceId, { tenantId: ctx.tenantId, recordId: record.id, fileId: registered.fileId });
  expect(admin.versions.find(item => item.versionNo === 2)).toMatchObject({ deleted: true, deleteReason: "wrong file" });
  await deleteAttachmentVersion(pages, owner, ctx.workspaceId, { operationId: crypto.randomUUID(), tenantId: ctx.tenantId, recordId: record.id, fileId: registered.fileId, versionNo: 3, reason: "replace current", successorVersionNo: 1 });
  expect((await listAttachmentVersions(pages, owner, ctx.workspaceId, { tenantId: ctx.tenantId, recordId: record.id, fileId: registered.fileId })).currentVersionNo).toBe(1);
  const history = await new SharedRecordHistoryRepository(pages, authority).listRecordHistory(ctx, record.id);
  expect(history.events.map(event => event.kind)).toEqual(expect.arrayContaining(["attachment-delete-2", "attachment-delete-3"]));
  const audit = JSON.stringify((await db.query("SELECT after_value FROM hs_audit WHERE action='attachment.delete' AND actor_id=$1", [owner.id])).rows);
  expect(audit).not.toContain("wrong file");
});

it("issues a session-bound download of at most five minutes and refuses a later or foreign session", async () => {
  const record = await organisation("R-100");
  const registered = await fileOn(record.id);
  await db.query("INSERT INTO hs_data_record_grants(tenant_id,record_id,user_id,capabilities) VALUES($1,$2,$3,$4)", [ctx.tenantId, record.id, viewer.id, ["view"]]);
  await upload(record.id, registered.fileId, "notes.txt", text("readable\n"));
  const operationId = crypto.randomUUID();
  const issued = await issueAttachmentDownload(pages, viewer, ctx.workspaceId, { operationId, tenantId: ctx.tenantId, recordId: record.id, fileId: registered.fileId, versionNo: 1, sessionKey: "session-a" });
  const replay = await issueAttachmentDownload(pages, viewer, ctx.workspaceId, { operationId, tenantId: ctx.tenantId, recordId: record.id, fileId: registered.fileId, versionNo: 1, sessionKey: "session-a" });
  expect(replay).toMatchObject({ replayed: true, url: issued.url });
  const token = issued.url.split("/").at(-1) ?? "";
  const file = await redeemAttachmentDownload(pages, viewer, ctx.workspaceId, token, "session-a");
  expect(new TextDecoder().decode(file.bytes)).toBe("readable\n");
  const lifetime = await db.query<{ ok: boolean }>("SELECT expires_at <= created_at + interval '5 minutes' AND expires_at > created_at + interval '4 minutes' AS ok FROM hs_attachment_download_tokens WHERE actor_id=$1", [viewer.id]);
  expect(lifetime.rows[0].ok).toBe(true);
  await db.query("UPDATE hs_attachment_download_tokens SET expires_at=clock_timestamp() - interval '6 minutes', created_at=expires_at - interval '5 minutes' WHERE actor_id=$1", [viewer.id]);
  const expired = await fail(() => redeemAttachmentDownload(pages, viewer, ctx.workspaceId, token, "session-a"));
  const otherSession = await issueAttachmentDownload(pages, viewer, ctx.workspaceId, { operationId: crypto.randomUUID(), tenantId: ctx.tenantId, recordId: record.id, fileId: registered.fileId, versionNo: 1, sessionKey: "session-b" });
  const foreign = await fail(() => redeemAttachmentDownload(pages, viewer, ctx.workspaceId, otherSession.url.split("/").at(-1) ?? "", "session-a"));
  const random = await fail(() => redeemAttachmentDownload(pages, viewer, ctx.workspaceId, "a".repeat(43), "session-a"));
  expect(shape(expired)).toEqual(shape(random));
  expect(shape(foreign)).toEqual(shape(random));
  expect(shape(random)).toEqual({ status: 404, code: "not_found", message: "This item is restricted or unavailable." });
  const denied = attachmentDeniedResponse(random as DocumentError);
  expect(denied.headers.get("content-disposition")).toBeNull();
  expect(denied.headers.get("content-type")).not.toContain("filename");
  const audit = JSON.stringify((await db.query("SELECT after_value FROM hs_audit WHERE action='attachment.download' AND actor_id=$1", [viewer.id])).rows);
  expect(audit).not.toContain(token);
  expect(audit).not.toContain("notes.txt");
});

it("releases an upload and refuses a download after access is revoked", async () => {
  const record = await organisation("R-200");
  const registered = await fileOn(record.id);
  await upload(record.id, registered.fileId, "notes.txt", text("kept\n"));
  await db.query("INSERT INTO hs_data_record_grants(tenant_id,record_id,user_id,capabilities) VALUES($1,$2,$3,$4)", [ctx.tenantId, record.id, editor.id, ["view", "edit"]]);
  const reserved = await reserveAttachmentVersion(pages, editor, ctx.workspaceId, { operationId: crypto.randomUUID(), tenantId: ctx.tenantId, recordId: record.id, fileId: registered.fileId, name: "notes.txt", size: 4 });
  await db.query("DELETE FROM hs_data_record_grants WHERE tenant_id=$1 AND user_id=$2", [ctx.tenantId, editor.id]);
  const revoked = await fail(() => finishAttachmentVersion(pages, editor, ctx.workspaceId, { operationId: crypto.randomUUID(), tenantId: ctx.tenantId, recordId: record.id, reservationId: reserved.reservationId, bytes: text("nope") }));
  expect(shape(revoked)).toEqual({ status: 404, code: "not_found", message: "This item is restricted or unavailable." });
  expect((await db.query<{ state: string }>("SELECT state FROM hs_attachment_reservations WHERE id=$1", [reserved.reservationId])).rows[0].state).toBe("released");
  expect((await db.query("SELECT id FROM hs_attachment_versions WHERE file_id=$1", [registered.fileId])).rows).toHaveLength(1);
  await db.query("INSERT INTO hs_data_record_grants(tenant_id,record_id,user_id,capabilities) VALUES($1,$2,$3,$4)", [ctx.tenantId, record.id, editor.id, ["view"]]);
  const issued = await issueAttachmentDownload(pages, editor, ctx.workspaceId, { operationId: crypto.randomUUID(), tenantId: ctx.tenantId, recordId: record.id, fileId: registered.fileId, versionNo: 1, sessionKey: "session-ed" });
  await db.query("DELETE FROM hs_data_record_grants WHERE tenant_id=$1 AND user_id=$2", [ctx.tenantId, editor.id]);
  const refused = await fail(() => redeemAttachmentDownload(pages, editor, ctx.workspaceId, issued.url.split("/").at(-1) ?? "", "session-ed"));
  const missing = await fail(() => redeemAttachmentDownload(pages, editor, ctx.workspaceId, "b".repeat(43), "session-ed"));
  expect(shape(refused)).toEqual(shape(missing));
});

it("hides an archived record from readers and tells a restorer it is archived", async () => {
  const record = await organisation("R-300");
  const registered = await fileOn(record.id);
  await upload(record.id, registered.fileId, "notes.txt", text("archived\n"));
  await db.query("UPDATE hs_data_records SET state='archived' WHERE id=$1", [record.id]);
  await db.query("INSERT INTO hs_data_record_grants(tenant_id,record_id,user_id,capabilities) VALUES($1,$2,$3,$4)", [ctx.tenantId, record.id, viewer.id, ["view"]]);
  const reader = await fail(() => listAttachmentVersions(pages, viewer, ctx.workspaceId, { tenantId: ctx.tenantId, recordId: record.id, fileId: registered.fileId }));
  const random = await fail(() => listAttachmentVersions(pages, viewer, ctx.workspaceId, { tenantId: ctx.tenantId, recordId: crypto.randomUUID(), fileId: registered.fileId }));
  expect(shape(reader)).toEqual(shape(random));
  const restorer = await fail(() => listAttachmentVersions(pages, owner, ctx.workspaceId, { tenantId: ctx.tenantId, recordId: record.id, fileId: registered.fileId }));
  expect(shape(restorer)).toEqual({ status: 409, code: "record_archived", message: "Record archived" });
});

it("returns one not-found shape for outsiders, foreign ids and direct storage keys", async () => {
  const record = await organisation("R-200");
  const registered = await fileOn(record.id);
  await upload(record.id, registered.fileId, "secret.txt", text("secret\n"));
  const blob = (await db.query<{ blob_key: string }>("SELECT blob_key FROM hs_attachment_versions WHERE file_id=$1", [registered.fileId])).rows[0].blob_key;
  const outsiderFile = await fail(() => listAttachmentVersions(pages, outsider, ctx.workspaceId, { tenantId: ctx.tenantId, recordId: record.id, fileId: registered.fileId }));
  const outsiderRandom = await fail(() => listAttachmentVersions(pages, outsider, ctx.workspaceId, { tenantId: ctx.tenantId, recordId: crypto.randomUUID(), fileId: crypto.randomUUID() }));
  const byBlob = await fail(() => listAttachmentVersions(pages, owner, ctx.workspaceId, { tenantId: ctx.tenantId, recordId: record.id, fileId: blob }));
  const byRandom = await fail(() => listAttachmentVersions(pages, owner, ctx.workspaceId, { tenantId: ctx.tenantId, recordId: record.id, fileId: crypto.randomUUID() }));
  expect(shape(outsiderFile)).toEqual(shape(outsiderRandom));
  expect(shape(byBlob)).toEqual(shape(byRandom));
  expect(shape(byRandom)).toEqual({ status: 404, code: "not_found", message: "This item is restricted or unavailable." });
  expect(JSON.stringify([outsiderFile, byBlob])).not.toContain("secret");
  expect(shape(await fail(async () => assertNoDirectStorageKey({ blobKey: blob })))).toEqual(shape(byRandom));
  const viewerDenied = await fail(async () => {
    await db.query("INSERT INTO hs_data_record_grants(tenant_id,record_id,user_id,capabilities) VALUES($1,$2,$3,$4)", [ctx.tenantId, record.id, viewer.id, ["view"]]);
    return reserveAttachmentVersion(pages, viewer, ctx.workspaceId, { operationId: crypto.randomUUID(), tenantId: ctx.tenantId, recordId: record.id, fileId: registered.fileId, name: "notes.txt", size: 4 });
  });
  expect(shape(viewerDenied)).toMatchObject({ status: 403, code: "attachment_forbidden" });
});
