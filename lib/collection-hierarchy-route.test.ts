import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  catalogue: vi.fn(), nodes: vi.fn(), search: vi.fn(), history: vi.fn(), record: vi.fn(), preview: vi.fn(),
  save: vi.fn(), stash: vi.fn(), stashPlace: vi.fn(), discard: vi.fn(), apply: vi.fn(), download: vi.fn(),
  grant: vi.fn(), revoke: vi.fn(), policy: vi.fn(), repository: vi.fn(async () => ({})),
}));
vi.mock("./repository", () => ({ repository: mocks.repository }));
vi.mock("./collection-hierarchy", () => ({
  hierarchyCatalogue: mocks.catalogue,
  hierarchyNodes: mocks.nodes,
  searchHierarchy: mocks.search,
  hierarchyHistory: mocks.history,
  readHierarchyRecord: mocks.record,
  previewHierarchyImpact: mocks.preview,
  saveHierarchyConfig: mocks.save,
  stashHierarchyConfig: mocks.stash,
  stashHierarchyPlacement: mocks.stashPlace,
  discardHierarchyDraft: mocks.discard,
  applyHierarchyImpact: mocks.apply,
  downloadHierarchy: mocks.download,
  grantHierarchyManager: mocks.grant,
  revokeHierarchyManager: mocks.revoke,
  saveHierarchyFieldPolicy: mocks.policy,
}));
import { GET, POST } from "../app/api/v1/workspaces/[id]/collection-hierarchy/route";

const origin = "http://localhost:3000";
const workspaceId = "ws-aplyd";
const operationId = "00000000-0000-4000-8000-0000000000c2";
const recordId = "00000000-0000-4000-8000-0000000000c3";
const previewId = "00000000-0000-4000-8000-0000000000c4";
const params = { params: Promise.resolve({ id: workspaceId }) };
const request = (body: unknown, extra: Record<string, string> = {}) => new Request(origin + "/api/test", { method: "POST", headers: { origin, "content-type": "application/json", ...extra }, body: JSON.stringify(body) });
const config = { operationId, collection: "assets", expectedVersion: 0, enabled: true, allowRoots: true, depthLimit: 20 };

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("HS_LOCAL_PREVIEW", "1");
  vi.stubEnv("HS_ORIGIN", origin);
  vi.clearAllMocks();
  mocks.catalogue.mockResolvedValue({ manage: false, configs: [] });
  mocks.nodes.mockResolvedValue({ entries: [], more: false });
  mocks.search.mockResolvedValue({ results: [], more: false });
  mocks.history.mockResolvedValue({ events: [] });
  mocks.record.mockResolvedValue({ id: recordId });
  mocks.preview.mockResolvedValue({ subtree: [], references: [] });
  mocks.save.mockResolvedValue({ version: 1, grantsCreated: false });
  mocks.apply.mockResolvedValue({ id: recordId, grantsCreated: false });
});
afterEach(() => vi.unstubAllEnvs());

it("rejects a foreign origin and an extra field before saving hierarchy", async () => {
  expect((await GET(new Request(`${origin}/api/v1/workspaces/${workspaceId}/collection-hierarchy`), params)).status).toBe(200);
  expect(mocks.catalogue).toHaveBeenCalled();
  const body = { action: "save-config", ...config, extra: true };
  expect((await POST(request(body, { origin: "https://foreign.invalid" }), params)).status).toBe(403);
  expect(mocks.save).not.toHaveBeenCalled();
  expect((await POST(request(body), params)).status).toBe(422);
  expect(mocks.save).not.toHaveBeenCalled();
  expect((await POST(request({ action: "save-config", ...config, depthLimit: 21 }), params)).status).toBe(422);
  expect((await POST(request({ action: "save-config", ...config }), params)).status).toBe(200);
  expect(mocks.save).toHaveBeenCalledWith({}, expect.any(Object), workspaceId, expect.objectContaining({ collection: "assets", depthLimit: 20, allowRoots: true }));
});

it("uses the same not-found response for a missing tree and a denied read", async () => {
  expect((await GET(new Request(`${origin}/api/v1/workspaces/${workspaceId}/collection-hierarchy?view=tree`), params)).status).toBe(404);
  expect(mocks.nodes).not.toHaveBeenCalled();
  const { DocumentError } = await import("./document");
  mocks.nodes.mockRejectedValueOnce(new DocumentError("Collection hierarchy is restricted or unavailable.", "not_found", 404));
  const denied = await GET(new Request(`${origin}/api/v1/workspaces/${workspaceId}/collection-hierarchy?view=tree&collection=assets`), params);
  expect(denied.status).toBe(404);
  expect(await denied.json()).toEqual({ error: "Collection hierarchy is restricted or unavailable.", code: "not_found", retryable: false });
  expect((await POST(request({ action: "apply", operationId, previewId, expectedVersion: 1 }), params)).status).toBe(200);
  expect(mocks.apply).toHaveBeenCalled();
});
