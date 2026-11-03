import { afterEach, beforeEach, expect, it } from "vitest";
import { vi } from "vitest";

const mocks = vi.hoisted(() => ({
  catalogue: vi.fn(), read: vi.fn(), search: vi.fn(), history: vi.fn(), render: vi.fn(), create: vi.fn(), stash: vi.fn(), discard: vi.fn(),
  preview: vi.fn(), apply: vi.fn(), download: vi.fn(), grant: vi.fn(), revoke: vi.fn(),
  repository: vi.fn(async () => ({})),
}));
vi.mock("./repository", () => ({ repository: mocks.repository }));
vi.mock("./role-interface", () => ({
  roleInterfaceCatalogue: mocks.catalogue,
  readRoleInterface: mocks.read,
  searchRoleInterfaces: mocks.search,
  roleInterfaceHistory: mocks.history,
  renderRoleInterface: mocks.render,
  createRoleInterface: mocks.create,
  stashRoleInterface: mocks.stash,
  discardRoleInterfaceDraft: mocks.discard,
  previewRoleInterface: mocks.preview,
  applyRoleInterfacePreview: mocks.apply,
  downloadRoleInterface: mocks.download,
  grantRoleInterfaceManager: mocks.grant,
  revokeRoleInterfaceManager: mocks.revoke,
}));
import { GET, POST } from "../app/api/v1/workspaces/[id]/role-interfaces/route";

const origin = "http://localhost:3000";
const workspaceId = "ws-aplyd";
const interfaceId = "00000000-0000-4000-8000-0000000000e1";
const operationId = "00000000-0000-4000-8000-0000000000e2";
const params = { params: Promise.resolve({ id: workspaceId }) };
const definition = {
  navigation: [{ id: "home", label: "Clinic", screenId: "clinic" }],
  screens: [{ id: "clinic", name: "Clinic", components: [{ id: "edit", kind: "form", collection: "organisations", fields: [{ key: "core:notes", version: 1 }] }] }],
  roles: ["member"],
};
const request = (body: unknown, extra: Record<string, string> = {}) => new Request(origin + "/api/test", { method: "POST", headers: { origin, "content-type": "application/json", ...extra }, body: JSON.stringify(body) });

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("HS_LOCAL_PREVIEW", "1");
  vi.stubEnv("HS_ORIGIN", origin);
  vi.clearAllMocks();
  mocks.catalogue.mockResolvedValue({ manage: false, interfaces: [], sharing: "private" });
  mocks.search.mockResolvedValue({ results: [] });
  mocks.history.mockResolvedValue({ events: [], submissions: [] });
  mocks.render.mockResolvedValue({ browse: false, screens: [] });
  mocks.read.mockResolvedValue({ id: interfaceId, sharing: "private" });
  mocks.create.mockResolvedValue({ id: interfaceId, status: "draft", version: 1, sharing: "private" });
  mocks.preview.mockResolvedValue({ previewId: operationId });
  mocks.apply.mockResolvedValue({ status: "published", sharing: "private" });
  mocks.download.mockResolvedValue({ body: "# Interface", version: 1 });
});
afterEach(() => vi.unstubAllEnvs());

it("rejects a foreign origin, a script, and a public share before creating an interface", async () => {
  const listed = await GET(new Request(`${origin}/api/v1/workspaces/${workspaceId}/role-interfaces`), params);
  expect(listed.status).toBe(200);
  expect(listed.headers.get("cache-control")).toBe("no-store");
  expect(mocks.catalogue).toHaveBeenCalledWith({}, expect.any(Object), workspaceId);
  const body = { action: "create", operationId, name: "Clinic desk", definition, script: "alert(1)" };
  expect((await POST(request(body, { origin: "https://foreign.invalid" }), params)).status).toBe(403);
  expect(mocks.create).not.toHaveBeenCalled();
  expect((await POST(request(body), params)).status).toBe(422);
  expect((await POST(request({ action: "create", operationId, name: "Clinic desk", definition, url: "https://evil.example" }), params)).status).toBe(422);
  expect(mocks.create).not.toHaveBeenCalled();
  expect((await POST(request({ action: "create", operationId, name: "Clinic desk", definition }), params)).status).toBe(200);
  expect(mocks.create).toHaveBeenCalledWith({}, expect.any(Object), workspaceId, expect.objectContaining({ name: "Clinic desk" }));
});

it("uses the same not-found response for a missing interface and a denied read", async () => {
  expect((await GET(new Request(`${origin}/api/v1/workspaces/${workspaceId}/role-interfaces?view=search`), params)).status).toBe(422);
  expect(mocks.search).not.toHaveBeenCalled();
  expect((await GET(new Request(`${origin}/api/v1/workspaces/${workspaceId}/role-interfaces?view=interface`), params)).status).toBe(404);
  const { DocumentError } = await import("./document");
  mocks.read.mockRejectedValueOnce(new DocumentError("Interfaces are restricted or unavailable.", "not_found", 404));
  const denied = await GET(new Request(`${origin}/api/v1/workspaces/${workspaceId}/role-interfaces?view=interface&interfaceId=${interfaceId}`), params);
  expect(denied.status).toBe(404);
  expect(await denied.json()).toEqual({ error: "Interfaces are restricted or unavailable.", code: "not_found", retryable: false });
  expect((await GET(new Request(`${origin}/api/v1/workspaces/nope/role-interfaces`), { params: Promise.resolve({ id: "" }) })).status).toBe(404);
  expect((await GET(new Request(`${origin}/api/v1/workspaces/${workspaceId}/role-interfaces?view=render&interfaceId=${interfaceId}`), params)).status).toBe(200);
  expect(mocks.render).toHaveBeenCalled();
  expect((await POST(request({ action: "preview", operationId, interfaceId, kind: "submit", expectedVersion: 1, componentId: "edit", recordId: interfaceId, schemaVersion: 1, values: { "core:notes": "Hello" }, script: true }), params)).status).toBe(422);
  expect(mocks.preview).not.toHaveBeenCalled();
  expect((await POST(request({ action: "preview", operationId, interfaceId, kind: "publish", expectedVersion: 1 }), params)).status).toBe(200);
  expect(mocks.preview).toHaveBeenCalled();
  expect((await POST(request({ action: "download", operationId, interfaceId, expectedVersion: 1 }), params)).status).toBe(200);
  expect(mocks.download).toHaveBeenCalled();
});
