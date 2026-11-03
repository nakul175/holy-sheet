import { createHash, randomUUID } from "node:crypto";
import type { Actor } from "./auth";
import type { Sql } from "./database";
import { DocumentError } from "./document";
import { formatIst } from "./ist-label";
import { getObject } from "./media";
import type { Repository } from "./repository";
import { recordHash } from "./shared-record-types";
import {
  attachmentTextBoundary,
  attachmentTextByteLimit,
  attachmentTextLanguage,
  extractAttachmentText,
  type AttachmentExtraction,
  type AttachmentTextStatus,
} from "./attachment-text-extract";

export { attachmentTextBoundary, attachmentTextByteLimit, attachmentTextLanguage };
export const attachmentTextAssignment = "Assigning a text index manager does not grant access to a file, record, or field.";
const source = "attachment-text";
const unavailable = () => new DocumentError("This item is restricted or unavailable.", "not_found", 404);
const refused = () => new DocumentError("This action is not permitted.", "attachment_text_forbidden", 403);
const mismatch = () => new DocumentError("This attempt was reused with different fields.", "operation_mismatch", 409);
const conflict = () => new DocumentError("The attachment text version changed. Review it and try again.", "attachment_text_conflict", 409);
const versionRequired = () => new DocumentError("Confirm the index version before recognising again.", "version_required", 409);
const invalid = () => new DocumentError("Check the attachment text request.", "attachment_text_validation", 400);
const managementRequired = () => new DocumentError("Attachment text configuration authority is required.", "management_required", 403);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Scope = { workspaceId: string; tenantId: string; role: string };
type IndexRow = {
  id: string; version: number | string; attempts: number | string; status: AttachmentTextStatus; language: string;
  checksum: string; page_count: number | string; failure: string | null; ocr_error_count: number | string;
};
type VersionRow = { id: string; version_no: number | string; blob_key: string; checksum: string; size: number | string; mime: string; name: string; deleted_at: string | null };
type Access = { id: string; collection: string; field_key: string | null; current_version_id: string | null; can_view: boolean; can_edit: boolean; can_export: boolean; can_history: boolean; field_view: boolean; field_write: boolean; field_history: boolean };
export type ReindexItem = { recordId: string; fileId: string; versionNo?: number; expectedVersion?: number };
export type IndexedItem = {
  fileId: string; recordId: string; versionId: string | null; versionNo: number | null; status: string;
  language: string; pageCount: number; attempts: number; version: number; failure: string | null; idempotent: boolean; code?: string;
};

const grant = (capability: "view" | "edit" | "export" | "history") => `(EXISTS(SELECT 1 FROM hs_data_collection_grants g WHERE g.tenant_id=r.tenant_id AND g.user_id=$3 AND g.collection=r.collection AND '${capability}'=ANY(g.capabilities)) OR EXISTS(SELECT 1 FROM hs_data_record_grants g WHERE g.tenant_id=r.tenant_id AND g.record_id=r.id AND g.user_id=$3 AND '${capability}'=ANY(g.capabilities)))`;
const field = (flag: "can_view" | "can_write" | "can_history") => `(f.field_key IS NULL OR EXISTS(SELECT 1 FROM hs_data_field_permissions p WHERE p.tenant_id=r.tenant_id AND p.collection=r.collection AND p.field_key=f.field_key AND p.user_id=$3 AND p.${flag}=true))`;
const visibleFile = `f.deleted_at IS NULL AND v.deleted_at IS NULL AND r.state='active' AND r.merged_into_id IS NULL AND ${grant("view")} AND ${field("can_view")}`;

function on(value: unknown) { return value === true || value === "t" || value === "true" || value === 1; }
function num(value: number | string | null | undefined) { return Number(value ?? 0); }
function asRecord(value: unknown) { return (typeof value === "string" ? JSON.parse(value) : value ?? {}) as Record<string, unknown>; }
function checksumOf(bytes: Uint8Array) { return createHash("sha256").update(bytes).digest("hex"); }
function cleanQuery(value: string) {
  const query = value.normalize("NFC").trim();
  if (!query) return "";
  if (query.length > 80 || /[\p{Cc}]/u.test(query)) throw invalid();
  return query.length < 2 ? "" : query;
}
function snippet(text: string, query: string) {
  const at = text.toLowerCase().indexOf(query.toLowerCase());
  const start = Math.max(0, at < 0 ? 0 : at - 40);
  const end = Math.min(text.length, (at < 0 ? 0 : at) + query.length + 40);
  return `${start ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`.slice(0, 180);
}
function safeName(name: string) {
  const clean = name.normalize("NFC").replace(/[^\w. -]+/g, "").trim().slice(0, 160);
  return clean || "attachment";
}

async function scope(tx: Sql, workspaceId: string, actor: Actor): Promise<Scope> {
  if (!workspaceId || workspaceId.length > 200) throw unavailable();
  const row = await tx.query<{ tenant_id: string | null; role: string }>(
    `SELECT b.tenant_id, m.role FROM hs_workspaces w
     JOIN hs_members m ON m.workspace_id=w.id AND m.user_id=$2 AND m.active=true
     LEFT JOIN hs_data_workspaces b ON b.workspace_id=w.id
     WHERE w.id=$1`,
    [workspaceId, actor.id],
  );
  if (!row.rows[0]?.tenant_id) throw unavailable();
  return { workspaceId, tenantId: row.rows[0].tenant_id, role: row.rows[0].role };
}

async function audit(tx: Sql, actor: Actor, action: string, operationId: string, subjectId: string, after: Record<string, unknown>) {
  await tx.query(
    "INSERT INTO hs_audit(id,actor_id,action,subject_id,after_value,correlation_id) VALUES($1,$2,$3,$4,$5,$6)",
    [randomUUID(), actor.id, action, subjectId, JSON.stringify({ source, operationId, atIst: formatIst(new Date()), ...after }), operationId],
  );
}

async function prior(tx: Sql, actorId: string, operationId: string, requestHash: string) {
  const row = await tx.query<{ request_hash: string; result: unknown }>("SELECT request_hash, result FROM hs_attachment_text_operations WHERE actor_id=$1 AND operation_id=$2", [actorId, operationId]);
  if (!row.rows[0]) return null;
  if (row.rows[0].request_hash !== requestHash) throw mismatch();
  return asRecord(row.rows[0].result);
}

async function remember(tx: Sql, actorId: string, operationId: string, requestHash: string, result: Record<string, unknown>) {
  await tx.query("INSERT INTO hs_attachment_text_operations(actor_id,operation_id,request_hash,result) VALUES($1,$2,$3,$4)", [actorId, operationId, requestHash, JSON.stringify(result)]);
}

async function manager(tx: Sql, here: Scope, actor: Actor) {
  if (here.role === "owner" || here.role === "admin") return true;
  if (here.role === "observer") return false;
  const row = await tx.query("SELECT 1 FROM hs_attachment_text_managers WHERE workspace_id=$1 AND user_id=$2", [here.workspaceId, actor.id]);
  return row.rows.length > 0;
}

async function requireManager(tx: Sql, here: Scope, actor: Actor, native = false) {
  if (here.role === "observer") throw refused();
  if (native && here.role !== "owner" && here.role !== "admin") throw managementRequired();
  if (!await manager(tx, here, actor)) throw managementRequired();
}

async function readConfig(tx: Sql, workspaceId: string) {
  const row = await tx.query<{ language: string; enabled: unknown; version: number | string }>("SELECT language, enabled, version FROM hs_attachment_text_config WHERE workspace_id=$1", [workspaceId]);
  const found = row.rows[0];
  if (!found) return { language: attachmentTextLanguage, enabled: true, version: 0 };
  return { language: attachmentTextLanguage, enabled: on(found.enabled), version: num(found.version) };
}

async function gate(tx: Sql, here: Scope, actor: Actor, recordId: string, fileId: string, mode: "view" | "edit" | "export" | "history") {
  if (!uuidPattern.test(recordId) || !uuidPattern.test(fileId)) throw unavailable();
  const row = await tx.query<Access & { state: string }>(
    `SELECT r.id, r.state, r.collection, f.field_key, f.current_version_id,
      ${grant("view")} AS can_view, ${grant("edit")} AS can_edit, ${grant("export")} AS can_export, ${grant("history")} AS can_history,
      ${field("can_view")} AS field_view, ${field("can_write")} AS field_write, ${field("can_history")} AS field_history
     FROM hs_data_records r
     JOIN hs_document_record_links l ON l.record_id=r.id AND l.tenant_id=r.tenant_id AND l.workspace_id=$4 AND l.doc_type='file' AND l.doc_id=$5
     JOIN hs_linked_files f ON f.id::text=l.doc_id AND f.tenant_id=r.tenant_id AND f.deleted_at IS NULL
     WHERE r.id=$1 AND r.tenant_id=$2 AND r.merged_into_id IS NULL`,
    [recordId, here.tenantId, actor.id, here.workspaceId, fileId],
  );
  const found = row.rows[0];
  if (!found || found.state !== "active" || !on(found.can_view) || !on(found.field_view)) throw unavailable();
  if (mode === "edit" && (!on(found.can_edit) || (found.field_key && !on(found.field_write)))) throw refused();
  if (mode === "export" && !on(found.can_export)) throw refused();
  if (mode === "history" && (!on(found.can_history) || (found.field_key && !on(found.field_history)))) throw refused();
  return found;
}

async function versionOf(tx: Sql, here: Scope, fileId: string, versionNo: number | undefined, currentId: string | null) {
  const row = await tx.query<VersionRow>(
    versionNo
      ? "SELECT id, version_no, blob_key, checksum, size, mime, name, deleted_at FROM hs_attachment_versions WHERE file_id=$1 AND tenant_id=$2 AND version_no=$3"
      : "SELECT id, version_no, blob_key, checksum, size, mime, name, deleted_at FROM hs_attachment_versions WHERE id=$3 AND file_id=$1 AND tenant_id=$2",
    [fileId, here.tenantId, versionNo ?? currentId],
  );
  const version = row.rows[0];
  if (!version || version.deleted_at) throw unavailable();
  return version;
}

async function indexRow(tx: Sql, tenantId: string, versionId: string, lock = false) {
  const row = await tx.query<IndexRow>(`SELECT id, version, attempts, status, language, checksum, page_count, failure, ocr_error_count FROM hs_attachment_text_indexes WHERE tenant_id=$1 AND version_id=$2${lock ? " FOR UPDATE" : ""}`, [tenantId, versionId]);
  return row.rows[0] ?? null;
}

function skipped(item: ReindexItem, status: string, code?: string): IndexedItem {
  return { fileId: item.fileId, recordId: item.recordId, versionId: null, versionNo: null, status, language: attachmentTextLanguage, pageCount: 0, attempts: 0, version: 0, failure: null, idempotent: false, code };
}

function published(item: ReindexItem, version: VersionRow, row: IndexRow, idempotent: boolean): IndexedItem {
  return {
    fileId: item.fileId, recordId: item.recordId, versionId: version.id, versionNo: num(version.version_no),
    status: row.status, language: row.language, pageCount: num(row.page_count), attempts: num(row.attempts),
    version: num(row.version), failure: row.failure, idempotent,
  };
}

async function indexOne(pages: Repository, actor: Actor, workspaceId: string, item: ReindexItem, operationId: string): Promise<IndexedItem> {
  const prepared = await pages.db.transaction(async tx => {
    const here = await scope(tx, workspaceId, actor);
    const config = await readConfig(tx, here.workspaceId);
    if (!config.enabled) return { kind: "disabled" as const };
    const access = await gate(tx, here, actor, item.recordId, item.fileId, "edit");
    const version = await versionOf(tx, here, item.fileId, item.versionNo, access.current_version_id);
    const existing = await indexRow(tx, here.tenantId, version.id, true);
    if (existing && item.expectedVersion != null && num(existing.version) !== item.expectedVersion) throw conflict();
    const sameBytes = existing?.checksum === version.checksum;
    const terminal = Boolean(existing && sameBytes && existing.language === config.language && existing.status !== "failed");
    const bounded = Boolean(existing && sameBytes && existing.status === "failed" && num(existing.attempts) >= 5);
    if ((terminal || bounded) && existing) return { kind: "ready" as const, version, row: existing };
    if (existing && item.expectedVersion == null) throw versionRequired();
    return { kind: "run" as const, version, existing };
  });
  if (prepared.kind === "disabled") return skipped(item, "disabled", "disabled");
  if (prepared.kind === "ready") return published(item, prepared.version, prepared.row, true);

  let extraction: AttachmentExtraction;
  if (num(prepared.version.size) > attachmentTextByteLimit) {
    extraction = { status: "oversize", language: attachmentTextLanguage, mime: prepared.version.mime, pageCount: 0, pages: [], failure: "File exceeds 20 MiB." };
  } else {
    try {
      const bytes = await getObject(prepared.version.blob_key);
      extraction = checksumOf(bytes) === prepared.version.checksum
        ? await extractAttachmentText(bytes, prepared.version.mime)
        : { status: "failed", language: attachmentTextLanguage, mime: prepared.version.mime, pageCount: 0, pages: [], failure: "Stored bytes did not match the version." };
    } catch {
      extraction = { status: "failed", language: attachmentTextLanguage, mime: prepared.version.mime, pageCount: 0, pages: [], failure: "File bytes could not be read." };
    }
  }
  return pages.db.transaction(async tx => {
    const here = await scope(tx, workspaceId, actor);
    const access = await gate(tx, here, actor, item.recordId, item.fileId, "edit");
    const version = await versionOf(tx, here, item.fileId, item.versionNo, access.current_version_id);
    if (version.checksum !== prepared.version.checksum || version.blob_key !== prepared.version.blob_key) throw conflict();
    const existing = await indexRow(tx, here.tenantId, version.id, true);
    if (existing && item.expectedVersion != null && num(existing.version) !== item.expectedVersion) throw conflict();
    const attempts = existing && existing.status === "failed" ? Math.min(5, num(existing.attempts) + 1) : 1;
    const nextVersion = existing ? num(existing.version) + 1 : 1;
    const id = existing?.id ?? randomUUID();
    const failure = extraction.failure;
    if (existing) {
      await tx.query(
        `UPDATE hs_attachment_text_indexes SET status=$2, language=$3, page_count=$4, ocr_error_count=$5, failure=$6, attempts=$7, version=$8, checksum=$9, mime=$10, indexed_at=clock_timestamp() WHERE id=$1`,
        [id, extraction.status, extraction.language, extraction.pageCount, extraction.pages.reduce((sum, page) => sum + page.ocrErrors.length, 0), failure, attempts, nextVersion, version.checksum, version.mime],
      );
      await tx.query("DELETE FROM hs_attachment_text_pages WHERE index_id=$1", [id]);
    } else {
      await tx.query(
        `INSERT INTO hs_attachment_text_indexes(id,workspace_id,tenant_id,file_id,version_id,version_no,checksum,mime,language,status,page_count,ocr_error_count,failure,attempts,version)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [id, here.workspaceId, here.tenantId, item.fileId, version.id, num(version.version_no), version.checksum, version.mime, extraction.language, extraction.status, extraction.pageCount, extraction.pages.reduce((sum, page) => sum + page.ocrErrors.length, 0), failure, attempts, nextVersion],
      );
    }
    for (const page of extraction.pages) {
      await tx.query(
        "INSERT INTO hs_attachment_text_pages(index_id,page_no,text,recognition,ocr_errors) VALUES($1,$2,$3,$4,$5)",
        [id, page.page, page.text.slice(0, 8000), page.recognition, page.ocrErrors.join("\n").slice(0, 1000)],
      );
    }
    await audit(tx, actor, "attachment-text.index", operationId, item.fileId, { workspaceId: here.workspaceId, fileId: item.fileId, versionId: version.id, versionNo: num(version.version_no), status: extraction.status, language: extraction.language, pageCount: extraction.pageCount });
    const row = await indexRow(tx, here.tenantId, version.id);
    if (!row) throw unavailable();
    return published(item, version, row, false);
  });
}

export async function reindexAttachmentText(pages: Repository, actor: Actor, workspaceId: string, input: { operationId: string; items: ReindexItem[] }) {
  if (!uuidPattern.test(input.operationId) || input.items.length < 1 || input.items.length > 20) throw invalid();
  const requestHash = recordHash({ kind: "reindex", workspaceId, items: input.items });
  const existing = await pages.db.transaction(async tx => prior(tx, actor.id, input.operationId, requestHash));
  if (existing) return { items: Array.isArray(existing.items) ? existing.items as IndexedItem[] : [], replayed: true };
  const items: IndexedItem[] = [];
  for (const item of input.items) {
    try { items.push(await indexOne(pages, actor, workspaceId, item, input.operationId)); }
    catch (error) {
      const code = error instanceof DocumentError ? error.code : "failed";
      items.push(skipped(item, "skipped", code));
    }
  }
  const result = { items, replayed: false };
  await pages.db.transaction(async tx => {
    const seen = await prior(tx, actor.id, input.operationId, requestHash);
    if (!seen) await remember(tx, actor.id, input.operationId, requestHash, result);
  });
  return result;
}

const hitColumns = `f.name AS filename, p.page_no, p.text, p.recognition, p.ocr_errors, i.language, i.status, i.version_id, v.version_no, v.id AS exact_version_id, f.id AS file_id, f.current_version_id, r.id AS record_id, pin.id AS pin_id, pin.pinned_version_no, ${grant("export")} AS can_export, ${grant("history")} AS can_history, ${field("can_history")} AS field_history, f.field_key`;

function hitFrom(row: { filename: string; page_no: number | string; text: string; recognition: "text" | "ocr"; ocr_errors: string; language: string; status: string; version_no: number | string; exact_version_id: string; file_id: string; current_version_id: string | null; record_id: string; pin_id: string | null; pinned_version_no: number | string | null; can_export: unknown; can_history: unknown; field_history: unknown; field_key: string | null }, query = "") {
  const errors = row.ocr_errors ? row.ocr_errors.split("\n").filter(Boolean) : [];
  const versionNo = num(row.version_no);
  const pinned = Boolean(row.pin_id) && (row.pinned_version_no == null ? row.exact_version_id === row.current_version_id : num(row.pinned_version_no) === versionNo);
  return {
    filename: row.filename, page: num(row.page_no), snippet: query ? snippet(row.text, query) : undefined, text: query ? undefined : row.text,
    recognition: row.recognition, ocrError: errors.length > 0, ocrErrors: errors, language: row.language, status: row.status,
    versionId: row.exact_version_id, versionNo, fileId: row.file_id, recordId: row.record_id, exact: true, pinned,
    canDownload: on(row.can_export), canHistory: on(row.can_history) && (!row.field_key || on(row.field_history)),
  };
}

export async function searchAttachmentText(pages: Repository, actor: Actor, workspaceId: string, queryText: string) {
  const query = cleanQuery(queryText);
  return pages.db.transaction(async tx => {
    const here = await scope(tx, workspaceId, actor);
    if (!query) return { hits: [] };
    const rows = await tx.query<Parameters<typeof hitFrom>[0]>(
      `SELECT DISTINCT ON (i.version_id, p.page_no) ${hitColumns}
       FROM hs_attachment_text_pages p
       JOIN hs_attachment_text_indexes i ON i.id=p.index_id
       JOIN hs_attachment_versions v ON v.id=i.version_id AND v.tenant_id=i.tenant_id
       JOIN hs_linked_files f ON f.id=i.file_id AND f.tenant_id=i.tenant_id
       JOIN hs_document_record_links l ON l.workspace_id=i.workspace_id AND l.tenant_id=i.tenant_id AND l.doc_type='file' AND l.doc_id=f.id::text
       JOIN hs_data_records r ON r.id=l.record_id AND r.tenant_id=i.tenant_id
       LEFT JOIN hs_attachment_pins pin ON pin.workspace_id=i.workspace_id AND pin.tenant_id=i.tenant_id AND pin.file_id=f.id AND pin.record_id=r.id AND pin.source_kind='record'
       WHERE i.workspace_id=$1 AND i.tenant_id=$2 AND strpos(lower(p.text), lower($4))>0 AND ${visibleFile}
       ORDER BY i.version_id, p.page_no, r.id
       LIMIT 20`,
      [here.workspaceId, here.tenantId, actor.id, query],
    );
    return { hits: rows.rows.map(row => ({ ...hitFrom(row, query), text: undefined })) };
  });
}

export async function previewAttachmentText(pages: Repository, actor: Actor, workspaceId: string, input: { recordId: string; versionId: string; page: number }) {
  if (!uuidPattern.test(input.versionId) || !Number.isInteger(input.page) || input.page < 1 || input.page > 500) throw unavailable();
  return pages.db.transaction(async tx => {
    const here = await scope(tx, workspaceId, actor);
    await gate(tx, here, actor, input.recordId, await fileForVersion(tx, here, input.versionId), "view");
    const rows = await tx.query<Parameters<typeof hitFrom>[0]>(
      `SELECT ${hitColumns}
       FROM hs_attachment_text_pages p
       JOIN hs_attachment_text_indexes i ON i.id=p.index_id
       JOIN hs_attachment_versions v ON v.id=i.version_id AND v.tenant_id=i.tenant_id
       JOIN hs_linked_files f ON f.id=i.file_id AND f.tenant_id=i.tenant_id
       JOIN hs_document_record_links l ON l.workspace_id=i.workspace_id AND l.tenant_id=i.tenant_id AND l.doc_type='file' AND l.doc_id=f.id::text AND l.record_id=$5
       JOIN hs_data_records r ON r.id=l.record_id AND r.tenant_id=i.tenant_id
       LEFT JOIN hs_attachment_pins pin ON pin.workspace_id=i.workspace_id AND pin.tenant_id=i.tenant_id AND pin.file_id=f.id AND pin.record_id=r.id AND pin.source_kind='record'
       WHERE i.workspace_id=$1 AND i.tenant_id=$2 AND v.id=$4 AND p.page_no=$6 AND ${visibleFile}`,
      [here.workspaceId, here.tenantId, actor.id, input.versionId, input.recordId, input.page],
    );
    const row = rows.rows[0];
    if (!row) throw unavailable();
    const hit = hitFrom(row);
    return { ...hit, snippet: undefined, text: row.text, boundary: attachmentTextBoundary };
  });
}

async function fileForVersion(tx: Sql, here: Scope, versionId: string) {
  const row = await tx.query<{ file_id: string }>("SELECT file_id FROM hs_attachment_versions WHERE id=$1 AND tenant_id=$2 AND deleted_at IS NULL", [versionId, here.tenantId]);
  if (!row.rows[0]) throw unavailable();
  return row.rows[0].file_id;
}

export async function downloadAttachmentText(pages: Repository, actor: Actor, workspaceId: string, input: { operationId: string; recordId: string; versionId: string }) {
  if (!uuidPattern.test(input.operationId) || !uuidPattern.test(input.versionId)) throw invalid();
  const requestHash = recordHash({ kind: "download", workspaceId, recordId: input.recordId, versionId: input.versionId });
  const meta = await pages.db.transaction(async tx => {
    const here = await scope(tx, workspaceId, actor);
    const seen = await prior(tx, actor.id, input.operationId, requestHash);
    const fileId = await fileForVersion(tx, here, input.versionId);
    await gate(tx, here, actor, input.recordId, fileId, "export");
    const version = await versionOf(tx, here, fileId, undefined, input.versionId);
    if (version.id !== input.versionId) throw unavailable();
    if (!seen) {
      await remember(tx, actor.id, input.operationId, requestHash, { versionId: version.id, versionNo: num(version.version_no), filename: version.name, size: num(version.size) });
      await audit(tx, actor, "attachment-text.download", input.operationId, fileId, { workspaceId: here.workspaceId, fileId, versionId: version.id, versionNo: num(version.version_no) });
    }
    return version;
  });
  const bytes = await getObject(meta.blob_key);
  if (checksumOf(bytes) !== meta.checksum) throw new DocumentError("Stored bytes did not match the version.", "attachment_text_integrity", 409);
  await pages.db.transaction(async tx => {
    const here = await scope(tx, workspaceId, actor);
    const fileId = await fileForVersion(tx, here, input.versionId);
    await gate(tx, here, actor, input.recordId, fileId, "export");
  });
  const headers = new Headers({ "Content-Type": meta.mime, "Content-Disposition": `attachment; filename="${safeName(meta.name)}"`, "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff", Vary: "Cookie, Authorization", "X-HS-Attachment-Version": String(num(meta.version_no)) });
  return new Response(Buffer.from(bytes), { headers });
}

function events(rows: { actor_id: string; name: string; action: string; after_value: unknown; correlation_id: string; created_at: string }[]) {
  return rows.map(row => {
    const after = asRecord(row.after_value);
    return { actorId: row.actor_id, actorName: row.name, action: row.action, atIst: String(after.atIst ?? formatIst(row.created_at)), source: String(after.source ?? source), operationId: String(after.operationId ?? row.correlation_id) };
  });
}

export async function attachmentTextHistory(pages: Repository, actor: Actor, workspaceId: string, input: { recordId: string; fileId: string }) {
  return pages.db.transaction(async tx => {
    const here = await scope(tx, workspaceId, actor);
    await gate(tx, here, actor, input.recordId, input.fileId, "history");
    const rows = await tx.query<{ actor_id: string; name: string; action: string; after_value: unknown; correlation_id: string; created_at: string }>(
      `SELECT a.actor_id, u.name, a.action, a.after_value, a.correlation_id, a.created_at
       FROM hs_audit a JOIN hs_users u ON u.id=a.actor_id
       WHERE a.subject_id=$1 AND a.action LIKE 'attachment-text.%' AND a.action NOT LIKE 'attachment-text.grant%' AND a.action NOT LIKE 'attachment-text.revoke%' AND a.action NOT IN ('attachment-text.save','attachment-text.stash','attachment-text.discard-draft')
       ORDER BY a.created_at, a.id`,
      [input.fileId],
    );
    return { events: events(rows.rows) };
  });
}

export async function attachmentTextConfigHistory(pages: Repository, actor: Actor, workspaceId: string) {
  return pages.db.transaction(async tx => {
    const here = await scope(tx, workspaceId, actor);
    await requireManager(tx, here, actor);
    const rows = await tx.query<{ actor_id: string; name: string; action: string; after_value: unknown; correlation_id: string; created_at: string }>(
      `SELECT a.actor_id, u.name, a.action, a.after_value, a.correlation_id, a.created_at
       FROM hs_audit a JOIN hs_users u ON u.id=a.actor_id
       WHERE a.subject_id=$1 AND a.action IN ('attachment-text.save','attachment-text.stash','attachment-text.discard-draft','attachment-text.grant-manager','attachment-text.revoke-manager')
       ORDER BY a.created_at, a.id`,
      [here.workspaceId],
    );
    return { events: events(rows.rows) };
  });
}

export async function readAttachmentTextConfig(pages: Repository, actor: Actor, workspaceId: string) {
  return pages.db.transaction(async tx => {
    const here = await scope(tx, workspaceId, actor);
    const manage = await manager(tx, here, actor);
    const config = await readConfig(tx, here.workspaceId);
    const draft = manage ? await tx.query<{ language: string; enabled: unknown; base_version: number | string }>("SELECT language, enabled, base_version FROM hs_attachment_text_drafts WHERE workspace_id=$1 AND actor_id=$2", [here.workspaceId, actor.id]) : { rows: [] };
    const saved = draft.rows[0];
    return {
      ...config, manage, boundary: attachmentTextBoundary, assignment: attachmentTextAssignment,
      recoverableDraft: saved ? { language: attachmentTextLanguage, enabled: on(saved.enabled), baseVersion: num(saved.base_version) } : null,
    };
  });
}

export async function listAttachmentText(pages: Repository, actor: Actor, workspaceId: string) {
  return pages.db.transaction(async tx => {
    const here = await scope(tx, workspaceId, actor);
    const rows = await tx.query<{ file_id: string; filename: string; version_id: string; version_no: number | string; record_id: string; status: string | null; language: string | null; version: number | string | null; can_edit: unknown; can_export: unknown; can_history: unknown; field_key: string | null; field_write: unknown; field_history: unknown }>(
      `SELECT f.id AS file_id, f.name AS filename, v.id AS version_id, v.version_no, r.id AS record_id, i.status, i.language, i.version,
        ${grant("edit")} AS can_edit, ${grant("export")} AS can_export, ${grant("history")} AS can_history, f.field_key,
        ${field("can_write")} AS field_write, ${field("can_history")} AS field_history
       FROM hs_linked_files f
       JOIN hs_attachment_versions v ON v.id=f.current_version_id AND v.tenant_id=f.tenant_id
       JOIN hs_document_record_links l ON l.workspace_id=f.workspace_id AND l.tenant_id=f.tenant_id AND l.doc_type='file' AND l.doc_id=f.id::text
       JOIN hs_data_records r ON r.id=l.record_id AND r.tenant_id=f.tenant_id
       LEFT JOIN hs_attachment_text_indexes i ON i.version_id=v.id AND i.tenant_id=f.tenant_id
       WHERE f.workspace_id=$1 AND f.tenant_id=$2 AND ${visibleFile}
       ORDER BY f.name, r.id LIMIT 30`,
      [here.workspaceId, here.tenantId, actor.id],
    );
    return {
      files: rows.rows.map(row => ({
        fileId: row.file_id, filename: row.filename, versionId: row.version_id, versionNo: num(row.version_no), recordId: row.record_id,
        status: row.status, language: row.language ?? attachmentTextLanguage, version: row.version == null ? 0 : num(row.version),
        canReindex: on(row.can_edit) && (!row.field_key || on(row.field_write)),
        canDownload: on(row.can_export),
        canHistory: on(row.can_history) && (!row.field_key || on(row.field_history)),
      })),
    };
  });
}

async function withConfig(pages: Repository, actor: Actor, workspaceId: string, operationId: string, requestHash: string, run: (tx: Sql, here: Scope) => Promise<Record<string, unknown>>) {
  if (!uuidPattern.test(operationId)) throw invalid();
  return pages.db.transaction(async tx => {
    const here = await scope(tx, workspaceId, actor);
    await requireManager(tx, here, actor);
    const seen = await prior(tx, actor.id, operationId, requestHash);
    if (seen) return { ...seen, replayed: true };
    const result = await run(tx, here);
    await remember(tx, actor.id, operationId, requestHash, result);
    return { ...result, replayed: false };
  });
}

export async function saveAttachmentTextConfig(pages: Repository, actor: Actor, workspaceId: string, input: { operationId: string; expectedVersion: number; enabled: boolean; language: "en" }) {
  if (input.language !== "en" || !Number.isInteger(input.expectedVersion) || input.expectedVersion < 0) throw invalid();
  const requestHash = recordHash({ kind: "save", workspaceId, expectedVersion: input.expectedVersion, enabled: input.enabled, language: input.language });
  return await withConfig(pages, actor, workspaceId, input.operationId, requestHash, async (tx, here) => {
    const current = await tx.query<{ version: number | string }>("SELECT version FROM hs_attachment_text_config WHERE workspace_id=$1 FOR UPDATE", [here.workspaceId]);
    const version = current.rows[0] ? num(current.rows[0].version) : 0;
    if (version !== input.expectedVersion) throw conflict();
    const next = version + 1;
    if (!current.rows[0]) await tx.query("INSERT INTO hs_attachment_text_config(workspace_id,language,enabled,version) VALUES($1,'en',$2,1)", [here.workspaceId, input.enabled]);
    else await tx.query("UPDATE hs_attachment_text_config SET language='en', enabled=$2, version=$3, updated_at=clock_timestamp() WHERE workspace_id=$1", [here.workspaceId, input.enabled, next]);
    await tx.query("INSERT INTO hs_attachment_text_config_revisions(workspace_id,version,language,enabled,actor_id,operation_id) VALUES($1,$2,'en',$3,$4,$5)", [here.workspaceId, next, input.enabled, actor.id, input.operationId]);
    await tx.query("DELETE FROM hs_attachment_text_drafts WHERE workspace_id=$1 AND actor_id=$2", [here.workspaceId, actor.id]);
    await audit(tx, actor, "attachment-text.save", input.operationId, here.workspaceId, { workspaceId: here.workspaceId, version: next, language: "en", enabled: input.enabled });
    return { version: next, language: attachmentTextLanguage, enabled: input.enabled };
  }) as unknown as { version: number; language: "en"; enabled: boolean; replayed: boolean };
}

export async function stashAttachmentTextConfig(pages: Repository, actor: Actor, workspaceId: string, input: { operationId: string; expectedVersion: number; enabled: boolean; language: "en" }) {
  if (input.language !== "en") throw invalid();
  const requestHash = recordHash({ kind: "stash", workspaceId, ...input });
  return withConfig(pages, actor, workspaceId, input.operationId, requestHash, async (tx, here) => {
    await tx.query(
      `INSERT INTO hs_attachment_text_drafts(workspace_id,actor_id,base_version,language,enabled,operation_id)
       VALUES($1,$2,$3,'en',$4,$5)
       ON CONFLICT (workspace_id, actor_id) DO UPDATE SET base_version=$3, language='en', enabled=$4, operation_id=$5, updated_at=clock_timestamp()`,
      [here.workspaceId, actor.id, input.expectedVersion, input.enabled, input.operationId],
    );
    await audit(tx, actor, "attachment-text.stash", input.operationId, here.workspaceId, { workspaceId: here.workspaceId, baseVersion: input.expectedVersion, enabled: input.enabled, language: "en" });
    return { stashed: true, baseVersion: input.expectedVersion, enabled: input.enabled, language: attachmentTextLanguage };
  });
}

export async function discardAttachmentTextDraft(pages: Repository, actor: Actor, workspaceId: string, input: { operationId: string }) {
  const requestHash = recordHash({ kind: "discard-draft", workspaceId, operationId: input.operationId });
  return withConfig(pages, actor, workspaceId, input.operationId, requestHash, async (tx, here) => {
    await tx.query("DELETE FROM hs_attachment_text_drafts WHERE workspace_id=$1 AND actor_id=$2", [here.workspaceId, actor.id]);
    await audit(tx, actor, "attachment-text.discard-draft", input.operationId, here.workspaceId, { workspaceId: here.workspaceId });
    return { discarded: true };
  });
}

export async function grantAttachmentTextManager(pages: Repository, actor: Actor, workspaceId: string, input: { operationId: string; userId: string }) {
  const requestHash = recordHash({ kind: "grant-manager", workspaceId, userId: input.userId });
  return withConfig(pages, actor, workspaceId, input.operationId, requestHash, async (tx, here) => {
    await requireManager(tx, here, actor, true);
    const member = await tx.query<{ role: string }>("SELECT role FROM hs_members WHERE workspace_id=$1 AND user_id=$2 AND active=true", [here.workspaceId, input.userId]);
    if (!member.rows[0] || member.rows[0].role === "observer") throw refused();
    await tx.query("INSERT INTO hs_attachment_text_managers(workspace_id,user_id,granted_by) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [here.workspaceId, input.userId, actor.id]);
    await audit(tx, actor, "attachment-text.grant-manager", input.operationId, here.workspaceId, { workspaceId: here.workspaceId, userId: input.userId });
    return { userId: input.userId, granted: true };
  });
}

export async function revokeAttachmentTextManager(pages: Repository, actor: Actor, workspaceId: string, input: { operationId: string; userId: string }) {
  const requestHash = recordHash({ kind: "revoke-manager", workspaceId, userId: input.userId });
  return withConfig(pages, actor, workspaceId, input.operationId, requestHash, async (tx, here) => {
    await requireManager(tx, here, actor, true);
    await tx.query("DELETE FROM hs_attachment_text_managers WHERE workspace_id=$1 AND user_id=$2", [here.workspaceId, input.userId]);
    await audit(tx, actor, "attachment-text.revoke-manager", input.operationId, here.workspaceId, { workspaceId: here.workspaceId, userId: input.userId });
    return { userId: input.userId, revoked: true };
  });
}
