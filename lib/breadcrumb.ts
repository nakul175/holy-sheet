import type { Actor } from "./auth";
import type { Sql } from "./database";
import {
  BREADCRUMB_SIBLING_LIMIT,
  BREADCRUMB_TRASH,
  BREADCRUMB_UNAVAILABLE,
  type BreadcrumbReadable,
  type BreadcrumbSegment,
  type BreadcrumbSibling,
  type BreadcrumbView,
} from "./breadcrumb-model";
import { DocumentError } from "./document";
import { loadPageAccessContext, pageReadable } from "./page-tree";
import type { Repository } from "./repository";

export type { BreadcrumbView };
export { BREADCRUMB_TRASH, BREADCRUMB_UNAVAILABLE };

type AccessContext = Awaited<ReturnType<typeof loadPageAccessContext>>;
type PageRow = AccessContext["pages"] extends Map<string, infer Row> ? Row : never;

const unavailable = () => new DocumentError(BREADCRUMB_UNAVAILABLE, "not_found", 404);

export type AncestryQuery = { siblingsOf: string | null; allSiblings: boolean };

/** Rejects a malformed sibling query before any page lookup. `all` is ignored without a segment id. */
export function ancestryQuery(url: URL): AncestryQuery {
  const siblingsOf = url.searchParams.get("siblingsOf");
  const all = url.searchParams.get("all");
  if (siblingsOf !== null && (siblingsOf.length < 1 || siblingsOf.length > 200)) throw unavailable();
  if (all !== null && all !== "1") throw unavailable();
  return { siblingsOf, allSiblings: all === "1" && siblingsOf !== null };
}

function pageHref(id: string) {
  return `/pages/${encodeURIComponent(id)}`;
}

function spaceHref(workspaceId: string, spaceId: string) {
  return `/workspaces/${encodeURIComponent(workspaceId)}/spaces/${encodeURIComponent(spaceId)}`;
}

function time(value: string | Date) {
  const parsed = new Date(value).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function byPosition(a: PageRow, b: PageRow) {
  return a.position - b.position || time(b.updated_at) - time(a.updated_at) || a.id.localeCompare(b.id);
}

/** Root first, including the leaf. Stops on a cycle or a parent outside this workspace graph. */
function lineage(ctx: AccessContext, pageId: string) {
  const chain: PageRow[] = [];
  const seen = new Set<string>();
  let current = ctx.pages.get(pageId);
  while (current && !seen.has(current.id)) {
    seen.add(current.id);
    chain.push(current);
    if (!current.parent_id) break;
    const parent = ctx.pages.get(current.parent_id);
    if (!parent || parent.workspace_id !== current.workspace_id) break;
    current = parent;
  }
  return chain.reverse();
}

/** Trash is visible to the leaf owner or the owner of a deleted ancestor. Everyone else gets the generic not-found. */
function trashVisible(actorId: string, chain: readonly PageRow[]) {
  const leaf = chain[chain.length - 1];
  if (!leaf) return false;
  if (leaf.owner_id === actorId) return true;
  return chain.some(node => node.deleted_at && node.owner_id === actorId);
}

function siblingWindow(rows: readonly BreadcrumbSibling[], all: boolean) {
  if (all) return { siblings: [...rows], siblingsTruncated: false };
  return { siblings: rows.slice(0, BREADCRUMB_SIBLING_LIMIT), siblingsTruncated: rows.length > BREADCRUMB_SIBLING_LIMIT };
}

function pageSiblings(ctx: AccessContext, actorId: string, page: PageRow): BreadcrumbSibling[] {
  return [...ctx.pages.values()]
    .filter(other => other.id !== page.id && other.space_id === page.space_id && other.parent_id === page.parent_id && !other.deleted_at && pageReadable(ctx, actorId, other))
    .sort(byPosition)
    .map(other => ({ id: other.id, title: other.title || "Untitled", href: pageHref(other.id) }));
}

async function spaceSiblings(tx: Sql, workspaceId: string, spaceId: string): Promise<BreadcrumbSibling[]> {
  const spaces = await tx.query<{ id: string; name: string }>("SELECT id, name FROM hs_spaces WHERE workspace_id = $1 AND id <> $2 ORDER BY name, id", [workspaceId, spaceId]);
  return spaces.rows.map(space => ({ id: space.id, title: space.name, href: spaceHref(workspaceId, space.id) }));
}

function readablePage(page: PageRow, current: boolean, siblings: BreadcrumbSibling[], all: boolean): BreadcrumbReadable {
  const windowed = siblingWindow(siblings, all);
  return {
    readable: true,
    kind: "page",
    id: page.id,
    title: page.title || "Untitled",
    href: pageHref(page.id),
    current,
    siblings: windowed.siblings,
    siblingsTruncated: windowed.siblingsTruncated,
  };
}

/**
 * Ancestry for one page. Unreadable ancestors collapse to a single `{ readable: false }`
 * with no id and no title. A trashed ancestor does not open as a trail.
 */
export async function readPageAncestry(r: Repository, actor: Actor, workspaceId: string, pageId: string, query: AncestryQuery = { siblingsOf: null, allSiblings: false }): Promise<BreadcrumbView> {
  if (!workspaceId || workspaceId.length > 200 || !pageId || pageId.length > 200) throw unavailable();
  if (query.siblingsOf && query.siblingsOf.length > 200) throw unavailable();
  return r.db.transaction(async tx => {
    const ctx = await loadPageAccessContext(tx, actor, workspaceId);
    const leaf = ctx.pages.get(pageId);
    if (!leaf || leaf.workspace_id !== workspaceId) throw unavailable();
    const chain = lineage(ctx, pageId);
    if (!chain.length || chain[chain.length - 1]?.id !== pageId) throw unavailable();
    if (chain.some(node => node.deleted_at)) {
      if (!trashVisible(actor.id, chain)) throw unavailable();
      return { state: "trash", message: BREADCRUMB_TRASH };
    }
    if (!pageReadable(ctx, actor.id, leaf)) throw unavailable();
    const ancestors = chain.slice(0, -1);
    const ancestorReadable = (page: PageRow) => pageReadable(ctx, actor.id, page);
    const showSpace = ancestors.length === 0 || ancestors.some(ancestorReadable);
    const revealAll = query.allSiblings ? query.siblingsOf : null;
    const segments: BreadcrumbSegment[] = [];
    if (showSpace) {
      const space = await tx.query<{ id: string; name: string }>("SELECT id, name FROM hs_spaces WHERE id = $1 AND workspace_id = $2", [leaf.space_id, workspaceId]);
      if (!space.rows.length) throw unavailable();
      const siblings = siblingWindow(await spaceSiblings(tx, workspaceId, leaf.space_id), revealAll === leaf.space_id);
      segments.push({
        readable: true,
        kind: "space",
        id: space.rows[0].id,
        title: space.rows[0].name,
        href: spaceHref(workspaceId, space.rows[0].id),
        current: false,
        siblings: siblings.siblings,
        siblingsTruncated: siblings.siblingsTruncated,
      });
    }
    let hiddenGap = false;
    for (const ancestor of ancestors) {
      if (!ancestorReadable(ancestor)) {
        hiddenGap = true;
        continue;
      }
      if (hiddenGap) {
        segments.push({ readable: false });
        hiddenGap = false;
      }
      segments.push(readablePage(ancestor, false, pageSiblings(ctx, actor.id, ancestor), revealAll === ancestor.id));
    }
    if (hiddenGap) segments.push({ readable: false });
    segments.push(readablePage(leaf, true, pageSiblings(ctx, actor.id, leaf), revealAll === leaf.id));
    if (query.siblingsOf && !segments.some(segment => segment.readable && segment.id === query.siblingsOf)) throw unavailable();
    return { state: "ready", treeVersion: ctx.treeVersion, segments };
  });
}

/** Page-scoped read. A foreign-tenant id and an unknown id share one not-found. */
export async function readPageAncestryForPage(r: Repository, actor: Actor, pageId: string, query: AncestryQuery = { siblingsOf: null, allSiblings: false }): Promise<BreadcrumbView> {
  if (!pageId || pageId.length > 200) throw unavailable();
  const located = await r.db.query<{ workspace_id: string }>(
    `SELECT p.workspace_id FROM hs_pages p
     JOIN hs_members m ON m.workspace_id = p.workspace_id AND m.user_id = $2 AND m.active = true
     WHERE p.id = $1`,
    [pageId, actor.id],
  );
  if (!located.rows.length) throw unavailable();
  return readPageAncestry(r, actor, located.rows[0].workspace_id, pageId, query);
}
