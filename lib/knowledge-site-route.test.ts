import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  catalogue: vi.fn(), read: vi.fn(), search: vi.fn(), history: vi.fn(), render: vi.fn(), asset: vi.fn(), downloadRead: vi.fn(),
  configure: vi.fn(), discard: vi.fn(), preview: vi.fn(), publish: vi.fn(), unpublish: vi.fn(), rollback: vi.fn(),
  activate: vi.fn(), download: vi.fn(), actions: vi.fn(), grant: vi.fn(), ungrant: vi.fn(), repository: vi.fn(async () => ({})),
}));
vi.mock("./repository", () => ({ repository: mocks.repository }));
vi.mock("./knowledge-site", () => ({
  knowledgeSiteCatalogue: mocks.catalogue,
  readKnowledgeSite: mocks.read,
  searchKnowledgeSites: mocks.search,
  knowledgeSiteHistory: mocks.history,
  renderKnowledgeSite: mocks.render,
  readKnowledgeAsset: mocks.asset,
  readKnowledgeDownload: mocks.downloadRead,
  saveKnowledgeSite: mocks.configure,
  discardKnowledgeSiteDraft: mocks.discard,
  previewKnowledgeSite: mocks.preview,
  publishKnowledgeSite: mocks.publish,
  unpublishKnowledgeSite: mocks.unpublish,
  rollbackKnowledgeSite: mocks.rollback,
  activateKnowledgeSite: mocks.activate,
  downloadKnowledgeSite: mocks.download,
  setKnowledgeSiteActions: mocks.actions,
  grantKnowledgeSiteManager: mocks.grant,
  revokeKnowledgeSiteManager: mocks.ungrant,
}));
import { GET, POST } from "../app/api/v1/workspaces/[id]/knowledge-sites/route";

const origin = "http://localhost:3000";
const workspaceId = "ws-aplyd";
const siteId = "00000000-0000-4000-8000-0000000000d1";
const operationId = "00000000-0000-4000-8000-0000000000d2";
const params = { params: Promise.resolve({ id: workspaceId }) };
const request = (body: unknown, extra: Record<string, string> = {}) => new Request(origin + "/api/test", { method: "POST", headers: { origin, "content-type": "application/json", host: "localhost:3000", ...extra }, body: JSON.stringify(body) });

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("HS_LOCAL_PREVIEW", "1");
  vi.stubEnv("HS_ORIGIN", origin);
  vi.clearAllMocks();
  mocks.catalogue.mockResolvedValue({ manage: false, sites: [], accessGranted: false, sharing: "off", liveSite: false, domain: null });
  mocks.search.mockResolvedValue({ results: [] });
  mocks.history.mockResolvedValue({ events: [] });
  mocks.render.mockResolvedValue({ id: siteId, sharing: "off", liveSite: false, cache: "no-store" });
  mocks.read.mockResolvedValue({ id: siteId, sharing: "off", liveSite: false });
  mocks.preview.mockResolvedValue({ id: siteId, sharing: "off", accessGranted: false, dryRun: true, cache: "no-store" });
  mocks.downloadRead.mockResolvedValue({ body: "Sharing: off.", cache: "no-store", liveSite: false });
});
afterEach(() => vi.unstubAllEnvs());

it("keeps knowledge-site reads uncached and rejects a public audience that was not confirmed", async () => {
  const listed = await GET(new Request(`${origin}/api/v1/workspaces/${workspaceId}/knowledge-sites`, { headers: { host: "localhost:3000" } }), params);
  expect(listed.status).toBe(200);
  expect(listed.headers.get("cache-control")).toBe("no-store");
  const body = { action: "publish", operationId, siteId, expectedVersion: 1 };
  expect((await POST(request(body, { origin: "https://foreign.invalid" }), params)).status).toBe(403);
  expect(mocks.publish).not.toHaveBeenCalled();
  expect((await POST(request(body), params)).status).toBe(422);
  expect(mocks.publish).not.toHaveBeenCalled();
  expect((await POST(request({ action: "publish", operationId, siteId, expectedVersion: 1, audience: "public", domain: "help.example" }), params)).status).toBe(422);
  expect(mocks.publish).not.toHaveBeenCalled();
  expect((await POST(request({ action: "preview", operationId, siteId, expectedVersion: 1 }), params)).status).toBe(200);
  expect(mocks.preview).toHaveBeenCalled();
});

it("uses the same not-found response for a missing site and does not serve a stale generation", async () => {
  expect((await GET(new Request(`${origin}/api/v1/workspaces/${workspaceId}/knowledge-sites?view=search`, { headers: { host: "localhost:3000" } }), params)).status).toBe(422);
  expect(mocks.search).not.toHaveBeenCalled();
  expect((await GET(new Request(`${origin}/api/v1/workspaces/${workspaceId}/knowledge-sites?view=site`, { headers: { host: "localhost:3000" } }), params)).status).toBe(404);
  expect(mocks.read).not.toHaveBeenCalled();
  const { DocumentError } = await import("./document");
  mocks.render.mockRejectedValueOnce(new DocumentError("Knowledge sites are restricted or unavailable.", "not_found", 404));
  const denied = await GET(new Request(`${origin}/api/v1/workspaces/${workspaceId}/knowledge-sites?view=render&siteId=${siteId}&generation=2`, { headers: { host: "localhost:3000" } }), params);
  expect(denied.status).toBe(404);
  const payload = await denied.json();
  expect(payload).toEqual({ error: "Knowledge sites are restricted or unavailable.", code: "not_found", retryable: false });
  expect(denied.headers.get("cache-control")).toBe("no-store");
  const asset = await GET(new Request(`${origin}/api/v1/workspaces/${workspaceId}/knowledge-sites?view=asset&siteId=${siteId}`, { headers: { host: "localhost:3000" } }), params);
  expect(asset.status).toBe(404);
  expect(mocks.asset).not.toHaveBeenCalled();
});
