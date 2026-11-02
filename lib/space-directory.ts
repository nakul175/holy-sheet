import { createHash, randomUUID } from "node:crypto";
import type { Actor } from "./auth";
import type { Sql } from "./database";
import { DocumentError, stableStringify } from "./document";
import { formatIst } from "./ist-label";
import { hierarchyRole, pageSubtree, type HierarchyGrant, type HierarchyMember, type HierarchyNode } from "./page-organisation";
import { retargetPublishedPages } from "./published-pages";
import type { Repository } from "./repository";
import type { PageRole } from "./types";
import {
  SPACE_UNAVAILABLE,
  type AccessChange,
  type DirectoryAction,
  type DirectorySpace,
  type DirectoryView,
  type MigrationJob,
  type MigrationPreview,
  type PersonRef,
  type SpaceVisibility,
} from "./space-directory-shared";

export {
  SPACE_ARCHIVED_BANNER,
  SPACE_UNAVAILABLE,
  type AccessChange,
  type DirectorySpace,
  type DirectoryView,
  type MigrationJob,
  type MigrationPreview,
  type SpaceVisibility,
} from "./space-directory-shared";

const hidden = () => new DocumentError(SPACE_UNAVAILABLE, "not_found", 404);
const mismatch = () => new DocumentError("This attempt was reused with different fields.", "operation_mismatch", 409);
const conflict = () => new DocumentError("The page tree changed. Review the move again.", "move_conflict", 409);
const archivedError = () => new DocumentError("This space is archived and read-only", "read_only", 403);
const confirmAccess = () => new DocumentError("Review and confirm who gains access before moving the tree.", "access_confirmation_required", 422);
const hash = (value: unknown) => createHash("sha256").update(stableStringify(value)).digest("hex");
const rank = (role: string | null) => (role === "viewer" ? 1 : role === "commenter" ? 2 : role === "editor" ? 3 : role === "owner" ? 4 : 0);

type MemberRow = { role: string };
type SpaceRow = {
  id: string;
  name: string;
  visibility: SpaceVisibility;
  archived_at: string | null;
  space_role: string | null;
  request_pending: boolean;
};

function asIds(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") return JSON.parse(value) as string[];
  return [];
}

function asObject<T>(value: unknown): T {
  if (typeof value === "string") return JSON.parse(value) as T;
  return value as T;
}

async function membership(tx: Sql, workspaceId: string, actor: Actor, lock = false) {
  const rows = await tx.query<MemberRow>(
    `SELECT m.role FROM hs_workspaces w JOIN hs_members m ON m.workspace_id = w.id AND m.user_id = $2 AND m.active = true WHERE w.id = $1 ${lock ? "FOR UPDATE OF w, m" : ""}`,
    [workspaceId, actor.id],
  );
  return rows.rows[0] ?? null;
}

function administers(role: string | undefined) {
  return role === "owner" || role === "admin";
}

async function audit(tx: Sql, actorId: string, action: string, operationId: string, after: Record<string, unknown>, pageId: string | null = null) {
  await tx.query(
    "INSERT INTO hs_audit(id, actor_id, action, page_id, after_value, correlation_id) VALUES($1,$2,$3,$4,$5::jsonb,$6)",
    [randomUUID(), actorId, action, pageId, JSON.stringify({ ...after, atIst: formatIst(new Date()) }), operationId],
  );
}

async function replayDirectory<T>(tx: Sql, workspaceId: string, actor: Actor, operationId: string, requestHash: string): Promise<T | null> {
  const prior = await tx.query<{ actor_id: string; request_hash: string; result: T }>(
    "SELECT actor_id, request_hash, result FROM hs_space_directory_operations WHERE workspace_id = $1 AND operation_id = $2",
    [workspaceId, operationId],
  );
  const row = prior.rows[0];
  if (!row) return null;
  if (row.actor_id !== actor.id || row.request_hash !== requestHash) throw mismatch();
  return { ...asObject<T>(row.result), replayed: true };
}

async function rememberDirectory(tx: Sql, workspaceId: string, actor: Actor, operationId: string, requestHash: string, result: unknown) {
  await tx.query(
    "INSERT INTO hs_space_directory_operations(workspace_id, operation_id, actor_id, request_hash, result) VALUES($1,$2,$3,$4,$5::jsonb)",
    [workspaceId, operationId, actor.id, requestHash, JSON.stringify(result)],
  );
}

async function visibleSpace(tx: Sql, workspaceId: string, spaceId: string, actor: Actor, lock = false) {
  const member = await membership(tx, workspaceId, actor, lock);
  if (!member) throw hidden();
  const rows = await tx.query<{ id: string; directory_visibility: SpaceVisibility; archived_at: string | null; workspace_role: string; space_role: string | null }>(
    `SELECT s.id, s.directory_visibility, s.archived_at, m.role AS workspace_role, sm.role AS space_role
     FROM hs_spaces s
     JOIN hs_members m ON m.workspace_id = s.workspace_id AND m.user_id = $3 AND m.active = true
     LEFT JOIN hs_space_members sm ON sm.space_id = s.id AND sm.user_id = $3 AND sm.active = true
     WHERE s.id = $1 AND s.workspace_id = $2 ${lock ? "FOR UPDATE OF s" : ""}`,
    [spaceId, workspaceId, actor.id],
  );
  const row = rows.rows[0];
  if (!row) throw hidden();
  const allowed = row.directory_visibility !== "private" || Boolean(row.space_role) || administers(row.workspace_role);
  if (!allowed) throw hidden();
  return { ...row, admin: administers(row.workspace_role) };
}

export async function listSpaceDirectory(r: Repository, actor: Actor, workspaceId: string, includeArchived = false): Promise<DirectoryView> {
  if (!workspaceId || workspaceId.length > 200) throw hidden();
  return r.db.transaction(async tx => {
    const member = await membership(tx, workspaceId, actor);
    if (!member) throw hidden();
    const admin = administers(member.role);
    const rows = await tx.query<SpaceRow>(
      `SELECT s.id, s.name, s.directory_visibility AS visibility, s.archived_at, sm.role AS space_role,
        EXISTS(SELECT 1 FROM hs_space_access_requests q WHERE q.space_id = s.id AND q.user_id = $2 AND q.state = 'pending') AS request_pending
       FROM hs_spaces s
       LEFT JOIN hs_space_members sm ON sm.space_id = s.id AND sm.user_id = $2 AND sm.active = true
       WHERE s.workspace_id = $1 AND ($3::boolean OR s.archived_at IS NULL)
       ORDER BY s.name, s.id`,
      [workspaceId, actor.id, includeArchived],
    );
    const spaces: DirectorySpace[] = [];
    for (const row of rows.rows) {
      const isMember = Boolean(row.space_role);
      if (row.visibility === "private" && !isMember && !admin) continue;
      let action: DirectoryAction = "open";
      if (!isMember && !admin) action = row.visibility === "discoverable" ? "request" : "join";
      spaces.push({
        id: row.id,
        name: row.name,
        visibility: row.visibility,
        archived: Boolean(row.archived_at),
        archivedAtIst: row.archived_at ? formatIst(row.archived_at) : null,
        action,
        requestPending: Boolean(row.request_pending),
      });
    }
    return { workspaceId, canAdminister: admin, includeArchived, spaces };
  });
}

export async function readSpaceBySlug(r: Repository, actor: Actor, slug: string, workspaceId: string | null) {
  if (!slug || slug.length > 80) throw hidden();
  return r.db.transaction(async tx => {
    const rows = await tx.query<{ id: string; name: string; workspace_id: string; directory_visibility: SpaceVisibility; archived_at: string | null; workspace_role: string; space_role: string | null }>(
      `SELECT s.id, s.name, s.workspace_id, s.directory_visibility, s.archived_at, m.role AS workspace_role, sm.role AS space_role
       FROM hs_spaces s
       JOIN hs_members m ON m.workspace_id = s.workspace_id AND m.user_id = $1 AND m.active = true
       LEFT JOIN hs_space_members sm ON sm.space_id = s.id AND sm.user_id = $1 AND sm.active = true
       WHERE s.slug = $2 AND ($3::text IS NULL OR s.workspace_id = $3)`,
      [actor.id, slug, workspaceId],
    );
    const visible = rows.rows.filter(row => {
      const allowed = row.directory_visibility !== "private" || Boolean(row.space_role) || administers(row.workspace_role);
      if (!allowed) return false;
      if (row.archived_at && !row.space_role && !administers(row.workspace_role)) return false;
      return true;
    });
    if (visible.length !== 1) throw hidden();
    const row = visible[0];
    return {
      id: row.id,
      name: row.name,
      workspaceId: row.workspace_id,
      visibility: row.directory_visibility,
      archived: Boolean(row.archived_at),
      archivedAtIst: row.archived_at ? formatIst(row.archived_at) : null,
    };
  });
}

async function mutateDirectory<T>(r: Repository, actor: Actor, workspaceId: string, operationId: string, command: unknown, apply: (tx: Sql) => Promise<T>) {
  if (!workspaceId || workspaceId.length > 200 || !operationId) throw hidden();
  const requestHash = hash(command);
  return r.db.transaction(async tx => {
    const prior = await replayDirectory<T & { replayed?: boolean }>(tx, workspaceId, actor, operationId, requestHash);
    if (prior) return prior;
    const result = await apply(tx);
    const stored = { ...result, replayed: false };
    await rememberDirectory(tx, workspaceId, actor, operationId, requestHash, stored);
    return stored;
  });
}

export async function joinSpace(r: Repository, actor: Actor, workspaceId: string, spaceId: string, operationId: string) {
  return mutateDirectory(r, actor, workspaceId, operationId, { action: "join", spaceId }, async tx => {
    const space = await visibleSpace(tx, workspaceId, spaceId, actor, true);
    if (space.archived_at && !space.space_role && !space.admin) throw hidden();
    if (space.archived_at || space.directory_visibility !== "open") throw hidden();
    if (!space.space_role) {
      await tx.query(
        `INSERT INTO hs_space_members(space_id, user_id, role, granted_by) VALUES($1,$2,'viewer',$3)
         ON CONFLICT(space_id, user_id) DO UPDATE SET role = 'viewer', active = true, version = hs_space_members.version + 1, granted_by = EXCLUDED.granted_by, updated_at = clock_timestamp()`,
        [spaceId, actor.id, actor.id],
      );
    }
    await audit(tx, actor.id, "space.join", operationId, { spaceId, workspaceId });
    return { spaceId, action: "open" as const };
  });
}

export async function requestSpaceAccess(r: Repository, actor: Actor, workspaceId: string, spaceId: string, operationId: string) {
  return mutateDirectory(r, actor, workspaceId, operationId, { action: "request-access", spaceId }, async tx => {
    const space = await visibleSpace(tx, workspaceId, spaceId, actor, true);
    if (space.archived_at && !space.space_role && !space.admin) throw hidden();
    if (space.directory_visibility !== "discoverable" || space.archived_at || space.space_role) throw hidden();
    const pending = await tx.query("SELECT id FROM hs_space_access_requests WHERE space_id = $1 AND user_id = $2 AND state = 'pending'", [spaceId, actor.id]);
    if (!pending.rows.length) {
      await tx.query(
        "INSERT INTO hs_space_access_requests(id, space_id, user_id, workspace_id, state, operation_id) VALUES($1,$2,$3,$4,'pending',$5)",
        [randomUUID(), spaceId, actor.id, workspaceId, operationId],
      );
    }
    await audit(tx, actor.id, "space.request-access", operationId, { spaceId, workspaceId });
    return { spaceId, requestPending: true };
  });
}

export async function setSpaceVisibility(r: Repository, actor: Actor, workspaceId: string, spaceId: string, visibility: SpaceVisibility, operationId: string) {
  return mutateDirectory(r, actor, workspaceId, operationId, { action: "visibility", spaceId, visibility }, async tx => {
    const member = await membership(tx, workspaceId, actor, true);
    if (!member || !administers(member.role)) throw hidden();
    const rows = await tx.query<{ directory_visibility: SpaceVisibility }>(
      "SELECT directory_visibility FROM hs_spaces WHERE id = $1 AND workspace_id = $2 FOR UPDATE",
      [spaceId, workspaceId],
    );
    if (!rows.rows[0] || !["open", "discoverable", "private"].includes(visibility)) throw hidden();
    const before = rows.rows[0].directory_visibility;
    if (before !== visibility) await tx.query("UPDATE hs_spaces SET directory_visibility = $2 WHERE id = $1", [spaceId, visibility]);
    await audit(tx, actor.id, "space.visibility", operationId, { spaceId, workspaceId, visibility });
    return { spaceId, visibility };
  });
}

export async function archiveSpace(r: Repository, actor: Actor, workspaceId: string, spaceId: string, operationId: string, archived: boolean) {
  return mutateDirectory(r, actor, workspaceId, operationId, { action: archived ? "archive" : "unarchive", spaceId }, async tx => {
    const member = await membership(tx, workspaceId, actor, true);
    if (!member || !administers(member.role)) throw hidden();
    const rows = await tx.query<{ archived_at: string | null }>("SELECT archived_at FROM hs_spaces WHERE id = $1 AND workspace_id = $2 FOR UPDATE", [spaceId, workspaceId]);
    if (!rows.rows[0]) throw hidden();
    const stamp = archived ? rows.rows[0].archived_at ?? new Date().toISOString() : null;
    await tx.query("UPDATE hs_spaces SET archived_at = $2 WHERE id = $1", [spaceId, archived ? stamp : null]);
    await audit(tx, actor.id, archived ? "space.archive" : "space.unarchive", operationId, { spaceId, workspaceId, archived });
    return { spaceId, archived, archivedAtIst: stamp ? formatIst(stamp) : null };
  });
}

type LoadedTree = {
  workspaceId: string;
  nodes: Map<string, HierarchyNode>;
  list: HierarchyNode[];
  members: HierarchyMember[];
  grants: Map<string, HierarchyGrant[]>;
  treeVersion: number;
};

async function loadTree(tx: Sql, workspaceId: string, actor: Actor): Promise<LoadedTree> {
  const member = await membership(tx, workspaceId, actor, true);
  if (!member || !administers(member.role)) throw hidden();
  const version = await tx.query<{ tree_version: number }>("SELECT tree_version FROM hs_workspaces WHERE id = $1", [workspaceId]);
  const pages = await tx.query<HierarchyNode>(
    "SELECT id, workspace_id, space_id, parent_id, owner_id, visibility, title, version, acl_version, position, deleted_at FROM hs_pages WHERE workspace_id = $1 ORDER BY position, id LIMIT 1001",
    [workspaceId],
  );
  const people = await tx.query<HierarchyMember>(
    "SELECT u.id, u.name, m.role, m.active FROM hs_members m JOIN hs_users u ON u.id = m.user_id WHERE m.workspace_id = $1 ORDER BY u.id LIMIT 501",
    [workspaceId],
  );
  if (pages.rows.length > 1000 || people.rows.length > 500) throw new DocumentError("This release supports moves in workspaces with up to 1,000 pages and 500 members.", "move_limit", 422);
  const grantRows = await tx.query<HierarchyGrant>(
    "SELECT g.page_id, g.subject, g.role FROM hs_grants g JOIN hs_pages p ON p.id = g.page_id WHERE p.workspace_id = $1",
    [workspaceId],
  );
  const grants = new Map<string, HierarchyGrant[]>();
  for (const grant of grantRows.rows) grants.set(grant.page_id, [...(grants.get(grant.page_id) ?? []), grant]);
  return {
    workspaceId,
    nodes: new Map(pages.rows.map(page => [page.id, page])),
    list: pages.rows,
    members: people.rows,
    grants,
    treeVersion: version.rows[0]?.tree_version ?? 1,
  };
}

function orderedSubtree(nodes: HierarchyNode[], rootId: string) {
  const ids = pageSubtree(nodes, rootId);
  const ordered: HierarchyNode[] = [];
  const seen = new Set<string>();
  const walk = (id: string) => {
    if (seen.has(id) || !ids.has(id)) return;
    seen.add(id);
    const node = nodes.find(item => item.id === id);
    if (!node) return;
    ordered.push(node);
    nodes.filter(item => item.parent_id === id && ids.has(item.id)).sort((a, b) => a.position - b.position || a.id.localeCompare(b.id)).forEach(child => walk(child.id));
  };
  walk(rootId);
  return ordered;
}

async function brokenReferences(tx: Sql, workspaceId: string, ids: string[]) {
  if (!ids.length) return 0;
  const links = await tx.query<{ target: string | null }>(
    "SELECT node->'attrs'->>'pageId' AS target FROM hs_blocks WHERE type = 'pageLink' AND page_id = ANY($1::text[])",
    [ids],
  );
  const inside = new Set(ids);
  const outside = [...new Set(links.rows.map(row => row.target ?? "").filter(target => target && !inside.has(target)))];
  const found = new Map<string, { workspace_id: string; deleted_at: string | null }>();
  if (outside.length) {
    const rows = await tx.query<{ id: string; workspace_id: string; deleted_at: string | null }>(
      "SELECT id, workspace_id, deleted_at FROM hs_pages WHERE id = ANY($1::text[])",
      [outside],
    );
    for (const row of rows.rows) found.set(row.id, row);
  }
  let count = 0;
  for (const row of links.rows) {
    const target = row.target ?? "";
    if (!target || inside.has(target)) continue;
    const page = found.get(target);
    if (!page || page.workspace_id !== workspaceId || page.deleted_at) count += 1;
  }
  return count;
}

async function buildPreview(r: Repository, tx: Sql, actor: Actor, workspaceId: string, rootPageId: string, targetSpaceId: string, parentId: string | null): Promise<{ preview: MigrationPreview; pageIds: string[]; sourceSpaceId: string }> {
  const tree = await loadTree(tx, workspaceId, actor);
  let root: Awaited<ReturnType<Repository["access"]>>;
  try {
    root = await r.access(tx, rootPageId, actor, false, true);
  } catch (error) {
    if (error instanceof DocumentError && error.status === 404) throw hidden();
    throw error;
  }
  if (root.workspace_id !== workspaceId) throw hidden();
  const target = await tx.query<{ id: string; archived_at: string | null }>("SELECT id, archived_at FROM hs_spaces WHERE id = $1 AND workspace_id = $2", [targetSpaceId, workspaceId]);
  if (!target.rows[0]) throw hidden();
  if (target.rows[0].archived_at || root.space_archived_at) throw archivedError();
  if (root.space_id === targetSpaceId && root.parent_id === parentId) throw new DocumentError("Choose a different destination.", "invalid_destination", 422);
  const ids = pageSubtree(tree.list, rootPageId);
  if (!ids.has(rootPageId)) throw hidden();
  if (parentId) {
    const parent = tree.nodes.get(parentId);
    if (!parent || parent.workspace_id !== workspaceId) throw hidden();
    if (parent.deleted_at || parent.space_id !== targetSpaceId || ids.has(parentId)) throw new DocumentError("Choose a destination in this workspace.", "invalid_destination", 422);
  }
  const ordered = orderedSubtree(tree.list, rootPageId);
  const after = new Map(tree.nodes);
  for (const id of ids) {
    const node = after.get(id);
    if (!node) continue;
    after.set(id, { ...node, space_id: targetSpaceId, parent_id: id === rootPageId ? parentId : node.parent_id });
  }
  const accessChanges: AccessChange[] = [];
  for (const member of tree.members) {
    const beforeCache = new Map<string, PageRole | null>();
    const afterCache = new Map<string, PageRole | null>();
    for (const id of [...ids].sort()) {
      const before = hierarchyRole(tree.nodes, tree.grants, member, id, beforeCache);
      const next = hierarchyRole(after, tree.grants, member, id, afterCache);
      if (before !== next) accessChanges.push({ userId: member.id, name: member.name, pageId: id, before, after: next });
      if (accessChanges.length > 5000) throw new DocumentError("This release supports up to 5,000 access changes per move.", "move_limit", 422);
    }
  }
  accessChanges.sort((a, b) => a.userId.localeCompare(b.userId) || a.pageId.localeCompare(b.pageId));
  const gains = new Map<string, PersonRef>();
  const loses = new Map<string, PersonRef>();
  for (const change of accessChanges) {
    if (rank(change.after) > rank(change.before)) gains.set(change.userId, { userId: change.userId, name: change.name });
    if (rank(change.after) < rank(change.before)) loses.set(change.userId, { userId: change.userId, name: change.name });
  }
  const pageIds = ordered.map(page => page.id);
  const data = {
    rootPageId,
    targetSpaceId,
    parentId,
    pageIds,
    pageCount: pageIds.length,
    trashedCount: ordered.filter(page => page.deleted_at).length,
    accessChanges,
    gains: [...gains.values()],
    loses: [...loses.values()],
    brokenReferences: await brokenReferences(tx, workspaceId, pageIds),
    redirectCount: pageIds.length,
    treeVersion: tree.treeVersion,
  };
  const { pageIds: listed, ...preview } = data;
  return { preview: { ...preview, digest: hash(data) }, pageIds: listed, sourceSpaceId: root.space_id };
}

export async function previewSpaceMigration(r: Repository, actor: Actor, workspaceId: string, input: { rootPageId: string; targetSpaceId: string; parentId?: string | null }) {
  if (!workspaceId || workspaceId.length > 200 || !input.rootPageId || input.rootPageId.length > 200 || !input.targetSpaceId || input.targetSpaceId.length > 200) throw hidden();
  return r.db.transaction(async tx => (await buildPreview(r, tx, actor, workspaceId, input.rootPageId, input.targetSpaceId, input.parentId ?? null)).preview);
}

type JobRow = {
  id: string;
  workspace_id: string;
  operation_id: string;
  actor_id: string;
  root_page_id: string;
  source_space_id: string;
  target_space_id: string;
  parent_id: string | null;
  status: MigrationJob["status"];
  request_hash: string;
  page_ids: unknown;
  tree_version: number;
  cursor_index: number;
  halt_reason: string | null;
};

function jobReport(job: JobRow, replayed = false): MigrationJob {
  const ids = asIds(job.page_ids);
  const cursor = Number(job.cursor_index) || 0;
  return {
    jobId: job.id,
    status: job.status,
    pageCount: ids.length,
    movedPageIds: ids.slice(0, cursor),
    remainingPageIds: ids.slice(cursor),
    sourceSpaceId: job.source_space_id,
    targetSpaceId: job.target_space_id,
    haltReason: job.halt_reason,
    atIst: formatIst(new Date()),
    replayed,
  };
}

export async function startSpaceMigration(r: Repository, actor: Actor, workspaceId: string, input: { rootPageId: string; targetSpaceId: string; parentId?: string | null; operationId: string; previewDigest: string; confirmAccess?: boolean }) {
  if (!input.operationId) throw hidden();
  const requestHash = hash({ action: "start", rootPageId: input.rootPageId, targetSpaceId: input.targetSpaceId, parentId: input.parentId ?? null, previewDigest: input.previewDigest, confirmAccess: input.confirmAccess === true });
  return r.db.transaction(async tx => {
    const existing = await tx.query<JobRow>("SELECT * FROM hs_space_migration_jobs WHERE workspace_id = $1 AND operation_id = $2", [workspaceId, input.operationId]);
    if (existing.rows[0]) {
      const job = existing.rows[0];
      if (job.actor_id !== actor.id || job.request_hash !== requestHash) throw mismatch();
      return jobReport(job, true);
    }
    const built = await buildPreview(r, tx, actor, workspaceId, input.rootPageId, input.targetSpaceId, input.parentId ?? null);
    const preview = built.preview;
    if (preview.digest !== input.previewDigest) throw conflict();
    if (preview.gains.length && input.confirmAccess !== true) throw confirmAccess();
    const jobId = randomUUID();
    await tx.query(
      `INSERT INTO hs_space_migration_jobs(id, workspace_id, operation_id, actor_id, root_page_id, source_space_id, target_space_id, parent_id, status, request_hash, preview, page_ids, tree_version)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,'running',$9,$10::jsonb,$11::jsonb,$12)`,
      [jobId, workspaceId, input.operationId, actor.id, input.rootPageId, built.sourceSpaceId, input.targetSpaceId, input.parentId ?? null, requestHash, JSON.stringify({ pageCount: preview.pageCount, brokenReferences: preview.brokenReferences, gains: preview.gains.map(person => person.userId), loses: preview.loses.map(person => person.userId) }), JSON.stringify(built.pageIds), preview.treeVersion],
    );
    await audit(tx, actor.id, "space.migration.start", input.operationId, { jobId, workspaceId, rootPageId: input.rootPageId, targetSpaceId: input.targetSpaceId, pageIds: built.pageIds });
    const job = await tx.query<JobRow>("SELECT * FROM hs_space_migration_jobs WHERE id = $1", [jobId]);
    return jobReport(job.rows[0]);
  });
}

async function haltJob(tx: Sql, job: JobRow, actor: Actor, operationId: string, requestHash: string, reason: string) {
  await tx.query("UPDATE hs_space_migration_jobs SET status = 'halted', halt_reason = $2, updated_at = clock_timestamp() WHERE id = $1", [job.id, reason]);
  const next = { ...job, status: "halted" as const, halt_reason: reason };
  const report = jobReport(next);
  await tx.query(
    "INSERT INTO hs_space_migration_steps(job_id, operation_id, actor_id, request_hash, result) VALUES($1,$2,$3,$4,$5::jsonb)",
    [job.id, operationId, actor.id, requestHash, JSON.stringify(report)],
  );
  await audit(tx, actor.id, "space.migration.halt", operationId, { jobId: job.id, workspaceId: job.workspace_id, reason, movedPageIds: report.movedPageIds, remainingPageIds: report.remainingPageIds });
  return report;
}

export async function stepSpaceMigration(r: Repository, actor: Actor, workspaceId: string, input: { jobId: string; operationId: string; resume?: boolean }) {
  if (!workspaceId || !input.jobId || !input.operationId) throw hidden();
  const requestHash = hash({ action: input.resume ? "resume" : "step", jobId: input.jobId });
  return r.db.transaction(async tx => {
    const member = await membership(tx, workspaceId, actor, true);
    if (!member) throw hidden();
    const found = await tx.query<JobRow>("SELECT * FROM hs_space_migration_jobs WHERE id = $1 AND workspace_id = $2 FOR UPDATE", [input.jobId, workspaceId]);
    const job = found.rows[0];
    if (!job) throw hidden();
    if (job.actor_id !== actor.id) throw hidden();
    const prior = await tx.query<{ actor_id: string; request_hash: string; result: MigrationJob }>(
      "SELECT actor_id, request_hash, result FROM hs_space_migration_steps WHERE job_id = $1 AND operation_id = $2",
      [job.id, input.operationId],
    );
    if (prior.rows[0]) {
      if (prior.rows[0].actor_id !== actor.id || prior.rows[0].request_hash !== requestHash) throw mismatch();
      return { ...asObject<MigrationJob>(prior.rows[0].result), replayed: true };
    }
    if (!administers(member.role)) {
      if (job.actor_id === actor.id && job.status === "running") return haltJob(tx, job, actor, input.operationId, requestHash, "authority_revoked");
      throw hidden();
    }
    if (job.status === "halted" && !input.resume) return jobReport(job);
    if (job.status === "halted" && input.resume) {
      await tx.query("UPDATE hs_space_migration_jobs SET status = 'running', halt_reason = NULL, updated_at = clock_timestamp() WHERE id = $1", [job.id]);
      job.status = "running";
      job.halt_reason = null;
    }
    const currentTree = await tx.query<{ tree_version: number }>("SELECT tree_version FROM hs_workspaces WHERE id = $1", [workspaceId]);
    if (currentTree.rows[0]?.tree_version !== job.tree_version + job.cursor_index) {
      return haltJob(tx, job, actor, input.operationId, requestHash, "tree_changed");
    }
    const spaces = await tx.query<{ id: string; archived_at: string | null }>(
      "SELECT id, archived_at FROM hs_spaces WHERE workspace_id = $1 AND id = ANY($2::text[]) FOR UPDATE",
      [workspaceId, [job.source_space_id, job.target_space_id]],
    );
    if (spaces.rows.length !== new Set([job.source_space_id, job.target_space_id]).size || spaces.rows.some(space => space.archived_at)) {
      return haltJob(tx, job, actor, input.operationId, requestHash, "space_archived");
    }
    const ids = asIds(job.page_ids);
    if (job.cursor_index >= ids.length) {
      await tx.query("UPDATE hs_space_migration_jobs SET status = 'completed', updated_at = clock_timestamp() WHERE id = $1", [job.id]);
      const report = jobReport({ ...job, status: "completed", cursor_index: ids.length });
      await tx.query("INSERT INTO hs_space_migration_steps(job_id, operation_id, actor_id, request_hash, result) VALUES($1,$2,$3,$4,$5::jsonb)", [job.id, input.operationId, actor.id, requestHash, JSON.stringify(report)]);
      return report;
    }
    const pageId = ids[job.cursor_index];
    const page = await tx.query<{ space_id: string; deleted_at: string | null }>("SELECT space_id, deleted_at FROM hs_pages WHERE id = $1 AND workspace_id = $2 FOR UPDATE", [pageId, workspaceId]);
    if (!page.rows[0]) return haltJob(tx, job, actor, input.operationId, requestHash, "interrupted");
    const sourceSpaceId = page.rows[0].space_id;
    const isRoot = pageId === job.root_page_id;
    let position = 0;
    if (isRoot) {
      const next = await tx.query<{ pos: number }>(
        "SELECT COALESCE(MAX(position), -1) + 1 AS pos FROM hs_pages WHERE workspace_id = $1 AND space_id = $2 AND parent_id IS NOT DISTINCT FROM $3 AND id <> $4",
        [workspaceId, job.target_space_id, job.parent_id, pageId],
      );
      position = Number(next.rows[0]?.pos ?? 0);
      await tx.query("UPDATE hs_pages SET space_id = $2, parent_id = $3, position = $4, acl_version = acl_version + 1 WHERE id = $1", [pageId, job.target_space_id, job.parent_id, position]);
    } else {
      await tx.query("UPDATE hs_pages SET space_id = $2, acl_version = acl_version + 1 WHERE id = $1", [pageId, job.target_space_id]);
    }
    await tx.query(
      "INSERT INTO hs_space_page_redirects(workspace_id, page_id, from_space_id, to_space_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING",
      [workspaceId, pageId, sourceSpaceId, job.target_space_id],
    );
    await retargetPublishedPages(tx, actor, [pageId], job.target_space_id, input.operationId);
    await tx.query("UPDATE hs_workspaces SET tree_version = tree_version + 1 WHERE id = $1", [workspaceId]);
    const cursor = job.cursor_index + 1;
    const status = cursor >= ids.length ? "completed" : "running";
    await tx.query("UPDATE hs_space_migration_jobs SET cursor_index = $2, status = $3, updated_at = clock_timestamp() WHERE id = $1", [job.id, cursor, status]);
    const report = jobReport({ ...job, cursor_index: cursor, status, halt_reason: null });
    await tx.query("INSERT INTO hs_space_migration_steps(job_id, operation_id, actor_id, request_hash, result) VALUES($1,$2,$3,$4,$5::jsonb)", [job.id, input.operationId, actor.id, requestHash, JSON.stringify(report)]);
    await audit(tx, actor.id, "space.migration.move", input.operationId, { jobId: job.id, workspaceId, pageId, fromSpaceId: sourceSpaceId, toSpaceId: job.target_space_id, trashed: Boolean(page.rows[0].deleted_at) }, pageId);
    return report;
  });
}

export async function resolveSpacePage(r: Repository, actor: Actor, workspaceId: string, spaceId: string, pageId: string) {
  if (!workspaceId || workspaceId.length > 200 || !spaceId || spaceId.length > 200 || !pageId || pageId.length > 200) throw hidden();
  return r.db.transaction(async tx => {
    const member = await membership(tx, workspaceId, actor);
    if (!member) throw hidden();
    let page: { id: string; space_id: string; workspace_id: string };
    try {
      page = await r.access(tx, pageId, actor);
    } catch (error) {
      if (error instanceof DocumentError && (error.status === 404 || error.status === 403)) throw hidden();
      throw error;
    }
    if (page.workspace_id !== workspaceId) throw hidden();
    if (page.space_id === spaceId) return { pageId: page.id, spaceId: page.space_id, redirect: false, location: `/pages/${encodeURIComponent(page.id)}` };
    const redirect = await tx.query("SELECT to_space_id FROM hs_space_page_redirects WHERE workspace_id = $1 AND page_id = $2 AND from_space_id = $3", [workspaceId, pageId, spaceId]);
    if (!redirect.rows.length || page.space_id !== redirect.rows[0].to_space_id) throw hidden();
    return { pageId: page.id, spaceId: page.space_id, redirect: true, location: `/pages/${encodeURIComponent(page.id)}` };
  });
}
