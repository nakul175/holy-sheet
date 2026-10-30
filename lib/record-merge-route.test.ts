import { beforeEach, expect, it, vi } from "vitest";
import { DocumentError } from "./document";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  repository: vi.fn(),
  duplicateSuggestions: vi.fn(),
  previewMerge: vi.fn(),
  applyMerge: vi.fn(),
  consumers: [] as unknown[],
}));
vi.mock("./suite-tenant-authority", () => ({ authenticateRecordAuthority: mocks.authenticate }));
vi.mock("./repository", () => ({ repository: mocks.repository }));
vi.mock("./shared-record-merges", async () => {
  const actual = await vi.importActual<typeof import("./shared-record-merges")>("./shared-record-merges");
  return {
    ...actual,
    nativeRecordMergeRepository: (pages: ConstructorParameters<typeof actual.SharedRecordMergeRepository>[0], authority: ConstructorParameters<typeof actual.SharedRecordMergeRepository>[1]) => {
      const repo = new actual.SharedRecordMergeRepository(pages, authority);
      mocks.consumers.push(repo.consumers);
      repo.duplicateSuggestions = mocks.duplicateSuggestions;
      repo.previewMerge = mocks.previewMerge;
      repo.applyMerge = mocks.applyMerge;
      return repo;
    },
  };
});
import { GET } from "../app/api/v1/workspaces/[id]/tenants/[tenantId]/record-duplicates/route";
import { POST } from "../app/api/v1/workspaces/[id]/tenants/[tenantId]/record-merges/route";

const tenantId = "00000000-0000-4000-8000-000000000002",
  sourceId = "00000000-0000-4000-8000-0000000000a1",
  survivorId = "00000000-0000-4000-8000-0000000000a2",
  operationId = "00000000-0000-4000-8000-000000000004",
  previewId = "00000000-0000-4000-8000-000000000005",
  reviewHash = "ab".repeat(32),
  scope = () => ({ params: Promise.resolve({ id: "workspace-a", tenantId }) }),
  request = (data: unknown, origin = "https://hs.example") => new Request("https://hs.example/api/record-merges", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(data) });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.consumers.length = 0;
  vi.stubEnv("HS_ORIGIN", "https://hs.example");
  mocks.authenticate.mockResolvedValue({ actor: { id: "verified-user" }, authority: { verify: vi.fn() } });
  mocks.repository.mockResolvedValue({});
});

it("does not attach a consumer adapter on the native repository", async () => {
  const actual = await vi.importActual<typeof import("./shared-record-merges")>("./shared-record-merges");
  expect(actual.nativeRecordMergeRepository({} as never, { verify: async () => { throw new Error("unused"); } }).consumers).toBeUndefined();
});

it("returns at most the service duplicate page and omits an email predicate the caller did not supply", async () => {
  mocks.duplicateSuggestions.mockResolvedValue({ suggestions: [], hasMore: false, advisory: true });
  const listed = await GET(new Request(`https://hs.example/api/record-duplicates?collection=organisations&name=Acme&domain=https%3A%2F%2Fexample.org%2Fteam&limit=100`), scope());
  expect(listed.status).toBe(200);
  expect(listed.headers.get("cache-control")).toBe("no-store");
  expect(mocks.duplicateSuggestions).toHaveBeenCalledWith(expect.objectContaining({ actor: { id: "verified-user" }, workspaceId: "workspace-a", tenantId }), { collection: "organisations", name: "Acme", domain: "https://example.org/team", includeArchived: false });
  expect(JSON.stringify(mocks.duplicateSuggestions.mock.calls[0][1])).not.toContain("limit");
  expect(mocks.consumers).toEqual([undefined]);
});

it("forwards an email predicate and archived flag only when the caller asks for them", async () => {
  mocks.duplicateSuggestions.mockResolvedValue({ suggestions: [{ id: sourceId, name: "Ada", reasons: ["email"] }], hasMore: true, advisory: true });
  const listed = await GET(new Request(`https://hs.example/api/record-duplicates?collection=contacts&name=Ada&email=ada%40example.org&excludeId=${survivorId}&includeArchived=1`), scope());
  expect(listed.status).toBe(200);
  expect(mocks.duplicateSuggestions).toHaveBeenCalledWith(expect.anything(), { collection: "contacts", name: "Ada", email: "ada@example.org", excludeId: survivorId, includeArchived: true });
});

it("rejects a duplicate query before the service when the name or email is unusable", async () => {
  expect((await GET(new Request("https://hs.example/api/record-duplicates?collection=contacts&name="), scope())).status).toBe(400);
  expect((await GET(new Request("https://hs.example/api/record-duplicates?collection=contacts&name=Ada&email=not-an-email"), scope())).status).toBe(400);
  expect(mocks.duplicateSuggestions).not.toHaveBeenCalled();
});

it("previews explicit field, parent and relationship choices through suite-tenant authority", async () => {
  const preview = { previewId, reviewHash, integrationReady: false, blockers: ["Choose a value for each permitted conflicting field."], conflicts: [], relationshipConflicts: [] };
  mocks.previewMerge.mockResolvedValue(preview);
  const response = await POST(request({ kind: "preview", sourceId, survivorId, sourceVersion: 2, survivorVersion: 4, nameFrom: "source", fieldFrom: { "core:notes": "source" }, relationshipFrom: { "contract-account:00000000-0000-4000-8000-0000000000a3": "survivor" }, parentFrom: "source" }), scope());
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual(preview);
  expect(mocks.previewMerge).toHaveBeenCalledWith(expect.objectContaining({ actor: { id: "verified-user" }, workspaceId: "workspace-a", tenantId }), { sourceId, survivorId, sourceVersion: 2, survivorVersion: 4, nameFrom: "source", fieldFrom: { "core:notes": "source" }, relationshipFrom: { "contract-account:00000000-0000-4000-8000-0000000000a3": "survivor" }, parentFrom: "source" });
  expect(mocks.applyMerge).not.toHaveBeenCalled();
  expect(mocks.consumers).toEqual([undefined]);
});

it("keeps apply unavailable when no qualified alias consumer is connected", async () => {
  mocks.applyMerge.mockRejectedValue(new DocumentError("Connected-app alias resolution is not qualified for this review.", "record_merge_consumers_unavailable", 503));
  const response = await POST(request({ kind: "apply", operationId, previewId, reviewHash, confirm: "merge-and-retain-source-history" }), scope());
  expect(response.status).toBe(503);
  expect(await response.json()).toEqual({ error: "Connected-app alias resolution is not qualified for this review.", code: "record_merge_consumers_unavailable", retryable: true });
  expect(mocks.applyMerge).toHaveBeenCalledWith(expect.anything(), { operationId, previewId, reviewHash, confirm: "merge-and-retain-source-history" });
  expect(mocks.consumers).toEqual([undefined]);
});

it("denies cross-origin merge writes before authentication and rejects forged fields", async () => {
  expect((await POST(request({ kind: "preview", sourceId, survivorId, sourceVersion: 1, survivorVersion: 1, nameFrom: "survivor" }, "https://attacker.example"), scope())).status).toBe(403);
  expect(mocks.authenticate).not.toHaveBeenCalled();
  mocks.authenticate.mockResolvedValue({ actor: { id: "verified-user" }, authority: { verify: vi.fn() } });
  const forged = await POST(request({ kind: "apply", operationId, previewId, reviewHash, confirm: "merge-and-retain-source-history", grants: ["page-secret"] }), scope());
  expect(forged.status).toBe(400);
  expect(mocks.applyMerge).not.toHaveBeenCalled();
  mocks.authenticate.mockRejectedValue(new DocumentError("Structured records are not enabled in this environment.", "record_feature_disabled", 503));
  const disabled = await GET(new Request("https://hs.example/api/record-duplicates?collection=organisations&name=Acme"), scope());
  expect(disabled.status).toBe(503);
  expect(await disabled.json()).toMatchObject({ code: "record_feature_disabled" });
  expect(mocks.duplicateSuggestions).not.toHaveBeenCalled();
});
