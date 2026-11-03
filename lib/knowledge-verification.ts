import { randomUUID } from "node:crypto";
import type { Actor } from "./auth";
import type { Sql } from "./database";
import { DocumentError } from "./document";
import { formatIst } from "./ist-label";
import type { Repository } from "./repository";
import { recordHash } from "./shared-record-types";
import {
  assessVerification,
  assertTitleOnlyPolicy,
  knowledgeVerificationActions,
  knowledgeVerificationAssignment,
  knowledgeVerificationBoundary,
  knowledgeVerificationRecoverable,
  knowledgeVerificationSchedules,
  knowledgeVerificationSource,
  knowledgeVerificationStatement,
  knowledgeVerificationTitleOnly,
  knowledgeVerificationTitleOnlyPolicy,
  collectDocumentSources,
  pageFingerprint,
  recordFingerprint,
  textExcerpt,
  verificationBases,
  verificationBasis,
  verificationDocument,
  verificationExpiryDays,
  verificationLabel,
  verificationNote,
  verificationProjection,
  verificationQuery,
  verificationReason,
  type Fingerprint,
  type StoredVerificationStatus,
  type VerificationAction,
  type VerificationStatus,
} from "./knowledge-verification-plan";

const unavailable = () => new DocumentError("Verification is restricted or unavailable.", "not_found", 404);
const authorityError = () => new DocumentError("Verification authority is required.", "knowledge_verification_authority", 403);
const forbidden = () => new DocumentError("This action is not permitted.", "action_forbidden", 403);
const conflict = () => new DocumentError("The verification version changed. The draft is kept.", "knowledge_verification_conflict", 409);
const unchanged = () => new DocumentError("The verification version changed. Nothing was overwritten.", "knowledge_verification_conflict", 409);
function settle<T extends object>(result: T): T {
  const value = result as T & { conflict?: boolean; previewStale?: boolean };
  if (value.previewStale) throw previewError();
  if (value.conflict) throw conflict();
  return result;
}
const previewError = () => new DocumentError("Review the impact again. The published revision changed.", "knowledge_verification_preview", 409);
const mismatch = () => new DocumentError("This attempt was reused with different fields.", "operation_mismatch", 409);
const unpublished = () => new DocumentError("Verify a published revision.", "knowledge_verification_unpublished", 409);
const renewRequired = () => new DocumentError("Renew the current badge.", "knowledge_verification_renew", 409);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const control = /[\p{Cc}]/u;

type Scope = { workspaceId: string; tenantId: string; role: string };
type PreviewKind = "verify" | "renew" | "revoke";
type FieldFlags = { sensitive: boolean; explicit: boolean; view: boolean; write: boolean; history: boolean };
type TargetAccess = {
  kind: "page" | "record";
  id: string;
  title: string;
  view: boolean;
  export: boolean;
  history: boolean;
  fingerprint: Fingerprint | null;
  revision: number;
  publishedRef: string | null;
  excerpt: string;
  sources: string[];
};
type BadgeRow = {
  id: string;
  target_kind: "page" | "record";
  target_id: string;
  revision_version: number | string;
  published_ref: string;
  title_hash: string;
  content_hash: string;
  source_hash: string;
  title_only: string;
  owner_id: string;
  owner_name: string;
  basis: string;
  basis_note: string;
  expiry_days: number | string;
  expires_at: string | Date;
  status: StoredVerificationStatus;
  version: number | string;
  verified_by: string;
  created_at: string | Date;
};
type DraftPayload = { ownerId?: string; basis?: string; basisNote?: string; expiryDays?: number; reason?: string };
export type KnowledgeBadgePin = {
  status: VerificationStatus;
  label: string;
  owner: string;
  basis: string;
  expiresAt: string;
  revision: number;
  titleOnlyPolicy: typeof knowledgeVerificationTitleOnlyPolicy;
  statement: string;
};
export type KnowledgeBadgeView = KnowledgeBadgePin & {
  id: string;
  targetKind: "page" | "record";
  targetId: string;
  title: string;
  reason: string | null;
  titleChanged: boolean;
  titleOnlyRule: string;
  ownerId: string;
  basisNote: string;
  expiryDays: number;
  liveRevision: number | null;
  attestedRevision: number;
  publishedRef: string;
  version: number;
  verifiedBy: string;
  recoverableDraft: { baseVersion: number; payload: DraftPayload } | null;
  rights: { tenant: true; record: "view"; field: "view"; action: "inspect" };
};
type ShownBadge = { access: TargetAccess; view: KnowledgeBadgeView; row: BadgeRow; field: FieldFlags };

const capability = (kind: "view" | "export" | "history") =>
  `(EXISTS(SELECT 1 FROM hs_data_collection_grants g WHERE g.tenant_id=r.tenant_id AND g.user_id=$3 AND g.collection=r.collection AND '${kind}'=ANY(g.capabilities)) OR EXISTS(SELECT 1 FROM hs_data_record_grants g WHERE g.tenant_id=r.tenant_id AND g.record_id=r.id AND g.user_id=$3 AND '${kind}'=ANY(g.capabilities)))`;

function on(value: unknown) { return value === true || value === "t" || value === "true" || value === 1; }
function num(value: number | string | null | undefined) { return Number(value ?? 0); }
function asJson<T>(value: unknown): T { return (typeof value === "string" ? JSON.parse(value) : value) as T; }
function at(value: string | Date) { return value instanceof Date ? value : new Date(value); }
function textList(value: unknown) {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
}
function fieldsOf(value: unknown) {
  const parsed = asJson<Record<string, unknown>>(value ?? {});
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
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
    [randomUUID(), actor.id, action, subjectId, JSON.stringify({ source: knowledgeVerificationSource, operationId, atIst: formatIst(new Date()), ...after }), operationId],
  );
}

async function track(tx: Sql, tenantId: string, actor: Actor, action: string, operationId: string, badgeId: string | null, detail: Record<string, unknown>) {
  await tx.query(
    "INSERT INTO hs_knowledge_verification_events(id,tenant_id,badge_id,action,actor_id,operation_id,source,detail) VALUES($1,$2,$3,$4,$5,$6,$7,$8)",
    [randomUUID(), tenantId, badgeId, action, actor.id, operationId, knowledgeVerificationSource, JSON.stringify(detail)],
  );
}

async function prior<T extends object>(tx: Sql, actorId: string, operationId: string, requestHash: string): Promise<(T & { replayed: true }) | null> {
  const row = await tx.query<{ request_hash: string; result: unknown }>("SELECT request_hash, result FROM hs_knowledge_verification_operations WHERE actor_id=$1 AND operation_id=$2", [actorId, operationId]);
  if (!row.rows[0]) return null;
  if (row.rows[0].request_hash !== requestHash) throw mismatch();
  return { ...asJson<T>(row.rows[0].result), replayed: true };
}

async function remember<T extends object>(tx: Sql, actorId: string, operationId: string, requestHash: string, result: T) {
  const stored = { ...result, replayed: false };
  await tx.query("INSERT INTO hs_knowledge_verification_operations(actor_id,operation_id,request_hash,result) VALUES($1,$2,$3,$4)", [actorId, operationId, requestHash, JSON.stringify(stored)]);
  return stored;
}

async function hold(tx: Sql, tenantId: string) {
  await tx.query("SELECT id FROM hs_data_tenants WHERE id=$1 FOR UPDATE", [tenantId]);
}

async function isSteward(tx: Sql, here: Scope, actor: Actor) {
  if (here.role === "observer") return false;
  if (here.role === "owner" || here.role === "admin") return true;
  const row = await tx.query("SELECT 1 FROM hs_knowledge_verification_stewards WHERE workspace_id=$1 AND user_id=$2", [here.workspaceId, actor.id]);
  return row.rows.length > 0;
}

async function fieldFlags(tx: Sql, tenantId: string, userId: string): Promise<FieldFlags> {
  const policy = await tx.query<{ sensitive: boolean }>("SELECT sensitive FROM hs_knowledge_verification_field_policy WHERE tenant_id=$1", [tenantId]);
  const access = await tx.query<{ can_view: boolean; can_write: boolean; can_history: boolean }>("SELECT can_view, can_write, can_history FROM hs_knowledge_verification_field_access WHERE tenant_id=$1 AND user_id=$2", [tenantId, userId]);
  const sensitive = policy.rows[0] ? on(policy.rows[0].sensitive) : false;
  const row = access.rows[0];
  if (!row) return { sensitive, explicit: false, view: !sensitive, write: false, history: !sensitive };
  return { sensitive, explicit: true, view: on(row.can_view), write: on(row.can_write), history: on(row.can_history) };
}

function canWrite(field: FieldFlags, steward: boolean) {
  if (!steward) return false;
  if (field.sensitive || field.explicit) return field.write;
  return true;
}

async function actionAllowed(tx: Sql, tenantId: string, userId: string, action: VerificationAction, base: boolean) {
  if (!base) return false;
  const rows = await tx.query<{ action: string }>("SELECT action FROM hs_knowledge_verification_actions WHERE tenant_id=$1 AND user_id=$2", [tenantId, userId]);
  if (!rows.rows.length) return true;
  return rows.rows.some(row => row.action === action);
}

async function activeOwner(tx: Sql, workspaceId: string, userId: string) {
  const row = await tx.query<{ role: string }>("SELECT role FROM hs_members WHERE workspace_id=$1 AND user_id=$2 AND active=true", [workspaceId, userId]);
  return !!row.rows[0] && row.rows[0].role !== "observer";
}

async function livePage(tx: Sql, pageId: string) {
  const row = await tx.query<{ id: string; revision_version: number | string; title: string; document: unknown }>(
    `SELECT v.id::text AS id, v.revision_version, r.title, r.document
     FROM hs_published_versions v
     JOIN hs_revisions r ON r.page_id=v.page_id AND r.version=v.revision_version
     JOIN hs_page_publication_state s ON s.page_id=v.page_id AND s.live=true
     WHERE v.page_id=$1
     ORDER BY v.version_no DESC
     LIMIT 1`,
    [pageId],
  );
  return row.rows[0] ?? null;
}

async function recordReferences(tx: Sql, tenantId: string, recordId: string) {
  const row = await tx.query<{ source_app: string; source_type: string; source_id: string }>(
    "SELECT source_app, source_type, source_id FROM hs_data_references WHERE tenant_id=$1 AND record_id=$2 ORDER BY source_app, source_type, source_id",
    [tenantId, recordId],
  );
  return row.rows.map(item => `${item.source_app}:${item.source_type}:${item.source_id}`);
}

async function openTarget(r: Repository, tx: Sql, here: Scope, actor: Actor, kind: "page" | "record", id: string): Promise<TargetAccess | null> {
  if (kind === "page") {
    if (!id || id.length > 200) return null;
    let page: { workspace_id: string; title: string; role: string };
    try { page = await r.access(tx, id, actor); }
    catch (error) { if (error instanceof DocumentError && error.status === 404) return null; throw error; }
    if (page.workspace_id !== here.workspaceId) return null;
    const snap = await livePage(tx, id);
    const document = snap ? asJson(snap.document) : null;
    const admin = here.role === "owner" || here.role === "admin";
    const editor = admin || page.role === "owner" || page.role === "editor";
    const sources = document ? collectDocumentSources(document) : [];
    return {
      kind, id, title: snap?.title ?? page.title, view: true, export: editor, history: editor,
      fingerprint: snap ? pageFingerprint(snap.title, document) : null,
      revision: snap ? num(snap.revision_version) : 0,
      publishedRef: snap?.id ?? null,
      excerpt: document ? textExcerpt(document) : "",
      sources,
    };
  }
  return openRecord(tx, here, actor, id);
}

async function openRecord(tx: Sql, here: Scope, actor: Actor, id: string): Promise<TargetAccess | null> {
  if (!uuidPattern.test(id)) return null;
  const row = await tx.query<{ id: string; name: string; version: number | string; field_values: unknown; state: string; merged_into_id: string | null; can_view: boolean; can_export: boolean; can_history: boolean }>(
    `SELECT r.id::text, r.name, r.version, r.field_values, r.state, r.merged_into_id::text, ${capability("view")} AS can_view, ${capability("export")} AS can_export, ${capability("history")} AS can_history
     FROM hs_data_records r WHERE r.id=$1 AND r.tenant_id=$2`,
    [id, here.tenantId, actor.id],
  );
  const found = row.rows[0];
  if (!found || !on(found.can_view) || found.state !== "active" || found.merged_into_id) return null;
  const values = fieldsOf(found.field_values);
  const references = await recordReferences(tx, here.tenantId, found.id);
  const sources = [
    ...references.map(item => `ref:${item}`),
    ...Object.keys(values).filter(key => key === "core:source" || key.startsWith("source:")).map(key => `field:${key}`),
  ].sort();
  return {
    kind: "record", id: found.id, title: found.name, view: true, export: on(found.can_export), history: on(found.can_history),
    fingerprint: recordFingerprint(found.name, values, references),
    revision: num(found.version),
    publishedRef: `record:${found.id}:v${num(found.version)}`,
    excerpt: found.name,
    sources,
  };
}

async function policyOf(tx: Sql, tenantId: string) {
  const row = await tx.query<{ version: number | string; title_only: string; bases: unknown; default_expiry_days: number | string }>(
    "SELECT version, title_only, bases, default_expiry_days FROM hs_knowledge_verification_policies WHERE tenant_id=$1",
    [tenantId],
  );
  const policy = row.rows[0];
  if (!policy) return null;
  return { version: num(policy.version), titleOnly: policy.title_only, bases: textList(policy.bases), defaultExpiryDays: num(policy.default_expiry_days) };
}

async function policyDraft(tx: Sql, tenantId: string, actorId: string) {
  const row = await tx.query<{ base_version: number | string; bases: unknown; default_expiry_days: number | string }>(
    "SELECT base_version, bases, default_expiry_days FROM hs_knowledge_verification_policy_drafts WHERE tenant_id=$1 AND actor_id=$2",
    [tenantId, actorId],
  );
  const draft = row.rows[0];
  if (!draft) return null;
  return { baseVersion: num(draft.base_version), bases: textList(draft.bases), defaultExpiryDays: num(draft.default_expiry_days) };
}

async function badgeDraft(tx: Sql, tenantId: string, actorId: string, kind: string, id: string) {
  const row = await tx.query<{ base_version: number | string; payload: unknown }>(
    "SELECT base_version, payload FROM hs_knowledge_verification_drafts WHERE tenant_id=$1 AND actor_id=$2 AND target_kind=$3 AND target_id=$4",
    [tenantId, actorId, kind, id],
  );
  if (!row.rows[0]) return null;
  return { baseVersion: num(row.rows[0].base_version), payload: asJson<DraftPayload>(row.rows[0].payload) };
}

async function saveBadgeDraft(tx: Sql, tenantId: string, actorId: string, kind: string, id: string, baseVersion: number, payload: DraftPayload, operationId: string) {
  await tx.query(
    `INSERT INTO hs_knowledge_verification_drafts(tenant_id,actor_id,target_kind,target_id,base_version,payload,operation_id)
     VALUES($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (tenant_id, actor_id, target_kind, target_id)
     DO UPDATE SET base_version=$5, payload=$6, operation_id=$7, updated_at=clock_timestamp()`,
    [tenantId, actorId, kind, id, baseVersion, JSON.stringify(payload), operationId],
  );
}

function attested(row: BadgeRow): Fingerprint {
  return { titleHash: row.title_hash, contentHash: row.content_hash, sourceHash: row.source_hash };
}

function present(row: BadgeRow, access: TargetAccess, draft: { baseVersion: number; payload: DraftPayload } | null): KnowledgeBadgeView {
  const assessment = assessVerification({
    attested: attested(row),
    live: access.fingerprint,
    storedStatus: row.status,
    expiresAt: at(row.expires_at),
    now: new Date(),
    titleOnly: row.title_only,
  });
  return {
    id: row.id,
    targetKind: row.target_kind,
    targetId: row.target_id,
    title: access.title,
    status: assessment.status,
    label: verificationLabel(assessment.status),
    reason: assessment.reason,
    titleChanged: assessment.titleChanged,
    titleOnlyPolicy: assessment.titleOnlyPolicy,
    titleOnlyRule: knowledgeVerificationTitleOnly,
    owner: row.owner_name,
    ownerId: row.owner_id,
    basis: row.basis,
    basisNote: row.basis_note,
    expiryDays: num(row.expiry_days),
    expiresAt: at(row.expires_at).toISOString(),
    revision: num(row.revision_version),
    attestedRevision: num(row.revision_version),
    liveRevision: access.fingerprint ? access.revision : null,
    publishedRef: row.published_ref,
    version: num(row.version),
    verifiedBy: row.verified_by,
    statement: knowledgeVerificationStatement,
    recoverableDraft: draft,
    rights: { tenant: true, record: "view", field: "view", action: "inspect" },
  };
}

function pinOf(view: KnowledgeBadgeView): KnowledgeBadgePin {
  return {
    status: view.status, label: view.label, owner: view.owner, basis: view.basis, expiresAt: view.expiresAt,
    revision: view.attestedRevision, titleOnlyPolicy: view.titleOnlyPolicy, statement: view.statement,
  };
}

async function loadBadge(tx: Sql, tenantId: string, badgeId: string) {
  if (!uuidPattern.test(badgeId)) return null;
  const row = await tx.query<BadgeRow>(
    `SELECT b.id::text, b.target_kind, b.target_id, b.revision_version, b.published_ref, b.title_hash, b.content_hash, b.source_hash, b.title_only,
            b.owner_id, u.name AS owner_name, b.basis, b.basis_note, b.expiry_days, b.expires_at, b.status, b.version, b.verified_by, b.created_at
     FROM hs_knowledge_verification_badges b JOIN hs_users u ON u.id=b.owner_id
     WHERE b.id=$1 AND b.tenant_id=$2`,
    [badgeId, tenantId],
  );
  return row.rows[0] ?? null;
}

async function showBadge(r: Repository, tx: Sql, here: Scope, actor: Actor, row: BadgeRow): Promise<ShownBadge | null> {
  const access = await openTarget(r, tx, here, actor, row.target_kind, row.target_id);
  const field = await fieldFlags(tx, here.tenantId, actor.id);
  const projected = verificationProjection({ contentPermitted: !!access?.view, metadataPermitted: field.view, badge: row });
  if (!projected.include || !projected.badge || !access) return null;
  const draft = await badgeDraft(tx, here.tenantId, actor.id, row.target_kind, row.target_id);
  return { access, view: present(row, access, draft), row, field };
}

async function requireShown(r: Repository, tx: Sql, here: Scope, actor: Actor, badgeId: string) {
  const row = await loadBadge(tx, here.tenantId, badgeId);
  if (!row) throw unavailable();
  const shown = await showBadge(r, tx, here, actor, row);
  if (!shown) throw unavailable();
  return shown;
}

const badgeSelect = `SELECT b.id::text, b.target_kind, b.target_id, b.revision_version, b.published_ref, b.title_hash, b.content_hash, b.source_hash, b.title_only,
  b.owner_id, u.name AS owner_name, b.basis, b.basis_note, b.expiry_days, b.expires_at, b.status, b.version, b.verified_by, b.created_at
  FROM hs_knowledge_verification_badges b JOIN hs_users u ON u.id=b.owner_id`;

function copy(boundary = true) {
  return {
    boundary: knowledgeVerificationBoundary,
    assignment: knowledgeVerificationAssignment,
    titleOnlyPolicy: knowledgeVerificationTitleOnlyPolicy,
    titleOnlyRule: knowledgeVerificationTitleOnly,
    statement: knowledgeVerificationStatement,
    schedules: knowledgeVerificationSchedules,
    recoverable: knowledgeVerificationRecoverable,
    ...(boundary ? { attestation: knowledgeVerificationStatement } : {}),
  };
}

export async function knowledgeVerificationCatalogue(r: Repository, actor: Actor, workspaceId: string) {
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    const steward = await isSteward(tx, here, actor);
    const admin = here.role === "owner" || here.role === "admin";
    const policy = await policyOf(tx, here.tenantId);
    const draft = admin ? await policyDraft(tx, here.tenantId, actor.id) : null;
    const rows = await tx.query<BadgeRow>(`${badgeSelect} WHERE b.tenant_id=$1 ORDER BY b.updated_at DESC, b.id LIMIT 100`, [here.tenantId]);
    const badges: KnowledgeBadgeView[] = [];
    for (const row of rows.rows) {
      const shown = await showBadge(r, tx, here, actor, row);
      if (shown) badges.push(shown.view);
    }
    const loose = await tx.query<{ target_kind: "page" | "record"; target_id: string; base_version: number | string; payload: unknown }>(
      "SELECT target_kind, target_id, base_version, payload FROM hs_knowledge_verification_drafts WHERE tenant_id=$1 AND actor_id=$2",
      [here.tenantId, actor.id],
    );
    const drafts = [];
    for (const item of loose.rows) {
      if (badges.some(badge => badge.targetKind === item.target_kind && badge.targetId === item.target_id)) continue;
      const access = await openTarget(r, tx, here, actor, item.target_kind, item.target_id);
      const field = await fieldFlags(tx, here.tenantId, actor.id);
      if (!access?.view || !field.view) continue;
      drafts.push({ targetKind: item.target_kind, targetId: item.target_id, baseVersion: num(item.base_version), payload: asJson<DraftPayload>(item.payload) });
    }
    const members = steward
      ? (await tx.query<{ id: string; name: string }>("SELECT u.id, u.name FROM hs_members m JOIN hs_users u ON u.id=m.user_id WHERE m.workspace_id=$1 AND m.active=true AND m.role<>'observer' ORDER BY u.name, u.id", [here.workspaceId])).rows
      : [];
    return {
      ...copy(),
      manage: admin,
      steward,
      policy: policy ? { ...policy, titleOnlyPolicy: knowledgeVerificationTitleOnlyPolicy, recoverableDraft: draft } : null,
      badges,
      drafts,
      members,
    };
  });
}

export async function readKnowledgeBadge(r: Repository, actor: Actor, workspaceId: string, badgeId: string) {
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    return (await requireShown(r, tx, here, actor, badgeId)).view;
  });
}

export async function searchKnowledgeVerification(r: Repository, actor: Actor, workspaceId: string, query: string) {
  const needle = verificationQuery(query);
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    const rows = await tx.query<BadgeRow>(`${badgeSelect} WHERE b.tenant_id=$1 ORDER BY b.updated_at DESC, b.id LIMIT 200`, [here.tenantId]);
    const results = [];
    for (const row of rows.rows) {
      const shown = await showBadge(r, tx, here, actor, row);
      if (!shown) continue;
      const hay = `${shown.view.title}\n${shown.view.owner}\n${shown.view.basis}\n${shown.view.basisNote}`.toLocaleLowerCase();
      if (!hay.includes(needle)) continue;
      results.push({
        id: shown.view.id, targetKind: shown.view.targetKind, targetId: shown.view.targetId, title: shown.view.title,
        status: shown.view.status, label: shown.view.label, owner: shown.view.owner, basis: shown.view.basis,
        expiresAt: shown.view.expiresAt, revision: shown.view.attestedRevision, titleChanged: shown.view.titleChanged,
        titleOnlyPolicy: shown.view.titleOnlyPolicy, titleOnlyRule: shown.view.titleOnlyRule, statement: shown.view.statement,
      });
      if (results.length >= 50) break;
    }
    return { results, assignment: knowledgeVerificationAssignment };
  });
}

export async function projectKnowledgeVerification(r: Repository, actor: Actor, workspaceId: string, input: { recordIds?: string[]; pageIds?: string[] }) {
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    return {
      records: await projectKind(r, tx, here, actor, "record", input.recordIds ?? []),
      pages: await projectKind(r, tx, here, actor, "page", input.pageIds ?? []),
      assignment: knowledgeVerificationAssignment,
    };
  });
}

async function projectKind(r: Repository, tx: Sql, here: Scope, actor: Actor, kind: "page" | "record", ids: string[]) {
  const unique = [...new Set(ids)].slice(0, 50);
  const results: { id: string; verification: KnowledgeBadgePin | null }[] = [];
  for (const id of unique) {
    const access = await openTarget(r, tx, here, actor, kind, id);
    if (!access?.view) continue;
    const field = await fieldFlags(tx, here.tenantId, actor.id);
    const row = (await tx.query<BadgeRow>(`${badgeSelect} WHERE b.tenant_id=$1 AND b.target_kind=$2 AND b.target_id=$3`, [here.tenantId, kind, id])).rows[0] ?? null;
    const projected = verificationProjection({
      contentPermitted: true,
      metadataPermitted: field.view,
      badge: row ? pinOf(present(row, access, null)) : null,
    });
    results.push({ id, verification: projected.badge });
  }
  return results;
}

export async function decorateKnowledgeVerification(tx: Sql, tenantId: string, workspaceId: string, actor: Actor, screens: { components: { records?: { id: string }[]; record?: { id: string } | null }[] }[]) {
  const ids = new Set<string>();
  for (const screen of screens) for (const component of screen.components) {
    for (const record of component.records ?? []) ids.add(record.id);
    if (component.record?.id) ids.add(component.record.id);
  }
  if (!ids.size) return;
  const here = await scopeOf(tx, workspaceId, actor);
  if (here.tenantId !== tenantId) return;
  const field = await fieldFlags(tx, here.tenantId, actor.id);
  const rows = await tx.query<BadgeRow>(`${badgeSelect} WHERE b.tenant_id=$1 AND b.target_kind='record'`, [here.tenantId]);
  const byId = new Map(rows.rows.filter(row => ids.has(row.target_id)).map(row => [row.target_id, row]));
  const apply = async (record: { id: string }) => {
    const row = byId.get(record.id);
    if (!row) return;
    const access = await openRecord(tx, here, actor, record.id);
    const projected = verificationProjection({ contentPermitted: !!access?.view, metadataPermitted: field.view, badge: access ? pinOf(present(row, access, null)) : null });
    (record as { verification?: KnowledgeBadgePin | null }).verification = projected.include ? projected.badge : null;
  };
  for (const screen of screens) for (const component of screen.components) {
    for (const record of component.records ?? []) await apply(record);
    if (component.record) await apply(component.record);
  }
}

export async function knowledgeVerificationHistory(r: Repository, actor: Actor, workspaceId: string, badgeId: string) {
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    const shown = await requireShown(r, tx, here, actor, badgeId);
    const allowed = await actionAllowed(tx, here.tenantId, actor.id, "history", shown.access.history && shown.field.history);
    if (!allowed) throw forbidden();
    const events = await tx.query<{ action: string; actor_id: string; actor_name: string; operation_id: string; source: string; created_at: string | Date; detail: unknown }>(
      `SELECT e.action, e.actor_id, u.name AS actor_name, e.operation_id::text, e.source, e.created_at, e.detail
       FROM hs_knowledge_verification_events e JOIN hs_users u ON u.id=e.actor_id
       WHERE e.tenant_id=$1 AND e.badge_id=$2 ORDER BY e.created_at, e.id`,
      [here.tenantId, badgeId],
    );
    return {
      events: events.rows.map(event => {
        const detail = asJson<{ reason?: string; revision?: number }>(event.detail);
        return {
          action: event.action, actorId: event.actor_id, actorName: event.actor_name, operationId: event.operation_id,
          source: event.source, atIst: formatIst(event.created_at), reason: detail.reason ?? null, revision: detail.revision ?? null,
        };
      }),
      scope: shown.view,
    };
  });
}

export async function knowledgeVerificationSourcePreview(r: Repository, actor: Actor, workspaceId: string, badgeId: string) {
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    const shown = await requireShown(r, tx, here, actor, badgeId);
    const preview = verificationProjection({ contentPermitted: shown.access.view, metadataPermitted: shown.field.view, badge: shown.view });
    if (!preview.include || !preview.badge) throw unavailable();
    return {
      badge: pinOf(shown.view),
      title: shown.view.title,
      excerpt: shown.access.excerpt,
      sources: shown.access.sources,
      titleOnlyRule: knowledgeVerificationTitleOnly,
      statement: knowledgeVerificationStatement,
    };
  });
}

async function writeRevision(tx: Sql, row: BadgeRow, action: string, actor: Actor, operationId: string) {
  await tx.query(
    `INSERT INTO hs_knowledge_verification_revisions(badge_id,version,status,revision_version,published_ref,title_hash,content_hash,source_hash,owner_id,basis,basis_note,expiry_days,expires_at,action,actor_id,operation_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
    [row.id, num(row.version), row.status, num(row.revision_version), row.published_ref, row.title_hash, row.content_hash, row.source_hash, row.owner_id, row.basis, row.basis_note, num(row.expiry_days), at(row.expires_at).toISOString(), action, actor.id, operationId],
  );
}

function ownerId(value: unknown) {
  if (typeof value !== "string") throw new DocumentError("Choose an accountable owner.", "knowledge_verification_owner", 422);
  const id = value.trim();
  if (!id || id.length > 200 || control.test(id)) throw new DocumentError("Choose an accountable owner.", "knowledge_verification_owner", 422);
  return id;
}

export async function saveKnowledgeVerificationPolicy(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; expectedVersion: number; bases: string[]; defaultExpiryDays: number; titleOnly?: string }) {
  const bases = verificationBases(input.bases);
  const expiry = verificationExpiryDays(input.defaultExpiryDays);
  if (input.titleOnly !== undefined) assertTitleOnlyPolicy(input.titleOnly);
  const requestHash = recordHash({ kind: "policy", workspaceId, expectedVersion: input.expectedVersion, bases, expiry });
  const outcome = await r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await hold(tx, here.tenantId);
    if (here.role !== "owner" && here.role !== "admin") throw authorityError();
    if (!await actionAllowed(tx, here.tenantId, actor.id, "configure", true)) throw forbidden();
    const replay = await prior<{ version: number }>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    const policy = await policyOf(tx, here.tenantId);
    const version = policy?.version ?? 0;
    if (version !== input.expectedVersion) {
      await tx.query(
        `INSERT INTO hs_knowledge_verification_policy_drafts(tenant_id,actor_id,base_version,bases,default_expiry_days,operation_id)
         VALUES($1,$2,$3,$4,$5,$6)
         ON CONFLICT (tenant_id, actor_id) DO UPDATE SET base_version=$3, bases=$4, default_expiry_days=$5, operation_id=$6, updated_at=clock_timestamp()`,
        [here.tenantId, actor.id, input.expectedVersion, JSON.stringify(bases), expiry, input.operationId],
      );
      return remember(tx, actor.id, input.operationId, requestHash, { conflict: true as const, recoverable: true as const, version });
    }
    const next = version + 1;
    await tx.query(
      `INSERT INTO hs_knowledge_verification_policies(tenant_id,version,title_only,bases,default_expiry_days)
       VALUES($1,$2,'preserve',$3,$4)
       ON CONFLICT (tenant_id) DO UPDATE SET version=$2, bases=$3, default_expiry_days=$4, updated_at=clock_timestamp()`,
      [here.tenantId, next, JSON.stringify(bases), expiry],
    );
    await tx.query(
      "INSERT INTO hs_knowledge_verification_policy_revisions(tenant_id,version,bases,default_expiry_days,actor_id,operation_id) VALUES($1,$2,$3,$4,$5,$6)",
      [here.tenantId, next, JSON.stringify(bases), expiry, actor.id, input.operationId],
    );
    await tx.query("DELETE FROM hs_knowledge_verification_policy_drafts WHERE tenant_id=$1 AND actor_id=$2", [here.tenantId, actor.id]);
    await track(tx, here.tenantId, actor, "configure", input.operationId, null, { version: next, titleOnly: knowledgeVerificationTitleOnlyPolicy });
    await audit(tx, actor, "knowledge-verification.configure", input.operationId, here.tenantId, { workspaceId, version: next });
    return remember(tx, actor.id, input.operationId, requestHash, { version: next, titleOnlyPolicy: knowledgeVerificationTitleOnlyPolicy, bases, defaultExpiryDays: expiry });
  });
  return settle(outcome);
}

export async function stashKnowledgeVerificationPolicy(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; expectedVersion: number; bases: string[]; defaultExpiryDays: number }) {
  const bases = verificationBases(input.bases);
  const expiry = verificationExpiryDays(input.defaultExpiryDays);
  const requestHash = recordHash({ kind: "stash-policy", workspaceId, ...input, bases, expiry });
  const outcome = await r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await hold(tx, here.tenantId);
    if (here.role !== "owner" && here.role !== "admin") throw authorityError();
    const replay = await prior<{ kept: true }>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    await tx.query(
      `INSERT INTO hs_knowledge_verification_policy_drafts(tenant_id,actor_id,base_version,bases,default_expiry_days,operation_id)
       VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT (tenant_id, actor_id) DO UPDATE SET base_version=$3, bases=$4, default_expiry_days=$5, operation_id=$6, updated_at=clock_timestamp()`,
      [here.tenantId, actor.id, input.expectedVersion, JSON.stringify(bases), expiry, input.operationId],
    );
    const policy = await policyOf(tx, here.tenantId);
    await audit(tx, actor, "knowledge-verification.stash-policy", input.operationId, here.tenantId, { workspaceId, version: policy?.version ?? 0 });
    const mismatched = (policy?.version ?? 0) !== input.expectedVersion;
    return remember(tx, actor.id, input.operationId, requestHash, { kept: true as const, recoverable: true as const, conflict: mismatched });
  });
  return settle(outcome);
}

export async function discardKnowledgeVerificationPolicy(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string }) {
  const requestHash = recordHash({ kind: "discard-policy", workspaceId, operationId: input.operationId });
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    if (here.role !== "owner" && here.role !== "admin") throw authorityError();
    const replay = await prior<{ discarded: true }>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    await tx.query("DELETE FROM hs_knowledge_verification_policy_drafts WHERE tenant_id=$1 AND actor_id=$2", [here.tenantId, actor.id]);
    await audit(tx, actor, "knowledge-verification.discard-policy", input.operationId, here.tenantId, { workspaceId });
    return remember(tx, actor.id, input.operationId, requestHash, { discarded: true as const });
  });
}

export async function saveKnowledgeVerificationFieldPolicy(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; expectedVersion: number; sensitive: boolean; access: { userId: string; canView: boolean; canWrite: boolean; canHistory: boolean }[] }) {
  const requestHash = recordHash({ kind: "field-policy", workspaceId, expectedVersion: input.expectedVersion, sensitive: input.sensitive, access: input.access });
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await hold(tx, here.tenantId);
    if (here.role !== "owner" && here.role !== "admin") throw authorityError();
    const replay = await prior<{ version: number }>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    const current = await tx.query<{ version: number | string }>("SELECT version FROM hs_knowledge_verification_field_policy WHERE tenant_id=$1", [here.tenantId]);
    const version = current.rows[0] ? num(current.rows[0].version) : 0;
    if (version !== input.expectedVersion) throw unchanged();
    const next = version + 1;
    await tx.query(
      `INSERT INTO hs_knowledge_verification_field_policy(tenant_id,sensitive,version) VALUES($1,$2,$3)
       ON CONFLICT (tenant_id) DO UPDATE SET sensitive=$2, version=$3`,
      [here.tenantId, input.sensitive === true, next],
    );
    await tx.query("DELETE FROM hs_knowledge_verification_field_access WHERE tenant_id=$1", [here.tenantId]);
    for (const entry of input.access) {
      if (!await activeOwner(tx, here.workspaceId, entry.userId) && entry.userId !== actor.id) {
        const member = await tx.query("SELECT 1 FROM hs_members WHERE workspace_id=$1 AND user_id=$2 AND active=true", [here.workspaceId, entry.userId]);
        if (!member.rows.length) throw unavailable();
      }
      await tx.query(
        "INSERT INTO hs_knowledge_verification_field_access(tenant_id,user_id,can_view,can_write,can_history) VALUES($1,$2,$3,$4,$5)",
        [here.tenantId, entry.userId, entry.canView === true, entry.canWrite === true, entry.canHistory === true],
      );
    }
    await audit(tx, actor, "knowledge-verification.field-policy", input.operationId, here.tenantId, { workspaceId, version: next, sensitive: input.sensitive === true });
    return remember(tx, actor.id, input.operationId, requestHash, { version: next, sensitive: input.sensitive === true });
  });
}

export async function setKnowledgeVerificationActions(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; userId: string; expectedVersion: number; actions: string[] }) {
  const actions: VerificationAction[] = [];
  for (const action of input.actions) {
    if (!knowledgeVerificationActions.includes(action as VerificationAction) || actions.includes(action as VerificationAction)) {
      throw new DocumentError("Check the verification request.", "knowledge_verification_validation", 422);
    }
    actions.push(action as VerificationAction);
  }
  const requestHash = recordHash({ kind: "actions", workspaceId, userId: input.userId, expectedVersion: input.expectedVersion, actions });
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await hold(tx, here.tenantId);
    if (here.role !== "owner" && here.role !== "admin") throw authorityError();
    const member = await tx.query("SELECT 1 FROM hs_members WHERE workspace_id=$1 AND user_id=$2 AND active=true", [here.workspaceId, input.userId]);
    if (!member.rows.length) throw unavailable();
    const replay = await prior<{ version: number }>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    const current = await tx.query<{ version: number | string }>("SELECT version FROM hs_knowledge_verification_action_sets WHERE tenant_id=$1 AND user_id=$2", [here.tenantId, input.userId]);
    const version = current.rows[0] ? num(current.rows[0].version) : 0;
    if (version !== input.expectedVersion) throw unchanged();
    const next = version + 1;
    await tx.query("DELETE FROM hs_knowledge_verification_actions WHERE tenant_id=$1 AND user_id=$2", [here.tenantId, input.userId]);
    for (const action of actions) {
      await tx.query("INSERT INTO hs_knowledge_verification_actions(tenant_id,user_id,action,granted_by) VALUES($1,$2,$3,$4)", [here.tenantId, input.userId, action, actor.id]);
    }
    await tx.query(
      `INSERT INTO hs_knowledge_verification_action_sets(tenant_id,user_id,version) VALUES($1,$2,$3)
       ON CONFLICT (tenant_id, user_id) DO UPDATE SET version=$3`,
      [here.tenantId, input.userId, next],
    );
    await audit(tx, actor, "knowledge-verification.actions", input.operationId, input.userId, { workspaceId, version: next, actions });
    return remember(tx, actor.id, input.operationId, requestHash, { version: next, actions, grantsAccess: false as const });
  });
}

export async function grantKnowledgeSteward(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; userId: string }) {
  const requestHash = recordHash({ kind: "grant-steward", workspaceId, userId: input.userId });
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await hold(tx, here.tenantId);
    if (here.role !== "owner" && here.role !== "admin") throw authorityError();
    const replay = await prior<{ granted: true }>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    if (!await activeOwner(tx, here.workspaceId, input.userId)) throw unavailable();
    await tx.query(
      `INSERT INTO hs_knowledge_verification_stewards(workspace_id,user_id,granted_by) VALUES($1,$2,$3)
       ON CONFLICT (workspace_id, user_id) DO NOTHING`,
      [here.workspaceId, input.userId, actor.id],
    );
    await audit(tx, actor, "knowledge-verification.grant-steward", input.operationId, input.userId, { workspaceId, grantsAccess: false });
    return remember(tx, actor.id, input.operationId, requestHash, { granted: true as const, grantsAccess: false as const });
  });
}

export async function revokeKnowledgeSteward(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; userId: string }) {
  const requestHash = recordHash({ kind: "revoke-steward", workspaceId, userId: input.userId });
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await hold(tx, here.tenantId);
    if (here.role !== "owner" && here.role !== "admin") throw authorityError();
    const replay = await prior<{ revoked: true }>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    await tx.query("DELETE FROM hs_knowledge_verification_stewards WHERE workspace_id=$1 AND user_id=$2", [here.workspaceId, input.userId]);
    await audit(tx, actor, "knowledge-verification.revoke-steward", input.operationId, input.userId, { workspaceId });
    return remember(tx, actor.id, input.operationId, requestHash, { revoked: true as const });
  });
}

export async function stashKnowledgeVerification(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; targetKind: "page" | "record"; targetId: string; expectedVersion: number; ownerId: string; basis: string; basisNote: string; expiryDays: number }) {
  const payload: DraftPayload = { ownerId: ownerId(input.ownerId), basis: input.basis.trim(), basisNote: input.basisNote, expiryDays: input.expiryDays };
  const requestHash = recordHash({ kind: "stash", workspaceId, ...input, payload });
  const outcome = await r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await hold(tx, here.tenantId);
    const steward = await isSteward(tx, here, actor);
    if (!steward) throw authorityError();
    const replay = await prior<{ kept: true }>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    const access = await openTarget(r, tx, here, actor, input.targetKind, input.targetId);
    const field = await fieldFlags(tx, here.tenantId, actor.id);
    if (!access?.view || !field.view) throw unavailable();
    if (!canWrite(field, steward)) throw forbidden();
    await saveBadgeDraft(tx, here.tenantId, actor.id, input.targetKind, input.targetId, input.expectedVersion, payload, input.operationId);
    const existing = (await tx.query<{ version: number | string }>("SELECT version FROM hs_knowledge_verification_badges WHERE tenant_id=$1 AND target_kind=$2 AND target_id=$3", [here.tenantId, input.targetKind, input.targetId])).rows[0];
    await audit(tx, actor, "knowledge-verification.stash", input.operationId, input.targetId, { workspaceId, version: existing ? num(existing.version) : 0 });
    const mismatched = (existing ? num(existing.version) : 0) !== input.expectedVersion;
    return remember(tx, actor.id, input.operationId, requestHash, { kept: true as const, recoverable: true as const, conflict: mismatched });
  });
  return settle(outcome);
}

export async function discardKnowledgeVerificationDraft(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; targetKind: "page" | "record"; targetId: string }) {
  const requestHash = recordHash({ kind: "discard-draft", workspaceId, ...input });
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    const replay = await prior<{ discarded: true }>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    await tx.query("DELETE FROM hs_knowledge_verification_drafts WHERE tenant_id=$1 AND actor_id=$2 AND target_kind=$3 AND target_id=$4", [here.tenantId, actor.id, input.targetKind, input.targetId]);
    await audit(tx, actor, "knowledge-verification.discard-draft", input.operationId, input.targetId, { workspaceId });
    return remember(tx, actor.id, input.operationId, requestHash, { discarded: true as const });
  });
}

type PreviewInput = {
  operationId: string;
  kind: PreviewKind;
  expectedVersion: number;
  targetKind?: "page" | "record";
  targetId?: string;
  badgeId?: string;
  ownerId?: string;
  basis?: string;
  basisNote?: string;
  expiryDays?: number;
  reason?: string;
};

export async function previewKnowledgeVerification(r: Repository, actor: Actor, workspaceId: string, input: PreviewInput) {
  const requestHash = recordHash({ workspaceId, preview: true, ...input });
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await hold(tx, here.tenantId);
    const replay = await prior<{ previewId: string }>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    const detail = await review(r, tx, here, actor, input);
    const previewId = randomUUID();
    const seal = recordHash(detail.detail);
    await tx.query(
      `INSERT INTO hs_knowledge_verification_previews(id,tenant_id,actor_id,action,badge_id,target_kind,target_id,expected_version,seal,detail)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [previewId, here.tenantId, actor.id, input.kind, detail.badgeId, detail.targetKind, detail.targetId, input.expectedVersion, seal, JSON.stringify(detail.detail)],
    );
    await audit(tx, actor, "knowledge-verification.preview", input.operationId, detail.badgeId ?? detail.targetId, { workspaceId, action: input.kind });
    return remember(tx, actor.id, input.operationId, requestHash, {
      previewId, action: input.kind, review: detail.review, version: input.expectedVersion, seal, schedules: knowledgeVerificationSchedules,
    });
  });
}

async function review(r: Repository, tx: Sql, here: Scope, actor: Actor, input: PreviewInput) {
  const steward = await isSteward(tx, here, actor);
  const field = await fieldFlags(tx, here.tenantId, actor.id);
  if (input.kind === "verify") {
    if (!input.targetKind || !input.targetId) throw unavailable();
    const access = await openTarget(r, tx, here, actor, input.targetKind, input.targetId);
    if (!access?.view || !field.view) throw unavailable();
    if (!steward || !canWrite(field, steward)) throw steward ? forbidden() : authorityError();
    if (!await actionAllowed(tx, here.tenantId, actor.id, "verify", true)) throw forbidden();
    if (!access.fingerprint || !access.publishedRef) throw unpublished();
    const policy = await policyOf(tx, here.tenantId);
    if (!policy) throw new DocumentError("Configure the verification bases first.", "knowledge_verification_basis", 422);
    const owner = ownerId(input.ownerId);
    if (!await activeOwner(tx, here.workspaceId, owner)) throw new DocumentError("Choose an accountable owner.", "knowledge_verification_owner", 422);
    const basis = verificationBasis(String(input.basis ?? ""), policy.bases);
    const basisNote = verificationNote(String(input.basisNote ?? ""));
    const expiryDays = verificationExpiryDays(Number(input.expiryDays));
    const existing = await tx.query<{ id: string; status: StoredVerificationStatus; version: number | string }>("SELECT id::text, status, version FROM hs_knowledge_verification_badges WHERE tenant_id=$1 AND target_kind=$2 AND target_id=$3", [here.tenantId, input.targetKind, input.targetId]);
    const row = existing.rows[0];
    if (row && row.status !== "revoked") throw renewRequired();
    if ((row ? num(row.version) : 0) !== input.expectedVersion) throw conflict();
    const detail = { ownerId: owner, basis, basisNote, expiryDays, fingerprint: access.fingerprint, revision: access.revision, publishedRef: access.publishedRef, policyVersion: policy.version, titleOnly: policy.titleOnly };
    return {
      badgeId: row?.id ?? null, targetKind: input.targetKind, targetId: input.targetId, detail,
      seal: { kind: input.kind, targetKind: input.targetKind, targetId: input.targetId, expectedVersion: input.expectedVersion, detail },
      review: `${knowledgeVerificationStatement} ${knowledgeVerificationTitleOnly} Expiry ${expiryDays} days. Owner and basis are saved with this revision only.`,
    };
  }
  if (!input.badgeId) throw unavailable();
  const shown = await requireShown(r, tx, here, actor, input.badgeId);
  if (num(shown.row.version) !== input.expectedVersion) throw conflict();
  if (!steward || !canWrite(field, steward)) throw steward ? forbidden() : authorityError();
  const reason = verificationReason(String(input.reason ?? ""));
  if (input.kind === "revoke") {
    if (shown.row.status === "revoked") throw conflict();
    if (!await actionAllowed(tx, here.tenantId, actor.id, "revoke", true)) throw forbidden();
    const detail = { reason, policyVersion: (await policyOf(tx, here.tenantId))?.version ?? 0 };
    return {
      badgeId: shown.row.id, targetKind: shown.row.target_kind, targetId: shown.row.target_id, detail,
      seal: { kind: "revoke", badgeId: shown.row.id, expectedVersion: input.expectedVersion, detail },
      review: `Revoke the attestation of published revision ${num(shown.row.revision_version)}. ${reason}`,
    };
  }
  if (!await actionAllowed(tx, here.tenantId, actor.id, "renew", true)) throw forbidden();
  if (shown.row.status === "revoked") throw new DocumentError("Verify the published revision again.", "knowledge_verification_renew", 409);
  if (!shown.access.fingerprint || !shown.access.publishedRef) throw unpublished();
  const expiryDays = verificationExpiryDays(Number(input.expiryDays));
  const detail = { reason, expiryDays, fingerprint: shown.access.fingerprint, revision: shown.access.revision, publishedRef: shown.access.publishedRef, ownerId: shown.row.owner_id, basis: shown.row.basis, basisNote: shown.row.basis_note };
  return {
    badgeId: shown.row.id, targetKind: shown.row.target_kind, targetId: shown.row.target_id, detail,
    seal: { kind: "renew", badgeId: shown.row.id, expectedVersion: input.expectedVersion, detail },
    review: `Renew the attestation for ${expiryDays} days. ${knowledgeVerificationTitleOnly} ${reason}`,
  };
}

export async function applyKnowledgeVerification(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; previewId: string; expectedVersion: number }) {
  const requestHash = recordHash({ kind: "apply", workspaceId, ...input });
  const outcome = await r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await hold(tx, here.tenantId);
    const replay = await prior<KnowledgeBadgeView>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    if (!uuidPattern.test(input.previewId)) throw previewError();
    const preview = await tx.query<{ action: PreviewKind; badge_id: string | null; target_kind: "page" | "record"; target_id: string; expected_version: number | string; seal: string; detail: unknown }>(
      "SELECT action, badge_id::text, target_kind, target_id, expected_version, seal, detail FROM hs_knowledge_verification_previews WHERE id=$1 AND tenant_id=$2 AND actor_id=$3",
      [input.previewId, here.tenantId, actor.id],
    );
    const row = preview.rows[0];
    if (!row || num(row.expected_version) !== input.expectedVersion) throw previewError();
    const detail = asJson<Record<string, unknown>>(row.detail);
    if (recordHash(detail) !== row.seal) throw previewError();
    const saved = await applyPreview(r, tx, here, actor, row.action, row.target_kind, row.target_id, row.badge_id, input.expectedVersion, detail, input.operationId);
    return remember(tx, actor.id, input.operationId, requestHash, saved);
  });
  return settle(outcome) as KnowledgeBadgeView & { replayed: boolean };
}

async function applyPreview(r: Repository, tx: Sql, here: Scope, actor: Actor, action: PreviewKind, kind: "page" | "record", targetId: string, badgeId: string | null, expectedVersion: number, detail: Record<string, unknown>, operationId: string): Promise<KnowledgeBadgeView | { conflict: true; recoverable: true; previewStale?: false } | { previewStale: true; recoverable: true; conflict?: false }> {
  const access = await openTarget(r, tx, here, actor, kind, targetId);
  const field = await fieldFlags(tx, here.tenantId, actor.id);
  const steward = await isSteward(tx, here, actor);
  if (!access?.view || !field.view) throw unavailable();
  if (!steward || !canWrite(field, steward) || !await actionAllowed(tx, here.tenantId, actor.id, action, true)) throw forbidden();
  const existing = (await tx.query<BadgeRow>(`${badgeSelect} WHERE b.tenant_id=$1 AND b.target_kind=$2 AND b.target_id=$3 FOR UPDATE OF b`, [here.tenantId, kind, targetId])).rows[0];
  if ((existing ? num(existing.version) : 0) !== expectedVersion) {
    await saveBadgeDraft(tx, here.tenantId, actor.id, kind, targetId, expectedVersion, draftFrom(detail), operationId);
    return { conflict: true, recoverable: true };
  }
  if (action !== "revoke") {
    const fingerprint = detail.fingerprint as Fingerprint | undefined;
    if (!access.fingerprint || !fingerprint || fingerprint.contentHash !== access.fingerprint.contentHash || fingerprint.sourceHash !== access.fingerprint.sourceHash || fingerprint.titleHash !== access.fingerprint.titleHash) {
      await saveBadgeDraft(tx, here.tenantId, actor.id, kind, targetId, expectedVersion, draftFrom(detail), operationId);
      return { previewStale: true, recoverable: true };
    }
  }
  const expiresAt = new Date(Date.now() + num(detail.expiryDays as number) * 86400000).toISOString();
  if (action === "verify") {
    if (existing && existing.status !== "revoked") throw renewRequired();
    const nextVersion = existing ? num(existing.version) + 1 : 1;
    const id = existing?.id ?? randomUUID();
    const fingerprint = access.fingerprint!;
    if (!existing) {
      await tx.query(
        `INSERT INTO hs_knowledge_verification_badges(id,tenant_id,target_kind,target_id,revision_version,published_ref,title_hash,content_hash,source_hash,title_only,owner_id,basis,basis_note,expiry_days,expires_at,status,version,verified_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,'preserve',$10,$11,$12,$13,$14,'current',$15,$16)`,
        [id, here.tenantId, kind, targetId, access.revision, access.publishedRef, fingerprint.titleHash, fingerprint.contentHash, fingerprint.sourceHash, detail.ownerId, detail.basis, detail.basisNote, detail.expiryDays, expiresAt, nextVersion, actor.id],
      );
    } else {
      await tx.query(
        `UPDATE hs_knowledge_verification_badges SET revision_version=$2, published_ref=$3, title_hash=$4, content_hash=$5, source_hash=$6, owner_id=$7, basis=$8, basis_note=$9, expiry_days=$10, expires_at=$11, status='current', version=$12, verified_by=$13, updated_at=clock_timestamp()
         WHERE id=$1 AND version=$14`,
        [id, access.revision, access.publishedRef, fingerprint.titleHash, fingerprint.contentHash, fingerprint.sourceHash, detail.ownerId, detail.basis, detail.basisNote, detail.expiryDays, expiresAt, nextVersion, actor.id, expectedVersion],
      );
    }
  } else if (action === "renew") {
    if (!existing || existing.status === "revoked") throw unchanged();
    const fingerprint = access.fingerprint!;
    await tx.query(
      `UPDATE hs_knowledge_verification_badges SET revision_version=$2, published_ref=$3, title_hash=$4, content_hash=$5, source_hash=$6, expiry_days=$7, expires_at=$8, status='current', version=$9, verified_by=$10, updated_at=clock_timestamp()
       WHERE id=$1 AND version=$11`,
      [existing.id, access.revision, access.publishedRef, fingerprint.titleHash, fingerprint.contentHash, fingerprint.sourceHash, detail.expiryDays, expiresAt, num(existing.version) + 1, actor.id, expectedVersion],
    );
  } else if (existing) {
    await tx.query("UPDATE hs_knowledge_verification_badges SET status='revoked', version=$2, updated_at=clock_timestamp() WHERE id=$1 AND version=$3", [existing.id, num(existing.version) + 1, expectedVersion]);
  } else throw unavailable();
  const saved = (await tx.query<BadgeRow>(`${badgeSelect} WHERE b.tenant_id=$1 AND b.target_kind=$2 AND b.target_id=$3`, [here.tenantId, kind, targetId])).rows[0];
  if (!saved) throw unavailable();
  await writeRevision(tx, saved, action, actor, operationId);
  await tx.query("DELETE FROM hs_knowledge_verification_drafts WHERE tenant_id=$1 AND actor_id=$2 AND target_kind=$3 AND target_id=$4", [here.tenantId, actor.id, kind, targetId]);
  await track(tx, here.tenantId, actor, action, operationId, saved.id, { reason: typeof detail.reason === "string" ? detail.reason : null, revision: num(saved.revision_version), basis: saved.basis, expiryDays: num(saved.expiry_days) });
  await audit(tx, actor, `knowledge-verification.${action}`, operationId, saved.id, { workspaceId: here.workspaceId, version: num(saved.version), targetKind: kind, targetId });
  const shown = await showBadge(r, tx, here, actor, saved);
  if (!shown) throw unavailable();
  return shown.view;
}

function draftFrom(detail: Record<string, unknown>): DraftPayload {
  return {
    ownerId: typeof detail.ownerId === "string" ? detail.ownerId : undefined,
    basis: typeof detail.basis === "string" ? detail.basis : undefined,
    basisNote: typeof detail.basisNote === "string" ? detail.basisNote : undefined,
    expiryDays: typeof detail.expiryDays === "number" ? detail.expiryDays : undefined,
    reason: typeof detail.reason === "string" ? detail.reason : undefined,
  };
}

export async function reportKnowledgeConcern(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; badgeId: string; reason: string }) {
  const reason = verificationReason(input.reason);
  const requestHash = recordHash({ kind: "concern", workspaceId, badgeId: input.badgeId, reason });
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    await hold(tx, here.tenantId);
    const replay = await prior<{ id: string }>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    const shown = await requireShown(r, tx, here, actor, input.badgeId);
    if (!await actionAllowed(tx, here.tenantId, actor.id, "report", shown.access.view && shown.field.view)) throw forbidden();
    const id = randomUUID();
    await tx.query(
      "INSERT INTO hs_knowledge_verification_concerns(id,tenant_id,badge_id,actor_id,operation_id,reason,source) VALUES($1,$2,$3,$4,$5,$6,$7)",
      [id, here.tenantId, shown.row.id, actor.id, input.operationId, reason, knowledgeVerificationSource],
    );
    await track(tx, here.tenantId, actor, "concern", input.operationId, shown.row.id, { reason, revision: num(shown.row.revision_version) });
    await audit(tx, actor, "knowledge-verification.concern", input.operationId, shown.row.id, { workspaceId, reason });
    return remember(tx, actor.id, input.operationId, requestHash, { id, reported: true as const, source: knowledgeVerificationSource, atIst: formatIst(new Date()) });
  });
}

export async function downloadKnowledgeVerification(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; badgeId: string; expectedVersion: number }) {
  const requestHash = recordHash({ kind: "download", workspaceId, ...input });
  return r.db.transaction(async tx => {
    const here = await scopeOf(tx, workspaceId, actor);
    const replay = await prior<{ body: string }>(tx, actor.id, input.operationId, requestHash);
    if (replay) return replay;
    const shown = await requireShown(r, tx, here, actor, input.badgeId);
    if (shown.view.version !== input.expectedVersion) throw unchanged();
    if (!await actionAllowed(tx, here.tenantId, actor.id, "download", shown.access.export && shown.field.view)) throw forbidden();
    const body = verificationDocument({
      kind: shown.view.targetKind, title: shown.view.title, status: shown.view.label, owner: shown.view.owner,
      basis: shown.view.basis, basisNote: shown.view.basisNote, expiresAt: shown.view.expiresAt,
      revision: shown.view.attestedRevision, titleChanged: shown.view.titleChanged, reason: shown.view.reason,
    });
    await audit(tx, actor, "knowledge-verification.download", input.operationId, shown.row.id, { workspaceId, version: shown.view.version });
    return remember(tx, actor.id, input.operationId, requestHash, { filename: "knowledge-verification.md", contentType: "text/markdown; charset=utf-8", body, version: shown.view.version });
  });
}
