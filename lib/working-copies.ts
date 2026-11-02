import { createHash, randomUUID } from "node:crypto";
import type { Actor } from "./auth";
import type { Sql } from "./database";
import { DocumentError, documentBlocks, stableStringify, validateDocument, type RichNode } from "./document";
import { formatIst } from "./ist-label";
import { validateNewPageReferences } from "./page-references";
import type { Repository } from "./repository";
import { validateNewRecordLinks } from "./record-backlinks";
import { validateRecordPageReferences } from "./record-page-ref-store";
import { stripSyncedContent } from "./synced-blocks";
import { standardRecordFields } from "./shared-record-types";
import { canEdit } from "./types";
import { ensureAuthorFollow } from "./page-follow-store";
import { isWorkingCopyPage } from "./working-copy-access";
import {
  forkDocument,
  mergeWorkingCopy,
  redactTopLevel,
  type BlockLink,
  type HiddenField,
  type WorkingChoice,
} from "./working-copy-plan";

const unavailable = () => new DocumentError("Working copy unavailable", "not_found", 404);
const choiceError = () => new DocumentError("Choose each conflict before applying the working copy.", "working_copy_choice", 422);
const closed = () => new DocumentError("This working copy is no longer open.", "working_copy_closed", 409);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type CopyRow = {
  id: string;
  workspace_id: string;
  copy_page_id: string;
  source_page_id: string;
  owner_id: string;
  base_version: number;
  captured_page_version: number;
  base_title: string;
  base_document: RichNode | string;
  block_map: BlockLink[] | string;
  media_map: BlockLink[] | string;
  redacted_blocks: string[] | string;
  hidden_fields: HiddenField[] | string;
  choices: Record<string, WorkingChoice> | string;
  state: "open" | "applied" | "abandoned" | "archived";
  version: number;
  applied_source_version: number | null;
};

export type WorkingCopySummary = {
  id: string;
  copyPageId: string;
  sourcePageId: string;
  baseVersion: number;
  capturedPageVersion: number;
  state: CopyRow["state"];
  version: number;
  title: string;
  sourceTitle: string | null;
  sourceReadable: boolean;
  sourceEditable: boolean;
  appliedSourceVersion: number | null;
  choices: Record<string, WorkingChoice>;
};

function asJson<T>(value: T | string): T {
  return typeof value === "string" ? JSON.parse(value) as T : value;
}

function digest(value: unknown) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

async function audit(tx: Sql, actor: Actor, pageId: string, action: string, operationId: string, after: Record<string, unknown>) {
  await tx.query("INSERT INTO hs_audit(id, actor_id, action, page_id, after_value, correlation_id) VALUES($1,$2,$3,$4,$5,$6)", [randomUUID(), actor.id, action, pageId, JSON.stringify({ ...after, atIst: formatIst(new Date()) }), operationId]);
}

async function remembered(tx: Sql, actor: Actor, operationId: string, requestHash: string) {
  const prior = await tx.query<{ request_hash: string; result: unknown }>("SELECT request_hash, result FROM hs_working_copy_operations WHERE actor_id=$1 AND operation_id=$2", [actor.id, operationId]);
  const row = prior.rows[0];
  if (!row) return null;
  if (row.request_hash !== requestHash) throw new DocumentError("Operation ID was reused with different content", "operation_mismatch", 409);
  const result = asJson<Record<string, unknown>>(row.result as Record<string, unknown> | string);
  return { ...result, replayed: true };
}

async function finish(tx: Sql, actor: Actor, operationId: string, requestHash: string, copyId: string, result: Record<string, unknown>) {
  await tx.query("INSERT INTO hs_working_copy_operations(actor_id, operation_id, request_hash, copy_id, result) VALUES($1,$2,$3,$4,$5)", [actor.id, operationId, requestHash, copyId, JSON.stringify(result)]);
  return { ...result, replayed: false };
}

async function owned(tx: Sql, actor: Actor, id: string, lock = false) {
  const rows = await tx.query<CopyRow>(`SELECT * FROM hs_working_copies WHERE id=$1 AND owner_id=$2 ${lock ? "FOR UPDATE" : ""}`, [id, actor.id]);
  if (!rows.rows.length) throw unavailable();
  return rows.rows[0];
}

async function sourceAccess(r: Repository, tx: Sql, actor: Actor, pageId: string, edit: boolean) {
  try {
    return await r.access(tx, pageId, actor, edit, true);
  } catch (error) {
    if (error instanceof DocumentError && error.status === 404) throw edit ? error : unavailable();
    throw error;
  }
}

async function summary(r: Repository, tx: Sql, actor: Actor, row: CopyRow): Promise<WorkingCopySummary> {
  const copy = await tx.query<{ title: string }>("SELECT title FROM hs_pages WHERE id=$1", [row.copy_page_id]);
  let sourceTitle: string | null = null;
  let sourceReadable = false;
  let sourceEditable = false;
  try {
    const source = await r.access(tx, row.source_page_id, actor, false);
    sourceReadable = true;
    sourceEditable = canEdit(source.role);
    sourceTitle = source.title;
  } catch (error) {
    if (!(error instanceof DocumentError) || error.status !== 404) throw error;
  }
  return {
    id: row.id,
    copyPageId: row.copy_page_id,
    sourcePageId: row.source_page_id,
    baseVersion: Number(row.base_version),
    capturedPageVersion: Number(row.captured_page_version),
    state: row.state,
    version: Number(row.version),
    title: copy.rows[0]?.title ?? "Working copy",
    sourceTitle,
    sourceReadable,
    sourceEditable,
    appliedSourceVersion: row.applied_source_version == null ? null : Number(row.applied_source_version),
    choices: asJson(row.choices) ?? {},
  };
}

async function tenantId(tx: Sql, workspaceId: string) {
  const row = await tx.query<{ tenant_id: string }>("SELECT tenant_id FROM hs_data_workspaces WHERE workspace_id=$1", [workspaceId]);
  return row.rows[0]?.tenant_id ?? null;
}

async function recordVisible(tx: Sql, tenant: string, actorId: string, recordId: string, collection: string) {
  if (!uuid.test(recordId)) return false;
  const row = await tx.query(
    `SELECT 1 FROM hs_data_records r WHERE r.id=$1 AND r.tenant_id=$2 AND r.collection=$3 AND r.merged_into_id IS NULL AND r.state='active'
     AND (EXISTS(SELECT 1 FROM hs_data_collection_grants g WHERE g.tenant_id=r.tenant_id AND g.user_id=$4 AND g.collection=r.collection AND 'view'=ANY(g.capabilities))
       OR EXISTS(SELECT 1 FROM hs_data_record_grants g WHERE g.tenant_id=r.tenant_id AND g.record_id=r.id AND g.user_id=$4 AND 'view'=ANY(g.capabilities)))`,
    [recordId, tenant, collection, actorId],
  );
  return row.rows.length > 0;
}

async function viewVisible(tx: Sql, tenant: string, workspaceId: string, actorId: string, viewId: string, collection: string) {
  if (!uuid.test(viewId)) return false;
  const row = await tx.query(
    `SELECT 1 FROM hs_data_views v WHERE v.id=$1 AND v.tenant_id=$2 AND v.workspace_id=$3 AND v.collection=$4 AND v.deleted=false AND (v.scope='workspace' OR v.owner_id=$5)
     AND (EXISTS(SELECT 1 FROM hs_data_collection_grants g WHERE g.tenant_id=v.tenant_id AND g.user_id=$5 AND g.collection=v.collection AND 'view'=ANY(g.capabilities))
       OR EXISTS(SELECT 1 FROM hs_data_record_grants g JOIN hs_data_records r ON r.tenant_id=g.tenant_id AND r.id=g.record_id WHERE g.tenant_id=v.tenant_id AND g.user_id=$5 AND r.collection=v.collection AND 'view'=ANY(g.capabilities)))`,
    [viewId, tenant, workspaceId, collection, actorId],
  );
  return row.rows.length > 0;
}

async function hiddenKeys(tx: Sql, tenant: string, actorId: string, collection: string, keys: string[]) {
  const secret = new Set(standardRecordFields(collection).filter(field => field.sensitive).map(field => field.key));
  const sensitive = await tx.query<{ field_key: string }>("SELECT field_key FROM hs_data_fields WHERE tenant_id=$1 AND collection=$2 AND sensitive=true", [tenant, collection]);
  for (const row of sensitive.rows) secret.add(row.field_key);
  const granted = await tx.query<{ field_key: string }>("SELECT field_key FROM hs_data_field_permissions WHERE tenant_id=$1 AND collection=$2 AND user_id=$3 AND can_view=true", [tenant, collection, actorId]);
  const allowed = new Set(granted.rows.map(row => row.field_key));
  return keys.filter(key => secret.has(key) && !allowed.has(key));
}

async function permissionMask(tx: Sql, actor: Actor, workspaceId: string, sourcePageId: string, document: RichNode) {
  const blocked = new Set<string>();
  const hidden = new Map<string, string[]>();
  const tenant = await tenantId(tx, workspaceId);
  for (const block of documentBlocks(document)) {
    if ((block.type === "image" || block.type === "file") && typeof block.node.attrs?.attachmentId === "string") {
      const media = await tx.query("SELECT 1 FROM hs_media WHERE id=$1 AND page_id=$2 AND state='ready' AND deleted_at IS NULL", [block.node.attrs.attachmentId, sourcePageId]);
      if (!media.rows.length) blocked.add(block.id);
    }
    if (block.type !== "recordRef" && block.type !== "recordView") continue;
    if (!tenant) {
      blocked.add(block.id);
      continue;
    }
    const collection = String(block.node.attrs?.collectionId ?? "");
    if (block.type === "recordRef") {
      const recordId = String(block.node.attrs?.recordId ?? "");
      if (!await recordVisible(tx, tenant, actor.id, recordId, collection)) {
        blocked.add(block.id);
        continue;
      }
      const fields = Array.isArray(block.node.attrs?.fields) ? block.node.attrs.fields.filter((key): key is string => typeof key === "string") : [];
      const secret = await hiddenKeys(tx, tenant, actor.id, collection, fields);
      if (secret.length) hidden.set(block.id, secret);
    } else {
      const viewId = String(block.node.attrs?.viewId ?? "");
      const columns = Array.isArray(block.node.attrs?.columns) ? block.node.attrs.columns.filter((key): key is string => typeof key === "string") : [];
      if (!await viewVisible(tx, tenant, workspaceId, actor.id, viewId, collection)) {
        blocked.add(block.id);
        continue;
      }
      const secret = await hiddenKeys(tx, tenant, actor.id, collection, columns);
      const visible = columns.filter(key => !secret.includes(key));
      if (!visible.length) blocked.add(block.id);
      else if (secret.length) hidden.set(block.id, secret);
    }
  }
  const masked = redactTopLevel(document, blocked, hidden);
  return { document: masked.document, redacted: masked.redacted, hiddenFields: [...hidden].filter(([blockId]) => !masked.redacted.includes(blockId)).map(([blockId, keys]) => ({ blockId, keys })) };
}

function rewriteAttachments(node: RichNode, media: Map<string, string>): RichNode {
  const attrs = node.attrs ? { ...node.attrs } : undefined;
  if (attrs && typeof attrs.attachmentId === "string" && media.has(attrs.attachmentId)) attrs.attachmentId = media.get(attrs.attachmentId)!;
  return { ...node, ...(attrs ? { attrs } : {}), ...(node.content ? { content: node.content.map(child => rewriteAttachments(child, media)) } : {}) };
}

async function cloneMedia(tx: Sql, actor: Actor, sourcePageId: string, copyPageId: string, document: RichNode) {
  const map = new Map<string, string>();
  for (const block of documentBlocks(document)) {
    const attachmentId = block.node.attrs?.attachmentId;
    if ((block.type !== "image" && block.type !== "file") || typeof attachmentId !== "string" || map.has(attachmentId)) continue;
    const media = await tx.query<{ name: string; mime: string; size: string; object_key: string; sha256: string | null; scanned_at: string | null }>("SELECT name, mime, size, object_key, sha256, scanned_at FROM hs_media WHERE id=$1 AND page_id=$2 AND state='ready' AND deleted_at IS NULL", [attachmentId, sourcePageId]);
    const row = media.rows[0];
    if (!row) continue;
    const copyId = randomUUID();
    await tx.query("INSERT INTO hs_media(id, page_id, uploader_id, operation_id, name, mime, size, object_key, state, sha256, scanned_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'ready',$9,$10)", [copyId, copyPageId, actor.id, randomUUID(), row.name, row.mime, row.size, row.object_key, row.sha256, row.scanned_at]);
    map.set(attachmentId, copyId);
  }
  return { document: rewriteAttachments(document, map), mediaMap: [...map].map(([sourceId, copyId]) => ({ sourceId, copyId })) };
}

async function transplantMedia(tx: Sql, actor: Actor, sourcePageId: string, copyPageId: string, document: RichNode) {
  let next = document;
  const seen = new Set<string>();
  for (const block of documentBlocks(document)) {
    const attachmentId = block.node.attrs?.attachmentId;
    if ((block.type !== "image" && block.type !== "file") || typeof attachmentId !== "string" || seen.has(attachmentId)) continue;
    seen.add(attachmentId);
    const onSource = await tx.query("SELECT 1 FROM hs_media WHERE id=$1 AND page_id=$2 AND state='ready' AND deleted_at IS NULL", [attachmentId, sourcePageId]);
    if (onSource.rows.length) continue;
    const donor = await tx.query<{ name: string; mime: string; size: string; object_key: string; sha256: string | null; scanned_at: string | null }>("SELECT name, mime, size, object_key, sha256, scanned_at FROM hs_media WHERE id=$1 AND page_id=$2 AND state='ready' AND deleted_at IS NULL", [attachmentId, copyPageId]);
    const row = donor.rows[0];
    if (!row) throw new DocumentError("An attachment in the working copy is unavailable. The original was not changed.", "working_copy_media", 422);
    const id = randomUUID();
    await tx.query("INSERT INTO hs_media(id, page_id, uploader_id, operation_id, name, mime, size, object_key, state, sha256, scanned_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,'ready',$9,$10)", [id, sourcePageId, actor.id, randomUUID(), row.name, row.mime, row.size, row.object_key, row.sha256, row.scanned_at]);
    const replacement = new Map([[attachmentId, id]]);
    next = rewriteAttachments(next, replacement);
  }
  return next;
}

function unionHidden(stored: HiddenField[], current: HiddenField[]) {
  const map = new Map<string, Set<string>>();
  for (const field of [...stored, ...current]) map.set(field.blockId, new Set([...(map.get(field.blockId) ?? []), ...field.keys]));
  return [...map].map(([blockId, keys]) => ({ blockId, keys: [...keys] }));
}

async function compare(r: Repository, tx: Sql, actor: Actor, row: CopyRow, choices: Record<string, WorkingChoice>) {
  let source;
  try {
    source = await r.get(row.source_page_id, actor, tx, undefined, false);
  } catch (error) {
    if (error instanceof DocumentError && error.status === 404) throw unavailable();
    throw error;
  }
  const raw = stripSyncedContent(source.document);
  const masked = await permissionMask(tx, actor, row.workspace_id, row.source_page_id, raw);
  const copy = await r.get(row.copy_page_id, actor, tx, undefined, false);
  const merged = mergeWorkingCopy({
    baseTitle: row.base_title,
    base: asJson(row.base_document),
    originalTitle: source.title,
    original: masked.document,
    originalRaw: raw,
    copyTitle: copy.title,
    copy: copy.document,
    blockMap: asJson(row.block_map),
    mediaMap: asJson(row.media_map),
    redacted: [...new Set([...asJson<string[]>(row.redacted_blocks), ...masked.redacted])],
    hiddenFields: unionHidden(asJson(row.hidden_fields), masked.hiddenFields),
    choices,
  });
  return { source, copy, raw, merged };
}

export async function listWorkingCopies(r: Repository, actor: Actor, pageId: string) {
  return r.db.transaction(async tx => {
    let readable = false;
    try {
      await r.access(tx, pageId, actor, false, true);
      readable = true;
    } catch (error) {
      if (!(error instanceof DocumentError) || error.status !== 404) throw error;
    }
    const rows = await tx.query<CopyRow>("SELECT * FROM hs_working_copies WHERE owner_id=$1 AND (source_page_id=$2 OR copy_page_id=$2) ORDER BY created_at, id", [actor.id, pageId]);
    if (!rows.rows.length && !readable) throw unavailable();
    const copies = [];
    for (const row of rows.rows) copies.push(await summary(r, tx, actor, row));
    return { copies };
  });
}

type CreatedCopy = { id: string; copyPageId: string; sourcePageId: string; baseVersion: number; capturedPageVersion: number; version: number; state: "open"; title: string; replayed: boolean };
type AppliedCopy = { id: string; state: "applied"; version: number; sourceVersion: number; copyPageId: string; sourcePageId: string; replayed: boolean };
type ClosedCopy = { id: string; state: "abandoned" | "archived"; version: number; sourceVersion: number; copyPageId: string; sourcePageId: string; replayed: boolean };

export async function createWorkingCopy(r: Repository, actor: Actor, pageId: string, operationId: string): Promise<CreatedCopy> {
  const requestHash = digest({ action: "create", pageId, operationId });
  return r.db.transaction(async tx => {
    await tx.query("SELECT id FROM hs_users WHERE id=$1 FOR NO KEY UPDATE", [actor.id]);
    const prior = await remembered(tx, actor, operationId, requestHash);
    if (prior) return prior as CreatedCopy;
    const meta = await r.access(tx, pageId, actor, false, true);
    if (await isWorkingCopyPage(tx, pageId)) throw new DocumentError("Create a working copy from the original page.", "working_copy_private", 422);
    const member = await tx.query<{ role: string; archived_at: string | null }>("SELECT m.role, s.archived_at FROM hs_spaces s JOIN hs_members m ON m.workspace_id=s.workspace_id AND m.user_id=$2 AND m.active=true WHERE s.id=$1", [meta.space_id, actor.id]);
    if (!member.rows.length) throw unavailable();
    if (member.rows[0].role === "observer") throw new DocumentError("Observers cannot create pages", "read_only", 403);
    if (member.rows[0].archived_at) throw new DocumentError("This space is archived and read-only", "read_only", 403);
    const page = await r.get(pageId, actor, tx, undefined, false);
    const stored = stripSyncedContent(page.document);
    const masked = await permissionMask(tx, actor, meta.workspace_id, pageId, stored);
    const base = validateDocument(masked.document);
    const forked = forkDocument(base);
    const copyPageId = randomUUID();
    const title = `Working copy of ${page.title}`.slice(0, 240);
    await tx.query("INSERT INTO hs_pages(id, workspace_id, space_id, parent_id, owner_id, title, visibility) VALUES($1,$2,$3,NULL,$4,$5,'private')", [copyPageId, meta.workspace_id, meta.space_id, actor.id, title]);
    const media = await cloneMedia(tx, actor, pageId, copyPageId, forked.document);
    const copyDocument = validateDocument(media.document);
    await r.writeDocument(tx, copyPageId, copyDocument, 1, title, actor.id, "working-copy", undefined, operationId);
    await ensureAuthorFollow(tx, actor.id, copyPageId);
    const id = randomUUID();
    const baseVersion = page.publicationFingerprint ? page.version : meta.version;
    await tx.query(`INSERT INTO hs_working_copies(id, workspace_id, copy_page_id, source_page_id, owner_id, base_version, captured_page_version, base_title, base_document, block_map, media_map, redacted_blocks, hidden_fields, state)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'open')`, [id, meta.workspace_id, copyPageId, pageId, actor.id, baseVersion, meta.version, page.title, JSON.stringify(base), JSON.stringify(forked.blockMap), JSON.stringify(media.mediaMap), JSON.stringify(masked.redacted), JSON.stringify(masked.hiddenFields)]);
    const result = { id, copyPageId, sourcePageId: pageId, baseVersion, capturedPageVersion: meta.version, version: 1, state: "open" as const, title };
    await audit(tx, actor, copyPageId, "working-copy.create", operationId, { sourcePageId: pageId, copyPageId, baseVersion, capturedPageVersion: meta.version, workspaceId: meta.workspace_id });
    return finish(tx, actor, operationId, requestHash, id, result) as Promise<CreatedCopy>;
  });
}

export async function readWorkingCopy(r: Repository, actor: Actor, id: string) {
  return r.db.transaction(async tx => summary(r, tx, actor, await owned(tx, actor, id)));
}

export async function reconcileWorkingCopy(r: Repository, actor: Actor, id: string) {
  return r.db.transaction(async tx => {
    const row = await owned(tx, actor, id);
    const { source, merged } = await compare(r, tx, actor, row, {});
    return {
      id: row.id,
      version: Number(row.version),
      sourceVersion: source.version,
      baseVersion: Number(row.base_version),
      state: row.state,
      conflicts: merged.conflicts,
      preservedRestricted: merged.preservedRestricted,
      ready: merged.unresolved.length === 0,
    };
  });
}

export async function saveWorkingCopyChoices(r: Repository, actor: Actor, id: string, input: { operationId: string; expectedVersion: number; choices: Record<string, WorkingChoice> }) {
  const requestHash = digest({ action: "choices", id, ...input });
  return r.db.transaction(async tx => {
    const prior = await remembered(tx, actor, input.operationId, requestHash);
    if (prior) return prior;
    const row = await owned(tx, actor, id, true);
    if (row.state !== "open") throw closed();
    if (Number(row.version) !== input.expectedVersion) throw new DocumentError("The working copy changed. Review it again.", "working_copy_conflict", 409);
    const version = Number(row.version) + 1;
    await tx.query("UPDATE hs_working_copies SET choices=$2, version=$3, updated_at=clock_timestamp() WHERE id=$1", [id, JSON.stringify(input.choices), version]);
    const result = { id, version, state: row.state, choices: input.choices };
    await audit(tx, actor, row.copy_page_id, "working-copy.choices", input.operationId, { sourcePageId: row.source_page_id, copyPageId: row.copy_page_id, version, choiceKeys: Object.keys(input.choices) });
    return finish(tx, actor, input.operationId, requestHash, id, result);
  });
}

export async function applyWorkingCopy(r: Repository, actor: Actor, id: string, input: { operationId: string; expectedVersion: number; expectedSourceVersion: number; choices: Record<string, WorkingChoice> }): Promise<AppliedCopy> {
  const requestHash = digest({ action: "apply", id, ...input });
  return r.db.transaction(async tx => {
    const prior = await remembered(tx, actor, input.operationId, requestHash);
    if (prior) return prior as AppliedCopy;
    const row = await owned(tx, actor, id, true);
    if (row.state !== "open") throw closed();
    if (Number(row.version) !== input.expectedVersion) throw new DocumentError("The working copy changed. Review it again.", "working_copy_conflict", 409);
    const sourceMeta = await sourceAccess(r, tx, actor, row.source_page_id, true);
    if (sourceMeta.version !== input.expectedSourceVersion) throw new DocumentError("The original changed. Review the comparison again.", "working_copy_source_conflict", 409);
    await r.access(tx, row.copy_page_id, actor, true, true);
    const { source, merged } = await compare(r, tx, actor, row, input.choices);
    if (merged.unresolved.length || !merged.document || merged.title == null) throw choiceError();
    const transplanted = await transplantMedia(tx, actor, row.source_page_id, row.copy_page_id, merged.document);
    const document = validateDocument(transplanted);
    const current = stripSyncedContent(source.document);
    const title = merged.title.trim().slice(0, 240) || "Untitled";
    let version = sourceMeta.version;
    if (stableStringify(document) !== stableStringify(current) || title !== source.title) {
      await validateNewPageReferences(r, tx, actor, row.workspace_id, document, current);
      await validateRecordPageReferences(tx, actor, row.workspace_id, document, current);
      await validateNewRecordLinks(tx, actor, row.workspace_id, document, current);
      version = sourceMeta.version + 1;
      await r.writeDocument(tx, row.source_page_id, document, version, title, actor.id, "working-copy", undefined, input.operationId);
      await tx.query("UPDATE hs_pages SET title=$2, version=$3, updated_at=clock_timestamp() WHERE id=$1", [row.source_page_id, title, version]);
      await tx.query("UPDATE hs_media m SET deleted_at=CASE WHEN EXISTS(SELECT 1 FROM hs_blocks b WHERE b.page_id=$1 AND b.type IN ('image','file') AND b.node->'attrs'->>'attachmentId'=m.id::text) THEN NULL ELSE COALESCE(m.deleted_at,now()) END WHERE m.page_id=$1 AND m.state='ready'", [row.source_page_id]);
    }
    const nextVersion = Number(row.version) + 1;
    await tx.query("UPDATE hs_working_copies SET state='applied', version=$2, choices=$3, applied_source_version=$4, updated_at=clock_timestamp() WHERE id=$1", [id, nextVersion, JSON.stringify(input.choices), version]);
    const result = { id, state: "applied" as const, version: nextVersion, sourceVersion: version, copyPageId: row.copy_page_id, sourcePageId: row.source_page_id };
    await audit(tx, actor, row.copy_page_id, "working-copy.apply", input.operationId, { sourcePageId: row.source_page_id, copyPageId: row.copy_page_id, sourceVersion: version, version: nextVersion, conflicts: Object.keys(input.choices) });
    return finish(tx, actor, input.operationId, requestHash, id, result) as Promise<AppliedCopy>;
  });
}

async function closeCopy(r: Repository, actor: Actor, id: string, action: "abandon" | "archive", input: { operationId: string; expectedVersion: number }): Promise<ClosedCopy> {
  const requestHash = digest({ action, id, ...input });
  return r.db.transaction(async tx => {
    const prior = await remembered(tx, actor, input.operationId, requestHash);
    if (prior) return prior as ClosedCopy;
    const row = await owned(tx, actor, id, true);
    const allowed = action === "archive" ? row.state === "open" || row.state === "applied" : row.state === "open";
    if (!allowed) throw closed();
    if (Number(row.version) !== input.expectedVersion) throw new DocumentError("The working copy changed. Review it again.", "working_copy_conflict", 409);
    const source = await tx.query<{ version: number }>("SELECT version FROM hs_pages WHERE id=$1", [row.source_page_id]);
    const version = Number(row.version) + 1;
    const state = action === "archive" ? "archived" : "abandoned";
    await tx.query("UPDATE hs_working_copies SET state=$2, version=$3, updated_at=clock_timestamp() WHERE id=$1", [id, state, version]);
    const result = { id, state, version, sourceVersion: Number(source.rows[0]?.version ?? 0), copyPageId: row.copy_page_id, sourcePageId: row.source_page_id };
    await audit(tx, actor, row.copy_page_id, `working-copy.${action}`, input.operationId, { sourcePageId: row.source_page_id, copyPageId: row.copy_page_id, version, sourceVersion: result.sourceVersion });
    return finish(tx, actor, input.operationId, requestHash, id, result) as Promise<ClosedCopy>;
  });
}

export function abandonWorkingCopy(r: Repository, actor: Actor, id: string, input: { operationId: string; expectedVersion: number }) {
  return closeCopy(r, actor, id, "abandon", input);
}

export function archiveWorkingCopy(r: Repository, actor: Actor, id: string, input: { operationId: string; expectedVersion: number }) {
  return closeCopy(r, actor, id, "archive", input);
}
