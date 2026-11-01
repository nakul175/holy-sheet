import { expect, it } from "vitest";
import { validateDocument } from "./document";
import { renderMarkdown, type ExportInput } from "./export-plan";
import { formatRecordFieldValue, planRecordRefBatches, purgeRecordRefKeys, readerSort, recordRefAttributeError, restrictedRecordPlaceholder } from "./record-page-refs";

const recordId = "00000000-0000-4000-8000-000000000100";
const viewId = "00000000-0000-4000-8000-000000000200";
const block = (type: string, attrs: Record<string, unknown>) => ({ type: "doc", content: [{ type, attrs: { id: "block-1", nodeVersion: 1, ...attrs } }] });

it("saves chip and card config without field values", () => {
  const chip = validateDocument(block("recordRef", { recordId, collectionId: "organisations", display: "chip", fields: [] }));
  const card = validateDocument(block("recordRef", { recordId, collectionId: "organisations", display: "card", fields: ["core:notes", "core:domain"] }));
  expect(JSON.stringify(chip)).not.toContain("value");
  expect(card.content?.[0].attrs).toMatchObject({ recordId, collectionId: "organisations", display: "card", fields: ["core:notes", "core:domain"] });
  expect(() => validateDocument(block("recordRef", { recordId, collectionId: "organisations", display: "chip", fields: ["core:notes"] }))).toThrow(/chips/i);
  expect(() => validateDocument(block("recordRef", { recordId, collectionId: "organisations", display: "card", fields: ["core:notes"], secret: "250000" }))).toThrow(/Unsupported attributes/);
  expect(recordRefAttributeError("recordRef", { nodeVersion: 2, recordId, collectionId: "organisations", display: "chip", fields: [] })).toMatch(/version/i);
});

it("accepts a live view block and rejects stored row values", () => {
  const view = validateDocument(block("recordView", { viewId, collectionId: "organisations", layout: "table", columns: ["name", "core:notes"], limit: 10 }));
  expect(view.content?.[0].attrs).toMatchObject({ viewId, layout: "table", limit: 10 });
  expect(() => validateDocument(block("recordView", { viewId, collectionId: "organisations", layout: "table", columns: ["name"], limit: 10, rows: [] }))).toThrow(/Unsupported attributes/);
});

it("formats visible values and drops unknown objects", () => {
  expect(formatRecordFieldValue({ currency: "INR", minorUnits: "250000", scale: 2 })).toBe("INR 250000");
  expect(formatRecordFieldValue({ secret: "250000" })).toBe("");
  expect(readerSort([{ field: "secret", direction: "desc" }, { field: "name", direction: "asc" }], new Set())).toEqual([{ field: "name", direction: "asc" }]);
  expect(readerSort([{ field: "core:notes", direction: "desc" }], new Set(["core:notes"]))).toEqual([{ field: "core:notes", direction: "desc" }]);
});

it("keeps a full page of chips, cards and views inside three requests", () => {
  expect(planRecordRefBatches(60, 3)).toMatchObject({ requests: 1, deferredRecords: 0, deferredViews: 0 });
  expect(planRecordRefBatches(50, 3).requests).toBeLessThanOrEqual(3);
  expect(restrictedRecordPlaceholder).toEqual({ status: "restricted" });
});

it("exports a readable record as a link and a hidden record as the neutral label", () => {
  const input = (available: boolean): ExportInput => ({
    title: "Page", document: block("recordRef", { recordId, collectionId: "organisations", display: "chip", fields: [] }), version: 1, createdAt: "2026-10-31T00:00:00.000Z", format: "markdown", origin: "https://hs.example", references: {},
    recordReferences: { [recordId]: available ? { kind: "record", available: true, title: "Northwind", url: "https://hs.example/workspaces/ws/tenants/t/records?collection=organisations&record=" + recordId, fields: [{ label: "Notes", value: "Shown" }, { label: "Contract Value", value: null }] } : { kind: "record", available: false } },
  });
  expect(renderMarkdown(input(true))).toContain("[Record: Northwind](<https://hs.example/workspaces/ws/tenants/t/records?collection=organisations&record=" + recordId + ">)");
  expect(renderMarkdown(input(true))).toContain("Contract Value: —");
  expect(renderMarkdown(input(false))).toContain("Restricted record");
  expect(renderMarkdown(input(false))).not.toContain("Northwind");
  expect(purgeRecordRefKeys(["draft", "hs-record-ref:1", "other"])).toEqual(["hs-record-ref:1"]);
});
