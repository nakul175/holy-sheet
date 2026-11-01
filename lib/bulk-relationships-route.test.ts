import { beforeEach, expect, it, vi } from "vitest";
import { DocumentError } from "./document";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  repository: vi.fn(),
  preview: vi.fn(),
  execute: vi.fn(),
  download: vi.fn(),
  searchTargets: vi.fn(),
  history: vi.fn(),
}));
vi.mock("./suite-tenant-authority", () => ({ authenticateRecordAuthority: mocks.authenticate }));
vi.mock("./repository", () => ({ repository: mocks.repository }));
vi.mock("./bulk-relationships", () => ({
  BulkRelationshipRepository: class {
    preview = mocks.preview;
    execute = mocks.execute;
    download = mocks.download;
    searchTargets = mocks.searchTargets;
    saveDraft = vi.fn();
    readDraft = vi.fn();
    listDrafts = vi.fn();
    discardDraft = vi.fn();
    batchHistory = mocks.history;
  },
}));
import { POST } from "../app/api/v1/workspaces/[id]/tenants/[tenantId]/relationship-batches/route";

const tenantId = "00000000-0000-4000-8000-000000000002";
const sourceId = "00000000-0000-4000-8000-000000000003";
const targetId = "00000000-0000-4000-8000-000000000005";
const operationId = "00000000-0000-4000-8000-000000000004";
const scope = () => ({ params: Promise.resolve({ id: "workspace-a", tenantId }) });
const call = (body: unknown, origin = "https://hs.example") =>
  new Request("https://hs.example/api/relationship-batches", {
    method: "POST",
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("HS_ORIGIN", "https://hs.example");
  mocks.authenticate.mockResolvedValue({ actor: { id: "verified-user" }, authority: { verify: vi.fn() } });
  mocks.repository.mockResolvedValue({});
});

it("previews and executes through the authenticated tenant scope", async () => {
  const input = { sourceIds: [sourceId], kind: "contact-account", operation: "add", targetId, role: "Buyer", primary: false, status: "active" };
  mocks.preview.mockResolvedValue({ previewToken: "a".repeat(64), counts: { success: 1, skipped: 0, error: 0 } });
  expect((await POST(call({ action: "preview", ...input }), scope())).status).toBe(200);
  expect(mocks.preview).toHaveBeenCalledWith({ actor: { id: "verified-user" }, workspaceId: "workspace-a", tenantId }, input);
  mocks.execute.mockResolvedValue({ batchId: sourceId, replayed: false });
  const apply = { action: "execute", operationId, previewToken: "a".repeat(64), confirmed: true, ...input };
  expect((await POST(call(apply), scope())).status).toBe(200);
  expect(mocks.execute).toHaveBeenCalledWith(expect.anything(), { operationId, previewToken: "a".repeat(64), confirmed: true, ...input });
});

it("denies a cross-origin batch and rejects an unknown action before storage", async () => {
  expect((await POST(call({ action: "preview" }, "https://attacker.example"), scope())).status).toBe(403);
  expect(mocks.authenticate).not.toHaveBeenCalled();
  mocks.authenticate.mockResolvedValue({ actor: { id: "verified-user" }, authority: { verify: vi.fn() } });
  expect((await POST(call({ action: "grant-admin" }), scope())).status).toBe(400);
  expect(mocks.preview).not.toHaveBeenCalled();
});

it("returns a permission failure and a csv download without record values", async () => {
  mocks.history.mockRejectedValue(new DocumentError("Record is restricted or unavailable.", "record_not_found", 404));
  const denied = await POST(call({ action: "history", batchId: sourceId }), scope());
  expect(denied.status).toBe(404);
  expect(await denied.json()).toMatchObject({ code: "record_not_found", retryable: false });
  mocks.download.mockResolvedValue({ filename: "relationship-batch.csv", body: "batchId,sourceId,outcome,code,message\n" });
  const file = await POST(call({ action: "download", batchId: sourceId }), scope());
  expect(file.headers.get("content-type")).toContain("text/csv");
  expect(file.headers.get("content-disposition")).toContain("relationship-batch.csv");
  expect(await file.text()).toContain("outcome");
});
