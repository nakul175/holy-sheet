import { createHash, randomUUID } from "node:crypto";
import type { Actor } from "./auth";
import type { Sql } from "./database";
import { DocumentError, plainText, stableStringify, type RichNode } from "./document";
import { formatIst } from "./ist-label";
import { hierarchyRole, pageSubtree, type HierarchyGrant, type HierarchyMember, type HierarchyNode } from "./page-organisation";
import {
  mergeSiblingOrder,
  PAGE_TREE_CREATE_DENIED,
  PAGE_TREE_PAGE_SIZE,
  PAGE_TREE_UNAVAILABLE,
  type PageTreeMovePreview,
  type PageTreeMoveResult,
  type PageTreeNode,
  type PageTreeSlice,
} from "./page-tree-model";
import type { Repository } from "./repository";
import { SPACE_HOME_TEMPLATE_ID } from "./space-home-shared";
import { canEdit, type PageRole } from "./types";

export type { PageTreeMovePreview, PageTreeMoveResult, PageTreeNode, PageTreeSlice };
export { PAGE_TREE_CREATE_DENIED, PAGE_TREE_UNAVAILABLE };

type Row = {
  id: string;
  workspace_id: string;
  space_id: string;
  parent_id: string | null;
  owner_id: string;
  visibility: "private" | "space";
  title: string;
  version: number;
  position: number;
  updated_at: string | Date;
  deleted_at?: string | Date | null;
  acl_version?: number;
};
type Grant = { page_id: string; subject: string; role: PageRole };
type Context = {
  treeVersion: number;
  accessModel: number;
  memberRole: string;
  pages: Map<string, Row>;
  grants: Map<string, Grant[]>;
  homes: Set<string>;
  spaceRoles: Map<string, string>;
};

const hash = (value: unknown) => createHash("sha256").update(stableStringify(value)).digest("hex");
const unavailable = () => new DocumentError(PAGE_TREE_UNAVAILABLE, "not_found", 404);
const createDenied = () => new DocumentError(PAGE_TREE_CREATE_DENIED, "destination_create_required", 403);
const rank = (role: PageRole | null) => (role ? { viewer: 1, commenter: 2, editor: 3, owner: 4 }[role] : 0);
const time = (value: string | Date) => {
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
};

function ancestors(pages: Map<string, Row>, id: string) {
  const chain: Row[] = [];
  const seen = new Set<string>();
  let current: Row | undefined = pages.get(id);
  if (!current || current.deleted_at) return chain;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.push(current);
    const parent: Row | undefined = current.parent_id ? pages.get(current.parent_id) : undefined;
    if (!parent || parent.deleted_at) break;
    current = parent;
  }
  return chain;
}

function grantMatches(page: Row, grant: Grant, actorId: string) {
  return grant.subject === actorId || (grant.subject === "space" && page.visibility === "space");
}

/** HOLY-4 effective read. A space-home reader does not inherit that exception onto child pages. */
export function pageReadable(ctx: Context, actorId: string, page: Row) {
  if (page.deleted_at) return false;
  if (ctx.memberRole === "owner" || ctx.memberRole === "admin") return true;
  for (const node of ancestors(ctx.pages, page.id)) {
    if (node.owner_id === actorId) return true;
    if ((ctx.grants.get(node.id) ?? []).some(grant => grantMatches(node, grant, actorId))) return true;
  }
  return ctx.homes.has(page.id);
}

export function pageTreeRole(ctx: Context, actorId: string, page: Row): PageRole {
  if (ctx.memberRole === "observer") return "viewer";
  if (page.owner_id === actorId) return "owner";
  if (ctx.memberRole === "owner" || ctx.memberRole === "admin") return "editor";
  let best = 0;
  let role: PageRole = "viewer";
  for (const node of ancestors(ctx.pages, page.id)) {
    if (node.owner_id === actorId && 3 > best) {
      best = 3;
      role = "editor";
    }
    for (const grant of ctx.grants.get(node.id) ?? []) {
      if (!grantMatches(node, grant, actorId)) continue;
      const next: PageRole = grant.role === "editor" || grant.role === "commenter" ? grant.role : "viewer";
      const score = rank(next);
      if (score > best) {
        best = score;
        role = next;
      }
    }
  }
  return role;
}

function canCreateInSpace(ctx: Context, spaceId: string) {
  if (ctx.memberRole === "observer") return false;
  if (ctx.accessModel === 2 && ctx.memberRole !== "owner" && ctx.memberRole !== "admin") {
    const spaceRole = ctx.spaceRoles.get(spaceId) ?? "";
    if (spaceRole !== "leader" && spaceRole !== "editor") return false;
  }
  return true;
}

async function audit(tx: Sql, actorId: string, action: string, pageId: string, operationId: string, after: Record<string, unknown>) {
  await tx.query(
    "INSERT INTO hs_audit(id, actor_id, action, page_id, after_value, correlation_id) VALUES($1,$2,$3,$4,$5::jsonb,$6)",
    [randomUUID(), actorId, action, pageId, JSON.stringify(after), operationId],
  );
}

async function requireMember(tx: Sql, workspaceId: string, actor: Actor, lock = false) {
  if (!workspaceId || workspaceId.length > 200) throw unavailable();
  const rows = await tx.query<{ id: string; role: string; tree_version: number; access_model_version: number }>(
    `SELECT w.id, w.tree_version, w.access_model_version, m.role
     FROM hs_workspaces w
     JOIN hs_members m ON m.workspace_id = w.id AND m.user_id = $2 AND m.active = true
     WHERE w.id = $1 ${lock ? "FOR UPDATE OF w" : ""}`,
    [workspaceId, actor.id],
  );
  if (!rows.rows.length) throw unavailable();
  return rows.rows[0];
}

async function readContext(tx: Sql, actor: Actor, workspaceId: string, lock = false): Promise<Context> {
  const member = await requireMember(tx, workspaceId, actor, lock);
  const pages = await tx.query<Row>(
    `SELECT id, workspace_id, space_id, parent_id, owner_id, visibility, title, version, acl_version, position, updated_at, deleted_at
     FROM hs_pages WHERE workspace_id = $1 ORDER BY id`,
    [workspaceId],
  );
  const grants = await tx.query<Grant>(
    `SELECT g.page_id, g.subject, g.role FROM hs_grants g
     JOIN hs_pages p ON p.id = g.page_id WHERE p.workspace_id = $1`,
    [workspaceId],
  );
  const homes = await tx.query<{ home_page_id: string }>(
    `SELECT s.home_page_id FROM hs_spaces s
     JOIN hs_page_template_sources src ON src.page_id = s.home_page_id AND src.template_id = $2
     JOIN hs_space_members sm ON sm.space_id = s.id AND sm.user_id = $3 AND sm.active = true
     WHERE s.workspace_id = $1 AND s.home_page_id IS NOT NULL`,
    [workspaceId, SPACE_HOME_TEMPLATE_ID, actor.id],
  );
  const spaces = await tx.query<{ space_id: string; role: string }>(
    `SELECT space_id, role FROM hs_space_members WHERE user_id = $1 AND active = true`,
    [actor.id],
  );
  const byPage = new Map<string, Grant[]>();
  for (const grant of grants.rows) byPage.set(grant.page_id, [...(byPage.get(grant.page_id) ?? []), grant]);
  return {
    treeVersion: member.tree_version,
    accessModel: member.access_model_version,
    memberRole: member.role,
    pages: new Map(pages.rows.map(page => [page.id, page])),
    grants: byPage,
    homes: new Set(homes.rows.map(row => row.home_page_id)),
    spaceRoles: new Map(spaces.rows.map(row => [row.space_id, row.role])),
  };
}

/** Membership-scoped page graph for HOLY-4 checks. Missing membership is the same not-found as an unknown workspace. */
export async function loadPageAccessContext(tx: Sql, actor: Actor, workspaceId: string) {
  return readContext(tx, actor, workspaceId);
}

function ordered(rows: Row[]) {
  return [...rows].sort((a, b) => a.position - b.position || time(b.updated_at) - time(a.updated_at) || a.id.localeCompare(b.id));
}

function nodeOf(ctx: Context, actorId: string, page: Row, spaceId: string): PageTreeNode {
  const hasVisibleChildren = [...ctx.pages.values()].some(child => child.parent_id === page.id && child.space_id === spaceId && !child.deleted_at && pageReadable(ctx, actorId, child));
  return {
    id: page.id,
    title: page.title,
    spaceId: page.space_id,
    parentId: page.parent_id,
    position: page.position,
    version: page.version,
    role: pageTreeRole(ctx, actorId, page),
    hasVisibleChildren,
  };
}

export async function listPageTreeChildren(
  r: Repository,
  actor: Actor,
  workspaceId: string,
  query: { spaceId: string; parentId: string | null; cursor?: string | null; pageSize?: number },
): Promise<PageTreeSlice> {
  if (!query.spaceId || query.spaceId.length > 200) throw unavailable();
  return r.db.transaction(async tx => {
    const ctx = await readContext(tx, actor, workspaceId);
    const space = await tx.query<{ id: string }>("SELECT id FROM hs_spaces WHERE id = $1 AND workspace_id = $2", [query.spaceId, workspaceId]);
    if (!space.rows.length) throw unavailable();
    const readable = (page: Row) => pageReadable(ctx, actor.id, page);
    let rows: Row[];
    if (query.parentId) {
      if (query.parentId.length > 200) throw unavailable();
      const parent = ctx.pages.get(query.parentId);
      if (!parent || parent.deleted_at || parent.workspace_id !== workspaceId || parent.space_id !== query.spaceId || !readable(parent)) throw unavailable();
      rows = [...ctx.pages.values()].filter(page => page.parent_id === query.parentId && page.space_id === query.spaceId && !page.deleted_at && readable(page));
    } else {
      rows = [...ctx.pages.values()].filter(page => {
        if (page.space_id !== query.spaceId || page.deleted_at || !readable(page)) return false;
        if (!page.parent_id) return true;
        const parent = ctx.pages.get(page.parent_id);
        return !parent || parent.space_id !== page.space_id || parent.deleted_at || !readable(parent);
      });
    }
    const sorted = ordered(rows);
    const size = Math.min(PAGE_TREE_PAGE_SIZE, Math.max(1, query.pageSize ?? PAGE_TREE_PAGE_SIZE));
    let start = 0;
    if (query.cursor) {
      const at = sorted.findIndex(page => page.id === query.cursor);
      if (at < 0) throw new DocumentError("Refresh this page tree.", "page_tree_cursor", 409);
      start = at + 1;
    }
    const page = sorted.slice(start, start + size);
    return {
      workspaceId,
      spaceId: query.spaceId,
      parentId: query.parentId,
      treeVersion: ctx.treeVersion,
      canCreateInSpace: canCreateInSpace(ctx, query.spaceId),
      nodes: page.map(item => nodeOf(ctx, actor.id, item, query.spaceId)),
      nextCursor: start + size < sorted.length ? page.at(-1)?.id ?? null : null,
    };
  });
}

async function assertDestination(r: Repository, tx: Sql, actor: Actor, workspaceId: string, spaceId: string, parentId: string | null) {
  const space = await tx.query<{ access_model_version: number; role: string; space_role: string | null }>(
    `SELECT w.access_model_version, m.role, sm.role AS space_role
     FROM hs_spaces s
     JOIN hs_workspaces w ON w.id = s.workspace_id
     JOIN hs_members m ON m.workspace_id = w.id AND m.user_id = $3 AND m.active = true
     LEFT JOIN hs_space_members sm ON sm.space_id = s.id AND sm.user_id = $3 AND sm.active = true
     WHERE s.id = $1 AND s.workspace_id = $2`,
    [spaceId, workspaceId, actor.id],
  );
  if (!space.rows.length) throw unavailable();
  if (parentId) {
    try {
      const parent = await r.access(tx, parentId, actor, true, false);
      if (parent.workspace_id !== workspaceId || parent.space_id !== spaceId) throw unavailable();
    } catch (error) {
      if (error instanceof DocumentError && error.status === 404) throw unavailable();
      if (error instanceof DocumentError && error.code === "read_only") throw createDenied();
      throw error;
    }
    return;
  }
  const row = space.rows[0];
  if (row.role === "observer") throw createDenied();
  if (row.access_model_version === 2 && row.role !== "owner" && row.role !== "admin" && row.space_role !== "leader" && row.space_role !== "editor") throw createDenied();
}

function names(pages: Map<string, Row>, id: string | null, spaceName: string) {
  const path: string[] = [];
  const seen = new Set<string>();
  let current = id ? pages.get(id) : undefined;
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    path.unshift(current.title);
    current = current.parent_id ? pages.get(current.parent_id) : undefined;
  }
  return [spaceName, ...path];
}

async function reviewMove(r: Repository, tx: Sql, actor: Actor, workspaceId: string, intent: { pageId: string; spaceId: string; parentId: string | null; index: number }) {
  let source;
  try {
    source = await r.access(tx, intent.pageId, actor, true, true);
  } catch (error) {
    if (error instanceof DocumentError && error.status === 404) throw unavailable();
    throw error;
  }
  if (source.workspace_id !== workspaceId) throw unavailable();
  await assertDestination(r, tx, actor, workspaceId, intent.spaceId, intent.parentId);
  const ctx = await readContext(tx, actor, workspaceId);
  const pages = [...ctx.pages.values()];
  if (pages.length > 1000) throw new DocumentError("This release supports moves in workspaces with up to 1,000 pages and 500 members. No pages were moved.", "move_limit", 422);
  const members = await tx.query<HierarchyMember>(
    "SELECT u.id, u.name, m.role, m.active FROM hs_members m JOIN hs_users u ON u.id = m.user_id WHERE m.workspace_id = $1 ORDER BY u.id LIMIT 501",
    [workspaceId],
  );
  if (members.rows.length > 500) throw new DocumentError("This release supports moves in workspaces with up to 1,000 pages and 500 members. No pages were moved.", "move_limit", 422);
  const grantRows = await tx.query<HierarchyGrant>(
    "SELECT g.page_id, g.subject, g.role FROM hs_grants g JOIN hs_pages p ON p.id = g.page_id WHERE p.workspace_id = $1 ORDER BY g.page_id, g.subject",
    [workspaceId],
  );
  const nodes = new Map(pages.map(page => [page.id, page as HierarchyNode]));
  const ids = pageSubtree(pages as HierarchyNode[], intent.pageId);
  if (intent.parentId && ids.has(intent.parentId)) throw new DocumentError("A page cannot move into itself or its descendants", "move_cycle", 422);
  const destination = ordered(pages.filter(page => !page.deleted_at && page.space_id === intent.spaceId && page.parent_id === intent.parentId));
  const visible = destination.filter(page => page.id !== intent.pageId && pageReadable(ctx, actor.id, page));
  const placed = mergeSiblingOrder(destination.map(page => page.id), visible.map(page => page.id), intent.pageId, intent.index);
  if (!placed) throw new DocumentError("Choose a valid sibling position", "invalid_position", 422);
  const byPage = new Map<string, HierarchyGrant[]>();
  for (const grant of grantRows.rows) byPage.set(grant.page_id, [...(byPage.get(grant.page_id) ?? []), grant]);
  const after = new Map(pages.map(page => [page.id, { ...page, ...(ids.has(page.id) ? { space_id: intent.spaceId } : {}), ...(page.id === intent.pageId ? { parent_id: intent.parentId } : {}) } as HierarchyNode]));
  const changes: PageTreeMovePreview["changes"] = [];
  for (const member of members.rows) {
    const beforeCache = new Map<string, PageRole | null>();
    const afterCache = new Map<string, PageRole | null>();
    for (const id of [...ids].sort()) {
      const before = hierarchyRole(nodes, byPage, member, id, beforeCache);
      const next = hierarchyRole(after, byPage, member, id, afterCache);
      if (before !== next) changes.push({ pageId: id, pageTitle: nodes.get(id)?.title ?? "", recipientId: member.id, recipientName: member.name, before, after: next });
      if (changes.length > 5000) throw new DocumentError("This release supports up to 5,000 access changes per move. No pages were moved.", "move_limit", 422);
    }
  }
  const space = await tx.query<{ name: string }>("SELECT name FROM hs_spaces WHERE id = $1 AND workspace_id = $2", [intent.spaceId, workspaceId]);
  if (!space.rows.length) throw unavailable();
  const version = await tx.query<{ tree_version: number; access_version: number }>("SELECT tree_version, access_version FROM hs_workspaces WHERE id = $1", [workspaceId]);
  const data = {
    pageId: intent.pageId,
    title: source.title,
    descendantCount: [...ids].filter(id => id !== intent.pageId && !nodes.get(id)?.deleted_at).length,
    treeVersion: version.rows[0].tree_version,
    sourcePath: names(ctx.pages, source.parent_id, source.space_name),
    targetPath: names(ctx.pages, intent.parentId, space.rows[0].name),
    position: { index: intent.index, afterId: intent.index ? visible[intent.index - 1].id : null, afterTitle: intent.index ? visible[intent.index - 1].title : null },
    changes,
    expandsAccess: changes.some(change => rank(change.after) > rank(change.before)),
  };
  const digest = hash({ data, intent: { spaceId: intent.spaceId, parentId: intent.parentId, index: intent.index }, pages, members: members.rows, grants: grantRows.rows, accessVersion: version.rows[0].access_version });
  return { ids, placed, preview: { ...data, digest } satisfies PageTreeMovePreview };
}

export async function previewPageTreeMove(r: Repository, actor: Actor, workspaceId: string, intent: { pageId: string; spaceId: string; parentId: string | null; index: number }) {
  return r.db.transaction(async tx => (await reviewMove(r, tx, actor, workspaceId, intent)).preview);
}

export async function applyPageTreeMove(
  r: Repository,
  actor: Actor,
  workspaceId: string,
  input: { pageId: string; spaceId: string; parentId: string | null; index: number; operationId: string; expectedTreeVersion: number; previewDigest: string; confirmExpanded: boolean },
): Promise<PageTreeMoveResult> {
  const requestHash = hash(input);
  return r.db.transaction(async tx => {
    let source;
    try {
      source = await r.access(tx, input.pageId, actor, true, true);
    } catch (error) {
      if (error instanceof DocumentError && error.status === 404) throw unavailable();
      throw error;
    }
    if (source.workspace_id !== workspaceId) throw unavailable();
    const prior = await tx.query<{ actor_id: string; page_id: string; request_hash: string; result: { pageId: string; treeVersion: number; atIst: string } }>(
      "SELECT actor_id, page_id, request_hash, result FROM hs_page_tree_operations WHERE workspace_id = $1 AND operation_id = $2",
      [workspaceId, input.operationId],
    );
    if (prior.rows.length) {
      const operation = prior.rows[0];
      if (operation.actor_id !== actor.id || operation.page_id !== input.pageId || operation.request_hash !== requestHash) throw new DocumentError("Move operation was reused with different fields", "operation_mismatch", 409);
      return { ...operation.result, replayed: true };
    }
    const reviewed = await reviewMove(r, tx, actor, workspaceId, input);
    if (reviewed.preview.treeVersion !== input.expectedTreeVersion || reviewed.preview.digest !== input.previewDigest) throw new DocumentError("The page tree changed. Review the move again.", "move_conflict", 409);
    if (reviewed.preview.expandsAccess && !input.confirmExpanded) throw new DocumentError("Review and explicitly confirm the expanded inherited access", "access_confirmation_required", 422);
    await tx.query("UPDATE hs_pages SET space_id = $2, acl_version = acl_version + 1 WHERE id = ANY($1::text[])", [[...reviewed.ids], input.spaceId]);
    await tx.query("UPDATE hs_pages SET parent_id = $2 WHERE id = $1", [input.pageId, input.parentId]);
    for (const [position, id] of reviewed.placed.entries()) await tx.query("UPDATE hs_pages SET position = $2 WHERE id = $1", [id, position]);
    await tx.query("UPDATE hs_workspaces SET tree_version = tree_version + 1 WHERE id = $1", [workspaceId]);
    const atIst = formatIst(new Date());
    const ack = { pageId: input.pageId, treeVersion: reviewed.preview.treeVersion + 1, atIst };
    await tx.query(
      "INSERT INTO hs_page_tree_operations(workspace_id, operation_id, actor_id, page_id, request_hash, result) VALUES($1,$2,$3,$4,$5,$6::jsonb)",
      [workspaceId, input.operationId, actor.id, input.pageId, requestHash, JSON.stringify(ack)],
    );
    await audit(tx, actor.id, "page.tree.move", input.pageId, input.operationId, {
      pageId: input.pageId,
      spaceId: input.spaceId,
      parentId: input.parentId,
      index: input.index,
      descendantCount: reviewed.preview.descendantCount,
      atIst,
    });
    return { ...ack, replayed: false };
  });
}

export async function createPageTreeChild(r: Repository, actor: Actor, workspaceId: string, input: { spaceId: string; parentId: string | null; operationId: string }) {
  await r.db.transaction(async tx => {
    await requireMember(tx, workspaceId, actor, true);
    await assertDestination(r, tx, actor, workspaceId, input.spaceId, input.parentId);
  });
  let page;
  try {
    page = await r.create(actor, "", input.spaceId, input.parentId, input.operationId);
  } catch (error) {
    if (error instanceof DocumentError && error.status === 404) throw unavailable();
    if (error instanceof DocumentError && error.code === "read_only") throw createDenied();
    throw error;
  }
  if (page.workspaceId !== workspaceId) throw unavailable();
  return r.db.transaction(async tx => {
    const prior = await tx.query<{ after_value: { atIst?: string } }>("SELECT after_value FROM hs_audit WHERE correlation_id = $1 AND action = 'page.tree.create'", [input.operationId]);
    if (prior.rows.length) return { pageId: page.id, parentId: page.parentPageId, spaceId: page.spaceId, title: page.title, version: page.version, role: page.role, replayed: true, atIst: prior.rows[0].after_value?.atIst ?? "" };
    const atIst = formatIst(new Date());
    await tx.query("UPDATE hs_workspaces SET tree_version = tree_version + 1 WHERE id = $1", [workspaceId]);
    await audit(tx, actor.id, "page.tree.create", page.id, input.operationId, { pageId: page.id, spaceId: page.spaceId, parentId: page.parentPageId, atIst });
    return { pageId: page.id, parentId: page.parentPageId, spaceId: page.spaceId, title: page.title, version: page.version, role: page.role, replayed: false, atIst };
  });
}

export async function renamePageTreePage(r: Repository, actor: Actor, workspaceId: string, input: { pageId: string; title: string; baseVersion: number; operationId: string }) {
  const title = input.title.normalize("NFC").trim();
  if (!title || [...title].length > 240 || /[\u0000-\u001f]/.test(title)) throw new DocumentError("Enter a page title.", "invalid_title", 422);
  let current;
  try {
    current = await r.get(input.pageId, actor);
  } catch (error) {
    if (error instanceof DocumentError && error.status === 404) throw unavailable();
    throw error;
  }
  if (current.workspaceId !== workspaceId) throw unavailable();
  if (!canEdit(current.role)) throw new DocumentError("This page is read only", "read_only", 403);
  const saved = await r.save(input.pageId, actor, { operationId: input.operationId, baseVersion: input.baseVersion, title, document: current.document });
  if (saved.replayed) {
    const prior = await r.db.query<{ after_value: { atIst?: string } }>("SELECT after_value FROM hs_audit WHERE correlation_id = $1 AND action = 'page.tree.rename'", [input.operationId]);
    return { pageId: input.pageId, version: saved.page.version, replayed: true, atIst: prior.rows[0]?.after_value?.atIst ?? "" };
  }
  const atIst = formatIst(new Date());
  await r.db.transaction(async tx => {
    await tx.query("UPDATE hs_workspaces SET tree_version = tree_version + 1 WHERE id = $1", [workspaceId]);
    await audit(tx, actor.id, "page.tree.rename", input.pageId, input.operationId, { pageId: input.pageId, atIst });
  });
  return { pageId: input.pageId, version: saved.page.version, replayed: false, atIst };
}

export async function cancelEmptyPageTreePage(r: Repository, actor: Actor, workspaceId: string, operationId: string) {
  return r.db.transaction(async tx => {
    await requireMember(tx, workspaceId, actor, true);
    const created = await tx.query<{ page_id: string | null }>("SELECT page_id FROM hs_page_creations WHERE actor_id = $1 AND operation_id = $2", [actor.id, operationId]);
    if (!created.rows.length) throw unavailable();
    const pageId = created.rows[0].page_id;
    if (!pageId) return { cancelled: true, replayed: true, pageId: null };
    const page = await tx.query<{ id: string; title: string; workspace_id: string; deleted_at: string | null; owner_id: string }>("SELECT id, title, workspace_id, deleted_at, owner_id FROM hs_pages WHERE id = $1", [pageId]);
    if (!page.rows.length || page.rows[0].workspace_id !== workspaceId || page.rows[0].owner_id !== actor.id) throw unavailable();
    if (page.rows[0].deleted_at) return { cancelled: true, replayed: true, pageId };
    const blocks = await tx.query<{ node: RichNode }>("SELECT node FROM hs_blocks WHERE page_id = $1 AND parent_id IS NULL ORDER BY position", [pageId]);
    const text = plainText({ type: "doc", content: blocks.rows.map(row => row.node) }).trim();
    if ((page.rows[0].title !== "Untitled" && page.rows[0].title !== "") || text) throw new DocumentError("This page is no longer empty.", "page_not_empty", 409);
    await tx.query("UPDATE hs_pages SET deleted_at = clock_timestamp() WHERE id = $1 AND deleted_at IS NULL", [pageId]);
    await tx.query("UPDATE hs_workspaces SET tree_version = tree_version + 1 WHERE id = $1", [workspaceId]);
    const atIst = formatIst(new Date());
    await audit(tx, actor.id, "page.tree.cancel", pageId, operationId, { pageId, atIst });
    return { cancelled: true, replayed: false, pageId, atIst };
  });
}
