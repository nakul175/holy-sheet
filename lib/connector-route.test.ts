import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  catalogue: vi.fn(), read: vi.fn(), search: vi.fn(), history: vi.fn(), inventory: vi.fn(),
  configure: vi.fn(), stash: vi.fn(), discard: vi.fn(), preview: vi.fn(), enable: vi.fn(), pause: vi.fn(),
  disconnect: vi.fn(), activate: vi.fn(), delegate: vi.fn(), sync: vi.fn(), review: vi.fn(), merge: vi.fn(),
  download: vi.fn(), actions: vi.fn(), grant: vi.fn(), ungrant: vi.fn(), repository: vi.fn(async () => ({})),
}));
vi.mock("./repository", () => ({ repository: mocks.repository }));
vi.mock("./connector", () => ({
  connectorCatalogue: mocks.catalogue,
  readConnector: mocks.read,
  searchConnectors: mocks.search,
  connectorHistory: mocks.history,
  connectorInventoryView: mocks.inventory,
  saveConnector: mocks.configure,
  stashConnector: mocks.stash,
  discardConnectorDraft: mocks.discard,
  previewConnector: mocks.preview,
  enableConnector: mocks.enable,
  pauseConnector: mocks.pause,
  disconnectConnector: mocks.disconnect,
  activateConnector: mocks.activate,
  delegateConnector: mocks.delegate,
  syncConnector: mocks.sync,
  reviewConnectorConflict: mocks.review,
  mergeConnector: mocks.merge,
  downloadConnectorReport: mocks.download,
  setConnectorActions: mocks.actions,
  grantConnectorManager: mocks.grant,
  revokeConnectorManager: mocks.ungrant,
}));
import { GET, POST } from "../app/api/v1/workspaces/[id]/connectors/route";

const origin = "http://localhost:3000";
const workspaceId = "ws-aplyd";
const connectorId = "00000000-0000-4000-8000-0000000000c1";
const operationId = "00000000-0000-4000-8000-0000000000c2";
const params = { params: Promise.resolve({ id: workspaceId }) };
const request = (body: unknown, extra: Record<string, string> = {}) => new Request(origin + "/api/test", { method: "POST", headers: { origin, "content-type": "application/json", host: "localhost:3000", ...extra }, body: JSON.stringify(body) });

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("HS_LOCAL_PREVIEW", "1");
  vi.stubEnv("HS_ORIGIN", origin);
  vi.clearAllMocks();
  mocks.catalogue.mockResolvedValue({ manage: false, connectors: [], accessGranted: false, sharing: "off", secretVisible: false });
  mocks.search.mockResolvedValue({ results: [] });
  mocks.history.mockResolvedValue({ events: [] });
  mocks.inventory.mockResolvedValue({ residency: "tenant", connectors: [], secretVisible: false, liveActivation: false });
  mocks.read.mockResolvedValue({ id: connectorId, sharing: "off", secretVisible: false });
  mocks.preview.mockResolvedValue({ id: connectorId, sharing: "off", accessGranted: false, dryRun: true, cache: "no-store", secretVisible: false });
});
afterEach(() => vi.unstubAllEnvs());

it("keeps connector reads uncached and rejects a foreign origin before configuration", async () => {
  const listed = await GET(new Request(`${origin}/api/v1/workspaces/${workspaceId}/connectors`, { headers: { host: "localhost:3000" } }), params);
  expect(listed.status).toBe(200);
  expect(listed.headers.get("cache-control")).toBe("no-store");
  const body = { action: "configure", operationId, expectedVersion: 0, name: "Clinic", definition: { type: "records" }, password: "hs-secret:super-secret-value" };
  expect((await POST(request(body, { origin: "https://foreign.invalid" }), params)).status).toBe(403);
  expect(mocks.configure).not.toHaveBeenCalled();
  expect((await POST(request(body), params)).status).toBe(422);
  expect(mocks.configure).not.toHaveBeenCalled();
  expect((await POST(request({ action: "preview", operationId, connectorId, expectedVersion: 1 }), params)).status).toBe(200);
  expect(mocks.preview).toHaveBeenCalled();
});

it("uses the same not-found response for a missing connector and does not echo a secret", async () => {
  expect((await GET(new Request(`${origin}/api/v1/workspaces/${workspaceId}/connectors?view=search`, { headers: { host: "localhost:3000" } }), params)).status).toBe(422);
  expect(mocks.search).not.toHaveBeenCalled();
  expect((await GET(new Request(`${origin}/api/v1/workspaces/${workspaceId}/connectors?view=connector`, { headers: { host: "localhost:3000" } }), params)).status).toBe(404);
  expect(mocks.read).not.toHaveBeenCalled();
  const { DocumentError } = await import("./document");
  mocks.read.mockRejectedValueOnce(new DocumentError("Connectors are restricted or unavailable.", "not_found", 404));
  const denied = await GET(new Request(`${origin}/api/v1/workspaces/${workspaceId}/connectors?view=connector&connectorId=${connectorId}&secret=hs-secret:super-secret-value`, { headers: { host: "localhost:3000" } }), params);
  expect(denied.status).toBe(404);
  const payload = await denied.json();
  expect(payload).toEqual({ error: "Connectors are restricted or unavailable.", code: "not_found", retryable: false });
  expect(JSON.stringify(payload)).not.toContain("hs-secret");
  expect(denied.headers.get("cache-control")).toBe("no-store");
  const inventory = await GET(new Request(`${origin}/api/v1/workspaces/${workspaceId}/connectors?view=inventory`, { headers: { host: "localhost:3000" } }), params);
  expect(inventory.status).toBe(200);
  expect(JSON.stringify(await inventory.json())).toContain("tenant");
});
