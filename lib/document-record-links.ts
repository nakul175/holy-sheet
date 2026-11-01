import { randomUUID } from "node:crypto";
import type { Actor } from "./auth";
import type { Sql } from "./database";
import { DocumentError } from "./document";
import { recordHash } from "./shared-record-types";
import { recordPageHref } from "./record-page-refs";
import type { Repository } from "./repository";
import { canEdit } from "./types";

const unavailable = () => new DocumentError("This item is restricted or unavailable.", "not_found", 404);
const refused = () => new DocumentError("This action is not permitted.", "document_link_forbidden", 403);
const choiceRequired = () => new DocumentError("Choose delete or keep this file in Unlinked files for 30 days.", "unlink_choice_required", 422);
const mismatch = () => new DocumentError("This link attempt was reused with different fields.", "operation_mismatch", 409);
const invalid = () => new DocumentError("Check the document link request.", "document_link_validation", 400);
const pageIdPattern = /^[a-zA-Z0-9_-]{1,100}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const dayPattern = /^\d{4}-\d{2}-\d{2}$/;
const PAGE_SIZE = 20;
const SCAN_CAP = 200;

export type DocType = "page" | "file";
export type LinkDisposition = "delete" | "keep";

export type AssociationItem = {
  linkId: string;
  docType: DocType;
  docId: string;
  recordId: string;
  title: string | null;
  availability: "visible" | "in-trash";
  label: "In trash" | null;
  ownerId: string;
  updatedAt: string;
  linkedAt: string;
  linkedAtLabel: string;
  href: string | null;
  canUnlink: boolean;
};

export type AssociationList = {
  items: AssociationItem[];
  nextCursor: string | null;
  countLabel: string;
  canLink: boolean;
  limited: boolean;
};

export type UnlinkedFileItem = {
  fileId: string;
  name: string;
  unlinkedAt: string;
  unlinkedAtLabel: string;
  purgeAfter: string;
  purgeAfterLabel: string;
};

type Scope = { workspaceId: string; tenantId: string; role: string };
type RecordRow = {
  id: string;
  name: string;
  collection: string;
  state: string;
  updated_at: string;
  can_view: boolean;
  can_link: boolean;
  can_restore: boolean;
};

const viewGrant = (actor: string) => `(EXISTS(SELECT 1 FROM hs_data_collection_grants g WHERE g.tenant_id=r.tenant_id AND g.user_id=${actor} AND g.collection=r.collection AND 'view'=ANY(g.capabilities)) OR EXISTS(SELECT 1 FROM hs_data_record_grants g WHERE g.tenant_id=r.tenant_id AND g.record_id=r.id AND g.user_id=${actor} AND 'view'=ANY(g.capabilities)))`;
const linkGrant = (actor: string) => `(EXISTS(SELECT 1 FROM hs_data_collection_grants g WHERE g.tenant_id=r.tenant_id AND g.user_id=${actor} AND g.collection=r.collection AND 'link'=ANY(g.capabilities)) OR EXISTS(SELECT 1 FROM hs_data_record_grants g WHERE g.tenant_id=r.tenant_id AND g.record_id=r.id AND g.user_id=${actor} AND 'link'=ANY(g.capabilities)))`;
const restoreGrant = (actor: string) => `(EXISTS(SELECT 1 FROM hs_data_collection_grants g WHERE g.tenant_id=r.tenant_id AND g.user_id=${actor} AND g.collection=r.collection AND 'restore'=ANY(g.capabilities)) OR EXISTS(SELECT 1 FROM hs_data_record_grants g WHERE g.tenant_id=r.tenant_id AND g.record_id=r.id AND g.user_id=${actor} AND 'restore'=ANY(g.capabilities)))`;

export function formatLinkedAtIst(value: string | Date) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const formatted = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kolkata", day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(date);
  return `${formatted} IST`;
}

function istDay(day: string, end: boolean) {
  if (!dayPattern.test(day)) throw invalid();
  const stamp = end ? `${day}T23:59:59.999+05:30` : `${day}T00:00:00.000+05:30`;
  const date = new Date(stamp);
  if (Number.isNaN(date.getTime())) throw invalid();
  return date.toISOString();
}

function iso(value: string | Date) {
  return new Date(value).toISOString();
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

async function lockActor(tx: Sql, actorId: string) {
  await tx.query("SELECT id FROM hs_users WHERE id=$1 FOR UPDATE", [actorId]);
}

async function loadRecord(tx: Sql, tenantId: string, actorId: string, recordId: string, lock = false): Promise<RecordRow | null> {
  if (!uuidPattern.test(recordId)) return null;
  const row = await tx.query<RecordRow>(
    `SELECT r.id, r.name, r.collection, r.state, r.updated_at,
      ${viewGrant("$3")} AS can_view, ${linkGrant("$3")} AS can_link, ${restoreGrant("$3")} AS can_restore
     FROM hs_data_records r
     WHERE r.id=$1 AND r.tenant_id=$2 AND r.merged_into_id IS NULL ${lock ? "FOR UPDATE" : ""}`,
    [recordId, tenantId, actorId],
  );
  return row.rows[0] ?? null;
}

function assertLinkable(record: RecordRow | null) {
  if (!record || !record.can_view || record.state !== "active") throw unavailable();
  if (!record.can_link) throw refused();
  return record;
}

async function priorOperation(tx: Sql, workspaceId: string, actorId: string, operationId: string, requestHash: string, kind: string) {
  const row = await tx.query<{ request_hash: string; kind: string; result: unknown }>(
    "SELECT request_hash, kind, result FROM hs_document_record_link_operations WHERE workspace_id=$1 AND actor_id=$2 AND operation_id=$3",
    [workspaceId, actorId, operationId],
  );
  const found = row.rows[0];
  if (!found) return null;
  if (found.request_hash !== requestHash || found.kind !== kind) throw mismatch();
  return typeof found.result === "string" ? JSON.parse(found.result) as Record<string, unknown> : found.result as Record<string, unknown>;
}

async function remember(tx: Sql, workspaceId: string, actorId: string, operationId: string, requestHash: string, kind: string, result: Record<string, unknown>) {
  await tx.query(
    "INSERT INTO hs_document_record_link_operations(workspace_id,actor_id,operation_id,request_hash,kind,result) VALUES($1,$2,$3,$4,$5,$6)",
    [workspaceId, actorId, operationId, requestHash, kind, JSON.stringify(result)],
  );
}

async function audit(tx: Sql, actor: Actor, action: string, operationId: string, after: Record<string, unknown>, pageId?: string) {
  await tx.query(
    "INSERT INTO hs_audit(id,actor_id,action,page_id,after_value,correlation_id) VALUES($1,$2,$3,$4,$5,$6)",
    [randomUUID(), actor.id, action, pageId ?? null, JSON.stringify(after), operationId],
  );
}

async function editablePage(pages: Repository, tx: Sql, actor: Actor, workspaceId: string, pageId: string) {
  if (!pageIdPattern.test(pageId)) throw unavailable();
  try {
    const page = await pages.access(tx, pageId, actor, true, true);
    if (page.workspace_id !== workspaceId) throw unavailable();
    return page;
  } catch (error) {
    if (error instanceof DocumentError && (error.status === 404 || error.code === "read_only")) {
      if (error.status === 404) throw unavailable();
      throw refused();
    }
    throw error;
  }
}

type FileRow = { id: string; name: string; owner_id: string; deleted_at: string | null; unlinked_at: string | null; workspace_id: string; tenant_id: string };

async function editableFile(tx: Sql, actor: Actor, scopeRow: Scope, fileId: string) {
  if (!uuidPattern.test(fileId)) throw unavailable();
  const row = await tx.query<FileRow>(
    "SELECT id, name, owner_id, deleted_at, unlinked_at, workspace_id, tenant_id FROM hs_linked_files WHERE id=$1 AND tenant_id=$2 FOR UPDATE",
    [fileId, scopeRow.tenantId],
  );
  const file = row.rows[0];
  if (!file || file.deleted_at || file.workspace_id !== scopeRow.workspaceId) throw unavailable();
  const canEditFile = file.owner_id === actor.id || scopeRow.role === "owner" || scopeRow.role === "admin";
  if (!canEditFile) {
    const visible = await tx.query(
      `SELECT 1 FROM hs_document_record_links l
       JOIN hs_data_records r ON r.id=l.record_id AND r.tenant_id=l.tenant_id
       WHERE l.workspace_id=$1 AND l.doc_type='file' AND l.doc_id=$2 AND r.merged_into_id IS NULL AND r.state<>'trashed' AND ${viewGrant("$3")} LIMIT 1`,
      [scopeRow.workspaceId, fileId, actor.id],
    );
    if (!visible.rows.length && file.owner_id !== actor.id) throw unavailable();
    throw refused();
  }
  return file;
}

async function readableMedia(pages: Repository, tx: Sql, actor: Actor, workspaceId: string, mediaId: string) {
  if (!uuidPattern.test(mediaId)) throw unavailable();
  const media = await tx.query<{ id: string; page_id: string }>(
    "SELECT id, page_id FROM hs_media WHERE id=$1 AND state='ready' AND deleted_at IS NULL",
    [mediaId],
  );
  if (!media.rows.length) throw unavailable();
  try {
    const page = await pages.access(tx, media.rows[0].page_id, actor, false, true);
    if (page.workspace_id !== workspaceId) throw unavailable();
  } catch (error) {
    if (error instanceof DocumentError && error.status === 404) throw unavailable();
    throw error;
  }
  return media.rows[0].id;
}

type LinkResult = { linked: true; already: boolean; linkId: string; docType: DocType; docId: string; recordId: string; replayed: boolean };
type UnlinkResult = { unlinked: true; already: boolean; docType: DocType; docId: string; recordId: string; fileState?: "linked" | "kept" | "deleted" | "unchanged"; replayed: boolean };
type RegisterResult = { fileId: string; linkId: string; recordId: string; docType: "file"; name: string; replayed: boolean };

export async function linkDocumentRecord(pages: Repository, actor: Actor, workspaceId: string, input: { operationId: string; tenantId?: string; docType: DocType; docId: string; recordId: string }): Promise<LinkResult> {
  if (!uuidPattern.test(input.operationId)) throw invalid();
  const requestHash = recordHash({ kind: "link", docType: input.docType, docId: input.docId, recordId: input.recordId, tenantId: input.tenantId ?? null });
  return pages.db.transaction(async tx => {
    await lockActor(tx, actor.id);
    const here = await scope(tx, workspaceId, actor, input.tenantId);
    const record = assertLinkable(await loadRecord(tx, here.tenantId, actor.id, input.recordId, true));
    const page = input.docType === "page" ? await editablePage(pages, tx, actor, here.workspaceId, input.docId) : null;
    const file = input.docType === "file" ? await editableFile(tx, actor, here, input.docId) : null;
    if (input.docType !== "page" && input.docType !== "file") throw invalid();
    const replay = await priorOperation(tx, here.workspaceId, actor.id, input.operationId, requestHash, "link");
    if (replay) return { ...(replay as Omit<LinkResult, "replayed">), replayed: true };
    const existing = await tx.query<{ id: string }>(
      "SELECT id FROM hs_document_record_links WHERE workspace_id=$1 AND doc_type=$2 AND doc_id=$3 AND record_id=$4",
      [here.workspaceId, input.docType, input.docId, record.id],
    );
    let linkId = existing.rows[0]?.id;
    const already = !!linkId;
    if (!linkId) {
      linkId = randomUUID();
      await tx.query(
        "INSERT INTO hs_document_record_links(id,workspace_id,tenant_id,doc_type,doc_id,record_id,created_by) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [linkId, here.workspaceId, here.tenantId, input.docType, input.docId, record.id, actor.id],
      );
      if (file?.unlinked_at) await tx.query("UPDATE hs_linked_files SET unlinked_at=NULL, purge_after=NULL, updated_at=clock_timestamp() WHERE id=$1", [file.id]);
    }
    const result: Omit<LinkResult, "replayed"> = { linked: true, already, linkId, docType: input.docType, docId: input.docId, recordId: record.id };
    await audit(tx, actor, "document-link.link", input.operationId, { workspaceId: here.workspaceId, docType: input.docType, docId: input.docId, recordId: record.id, linkId, already }, page?.id);
    await remember(tx, here.workspaceId, actor.id, input.operationId, requestHash, "link", result);
    return { ...result, replayed: false };
  });
}

export async function unlinkDocumentRecord(pages: Repository, actor: Actor, workspaceId: string, input: { operationId: string; tenantId?: string; docType: DocType; docId: string; recordId: string; disposition?: LinkDisposition }): Promise<UnlinkResult> {
  if (!uuidPattern.test(input.operationId)) throw invalid();
  if (input.disposition && input.disposition !== "delete" && input.disposition !== "keep") throw invalid();
  const requestHash = recordHash({ kind: "unlink", docType: input.docType, docId: input.docId, recordId: input.recordId, disposition: input.disposition ?? null, tenantId: input.tenantId ?? null });
  return pages.db.transaction(async tx => {
    await lockActor(tx, actor.id);
    const here = await scope(tx, workspaceId, actor, input.tenantId);
    const record = assertLinkable(await loadRecord(tx, here.tenantId, actor.id, input.recordId, true));
    let pageId: string | undefined;
    if (input.docType === "page") {
      if (!pageIdPattern.test(input.docId)) throw unavailable();
      const marker = await tx.query<{ deleted_at: string | null; owner_id: string; workspace_id: string }>("SELECT deleted_at, owner_id, workspace_id FROM hs_pages WHERE id=$1", [input.docId]);
      const page = marker.rows[0];
      if (!page || page.workspace_id !== here.workspaceId) throw unavailable();
      if (page.deleted_at) {
        if (page.owner_id !== actor.id) throw unavailable();
        await tx.query("SELECT id FROM hs_pages WHERE id=$1 FOR UPDATE", [input.docId]);
        pageId = input.docId;
      } else {
        pageId = (await editablePage(pages, tx, actor, here.workspaceId, input.docId)).id;
      }
    }
    const file = input.docType === "file" ? await editableFile(tx, actor, here, input.docId) : null;
    const replay = await priorOperation(tx, here.workspaceId, actor.id, input.operationId, requestHash, "unlink");
    if (replay) return { ...(replay as Omit<UnlinkResult, "replayed">), replayed: true };
    const link = await tx.query<{ id: string }>(
      "SELECT id FROM hs_document_record_links WHERE workspace_id=$1 AND doc_type=$2 AND doc_id=$3 AND record_id=$4 FOR UPDATE",
      [here.workspaceId, input.docType, input.docId, record.id],
    );
    if (!link.rows.length) {
      const result: Omit<UnlinkResult, "replayed"> = { unlinked: true, already: true, docType: input.docType, docId: input.docId, recordId: record.id };
      await remember(tx, here.workspaceId, actor.id, input.operationId, requestHash, "unlink", result);
      return { ...result, replayed: false };
    }
    if (file) {
      const count = await tx.query<{ n: number | string }>(
        "SELECT count(*)::int AS n FROM hs_document_record_links WHERE workspace_id=$1 AND doc_type='file' AND doc_id=$2",
        [here.workspaceId, file.id],
      );
      if (Number(count.rows[0]?.n ?? 0) <= 1 && !input.disposition) throw choiceRequired();
    }
    await tx.query("DELETE FROM hs_document_record_links WHERE id=$1", [link.rows[0].id]);
    let fileState: "linked" | "kept" | "deleted" | "unchanged" = "unchanged";
    if (file && input.disposition) {
      const left = await tx.query<{ n: number | string }>(
        "SELECT count(*)::int AS n FROM hs_document_record_links WHERE workspace_id=$1 AND doc_type='file' AND doc_id=$2",
        [here.workspaceId, file.id],
      );
      if (Number(left.rows[0]?.n ?? 0) === 0) {
        if (input.disposition === "delete") {
          await tx.query("UPDATE hs_linked_files SET deleted_at=clock_timestamp(), unlinked_at=NULL, purge_after=NULL, updated_at=clock_timestamp() WHERE id=$1", [file.id]);
          fileState = "deleted";
        } else {
          await tx.query("UPDATE hs_linked_files SET unlinked_at=clock_timestamp(), purge_after=clock_timestamp()+interval '30 days', updated_at=clock_timestamp() WHERE id=$1", [file.id]);
          fileState = "kept";
        }
      }
    }
    const result: Omit<UnlinkResult, "replayed"> = { unlinked: true, already: false, docType: input.docType, docId: input.docId, recordId: record.id, fileState };
    await audit(tx, actor, "document-link.unlink", input.operationId, { workspaceId: here.workspaceId, docType: input.docType, docId: input.docId, recordId: record.id, linkId: link.rows[0].id, fileState }, pageId);
    await remember(tx, here.workspaceId, actor.id, input.operationId, requestHash, "unlink", result);
    return { ...result, replayed: false };
  });
}

export async function registerLinkedFile(pages: Repository, actor: Actor, workspaceId: string, input: { operationId: string; tenantId?: string; name: string; recordId: string; mediaId?: string }): Promise<RegisterResult> {
  if (!uuidPattern.test(input.operationId)) throw invalid();
  const name = input.name.trim().normalize("NFC");
  if (!name || Array.from(name).length > 240 || /[\p{Cc}]/u.test(name)) throw invalid();
  const requestHash = recordHash({ kind: "register-file", name, recordId: input.recordId, mediaId: input.mediaId ?? null, tenantId: input.tenantId ?? null });
  return pages.db.transaction(async tx => {
    await lockActor(tx, actor.id);
    const here = await scope(tx, workspaceId, actor, input.tenantId);
    const record = assertLinkable(await loadRecord(tx, here.tenantId, actor.id, input.recordId, true));
    const mediaId = input.mediaId ? await readableMedia(pages, tx, actor, here.workspaceId, input.mediaId) : null;
    const replay = await priorOperation(tx, here.workspaceId, actor.id, input.operationId, requestHash, "register-file");
    if (replay) return { ...(replay as Omit<RegisterResult, "replayed">), replayed: true };
    const fileId = randomUUID();
    const linkId = randomUUID();
    await tx.query(
      "INSERT INTO hs_linked_files(id,workspace_id,tenant_id,name,owner_id,media_id) VALUES($1,$2,$3,$4,$5,$6)",
      [fileId, here.workspaceId, here.tenantId, name, actor.id, mediaId],
    );
    await tx.query(
      "INSERT INTO hs_document_record_links(id,workspace_id,tenant_id,doc_type,doc_id,record_id,created_by) VALUES($1,$2,$3,'file',$4,$5,$6)",
      [linkId, here.workspaceId, here.tenantId, fileId, record.id, actor.id],
    );
    const result: Omit<RegisterResult, "replayed"> = { fileId, linkId, recordId: record.id, docType: "file", name };
    await audit(tx, actor, "document-link.register-file", input.operationId, { workspaceId: here.workspaceId, docType: "file", docId: fileId, recordId: record.id, linkId, mediaLinked: !!mediaId });
    await remember(tx, here.workspaceId, actor.id, input.operationId, requestHash, "register-file", result);
    return { ...result, replayed: false };
  });
}

type DocumentRow = {
  link_id: string;
  doc_type: DocType;
  doc_id: string;
  record_id: string;
  created_at: string;
  page_title: string | null;
  page_owner: string | null;
  page_deleted: string | null;
  page_updated: string | null;
  page_workspace: string | null;
  file_name: string | null;
  file_owner: string | null;
  file_deleted: string | null;
  file_updated: string | null;
};

async function visibleDocument(pages: Repository, tx: Sql, actor: Actor, here: Scope, row: DocumentRow, recordCanLink: boolean): Promise<AssociationItem | null> {
  if (row.doc_type === "page") {
    if (!row.page_owner || row.page_workspace !== here.workspaceId) return null;
    if (row.page_deleted) {
      if (row.page_owner !== actor.id) return null;
      return itemFrom(row, row.page_title, "in-trash", "In trash", row.page_owner, row.page_updated ?? row.created_at, recordCanLink, null);
    }
    try {
      const page = await pages.access(tx, row.doc_id, actor, false);
      if (page.workspace_id !== here.workspaceId) return null;
      return itemFrom(row, page.title, "visible", null, page.owner_id, page.updated_at, recordCanLink && canEdit(page.role), `/pages/${page.id}`);
    } catch (error) {
      if (error instanceof DocumentError && error.status === 404) return null;
      throw error;
    }
  }
  if (!row.file_owner || row.file_deleted) return null;
  const canEditFile = row.file_owner === actor.id || here.role === "owner" || here.role === "admin";
  return itemFrom(row, row.file_name, "visible", null, row.file_owner, row.file_updated ?? row.created_at, recordCanLink && canEditFile, null);
}

function itemFrom(row: DocumentRow, title: string | null, availability: "visible" | "in-trash", label: "In trash" | null, ownerId: string, updatedAt: string, canUnlink: boolean, href: string | null): AssociationItem {
  return {
    linkId: row.link_id,
    docType: row.doc_type,
    docId: row.doc_id,
    recordId: row.record_id,
    title,
    availability,
    label,
    ownerId,
    updatedAt: iso(updatedAt),
    linkedAt: iso(row.created_at),
    linkedAtLabel: formatLinkedAtIst(row.created_at),
    href,
    canUnlink,
  };
}

function pageSlice<T extends { linkId: string }>(rows: T[], cursor: string | null, filter: string): { items: T[]; nextCursor: string | null } {
  let start = 0;
  if (cursor) {
    let parsed: { id?: string; filter?: string };
    try { parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as { id?: string; filter?: string }; } catch { throw invalid(); }
    if (!parsed.id || !uuidPattern.test(parsed.id) || parsed.filter !== filter) throw new DocumentError("Refresh this document list.", "document_link_cursor", 409);
    const index = rows.findIndex(row => row.linkId === parsed.id);
    if (index < 0) throw new DocumentError("Refresh this document list.", "document_link_cursor", 409);
    start = index + 1;
  }
  const items = rows.slice(start, start + PAGE_SIZE);
  const nextCursor = start + PAGE_SIZE < rows.length && items.length ? Buffer.from(JSON.stringify({ id: items[items.length - 1].linkId, filter }), "utf8").toString("base64url") : null;
  return { items, nextCursor };
}

export async function listRecordDocuments(pages: Repository, actor: Actor, workspaceId: string, query: { tenantId?: string; recordId: string; type?: string; owner?: string; updatedFrom?: string; updatedTo?: string; cursor?: string }) {
  if (query.type && query.type !== "page" && query.type !== "file") throw invalid();
  if (query.owner && (query.owner.length > 200 || /[\p{Cc}]/u.test(query.owner))) throw invalid();
  const from = query.updatedFrom ? istDay(query.updatedFrom, false) : null;
  const to = query.updatedTo ? istDay(query.updatedTo, true) : null;
  return pages.db.transaction(async tx => {
    const here = await scope(tx, workspaceId, actor, query.tenantId);
    const record = await loadRecord(tx, here.tenantId, actor.id, query.recordId);
    if (!record || !record.can_view || (record.state === "trashed" && !record.can_restore)) throw unavailable();
    const rows = await tx.query<DocumentRow>(
      `SELECT l.id AS link_id, l.doc_type, l.doc_id, l.record_id, l.created_at,
        p.title AS page_title, p.owner_id AS page_owner, p.deleted_at AS page_deleted, p.updated_at AS page_updated, p.workspace_id AS page_workspace,
        f.name AS file_name, f.owner_id AS file_owner, f.deleted_at AS file_deleted, f.updated_at AS file_updated
       FROM hs_document_record_links l
       LEFT JOIN hs_pages p ON l.doc_type='page' AND p.id=l.doc_id
       LEFT JOIN hs_linked_files f ON l.doc_type='file' AND f.id::text=l.doc_id AND f.tenant_id=l.tenant_id
       WHERE l.workspace_id=$1 AND l.record_id=$2
         AND ($3::text IS NULL OR l.doc_type=$3)
         AND ($4::text IS NULL OR COALESCE(p.owner_id, f.owner_id)=$4)
         AND ($5::timestamptz IS NULL OR COALESCE(p.updated_at, f.updated_at, l.created_at) >= $5)
         AND ($6::timestamptz IS NULL OR COALESCE(p.updated_at, f.updated_at, l.created_at) <= $6)
       ORDER BY COALESCE(p.updated_at, f.updated_at, l.created_at) DESC, l.id DESC
       LIMIT $7`,
      [here.workspaceId, record.id, query.type || null, query.owner || null, from, to, SCAN_CAP],
    );
    const visible: AssociationItem[] = [];
    for (const row of rows.rows) {
      const item = await visibleDocument(pages, tx, actor, here, row, record.can_link && record.state === "active");
      if (item) visible.push(item);
    }
    const filter = recordHash({ scope: "record", recordId: record.id, type: query.type ?? "", owner: query.owner ?? "", from, to });
    const sliced = pageSlice(visible, query.cursor ?? null, filter);
    return { items: sliced.items, nextCursor: sliced.nextCursor, countLabel: `${visible.length} you can see`, canLink: record.can_link && record.state === "active", limited: rows.rows.length >= SCAN_CAP } satisfies AssociationList;
  });
}

type RecordLinkRow = RecordRow & { link_id: string; created_at: string };

export async function listDocumentRecords(pages: Repository, actor: Actor, workspaceId: string, query: { tenantId?: string; docType: DocType; docId: string; cursor?: string }) {
  if (query.docType !== "page" && query.docType !== "file") throw invalid();
  return pages.db.transaction(async tx => {
    const here = await scope(tx, workspaceId, actor, query.tenantId);
    let canEditDocument = false;
    if (query.docType === "page") {
      if (!pageIdPattern.test(query.docId)) throw unavailable();
      const marker = await tx.query<{ deleted_at: string | null; owner_id: string; workspace_id: string }>("SELECT deleted_at, owner_id, workspace_id FROM hs_pages WHERE id=$1", [query.docId]);
      const page = marker.rows[0];
      if (!page || page.workspace_id !== here.workspaceId) throw unavailable();
      if (page.deleted_at) {
        if (page.owner_id !== actor.id) throw unavailable();
        canEditDocument = true;
      } else {
        try {
          const open = await pages.access(tx, query.docId, actor, false);
          canEditDocument = canEdit(open.role);
        } catch (error) {
          if (error instanceof DocumentError && error.status === 404) throw unavailable();
          throw error;
        }
      }
    } else {
      if (!uuidPattern.test(query.docId)) throw unavailable();
      const file = await tx.query<{ owner_id: string; deleted_at: string | null; workspace_id: string }>("SELECT owner_id, deleted_at, workspace_id FROM hs_linked_files WHERE id=$1 AND tenant_id=$2", [query.docId, here.tenantId]);
      const row = file.rows[0];
      if (!row || row.deleted_at || row.workspace_id !== here.workspaceId) throw unavailable();
      canEditDocument = row.owner_id === actor.id || here.role === "owner" || here.role === "admin";
      if (!canEditDocument) {
        const visible = await tx.query(
          `SELECT 1 FROM hs_document_record_links l JOIN hs_data_records r ON r.id=l.record_id AND r.tenant_id=l.tenant_id
           WHERE l.doc_type='file' AND l.doc_id=$1 AND l.workspace_id=$2 AND ${viewGrant("$3")} LIMIT 1`,
          [query.docId, here.workspaceId, actor.id],
        );
        if (!visible.rows.length) throw unavailable();
      }
    }
    const rows = await tx.query<RecordLinkRow>(
      `SELECT l.id AS link_id, l.created_at, r.id, r.name, r.collection, r.state, r.updated_at,
        ${viewGrant("$4")} AS can_view, ${linkGrant("$4")} AS can_link, ${restoreGrant("$4")} AS can_restore
       FROM hs_document_record_links l
       JOIN hs_data_records r ON r.id=l.record_id AND r.tenant_id=l.tenant_id
       WHERE l.workspace_id=$1 AND l.doc_type=$2 AND l.doc_id=$3 AND r.merged_into_id IS NULL
       ORDER BY l.created_at DESC, l.id DESC
       LIMIT $5`,
      [here.workspaceId, query.docType, query.docId, actor.id, SCAN_CAP],
    );
    const visible: AssociationItem[] = [];
    for (const row of rows.rows) {
      const shown = recordListItem(here, query, row, canEditDocument);
      if (shown) visible.push(shown);
    }
    const filter = recordHash({ scope: "document", docType: query.docType, docId: query.docId });
    const sliced = pageSlice(visible, query.cursor ?? null, filter);
    return { items: sliced.items, nextCursor: sliced.nextCursor, countLabel: `${visible.length} you can see`, canLink: canEditDocument, limited: rows.rows.length >= SCAN_CAP } satisfies AssociationList;
  });
}

function recordListItem(here: Scope, query: { docType: DocType; docId: string }, row: RecordLinkRow, canEditDocument: boolean): AssociationItem | null {
  const ended = row.state === "archived" || row.state === "trashed";
  if (!row.can_view && !(ended && row.can_restore)) return null;
  if (ended && !row.can_restore) return null;
  return {
    linkId: row.link_id,
    docType: query.docType,
    docId: query.docId,
    recordId: row.id,
    title: row.can_view ? row.name : null,
    availability: ended ? "in-trash" : "visible",
    label: ended ? "In trash" : null,
    ownerId: "",
    updatedAt: iso(row.updated_at),
    linkedAt: iso(row.created_at),
    linkedAtLabel: formatLinkedAtIst(row.created_at),
    href: row.can_view && row.state !== "trashed" ? recordPageHref(here.workspaceId, here.tenantId, row.collection, row.id) : null,
    canUnlink: canEditDocument && row.can_link && row.state === "active",
  };
}

async function expireUnlinked(tx: Sql, workspaceId: string) {
  await tx.query(
    `UPDATE hs_linked_files SET deleted_at=clock_timestamp()
     WHERE id IN (SELECT id FROM hs_linked_files WHERE workspace_id=$1 AND deleted_at IS NULL AND purge_after IS NOT NULL AND purge_after <= clock_timestamp() LIMIT 50)`,
    [workspaceId],
  );
}

export async function listUnlinkedFiles(pages: Repository, actor: Actor, workspaceId: string, query: { tenantId?: string; cursor?: string } = {}) {
  return pages.db.transaction(async tx => {
    const here = await scope(tx, workspaceId, actor, query.tenantId);
    await expireUnlinked(tx, here.workspaceId);
    const privileged = here.role === "owner" || here.role === "admin";
    const rows = await tx.query<{ id: string; name: string; unlinked_at: string; purge_after: string }>(
      `SELECT id, name, unlinked_at, purge_after FROM hs_linked_files
       WHERE workspace_id=$1 AND tenant_id=$2 AND deleted_at IS NULL AND unlinked_at IS NOT NULL AND purge_after > clock_timestamp()
         AND ($3::boolean OR owner_id=$4)
       ORDER BY unlinked_at DESC, id DESC
       LIMIT $5`,
      [here.workspaceId, here.tenantId, privileged, actor.id, SCAN_CAP],
    );
    const visible: (UnlinkedFileItem & { linkId: string })[] = rows.rows.map(row => ({
      linkId: row.id,
      fileId: row.id,
      name: row.name,
      unlinkedAt: iso(row.unlinked_at),
      unlinkedAtLabel: formatLinkedAtIst(row.unlinked_at),
      purgeAfter: iso(row.purge_after),
      purgeAfterLabel: formatLinkedAtIst(row.purge_after),
    }));
    const filter = recordHash({ scope: "unlinked", workspaceId: here.workspaceId, actor: privileged ? "*" : actor.id });
    const sliced = pageSlice(visible, query.cursor ?? null, filter);
    return { items: sliced.items.map(({ linkId: _, ...item }) => item), nextCursor: sliced.nextCursor, countLabel: `${visible.length} you can see` };
  });
}

export async function listPageRecords(pages: Repository, actor: Actor, pageId: string, cursor?: string) {
  const workspace = await pages.db.transaction(async tx => {
    const row = await tx.query<{ workspace_id: string }>("SELECT workspace_id FROM hs_pages WHERE id=$1", [pageId]);
    return row.rows[0]?.workspace_id ?? "";
  });
  return listDocumentRecords(pages, actor, workspace, { docType: "page", docId: pageId, cursor });
}
