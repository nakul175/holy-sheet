import { describe, expect, it } from "vitest";
import {
  classifySourceEdit,
  effectiveReview,
  impactReport,
  traverseDependencies,
  unrelatedMetadataRule,
  type PlanEdge,
} from "./dependency-impact-plan";

const edge = (id: string, sourceId: string, dependentPageId: string, permitted = true): PlanEdge => ({
  id, kind: "link", sourceId, dependentPageId, sourceState: "active", permitted,
});

describe("dependency impact plan", () => {
  it("treats an unchanged document digest as unrelated metadata", () => {
    expect(classifySourceEdit("same", "same")).toEqual({ effect: "metadata", rule: unrelatedMetadataRule, marksReview: false });
    expect(classifySourceEdit("before", "after").marksReview).toBe(true);
  });

  it("marks an acknowledgement stale when the dependent revision moved", () => {
    expect(effectiveReview({ reviewState: "acknowledged", sourceRevision: 3, acknowledgedSourceRevision: 3, acknowledgedDependentRevision: 4, liveDependentRevision: 5 })).toBe("stale");
    expect(effectiveReview({ reviewState: "acknowledged", sourceRevision: 3, acknowledgedSourceRevision: 3, acknowledgedDependentRevision: 4, liveDependentRevision: 4 })).toBe("acknowledged");
    expect(effectiveReview({ reviewState: "needs_review", sourceRevision: 3, acknowledgedSourceRevision: null, acknowledgedDependentRevision: null, liveDependentRevision: 4 })).toBe("needs_review");
  });

  it("walks a cycle once and stops at the page bound", () => {
    const cyclic = traverseDependencies({
      start: { type: "source", id: "a" },
      edges: [edge("1", "a", "b"), edge("2", "b", "a")],
      sources: { a: { state: "active", mergedIntoId: null }, b: { state: "active", mergedIntoId: null } },
      limit: 50,
    });
    expect(cyclic.pages).toEqual(["b", "a"]);
    expect(cyclic.edges.map(item => item.cycle)).toEqual([false, true]);
    expect(cyclic.truncated).toBe(false);
    const chain = Array.from({ length: 60 }, (_, index) => edge(String(index), `p${index}`, `p${index + 1}`));
    const bounded = traverseDependencies({
      start: { type: "page", id: "p0" },
      edges: chain,
      sources: {},
      limit: 50,
    });
    expect(bounded.pages).toHaveLength(50);
    expect(bounded.truncated).toBe(true);
    expect(bounded.pages).not.toContain("p59");
  });

  it("omits hidden edges, stops under a retired source, and follows a merged source once", () => {
    const hidden = traverseDependencies({
      start: { type: "source", id: "a" },
      edges: [edge("visible", "a", "b"), edge("secret", "a", "hidden", false)],
      sources: { a: { state: "active", mergedIntoId: null } },
      limit: 50,
    });
    expect(hidden.pages).toEqual(["b"]);
    expect(JSON.stringify(hidden)).not.toContain("hidden");
    const retired = traverseDependencies({
      start: { type: "source", id: "a" },
      edges: [edge("1", "a", "b"), edge("2", "b", "c")],
      sources: { a: { state: "retired", mergedIntoId: null }, b: { state: "active", mergedIntoId: null } },
      limit: 50,
    });
    expect(retired.pages).toEqual(["b"]);
    expect(retired.edges[0].sourceState).toBe("retired");
    const merged = traverseDependencies({
      start: { type: "source", id: "a" },
      edges: [edge("1", "a", "b"), edge("2", "d", "e")],
      sources: { a: { state: "merged", mergedIntoId: "d" }, d: { state: "active", mergedIntoId: null } },
      limit: 50,
    });
    expect(merged.pages).toEqual(["b", "e"]);
    const loop = traverseDependencies({
      start: { type: "source", id: "a" },
      edges: [edge("1", "a", "b")],
      sources: { a: { state: "merged", mergedIntoId: "a" } },
      limit: 50,
    });
    expect(loop.pages).toEqual(["b"]);
  });

  it("builds a report from titles and review state only", () => {
    const report = impactReport([{ kind: "snippet", sourceTitle: "Dose", sourceRevision: 2, dependentTitle: "Ward", reviewLabel: "Needs review", reason: "Source material changed at revision 2", sourceState: "active" }]);
    expect(report).toContain("Snippet · Dose · revision 2 · Ward · Needs review · Source material changed at revision 2 · active");
    expect(report).not.toContain("body");
  });
});
