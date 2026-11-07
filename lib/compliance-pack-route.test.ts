import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ create: vi.fn(), list: vi.fn(), read: vi.fn(), download: vi.fn(), policy: vi.fn(), change: vi.fn(), repository: vi.fn(async () => ({})), binding: vi.fn(() => "binding") }));
vi.mock("./repository", () => ({ repository: mocks.repository }));
vi.mock("./compliance-pack", () => ({
  createComplianceExport: mocks.create,
  listComplianceExports: mocks.list,
  readComplianceExport: mocks.read,
  downloadComplianceExport: mocks.download,
  exportAttachmentPolicy: mocks.policy,
  changeExportAttachmentPolicy: mocks.change,
  complianceSessionBinding: mocks.binding,
}));
import { GET as list, POST as create } from "../app/api/v1/workspaces/[id]/compliance-exports/route";
import { GET as readPolicy, POST as changePolicy } from "../app/api/v1/workspaces/[id]/compliance-exports/policy/route";
import { GET as readJob } from "../app/api/v1/compliance-exports/[id]/route";
import { POST as download } from "../app/api/v1/compliance-exports/[id]/download/route";

const origin = "http://localhost:3000";
const id = crypto.randomUUID();
const params = { params: Promise.resolve({ id: "ws-a" }) };
const request = (path: string, body: unknown, extra: Record<string, string> = {}) => new Request(origin + path, { method: "POST", headers: { origin, "content-type": "application/json", ...extra }, body: JSON.stringify(body) });

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("HS_LOCAL_PREVIEW", "1");
  vi.stubEnv("HS_ORIGIN", origin);
  vi.clearAllMocks();
  mocks.list.mockResolvedValue({ jobs: [] });
  mocks.create.mockResolvedValue({ id, state: "ready", progress: 100, etaSeconds: 0 });
  mocks.read.mockResolvedValue({ id, state: "ready" });
  mocks.policy.mockResolvedValue({ attachments: true, version: 1, manage: true });
  mocks.change.mockResolvedValue({ attachments: false, version: 2, manage: true });
  mocks.download.mockResolvedValue({ bytes: Buffer.from("PK\u0003\u0004pack"), filename: "pages-by-aplyd-compliance-pack.zip", contentType: "application/zip" });
});
afterEach(() => vi.unstubAllEnvs());

it("requires the caller session and rejects a foreign origin before packing", async () => {
  expect((await list(new Request(`${origin}/api/v1/workspaces/ws-a/compliance-exports`), params)).status).toBe(200);
  expect(mocks.list).toHaveBeenCalledWith({}, expect.any(Object), "ws-a", "binding");
  const body = { operationId: id, scope: "space", format: "compliance-pack", targetId: "space", includeDraft: false, includeTrash: false, allAttachmentVersions: false };
  expect((await create(request("/api/test", body, { origin: "https://foreign.invalid" }), params)).status).toBe(403);
  expect(mocks.create).not.toHaveBeenCalled();
  expect((await download(request("/api/test", { token: "a".repeat(32) }, { origin: "https://foreign.invalid" }), { params: Promise.resolve({ id }) })).status).toBe(403);
  expect(mocks.download).not.toHaveBeenCalled();
});

it("rejects extra fields and a non-uuid job before lookup", async () => {
  expect((await create(request("/api/test", { operationId: id, scope: "space", format: "compliance-pack", targetId: "space", includeDraft: false, includeTrash: false, allAttachmentVersions: false, document: {} }), params)).status).toBe(422);
  expect(mocks.create).not.toHaveBeenCalled();
  expect((await readJob(new Request(`${origin}/api/test`), { params: Promise.resolve({ id: "bad" }) })).status).toBe(404);
  expect(mocks.read).not.toHaveBeenCalled();
  expect((await download(request("/api/test", { token: "short" }), { params: Promise.resolve({ id }) })).status).toBe(422);
  expect(mocks.download).not.toHaveBeenCalled();
});

it("returns a private zip and the same not-found shape for a denied download", async () => {
  const response = await download(request("/api/test", { token: "a".repeat(32) }), { params: Promise.resolve({ id }) });
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("application/zip");
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("x-content-type-options")).toBe("nosniff");
  expect(response.headers.get("content-disposition")).toContain("pages-by-aplyd-compliance-pack.zip");
  const { DocumentError } = await import("./document");
  mocks.download.mockRejectedValueOnce(new DocumentError("Export unavailable", "not_found", 404));
  const denied = await download(request("/api/test", { token: "b".repeat(32) }), { params: Promise.resolve({ id }) });
  expect(denied.status).toBe(404);
  expect(await denied.json()).toEqual({ error: "Export unavailable", code: "not_found", retryable: false });
});

it("updates attachment policy only through the strict request", async () => {
  expect((await readPolicy(new Request(`${origin}/api/v1/workspaces/ws-a/compliance-exports/policy?spaceId=space-product`), params)).status).toBe(200);
  expect(mocks.policy).toHaveBeenCalledWith({}, expect.any(Object), "ws-a", "space-product");
  expect((await changePolicy(request("/api/test", { operationId: id, spaceId: "space-product", attachments: false, expectedVersion: 1, enabled: false }), params)).status).toBe(422);
  expect(mocks.change).not.toHaveBeenCalled();
  expect((await changePolicy(request("/api/test", { operationId: id, spaceId: "space-product", attachments: false, expectedVersion: 1 }), params)).status).toBe(200);
});
