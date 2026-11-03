import { createHash, randomUUID } from "node:crypto";
import type { Actor } from "./auth";
import type { Sql } from "./database";
import { DocumentError, stableStringify } from "./document";
import {
  classifySourceEdit,
  effectiveReview,
  impactReport,
  isDependencyKind,
  kindLabel,
  traverseDependencies,
  unrelatedMetadataRule,
  type DependencyKind,
  type PlanEdge,
  type PlanSource,
  type ShownReview,
  type SourceState,
  type StoredReview,
} from "./dependency-impact-plan";
import { formatIst } from "./ist-label";
import type { Repository } from "./repository";

const unavailable = () => new DocumentError("Dependency unavailable", "not_found", 404);
const conflict = () => new DocumentError("This dependency changed. Refresh it before saving.", "dependency_conflict", 409);
const readOnly = () => new DocumentError("This dependency is read only.", "read_only", 403);
const staleReview = () => new DocumentError("This review is stale. Refresh the source and dependent revisions before acknowledging.", "review_stale", 409);
const missingAuthority = () => new DocumentError("This reviewer cannot acknowledge the current revisions. Reassign the review.", "review_authority", 403);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

type EdgeRow = {
  id: string;
  workspace_id: string;
  kind: DependencyKind;
  source_id: string;
  source_revision: number;
  material_digest: string;
  dependent_page_id: string;
  dependent_revision: number;
  reviewer_id: string;
  review_state: StoredReview;
  review_reason: string;
  acknowledged_source_revision: number | null;
  acknowledged_dependent_revision: number | null;
  note: string;
  version: number;
};

type SourceRow = {
  workspace_id: string;
  kind: DependencyKind;
  source_id: string;
  revision: number;
  material_digest: string;
  state: SourceState;
  merged_into_id: string | null;
  note: string;
  version: number;
};

type SourceFact = {
  exists: boolean;
  readable: boolean;
  title: string;
  lifecycle: SourceState;
  registry: SourceRow | null;
};

export type EdgeView = {
  id: string;
  workspaceId: string;
  kind: DependencyKind;
  kindLabel: string;
  sourceId: string;
  sourceTitle: string;
  sourceRevision: number;
  liveSourceRevision: number;
  sourceState: SourceState;
  mergedIntoId: string | null;
  dependentPageId: string;
  dependentTitle: string;
  dependentRevision: number;
  liveDependentRevision: number;
  reviewerId: string;
  reviewerName: string;
  reviewerAuthority: boolean;
  reviewState: ShownReview;
  reviewReason: string;
  note: string;
  version: number;
  sourceVersion: number;
  access: "manage" | "review" | "view";
  recoverableDraft: { baseVersion: number; note: string; reviewerId: string } | null;
};

function asJson<T>(value: T | string): T {
  return typeof value === "string" ? JSON.parse(value) as T : value;
}

function digest(value: unknown) {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

function materialDigest(value: unknown) {
  return digest(value ?? null);
}

function flag(value: unknown) {
  return value === true || value === "t" || value === "true" || value === 1;
}

function num(value: number | string | null) {
  return value == null ? null : Number(value);
}

function reviewLabel(state: ShownReview) {
  if (state === "needs_review") return "Needs review";
  if (state === "acknowledged") return "Acknowledged";
  if (state === "stale") return "Stale review";
  return "Current";
}

async function audit(tx: Sql, actor: Actor, action: string, operationId: string, edgeId: string | null, after: Record<string, unknown>) {
  await tx.query(
    "INSERT INTO hs_audit(id, actor_id, action, page_id, subject_id, after_value, correlation_id) VALUES($1,$2,$3,NULL,$4,$5,$6)",
    [randomUUID(), actor.id, action, edgeId, JSON.stringify({ source: "dependency-impact", operationId, atIst: formatIst(new Date()), ...after }), operationId],
  );
}

async function priorOperation(tx: Sql, actor: Actor, operationId: string, requestHash: string) {
  const prior = await tx.query<{ request_hash: string; edge_id: string | null; result: unknown }>(
    "SELECT request_hash, edge_id, result FROM hs_dependency_operations WHERE actor_id=$1 AND operation_id=$2",
    [actor.id, operationId],
  );
  const row = prior.rows[0];
  if (!row) return null;
  if (row.request_hash !== requestHash) throw new DocumentError("Operation ID was reused with different content", "operation_mismatch", 409);
  return { edgeId: row.edge_id, result: asJson<Record<string, unknown>>(row.result as Record<string, unknown> | string) };
}

async function finish(tx: Sql, actor: Actor, operationId: string, requestHash: string, edgeId: string | null, result: Record<string, unknown>) {
  await tx.query(
    "INSERT INTO hs_dependency_operations(actor_id, operation_id, request_hash, edge_id, result) VALUES($1,$2,$3,$4,$5)",
    [actor.id, operationId, requestHash, edgeId, JSON.stringify(result)],
  );
}

async function workspaceRole(tx: Sql, workspaceId: string, actor: Actor) {
  const rows = await tx.query<{ role: string }>(
    "SELECT m.role FROM hs_workspaces w JOIN hs_members m ON m.workspace_id=w.id AND m.user_id=$2 AND m.active=true WHERE w.id=$1",
    [workspaceId, actor.id],
  );
  if (!rows.rows.length) throw unavailable();
  return rows.rows[0].role;
}

function nativeManager(role: string) {
  return role === "owner" || role === "admin";
}

async function managerFlag(tx: Sql, workspaceId: string, actor: Actor, role: string) {
  if (role === "observer") return false;
  if (nativeManager(role)) return true;
  const rows = await tx.query("SELECT 1 FROM hs_dependency_managers WHERE workspace_id=$1 AND user_id=$2", [workspaceId, actor.id]);
  return rows.rows.length > 0;
}

async function requireManager(tx: Sql, workspaceId: string, actor: Actor) {
  const role = await workspaceRole(tx, workspaceId, actor);
  if (role === "observer") throw readOnly();
  if (!await managerFlag(tx, workspaceId, actor, role)) throw new DocumentError("Dependency management authority required", "management_required", 403);
  return { role, native: nativeManager(role) };
}

async function activeMember(tx: Sql, workspaceId: string, userId: string) {
  const rows = await tx.query<{ role: string }>("SELECT role FROM hs_members WHERE workspace_id=$1 AND user_id=$2 AND active=true", [workspaceId, userId]);
  return rows.rows[0] ?? null;
}

async function readablePage(r: Repository, tx: Sql, actor: Actor, workspaceId: string, pageId: string) {
  try {
    const page = await r.access(tx, pageId, actor, false);
    if (page.workspace_id !== workspaceId) return null;
    return page;
  } catch (error) {
    if (error instanceof DocumentError && (error.status === 404 || error.status === 403)) return null;
    throw error;
  }
}

async function canEditPage(r: Repository, tx: Sql, actor: Actor, pageId: string) {
  try {
    await r.access(tx, pageId, actor, true);
    return true;
  } catch (error) {
    if (error instanceof DocumentError && (error.status === 404 || error.status === 403)) return false;
    throw error;
  }
}

async function registry(tx: Sql, workspaceId: string, kind: DependencyKind, sourceId: string, lock: boolean) {
  const rows = await tx.query<SourceRow>(
    `SELECT workspace_id, kind, source_id, revision, material_digest, state, merged_into_id, note, version FROM hs_dependency_sources WHERE workspace_id=$1 AND kind=$2 AND source_id=$3 ${lock ? "FOR UPDATE" : ""}`,
    [workspaceId, kind, sourceId],
  );
  const row = rows.rows[0];
  if (!row) return null;
  return { ...row, revision: Number(row.revision), version: Number(row.version) };
}

async function pageFact(tx: Sql, workspaceId: string, pageId: string) {
  const rows = await tx.query<{ title: string; deleted_at: string | null; version: number }>(
    "SELECT title, deleted_at, version FROM hs_pages WHERE id=$1 AND workspace_id=$2",
    [pageId, workspaceId],
  );
  return rows.rows[0] ? { ...rows.rows[0], version: Number(rows.rows[0].version) } : null;
}

function combineState(stored: SourceState | null, underlyingRetired: boolean): SourceState {
  if (stored === "merged" && !underlyingRetired) return "merged";
  if (underlyingRetired || stored === "retired") return "retired";
  return "active";
}

async function readSource(r: Repository, tx: Sql, actor: Actor, workspaceId: string, kind: DependencyKind, sourceId: string, manager: boolean): Promise<SourceFact> {
  void manager;
  const stored = await registry(tx, workspaceId, kind, sourceId, false);
  const role = await workspaceRole(tx, workspaceId, actor);
  const native = nativeManager(role);
  if (kind === "link") {
    const page = await pageFact(tx, workspaceId, sourceId);
    if (!page && !stored) return { exists: false, readable: false, title: "", lifecycle: "active", registry: stored };
    const deleted = Boolean(page?.deleted_at);
    const opened = page && !deleted ? await readablePage(r, tx, actor, workspaceId, sourceId) : null;
    const readable = Boolean(opened) || (native && deleted);
    return {
      exists: Boolean(page || stored),
      readable,
      title: opened?.title ?? (readable && deleted ? "Retired source" : ""),
      lifecycle: combineState(stored?.state ?? null, deleted),
      registry: stored,
    };
  }
  if (kind === "template") {
    const rows = await tx.query<{ name: string; archived: boolean; can_read: boolean }>(
      `SELECT t.name, t.archived_at IS NOT NULL AS archived,
        (t.owner_id=$3 OR (t.scope_space_id IS NOT NULL AND (t.restricted=false OR $4::boolean OR EXISTS(SELECT 1 FROM hs_space_template_managers g WHERE g.workspace_id=t.workspace_id AND g.space_id=t.scope_space_id AND g.user_id=$3)))) AS can_read
       FROM hs_templates t WHERE t.id::text=$1 AND t.workspace_id=$2`,
      [sourceId, workspaceId, actor.id, native],
    );
    const row = rows.rows[0];
    if (!row && !stored) return { exists: false, readable: false, title: "", lifecycle: "active", registry: stored };
    const readable = flag(row?.can_read);
    return { exists: Boolean(row || stored), readable, title: readable ? row?.name ?? "" : "", lifecycle: combineState(stored?.state ?? null, flag(row?.archived)), registry: stored };
  }
  if (kind === "snippet") {
    const rows = await tx.query<{ title: string; space_id: string; retired_at: string | null; deleted_at: string | null }>(
      "SELECT title, space_id, retired_at, deleted_at FROM hs_snippets WHERE id=$1 AND workspace_id=$2",
      [sourceId, workspaceId],
    );
    const row = rows.rows[0];
    if (!row && !stored) return { exists: false, readable: false, title: "", lifecycle: "active", registry: stored };
    let allowed = false;
    if (row && !row.deleted_at) {
      if (native) allowed = true;
      else {
        const granted = await tx.query("SELECT 1 FROM hs_snippet_roles WHERE space_id=$1 AND user_id=$2", [row.space_id, actor.id]);
        const member = await tx.query("SELECT 1 FROM hs_space_members WHERE space_id=$1 AND user_id=$2 AND active=true", [row.space_id, actor.id]);
        const page = await tx.query("SELECT 1 FROM hs_pages p WHERE p.space_id=$1 AND p.workspace_id=$2 AND p.deleted_at IS NULL AND (p.owner_id=$3 OR EXISTS(SELECT 1 FROM hs_grants g WHERE g.page_id=p.id AND (g.subject=$3 OR (p.visibility='space' AND g.subject='space')))) LIMIT 1", [row.space_id, workspaceId, actor.id]);
        allowed = granted.rows.length > 0 || member.rows.length > 0 || page.rows.length > 0;
      }
    }
    const readable = allowed || (native && Boolean(row?.deleted_at));
    const retired = Boolean(row?.retired_at || row?.deleted_at);
    return { exists: Boolean(row || stored), readable, title: allowed ? row?.title ?? "" : readable ? "Retired source" : "", lifecycle: combineState(stored?.state ?? null, retired), registry: stored };
  }
  const rows = await tx.query<{ source_page_id: string | null; deleted_at: string | null }>(
    "SELECT source_page_id, deleted_at FROM hs_synced_blocks WHERE id=$1 AND workspace_id=$2",
    [sourceId, workspaceId],
  );
  const row = rows.rows[0];
  if (!row && !stored) return { exists: false, readable: false, title: "", lifecycle: "active", registry: stored };
  const sourcePage = row?.source_page_id && !row.deleted_at ? await readablePage(r, tx, actor, workspaceId, row.source_page_id) : null;
  const grant = row && !row.deleted_at ? await tx.query("SELECT 1 FROM hs_synced_grants WHERE synced_id=$1 AND subject=$2", [sourceId, actor.id]) : { rows: [] };
  const allowed = Boolean(sourcePage) || grant.rows.length > 0;
  const readable = allowed || (native && Boolean(row?.deleted_at));
  return {
    exists: Boolean(row || stored),
    readable,
    title: sourcePage ? sourcePage.title : readable ? (row?.deleted_at ? "Retired source" : "Synced source") : "",
    lifecycle: combineState(stored?.state ?? null, Boolean(row?.deleted_at)),
    registry: stored,
  };
}

async function revisionMaterial(tx: Sql, workspaceId: string, kind: DependencyKind, sourceId: string, revision: number) {
  if (kind === "link") {
    const rows = await tx.query<{ document: unknown }>(
      "SELECT r.document FROM hs_revisions r JOIN hs_pages p ON p.id=r.page_id WHERE p.id=$1 AND p.workspace_id=$2 AND r.version=$3",
      [sourceId, workspaceId, revision],
    );
    return rows.rows[0] ? materialDigest(asJson(rows.rows[0].document)) : null;
  }
  if (kind === "template") {
    const rows = await tx.query<{ document: unknown }>(
      "SELECT v.document FROM hs_template_revisions v JOIN hs_templates t ON t.id=v.template_id WHERE t.id::text=$1 AND t.workspace_id=$2 AND v.version=$3",
      [sourceId, workspaceId, revision],
    );
    return rows.rows[0] ? materialDigest(asJson(rows.rows[0].document)) : null;
  }
  if (kind === "snippet") {
    const rows = await tx.query<{ content: unknown }>(
      "SELECT v.content FROM hs_snippet_versions v JOIN hs_snippets s ON s.id=v.snippet_id WHERE s.id=$1 AND s.workspace_id=$2 AND v.version_number=$3",
      [sourceId, workspaceId, revision],
    );
    return rows.rows[0] ? materialDigest(asJson(rows.rows[0].content)) : null;
  }
  const rows = await tx.query<{ content: unknown; version: number; previous_content: unknown; previous_version: number | null }>(
    "SELECT content, version, previous_content, previous_version FROM hs_synced_blocks WHERE id=$1 AND workspace_id=$2",
    [sourceId, workspaceId],
  );
  const row = rows.rows[0];
  if (!row) return null;
  if (Number(row.version) === revision) return materialDigest(asJson(row.content));
  if (row.previous_version != null && Number(row.previous_version) === revision) return materialDigest(asJson(row.previous_content));
  return null;
}

async function provenance(tx: Sql, kind: DependencyKind, sourceId: string, dependentPageId: string) {
  if (kind === "link") {
    const rows = await tx.query("SELECT 1 FROM hs_blocks WHERE page_id=$1 AND type='pageLink' AND node->'attrs'->>'pageId'=$2 LIMIT 1", [dependentPageId, sourceId]);
    return rows.rows.length > 0;
  }
  if (kind === "template") {
    const rows = await tx.query("SELECT 1 FROM hs_page_template_sources WHERE page_id=$1 AND template_id=$2 LIMIT 1", [dependentPageId, sourceId]);
    return rows.rows.length > 0;
  }
  if (kind === "snippet") {
    const rows = await tx.query("SELECT 1 FROM hs_snippet_placements WHERE page_id=$1 AND snippet_id=$2 LIMIT 1", [dependentPageId, sourceId]);
    return rows.rows.length > 0;
  }
  const rows = await tx.query("SELECT 1 FROM hs_synced_placements WHERE page_id=$1 AND synced_id=$2 LIMIT 1", [dependentPageId, sourceId]);
  return rows.rows.length > 0;
}

async function loadEdge(tx: Sql, workspaceId: string, edgeId: string, lock: boolean) {
  if (!uuidPattern.test(edgeId)) throw unavailable();
  const rows = await tx.query<EdgeRow>(
    `SELECT id, workspace_id, kind, source_id, source_revision, material_digest, dependent_page_id, dependent_revision, reviewer_id, review_state, review_reason, acknowledged_source_revision, acknowledged_dependent_revision, note, version FROM hs_dependency_edges WHERE id=$1 AND workspace_id=$2 ${lock ? "FOR UPDATE" : ""}`,
    [edgeId, workspaceId],
  );
  const row = rows.rows[0];
  if (!row) throw unavailable();
  return {
    ...row,
    source_revision: Number(row.source_revision),
    dependent_revision: Number(row.dependent_revision),
    acknowledged_source_revision: num(row.acknowledged_source_revision),
    acknowledged_dependent_revision: num(row.acknowledged_dependent_revision),
    version: Number(row.version),
  };
}

async function reviewerCanAct(r: Repository, tx: Sql, workspaceId: string, reviewerId: string, kind: DependencyKind, sourceId: string, dependentPageId: string) {
  const member = await activeMember(tx, workspaceId, reviewerId);
  if (!member || member.role === "observer") return false;
  const reviewer = { id: reviewerId, name: "" };
  const source = await readSource(r, tx, reviewer, workspaceId, kind, sourceId, false);
  const dependent = await readablePage(r, tx, reviewer, workspaceId, dependentPageId);
  return source.readable && Boolean(dependent);
}

async function present(r: Repository, tx: Sql, actor: Actor, workspaceId: string, edgeId: string, role: string, manager: boolean): Promise<EdgeView | null> {
  const edge = await loadEdge(tx, workspaceId, edgeId, false);
  const source = await readSource(r, tx, actor, workspaceId, edge.kind, edge.source_id, manager);
  const dependent = await readablePage(r, tx, actor, workspaceId, edge.dependent_page_id);
  if (!source.readable || !source.exists || !dependent) return null;
  const liveDependent = await pageFact(tx, workspaceId, edge.dependent_page_id);
  const names = await tx.query<{ id: string; name: string }>("SELECT id, name FROM hs_users WHERE id=$1", [edge.reviewer_id]);
  const draft = await tx.query<{ base_version: number; note: string; reviewer_id: string }>(
    "SELECT base_version, note, reviewer_id FROM hs_dependency_drafts WHERE edge_id=$1 AND actor_id=$2",
    [edge.id, actor.id],
  );
  const successor = source.lifecycle === "merged" && source.registry?.merged_into_id
    ? await readSource(r, tx, actor, workspaceId, edge.kind, source.registry.merged_into_id, manager)
    : null;
  const authority = await reviewerCanAct(r, tx, workspaceId, edge.reviewer_id, edge.kind, edge.source_id, edge.dependent_page_id);
  const access = manager ? "manage" : edge.reviewer_id === actor.id && role !== "observer" ? "review" : "view";
  return {
    id: edge.id,
    workspaceId,
    kind: edge.kind,
    kindLabel: kindLabel(edge.kind),
    sourceId: edge.source_id,
    sourceTitle: source.title,
    sourceRevision: edge.source_revision,
    liveSourceRevision: edge.source_revision,
    sourceState: source.lifecycle,
    mergedIntoId: successor?.readable ? source.registry?.merged_into_id ?? null : null,
    dependentPageId: edge.dependent_page_id,
    dependentTitle: dependent.title,
    dependentRevision: edge.dependent_revision,
    liveDependentRevision: liveDependent?.version ?? edge.dependent_revision,
    reviewerId: edge.reviewer_id,
    reviewerName: names.rows[0]?.name ?? "Reviewer",
    reviewerAuthority: authority,
    reviewState: effectiveReview({
      reviewState: edge.review_state,
      sourceRevision: edge.source_revision,
      acknowledgedSourceRevision: edge.acknowledged_source_revision,
      acknowledgedDependentRevision: edge.acknowledged_dependent_revision,
      liveDependentRevision: liveDependent?.version ?? edge.dependent_revision,
    }),
    reviewReason: edge.review_reason,
    note: edge.note,
    version: edge.version,
    sourceVersion: source.registry?.version ?? 1,
    access,
    recoverableDraft: draft.rows[0] ? { baseVersion: Number(draft.rows[0].base_version), note: draft.rows[0].note, reviewerId: draft.rows[0].reviewer_id } : null,
  };
}

async function shown(r: Repository, tx: Sql, actor: Actor, workspaceId: string, edgeId: string, role: string, manager: boolean) {
  const view = await present(r, tx, actor, workspaceId, edgeId, role, manager);
  if (!view) throw unavailable();
  return view;
}

async function requireEdge(r: Repository, tx: Sql, actor: Actor, workspaceId: string, edgeId: string, lock: boolean) {
  const role = await workspaceRole(tx, workspaceId, actor);
  const manager = await managerFlag(tx, workspaceId, actor, role);
  if (lock) await loadEdge(tx, workspaceId, edgeId, true);
  const view = await present(r, tx, actor, workspaceId, edgeId, role, manager);
  if (!view) throw unavailable();
  return { role, manager, view };
}

async function insertRevision(tx: Sql, edge: EdgeRow, version: number, action: string, actor: Actor, operationId: string, detail: Record<string, unknown>) {
  await tx.query(
    `INSERT INTO hs_dependency_edge_revisions(edge_id, version, action, source_revision, dependent_revision, reviewer_id, review_state, review_reason, note, detail, actor_id, operation_id)
     VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
    [edge.id, version, action, edge.source_revision, edge.dependent_revision, edge.reviewer_id, edge.review_state, edge.review_reason, edge.note, JSON.stringify(detail), actor.id, operationId],
  );
}

async function requireReviewer(tx: Sql, workspaceId: string, reviewerId: string) {
  const member = await activeMember(tx, workspaceId, reviewerId);
  if (!member) throw unavailable();
  if (member.role === "observer") throw new DocumentError("Observers cannot be responsible reviewers.", "read_only", 403);
  return member;
}

function cleanNote(note: string) {
  const value = note.trim();
  if (value.length > 2000) throw new DocumentError("Shorten the dependency note.", "dependency_note", 422);
  return value;
}

export async function listDependencyImpact(r: Repository, actor: Actor, workspaceId: string, query = "", pageId?: string | null) {
  return r.db.transaction(async tx => {
    const role = await workspaceRole(tx, workspaceId, actor);
    const manager = await managerFlag(tx, workspaceId, actor, role);
    const rows = await tx.query<{ id: string }>("SELECT id FROM hs_dependency_edges WHERE workspace_id=$1 ORDER BY updated_at DESC, id LIMIT 200", [workspaceId]);
    const needle = query.trim().toLocaleLowerCase();
    const edges = [];
    for (const row of rows.rows) {
      const view = await present(r, tx, actor, workspaceId, row.id, role, manager);
      if (!view) continue;
      if (pageId && view.dependentPageId !== pageId && view.sourceId !== pageId) continue;
      const haystack = `${view.kindLabel} ${view.sourceTitle} ${view.dependentTitle} ${view.note} ${view.reviewerName} ${view.reviewReason}`.toLocaleLowerCase();
      if (needle && !haystack.includes(needle)) continue;
      edges.push({ id: view.id, kind: view.kind, kindLabel: view.kindLabel, sourceId: view.sourceId, sourceTitle: view.sourceTitle, dependentPageId: view.dependentPageId, dependentTitle: view.dependentTitle, reviewState: view.reviewState, reviewReason: view.reviewReason, version: view.version });
    }
    const colleagues = await tx.query<{ id: string; name: string }>(
      "SELECT u.id, u.name FROM hs_members m JOIN hs_users u ON u.id=m.user_id WHERE m.workspace_id=$1 AND m.active=true AND m.role<>'observer' ORDER BY u.name, u.id",
      [workspaceId],
    );
    const current = pageId ? await readablePage(r, tx, actor, workspaceId, pageId) : null;
    return {
      manage: manager,
      edges,
      colleagues: colleagues.rows,
      currentPage: current ? { id: current.id, title: current.title, version: Number(current.version) } : null,
    };
  });
}

export async function readDependencyEdge(r: Repository, actor: Actor, workspaceId: string, edgeId: string) {
  return r.db.transaction(async tx => {
    const opened = await requireEdge(r, tx, actor, workspaceId, edgeId, false);
    return opened.view;
  });
}

export async function recordDependencyEdge(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; kind: DependencyKind; sourceId: string; sourceRevision: number; dependentPageId: string; reviewerId: string; note?: string }) {
  const note = cleanNote(input.note ?? "");
  const requestHash = digest({ action: "record", workspaceId, ...input, note });
  return r.db.transaction(async tx => {
    const authority = await requireManager(tx, workspaceId, actor);
    const prior = await priorOperation(tx, actor, input.operationId, requestHash);
    if (prior?.edgeId) return { ...(await shown(r, tx, actor, workspaceId, prior.edgeId, authority.role, true)), replayed: true };
    const source = await readSource(r, tx, actor, workspaceId, input.kind, input.sourceId, true);
    if (!source.exists || !source.readable || source.title === "Retired source") throw unavailable();
    const dependent = await readablePage(r, tx, actor, workspaceId, input.dependentPageId);
    if (!dependent) throw unavailable();
    if (!await provenance(tx, input.kind, input.sourceId, input.dependentPageId)) throw new DocumentError("Record an explicit link, template, snippet, or synced source before tracking it.", "provenance_required", 422);
    await requireReviewer(tx, workspaceId, input.reviewerId);
    const material = await revisionMaterial(tx, workspaceId, input.kind, input.sourceId, input.sourceRevision);
    if (!material) throw unavailable();
    const id = randomUUID();
    try {
      await tx.query(
        `INSERT INTO hs_dependency_edges(id, workspace_id, kind, source_id, source_revision, material_digest, dependent_page_id, dependent_revision, reviewer_id, note, created_by)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [id, workspaceId, input.kind, input.sourceId, input.sourceRevision, material, input.dependentPageId, Number(dependent.version), input.reviewerId, note, actor.id],
      );
    } catch (error) {
      if (typeof error === "object" && error && "code" in error && (error as { code?: string }).code === "23505") throw new DocumentError("This dependency is already recorded.", "dependency_exists", 409);
      throw error;
    }
    if (!source.registry) {
      await tx.query(
        `INSERT INTO hs_dependency_sources(workspace_id, kind, source_id, revision, material_digest, note) VALUES($1,$2,$3,$4,$5,'')`,
        [workspaceId, input.kind, input.sourceId, input.sourceRevision, material],
      );
    }
    const edge = await loadEdge(tx, workspaceId, id, true);
    await insertRevision(tx, edge, 1, "record", actor, input.operationId, { kind: input.kind });
    await audit(tx, actor, "dependency-impact.record", input.operationId, id, { workspaceId, kind: input.kind, sourceId: input.sourceId, sourceRevision: input.sourceRevision, dependentPageId: input.dependentPageId, reviewerId: input.reviewerId, version: 1 });
    await finish(tx, actor, input.operationId, requestHash, id, { id, version: 1 });
    return { ...(await shown(r, tx, actor, workspaceId, id, authority.role, true)), replayed: false };
  });
}

export async function saveDependencyEdge(r: Repository, actor: Actor, workspaceId: string, edgeId: string, input: { operationId: string; expectedVersion: number; note: string; reviewerId: string }) {
  const note = cleanNote(input.note);
  const requestHash = digest({ action: "save", workspaceId, edgeId, ...input, note });
  return r.db.transaction(async tx => {
    const opened = await requireEdge(r, tx, actor, workspaceId, edgeId, true);
    if (!opened.manager) throw opened.role === "observer" ? readOnly() : new DocumentError("Dependency management authority required", "management_required", 403);
    const prior = await priorOperation(tx, actor, input.operationId, requestHash);
    if (prior) return { ...(await shown(r, tx, actor, workspaceId, edgeId, opened.role, true)), replayed: true };
    const edge = await loadEdge(tx, workspaceId, edgeId, false);
    if (edge.version !== input.expectedVersion) throw conflict();
    await requireReviewer(tx, workspaceId, input.reviewerId);
    if (edge.note === note && edge.reviewer_id === input.reviewerId) {
      await finish(tx, actor, input.operationId, requestHash, edgeId, { id: edgeId, version: edge.version, unchanged: true });
      return { ...(await shown(r, tx, actor, workspaceId, edgeId, opened.role, true)), replayed: false, unchanged: true };
    }
    const reviewerChanged = edge.reviewer_id !== input.reviewerId;
    const version = edge.version + 1;
    const next: EdgeRow = {
      ...edge,
      note,
      reviewer_id: input.reviewerId,
      review_state: reviewerChanged ? "current" : edge.review_state,
      review_reason: reviewerChanged ? "" : edge.review_reason,
      acknowledged_source_revision: reviewerChanged ? null : edge.acknowledged_source_revision,
      acknowledged_dependent_revision: reviewerChanged ? null : edge.acknowledged_dependent_revision,
      version,
    };
    await tx.query(
      `UPDATE hs_dependency_edges SET note=$2, reviewer_id=$3, review_state=$4, review_reason=$5, acknowledged_source_revision=$6, acknowledged_dependent_revision=$7, acknowledged_at=CASE WHEN $8::boolean THEN NULL ELSE acknowledged_at END, version=$9, updated_at=clock_timestamp() WHERE id=$1`,
      [edgeId, note, input.reviewerId, next.review_state, next.review_reason, next.acknowledged_source_revision, next.acknowledged_dependent_revision, reviewerChanged, version],
    );
    await insertRevision(tx, next, version, "save", actor, input.operationId, { rule: unrelatedMetadataRule });
    await tx.query("DELETE FROM hs_dependency_drafts WHERE edge_id=$1 AND actor_id=$2", [edgeId, actor.id]);
    await audit(tx, actor, "dependency-impact.save", input.operationId, edgeId, { workspaceId, version, rule: unrelatedMetadataRule });
    await finish(tx, actor, input.operationId, requestHash, edgeId, { id: edgeId, version });
    return { ...(await shown(r, tx, actor, workspaceId, edgeId, opened.role, true)), replayed: false };
  });
}

export async function stashDependencyEdge(r: Repository, actor: Actor, workspaceId: string, edgeId: string, input: { operationId: string; expectedVersion: number; note: string; reviewerId: string }) {
  const note = cleanNote(input.note);
  const requestHash = digest({ action: "stash", workspaceId, edgeId, ...input, note });
  return r.db.transaction(async tx => {
    const opened = await requireEdge(r, tx, actor, workspaceId, edgeId, true);
    if (!opened.manager) throw opened.role === "observer" ? readOnly() : new DocumentError("Dependency management authority required", "management_required", 403);
    const prior = await priorOperation(tx, actor, input.operationId, requestHash);
    if (prior) return { ...(await shown(r, tx, actor, workspaceId, edgeId, opened.role, true)), replayed: true };
    const edge = await loadEdge(tx, workspaceId, edgeId, false);
    if (edge.version !== input.expectedVersion) throw conflict();
    await requireReviewer(tx, workspaceId, input.reviewerId);
    await tx.query(
      `INSERT INTO hs_dependency_drafts(edge_id, actor_id, base_version, note, reviewer_id, operation_id)
       VALUES($1,$2,$3,$4,$5,$6)
       ON CONFLICT (edge_id, actor_id) DO UPDATE SET base_version=EXCLUDED.base_version, note=EXCLUDED.note, reviewer_id=EXCLUDED.reviewer_id, operation_id=EXCLUDED.operation_id, updated_at=clock_timestamp()`,
      [edgeId, actor.id, edge.version, note, input.reviewerId, input.operationId],
    );
    await audit(tx, actor, "dependency-impact.stash", input.operationId, edgeId, { workspaceId, version: edge.version });
    await finish(tx, actor, input.operationId, requestHash, edgeId, { id: edgeId, version: edge.version, stashed: true });
    return { ...(await shown(r, tx, actor, workspaceId, edgeId, opened.role, true)), replayed: false };
  });
}

export async function discardDependencyDraft(r: Repository, actor: Actor, workspaceId: string, edgeId: string, operationId: string) {
  const requestHash = digest({ action: "discard-draft", workspaceId, edgeId, operationId });
  return r.db.transaction(async tx => {
    const opened = await requireEdge(r, tx, actor, workspaceId, edgeId, true);
    if (!opened.manager) throw opened.role === "observer" ? readOnly() : new DocumentError("Dependency management authority required", "management_required", 403);
    const prior = await priorOperation(tx, actor, operationId, requestHash);
    if (prior) return { ...(await shown(r, tx, actor, workspaceId, edgeId, opened.role, true)), replayed: true };
    await tx.query("DELETE FROM hs_dependency_drafts WHERE edge_id=$1 AND actor_id=$2", [edgeId, actor.id]);
    await audit(tx, actor, "dependency-impact.discard-draft", operationId, edgeId, { workspaceId });
    await finish(tx, actor, operationId, requestHash, edgeId, { id: edgeId, discarded: true });
    return { ...(await shown(r, tx, actor, workspaceId, edgeId, opened.role, true)), replayed: false };
  });
}

export async function acknowledgeDependency(r: Repository, actor: Actor, workspaceId: string, edgeId: string, input: { operationId: string; expectedVersion: number; sourceRevision: number; dependentRevision: number }) {
  const requestHash = digest({ action: "acknowledge", workspaceId, edgeId, ...input });
  return r.db.transaction(async tx => {
    const opened = await requireEdge(r, tx, actor, workspaceId, edgeId, true);
    if (opened.role === "observer") throw missingAuthority();
    const prior = await priorOperation(tx, actor, input.operationId, requestHash);
    if (prior) return { ...(await shown(r, tx, actor, workspaceId, edgeId, opened.role, opened.manager)), replayed: true };
    const edge = await loadEdge(tx, workspaceId, edgeId, false);
    if (edge.version !== input.expectedVersion) throw conflict();
    if (edge.reviewer_id !== actor.id || !opened.view.reviewerAuthority) throw missingAuthority();
    const dependent = await pageFact(tx, workspaceId, edge.dependent_page_id);
    if (input.sourceRevision !== edge.source_revision || input.dependentRevision !== dependent?.version) throw staleReview();
    if (edge.review_state === "acknowledged" && edge.acknowledged_source_revision === input.sourceRevision && edge.acknowledged_dependent_revision === input.dependentRevision) {
      await finish(tx, actor, input.operationId, requestHash, edgeId, { id: edgeId, version: edge.version, unchanged: true });
      return { ...(await shown(r, tx, actor, workspaceId, edgeId, opened.role, opened.manager)), replayed: false, unchanged: true };
    }
    const version = edge.version + 1;
    const next: EdgeRow = { ...edge, review_state: "acknowledged", review_reason: "", acknowledged_source_revision: input.sourceRevision, acknowledged_dependent_revision: input.dependentRevision, version };
    await tx.query(
      `UPDATE hs_dependency_edges SET review_state='acknowledged', review_reason='', acknowledged_source_revision=$2, acknowledged_dependent_revision=$3, acknowledged_at=clock_timestamp(), version=$4, updated_at=clock_timestamp() WHERE id=$1`,
      [edgeId, input.sourceRevision, input.dependentRevision, version],
    );
    await insertRevision(tx, next, version, "acknowledge", actor, input.operationId, { sourceRevision: input.sourceRevision, dependentRevision: input.dependentRevision });
    await audit(tx, actor, "dependency-impact.acknowledge", input.operationId, edgeId, { workspaceId, version, sourceRevision: input.sourceRevision, dependentRevision: input.dependentRevision });
    await finish(tx, actor, input.operationId, requestHash, edgeId, { id: edgeId, version });
    return { ...(await shown(r, tx, actor, workspaceId, edgeId, opened.role, opened.manager)), replayed: false };
  });
}

export async function reassignDependencyReviewer(r: Repository, actor: Actor, workspaceId: string, edgeId: string, input: { operationId: string; expectedVersion: number; reviewerId: string }) {
  const requestHash = digest({ action: "reassign", workspaceId, edgeId, ...input });
  return r.db.transaction(async tx => {
    const opened = await requireEdge(r, tx, actor, workspaceId, edgeId, true);
    if (!opened.manager) throw opened.role === "observer" ? readOnly() : new DocumentError("Dependency management authority required", "management_required", 403);
    const prior = await priorOperation(tx, actor, input.operationId, requestHash);
    if (prior) return { ...(await shown(r, tx, actor, workspaceId, edgeId, opened.role, true)), replayed: true };
    const edge = await loadEdge(tx, workspaceId, edgeId, false);
    if (edge.version !== input.expectedVersion) throw conflict();
    await requireReviewer(tx, workspaceId, input.reviewerId);
    if (edge.reviewer_id === input.reviewerId) {
      await finish(tx, actor, input.operationId, requestHash, edgeId, { id: edgeId, version: edge.version, unchanged: true });
      return { ...(await shown(r, tx, actor, workspaceId, edgeId, opened.role, true)), replayed: false, unchanged: true };
    }
    const version = edge.version + 1;
    const next: EdgeRow = { ...edge, reviewer_id: input.reviewerId, review_state: "current", review_reason: "", acknowledged_source_revision: null, acknowledged_dependent_revision: null, version };
    await tx.query(
      `UPDATE hs_dependency_edges SET reviewer_id=$2, review_state='current', review_reason='', acknowledged_source_revision=NULL, acknowledged_dependent_revision=NULL, acknowledged_at=NULL, version=$3, updated_at=clock_timestamp() WHERE id=$1`,
      [edgeId, input.reviewerId, version],
    );
    await insertRevision(tx, next, version, "reassign", actor, input.operationId, {});
    await audit(tx, actor, "dependency-impact.reassign", input.operationId, edgeId, { workspaceId, version, reviewerId: input.reviewerId });
    await finish(tx, actor, input.operationId, requestHash, edgeId, { id: edgeId, version });
    return { ...(await shown(r, tx, actor, workspaceId, edgeId, opened.role, true)), replayed: false };
  });
}

async function edgesForSource(tx: Sql, workspaceId: string, kind: DependencyKind, sourceId: string, lock: boolean) {
  const rows = await tx.query<EdgeRow>(
    `SELECT id, workspace_id, kind, source_id, source_revision, material_digest, dependent_page_id, dependent_revision, reviewer_id, review_state, review_reason, acknowledged_source_revision, acknowledged_dependent_revision, note, version FROM hs_dependency_edges WHERE workspace_id=$1 AND kind=$2 AND source_id=$3 ORDER BY id ${lock ? "FOR UPDATE" : ""}`,
    [workspaceId, kind, sourceId],
  );
  return rows.rows.map(row => ({
    ...row,
    source_revision: Number(row.source_revision),
    dependent_revision: Number(row.dependent_revision),
    acknowledged_source_revision: num(row.acknowledged_source_revision),
    acknowledged_dependent_revision: num(row.acknowledged_dependent_revision),
    version: Number(row.version),
  }));
}

async function requireSourceActor(r: Repository, tx: Sql, actor: Actor, workspaceId: string, kind: DependencyKind, sourceId: string, material: boolean) {
  const role = await workspaceRole(tx, workspaceId, actor);
  if (role === "observer") throw readOnly();
  const manager = await managerFlag(tx, workspaceId, actor, role);
  const source = await readSource(r, tx, actor, workspaceId, kind, sourceId, manager);
  if (!source.exists || !source.registry) throw unavailable();
  if (!source.readable) throw unavailable();
  if (!manager) {
    if (!(material && kind === "link" && await canEditPage(r, tx, actor, sourceId))) throw new DocumentError("Dependency management authority required", "management_required", 403);
  }
  return { role, manager, source };
}

type MaterialResult = { rule: string; marksReview: boolean; version: number; marked: EdgeView[]; replayed: boolean };
type MetadataResult = { rule: string; marksReview: boolean; version: number; replayed: boolean; unchanged?: boolean; note?: string };
type DownloadResult = { body: string; filename: string; contentType: string; included: string[]; replayed: boolean };

export async function noteDependencyMaterial(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; kind: DependencyKind; sourceId: string; sourceRevision: number; expectedVersion: number }): Promise<MaterialResult> {
  const requestHash = digest({ action: "note-material", workspaceId, ...input });
  return r.db.transaction(async tx => {
    const opened = await requireSourceActor(r, tx, actor, workspaceId, input.kind, input.sourceId, true);
    const prior = await priorOperation(tx, actor, input.operationId, requestHash);
    if (prior) {
      const ids = Array.isArray(prior.result.markedIds) ? prior.result.markedIds.map(String) : [];
      const marked: EdgeView[] = [];
      for (const id of ids) {
        const view = await present(r, tx, actor, workspaceId, id, opened.role, opened.manager);
        if (view) marked.push(view);
      }
      return { rule: String(prior.result.rule ?? ""), marksReview: Boolean(prior.result.marksReview), version: Number(prior.result.version), marked, replayed: true };
    }
    const source = await registry(tx, workspaceId, input.kind, input.sourceId, true);
    if (!source || source.version !== input.expectedVersion) throw conflict();
    const material = await revisionMaterial(tx, workspaceId, input.kind, input.sourceId, input.sourceRevision);
    if (!material) throw unavailable();
    const edges = await edgesForSource(tx, workspaceId, input.kind, input.sourceId, true);
    const affected = edges.filter(edge => classifySourceEdit(edge.material_digest, material).marksReview);
    const sourceChanged = classifySourceEdit(source.material_digest, material).marksReview;
    if (!sourceChanged && !affected.length) {
      await audit(tx, actor, "dependency-impact.metadata", input.operationId, null, { workspaceId, kind: input.kind, sourceId: input.sourceId, rule: unrelatedMetadataRule });
      const result = { rule: unrelatedMetadataRule, marksReview: false, version: source.version, markedIds: [] as string[] };
      await finish(tx, actor, input.operationId, requestHash, null, result);
      return { rule: result.rule, marksReview: false, version: result.version, marked: [], replayed: false };
    }
    const reason = `Source material changed at revision ${input.sourceRevision}`;
    const version = source.version + 1;
    await tx.query(
      "UPDATE hs_dependency_sources SET revision=$4, material_digest=$5, version=$6, updated_at=clock_timestamp() WHERE workspace_id=$1 AND kind=$2 AND source_id=$3",
      [workspaceId, input.kind, input.sourceId, input.sourceRevision, material, version],
    );
    const markedIds: string[] = [];
    for (const edge of affected) {
      const edgeVersion = edge.version + 1;
      const next: EdgeRow = { ...edge, source_revision: input.sourceRevision, material_digest: material, review_state: "needs_review", review_reason: reason, acknowledged_source_revision: null, acknowledged_dependent_revision: null, version: edgeVersion };
      await tx.query(
        `UPDATE hs_dependency_edges SET source_revision=$2, material_digest=$3, review_state='needs_review', review_reason=$4, acknowledged_source_revision=NULL, acknowledged_dependent_revision=NULL, acknowledged_at=NULL, version=$5, updated_at=clock_timestamp() WHERE id=$1`,
        [edge.id, input.sourceRevision, material, reason, edgeVersion],
      );
      await insertRevision(tx, next, edgeVersion, "material", actor, input.operationId, { rule: "source-material-changed" });
      const visible = await present(r, tx, actor, workspaceId, edge.id, opened.role, opened.manager);
      if (visible) {
        markedIds.push(edge.id);
        await audit(tx, actor, "dependency-impact.material", input.operationId, edge.id, { workspaceId, version: edgeVersion, sourceRevision: input.sourceRevision, rule: "source-material-changed", dependentPageId: edge.dependent_page_id });
      } else {
        await audit(tx, actor, "dependency-impact.material", input.operationId, edge.id, { workspaceId, version: edgeVersion, sourceRevision: input.sourceRevision, rule: "source-material-changed", hidden: true });
      }
    }
    const result = { rule: "source-material-changed", marksReview: true, version, markedIds };
    await finish(tx, actor, input.operationId, requestHash, null, result);
    const marked = [];
    for (const id of markedIds) {
      const view = await present(r, tx, actor, workspaceId, id, opened.role, opened.manager);
      if (view) marked.push(view);
    }
    return { rule: "source-material-changed", marksReview: true, version, marked, replayed: false };
  });
}

export async function noteDependencyMetadata(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; kind: DependencyKind; sourceId: string; note: string; expectedVersion: number }): Promise<MetadataResult> {
  const note = cleanNote(input.note);
  const requestHash = digest({ action: "note-metadata", workspaceId, ...input, note });
  return r.db.transaction(async tx => {
    await requireSourceActor(r, tx, actor, workspaceId, input.kind, input.sourceId, false);
    const prior = await priorOperation(tx, actor, input.operationId, requestHash);
    if (prior) return { rule: String(prior.result.rule ?? unrelatedMetadataRule), marksReview: false, version: Number(prior.result.version), replayed: true, unchanged: Boolean(prior.result.unchanged), note: typeof prior.result.note === "string" ? prior.result.note : undefined };
    const source = await registry(tx, workspaceId, input.kind, input.sourceId, true);
    if (!source || source.version !== input.expectedVersion) throw conflict();
    if (source.note === note) {
      const result = { rule: unrelatedMetadataRule, marksReview: false, version: source.version, unchanged: true };
      await finish(tx, actor, input.operationId, requestHash, null, result);
      return { ...result, replayed: false };
    }
    const version = source.version + 1;
    await tx.query(
      "UPDATE hs_dependency_sources SET note=$4, version=$5, updated_at=clock_timestamp() WHERE workspace_id=$1 AND kind=$2 AND source_id=$3",
      [workspaceId, input.kind, input.sourceId, note, version],
    );
    await audit(tx, actor, "dependency-impact.metadata", input.operationId, null, { workspaceId, kind: input.kind, sourceId: input.sourceId, version, rule: unrelatedMetadataRule });
    const result = { rule: unrelatedMetadataRule, marksReview: false, version, note };
    await finish(tx, actor, input.operationId, requestHash, null, result);
    return { ...result, replayed: false };
  });
}

async function setSourceState(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; kind: DependencyKind; sourceId: string; expectedVersion: number; state: "retired" | "merged"; mergedIntoId?: string | null }) {
  const requestHash = digest({ action: input.state, workspaceId, ...input });
  return r.db.transaction(async tx => {
    const opened = await requireSourceActor(r, tx, actor, workspaceId, input.kind, input.sourceId, false);
    const prior = await priorOperation(tx, actor, input.operationId, requestHash);
    if (prior) return { ...prior.result, replayed: true };
    const source = await registry(tx, workspaceId, input.kind, input.sourceId, true);
    if (!source || source.version !== input.expectedVersion) throw conflict();
    let mergedIntoId: string | null = null;
    if (input.state === "merged") {
      mergedIntoId = input.mergedIntoId ?? null;
      if (!mergedIntoId || mergedIntoId === input.sourceId) throw unavailable();
      const target = await readSource(r, tx, actor, workspaceId, input.kind, mergedIntoId, opened.manager);
      if (!target.exists || !target.readable) throw unavailable();
    }
    if (source.state === input.state && (source.merged_into_id ?? null) === mergedIntoId) {
      const result = { state: input.state, version: source.version, unchanged: true };
      await finish(tx, actor, input.operationId, requestHash, null, result);
      return { ...result, replayed: false };
    }
    const version = source.version + 1;
    await tx.query(
      "UPDATE hs_dependency_sources SET state=$4, merged_into_id=$5, version=$6, updated_at=clock_timestamp() WHERE workspace_id=$1 AND kind=$2 AND source_id=$3",
      [workspaceId, input.kind, input.sourceId, input.state, mergedIntoId, version],
    );
    const edges = await edgesForSource(tx, workspaceId, input.kind, input.sourceId, true);
    for (const edge of edges) {
      const visible = await present(r, tx, actor, workspaceId, edge.id, opened.role, opened.manager);
      await audit(tx, actor, `dependency-impact.${input.state}`, input.operationId, edge.id, visible
        ? { workspaceId, version, state: input.state, dependentPageId: edge.dependent_page_id }
        : { workspaceId, version, state: input.state, hidden: true });
    }
    await audit(tx, actor, `dependency-impact.${input.state}`, input.operationId, null, { workspaceId, kind: input.kind, sourceId: input.sourceId, version, state: input.state });
    const result = { state: input.state, version, unchanged: false };
    await finish(tx, actor, input.operationId, requestHash, null, result);
    return { ...result, replayed: false };
  });
}

export function retireDependencySource(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; kind: DependencyKind; sourceId: string; expectedVersion: number }) {
  return setSourceState(r, actor, workspaceId, { ...input, state: "retired", mergedIntoId: null });
}

export function mergeDependencySource(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; kind: DependencyKind; sourceId: string; expectedVersion: number; mergedIntoId: string }) {
  return setSourceState(r, actor, workspaceId, { ...input, state: "merged" });
}

async function impactGraph(r: Repository, tx: Sql, actor: Actor, workspaceId: string, input: { kind?: DependencyKind; sourceId?: string; pageId?: string; limit?: number }) {
  const role = await workspaceRole(tx, workspaceId, actor);
  const manager = await managerFlag(tx, workspaceId, actor, role);
  if (input.sourceId) {
    if (!input.kind) throw unavailable();
    const source = await readSource(r, tx, actor, workspaceId, input.kind, input.sourceId, manager);
    if (!source.exists || !source.readable) throw unavailable();
  } else if (input.pageId) {
    if (!await readablePage(r, tx, actor, workspaceId, input.pageId)) throw unavailable();
  } else throw unavailable();
  const rows = await tx.query<{ id: string }>("SELECT id FROM hs_dependency_edges WHERE workspace_id=$1 ORDER BY id", [workspaceId]);
  const edges: PlanEdge[] = [];
  const sources: Record<string, PlanSource> = {};
  const views = new Map<string, EdgeView>();
  for (const row of rows.rows) {
    const view = await present(r, tx, actor, workspaceId, row.id, role, manager);
    if (!view) continue;
    if (input.kind && view.kind !== input.kind) continue;
    views.set(view.id, view);
    edges.push({ id: view.id, kind: view.kind, sourceId: view.sourceId, dependentPageId: view.dependentPageId, sourceState: view.sourceState, permitted: true });
    const stored = await registry(tx, workspaceId, view.kind, view.sourceId, false);
    sources[view.sourceId] = { state: view.sourceState, mergedIntoId: view.mergedIntoId };
    if (stored?.merged_into_id && view.mergedIntoId) sources[view.sourceId] = { state: "merged", mergedIntoId: view.mergedIntoId };
  }
  if (input.sourceId && input.kind && !sources[input.sourceId]) {
    const source = await readSource(r, tx, actor, workspaceId, input.kind, input.sourceId, manager);
    sources[input.sourceId] = { state: source.lifecycle, mergedIntoId: source.lifecycle === "merged" && source.registry?.merged_into_id ? (await readSource(r, tx, actor, workspaceId, input.kind, source.registry.merged_into_id, manager)).readable ? source.registry.merged_into_id : null : null };
  }
  const traversed = traverseDependencies({
    start: input.sourceId ? { type: "source", id: input.sourceId } : { type: "page", id: input.pageId! },
    edges,
    sources,
    limit: input.limit ?? 50,
  });
  return { traversed, views, role, manager };
}

export async function traverseDependencyImpact(r: Repository, actor: Actor, workspaceId: string, input: { kind?: DependencyKind; sourceId?: string; pageId?: string; limit?: number }) {
  return r.db.transaction(async tx => {
    const { traversed, views } = await impactGraph(r, tx, actor, workspaceId, input);
    return {
      pages: traversed.pages,
      truncated: traversed.truncated,
      edges: traversed.edges.map(edge => {
        const view = views.get(edge.id)!;
        return {
          id: edge.id,
          kind: edge.kind,
          kindLabel: view.kindLabel,
          sourceId: view.sourceId,
          sourceTitle: view.sourceTitle,
          sourceRevision: view.sourceRevision,
          dependentPageId: view.dependentPageId,
          dependentTitle: view.dependentTitle,
          sourceState: edge.sourceState,
          cycle: edge.cycle,
          reviewState: view.reviewState,
          reviewReason: view.reviewReason,
        };
      }),
    };
  });
}

export async function previewDependencyImpact(r: Repository, actor: Actor, workspaceId: string, input: { kind?: DependencyKind; sourceId?: string; pageId?: string; limit?: number }) {
  const impact = await traverseDependencyImpact(r, actor, workspaceId, input);
  return {
    items: impact.edges.map(edge => ({
      ...edge,
      reviewLabel: reviewLabel(edge.reviewState),
    })),
    truncated: impact.truncated,
    pages: impact.pages,
  };
}

export async function downloadDependencyImpact(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; expectedVersion: number; kind?: DependencyKind; sourceId?: string; pageId?: string; limit?: number }): Promise<DownloadResult> {
  const requestHash = digest({ action: "download", workspaceId, ...input });
  return r.db.transaction(async tx => {
    const prior = await priorOperation(tx, actor, input.operationId, requestHash);
    if (prior) return { body: String(prior.result.body ?? ""), filename: String(prior.result.filename ?? "dependency-impact.md"), contentType: String(prior.result.contentType ?? "text/markdown"), included: Array.isArray(prior.result.included) ? prior.result.included.map(String) : [], replayed: true };
    if (input.sourceId) {
      if (!input.kind) throw unavailable();
      const role = await workspaceRole(tx, workspaceId, actor);
      const manager = await managerFlag(tx, workspaceId, actor, role);
      const source = await readSource(r, tx, actor, workspaceId, input.kind, input.sourceId, manager);
      if (!source.readable || !source.registry || source.registry.version !== input.expectedVersion) throw source.registry && source.readable ? conflict() : unavailable();
    } else if (input.pageId) {
      const page = await readablePage(r, tx, actor, workspaceId, input.pageId);
      if (!page || Number(page.version) !== input.expectedVersion) throw page ? conflict() : unavailable();
    } else throw unavailable();
    const { traversed, views } = await impactGraph(r, tx, actor, workspaceId, input);
    const items = traversed.edges.map(edge => {
      const view = views.get(edge.id)!;
      return { kind: view.kind, sourceTitle: view.sourceTitle, sourceRevision: view.sourceRevision, dependentTitle: view.dependentTitle, reviewLabel: reviewLabel(view.reviewState), reason: view.reviewReason, sourceState: edge.sourceState };
    });
    const body = impactReport(items);
    await audit(tx, actor, "dependency-impact.download", input.operationId, null, { workspaceId, included: traversed.edges.map(edge => edge.id) });
    const result = { body, filename: "dependency-impact.md", contentType: "text/markdown", included: traversed.edges.map(edge => edge.id) };
    await finish(tx, actor, input.operationId, requestHash, null, result);
    return { ...result, replayed: false };
  });
}

export async function dependencyHistory(r: Repository, actor: Actor, workspaceId: string, edgeId: string) {
  return r.db.transaction(async tx => {
    await requireEdge(r, tx, actor, workspaceId, edgeId, false);
    const rows = await tx.query<{ actor_id: string; name: string; action: string; after_value: { source?: string; atIst?: string; operationId?: string } | string; correlation_id: string; created_at: string }>(
      `SELECT a.actor_id, u.name, a.action, a.after_value, a.correlation_id, a.created_at
       FROM hs_audit a JOIN hs_users u ON u.id=a.actor_id
       WHERE a.subject_id=$1 AND a.action LIKE 'dependency-impact.%'
       ORDER BY a.created_at, a.id`,
      [edgeId],
    );
    return {
      events: rows.rows.map(row => {
        const after = asJson(row.after_value);
        return { actorId: row.actor_id, actorName: row.name, action: row.action, atIst: after.atIst ?? formatIst(row.created_at), source: after.source ?? "dependency-impact", operationId: after.operationId ?? row.correlation_id };
      }),
    };
  });
}

export async function grantDependencyManager(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; userId: string }) {
  const requestHash = digest({ action: "grant-manager", workspaceId, ...input });
  return r.db.transaction(async tx => {
    const authority = await requireManager(tx, workspaceId, actor);
    if (!authority.native) throw new DocumentError("A native workspace administrator must appoint dependency managers.", "management_required", 403);
    const prior = await priorOperation(tx, actor, input.operationId, requestHash);
    if (prior) return { ...prior.result, replayed: true };
    const member = await activeMember(tx, workspaceId, input.userId);
    if (!member) throw unavailable();
    if (member.role === "observer") throw new DocumentError("Observers cannot manage dependency impact.", "read_only", 403);
    await tx.query("INSERT INTO hs_dependency_managers(workspace_id, user_id, granted_by) VALUES($1,$2,$3) ON CONFLICT DO NOTHING", [workspaceId, input.userId, actor.id]);
    const result = { userId: input.userId, granted: true };
    await audit(tx, actor, "dependency-impact.grant-manager", input.operationId, null, { workspaceId, userId: input.userId });
    await finish(tx, actor, input.operationId, requestHash, null, result);
    return { ...result, replayed: false };
  });
}

export async function revokeDependencyManager(r: Repository, actor: Actor, workspaceId: string, input: { operationId: string; userId: string }) {
  const requestHash = digest({ action: "revoke-manager", workspaceId, ...input });
  return r.db.transaction(async tx => {
    const authority = await requireManager(tx, workspaceId, actor);
    if (!authority.native) throw new DocumentError("A native workspace administrator must appoint dependency managers.", "management_required", 403);
    const prior = await priorOperation(tx, actor, input.operationId, requestHash);
    if (prior) return { ...prior.result, replayed: true };
    if (!await activeMember(tx, workspaceId, input.userId)) throw unavailable();
    const removed = await tx.query("DELETE FROM hs_dependency_managers WHERE workspace_id=$1 AND user_id=$2 RETURNING user_id", [workspaceId, input.userId]);
    const result = { userId: input.userId, revoked: removed.rows.length > 0 };
    if (removed.rows.length) await audit(tx, actor, "dependency-impact.revoke-manager", input.operationId, null, { workspaceId, userId: input.userId });
    await finish(tx, actor, input.operationId, requestHash, null, result);
    return { ...result, replayed: false };
  });
}

export function parseDependencyKind(value: string | null) {
  if (!value) return undefined;
  if (!isDependencyKind(value)) throw unavailable();
  return value;
}
