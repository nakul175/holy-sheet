import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  catalogue: vi.fn(), read: vi.fn(), open: vi.fn(), search: vi.fn(), history: vi.fn(),
  configure: vi.fn(), stash: vi.fn(), discard: vi.fn(), preview: vi.fn(), pause: vi.fn(), revoke: vi.fn(),
  activate: vi.fn(), link: vi.fn(), actions: vi.fn(), grant: vi.fn(), ungrant: vi.fn(),
  form: vi.fn(), comment: vi.fn(), file: vi.fn(), download: vi.fn(), repository: vi.fn(async () => ({})),
}));
vi.mock("./repository", () => ({ repository: mocks.repository }));
vi.mock("./guest-portal", () => ({
  guestPortalCatalogue: mocks.catalogue,
  readGuestPortal: mocks.read,
  openGuestPortal: mocks.open,
  searchGuestPortals: mocks.search,
  guestPortalHistory: mocks.history,
  saveGuestPortal: mocks.configure,
  stashGuestPortal: mocks.stash,
  discardGuestPortalDraft: mocks.discard,
  previewGuestPortal: mocks.preview,
  pauseGuestPortal: mocks.pause,
  revokeGuestPortal: mocks.revoke,
  activateGuestPortal: mocks.activate,
  linkGuestIdentity: mocks.link,
  setGuestPortalActions: mocks.actions,
  grantGuestPortalManager: mocks.grant,
  revokeGuestPortalManager: mocks.ungrant,
  submitGuestForm: mocks.form,
  addGuestComment: mocks.comment,
  citeGuestFile: mocks.file,
  downloadGuestPortal: mocks.download,
}));
import { GET, POST } from "../app/api/v1/workspaces/[id]/guest-portals/route";

const origin = "http://localhost:3000";
const workspaceId = "ws-aplyd";
const portalId = "00000000-0000-4000-8000-0000000000c1";
const operationId = "00000000-0000-4000-8000-0000000000c2";
const params = { params: Promise.resolve({ id: workspaceId }) };
const request = (body: unknown, extra: Record<string, string> = {}) => new Request(origin + "/api/test", { method: "POST", headers: { origin, "content-type": "application/json", ...extra }, body: JSON.stringify(body) });

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("HS_LOCAL_PREVIEW", "1");
  vi.stubEnv("HS_ORIGIN", origin);
  vi.clearAllMocks();
  mocks.catalogue.mockResolvedValue({ manage: false, portals: [], accessGranted: false, sharing: "off" });
  mocks.open.mockResolvedValue({ admitted: false, sharing: "off", accessGranted: false });
  mocks.search.mockResolvedValue({ results: [] });
  mocks.history.mockResolvedValue({ events: [] });
  mocks.read.mockResolvedValue({ id: portalId, sharing: "off" });
  mocks.preview.mockResolvedValue({ id: portalId, sharing: "off", accessGranted: false, cache: "no-store" });
});
afterEach(() => vi.unstubAllEnvs());

it("keeps portal reads uncached and rejects a foreign origin before configuration", async () => {
  const listed = await GET(new Request(`${origin}/api/v1/workspaces/${workspaceId}/guest-portals`), params);
  expect(listed.status).toBe(200);
  expect(listed.headers.get("cache-control")).toBe("no-store");
  const body = { action: "configure", operationId, expectedVersion: 0, name: "Clinic", definition: { screens: [] }, cookies: "session=abc", invitation: true };
  expect((await POST(request(body, { origin: "https://foreign.invalid" }), params)).status).toBe(403);
  expect(mocks.configure).not.toHaveBeenCalled();
  expect((await POST(request(body), params)).status).toBe(422);
  expect(mocks.configure).not.toHaveBeenCalled();
  expect((await POST(request({ action: "preview", operationId, portalId, expectedVersion: 1 }), params)).status).toBe(200);
  expect(mocks.preview).toHaveBeenCalled();
});

it("uses the same not-found response for a missing portal and a denied open", async () => {
  expect((await GET(new Request(`${origin}/api/v1/workspaces/${workspaceId}/guest-portals?view=search`), params)).status).toBe(422);
  expect(mocks.search).not.toHaveBeenCalled();
  expect((await GET(new Request(`${origin}/api/v1/workspaces/${workspaceId}/guest-portals?view=open&urlToken=${portalId}&domain=partner.example`), params)).status).toBe(404);
  expect(mocks.open).not.toHaveBeenCalled();
  const { DocumentError } = await import("./document");
  mocks.open.mockRejectedValueOnce(new DocumentError("Guest portals are restricted or unavailable.", "not_found", 404));
  const denied = await GET(new Request(`${origin}/api/v1/workspaces/${workspaceId}/guest-portals?view=open&portalId=${portalId}&urlToken=secret-token&domain=partner.example`), params);
  expect(denied.status).toBe(404);
  const payload = await denied.json();
  expect(payload).toEqual({ error: "Guest portals are restricted or unavailable.", code: "not_found", retryable: false });
  expect(JSON.stringify(payload)).not.toContain("secret-token");
  expect(denied.headers.get("cache-control")).toBe("no-store");
});
