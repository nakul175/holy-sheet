import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  list: vi.fn(), create: vi.fn(), grant: vi.fn(), revoke: vi.fn(), read: vi.fn(), save: vi.fn(), stash: vi.fn(),
  discard: vi.fn(), publish: vi.fn(), share: vi.fn(), unshare: vi.fn(), archive: vi.fn(), preview: vi.fn(),
  download: vi.fn(), history: vi.fn(), snapshot: vi.fn(), repository: vi.fn(async () => ({})),
}));
vi.mock("./repository", () => ({ repository: mocks.repository }));
vi.mock("./document-bundles", () => ({
  listDocumentBundles: mocks.list,
  createDocumentBundle: mocks.create,
  grantBundleManager: mocks.grant,
  revokeBundleManager: mocks.revoke,
  readDocumentBundle: mocks.read,
  saveDocumentBundle: mocks.save,
  stashDocumentBundle: mocks.stash,
  discardDocumentBundleDraft: mocks.discard,
  publishDocumentBundle: mocks.publish,
  shareDocumentBundle: mocks.share,
  unshareDocumentBundle: mocks.unshare,
  archiveDocumentBundle: mocks.archive,
  previewDocumentBundle: mocks.preview,
  downloadDocumentBundle: mocks.download,
  bundleHistory: mocks.history,
  readPublishedSnapshot: mocks.snapshot,
}));
import { GET as list, POST as create } from "../app/api/v1/workspaces/[id]/document-bundles/route";
import { GET as read, POST as command } from "../app/api/v1/workspaces/[id]/document-bundles/[bundleId]/route";

const origin = "http://localhost:3000";
const workspaceId = "ws-aplyd";
const bundleId = "00000000-0000-4000-8000-0000000000b1";
const operationId = "00000000-0000-4000-8000-0000000000b2";
const listParams = { params: Promise.resolve({ id: workspaceId }) };
const itemParams = { params: Promise.resolve({ id: workspaceId, bundleId }) };
const request = (path: string, body: unknown, extra: Record<string, string> = {}) => new Request(origin + path, { method: "POST", headers: { origin, "content-type": "application/json", ...extra }, body: JSON.stringify(body) });

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("HS_LOCAL_PREVIEW", "1");
  vi.stubEnv("HS_ORIGIN", origin);
  vi.clearAllMocks();
  mocks.list.mockResolvedValue({ manage: true, bundles: [] });
  mocks.create.mockResolvedValue({ id: bundleId, version: 1 });
  mocks.read.mockResolvedValue({ id: bundleId, members: [] });
  mocks.preview.mockResolvedValue({ items: [] });
  mocks.history.mockResolvedValue({ events: [] });
  mocks.snapshot.mockResolvedValue({ immutable: true, members: [] });
  mocks.publish.mockResolvedValue({ id: bundleId, publicationNo: 1 });
  mocks.share.mockResolvedValue({ id: bundleId, version: 2 });
  mocks.unshare.mockResolvedValue({ id: bundleId, version: 3 });
  mocks.archive.mockResolvedValue({ id: bundleId, archived: true });
  mocks.save.mockResolvedValue({ id: bundleId, version: 2 });
  mocks.stash.mockResolvedValue({ id: bundleId, version: 1 });
  mocks.discard.mockResolvedValue({ id: bundleId });
  mocks.download.mockResolvedValue({ body: "# Bundle\n", filename: "bundle-package.md" });
});
afterEach(() => vi.unstubAllEnvs());

it("rejects a foreign origin and an extra field before creating a bundle", async () => {
  expect((await list(new Request(`${origin}/api/v1/workspaces/${workspaceId}/document-bundles?q=clinic`), listParams)).status).toBe(200);
  expect(mocks.list).toHaveBeenCalledWith({}, expect.any(Object), workspaceId, "clinic", null);
  const body = { action: "create", operationId, name: "Clinic packet", description: "Shared", ownerId: "owner", members: [], extra: true };
  expect((await create(request("/api/test", body, { origin: "https://foreign.invalid" }), listParams)).status).toBe(403);
  expect(mocks.create).not.toHaveBeenCalled();
  expect((await create(request("/api/test", body), listParams)).status).toBe(422);
  expect(mocks.create).not.toHaveBeenCalled();
  expect((await create(request("/api/test", { action: "create", operationId, name: "Clinic packet", ownerId: "owner" }), listParams)).status).toBe(200);
  expect(mocks.create).toHaveBeenCalledWith({}, expect.any(Object), workspaceId, expect.objectContaining({ name: "Clinic packet", description: "", members: [] }));
});

it("uses the same not-found response for a bad bundle id and a denied read", async () => {
  const deniedParams = { params: Promise.resolve({ id: workspaceId, bundleId: "not-a-uuid" }) };
  expect((await read(new Request(`${origin}/api/test`), deniedParams)).status).toBe(404);
  expect(mocks.read).not.toHaveBeenCalled();
  const { DocumentError } = await import("./document");
  mocks.read.mockRejectedValueOnce(new DocumentError("Document bundle unavailable", "not_found", 404));
  const denied = await read(new Request(`${origin}/api/test`), itemParams);
  expect(denied.status).toBe(404);
  expect(await denied.json()).toEqual({ error: "Document bundle unavailable", code: "not_found", retryable: false });
  expect((await read(new Request(`${origin}/api/test?view=history`), itemParams)).status).toBe(200);
  expect(mocks.history).toHaveBeenCalled();
  expect((await read(new Request(`${origin}/api/test?view=preview`), itemParams)).status).toBe(200);
  expect(mocks.preview).toHaveBeenCalledWith({}, expect.any(Object), workspaceId, bundleId, null);
});

it("requires the bundle command fields and does not call publish for a partial command", async () => {
  expect((await command(request("/api/test", { action: "publish", operationId }), itemParams)).status).toBe(422);
  expect(mocks.publish).not.toHaveBeenCalled();
  expect((await command(request("/api/test", { action: "publish", operationId, expectedVersion: 1 }), itemParams)).status).toBe(200);
  expect(mocks.publish).toHaveBeenCalled();
  expect((await command(request("/api/test", { action: "download", operationId, expectedVersion: 1, publicationId: bundleId }), itemParams)).status).toBe(200);
  expect(mocks.download).toHaveBeenCalledWith({}, expect.any(Object), workspaceId, bundleId, expect.objectContaining({ publicationId: bundleId }));
  expect((await command(request("/api/test", { action: "share", operationId, expectedVersion: 1, subjectId: "person", role: "viewer" }), itemParams)).status).toBe(200);
  expect(mocks.share).toHaveBeenCalled();
});
