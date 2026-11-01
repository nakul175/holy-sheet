import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Actor } from "./auth";
import { identityTokenFromRequest } from "./auth";
import type { Sql } from "./database";
import { DocumentError } from "./document";
import { formatIst } from "./ist-label";
import { deleteObject, getObject, putObject, scanBytes, validateMediaBytes, validateMediaMetadata } from "./media";
import type { Repository } from "./repository";
import { recordHash } from "./shared-record-types";

export const attachmentByteLimit = 50_000_000;
const unavailable = () => new DocumentError("This item is restricted or unavailable.", "not_found", 404);
const archived = () => new DocumentError("Record archived", "record_archived", 409);
const refused = () => new DocumentError("This action is not permitted.", "attachment_forbidden", 403);
const mismatch = () => new DocumentError("This attachment attempt was reused with different fields.", "operation_mismatch", 409);
const invalid = () => new DocumentError("Check the attachment request.", "attachment_validation", 400);
const currentRequired = () => new DocumentError("Choose another current version before deleting this one.", "attachment_current_required", 422);
const scanFailed = () => new DocumentError("File failed security scan", "unsafe_file", 422);
const expired = () => new DocumentError("Upload reservation expired; select the file again.", "upload_expired", 409);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const pageIdPattern = /^[a-zA-Z0-9_-]{1,100}$/;
const fieldKeyPattern = /^[A-Za-z0-9:_-]{1,100}$/;
const storageKeyNames = new Set(["key", "blobkey", "objectkey", "storagekey", "blob_key", "object_key", "storage_key"]);

type Scope = { workspaceId: string; tenantId: string; role: string };
type RecordAccess = { id: string; state: string; can_view: boolean; can_edit: boolean; can_restore: boolean };
type FileRow = { id: string; name: string; current_version_id: string | null; field_key: string | null; deleted_at: string | null };
type VersionRow = {
  id: string;
  file_id: string;
  version_no: number | string;
  blob_key: string;
  checksum: string;
  size: number | string;
  mime: string;
  name: string;
  scan_status: string;
  note: string | null;
  uploader_id: string;
  restored_from: number | string | null;
  deleted_at: string | null;
  delete_reason: string | null;
  purge_after: string | null;
  created_at: string;
};
type ReservationRow = {
  id: string;
  file_id: string;
  actor_id: string;
  record_id: string;
  name: string;
  mime: string;
  size: number | string;
  note: string | null;
  blob_key: string;
  checksum: string | null;
  state: string;
  release_reason: string | null;
  expires_at: string;
  workspace_id: string;
  tenant_id: string;
};

const grant = (capability: "view" | "edit" | "restore") => `(EXISTS(SELECT 1 FROM hs_data_collection_grants g WHERE g.tenant_id=r.tenant_id AND g.user_id=$3 AND g.collection=r.collection AND '${capability}'=ANY(g.capabilities)) OR EXISTS(SELECT 1 FROM hs_data_record_grants g WHERE g.tenant_id=r.tenant_id AND g.record_id=r.id AND g.user_id=$3 AND '${capability}'=ANY(g.capabilities)))`;

export function assertNoDirectStorageKey(value: unknown) {
  if (!value || typeof value !== "object") return;
  for (const key of Object.keys(value)) if (storageKeyNames.has(key.toLowerCase())) throw unavailable();
}

export function attachmentSessionKey(request: Request) {
  const credential = identityTokenFromRequest(request) ?? "";
  if (credential) return createHash("sha256").update(credential).digest("hex");
  const cookie = request.headers.get("cookie") ?? "";
  if (cookie) return createHash("sha256").update(cookie).digest("hex");
  return "local-preview";
}

export function attachmentDeniedResponse(error: DocumentError) {
  const headers = new Headers({ "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", Vary: "Cookie, Authorization" });
  return Response.json({ error: error.message, code: error.code, retryable: error.status >= 500 }, { status: error.status, headers });
}

function checksumOf(bytes: Uint8Array) {
  return createHash("sha256").update(bytes).digest("hex");
}

function asRecord(value: unknown) {
  if (typeof value === "string") return JSON.parse(value) as Record<string, unknown>;
  return (value ?? {}) as Record<string, unknown>;
}

function cleanNote(value: string | undefined, required = false) {
  if (value === undefined || value.trim() === "") {
    if (required) throw invalid();
    return null;
  }
  const note = value.trim().normalize("NFC");
  if (Array.from(note).length > 500 || /[\p{Cc}]/u.test(note)) throw invalid();
  return note;
}

function versionView(row: VersionRow, currentId: string | null) {
  const deleted = Boolean(row.deleted_at);
  return {
    id: row.id,
    versionNo: Number(row.version_no),
    uploaderId: row.uploader_id,
    at: new Date(row.created_at).toISOString(),
    atLabel: formatIst(row.created_at),
    size: Number(row.size),
    checksum: row.checksum,
    note: row.note,
    scanStatus: row.scan_status,
    name: row.name,
    current: row.id === currentId,
    deleted,
    purgeAfterLabel: row.purge_after ? formatIst(row.purge_after) : null,
    deleteReason: deleted ? row.delete_reason : null,
  };
}

function retained(row: VersionRow, privileged: boolean) {
  if (!row.deleted_at) return true;
  if (!privileged || !row.purge_after) return false;
  return new Date(row.purge_after).getTime() > Date.now();
}

async function scope(tx: Sql, workspaceId: string, actor: Actor, tenantId?: string): Promise<Scope> {
  if (!workspaceId || workspaceId.length > 200) throw unavailable();
  const row = await tx.query<{ tenant_id: string | null; role: string }>(
    `SELECT b.tenant_id, m.role FROM hs_workspaces w
     JOIN hs_members m ON m.workspace_id=w.id AND m.user_id=$2 AND m.active=true
     LEFT JOIN hs_data_workspaces b ON b.workspace_id=w.id
     WHERE w.id=$1`,
    [workspaceId, actor.id],
  );
  const found = row.rows[0];
  if (!found?.tenant_id) throw unavailable();
  if (tenantId && tenantId !== found.tenant_id) throw unavailable();
  return { workspaceId, tenantId: found.tenant_id, role: found.role };
}

async function prior(tx: Sql, here: Scope, actorId: string, operationId: string, requestHash: string, kind: string) {
  const row = await tx.query<{ request_hash: string; kind: string; result: unknown }>(
    "SELECT request_hash, kind, result FROM hs_attachment_operations WHERE workspace_id=$1 AND actor_id=$2 AND operation_id=$3",
    [here.workspaceId, actorId, operationId],
  );
  const found = row.rows[0];
  if (!found) return null;
  if (found.request_hash !== requestHash || found.kind !== kind) throw mismatch();
  return asRecord(found.result);
}

async function remember(tx: Sql, here: Scope, actorId: string, operationId: string, requestHash: string, kind: string, result: Record<string, unknown>) {
  await tx.query(
    "INSERT INTO hs_attachment_operations(workspace_id,actor_id,operation_id,request_hash,kind,result) VALUES($1,$2,$3,$4,$5,$6)",
    [here.workspaceId, actorId, operationId, requestHash, kind, JSON.stringify(result)],
  );
}

async function audit(tx: Sql, actor: Actor, action: string, operationId: string, after: Record<string, unknown>) {
  await tx.query(
    "INSERT INTO hs_audit(id,actor_id,action,after_value,correlation_id) VALUES($1,$2,$3,$4,$5)",
    [randomUUID(), actor.id, action, JSON.stringify(after), operationId],
  );
}

async function gate(tx: Sql, here: Scope, actor: Actor, recordId: string, fileId: string, mode: "view" | "edit") {
  if (!uuidPattern.test(recordId) || !uuidPattern.test(fileId)) throw unavailable();
  const record = await tx.query<RecordAccess>(
    `SELECT r.id, r.state, ${grant("view")} AS can_view, ${grant("edit")} AS can_edit, ${grant("restore")} AS can_restore
     FROM hs_data_records r WHERE r.id=$1 AND r.tenant_id=$2 AND r.merged_into_id IS NULL`,
    [recordId, here.tenantId, actor.id],
  );
  const found = record.rows[0];
  if (!found) throw unavailable();
  if (found.state !== "active") {
    if (found.can_restore) throw archived();
    throw unavailable();
  }
  if (!found.can_view) throw unavailable();
  const file = await tx.query<FileRow>(
    "SELECT id, name, current_version_id, field_key, deleted_at FROM hs_linked_files WHERE id=$1 AND tenant_id=$2 FOR UPDATE",
    [fileId, here.tenantId],
  );
  const linkedFile = file.rows[0];
  if (!linkedFile || linkedFile.deleted_at) throw unavailable();
  const link = await tx.query(
    "SELECT id FROM hs_document_record_links WHERE workspace_id=$1 AND tenant_id=$2 AND doc_type='file' AND doc_id=$3 AND record_id=$4",
    [here.workspaceId, here.tenantId, fileId, recordId],
  );
  if (!link.rows.length) throw unavailable();
  const privileged = here.role === "owner" || here.role === "admin";
  if (mode === "edit" && !found.can_edit) throw refused();
  return { record: found, file: linkedFile, privileged };
}

async function versions(tx: Sql, fileId: string, tenantId: string) {
  const rows = await tx.query<VersionRow>(
    "SELECT * FROM hs_attachment_versions WHERE file_id=$1 AND tenant_id=$2 ORDER BY version_no DESC",
    [fileId, tenantId],
  );
  return rows.rows;
}

async function writeHistory(tx: Sql, here: Scope, actor: Actor, fileId: string, operationId: string, kind: string) {
  const links = await tx.query<{ record_id: string }>(
    "SELECT record_id FROM hs_document_record_links WHERE workspace_id=$1 AND tenant_id=$2 AND doc_type='file' AND doc_id=$3 ORDER BY record_id",
    [here.workspaceId, here.tenantId, fileId],
  );
  for (const link of links.rows) {
    const current = await tx.query<{ id: string; name: string; field_values: unknown; parent_organisation_id: string | null; state: string }>(
      "SELECT id, name, field_values, parent_organisation_id, state FROM hs_data_records WHERE id=$1 AND tenant_id=$2 AND state<>'trashed' AND merged_into_id IS NULL FOR UPDATE",
      [link.record_id, here.tenantId],
    );
    const before = current.rows[0];
    if (!before) continue;
    const next = await tx.query<{ version: number; name: string; field_values: unknown; parent_organisation_id: string | null; state: string; collection: string }>(
      "UPDATE hs_data_records SET version=version+1, updated_by=$3, updated_at=clock_timestamp() WHERE id=$1 AND tenant_id=$2 RETURNING version, name, field_values, parent_organisation_id, state, collection",
      [before.id, here.tenantId, actor.id],
    );
    const row = next.rows[0];
    if (!row) continue;
    const eventId = randomUUID();
    const beforeSnap = { name: before.name, values: asRecord(before.field_values), parentOrganisationId: before.parent_organisation_id, state: before.state };
    const afterSnap = { name: row.name, values: asRecord(row.field_values), parentOrganisationId: row.parent_organisation_id, state: row.state };
    await tx.query(
      "INSERT INTO hs_data_events(id,tenant_id,record_id,record_version,actor_id,source_app,operation_id,kind,before_value,after_value,field_policy) VALUES($1,$2,$3,$4,$5,'holy-sheet',$6,$7,$8,$9,'{}')",
      [eventId, here.tenantId, before.id, row.version, actor.id, operationId, kind, JSON.stringify(beforeSnap), JSON.stringify(afterSnap)],
    );
    await tx.query(
      "INSERT INTO hs_data_change_events(id,tenant_id,record_id,record_version,collection,operation_id,source_app,actor_id,kind) VALUES($1,$2,$3,$4,$5,$6,'holy-sheet',$7,$8)",
      [eventId, here.tenantId, before.id, row.version, row.collection, operationId, actor.id, kind],
    );
  }
}

async function addVersion(tx: Sql, here: Scope, actor: Actor, file: FileRow, input: { blobKey: string; checksum: string; size: number; mime: string; name: string; note: string | null; restoredFrom: number | null; fieldKey: string | null }) {
  if (input.fieldKey && file.field_key && input.fieldKey !== file.field_key) throw invalid();
  const number = Number((await tx.query<{ n: number }>("SELECT COALESCE(MAX(version_no),0)::int AS n FROM hs_attachment_versions WHERE file_id=$1", [file.id])).rows[0].n) + 1;
  const id = randomUUID();
  await tx.query(
    `INSERT INTO hs_attachment_versions(id,file_id,workspace_id,tenant_id,version_no,blob_key,checksum,size,mime,name,scan_status,note,uploader_id,restored_from,scanned_at)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'clean',$11,$12,$13,clock_timestamp())`,
    [id, file.id, here.workspaceId, here.tenantId, number, input.blobKey, input.checksum, input.size, input.mime, input.name, input.note, actor.id, input.restoredFrom],
  );
  await tx.query(
    "UPDATE hs_linked_files SET current_version_id=$2, updated_at=clock_timestamp(), field_key=CASE WHEN field_key IS NULL THEN $3 ELSE field_key END WHERE id=$1",
    [file.id, id, input.fieldKey],
  );
  return { id, versionNo: number };
}

type ReserveResult = { reservationId: string; fileId: string; expiresAt: string; replayed: boolean };
type VersionResult = { versionId: string; versionNo: number; checksum: string; size: number; note: string | null; scanStatus: "clean"; replayed: boolean };
type DeleteResult = { deleted: true; versionNo: number; successorVersionNo: number | null; replayed: boolean };
type PinResult = { pinId: string; fileId: string; versionNo: number | null; pinLabel: string | null; replayed: boolean };
type DownloadResult = { url: string; expiresAt: string; versionNo: number; versionId: string; replayed: boolean };

function asReplay<T>(value: Record<string, unknown>): T {
  return { ...value, replayed: true } as T;
}

function denialError(code: string) {
  if (code === "unsafe_file") return scanFailed();
  if (code === "attachment_forbidden") return refused();
  if (code === "record_archived") return archived();
  return unavailable();
}

function published(version: { id: string; versionNo: number }, checksum: string, size: number, note: string | null) {
  return { versionId: version.id, versionNo: version.versionNo, checksum, size, note, scanStatus: "clean" as const, replayed: false };
}

export async function listAttachmentVersions(pages: Repository, actor: Actor, workspaceId: string, input: { tenantId?: string; recordId: string; fileId: string }) {
  return pages.db.transaction(async tx => {
    const here = await scope(tx, workspaceId, actor, input.tenantId);
    const access = await gate(tx, here, actor, input.recordId, input.fileId, "view");
    const rows = await versions(tx, access.file.id, here.tenantId);
    const items = rows.map(row => retained(row, access.privileged) ? versionView(row, access.file.current_version_id) : null).filter((row): row is NonNullable<typeof row> => Boolean(row));
    const current = items.find(item => item.current) ?? null;
    return {
      fileId: access.file.id,
      name: access.file.name,
      currentVersionNo: current?.versionNo ?? null,
      canUpload: access.record.can_edit,
      versions: items,
    };
  });
}

export async function reserveAttachmentVersion(pages: Repository, actor: Actor, workspaceId: string, input: { operationId: string; tenantId?: string; recordId: string; fileId: string; name: string; size: number; note?: string; fieldKey?: string }): Promise<ReserveResult> {
  if (!uuidPattern.test(input.operationId)) throw invalid();
  const note = cleanNote(input.note);
  const fieldKey = input.fieldKey ? (fieldKeyPattern.test(input.fieldKey) ? input.fieldKey : (() => { throw invalid(); })()) : null;
  const meta = validateMediaMetadata(input.name, input.size, attachmentByteLimit);
  const requestHash = recordHash({ kind: "reserve", recordId: input.recordId, fileId: input.fileId, name: input.name, size: input.size, note, fieldKey, tenantId: input.tenantId ?? null });
  return pages.db.transaction(async tx => {
    const here = await scope(tx, workspaceId, actor, input.tenantId);
    const replay = await prior(tx, here, actor.id, input.operationId, requestHash, "reserve");
    if (replay) return asReplay<ReserveResult>(replay);
    const access = await gate(tx, here, actor, input.recordId, input.fileId, "edit");
    if (fieldKey && access.file.field_key && fieldKey !== access.file.field_key) throw invalid();
    if (fieldKey && !access.file.field_key) await tx.query("UPDATE hs_linked_files SET field_key=$2 WHERE id=$1", [access.file.id, fieldKey]);
    const reservationId = randomUUID();
    const blobKey = randomUUID();
    const expires = await tx.query<{ expires_at: string }>(
      `INSERT INTO hs_attachment_reservations(id,file_id,workspace_id,tenant_id,actor_id,operation_id,record_id,name,mime,size,note,blob_key,state,expires_at)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'reserved',clock_timestamp()+interval '30 minutes') RETURNING expires_at`,
      [reservationId, access.file.id, here.workspaceId, here.tenantId, actor.id, input.operationId, input.recordId, input.name, meta.mime, input.size, note, blobKey],
    );
    const result = { reservationId, fileId: access.file.id, expiresAt: new Date(expires.rows[0].expires_at).toISOString(), replayed: false };
    await remember(tx, here, actor.id, input.operationId, requestHash, "reserve", result);
    await audit(tx, actor, "attachment.reserve", input.operationId, { workspaceId: here.workspaceId, fileId: access.file.id, recordId: input.recordId, reservationId, size: input.size, mime: meta.mime, notePresent: Boolean(note) });
    return result;
  });
}

async function reservation(tx: Sql, here: Scope, actor: Actor, reservationId: string) {
  if (!uuidPattern.test(reservationId)) throw unavailable();
  const row = await tx.query<ReservationRow>("SELECT * FROM hs_attachment_reservations WHERE id=$1 AND workspace_id=$2 AND tenant_id=$3 FOR UPDATE", [reservationId, here.workspaceId, here.tenantId]);
  const found = row.rows[0];
  if (!found || found.actor_id !== actor.id) throw unavailable();
  return found;
}

export async function finishAttachmentVersion(pages: Repository, actor: Actor, workspaceId: string, input: { operationId: string; tenantId?: string; recordId: string; reservationId: string; bytes: Uint8Array }): Promise<VersionResult> {
  if (!uuidPattern.test(input.operationId) || !uuidPattern.test(input.recordId)) throw invalid();
  const checksum = checksumOf(input.bytes);
  const requestHash = recordHash({ kind: "finish", reservationId: input.reservationId, recordId: input.recordId, checksum, size: input.bytes.length, tenantId: input.tenantId ?? null });
  const prepared = await pages.db.transaction(async tx => {
    const here = await scope(tx, workspaceId, actor, input.tenantId);
    const replay = await prior(tx, here, actor.id, input.operationId, requestHash, "finish");
    if (replay?.rejected) return { denied: String(replay.code ?? "not_found") };
    if (replay?.versionId) return { replay };
    const reserved = await reservation(tx, here, actor, input.reservationId);
    if (reserved.record_id !== input.recordId) throw unavailable();
    if (new Date(reserved.expires_at).getTime() <= Date.now()) throw expired();
    if (reserved.state === "released") return { denied: reserved.release_reason === "unsafe" ? "unsafe_file" : "not_found" };
    if (reserved.state === "consumed") throw unavailable();
    if (Number(reserved.size) !== input.bytes.length) throw new DocumentError("Upload length differs from reserved size");
    if (reserved.checksum && reserved.checksum !== checksum) throw mismatch();
    let denial: string | null = null;
    try { await gate(tx, here, actor, input.recordId, reserved.file_id, "edit"); } catch (error) {
      if (!(error instanceof DocumentError)) throw error;
      if (error.code !== "not_found" && error.code !== "attachment_forbidden" && error.code !== "record_archived") throw error;
      denial = error.code;
    }
    if (denial) {
      await tx.query("UPDATE hs_attachment_reservations SET state='released', release_reason='revoked' WHERE id=$1", [reserved.id]);
      await remember(tx, here, actor.id, input.operationId, requestHash, "finish", { rejected: true, code: denial });
      await audit(tx, actor, "attachment.release", input.operationId, { workspaceId: here.workspaceId, fileId: reserved.file_id, recordId: input.recordId, reservationId: reserved.id, reason: "revoked" });
      return { denied: denial };
    }
    await tx.query("UPDATE hs_attachment_reservations SET state='scanning', checksum=$2 WHERE id=$1", [reserved.id, checksum]);
    return { reserved, note: reserved.note };
  });
  if ("denied" in prepared && prepared.denied) throw denialError(String(prepared.denied));
  if ("replay" in prepared && prepared.replay) return asReplay<VersionResult>(prepared.replay);
  const ready = prepared as { reserved: ReservationRow; note: string | null };
  let mime: string;
  try { mime = await validateMediaBytes(ready.reserved.name, input.bytes, attachmentByteLimit); } catch (error) {
    await pages.db.transaction(async tx => { await tx.query("UPDATE hs_attachment_reservations SET state='reserved', checksum=NULL WHERE id=$1 AND state='scanning'", [ready.reserved.id]); });
    throw error;
  }
  await putObject(ready.reserved.blob_key, input.bytes, mime);
  try { await scanBytes(input.bytes); } catch (error) {
    const unsafe = error instanceof DocumentError && error.code === "unsafe_file";
    await deleteObject(ready.reserved.blob_key).catch(() => undefined);
    if (unsafe) {
      await pages.db.transaction(async tx => {
        const here = await scope(tx, workspaceId, actor, input.tenantId);
        await tx.query("UPDATE hs_attachment_reservations SET state='released', release_reason='unsafe' WHERE id=$1", [ready.reserved.id]);
        const existing = await prior(tx, here, actor.id, input.operationId, requestHash, "finish");
        if (!existing) {
          await remember(tx, here, actor.id, input.operationId, requestHash, "finish", { rejected: true, code: "unsafe_file" });
          await audit(tx, actor, "attachment.reject", input.operationId, { workspaceId: here.workspaceId, fileId: ready.reserved.file_id, recordId: input.recordId, reservationId: ready.reserved.id, reason: "unsafe" });
        }
      });
      throw scanFailed();
    }
    await pages.db.transaction(async tx => { await tx.query("UPDATE hs_attachment_reservations SET state='reserved', checksum=NULL WHERE id=$1 AND state='scanning'", [ready.reserved.id]); });
    throw error;
  }
  try {
    return await pages.db.transaction(async tx => {
      const here = await scope(tx, workspaceId, actor, input.tenantId);
      const replay = await prior(tx, here, actor.id, input.operationId, requestHash, "finish");
      if (replay?.versionId) return asReplay<VersionResult>(replay);
      const access = await gate(tx, here, actor, input.recordId, ready.reserved.file_id, "edit");
      const version = await addVersion(tx, here, actor, access.file, { blobKey: ready.reserved.blob_key, checksum, size: input.bytes.length, mime, name: ready.reserved.name, note: ready.note, restoredFrom: null, fieldKey: access.file.field_key });
      await tx.query("UPDATE hs_attachment_reservations SET state='consumed' WHERE id=$1", [ready.reserved.id]);
      await writeHistory(tx, here, actor, access.file.id, input.operationId, `attachment-version-${version.versionNo}`);
      const result = published(version, checksum, input.bytes.length, ready.note);
      await remember(tx, here, actor.id, input.operationId, requestHash, "finish", result);
      await audit(tx, actor, "attachment.version", input.operationId, { workspaceId: here.workspaceId, fileId: access.file.id, recordId: input.recordId, versionId: version.id, versionNo: version.versionNo, size: input.bytes.length, checksum, scanStatus: "clean" });
      return result;
    });
  } catch (error) {
    if (error instanceof DocumentError && (error.code === "not_found" || error.code === "attachment_forbidden" || error.code === "record_archived")) {
      await deleteObject(ready.reserved.blob_key).catch(() => undefined);
      await pages.db.transaction(async tx => {
        await tx.query("UPDATE hs_attachment_reservations SET state='released', release_reason='revoked' WHERE id=$1 AND state='scanning'", [ready.reserved.id]);
      });
    }
    throw error;
  }
}

export async function restoreAttachmentVersion(pages: Repository, actor: Actor, workspaceId: string, input: { operationId: string; tenantId?: string; recordId: string; fileId: string; versionNo: number }): Promise<VersionResult> {
  if (!uuidPattern.test(input.operationId) || !Number.isSafeInteger(input.versionNo) || input.versionNo < 1) throw invalid();
  const requestHash = recordHash({ kind: "restore", recordId: input.recordId, fileId: input.fileId, versionNo: input.versionNo, tenantId: input.tenantId ?? null });
  const source = await pages.db.transaction(async tx => {
    const here = await scope(tx, workspaceId, actor, input.tenantId);
    const replay = await prior(tx, here, actor.id, input.operationId, requestHash, "restore");
    if (replay) return { replay };
    const access = await gate(tx, here, actor, input.recordId, input.fileId, "edit");
    const rows = await versions(tx, access.file.id, here.tenantId);
    const match = rows.find(row => Number(row.version_no) === input.versionNo);
    if (!match || !retained(match, access.privileged) || match.deleted_at) throw unavailable();
    return { blobKey: match.blob_key, checksum: match.checksum, mime: match.mime, name: match.name, versionNo: Number(match.version_no) };
  });
  if ("replay" in source && source.replay) return asReplay<VersionResult>(source.replay);
  const bytes = await getObject(source.blobKey);
  if (checksumOf(bytes) !== source.checksum) throw new DocumentError("Attachment integrity changed. No bytes were delivered.", "media_integrity", 409);
  await scanBytes(bytes);
  const blobKey = randomUUID();
  await putObject(blobKey, bytes, source.mime);
  try {
    return await pages.db.transaction(async tx => {
      const here = await scope(tx, workspaceId, actor, input.tenantId);
      const replay = await prior(tx, here, actor.id, input.operationId, requestHash, "restore");
      if (replay) return asReplay<VersionResult>(replay);
      const access = await gate(tx, here, actor, input.recordId, input.fileId, "edit");
      const rows = await versions(tx, access.file.id, here.tenantId);
      const match = rows.find(row => Number(row.version_no) === source.versionNo && !row.deleted_at);
      if (!match) throw unavailable();
      const note = `Restored from v${source.versionNo}`;
      const version = await addVersion(tx, here, actor, access.file, { blobKey, checksum: source.checksum, size: bytes.length, mime: source.mime, name: source.name, note, restoredFrom: source.versionNo, fieldKey: null });
      await writeHistory(tx, here, actor, access.file.id, input.operationId, `attachment-restore-${version.versionNo}`);
      const result = published(version, source.checksum, bytes.length, note);
      await remember(tx, here, actor.id, input.operationId, requestHash, "restore", result);
      await audit(tx, actor, "attachment.restore", input.operationId, { workspaceId: here.workspaceId, fileId: access.file.id, recordId: input.recordId, versionId: version.id, versionNo: version.versionNo, restoredFrom: source.versionNo, checksum: source.checksum, size: bytes.length });
      return result;
    });
  } catch (error) {
    await deleteObject(blobKey).catch(() => undefined);
    throw error;
  }
}

export async function deleteAttachmentVersion(pages: Repository, actor: Actor, workspaceId: string, input: { operationId: string; tenantId?: string; recordId: string; fileId: string; versionNo: number; reason: string; successorVersionNo?: number }): Promise<DeleteResult> {
  if (!uuidPattern.test(input.operationId) || !Number.isSafeInteger(input.versionNo) || input.versionNo < 1) throw invalid();
  const reason = cleanNote(input.reason, true);
  if (input.successorVersionNo !== undefined && (!Number.isSafeInteger(input.successorVersionNo) || input.successorVersionNo < 1)) throw invalid();
  const requestHash = recordHash({ kind: "delete", recordId: input.recordId, fileId: input.fileId, versionNo: input.versionNo, reason, successorVersionNo: input.successorVersionNo ?? null, tenantId: input.tenantId ?? null });
  return pages.db.transaction(async tx => {
    const here = await scope(tx, workspaceId, actor, input.tenantId);
    const replay = await prior(tx, here, actor.id, input.operationId, requestHash, "delete");
    if (replay) return asReplay<DeleteResult>(replay);
    const access = await gate(tx, here, actor, input.recordId, input.fileId, "edit");
    const rows = await versions(tx, access.file.id, here.tenantId);
    const target = rows.find(row => Number(row.version_no) === input.versionNo);
    if (!target || !retained(target, access.privileged)) throw unavailable();
    if (target.deleted_at) throw unavailable();
    let successorId: string | null = null;
    if (target.id === access.file.current_version_id) {
      const successor = rows.find(row => Number(row.version_no) === input.successorVersionNo && !row.deleted_at && row.id !== target.id);
      if (!successor) throw currentRequired();
      successorId = successor.id;
      await tx.query("UPDATE hs_linked_files SET current_version_id=$2, updated_at=clock_timestamp() WHERE id=$1", [access.file.id, successor.id]);
    }
    const deleted = await tx.query(
      "UPDATE hs_attachment_versions SET deleted_at=clock_timestamp(), deleted_by=$2, delete_reason=$3, purge_after=clock_timestamp()+interval '30 days' WHERE id=$1 AND deleted_at IS NULL RETURNING purge_after",
      [target.id, actor.id, reason],
    );
    if (!deleted.rows.length) throw unavailable();
    await writeHistory(tx, here, actor, access.file.id, input.operationId, `attachment-delete-${input.versionNo}`);
    const result: DeleteResult = { deleted: true, versionNo: input.versionNo, successorVersionNo: successorId ? input.successorVersionNo ?? null : null, replayed: false };
    await remember(tx, here, actor.id, input.operationId, requestHash, "delete", result);
    await audit(tx, actor, "attachment.delete", input.operationId, { workspaceId: here.workspaceId, fileId: access.file.id, recordId: input.recordId, versionId: target.id, versionNo: input.versionNo, successorVersionId: successorId, reasonPresent: true });
    return result;
  });
}

export async function openAttachmentReference(pages: Repository, actor: Actor, workspaceId: string, input: { tenantId?: string; recordId: string; fileId: string; versionNo?: number; sourceKind?: "page" | "record"; sourceId?: string }) {
  return pages.db.transaction(async tx => {
    const here = await scope(tx, workspaceId, actor, input.tenantId);
    const access = await gate(tx, here, actor, input.recordId, input.fileId, "view");
    let pinned: number | null = null;
    if (input.versionNo !== undefined) {
      if (!Number.isSafeInteger(input.versionNo) || input.versionNo < 1) throw unavailable();
      pinned = input.versionNo;
    } else if (input.sourceKind && input.sourceId) {
      const pin = await tx.query<{ pinned_version_no: number | null }>(
        "SELECT pinned_version_no FROM hs_attachment_pins WHERE workspace_id=$1 AND file_id=$2 AND source_kind=$3 AND source_id=$4 ORDER BY created_at DESC LIMIT 1",
        [here.workspaceId, access.file.id, input.sourceKind, input.sourceId],
      );
      pinned = pin.rows[0]?.pinned_version_no === null || pin.rows[0]?.pinned_version_no === undefined ? null : Number(pin.rows[0].pinned_version_no);
    }
    const rows = await versions(tx, access.file.id, here.tenantId);
    const current = rows.find(row => row.id === access.file.current_version_id && !row.deleted_at);
    if (!current) throw unavailable();
    const targetNo = pinned ?? Number(current.version_no);
    const target = rows.find(row => Number(row.version_no) === targetNo);
    if (!target || !retained(target, access.privileged) || (target.deleted_at && pinned === null)) throw unavailable();
    if (target.deleted_at) throw unavailable();
    const notLatest = pinned !== null && pinned !== Number(current.version_no);
    const view = versionView(target, access.file.current_version_id);
    return { ...view, fileId: access.file.id, currentVersionNo: Number(current.version_no), pinnedVersionNo: pinned, notLatest, label: notLatest ? "Not latest" as const : null, pinLabel: pinned ? `@v${pinned}` : null };
  });
}

export async function pinAttachmentReference(pages: Repository, actor: Actor, workspaceId: string, input: { operationId: string; tenantId?: string; recordId: string; fileId: string; sourceKind: "page" | "record"; sourceId: string; versionNo: number | null }): Promise<PinResult> {
  if (!uuidPattern.test(input.operationId) || (input.sourceKind !== "page" && input.sourceKind !== "record")) throw invalid();
  if (input.versionNo !== null && (!Number.isSafeInteger(input.versionNo) || input.versionNo < 1)) throw invalid();
  const requestHash = recordHash({ kind: "pin", recordId: input.recordId, fileId: input.fileId, sourceKind: input.sourceKind, sourceId: input.sourceId, versionNo: input.versionNo, tenantId: input.tenantId ?? null });
  return pages.db.transaction(async tx => {
    const here = await scope(tx, workspaceId, actor, input.tenantId);
    const replay = await prior(tx, here, actor.id, input.operationId, requestHash, "pin");
    if (replay) return asReplay<PinResult>(replay);
    const access = await gate(tx, here, actor, input.recordId, input.fileId, "edit");
    if (input.sourceKind === "page") {
      if (!pageIdPattern.test(input.sourceId)) throw unavailable();
      try {
        const page = await pages.access(tx, input.sourceId, actor, false);
        if (page.workspace_id !== here.workspaceId) throw unavailable();
      } catch (error) {
        if (error instanceof DocumentError && error.status === 404) throw unavailable();
        throw error;
      }
    } else if (!uuidPattern.test(input.sourceId)) throw unavailable();
    if (input.versionNo !== null) {
      const rows = await versions(tx, access.file.id, here.tenantId);
      const target = rows.find(row => Number(row.version_no) === input.versionNo && !row.deleted_at);
      if (!target) throw unavailable();
    }
    await tx.query("DELETE FROM hs_attachment_pins WHERE workspace_id=$1 AND file_id=$2 AND source_kind=$3 AND source_id=$4", [here.workspaceId, access.file.id, input.sourceKind, input.sourceId]);
    const pinId = randomUUID();
    await tx.query(
      "INSERT INTO hs_attachment_pins(id,workspace_id,tenant_id,file_id,record_id,source_kind,source_id,pinned_version_no,created_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",
      [pinId, here.workspaceId, here.tenantId, access.file.id, input.recordId, input.sourceKind, input.sourceId, input.versionNo, actor.id],
    );
    const result = { pinId, fileId: access.file.id, versionNo: input.versionNo, pinLabel: input.versionNo ? `@v${input.versionNo}` : null, replayed: false };
    await remember(tx, here, actor.id, input.operationId, requestHash, "pin", result);
    await audit(tx, actor, "attachment.pin", input.operationId, { workspaceId: here.workspaceId, fileId: access.file.id, recordId: input.recordId, sourceKind: input.sourceKind, sourceId: input.sourceId, versionNo: input.versionNo });
    return result;
  });
}

export async function issueAttachmentDownload(pages: Repository, actor: Actor, workspaceId: string, input: { operationId: string; tenantId?: string; recordId: string; fileId: string; versionNo: number; sessionKey: string }): Promise<DownloadResult> {
  if (!uuidPattern.test(input.operationId) || !Number.isSafeInteger(input.versionNo) || input.versionNo < 1 || !input.sessionKey) throw invalid();
  const requestHash = recordHash({ kind: "download", recordId: input.recordId, fileId: input.fileId, versionNo: input.versionNo, sessionKey: input.sessionKey, tenantId: input.tenantId ?? null });
  return pages.db.transaction(async tx => {
    const here = await scope(tx, workspaceId, actor, input.tenantId);
    const replay = await prior(tx, here, actor.id, input.operationId, requestHash, "download");
    if (replay) return asReplay<DownloadResult>(replay);
    const access = await gate(tx, here, actor, input.recordId, input.fileId, "view");
    const rows = await versions(tx, access.file.id, here.tenantId);
    const target = rows.find(row => Number(row.version_no) === input.versionNo);
    if (!target || !retained(target, access.privileged)) throw unavailable();
    const token = randomBytes(32).toString("base64url");
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const stamped = await tx.query<{ expires_at: string }>(
      `INSERT INTO hs_attachment_download_tokens(token_hash,version_id,workspace_id,actor_id,record_id,session_key,created_at,expires_at)
       SELECT $1,$2,$3,$4,$5,$6,t.now,t.now+interval '5 minutes' FROM (SELECT clock_timestamp() AS now) t RETURNING expires_at`,
      [tokenHash, target.id, here.workspaceId, actor.id, input.recordId, input.sessionKey],
    );
    const result = { url: `/api/v1/workspaces/${encodeURIComponent(here.workspaceId)}/attachment-downloads/${token}`, expiresAt: new Date(stamped.rows[0].expires_at).toISOString(), versionNo: input.versionNo, versionId: target.id, replayed: false };
    await remember(tx, here, actor.id, input.operationId, requestHash, "download", result);
    await audit(tx, actor, "attachment.download", input.operationId, { workspaceId: here.workspaceId, fileId: access.file.id, recordId: input.recordId, versionId: target.id, versionNo: input.versionNo });
    return result;
  });
}

export async function redeemAttachmentDownload(pages: Repository, actor: Actor, workspaceId: string, token: string, sessionKey: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token) || !sessionKey) throw unavailable();
  const tokenHash = createHash("sha256").update(token).digest("hex");
  const located = await pages.db.transaction(async tx => {
    const here = await scope(tx, workspaceId, actor);
    const row = await tx.query<{ version_id: string; actor_id: string; record_id: string; session_key: string; expires_at: string }>(
      "SELECT version_id, actor_id, record_id, session_key, expires_at FROM hs_attachment_download_tokens WHERE token_hash=$1 AND workspace_id=$2",
      [tokenHash, here.workspaceId],
    );
    const tokenRow = row.rows[0];
    if (!tokenRow || tokenRow.actor_id !== actor.id || tokenRow.session_key !== sessionKey || new Date(tokenRow.expires_at).getTime() <= Date.now()) throw unavailable();
    const version = await tx.query<VersionRow>("SELECT * FROM hs_attachment_versions WHERE id=$1 AND tenant_id=$2", [tokenRow.version_id, here.tenantId]);
    const target = version.rows[0];
    if (!target) throw unavailable();
    const access = await gate(tx, here, actor, tokenRow.record_id, target.file_id, "view");
    if (!retained(target, access.privileged)) throw unavailable();
    return { blobKey: target.blob_key, checksum: target.checksum, mime: target.mime, name: target.name, recordId: tokenRow.record_id, fileId: target.file_id };
  });
  const bytes = await getObject(located.blobKey);
  if (checksumOf(bytes) !== located.checksum) throw new DocumentError("Attachment integrity changed. No bytes were delivered.", "media_integrity", 409);
  await pages.db.transaction(async tx => {
    const here = await scope(tx, workspaceId, actor);
    await gate(tx, here, actor, located.recordId, located.fileId, "view");
  });
  return { bytes, mime: located.mime, name: located.name };
}
