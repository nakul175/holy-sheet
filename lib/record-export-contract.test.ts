import { expect, it } from "vitest";
import { standardCollections } from "./shared-record-types";
import {
  acceptedExport,
  acceptedExportCancellation,
  explicitExportColumns,
  exportDownloadBody,
  exportPrepareBody,
  exportPrepareRetiresId,
  recordExportCollections,
  recordExportScope,
  RecordExportRequestError,
  viewExportScope,
  withheldReferenceFields,
  type ExportJobView,
} from "./record-export-contract";

const viewId = "00000000-0000-4000-8000-0000000000b1";
const recordA = "00000000-0000-4000-8000-0000000000a1";
const recordB = "00000000-0000-4000-8000-0000000000a2";
const jobId = "00000000-0000-4000-8000-0000000000c1";
const hash = "ab".repeat(32);
const secret = "Private export cell";
const notes = "core:notes";
const preview = (extra: Record<string, unknown> = {}) => ({
  id: jobId,
  collection: "organisations",
  format: "csv",
  rowCount: 2,
  columns: [{ key: "name", label: "Name", kind: "text" }],
  warnings: [],
  reviewHash: hash,
  state: "ready",
  createdAt: "2026-10-31T00:00:00.000Z",
  expiresAt: "2026-10-31T00:15:00.000Z",
  pinned: true,
  ...extra,
});
const viewInput = { collection: "organisations", viewId, expectedViewVersion: 3, viewColumnCount: 2, expectedSchemaVersion: 4, format: "csv", includeIds: false, includeRelationships: false };

it("keeps the export collection allowlist aligned with native collections", () => {
  expect([...recordExportCollections]).toEqual([...standardCollections]);
});

it("builds a saved-view scope without ids, relationships or a column list", () => {
  expect(viewExportScope(viewInput)).toEqual({ kind: "view", viewId, expectedViewVersion: 3, expectedSchemaVersion: 4, format: "csv", includeIds: false, includeRelationships: false });
  expect(viewExportScope({ ...viewInput, includeIds: true, includeRelationships: true })).toBeNull();
  expect(viewExportScope({ ...viewInput, collection: "accounts", includeRelationships: true })?.includeRelationships).toBe(true);
  expect(viewExportScope({ ...viewInput, viewColumnCount: 100, includeIds: true })).toBeNull();
  expect(viewExportScope({ ...viewInput, expectedViewVersion: 0 })).toBeNull();
  expect(exportPrepareBody("not-an-id", viewExportScope(viewInput))).toBeNull();
});

it("rejects duplicate records, reserved id columns and reference fields on an explicit scope", () => {
  const allowed = explicitExportColumns([
    { key: notes, label: "Notes", kind: "long-text" },
    { key: recordA, label: "Brief", kind: "attachment" },
    { key: recordB, label: "Linked record", kind: "record" },
    { key: "id", label: "Identifier", kind: "text" },
  ]).map((column) => column.key);
  expect(allowed).toEqual(["name", notes]);
  expect(withheldReferenceFields([{ key: recordA, label: "Brief", kind: "attachment" }])).toEqual([{ key: recordA, label: "Brief", kind: "attachment" }]);
  const input = { collection: "organisations", recordIds: [recordA, recordB], columns: ["name", notes], allowedColumns: allowed, expectedSchemaVersion: 4, format: "xlsx", includeIds: false, includeRelationships: false };
  expect(recordExportScope(input)).toMatchObject({ kind: "records", recordIds: [recordA, recordB], columns: ["name", notes], includeIds: false, includeRelationships: false });
  expect(recordExportScope({ ...input, recordIds: [recordA, recordA] })).toBeNull();
  expect(recordExportScope({ ...input, columns: ["name", "name"] })).toBeNull();
  expect(recordExportScope({ ...input, columns: ["id"] })).toBeNull();
  expect(recordExportScope({ ...input, columns: ["parentOrganisationId"] })).toBeNull();
  expect(recordExportScope({ ...input, columns: [recordA] })).toBeNull();
  expect(recordExportScope({ ...input, includeRelationships: true })).toBeNull();
  expect(recordExportScope({ ...input, recordIds: [] })).toBeNull();
});

it("accepts a pinned preview and drops cell payloads", () => {
  const accepted = acceptedExport(preview({ rows: [{ name: secret }], entries: [{ cells: [secret] }], snapshot: secret }));
  expect(accepted).toMatchObject({ id: jobId, pinned: true, rowCount: 2, warnings: [], reviewHash: hash });
  expect(JSON.stringify(accepted)).not.toContain(secret);
  expect(acceptedExport(preview({ pinned: false }))).toBeNull();
  expect(acceptedExport(preview({ state: "cancelled" }))).toBeNull();
  expect(acceptedExport(preview({ warnings: [`=${secret}`] }))).toBeNull();
  expect(acceptedExport(preview({ columns: [{ key: "name", label: "Name", kind: "text" }, { key: "name", label: "Name", kind: "text" }] }))).toBeNull();
  expect(acceptedExportCancellation({ id: jobId, state: "cancelled", snapshot: secret }, jobId)).toEqual({ id: jobId, state: "cancelled" });
  expect(acceptedExportCancellation({ id: jobId, state: "ready" }, jobId)).toBeNull();
});

it("requires acknowledgement only when the snapshot carries a warning", () => {
  const job = acceptedExport(preview({ warnings: ["csv-spreadsheet-text-escaping"] })) as ExportJobView;
  expect(exportDownloadBody(job, false)).toBeNull();
  expect(exportDownloadBody(job, true)).toEqual({ reviewHash: hash, acknowledgeEscaping: true });
  const plain = acceptedExport(preview()) as ExportJobView;
  expect(exportDownloadBody(plain, false)).toEqual({ reviewHash: hash, acknowledgeEscaping: false });
  expect(exportPrepareRetiresId(new RecordExportRequestError("expired", 410, "record_export_expired", false))).toBe(true);
  expect(exportPrepareRetiresId(new RecordExportRequestError("busy", 503, "service_unavailable", true))).toBe(false);
});
