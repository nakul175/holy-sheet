import { expect, it } from "vitest";
import {
  SEARCH_JUMP_UNAVAILABLE,
  SEARCH_LINK_COPIED,
  SEARCH_SHORTCUT_HINT,
  canonicalSearchHref,
  createPageActionLabel,
  createRecordActionLabel,
  headingMatches,
  parseBlockFragment,
  parseJumpQuery,
  permittedSearchActions,
  recordIdFromHit,
  searchResultShortcut,
} from "./search-jump-model";

it("lists only permitted actions for a page, a record, a viewer, and a trashed target", () => {
  expect(permittedSearchActions({ kind: "page", hasHeadings: true }, true)).toEqual(["open", "open-tab", "copy-link", "insert-link", "jump-section"]);
  expect(permittedSearchActions({ kind: "page", hasHeadings: false }, true)).not.toContain("jump-section");
  expect(permittedSearchActions({ kind: "record" }, true)).toEqual(["open", "open-tab", "copy-link", "insert-chip", "insert-card", "peek-record"]);
  expect(permittedSearchActions({ kind: "record" }, false)).toEqual(["open", "open-tab", "copy-link", "peek-record"]);
  expect(permittedSearchActions({ kind: "page", hasHeadings: true, trashed: true }, true)).toEqual(["open", "open-tab", "copy-link"]);
});

it("maps result shortcuts and ignores an insert the actor cannot perform", () => {
  const editing = permittedSearchActions({ kind: "record" }, true);
  const viewing = permittedSearchActions({ kind: "record" }, false);
  expect(searchResultShortcut({ key: "Enter" }, editing)).toBe("open");
  expect(searchResultShortcut({ key: "Enter", metaKey: true }, editing)).toBe("open-tab");
  expect(searchResultShortcut({ key: "Enter", ctrlKey: true }, editing)).toBe("open-tab");
  expect(searchResultShortcut({ key: "Enter", shiftKey: true }, editing)).toBe("insert-chip");
  expect(searchResultShortcut({ key: "Enter", shiftKey: true }, viewing)).toBeNull();
  expect(searchResultShortcut({ key: "c", ctrlKey: true, shiftKey: true }, viewing)).toBe("copy-link");
  expect(searchResultShortcut({ key: "Enter", altKey: true }, editing)).toBeNull();
  expect(SEARCH_SHORTCUT_HINT).toContain("Enter");
  expect(SEARCH_SHORTCUT_HINT).toContain("Shift+Enter");
  expect(SEARCH_LINK_COPIED).toBe("Link copied");
  expect(SEARCH_JUMP_UNAVAILABLE).toBe("This item is no longer available");
});

it("parses a heading jump and keeps create labels free of hidden-match wording", () => {
  expect(parseJumpQuery("runbook > esc")).toEqual({ pageQuery: "runbook", headingQuery: "esc" });
  expect(parseJumpQuery("no arrow")).toBeNull();
  expect(headingMatches("Escalation", "esc")).toBe(true);
  expect(headingMatches("Setup", "esc")).toBe(false);
  expect(parseBlockFragment("#block-heading-1")).toBe("heading-1");
  expect(parseBlockFragment("#hs-heading=heading-1")).toBeNull();
  expect(canonicalSearchHref({ id: "page-1", href: "/pages/page-1" })).toBe("/pages/page-1");
  expect(recordIdFromHit("record:00000000-0000-4000-8000-000000000010")).toBe("00000000-0000-4000-8000-000000000010");
  const page = createPageActionLabel("Vendor offboarding", "Product");
  const record = createRecordActionLabel("Vendor offboarding", "Organisations");
  expect(page).toBe('Create page "Vendor offboarding" in Product');
  expect(record).toContain("Organisations");
  expect(`${page} ${record}`.toLowerCase()).not.toMatch(/hidden|restricted|already exists/);
});
