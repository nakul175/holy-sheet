import { beforeEach, expect, it, vi } from "vitest";
import { DocumentError } from "./document";
import { recordExportRequestLimit } from "./record-export-contract";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  repository: vi.fn(),
  prepareRecordExport: vi.fn(),
  getRecordExport: vi.fn(),
  cancelRecordExport: vi.fn(),
  downloadRecordExport: vi.fn(),
  constructed: [] as unknown[][],
}));
vi.mock("./suite-tenant-authority", () => ({ authenticateRecordAuthority: mocks.authenticate }));
vi.mock("./repository", () => ({ repository: mocks.repository }));
vi.mock("./shared-record-exports", () => ({
  SharedRecordExportRepository: class {
    constructor(...args: unknown[]) { mocks.constructed.push(args); }
    prepareRecordExport = mocks.prepareRecordExport;
    getRecordExport = mocks.getRecordExport;
    cancelRecordExport = mocks.cancelRecordExport;
    downloadRecordExport = mocks.downloadRecordExport;
  },
}));
import { POST as prepare } from "../app/api/v1/workspaces/[id]/tenants/[tenantId]/record-exports/route";
import { GET, POST as cancel } from "../app/api/v1/workspaces/[id]/tenants/[tenantId]/record-exports/[jobId]/route";
import { POST as download } from "../app/api/v1/workspaces/[id]/tenants/[tenantId]/record-exports/[jobId]/download/route";

const tenantId = "00000000-0000-4000-8000-000000000002";
const jobId = "00000000-0000-4000-8000-0000000000c1";
const viewId = "00000000-0000-4000-8000-0000000000b1";
const recordA = "00000000-0000-4000-8000-0000000000a1";
const recordB = "00000000-0000-4000-8000-0000000000a2";
const reviewHash = "ab".repeat(32);
const authority = { verify: vi.fn() };
const scope = () => ({ params: Promise.resolve({ id: "workspace-a", tenantId }) });
const detail = () => ({ params: Promise.resolve({ id: "workspace-a", tenantId, jobId }) });
const viewBody = { id: jobId, kind: "view", viewId, expectedViewVersion: 2, expectedSchemaVersion: 4, format: "csv", includeIds: false, includeRelationships: false };
const recordBody = { id: jobId, kind: "records", collection: "organisations", recordIds: [recordA, recordB], columns: ["name", "core:notes"], expectedSchemaVersion: 4, format: "xlsx", includeIds: true, includeRelationships: false };
const post = (data: unknown, origin = "https://hs.example") => new Request("https://hs.example/api/record-exports", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(data) });
const jobPost = (data: unknown, origin = "https://hs.example") => new Request(`https://hs.example/api/record-exports/${jobId}`, { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(data) });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.constructed.length = 0;
  vi.stubEnv("HS_ORIGIN", "https://hs.example");
  mocks.authenticate.mockResolvedValue({ actor: { id: "verified-user" }, authority });
  mocks.repository.mockResolvedValue({});
});

it("prepares a view or explicit scope through suite-tenant authority and retries the same job id", async () => {
  const pinned = { id: jobId, state: "ready", pinned: true };
  mocks.prepareRecordExport.mockResolvedValue(pinned);
  const response = await prepare(post(viewBody), scope());
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual(pinned);
  expect(mocks.prepareRecordExport).toHaveBeenCalledWith(expect.objectContaining({ actor: { id: "verified-user" }, workspaceId: "workspace-a", tenantId }), viewBody);
  expect(mocks.constructed).toEqual([[{}, authority]]);
  const again = await prepare(post(recordBody), scope());
  expect(again.status).toBe(200);
  expect(mocks.prepareRecordExport).toHaveBeenLastCalledWith(expect.anything(), recordBody);
  expect(mocks.constructed.every((args) => args.length === 2 && args[1] === authority)).toBe(true);
});

it("rejects a cross-origin, forged, duplicate or oversized scope before preparation", async () => {
  expect((await prepare(post(viewBody, "https://attacker.example"), scope())).status).toBe(403);
  expect(mocks.authenticate).not.toHaveBeenCalled();
  mocks.authenticate.mockResolvedValue({ actor: { id: "verified-user" }, authority });
  expect((await prepare(post({ ...viewBody, grants: ["secret"] }), scope())).status).toBe(400);
  expect((await prepare(post({ ...recordBody, recordIds: [recordA, recordA] }), scope())).status).toBe(400);
  expect((await prepare(post({ ...recordBody, columns: ["name", "id"] }), scope())).status).toBe(400);
  expect((await prepare(post({ ...recordBody, columns: ["name", "parentOrganisationId"] }), scope())).status).toBe(400);
  expect((await prepare(post({ ...viewBody, includeIds: undefined }), scope())).status).toBe(400);
  expect((await prepare(post({ ...recordBody, collection: ["organisations", "accounts"] }), scope())).status).toBe(400);
  expect((await prepare(new Request("https://hs.example/api/record-exports", { method: "POST", headers: { Origin: "https://hs.example" }, body: "x".repeat(recordExportRequestLimit + 1) }), scope())).status).toBe(413);
  expect(mocks.prepareRecordExport).not.toHaveBeenCalled();
  mocks.authenticate.mockRejectedValue(new DocumentError("Structured records are not enabled in this environment.", "record_feature_disabled", 503));
  const disabled = await prepare(post(viewBody), scope());
  expect(disabled.status).toBe(503);
  expect(await disabled.json()).toMatchObject({ code: "record_feature_disabled", retryable: true });
  expect(mocks.prepareRecordExport).not.toHaveBeenCalled();
});

it("forwards preview and cancel without a reference adapter", async () => {
  mocks.getRecordExport.mockResolvedValue({ id: jobId, state: "ready" });
  const listed = await GET(new Request(`https://hs.example/api/record-exports/${jobId}`), detail());
  expect(listed.status).toBe(200);
  expect(listed.headers.get("cache-control")).toBe("no-store");
  expect(mocks.getRecordExport).toHaveBeenCalledWith(expect.objectContaining({ actor: { id: "verified-user" }, workspaceId: "workspace-a", tenantId }), jobId);
  mocks.cancelRecordExport.mockResolvedValue({ id: jobId, state: "cancelled" });
  expect((await cancel(jobPost({ kind: "cancel" }), detail())).status).toBe(200);
  expect(mocks.cancelRecordExport).toHaveBeenCalledWith(expect.anything(), jobId);
  expect((await cancel(jobPost({ kind: "cancel", snapshot: true }), detail())).status).toBe(400);
  expect((await cancel(jobPost({ kind: "cancel" }, "https://attacker.example"), detail())).status).toBe(403);
  expect(mocks.constructed.every((args) => args.length === 2 && args[1] === authority)).toBe(true);
});

it("returns the pinned file without adopting a supplied filename or content type", async () => {
  const csv = Buffer.from("\ufeff\"Name\"\r\n\"Ada\"\r\n", "utf8");
  mocks.downloadRecordExport.mockResolvedValue({ filename: "../secret.csv", contentType: "text/csv; charset=utf-8", bytes: csv, rows: 1 });
  const response = await download(jobPost({ reviewHash, acknowledgeEscaping: false }), detail());
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
  expect(response.headers.get("content-disposition")).toBe('attachment; filename="holy-sheet-records.csv"');
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(Buffer.from(await response.arrayBuffer()).equals(csv)).toBe(true);
  expect(mocks.downloadRecordExport).toHaveBeenCalledWith(expect.anything(), jobId, { reviewHash, acknowledgeEscaping: false });
  mocks.downloadRecordExport.mockResolvedValue({ filename: "holy-sheet-records.xlsx", contentType: "text/html", bytes: csv, rows: 1 });
  const replaced = await download(jobPost({ reviewHash, acknowledgeEscaping: true }), detail());
  expect(replaced.status).toBe(404);
  expect(await replaced.json()).toMatchObject({ code: "record_export_unavailable" });
  mocks.downloadRecordExport.mockRejectedValue(new DocumentError("The export expired after fifteen minutes.", "record_export_expired", 410));
  const expired = await download(jobPost({ reviewHash, acknowledgeEscaping: true }), detail());
  expect(expired.status).toBe(410);
  expect(await expired.json()).toMatchObject({ code: "record_export_expired" });
  expect((await download(jobPost({ reviewHash, acknowledgeEscaping: true }, "https://attacker.example"), detail())).status).toBe(403);
  mocks.downloadRecordExport.mockRejectedValue(new Error("worker failed"));
  const unavailable = await download(jobPost({ reviewHash, acknowledgeEscaping: true }), detail());
  expect(unavailable.status).toBe(503);
  expect(await unavailable.json()).toMatchObject({ code: "service_unavailable", retryable: true });
  expect(mocks.constructed.every((args) => args.length === 2 && args[1] === authority)).toBe(true);
});
