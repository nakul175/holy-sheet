import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  list: vi.fn(), record: vi.fn(), grant: vi.fn(), revoke: vi.fn(), material: vi.fn(), metadata: vi.fn(), retire: vi.fn(), merge: vi.fn(), download: vi.fn(),
  impact: vi.fn(), preview: vi.fn(), read: vi.fn(), save: vi.fn(), stash: vi.fn(), discard: vi.fn(), acknowledge: vi.fn(), reassign: vi.fn(), history: vi.fn(),
  repository: vi.fn(async () => ({})),
}));
vi.mock("./repository", () => ({ repository: mocks.repository }));
vi.mock("./dependency-impact", () => ({
  listDependencyImpact: mocks.list,
  recordDependencyEdge: mocks.record,
  grantDependencyManager: mocks.grant,
  revokeDependencyManager: mocks.revoke,
  noteDependencyMaterial: mocks.material,
  noteDependencyMetadata: mocks.metadata,
  retireDependencySource: mocks.retire,
  mergeDependencySource: mocks.merge,
  downloadDependencyImpact: mocks.download,
  traverseDependencyImpact: mocks.impact,
  previewDependencyImpact: mocks.preview,
  readDependencyEdge: mocks.read,
  saveDependencyEdge: mocks.save,
  stashDependencyEdge: mocks.stash,
  discardDependencyDraft: mocks.discard,
  acknowledgeDependency: mocks.acknowledge,
  reassignDependencyReviewer: mocks.reassign,
  dependencyHistory: mocks.history,
  parseDependencyKind: (value: string | null) => value || undefined,
}));
import { GET as list, POST as create } from "../app/api/v1/workspaces/[id]/dependency-impact/route";
import { GET as read, POST as command } from "../app/api/v1/workspaces/[id]/dependency-impact/[edgeId]/route";

const origin = "http://localhost:3000";
const workspaceId = "ws-aplyd";
const edgeId = "00000000-0000-4000-8000-0000000000d1";
const operationId = "00000000-0000-4000-8000-0000000000d2";
const listParams = { params: Promise.resolve({ id: workspaceId }) };
const itemParams = { params: Promise.resolve({ id: workspaceId, edgeId }) };
const request = (path: string, body: unknown, extra: Record<string, string> = {}) => new Request(origin + path, { method: "POST", headers: { origin, "content-type": "application/json", ...extra }, body: JSON.stringify(body) });

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("HS_LOCAL_PREVIEW", "1");
  vi.stubEnv("HS_ORIGIN", origin);
  vi.clearAllMocks();
  mocks.list.mockResolvedValue({ manage: true, edges: [] });
  mocks.record.mockResolvedValue({ id: edgeId, version: 1 });
  mocks.read.mockResolvedValue({ id: edgeId });
  mocks.impact.mockResolvedValue({ pages: [], edges: [], truncated: false });
  mocks.preview.mockResolvedValue({ items: [], pages: [], truncated: false });
  mocks.history.mockResolvedValue({ events: [] });
  mocks.download.mockResolvedValue({ body: "# Dependency impact\n", filename: "dependency-impact.md" });
  mocks.acknowledge.mockResolvedValue({ id: edgeId, reviewState: "acknowledged" });
  mocks.material.mockResolvedValue({ marksReview: true, marked: [] });
});
afterEach(() => vi.unstubAllEnvs());

it("rejects a foreign origin and an extra field before recording a dependency", async () => {
  expect((await list(new Request(`${origin}/api/v1/workspaces/${workspaceId}/dependency-impact?q=ward`), listParams)).status).toBe(200);
  expect(mocks.list).toHaveBeenCalledWith({}, expect.any(Object), workspaceId, "ward", null);
  const body = { action: "record", operationId, kind: "link", sourceId: "source", sourceRevision: 1, dependentPageId: "page", reviewerId: "editor", note: "", extra: true };
  expect((await create(request("/api/test", body, { origin: "https://foreign.invalid" }), listParams)).status).toBe(403);
  expect(mocks.record).not.toHaveBeenCalled();
  expect((await create(request("/api/test", body), listParams)).status).toBe(422);
  expect(mocks.record).not.toHaveBeenCalled();
  expect((await create(request("/api/test", { action: "record", operationId, kind: "link", sourceId: "source", sourceRevision: 1, dependentPageId: "page", reviewerId: "editor" }), listParams)).status).toBe(200);
  expect((await list(new Request(`${origin}/api/v1/workspaces/${workspaceId}/dependency-impact?view=impact&kind=link&sourceId=source`), listParams)).status).toBe(200);
  expect(mocks.impact).toHaveBeenCalledWith({}, expect.any(Object), workspaceId, expect.objectContaining({ kind: "link", sourceId: "source" }));
  expect((await list(new Request(`${origin}/api/v1/workspaces/${workspaceId}/dependency-impact?view=preview&kind=link&sourceId=source`), listParams)).status).toBe(200);
  expect(mocks.preview).toHaveBeenCalled();
});

it("uses the same not-found response for a bad edge id and a denied read", async () => {
  const deniedParams = { params: Promise.resolve({ id: workspaceId, edgeId: "not-a-uuid" }) };
  expect((await read(new Request(`${origin}/api/test`), deniedParams)).status).toBe(404);
  expect(mocks.read).not.toHaveBeenCalled();
  const { DocumentError } = await import("./document");
  mocks.read.mockRejectedValueOnce(new DocumentError("Dependency unavailable", "not_found", 404));
  const denied = await read(new Request(`${origin}/api/test`), itemParams);
  expect(denied.status).toBe(404);
  expect(await denied.json()).toEqual({ error: "Dependency unavailable", code: "not_found", retryable: false });
  expect((await read(new Request(`${origin}/api/test?view=history`), itemParams)).status).toBe(200);
  expect(mocks.history).toHaveBeenCalled();
});

it("requires acknowledgement revisions and does not call the command for a partial body", async () => {
  expect((await command(request("/api/test", { action: "acknowledge", operationId }), itemParams)).status).toBe(422);
  expect(mocks.acknowledge).not.toHaveBeenCalled();
  expect((await command(request("/api/test", { action: "acknowledge", operationId, expectedVersion: 2, sourceRevision: 3, dependentRevision: 4 }), itemParams)).status).toBe(200);
  expect(mocks.acknowledge).toHaveBeenCalledWith({}, expect.any(Object), workspaceId, edgeId, expect.objectContaining({ sourceRevision: 3, dependentRevision: 4 }));
  expect((await create(request("/api/test", { action: "note-material", operationId, kind: "link", sourceId: "source", sourceRevision: 2, expectedVersion: 1 }), listParams)).status).toBe(200);
  expect(mocks.material).toHaveBeenCalled();
  expect((await create(request("/api/test", { action: "download", operationId, expectedVersion: 1, kind: "link", sourceId: "source" }), listParams)).status).toBe(200);
  expect(mocks.download).toHaveBeenCalled();
});
