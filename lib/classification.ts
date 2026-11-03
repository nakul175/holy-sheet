import { randomUUID } from "node:crypto";
import type { Actor } from "./auth";
import type { Sql } from "./database";
import { DocumentError } from "./document";
import { formatIst } from "./ist-label";
import type { Repository } from "./repository";
import { spaceHomeMemberRead } from "./space-home-shared";
import { recordHash } from "./shared-record-types";
import { canEdit } from "./types";
import { workingCopyVisibleSql } from "./working-copy-access";
import {
  assertHierarchy,
  classificationAssignment,
  classificationBoundary,
  classificationCode,
  classificationDocument,
  classificationLabel,
  classificationLimits,
  classificationReview,
  classificationScope,
  nextMembership,
  tagSelectable,
  type Handling,
  type TagStatus,
} from "./classification-plan";

export { classificationAssignment, classificationBoundary, classificationReview };

const source = "classification";
const unavailable = () => new DocumentError("Classification is restricted or unavailable.", "not_found", 404);
const refused = () => new DocumentError("This action is not permitted.", "classification_forbidden", 403);
const mismatch = () => new DocumentError("This attempt was reused with different fields.", "operation_mismatch", 409);
const conflict = () => new DocumentError("The classification version changed. Review it and try again.", "classification_conflict", 409);
const invalid = () => new DocumentError("Check the classification request.", "classification_validation", 422);
const readOnly = () => new DocumentError("This classification is read only.", "read_only", 403);
const managementRequired = () => new DocumentError("Classification configuration authority is required.", "management_required", 403);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type Scope = { workspaceId: string; tenantId: string; role: string };
type TagRow = {
  id: string; tenant_id: string; code: string; label: string; parent_id: string | null; documents: boolean | string;
  collections: unknown; status: TagStatus; merged_into_id: string | null; handling: Handling; version: number | string;
};
type TargetKind = "page" | "record";
export type TagDraftView = { label: string; parentId: string | null; documents: boolean; collections: string[]; handling: Handling; clearedUserIds: string[]; baseVersion: number };
export type TagView = {
  id: string; code: string; label: string; status: TagStatus; parentId: string | null; documents: boolean; handling: Handling; version: number;
  collections?: string[]; clearedUserIds?: string[]; mergedIntoId?: string | null; recoverableDraft?: TagDraftView | null;
};
export type AssignmentView = { kind: TargetKind; id: string; title: string; version: number; canAssign: boolean; tags: { id: string; code: string; label: string; status: TagStatus }[]; choices: { id: string; code: string; label: string }[] };
type SaveInput = { operationId: string; expectedVersion: number; label: string; parentId: string | null; documents: boolean; collections: string[]; handling: Handling; clearedUserIds: string[] };

const grant = (capability: "view" | "edit" | "export" | "history") => `(EXISTS(SELECT 1 FROM hs_data_collection_grants g WHERE g.tenant_id=r.tenant_id AND g.user_id=$3 AND g.collection=r.collection AND '${capability}'=ANY(g.capabilities)) OR EXISTS(SELECT 1 FROM hs_data_record_grants g WHERE g.tenant_id=r.tenant_id AND g.record_id=r.id AND g.user_id=$3 AND '${capability}'=ANY(g.capabilities)))`;

function on(value: unknown) { return value === true || value === "t" || value === "true" || value === 1; }
function num(value: number | string | null | undefined) { return Number(value ?? 0); }
function asRecord(value: unknown) { return (typeof value === "string" ? JSON.parse(value) : value ?? {}) as Record<string, unknown>; }
function textList(value: unknown) {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
}
function uniqueViolation(error: unknown) {
  const value = error as { code?: string; cause?: { code?: string } };
  return value?.code === "23505" || value?.cause?.code === "23505";
}

async function scopeOf(tx: Sql, workspaceId: string, actor: Actor): Promise<Scope> {
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
  const row = await tx.query<{ request_hash: string; result: unknown }>("SELECT request_hash, result FROM hs_classification_operations WHERE actor_id=$1 AND operation_id=$2", [actorId, operationId]);
  if (!row.rows[0]) return null;
  if (row.rows[0].request_hash !== requestHash) throw mismatch();
  return { ...asRecord(row.rows[0].result), replayed: true };
}

async function remember(tx: Sql, actorId: string, operationId: string, requestHash: string, result: Record<string, unknown>) {
  await tx.query("INSERT INTO hs_classification_operations(actor_id,operation_id,request_hash,result) VALUES($1,$2,$3,$4)", [actorId, operationId, requestHash, JSON.stringify(result)]);
}

async function hold(tx: Sql, tenantId: string) {
  await tx.query("SELECT id FROM hs_data_tenants WHERE id=$1 FOR UPDATE", [tenantId]);
}

async function isManager(tx: Sql, here: Scope, actor: Actor) {
  if (here.role === "owner" || here.role === "admin") return true;
  if (here.role === "observer") return false;
  const row = await tx.query("SELECT 1 FROM hs_classification_managers WHERE workspace_id=$1 AND user_id=$2", [here.workspaceId, actor.id]);
  return row.rows.length > 0;
}

async function requireManager(tx: Sql, here: Scope, actor: Actor, native = false) {
  if (here.role === "observer") throw readOnly();
  if (native && here.role !== "owner" && here.role !== "admin") throw managementRequired();
  if (!await isManager(tx, here, actor)) throw managementRequired();
}

async function activeMember(tx: Sql, workspaceId: string, userId: string) {
  const row = await tx.query<{ role: string }>("SELECT role FROM hs_members WHERE workspace_id=$1 AND user_id=$2 AND active=true", [workspaceId, userId]);
  return row.rows[0] ?? null;
}

function collectionsOf(row: TagRow) { return textList(row.collections); }

async function loadTags(tx: Sql, tenantId: string) {
  const row = await tx.query<TagRow>("SELECT id, tenant_id, code, label, parent_id, documents, collections, status, merged_into_id, handling, version FROM hs_classification_tags WHERE tenant_id=$1 ORDER BY code, id", [tenantId]);
  return row.rows;
}

async function loadTag(tx: Sql, tenantId: string, id: string, lock = false) {
  if (!uuidPattern.test(id)) throw unavailable();
  const row = await tx.query<TagRow>(`SELECT id, tenant_id, code, label, parent_id, documents, collections, status, merged_into_id, handling, version FROM hs_classification_tags WHERE id=$1 AND tenant_id=$2${lock ? " FOR UPDATE" : ""}`, [id, tenantId]);
  if (!row.rows[0]) throw unavailable();
  return row.rows[0];
}

async function clearedIds(tx: Sql, actorId: string) {
  const row = await tx.query<{ tag_id: string }>("SELECT tag_id FROM hs_classification_handling WHERE user_id=$1", [actorId]);
  return new Set(row.rows.map(item => item.tag_id));
}

function tagVisible(row: TagRow, tags: TagRow[], cleared: ReadonlySet<string>, manager: boolean) {
  if (row.status === "removed") return manager;
  if (manager) return true;
  const byId = new Map(tags.map(tag => [tag.id, tag]));
  let cursor: TagRow | undefined = row;
  const seen = new Set<string>();
  while (cursor) {
    if (seen.has(cursor.id)) return false;
    seen.add(cursor.id);
    if (cursor.handling === "restrict" && !cleared.has(cursor.id)) return false;
    cursor = cursor.parent_id ? byId.get(cursor.parent_id) : undefined;
    if (cursor?.parent_id && !byId.has(cursor.parent_id) && cursor.handling !== "restrict") break;
  }
  return true;
}

async function fieldAllows(tx: Sql, tenantId: string, scopeKey: string, actorId: string, flag: "can_view" | "can_assign" | "can_history") {
  const policy = await tx.query<{ sensitive: boolean }>("SELECT sensitive FROM hs_classification_field_policy WHERE tenant_id=$1 AND scope_key=$2", [tenantId, scopeKey]);
  const access = await tx.query<{ can_view: boolean; can_assign: boolean; can_history: boolean }>("SELECT can_view, can_assign, can_history FROM hs_classification_field_access WHERE tenant_id=$1 AND scope_key=$2 AND user_id=$3", [tenantId, scopeKey, actorId]);
  const sensitive = policy.rows[0] ? on(policy.rows[0].sensitive) : false;
  const row = access.rows[0];
  if (sensitive) return row ? on(row[flag]) : false;
  if (!row) return true;
  return on(row[flag]);
}

async function knownCollections(tx: Sql, tenantId: string) {
  const row = await tx.query<{ id: string; name: string }>("SELECT id, name FROM hs_data_collections WHERE tenant_id=$1 AND deprecated=false ORDER BY name, id", [tenantId]);
  return row.rows;
}

async function pagePermitted(tx: Sql, workspaceId: string, actorId: string) {
  const visible = workingCopyVisibleSql("p", "$1");
  const childVisible = workingCopyVisibleSql("c", "$1");
  const row = await tx.query<{ id: string }>(
    `WITH RECURSIVE permitted AS (
      SELECT p.id FROM hs_pages p
      JOIN hs_members m ON m.workspace_id=p.workspace_id AND m.user_id=$1 AND m.active=true
      WHERE p.workspace_id=$2 AND p.deleted_at IS NULL AND ${visible}
        AND (m.role IN ('owner','admin') OR p.owner_id=$1 OR EXISTS(SELECT 1 FROM hs_grants g WHERE g.page_id=p.id AND (g.subject=$1 OR (p.visibility='space' AND g.subject='space'))) OR ${spaceHomeMemberRead("$1")})
      UNION
      SELECT c.id FROM hs_pages c JOIN permitted parent ON c.parent_id=parent.id
      WHERE c.workspace_id=$2 AND c.deleted_at IS NULL AND ${childVisible}
    ) SELECT id FROM permitted`,
    [actorId, workspaceId],
  );
  return new Set(row.rows.map(item => item.id));
}

async function openPage(r: Repository, tx: Sql, actor: Actor, pageId: string) {
  if (!pageId || pageId.length > 200) throw unavailable();
  try { return await r.get(pageId, actor, tx); }
  catch (error) { if (error instanceof DocumentError && error.status === 404) throw unavailable(); throw error; }
}

async function openRecord(tx: Sql, tenantId: string, recordId: string, actorId: string) {
  if (!uuidPattern.test(recordId)) throw unavailable();
  const row = await tx.query<{ id: string; collection: string; name: string; can_view: boolean; can_edit: boolean; can_export: boolean; can_history: boolean }>(
    `SELECT r.id, r.collection, r.name, ${grant("view")} AS can_view, ${grant("edit")} AS can_edit, ${grant("export")} AS can_export, ${grant("history")} AS can_history
     FROM hs_data_records r WHERE r.id=$1 AND r.tenant_id=$2 AND r.state='active' AND r.merged_into_id IS NULL`,
    [recordId, tenantId, actorId],
  );
  const found = row.rows[0];
  if (!found || !on(found.can_view)) throw unavailable();
  return { ...found, can_edit: on(found.can_edit), can_export: on(found.can_export), can_history: on(found.can_history) };
}

async function draftFor(tx: Sql, tagId: string, actorId: string): Promise<TagDraftView | null> {
  const row = await tx.query<{ label: string; parent_id: string | null; documents: boolean; collections: unknown; handling: Handling; cleared_user_ids: unknown; base_version: number }>(
    "SELECT label, parent_id, documents, collections, handling, cleared_user_ids, base_version FROM hs_classification_drafts WHERE tag_id=$1 AND actor_id=$2",
    [tagId, actorId],
  );
  const draft = row.rows[0];
  if (!draft) return null;
  return { label: draft.label, parentId: draft.parent_id, documents: on(draft.documents), collections: textList(draft.collections), handling: draft.handling, clearedUserIds: textList(draft.cleared_user_ids), baseVersion: num(draft.base_version) };
}

function presentTag(row: TagRow, manage: boolean, draft: TagDraftView | null): TagView {
  const view: TagView = {
    id: row.id, code: row.code, label: row.label, status: row.status, parentId: row.parent_id, documents: on(row.documents), handling: row.handling, version: num(row.version),
  };
  if (manage) {
    view.collections = collectionsOf(row);
    view.mergedIntoId = row.merged_into_id;
    view.recoverableDraft = draft;
  }
  return view;
}

async function roster(tx: Sql, tagId: string) {
  const row = await tx.query<{ user_id: string }>("SELECT user_id FROM hs_classification_handling WHERE tag_id=$1 ORDER BY user_id", [tagId]);
  return row.rows.map(item => item.user_id);
}

async function insertRevision(tx: Sql, row: TagRow, version: number, action: string, actor: Actor, operationId: string) {
  await tx.query(
    `INSERT INTO hs_classification_revisions(tag_id,version,action,code,label,parent_id,documents,collections,status,merged_into_id,handling,actor_id,operation_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
    [row.id, version, action, row.code, row.label, row.parent_id, on(row.documents), JSON.stringify(collectionsOf(row)), row.status, row.merged_into_id, row.handling, actor.id, operationId],
  );
}

async function membership(tx: Sql, tenantId: string, kind: TargetKind, targetId: string, lock = false) {
  const versionRow = await tx.query<{ version: number }>(`SELECT version FROM hs_classification_targets WHERE tenant_id=$1 AND target_kind=$2 AND target_id=$3${lock ? " FOR UPDATE" : ""}`, [tenantId, kind, targetId]);
  const tags = await tx.query<{ tag_id: string }>("SELECT tag_id FROM hs_classification_assignments WHERE tenant_id=$1 AND target_kind=$2 AND target_id=$3 ORDER BY tag_id", [tenantId, kind, targetId]);
  return { version: versionRow.rows[0] ? num(versionRow.rows[0].version) : 0, tagIds: tags.rows.map(item => item.tag_id) };
}

async function describeAssignment(tx: Sql, here: Scope, actor: Actor, tags: TagRow[], cleared: ReadonlySet<string>, manager: boolean, kind: TargetKind, target: { id: string; title: string; collection: string | null; canEdit: boolean; canHistory: boolean }): Promise<AssignmentView> {
  const scopeKey = kind === "page" ? "documents" : target.collection ?? "";
  if (!await fieldAllows(tx, here.tenantId, scopeKey, actor.id, "can_view")) throw unavailable();
  const current = await membership(tx, here.tenantId, kind, target.id);
  const visible = tags.filter(tag => tagVisible(tag, tags, cleared, manager) && tag.status !== "removed");
  const visibleIds = new Set(visible.map(tag => tag.id));
  const shown = current.tagIds.filter(id => visibleIds.has(id));
  const canAssign = target.canEdit && await fieldAllows(tx, here.tenantId, scopeKey, actor.id, "can_assign");
  const choices = visible.filter(tag => tagSelectable(tag.status, on(tag.documents), collectionsOf(tag), kind === "page" ? { kind: "page" } : { kind: "record", collection: target.collection ?? "" })).map(tag => ({ id: tag.id, code: tag.code, label: tag.label }));
  const byId = new Map(visible.map(tag => [tag.id, tag]));
  return {
    kind, id: target.id, title: target.title, version: current.version, canAssign,
    tags: shown.flatMap(id => { const tag = byId.get(id); return tag ? [{ id: tag.id, code: tag.code, label: tag.label, status: tag.status }] : []; }),
    choices,
  };
}

export async function classificationCatalogue(r: Repository, actor: Actor, workspaceId: string, input: { pageId?: string | null; recordId?: string | null } = {}) {
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    const manager = await isManager(tx, here, actor);
    const tags = await loadTags(tx, here.tenantId);
    const cleared = await clearedIds(tx, actor.id);
    const visible = tags.filter(tag => tag.status !== "removed" && tagVisible(tag, tags, cleared, manager));
    const views: TagView[] = [];
    for (const tag of visible) {
      const view = presentTag(tag, manager, manager ? await draftFor(tx, tag.id, actor.id) : null);
      if (manager) view.clearedUserIds = await roster(tx, tag.id);
      else if (view.parentId && !visible.some(item => item.id === view.parentId)) view.parentId = null;
      views.push(view);
    }
    let page: AssignmentView | null = null;
    if (input.pageId) {
      const opened = await openPage(r, tx, actor, input.pageId);
      if (opened.workspaceId !== workspaceId) throw unavailable();
      page = await describeAssignment(tx, here, actor, tags, cleared, manager, "page", { id: opened.id, title: opened.title, collection: null, canEdit: canEdit(opened.role), canHistory: canEdit(opened.role) });
    }
    let record: AssignmentView | null = null;
    if (input.recordId) {
      const opened = await openRecord(tx, here.tenantId, input.recordId, actor.id);
      record = await describeAssignment(tx, here, actor, tags, cleared, manager, "record", { id: opened.id, title: opened.name, collection: opened.collection, canEdit: opened.can_edit, canHistory: opened.can_history });
    }
    const collections = manager ? await knownCollections(tx, here.tenantId) : [];
    const colleagues = manager ? (await tx.query<{ id: string; name: string }>("SELECT u.id, u.name FROM hs_members m JOIN hs_users u ON u.id=m.user_id WHERE m.workspace_id=$1 AND m.active=true AND m.role<>'observer' ORDER BY u.name, u.id", [workspaceId])).rows : [];
    return { manage: manager, boundary: classificationBoundary, assignment: classificationAssignment, tags: views, page, record, collections, colleagues };
  });
}

export async function readClassificationTag(r: Repository, actor: Actor, workspaceId: string, tagId: string) {
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    const manager = await isManager(tx, here, actor);
    const tags = await loadTags(tx, here.tenantId);
    const row = tags.find(tag => tag.id === tagId);
    if (!row || !tagVisible(row, tags, await clearedIds(tx, actor.id), manager)) throw unavailable();
    const view = presentTag(row, manager, manager ? await draftFor(tx, row.id, actor.id) : null);
    if (manager) view.clearedUserIds = await roster(tx, row.id);
    return view;
  });
}

async function normaliseSave(tx: Sql, here: Scope, tags: TagRow[], tagId: string, input: SaveInput) {
  const label = classificationLabel(input.label);
  const handling: Handling = input.handling === "restrict" ? "restrict" : input.handling === "metadata" ? "metadata" : (() => { throw invalid(); })();
  const known = new Set((await knownCollections(tx, here.tenantId)).map(collection => collection.id));
  const scope = classificationScope(input.documents, input.collections, known);
  const parentId = input.parentId || null;
  if (parentId && !uuidPattern.test(parentId)) throw unavailable();
  const hierarchy = tags.map(tag => ({ id: tag.id, parentId: tag.id === tagId ? parentId : tag.parent_id }));
  if (parentId) {
    const parent = tags.find(tag => tag.id === parentId);
    if (!parent || parent.status === "removed" || parent.status === "merged") throw unavailable();
    assertHierarchy(hierarchy, tagId, parentId);
  }
  const cleared = [...new Set(input.clearedUserIds)];
  if (handling === "metadata" && cleared.length) throw invalid();
  if (cleared.length > classificationLimits.tags) throw invalid();
  for (const userId of cleared) {
    const member = await activeMember(tx, here.workspaceId, userId);
    if (!member || member.role === "observer") throw unavailable();
  }
  return { label, handling, scope, parentId, cleared };
}

export async function createClassificationTag(r: Repository, actor: Actor, workspaceId: string, input: SaveInput & { code: string }) {
  const requestHash = recordHash({ kind: "create", workspaceId, code: input.code, label: input.label, parentId: input.parentId, documents: input.documents, collections: input.collections, handling: input.handling, clearedUserIds: input.clearedUserIds });
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    const replay = await prior(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    await hold(tx, here.tenantId);
    await requireManager(tx, here, actor);
    const tags = await loadTags(tx, here.tenantId);
    if (tags.length >= classificationLimits.taxonomy) throw new DocumentError("The classification taxonomy is full.", "classification_limit", 422);
    const code = classificationCode(input.code);
    const id = randomUUID();
    const draft = await normaliseSave(tx, here, [...tags, { id, parent_id: input.parentId, status: "active" } as TagRow], id, input);
    try {
      await tx.query(
        `INSERT INTO hs_classification_tags(id,tenant_id,code,label,parent_id,documents,collections,status,handling,version,created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,'active',$8,1,$9)`,
        [id, here.tenantId, code, draft.label, draft.parentId, draft.scope.documents, JSON.stringify(draft.scope.collections), draft.handling, actor.id],
      );
    } catch (error) { if (uniqueViolation(error)) throw new DocumentError("That tag code is already in use.", "classification_code", 409); throw error; }
    if (draft.cleared.length) await tx.query("INSERT INTO hs_classification_handling(tag_id,user_id) SELECT $1, unnest($2::text[])", [id, draft.cleared]);
    const row = await loadTag(tx, here.tenantId, id);
    await insertRevision(tx, row, 1, "create", actor, input.operationId);
    await audit(tx, actor, "classification.create", input.operationId, id, { workspaceId, code, label: draft.label });
    const result = { ...presentTag(row, true, null), clearedUserIds: draft.cleared, replayed: false };
    await remember(tx, actor.id, input.operationId, requestHash, result);
    return result;
  });
}

export async function saveClassificationTag(r: Repository, actor: Actor, workspaceId: string, tagId: string, input: SaveInput) {
  const requestHash = recordHash({ kind: "save", workspaceId, tagId, ...input, operationId: undefined });
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    const replay = await prior(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    await hold(tx, here.tenantId);
    await requireManager(tx, here, actor);
    const row = await loadTag(tx, here.tenantId, tagId, true);
    if (num(row.version) !== input.expectedVersion) throw conflict();
    if (row.status === "removed" || row.status === "merged") throw conflict();
    const tags = await loadTags(tx, here.tenantId);
    const draft = await normaliseSave(tx, here, tags, tagId, input);
    const version = num(row.version) + 1;
    await tx.query(
      `UPDATE hs_classification_tags SET label=$3, parent_id=$4, documents=$5, collections=$6, handling=$7, version=$8, updated_at=clock_timestamp()
       WHERE id=$1 AND tenant_id=$2`,
      [tagId, here.tenantId, draft.label, draft.parentId, draft.scope.documents, JSON.stringify(draft.scope.collections), draft.handling, version],
    );
    await tx.query("DELETE FROM hs_classification_handling WHERE tag_id=$1", [tagId]);
    if (draft.cleared.length) await tx.query("INSERT INTO hs_classification_handling(tag_id,user_id) SELECT $1, unnest($2::text[])", [tagId, draft.cleared]);
    await tx.query("DELETE FROM hs_classification_drafts WHERE tag_id=$1 AND actor_id=$2", [tagId, actor.id]);
    const saved = await loadTag(tx, here.tenantId, tagId);
    await insertRevision(tx, saved, version, "save", actor, input.operationId);
    await audit(tx, actor, "classification.save", input.operationId, tagId, { workspaceId, code: saved.code, label: draft.label, version });
    const result = { ...presentTag(saved, true, null), clearedUserIds: draft.cleared, replayed: false };
    await remember(tx, actor.id, input.operationId, requestHash, result);
    return result;
  });
}

export async function stashClassificationTag(r: Repository, actor: Actor, workspaceId: string, tagId: string, input: SaveInput) {
  const requestHash = recordHash({ kind: "stash", workspaceId, tagId, ...input, operationId: undefined });
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    const replay = await prior(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    await hold(tx, here.tenantId);
    await requireManager(tx, here, actor);
    const row = await loadTag(tx, here.tenantId, tagId);
    if (row.status === "removed" || row.status === "merged") throw conflict();
    const tags = await loadTags(tx, here.tenantId);
    const draft = await normaliseSave(tx, here, tags, tagId, input);
    await tx.query(
      `INSERT INTO hs_classification_drafts(tag_id,actor_id,base_version,label,parent_id,documents,collections,handling,cleared_user_ids,operation_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       ON CONFLICT (tag_id, actor_id) DO UPDATE SET base_version=$3, label=$4, parent_id=$5, documents=$6, collections=$7, handling=$8, cleared_user_ids=$9, operation_id=$10, updated_at=clock_timestamp()`,
      [tagId, actor.id, input.expectedVersion, draft.label, draft.parentId, draft.scope.documents, JSON.stringify(draft.scope.collections), draft.handling, JSON.stringify(draft.cleared), input.operationId],
    );
    await audit(tx, actor, "classification.stash", input.operationId, tagId, { workspaceId, code: row.code, baseVersion: input.expectedVersion });
    const result = { id: tagId, version: num(row.version), recoverableDraft: { ...draft, collections: draft.scope.collections, clearedUserIds: draft.cleared, baseVersion: input.expectedVersion }, replayed: false };
    await remember(tx, actor.id, input.operationId, requestHash, result);
    return result;
  });
}

export async function discardClassificationDraft(r: Repository, actor: Actor, workspaceId: string, tagId: string, operationId: string) {
  const requestHash = recordHash({ kind: "discard-draft", workspaceId, tagId });
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    const replay = await prior(tx, actor.id, operationId, requestHash);
    if (replay) return replay;
    await hold(tx, here.tenantId);
    await requireManager(tx, here, actor);
    const row = await loadTag(tx, here.tenantId, tagId);
    await tx.query("DELETE FROM hs_classification_drafts WHERE tag_id=$1 AND actor_id=$2", [tagId, actor.id]);
    await audit(tx, actor, "classification.discard-draft", operationId, tagId, { workspaceId, code: row.code });
    const result = { id: tagId, discarded: true, replayed: false };
    await remember(tx, actor.id, operationId, requestHash, result);
    return result;
  });
}

export async function deprecateClassificationTag(r: Repository, actor: Actor, workspaceId: string, tagId: string, input: { operationId: string; expectedVersion: number }) {
  const requestHash = recordHash({ kind: "deprecate", workspaceId, tagId, expectedVersion: input.expectedVersion });
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    const replay = await prior(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    await hold(tx, here.tenantId);
    await requireManager(tx, here, actor);
    const row = await loadTag(tx, here.tenantId, tagId, true);
    if (num(row.version) !== input.expectedVersion) throw conflict();
    if (row.status !== "active" && row.status !== "deprecated") throw conflict();
    const version = row.status === "deprecated" ? num(row.version) : num(row.version) + 1;
    if (row.status === "active") {
      await tx.query("UPDATE hs_classification_tags SET status='deprecated', version=$3, updated_at=clock_timestamp() WHERE id=$1 AND tenant_id=$2", [tagId, here.tenantId, version]);
      const saved = await loadTag(tx, here.tenantId, tagId);
      await insertRevision(tx, saved, version, "deprecate", actor, input.operationId);
    }
    await audit(tx, actor, "classification.deprecate", input.operationId, tagId, { workspaceId, code: row.code, version });
    const saved = await loadTag(tx, here.tenantId, tagId);
    const result = { ...presentTag(saved, true, await draftFor(tx, tagId, actor.id)), replayed: false };
    await remember(tx, actor.id, input.operationId, requestHash, result);
    return result;
  });
}

async function referenceRows(tx: Sql, tenantId: string, tagId: string) {
  const row = await tx.query<{ target_kind: TargetKind; target_id: string }>("SELECT target_kind, target_id FROM hs_classification_assignments WHERE tenant_id=$1 AND tag_id=$2 ORDER BY target_kind, target_id", [tenantId, tagId]);
  return row.rows;
}

async function visibleReferences(r: Repository, tx: Sql, actor: Actor, here: Scope, rows: { target_kind: TargetKind; target_id: string }[]) {
  const pages = await pagePermitted(tx, here.workspaceId, actor.id);
  const documents = await fieldAllows(tx, here.tenantId, "documents", actor.id, "can_view");
  const pageIds = documents ? rows.filter(row => row.target_kind === "page" && pages.has(row.target_id)).map(row => row.target_id) : [];
  const pageTitles = pageIds.length ? await tx.query<{ id: string; title: string }>("SELECT id, title FROM hs_pages WHERE workspace_id=$1 AND deleted_at IS NULL AND id = ANY($2::text[])", [here.workspaceId, pageIds]) : { rows: [] as { id: string; title: string }[] };
  const recordIds = rows.filter(row => row.target_kind === "record" && uuidPattern.test(row.target_id)).map(row => row.target_id);
  const recordRows = recordIds.length ? await tx.query<{ id: string; name: string; collection: string }>(
    `SELECT r.id, r.name, r.collection FROM hs_data_records r
     WHERE r.tenant_id=$2 AND r.state='active' AND r.merged_into_id IS NULL AND r.id = ANY($1::uuid[]) AND ${grant("view")}`,
    [recordIds, here.tenantId, actor.id],
  ) : { rows: [] as { id: string; name: string; collection: string }[] };
  const references: { kind: TargetKind; id: string; title: string }[] = pageTitles.rows.map(page => ({ kind: "page" as const, id: page.id, title: page.title }));
  for (const record of recordRows.rows) {
    if (!await fieldAllows(tx, here.tenantId, record.collection, actor.id, "can_view")) continue;
    references.push({ kind: "record", id: record.id, title: record.name });
  }
  references.sort((a, b) => a.kind.localeCompare(b.kind) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id));
  return references;
}

export async function previewClassification(r: Repository, actor: Actor, workspaceId: string, input: { tagId: string; action: "merge" | "remove"; intoId?: string | null }) {
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await hold(tx, here.tenantId);
    await requireManager(tx, here, actor);
    const tags = await loadTags(tx, here.tenantId);
    const row = tags.find(tag => tag.id === input.tagId);
    if (!row || !tagVisible(row, tags, await clearedIds(tx, actor.id), true) || row.status === "removed" || row.status === "merged") throw unavailable();
    let into: TagRow | null = null;
    if (input.action === "merge") {
      if (!input.intoId || input.intoId === row.id) throw invalid();
      into = tags.find(tag => tag.id === input.intoId) ?? null;
      if (!into || into.status === "removed" || into.status === "merged") throw unavailable();
    }
    const stored = await referenceRows(tx, here.tenantId, row.id);
    const references = await visibleReferences(r, tx, actor, here, stored);
    const previewId = randomUUID();
    const referenceHash = recordHash(stored.map(item => `${item.target_kind}:${item.target_id}`));
    await tx.query(
      "INSERT INTO hs_classification_previews(id,tenant_id,actor_id,tag_id,action,into_id,tag_version,reference_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
      [previewId, here.tenantId, actor.id, row.id, input.action, into?.id ?? null, num(row.version), referenceHash],
    );
    return {
      previewId, action: input.action, tagId: row.id, code: row.code, label: row.label, version: num(row.version),
      intoId: into?.id ?? null, intoCode: into?.code ?? null, review: classificationReview,
      references: references.slice(0, classificationLimits.references),
      reviewTruncated: references.length > classificationLimits.references,
    };
  });
}

async function bumpTargets(tx: Sql, tenantId: string, rows: { target_kind: string; target_id: string }[]) {
  for (const row of rows) {
    await tx.query(
      `INSERT INTO hs_classification_targets(tenant_id,target_kind,target_id,version) VALUES($1,$2,$3,1)
       ON CONFLICT (tenant_id, target_kind, target_id) DO UPDATE SET version=hs_classification_targets.version+1, updated_at=clock_timestamp()`,
      [tenantId, row.target_kind, row.target_id],
    );
  }
}

export async function applyClassificationChange(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; previewId: string; expectedVersion: number }) {
  const requestHash = recordHash({ kind: "apply", workspaceId, previewId: input.previewId, expectedVersion: input.expectedVersion });
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    const replay = await prior(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    await hold(tx, here.tenantId);
    await requireManager(tx, here, actor);
    if (!uuidPattern.test(input.previewId)) throw unavailable();
    const preview = await tx.query<{ tag_id: string; action: "merge" | "remove"; into_id: string | null; tag_version: number; reference_hash: string }>(
      "SELECT tag_id, action, into_id, tag_version, reference_hash FROM hs_classification_previews WHERE id=$1 AND tenant_id=$2 AND actor_id=$3",
      [input.previewId, here.tenantId, actor.id],
    );
    const review = preview.rows[0];
    if (!review) throw unavailable();
    const ids = [review.tag_id, review.into_id].filter((id): id is string => !!id).sort();
    for (const id of ids) await loadTag(tx, here.tenantId, id, true);
    const row = await loadTag(tx, here.tenantId, review.tag_id);
    if (num(row.version) !== input.expectedVersion || num(row.version) !== num(review.tag_version) || row.status === "removed" || row.status === "merged") throw conflict();
    const stored = await referenceRows(tx, here.tenantId, row.id);
    if (recordHash(stored.map(item => `${item.target_kind}:${item.target_id}`)) !== review.reference_hash) throw conflict();
    const into = review.action === "merge" ? await loadTag(tx, here.tenantId, review.into_id ?? "") : null;
    if (review.action === "merge" && (!into || into.status === "removed" || into.status === "merged")) throw conflict();
    const eventTag = review.action === "merge" ? into!.id : row.id;
    const eventAction = review.action === "merge" ? "remap" : "remove";
    for (const item of stored) {
      await tx.query(
        "INSERT INTO hs_classification_assignment_events(id,tenant_id,tag_id,target_kind,target_id,action,actor_id,operation_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
        [randomUUID(), here.tenantId, eventTag, item.target_kind, item.target_id, eventAction, actor.id, input.operationId],
      );
    }
    if (review.action === "remove") {
      await tx.query("DELETE FROM hs_classification_assignments WHERE tenant_id=$1 AND tag_id=$2", [here.tenantId, row.id]);
    } else {
      await tx.query(
        `DELETE FROM hs_classification_assignments source
         USING hs_classification_assignments destination
         WHERE source.tenant_id=$1 AND source.tag_id=$2 AND destination.tenant_id=source.tenant_id
           AND destination.tag_id=$3 AND destination.target_kind=source.target_kind AND destination.target_id=source.target_id`,
        [here.tenantId, row.id, into!.id],
      );
      await tx.query("UPDATE hs_classification_assignments SET tag_id=$3 WHERE tenant_id=$1 AND tag_id=$2", [here.tenantId, row.id, into!.id]);
    }
    await bumpTargets(tx, here.tenantId, stored);
    const version = num(row.version) + 1;
    const status = review.action === "merge" ? "merged" : "removed";
    await tx.query(
      "UPDATE hs_classification_tags SET status=$3, merged_into_id=$4, version=$5, updated_at=clock_timestamp() WHERE id=$1 AND tenant_id=$2",
      [row.id, here.tenantId, status, into?.id ?? null, version],
    );
    const saved = await loadTag(tx, here.tenantId, row.id);
    await insertRevision(tx, saved, version, review.action, actor, input.operationId);
    await audit(tx, actor, `classification.${review.action}`, input.operationId, row.id, { workspaceId, code: row.code, intoId: into?.id ?? null, version });
    const visible = await visibleReferences(r, tx, actor, here, review.action === "merge" ? stored.map(item => ({ ...item, target_kind: item.target_kind })) : []);
    const result = { id: row.id, status, version, intoId: into?.id ?? null, replayed: false, references: review.action === "merge" ? visible.slice(0, classificationLimits.references) : [] };
    await remember(tx, actor.id, input.operationId, requestHash, result);
    return result;
  });
}

export async function assignClassification(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; targetKind: TargetKind; targetId: string; expectedVersion: number; tagIds: string[] }) {
  const requestHash = recordHash({ kind: "assign", workspaceId, targetKind: input.targetKind, targetId: input.targetId, expectedVersion: input.expectedVersion, tagIds: input.tagIds });
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    const replay = await prior(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    await hold(tx, here.tenantId);
    if (here.role === "observer") throw readOnly();
    const manager = await isManager(tx, here, actor);
    const tags = await loadTags(tx, here.tenantId);
    const cleared = await clearedIds(tx, actor.id);
    let title = "";
    let collection: string | null = null;
    let canEditTarget = false;
    if (input.targetKind === "page") {
      const page = await openPage(r, tx, actor, input.targetId);
      if (page.workspaceId !== workspaceId) throw unavailable();
      title = page.title;
      canEditTarget = canEdit(page.role);
    } else {
      const record = await openRecord(tx, here.tenantId, input.targetId, actor.id);
      title = record.name;
      collection = record.collection;
      canEditTarget = record.can_edit;
    }
    const scopeKey = input.targetKind === "page" ? "documents" : collection ?? "";
    if (!await fieldAllows(tx, here.tenantId, scopeKey, actor.id, "can_view")) throw unavailable();
    if (!canEditTarget || !await fieldAllows(tx, here.tenantId, scopeKey, actor.id, "can_assign")) throw refused();
    const current = await membership(tx, here.tenantId, input.targetKind, input.targetId, true);
    if (current.version !== input.expectedVersion) throw conflict();
    const visible = new Set(tags.filter(tag => tagVisible(tag, tags, cleared, manager) && tag.status !== "removed").map(tag => tag.id));
    const assignable = new Set(tags.filter(tag => visible.has(tag.id) && tagSelectable(tag.status, on(tag.documents), collectionsOf(tag), input.targetKind === "page" ? { kind: "page" } : { kind: "record", collection: collection ?? "" })).map(tag => tag.id));
    const change = nextMembership(current.tagIds, input.tagIds, visible, assignable);
    if (!change.ok) {
      if (change.reason === "hidden") throw unavailable();
      throw invalid();
    }
    if (change.added.length || change.removed.length) {
      for (const tagId of change.removed) await tx.query("DELETE FROM hs_classification_assignments WHERE tenant_id=$1 AND tag_id=$2 AND target_kind=$3 AND target_id=$4", [here.tenantId, tagId, input.targetKind, input.targetId]);
      for (const tagId of change.added) await tx.query("INSERT INTO hs_classification_assignments(id,tenant_id,tag_id,target_kind,target_id,created_by) VALUES($1,$2,$3,$4,$5,$6)", [randomUUID(), here.tenantId, tagId, input.targetKind, input.targetId, actor.id]);
      for (const tagId of [...change.added, ...change.removed]) {
        await tx.query(
          "INSERT INTO hs_classification_assignment_events(id,tenant_id,tag_id,target_kind,target_id,action,actor_id,operation_id) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
          [randomUUID(), here.tenantId, tagId, input.targetKind, input.targetId, change.added.includes(tagId) ? "assign" : "remove", actor.id, input.operationId],
        );
      }
      await bumpTargets(tx, here.tenantId, [{ target_kind: input.targetKind, target_id: input.targetId }]);
    }
    await audit(tx, actor, "classification.assign", input.operationId, input.targetId, { workspaceId, targetKind: input.targetKind, added: change.added, removed: change.removed });
    const saved = await describeAssignment(tx, here, actor, tags, cleared, manager, input.targetKind, { id: input.targetId, title, collection, canEdit: canEditTarget, canHistory: true });
    const result = { ...saved, replayed: false };
    await remember(tx, actor.id, input.operationId, requestHash, result);
    return result;
  });
}

async function facetQuery(tx: Sql, here: Scope, actor: Actor, kind: TargetKind, collection?: string | null) {
  if (kind === "page") {
    const visible = workingCopyVisibleSql("p", "$1");
    const childVisible = workingCopyVisibleSql("c", "$1");
    return tx.query<{ tag_id: string; n: number }>(
      `WITH RECURSIVE permitted AS (
        SELECT p.id FROM hs_pages p JOIN hs_members m ON m.workspace_id=p.workspace_id AND m.user_id=$1 AND m.active=true
        WHERE p.workspace_id=$2 AND p.deleted_at IS NULL AND ${visible}
          AND (m.role IN ('owner','admin') OR p.owner_id=$1 OR EXISTS(SELECT 1 FROM hs_grants g WHERE g.page_id=p.id AND (g.subject=$1 OR (p.visibility='space' AND g.subject='space'))) OR ${spaceHomeMemberRead("$1")})
        UNION SELECT c.id FROM hs_pages c JOIN permitted parent ON c.parent_id=parent.id
        WHERE c.workspace_id=$2 AND c.deleted_at IS NULL AND ${childVisible}
      )
      SELECT a.tag_id, count(DISTINCT a.target_id)::int AS n
      FROM hs_classification_assignments a JOIN permitted p ON p.id=a.target_id
      WHERE a.tenant_id=$3 AND a.target_kind='page'
      GROUP BY a.tag_id`,
      [actor.id, here.workspaceId, here.tenantId],
    );
  }
  if (!collection) throw invalid();
  return tx.query<{ tag_id: string; n: number }>(
    `SELECT a.tag_id, count(DISTINCT a.target_id)::int AS n
     FROM hs_classification_assignments a
     JOIN hs_data_records r ON r.tenant_id=a.tenant_id AND r.id::text=a.target_id
     WHERE a.tenant_id=$2 AND a.target_kind='record' AND r.collection=$1 AND r.state='active' AND r.merged_into_id IS NULL
       AND ${grant("view")}
     GROUP BY a.tag_id`,
    [collection, here.tenantId, actor.id],
  );
}

export async function classificationFacets(r: Repository, actor: Actor, workspaceId: string, input: { kind: TargetKind; collection?: string | null }) {
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    const scopeKey = input.kind === "page" ? "documents" : input.collection ?? "";
    if (input.kind === "record") {
      const known = new Set((await knownCollections(tx, here.tenantId)).map(collection => collection.id));
      if (!known.has(scopeKey)) throw unavailable();
    }
    if (!await fieldAllows(tx, here.tenantId, scopeKey, actor.id, "can_view")) return { facets: [] };
    const manager = await isManager(tx, here, actor);
    const tags = await loadTags(tx, here.tenantId);
    const cleared = await clearedIds(tx, actor.id);
    const counts = await facetQuery(tx, here, actor, input.kind, input.collection);
    const facets = counts.rows.flatMap(row => {
      const tag = tags.find(item => item.id === row.tag_id);
      if (!tag || !tagVisible(tag, tags, cleared, manager) || tag.status === "removed" || num(row.n) < 1) return [];
      if (input.kind === "record" && !collectionsOf(tag).includes(scopeKey) && tag.status === "active") return [{ tagId: tag.id, code: tag.code, label: tag.label, count: num(row.n) }];
      return [{ tagId: tag.id, code: tag.code, label: tag.label, count: num(row.n) }];
    }).sort((a, b) => a.label.localeCompare(b.label) || a.tagId.localeCompare(b.tagId));
    return { facets };
  });
}

export async function searchClassification(r: Repository, actor: Actor, workspaceId: string, tagId: string) {
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    const manager = await isManager(tx, here, actor);
    const tags = await loadTags(tx, here.tenantId);
    const row = tags.find(tag => tag.id === tagId);
    if (!row || !tagVisible(row, tags, await clearedIds(tx, actor.id), manager) || row.status === "removed") throw unavailable();
    const stored = await referenceRows(tx, here.tenantId, row.id);
    const references = await visibleReferences(r, tx, actor, here, stored);
    return { tagId: row.id, code: row.code, label: row.label, results: references.slice(0, classificationLimits.references).map(item => ({ kind: item.kind, id: item.id, title: item.title })) };
  });
}

export async function classificationHistory(r: Repository, actor: Actor, workspaceId: string, input: { tagId?: string | null; targetKind?: TargetKind | null; targetId?: string | null }) {
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    const manager = await isManager(tx, here, actor);
    const tags = await loadTags(tx, here.tenantId);
    const cleared = await clearedIds(tx, actor.id);
    const events: { action: string; actorId: string; actorName: string; atIst: string; source: string; operationId: string }[] = [];
    const pushAudit = async (where: string, values: unknown[]) => {
      const row = await tx.query<{ action: string; actor_id: string; name: string; created_at: string | Date; correlation_id: string }>(
        `SELECT a.action, a.actor_id, u.name, a.created_at, a.correlation_id::text
         FROM hs_audit a JOIN hs_users u ON u.id=a.actor_id
         WHERE ${where} ORDER BY a.created_at DESC LIMIT 100`,
        values,
      );
      for (const item of row.rows) events.push({ action: item.action, actorId: item.actor_id, actorName: item.name, atIst: formatIst(item.created_at), source, operationId: item.correlation_id });
    };
    const seeTarget = async (kind: string, targetId: string) => {
      if (kind === "page") return (await pagePermitted(tx, here.workspaceId, actor.id)).has(targetId) && await fieldAllows(tx, here.tenantId, "documents", actor.id, "can_view");
      if (!uuidPattern.test(targetId)) return false;
      const row = await tx.query<{ collection: string; can_view: boolean }>(
        `SELECT r.collection, ${grant("view")} AS can_view FROM hs_data_records r WHERE r.id=$1 AND r.tenant_id=$2 AND r.state='active' AND r.merged_into_id IS NULL`,
        [targetId, here.tenantId, actor.id],
      );
      const found = row.rows[0];
      return !!found && on(found.can_view) && await fieldAllows(tx, here.tenantId, found.collection, actor.id, "can_view");
    };
    if (input.tagId) {
      const row = tags.find(tag => tag.id === input.tagId);
      if (!row || !tagVisible(row, tags, cleared, manager)) throw unavailable();
      if (manager) await pushAudit("a.subject_id=$1 AND a.action LIKE 'classification.%'", [input.tagId]);
      const activity = await tx.query<{ action: string; actor_id: string; name: string; created_at: string | Date; operation_id: string; target_kind: string; target_id: string }>(
        `SELECT e.action, e.actor_id, u.name, e.created_at, e.operation_id::text, e.target_kind, e.target_id
         FROM hs_classification_assignment_events e JOIN hs_users u ON u.id=e.actor_id
         WHERE e.tag_id=$1 ORDER BY e.created_at DESC LIMIT 200`,
        [row.id],
      );
      for (const item of activity.rows) {
        if (!await seeTarget(item.target_kind, item.target_id)) continue;
        events.push({ action: item.action, actorId: item.actor_id, actorName: item.name, atIst: formatIst(item.created_at), source, operationId: item.operation_id });
      }
    } else if (input.targetKind && input.targetId) {
      const target = input.targetKind === "page" ? await openPage(r, tx, actor, input.targetId) : null;
      const record = input.targetKind === "record" ? await openRecord(tx, here.tenantId, input.targetId, actor.id) : null;
      if (target && target.workspaceId !== workspaceId) throw unavailable();
      const scopeKey = input.targetKind === "page" ? "documents" : record?.collection ?? "";
      if (!await fieldAllows(tx, here.tenantId, scopeKey, actor.id, "can_view")) throw unavailable();
      if (!await fieldAllows(tx, here.tenantId, scopeKey, actor.id, "can_history")) throw refused();
      if (input.targetKind === "record" && !record!.can_history && !record!.can_edit) throw refused();
      const activity = await tx.query<{ action: string; actor_id: string; name: string; created_at: string | Date; operation_id: string; tag_id: string }>(
        `SELECT e.action, e.actor_id, u.name, e.created_at, e.operation_id::text, e.tag_id
         FROM hs_classification_assignment_events e JOIN hs_users u ON u.id=e.actor_id
         WHERE e.tenant_id=$1 AND e.target_kind=$2 AND e.target_id=$3 ORDER BY e.created_at DESC LIMIT 100`,
        [here.tenantId, input.targetKind, input.targetId],
      );
      for (const item of activity.rows) {
        const tag = tags.find(candidate => candidate.id === item.tag_id);
        if (!tag || !tagVisible(tag, tags, cleared, manager)) continue;
        events.push({ action: item.action, actorId: item.actor_id, actorName: item.name, atIst: formatIst(item.created_at), source, operationId: item.operation_id });
      }
    } else throw unavailable();
    return { events };
  });
}

export async function downloadClassification(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; targetKind: TargetKind; targetId: string; expectedVersion: number }) {
  const requestHash = recordHash({ kind: "download", workspaceId, targetKind: input.targetKind, targetId: input.targetId, expectedVersion: input.expectedVersion });
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    const replay = await prior(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    await hold(tx, here.tenantId);
    const manager = await isManager(tx, here, actor);
    const tags = await loadTags(tx, here.tenantId);
    const cleared = await clearedIds(tx, actor.id);
    const page = input.targetKind === "page" ? await openPage(r, tx, actor, input.targetId) : null;
    const record = input.targetKind === "record" ? await openRecord(tx, here.tenantId, input.targetId, actor.id) : null;
    if (page && page.workspaceId !== workspaceId) throw unavailable();
    if (record && !record.can_export) throw refused();
    const scopeKey = input.targetKind === "page" ? "documents" : record?.collection ?? "";
    if (!await fieldAllows(tx, here.tenantId, scopeKey, actor.id, "can_view")) throw unavailable();
    const current = await membership(tx, here.tenantId, input.targetKind, input.targetId);
    if (current.version !== input.expectedVersion) throw conflict();
    const byId = new Map(tags.map(tag => [tag.id, tag]));
    const shown = current.tagIds.flatMap(id => {
      const tag = byId.get(id);
      if (!tag || !tagVisible(tag, tags, cleared, manager) || tag.status === "removed") return [];
      return [{ code: tag.code, label: tag.label, status: tag.status }];
    });
    const title = page?.title ?? record?.name ?? "";
    const body = classificationDocument({ kind: input.targetKind, title }, shown);
    await audit(tx, actor, "classification.download", input.operationId, input.targetId, { workspaceId, targetKind: input.targetKind, version: current.version });
    const result = { filename: "classification.md", contentType: "text/markdown; charset=utf-8", body, version: current.version, replayed: false };
    await remember(tx, actor.id, input.operationId, requestHash, result);
    return result;
  });
}

export async function grantClassificationManager(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; userId: string }) {
  const requestHash = recordHash({ kind: "grant-manager", workspaceId, userId: input.userId });
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    const replay = await prior(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    await hold(tx, here.tenantId);
    await requireManager(tx, here, actor, true);
    const member = await activeMember(tx, workspaceId, input.userId);
    if (!member || member.role === "observer") throw unavailable();
    await tx.query(
      `INSERT INTO hs_classification_managers(workspace_id,user_id,granted_by) VALUES($1,$2,$3)
       ON CONFLICT (workspace_id, user_id) DO NOTHING`,
      [workspaceId, input.userId, actor.id],
    );
    await audit(tx, actor, "classification.grant-manager", input.operationId, workspaceId, { workspaceId, userId: input.userId });
    const result = { granted: true, userId: input.userId, replayed: false };
    await remember(tx, actor.id, input.operationId, requestHash, result);
    return result;
  });
}

export async function revokeClassificationManager(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; userId: string }) {
  const requestHash = recordHash({ kind: "revoke-manager", workspaceId, userId: input.userId });
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    const replay = await prior(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    await hold(tx, here.tenantId);
    await requireManager(tx, here, actor, true);
    await tx.query("DELETE FROM hs_classification_managers WHERE workspace_id=$1 AND user_id=$2", [workspaceId, input.userId]);
    await audit(tx, actor, "classification.revoke-manager", input.operationId, workspaceId, { workspaceId, userId: input.userId });
    const result = { revoked: true, userId: input.userId, replayed: false };
    await remember(tx, actor.id, input.operationId, requestHash, result);
    return result;
  });
}

export async function saveClassificationFieldPolicy(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; scopeKey: string; sensitive: boolean; expectedVersion: number; access: { userId: string; canView: boolean; canAssign: boolean; canHistory: boolean }[] }) {
  const requestHash = recordHash({ kind: "field-policy", workspaceId, scopeKey: input.scopeKey, sensitive: input.sensitive, expectedVersion: input.expectedVersion, access: input.access });
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    const replay = await prior(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    await hold(tx, here.tenantId);
    await requireManager(tx, here, actor, true);
    const known = new Set((await knownCollections(tx, here.tenantId)).map(collection => collection.id));
    if (input.scopeKey !== "documents" && !known.has(input.scopeKey)) throw unavailable();
    const current = await tx.query<{ version: number }>("SELECT version FROM hs_classification_field_policy WHERE tenant_id=$1 AND scope_key=$2 FOR UPDATE", [here.tenantId, input.scopeKey]);
    const version = current.rows[0] ? num(current.rows[0].version) : 0;
    if (version !== input.expectedVersion) throw conflict();
    if (input.access.length > classificationLimits.tags) throw invalid();
    const access = [...input.access].sort((a, b) => a.userId.localeCompare(b.userId));
    const seen = new Set<string>();
    for (const item of access) {
      if (seen.has(item.userId)) throw invalid();
      seen.add(item.userId);
      const member = await activeMember(tx, workspaceId, item.userId);
      if (!member || member.role === "observer") throw unavailable();
      if ((item.canAssign || item.canHistory) && !item.canView) throw invalid();
    }
    const next = version + 1;
    await tx.query(
      `INSERT INTO hs_classification_field_policy(tenant_id,scope_key,sensitive,version) VALUES($1,$2,$3,$4)
       ON CONFLICT (tenant_id, scope_key) DO UPDATE SET sensitive=$3, version=$4`,
      [here.tenantId, input.scopeKey, input.sensitive, next],
    );
    await tx.query("DELETE FROM hs_classification_field_access WHERE tenant_id=$1 AND scope_key=$2", [here.tenantId, input.scopeKey]);
    for (const item of access) {
      await tx.query(
        "INSERT INTO hs_classification_field_access(tenant_id,scope_key,user_id,can_view,can_assign,can_history) VALUES($1,$2,$3,$4,$5,$6)",
        [here.tenantId, input.scopeKey, item.userId, item.canView, item.canAssign, item.canHistory],
      );
    }
    await audit(tx, actor, "classification.field-policy", input.operationId, workspaceId, { workspaceId, scopeKey: input.scopeKey, sensitive: input.sensitive, version: next });
    const result = { scopeKey: input.scopeKey, sensitive: input.sensitive, version: next, replayed: false };
    await remember(tx, actor.id, input.operationId, requestHash, result);
    return result;
  });
}
