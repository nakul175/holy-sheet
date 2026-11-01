/** Reader-facing breadcrumb constants. Safe to import from client components. */

/** Same neutral sentence for hidden, deleted, and unknown targets (LO-1). */
export const BREADCRUMB_UNAVAILABLE = "Page is restricted or unavailable";
/** Shown only when this reader is allowed to know the page is in Trash. */
export const BREADCRUMB_TRASH = "This page is in Trash";
/** One open page, not a workspace-wide tree poll. Under the 5s move/rename budget. */
export const BREADCRUMB_REFRESH_MS = 4_000;
export const BREADCRUMB_SIBLING_LIMIT = 20;
/** Space + ancestors + current. A depth-4 trail stays fully expanded. */
export const BREADCRUMB_EXPANDED_MAX = 4;
export const BREADCRUMB_MOBILE_QUERY = "(max-width: 720px)";

export type BreadcrumbSibling = { id: string; title: string; href: string };

export type BreadcrumbReadable = {
  readable: true;
  kind: "space" | "page";
  id: string;
  title: string;
  href: string;
  current: boolean;
  siblings: BreadcrumbSibling[];
  siblingsTruncated: boolean;
};

export type BreadcrumbSegment = BreadcrumbReadable | { readable: false };

export type BreadcrumbTrail = {
  state: "ready";
  treeVersion: number;
  segments: BreadcrumbSegment[];
};

export type BreadcrumbTrash = {
  state: "trash";
  message: string;
};

export type BreadcrumbView = BreadcrumbTrail | BreadcrumbTrash;

export type CrumbItem =
  | { type: "crumb"; segment: BreadcrumbReadable }
  | { type: "hidden" }
  | { type: "collapsed"; segments: BreadcrumbReadable[] };

export type CrumbPresentation =
  | { layout: "trail"; items: CrumbItem[] }
  | { layout: "back"; parent: BreadcrumbSegment | null };

export function isReadable(segment: BreadcrumbSegment): segment is BreadcrumbReadable {
  return segment.readable;
}

/**
 * Desktop shows the whole trail through depth 4.
 * Longer trails keep the space, the parent, and the current page, and list the middle in one menu.
 * Mobile keeps only the immediate parent and a back affordance.
 */
export function presentTrail(segments: readonly BreadcrumbSegment[], mobile: boolean): CrumbPresentation {
  const currentAt = segments.findIndex(segment => segment.readable && segment.current);
  if (mobile) return { layout: "back", parent: currentAt > 0 ? segments[currentAt - 1] : null };
  if (segments.length <= BREADCRUMB_EXPANDED_MAX) {
    return { layout: "trail", items: segments.map(segment => (segment.readable ? { type: "crumb", segment } : { type: "hidden" })) };
  }
  const head = segments[0];
  const middle = segments.slice(1, -2);
  const tail = segments.slice(-2);
  const items: CrumbItem[] = [head.readable ? { type: "crumb", segment: head } : { type: "hidden" }];
  if (middle.length) items.push({ type: "collapsed", segments: middle.filter(isReadable) });
  for (const segment of tail) items.push(segment.readable ? { type: "crumb", segment } : { type: "hidden" });
  return { layout: "trail", items };
}
