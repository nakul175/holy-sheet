import type { PageRole } from "./types";

/** Same neutral copy for hidden, deleted, and unknown targets (LO-1). */
export const PAGE_TREE_UNAVAILABLE = "Page is restricted or unavailable";
export const PAGE_TREE_CREATE_DENIED = "You do not have permission to create pages in this space.";
/** Undo stays available for 10 seconds. Guidance only; not a staging measurement. */
export const PAGE_TREE_UNDO_MS = 10_000;
/** Same recheck cadence as other HOLY-4 surfaces. */
export const PAGE_TREE_REFRESH_MS = 4_000;
/** Expand budget from HS-AC-N39-01. This build does not record a staging latency run. */
export const PAGE_TREE_EXPAND_BUDGET_MS = 300;
export const PAGE_TREE_ROW_PX = 36;
export const PAGE_TREE_PAGE_SIZE = 200;

export type PageTreeDrop = "before" | "inside" | "after";

export type PageTreeNode = {
  id: string;
  title: string;
  spaceId: string;
  parentId: string | null;
  position: number;
  version: number;
  role: PageRole;
  hasVisibleChildren: boolean;
};

export type PageTreeSlice = {
  workspaceId: string;
  spaceId: string;
  parentId: string | null;
  treeVersion: number;
  canCreateInSpace: boolean;
  nodes: PageTreeNode[];
  nextCursor: string | null;
};

export type PageTreeAccessChange = {
  pageId: string;
  pageTitle: string;
  recipientId: string;
  recipientName: string;
  before: PageRole | null;
  after: PageRole | null;
};

export type PageTreeMovePreview = {
  pageId: string;
  title: string;
  descendantCount: number;
  treeVersion: number;
  sourcePath: string[];
  targetPath: string[];
  position: { index: number; afterId: string | null; afterTitle: string | null };
  changes: PageTreeAccessChange[];
  expandsAccess: boolean;
  digest: string;
};

export type PageTreeMoveResult = {
  pageId: string;
  treeVersion: number;
  replayed: boolean;
  atIst: string;
};

export function dropPlacement(offsetY: number, height: number): PageTreeDrop {
  if (!(height > 0) || !Number.isFinite(offsetY)) return "inside";
  const ratio = offsetY / height;
  if (ratio <= 0.28) return "before";
  if (ratio >= 0.72) return "after";
  return "inside";
}

/** Window of a virtualised tree. Work stays proportional to the viewport, including a 2,000-row space. */
export function pageTreeWindow(scrollTop: number, viewport: number, count: number, overscan = 6) {
  const top = Number.isFinite(scrollTop) ? Math.max(0, scrollTop) : 0;
  const view = Number.isFinite(viewport) ? Math.max(0, viewport) : 0;
  const start = Math.max(0, Math.floor(top / PAGE_TREE_ROW_PX) - overscan);
  const end = Math.min(Math.max(0, count), Math.ceil((top + view) / PAGE_TREE_ROW_PX) + overscan);
  return { start, end: Math.max(start, end) };
}

export function siblingDestination(siblingIds: readonly string[], draggedId: string, targetId: string, place: "before" | "after") {
  const rest = siblingIds.filter(id => id !== draggedId);
  const at = rest.indexOf(targetId);
  if (at < 0) return rest.length;
  return place === "before" ? at : at + 1;
}

/**
 * Index is counted in visible siblings only, so a hidden sibling cannot extend the legal range.
 * Hidden ids stay in the stored order, in the gap they already occupied.
 */
export function mergeSiblingOrder(orderedIds: readonly string[], visibleIds: readonly string[], movedId: string, index: number): string[] | null {
  const visible = visibleIds.filter(id => id !== movedId);
  if (!Number.isInteger(index) || index < 0 || index > visible.length) return null;
  const visibleSet = new Set(visible);
  const gaps: string[][] = Array.from({ length: visible.length + 1 }, () => []);
  let gap = 0;
  const seen = new Set<string>();
  for (const id of orderedIds) {
    if (id === movedId || seen.has(id)) continue;
    seen.add(id);
    if (visibleSet.has(id)) gap += 1;
    else gaps[Math.min(gap, visible.length)].push(id);
  }
  const result: string[] = [];
  for (let i = 0; i <= visible.length; i += 1) {
    result.push(...gaps[i]);
    if (i === index) result.push(movedId);
    if (i < visible.length) result.push(visible[i]);
  }
  return result;
}
