import { expect, it } from "vitest";
import {
  assertHierarchy,
  classificationCode,
  classificationDocument,
  classificationLabel,
  classificationScope,
  facetCounts,
  nextMembership,
  remapAssignments,
  tagSelectable,
} from "./classification-plan";

it("keeps codes and labels stable and scoped", () => {
  expect(classificationCode(" clinic-1 ")).toBe("CLINIC-1");
  expect(() => classificationCode("has space")).toThrow(/stable tag code/);
  expect(classificationLabel(" Ward ")).toBe("Ward");
  expect(() => classificationLabel("")).toThrow(/tag label/);
  const known = new Set(["contacts", "organisations"]);
  expect(classificationScope(true, ["organisations", "contacts"], known)).toEqual({ documents: true, collections: ["contacts", "organisations"] });
  expect(() => classificationScope(false, ["missing"], known)).toThrow(/collections/);
});

it("rejects a cycle and hides deprecated tags from new selection", () => {
  const tags = [{ id: "a", parentId: null }, { id: "b", parentId: "a" }];
  expect(() => assertHierarchy(tags, "a", "b")).toThrow(/cycle/);
  expect(() => assertHierarchy(tags, "a", "missing")).toThrow(/cycle/);
  assertHierarchy(tags, "b", null);
  expect(tagSelectable("deprecated", true, ["contacts"], { kind: "page" })).toBe(false);
  expect(tagSelectable("active", true, [], { kind: "page" })).toBe(true);
  expect(tagSelectable("active", false, ["contacts"], { kind: "record", collection: "organisations" })).toBe(false);
});

it("preserves hidden membership and omits hidden facet rows", () => {
  const visible = new Set(["shown", "fresh"]);
  const assignable = new Set(["shown", "fresh"]);
  const changed = nextMembership(["shown", "secret"], ["fresh"], visible, assignable);
  expect(changed).toMatchObject({ ok: true, next: ["secret", "fresh"], added: ["fresh"], removed: ["shown"] });
  expect(nextMembership(["shown"], ["shown", "shown"], visible, assignable)).toMatchObject({ ok: false, reason: "duplicate" });
  expect(nextMembership(["shown"], ["secret"], visible, assignable)).toMatchObject({ ok: false, reason: "hidden" });
  const facets = facetCounts([
    { tagId: "hidden", code: "SECRET", label: "Secret", tagVisible: false, targets: [{ id: "r1", visible: true }] },
    { tagId: "empty", code: "NONE", label: "None", tagVisible: true, targets: [{ id: "r2", visible: false }] },
    { tagId: "shown", code: "CLINIC", label: "Clinic", tagVisible: true, targets: [{ id: "r1", visible: true }, { id: "r2", visible: false }] },
  ]);
  expect(facets).toEqual([{ tagId: "shown", code: "CLINIC", label: "Clinic", count: 1 }]);
  expect(JSON.stringify(facets)).not.toContain("SECRET");
  expect(JSON.stringify(facets)).not.toContain("r2");
});

it("remaps every reference once and keeps the download free of hidden tags", () => {
  const rows = [
    { tagId: "old", targetKind: "page", targetId: "visible" },
    { tagId: "old", targetKind: "record", targetId: "secret" },
    { tagId: "next", targetKind: "record", targetId: "secret" },
  ];
  const remapped = remapAssignments(rows, "old", "next");
  expect(remapped.changed).toHaveLength(2);
  expect(remapped.next.filter(row => row.tagId === "old")).toEqual([]);
  expect(remapped.next.filter(row => row.targetId === "secret")).toEqual([{ tagId: "next", targetKind: "record", targetId: "secret" }]);
  const body = classificationDocument({ kind: "page", title: "Visible clinic" }, [{ code: "CLINIC", label: "Clinic", status: "deprecated" }]);
  expect(body).toContain("CLINIC — Clinic (deprecated)");
  expect(body).toContain("does not grant access");
  expect(body).not.toContain("secret");
});
