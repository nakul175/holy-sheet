import { describe, expect, it } from "vitest";
import type { Page } from "./types";
import { parseQuery, searchPages } from "./search";

const page = (overrides: Partial<Page>): Page => ({ id: "one", workspaceId: "w", workspaceName: "Work", spaceId: "s", spaceName: "Product", parentPageId: null, title: "Release plan", visibility: "private", version: 1, updatedAt: "2026-01-01T00:00:00Z", blocks: [{ id: "b", pageId: "one", parentBlockId: null, type: "paragraph", text: "Coordinate the SHO integration launch", position: 0 }], ...overrides });

describe("searchPages", () => {
  it("supports quoted phrases and final-word prefixes", () => {
    expect(parseQuery('"SHO integration" lau')).toEqual({ phrases: ["sho integration"], terms: ["lau"], prefix: "lau" });
    expect(searchPages([page({})], '"SHO integration" lau')).toHaveLength(1);
  });
  it("ranks exact titles before title and content matches", () => {
    const results = searchPages([page({ id: "body", title: "Notes" }), page({ id: "partial", title: "Release plan draft" }), page({ id: "exact" })], "Release plan");
    expect(results.map((item) => item.id)).toEqual(["exact", "partial"]);
  });
  it("filters by space and ignores one-character searches", () => {
    expect(searchPages([page({})], "r")).toEqual([]);
    expect(searchPages([page({})], "Release", "other")).toEqual([]);
  });
});
