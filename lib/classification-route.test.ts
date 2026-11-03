import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  catalogue: vi.fn(), tag: vi.fn(), search: vi.fn(), facets: vi.fn(), history: vi.fn(), preview: vi.fn(),
  create: vi.fn(), save: vi.fn(), stash: vi.fn(), discard: vi.fn(), deprecate: vi.fn(), apply: vi.fn(),
  assign: vi.fn(), download: vi.fn(), grant: vi.fn(), revoke: vi.fn(), policy: vi.fn(), repository: vi.fn(async () => ({})),
}));
vi.mock("./repository", () => ({ repository: mocks.repository }));
vi.mock("./classification", () => ({
  classificationCatalogue: mocks.catalogue,
  readClassificationTag: mocks.tag,
  searchClassification: mocks.search,
  classificationFacets: mocks.facets,
  classificationHistory: mocks.history,
  previewClassification: mocks.preview,
  createClassificationTag: mocks.create,
  saveClassificationTag: mocks.save,
  stashClassificationTag: mocks.stash,
  discardClassificationDraft: mocks.discard,
  deprecateClassificationTag: mocks.deprecate,
  applyClassificationChange: mocks.apply,
  assignClassification: mocks.assign,
  downloadClassification: mocks.download,
  grantClassificationManager: mocks.grant,
  revokeClassificationManager: mocks.revoke,
  saveClassificationFieldPolicy: mocks.policy,
}));
import { GET, POST } from "../app/api/v1/workspaces/[id]/classification/route";

const origin = "http://localhost:3000";
const workspaceId = "ws-aplyd";
const tagId = "00000000-0000-4000-8000-0000000000c1";
const operationId = "00000000-0000-4000-8000-0000000000c2";
const params = { params: Promise.resolve({ id: workspaceId }) };
const request = (body: unknown, extra: Record<string, string> = {}) => new Request(origin + "/api/test", { method: "POST", headers: { origin, "content-type": "application/json", ...extra }, body: JSON.stringify(body) });
const save = { operationId, expectedVersion: 1, label: "Clinic", parentId: null, documents: true, collections: ["contacts"], handling: "metadata", clearedUserIds: [] };

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("HS_LOCAL_PREVIEW", "1");
  vi.stubEnv("HS_ORIGIN", origin);
  vi.clearAllMocks();
  mocks.catalogue.mockResolvedValue({ manage: false, tags: [] });
  mocks.search.mockResolvedValue({ results: [] });
  mocks.facets.mockResolvedValue({ facets: [] });
  mocks.history.mockResolvedValue({ events: [] });
  mocks.preview.mockResolvedValue({ references: [] });
  mocks.tag.mockResolvedValue({ id: tagId });
  mocks.create.mockResolvedValue({ id: tagId, version: 1 });
  mocks.assign.mockResolvedValue({ version: 1, tags: [] });
});
afterEach(() => vi.unstubAllEnvs());

it("rejects a foreign origin and an extra field before creating a tag", async () => {
  expect((await GET(new Request(`${origin}/api/v1/workspaces/${workspaceId}/classification?pageId=page-1`), params)).status).toBe(200);
  expect(mocks.catalogue).toHaveBeenCalledWith({}, expect.any(Object), workspaceId, { pageId: "page-1", recordId: null });
  const body = { action: "create", code: "CLINIC", ...save, extra: true };
  expect((await POST(request(body, { origin: "https://foreign.invalid" }), params)).status).toBe(403);
  expect(mocks.create).not.toHaveBeenCalled();
  expect((await POST(request(body), params)).status).toBe(422);
  expect(mocks.create).not.toHaveBeenCalled();
  expect((await POST(request({ action: "create", code: "CLINIC", ...save }), params)).status).toBe(200);
  expect(mocks.create).toHaveBeenCalledWith({}, expect.any(Object), workspaceId, expect.objectContaining({ code: "CLINIC", label: "Clinic" }));
});

it("uses the same not-found response for a missing tag and a denied read", async () => {
  expect((await GET(new Request(`${origin}/api/v1/workspaces/${workspaceId}/classification?view=search`), params)).status).toBe(404);
  expect(mocks.search).not.toHaveBeenCalled();
  const { DocumentError } = await import("./document");
  mocks.search.mockRejectedValueOnce(new DocumentError("Classification is restricted or unavailable.", "not_found", 404));
  const denied = await GET(new Request(`${origin}/api/v1/workspaces/${workspaceId}/classification?view=search&tagId=${tagId}`), params);
  expect(denied.status).toBe(404);
  expect(await denied.json()).toEqual({ error: "Classification is restricted or unavailable.", code: "not_found", retryable: false });
  expect((await GET(new Request(`${origin}/api/v1/workspaces/nope/classification?view=facets&kind=page`), { params: Promise.resolve({ id: "" }) })).status).toBe(404);
  expect((await POST(request({ action: "assign", operationId, targetKind: "page", targetId: "page-1", expectedVersion: 0, tagIds: [] }), params)).status).toBe(200);
  expect(mocks.assign).toHaveBeenCalled();
});
