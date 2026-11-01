import { expect, it } from "vitest";
import { BREADCRUMB_EXPANDED_MAX, BREADCRUMB_REFRESH_MS, BREADCRUMB_SIBLING_LIMIT, presentTrail, type BreadcrumbReadable, type BreadcrumbSegment } from "./breadcrumb-model";

const crumb = (id: string, title = id, extra: Partial<BreadcrumbReadable> = {}): BreadcrumbReadable => ({
  readable: true, kind: "page", id, title, href: `/pages/${id}`, current: false, siblings: [], siblingsTruncated: false, ...extra,
});

it("keeps a depth-4 trail expanded and collapses the middle of a depth-9 trail", () => {
  expect(BREADCRUMB_EXPANDED_MAX).toBe(4);
  expect(BREADCRUMB_SIBLING_LIMIT).toBe(20);
  expect(BREADCRUMB_REFRESH_MS).toBeLessThanOrEqual(5_000);
  const depth4: BreadcrumbSegment[] = [
    crumb("space", "Product", { kind: "space", href: "/workspaces/ws/spaces/space" }),
    crumb("p100", "P-100"),
    crumb("p103", "P-103"),
    crumb("p105", "P-105", { current: true }),
  ];
  const full = presentTrail(depth4, false);
  expect(full.layout).toBe("trail");
  if (full.layout !== "trail") return;
  expect(full.items.map(item => item.type === "crumb" ? item.segment.title : item.type)).toEqual(["Product", "P-100", "P-103", "P-105"]);
  expect(full.items.some(item => item.type === "collapsed")).toBe(false);

  const deep: BreadcrumbSegment[] = [crumb("space", "Product", { kind: "space" }), ...Array.from({ length: 8 }, (_, index) => crumb(`p${index + 1}`, `P-${index + 1}`, { current: index === 7 }))];
  expect(deep).toHaveLength(9);
  const collapsed = presentTrail(deep, false);
  expect(collapsed.layout).toBe("trail");
  if (collapsed.layout !== "trail") return;
  expect(collapsed.items.map(item => item.type)).toEqual(["crumb", "collapsed", "crumb", "crumb"]);
  const menu = collapsed.items[1];
  expect(menu.type).toBe("collapsed");
  if (menu.type !== "collapsed") return;
  expect(menu.segments.map(segment => segment.title)).toEqual(["P-1", "P-2", "P-3", "P-4", "P-5", "P-6"]);
  const parent = collapsed.items[2];
  const current = collapsed.items[3];
  expect(parent.type === "crumb" && parent.segment.title).toBe("P-7");
  expect(current.type === "crumb" && current.segment.current).toBe(true);
});

it("shows only the parent on a narrow viewport and keeps a hidden gap as an ellipsis", () => {
  const segments: BreadcrumbSegment[] = [
    crumb("space", "Product", { kind: "space" }),
    crumb("p100", "P-100"),
    { readable: false },
    crumb("p105", "P-105", { current: true }),
  ];
  const desktop = presentTrail(segments, false);
  expect(desktop.layout).toBe("trail");
  if (desktop.layout !== "trail") return;
  expect(desktop.items.map(item => item.type === "hidden" ? "…" : item.type === "crumb" ? item.segment.title : "menu")).toEqual(["Product", "P-100", "…", "P-105"]);
  const mobile = presentTrail(segments, true);
  expect(mobile).toEqual({ layout: "back", parent: { readable: false } });
  const rooted = presentTrail([crumb("space", "Product", { kind: "space" }), crumb("p105", "P-105", { current: true })], true);
  expect(rooted.layout).toBe("back");
  if (rooted.layout !== "back" || !rooted.parent?.readable) return;
  expect(rooted.parent.title).toBe("Product");
});
