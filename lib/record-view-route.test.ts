import { beforeEach, expect, it, vi } from "vitest";
import { DocumentError } from "./document";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), repository: vi.fn(), listViews: vi.fn(), queryView: vi.fn(), saveView: vi.fn(), deleteView: vi.fn() }));
vi.mock("./suite-tenant-authority", () => ({ authenticateRecordAuthority: mocks.authenticate }));
vi.mock("./repository", () => ({ repository: mocks.repository }));
vi.mock("./shared-record-views", async () => {
  const actual = await vi.importActual<typeof import("./shared-record-views")>("./shared-record-views");
  return { ...actual, SharedRecordViewRepository: class { listViews = mocks.listViews; queryView = mocks.queryView; saveView = mocks.saveView; deleteView = mocks.deleteView; } };
});
import { GET, POST } from "../app/api/v1/workspaces/[id]/tenants/[tenantId]/record-views/route";
import { GET as QUERY } from "../app/api/v1/workspaces/[id]/tenants/[tenantId]/record-views/[viewId]/route";

const tenantId = "00000000-0000-4000-8000-000000000002",
  viewId = "00000000-0000-4000-8000-000000000011",
  sharedId = "00000000-0000-4000-8000-000000000012",
  operationId = "00000000-0000-4000-8000-000000000004",
  scope = () => ({ params: Promise.resolve({ id: "workspace-a", tenantId }) }),
  detail = () => ({ params: Promise.resolve({ id: "workspace-a", tenantId, viewId }) }),
  definition = { columns: ["name"], filters: [{ field: "name", operator: "prefix" as const, value: "Ac" }], sort: [{ field: "name", direction: "asc" as const }], includeArchived: false },
  request = (data: unknown, origin = "https://hs.example") => new Request("https://hs.example/api/record-views", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(data) });
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("HS_ORIGIN", "https://hs.example");
  mocks.authenticate.mockResolvedValue({ actor: { id: "verified-user" }, authority: { verify: vi.fn() } });
  mocks.repository.mockResolvedValue({});
});

it("lists saved views for the authenticated workspace and tenant", async () => {
  mocks.listViews.mockResolvedValue({ views: [{ id: viewId, scope: "private", canManage: true }] });
  const response = await GET(new Request("https://hs.example/api/record-views?collection=organisations"), scope());
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(mocks.listViews).toHaveBeenCalledWith(expect.objectContaining({ actor: { id: "verified-user" }, workspaceId: "workspace-a", tenantId }), "organisations");
  expect(mocks.queryView).not.toHaveBeenCalled();
});

it("runs a view with an opaque cursor bound to the URL scope", async () => {
  const cursor = "a".repeat(43);
  mocks.queryView.mockResolvedValue({ view: { id: viewId }, fields: [], results: [], nextCursor: null });
  const response = await QUERY(new Request(`https://hs.example/api/record-views/${viewId}?cursor=${cursor}`), detail());
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(mocks.queryView).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "workspace-a", tenantId }), viewId, cursor);
  mocks.queryView.mockRejectedValue(new DocumentError("This view includes a restricted filter or sort. Review its configuration.", "record_view_restricted", 403));
  const restricted = await QUERY(new Request(`https://hs.example/api/record-views/${viewId}`), detail());
  expect(restricted.status).toBe(403);
  expect(await restricted.json()).toMatchObject({ code: "record_view_restricted", retryable: false });
});

it("saves a personal view and forwards a shared copy as a new view id", async () => {
  const personal = { kind: "save", id: viewId, operationId, collection: "organisations", scope: "private", name: "Open organisations", expectedVersion: 0, definition };
  mocks.saveView.mockResolvedValue({ id: viewId, appliedVersion: 1, currentVersion: 1, deleted: false, replayed: false });
  expect((await POST(request(personal), scope())).status).toBe(200);
  expect(mocks.saveView).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "workspace-a", tenantId }), { id: viewId, operationId, collection: "organisations", scope: "private", name: "Open organisations", expectedVersion: 0, definition });
  const copy = { ...personal, id: sharedId, operationId, scope: "workspace", name: "Open organisations shared", expectedVersion: 0 };
  mocks.saveView.mockResolvedValue({ id: sharedId, appliedVersion: 1, currentVersion: 1, deleted: false, replayed: false });
  expect((await POST(request(copy), scope())).status).toBe(200);
  expect(mocks.saveView).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ id: sharedId, scope: "workspace", expectedVersion: 0 }));
  expect(mocks.saveView.mock.calls.at(-1)?.[1].id).not.toBe(viewId);
});

it("deletes through the same authority and preserves safe denials", async () => {
  const body = { kind: "delete", id: viewId, operationId, expectedVersion: 1 };
  mocks.deleteView.mockResolvedValue({ id: viewId, appliedVersion: 2, currentVersion: 2, replayed: false });
  expect((await POST(request(body), scope())).status).toBe(200);
  expect(mocks.deleteView).toHaveBeenCalledWith(expect.objectContaining({ actor: { id: "verified-user" } }), { id: viewId, operationId, expectedVersion: 1 });
  expect(mocks.saveView).not.toHaveBeenCalled();
  mocks.deleteView.mockRejectedValue(new DocumentError("View management is not permitted.", "record_view_forbidden", 403));
  const denied = await POST(request(body), scope());
  expect(denied.status).toBe(403);
  expect(await denied.json()).toMatchObject({ code: "record_view_forbidden", retryable: false });
});

it("rejects cross-origin writes, forged fields, unsupported predicates and bad cursors before storage", async () => {
  expect((await POST(request({ kind: "save", id: viewId, operationId, collection: "organisations", scope: "private", name: "Mine", expectedVersion: 0, definition }, "https://attacker.example"), scope())).status).toBe(403);
  expect(mocks.authenticate).not.toHaveBeenCalled();
  const forged = await POST(request({ kind: "save", id: viewId, operationId, collection: "organisations", scope: "private", name: "Mine", expectedVersion: 0, definition, actorId: "forged" }), scope());
  expect(forged.status).toBe(400);
  const nested = await POST(request({ kind: "save", id: viewId, operationId, collection: "organisations", scope: "private", name: "Mine", expectedVersion: 0, definition: { ...definition, filters: [{ field: "name", operator: "or", value: [{ operator: "equal", value: "A" }] }] } }), scope());
  expect(nested.status).toBe(400);
  const audience = await POST(request({ kind: "save", id: viewId, operationId, collection: "organisations", scope: "everyone", name: "Mine", expectedVersion: 0, definition }), scope());
  expect(audience.status).toBe(400);
  expect(mocks.saveView).not.toHaveBeenCalled();
  const cursor = await QUERY(new Request(`https://hs.example/api/record-views/${viewId}?cursor=short`), detail());
  expect(cursor.status).toBe(400);
  expect(await cursor.json()).toMatchObject({ code: "record_view_cursor_invalid" });
  const missing = await QUERY(new Request("https://hs.example/api/record-views/not-a-view"), { params: Promise.resolve({ id: "workspace-a", tenantId, viewId: "not-a-view" }) });
  expect(missing.status).toBe(404);
  expect(mocks.queryView).not.toHaveBeenCalled();
});
