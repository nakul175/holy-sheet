import { beforeEach, expect, it, vi } from "vitest";
import { DocumentError } from "./document";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  repository: vi.fn(),
  stageImport: vi.fn(),
  configureImport: vi.fn(),
  reviewImportBatch: vi.fn(),
  getImport: vi.fn(),
  commitImportBatch: vi.fn(),
  cancelImport: vi.fn(),
  importReport: vi.fn(),
  constructed: [] as unknown[][],
}));
vi.mock("./suite-tenant-authority", () => ({ authenticateRecordAuthority: mocks.authenticate }));
vi.mock("./repository", () => ({ repository: mocks.repository }));
vi.mock("./shared-record-imports", () => ({
  SharedRecordImportRepository: class {
    constructor(...args: unknown[]) { mocks.constructed.push(args); }
    stageImport = mocks.stageImport;
    configureImport = mocks.configureImport;
    reviewImportBatch = mocks.reviewImportBatch;
    getImport = mocks.getImport;
    commitImportBatch = mocks.commitImportBatch;
    cancelImport = mocks.cancelImport;
    importReport = mocks.importReport;
  },
}));
import { POST as stage } from "../app/api/v1/workspaces/[id]/tenants/[tenantId]/record-imports/route";
import { GET, POST } from "../app/api/v1/workspaces/[id]/tenants/[tenantId]/record-imports/[jobId]/route";
import { GET as report } from "../app/api/v1/workspaces/[id]/tenants/[tenantId]/record-imports/[jobId]/report/route";

const tenantId = "00000000-0000-4000-8000-000000000002";
const jobId = "00000000-0000-4000-8000-0000000000c1";
const commandId = "00000000-0000-4000-8000-0000000000d1";
const reviewHash = "ab".repeat(32);
const authority = { verify: vi.fn() };
const scope = () => ({ params: Promise.resolve({ id: "workspace-a", tenantId }) });
const detail = () => ({ params: Promise.resolve({ id: "workspace-a", tenantId, jobId }) });
const metadata = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const source = { id: jobId, collection: "organisations", name: "people.csv", format: "csv" as const };
const binary = (bytes: Uint8Array) => new Blob([bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer]);
const stageRequest = (value: unknown, bytes: Uint8Array = Buffer.from("Name,Notes\nAda,Hello"), origin = "https://hs.example", type = "application/octet-stream") => new Request("https://hs.example/api/record-imports", { method: "POST", headers: { Origin: origin, "Content-Type": type, "x-hs-record-import": metadata(value) }, body: binary(bytes) });
const command = (data: unknown, origin = "https://hs.example") => new Request(`https://hs.example/api/record-imports/${jobId}`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(data) });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.constructed.length = 0;
  vi.stubEnv("HS_ORIGIN", "https://hs.example");
  mocks.authenticate.mockResolvedValue({ actor: { id: "verified-user" }, authority });
  mocks.repository.mockResolvedValue({});
});

it("stages one binary source through suite-tenant authority and retries the same job id", async () => {
  const staged = { id: jobId, state: "staged", version: 1 };
  mocks.stageImport.mockResolvedValue(staged);
  const bytes = Buffer.from("Name,Notes\nAda,Hello");
  const response = await stage(stageRequest({ ...source, sheetIndex: 2, format: "xlsx", name: "people.xlsx" }, bytes), scope());
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual(staged);
  expect(mocks.stageImport).toHaveBeenCalledWith(expect.objectContaining({ actor: { id: "verified-user" }, workspaceId: "workspace-a", tenantId }), { ...source, name: "people.xlsx", format: "xlsx", sheetIndex: 2 }, expect.any(Buffer));
  expect(Buffer.compare(mocks.stageImport.mock.calls[0][2], bytes)).toBe(0);
  expect(mocks.constructed).toEqual([[{}, authority]]);
  const again = await stage(stageRequest(source, bytes), scope());
  expect(again.status).toBe(200);
  expect(mocks.stageImport).toHaveBeenLastCalledWith(expect.anything(), source, expect.any(Buffer));
});

it("rejects a cross-origin, forged, oversized or wrongly typed source before staging", async () => {
  expect((await stage(stageRequest(source, Buffer.from("Name\nAda"), "https://attacker.example"), scope())).status).toBe(403);
  expect(mocks.authenticate).not.toHaveBeenCalled();
  mocks.authenticate.mockResolvedValue({ actor: { id: "verified-user" }, authority });
  expect((await stage(stageRequest({ ...source, grants: ["secret"] }), scope())).status).toBe(400);
  expect((await stage(stageRequest(source, Buffer.from("Name\nAda"), "https://hs.example", "text/csv"), scope())).status).toBe(400);
  expect((await stage(stageRequest(source, Buffer.alloc(20 * 1024 * 1024 + 1)), scope())).status).toBe(413);
  expect(mocks.stageImport).not.toHaveBeenCalled();
  mocks.authenticate.mockRejectedValue(new DocumentError("Structured records are not enabled in this environment.", "record_feature_disabled", 503));
  const disabled = await stage(stageRequest(source), scope());
  expect(disabled.status).toBe(503);
  expect(await disabled.json()).toMatchObject({ code: "record_feature_disabled", retryable: true });
  expect(mocks.stageImport).not.toHaveBeenCalled();
});

it("forwards preview, mapping, review, commit and cancel without a unique-key or relationship shortcut", async () => {
  mocks.getImport.mockResolvedValue({ id: jobId, rows: [] });
  const listed = await GET(new Request(`https://hs.example/api/record-imports/${jobId}?offset=50`), detail());
  expect(listed.status).toBe(200);
  expect(listed.headers.get("cache-control")).toBe("no-store");
  expect(mocks.getImport).toHaveBeenCalledWith(expect.objectContaining({ actor: { id: "verified-user" }, workspaceId: "workspace-a", tenantId }), jobId, 50);
  expect((await GET(new Request(`https://hs.example/api/record-imports/${jobId}?offset=1.5`), detail())).status).toBe(400);
  const mapping = { mode: "create", nameColumn: 0, fields: [{ column: 1, fieldKey: "core:notes" }] };
  mocks.configureImport.mockResolvedValue({ id: jobId, state: "reviewing", version: 2 });
  expect((await POST(command({ kind: "configure", expectedVersion: 1, mapping }), detail())).status).toBe(200);
  expect(mocks.configureImport).toHaveBeenCalledWith(expect.anything(), jobId, { expectedVersion: 1, mapping });
  expect((await POST(command({ kind: "configure", expectedVersion: 1, mapping, uniqueKey: "name" }), detail())).status).toBe(400);
  expect((await POST(command({ kind: "configure", expectedVersion: 1, mapping: { ...mapping, reparent: true } }), detail())).status).toBe(400);
  mocks.reviewImportBatch.mockResolvedValue({ id: jobId, state: "reviewed", reviewHash });
  expect((await POST(command({ kind: "review", expectedVersion: 2 }), detail())).status).toBe(200);
  expect(mocks.reviewImportBatch).toHaveBeenCalledWith(expect.anything(), jobId, { expectedVersion: 2 });
  const commit = { kind: "commit", id: commandId, expectedVersion: 3, reviewHash, confirm: "create-records", allowValidSubset: true, allowDuplicates: false, acknowledgeWarnings: true };
  mocks.commitImportBatch.mockResolvedValue({ id: jobId, state: "completed" });
  expect((await POST(command(commit), detail())).status).toBe(200);
  const { kind: _, ...forwarded } = commit;
  expect(mocks.commitImportBatch).toHaveBeenCalledWith(expect.anything(), jobId, forwarded);
  expect((await POST(command({ ...commit, reparent: true }), detail())).status).toBe(400);
  mocks.cancelImport.mockResolvedValue({ id: jobId, state: "cancelled" });
  expect((await POST(command({ kind: "cancel", expectedVersion: 4 }), detail())).status).toBe(200);
  expect(mocks.cancelImport).toHaveBeenCalledWith(expect.anything(), jobId, 4);
  expect((await POST(command({ kind: "review", expectedVersion: 2 }, "https://attacker.example"), detail())).status).toBe(403);
  expect(mocks.constructed.every((args) => args.length === 2 && args[1] === authority)).toBe(true);
});

it("returns the service error report without wrapping values into JSON", async () => {
  const csv = Buffer.from("\ufeff\"Source row\",\"Status\",\"Columns\",\"Issue codes\"\r\n\"2\",\"invalid\",\"2\",\"field_value_invalid\"\r\n", "utf8");
  mocks.importReport.mockResolvedValue({ filename: "record-import-report.csv", contentType: "text/csv; charset=utf-8", bytes: csv, rows: 1 });
  const response = await report(new Request(`https://hs.example/api/record-imports/${jobId}/report`), detail());
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("text/csv");
  expect(response.headers.get("content-disposition")).toBe('attachment; filename="record-import-report.csv"');
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(Buffer.from(await response.arrayBuffer()).equals(csv)).toBe(true);
  mocks.importReport.mockResolvedValue({ filename: "people.csv", contentType: "text/plain", bytes: csv, rows: 1 });
  const replaced = await report(new Request(`https://hs.example/api/record-imports/${jobId}/report`), detail());
  expect(replaced.headers.get("content-type")).toContain("text/csv");
  expect(replaced.headers.get("content-disposition")).toBe('attachment; filename="record-import-report.csv"');
  mocks.importReport.mockRejectedValue(new DocumentError("The private import staging copy expired after 24 hours.", "record_import_expired", 410));
  const expired = await report(new Request(`https://hs.example/api/record-imports/${jobId}/report`), detail());
  expect(expired.status).toBe(410);
  expect(await expired.json()).toMatchObject({ code: "record_import_expired" });
});
