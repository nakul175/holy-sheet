import { expect, it } from "vitest";
import {
  assertPlacement,
  hierarchyDocument,
  hierarchyLimits,
  siblingPage,
  subtreeIds,
  visibleAncestry,
} from "./collection-hierarchy-plan";

const chain = (size: number) => Array.from({ length: size }, (_, index) => ({ id: `n${index}`, parentId: index === 0 ? null : `n${index - 1}` }));

it("allows one parent, a depth of 20, and a root when the schema permits it", () => {
  expect(() => assertPlacement(chain(19), "n19", "n18", 20, true)).not.toThrow();
  expect(() => assertPlacement([{ id: "root", parentId: null }], "child", null, 20, true)).not.toThrow();
  expect(() => assertPlacement(chain(20), "extra", "n19", 20, true)).toThrow(/depth/i);
  expect(() => assertPlacement([], "root", null, 20, false)).toThrow(/without a parent/);
  expect(() => assertPlacement(chain(2), "n0", "n0", 20, true)).toThrow(/parent/i);
  expect(() => assertPlacement(chain(3), "n0", "n2", 20, true)).toThrow(/parent/i);
  expect(hierarchyLimits.depth).toBe(20);
  expect(hierarchyLimits.siblings).toBe(50);
});

it("pages visible siblings and keeps hidden ancestors out of the chain", () => {
  const rows = Array.from({ length: 51 }, (_, index) => ({ id: `s${index}`, name: `S${index}` }));
  const page = siblingPage(rows);
  expect(page.entries).toHaveLength(50);
  expect(page.more).toBe(true);
  expect(page).not.toHaveProperty("total");
  expect(page).not.toHaveProperty("count");
  const nodes = [{ id: "root", parentId: null }, { id: "hidden", parentId: "root" }, { id: "child", parentId: "hidden" }];
  expect(visibleAncestry(nodes, "child", new Set(["root", "child"]))).toEqual([]);
  expect(visibleAncestry(nodes, "child", new Set(["root", "hidden", "child"]))).toEqual(["root", "hidden"]);
  expect(subtreeIds(nodes, "root")).toEqual(["root", "hidden", "child"]);
  const document = hierarchyDocument("Assets", [{ name: "Child", parentName: null }]);
  expect(document).toContain("Child");
  expect(document).not.toContain("hidden");
  expect(document).toContain("does not grant access");
});
