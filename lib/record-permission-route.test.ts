import { beforeEach, expect, it, vi } from "vitest";
import { DocumentError } from "./document";
const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), repository: vi.fn(), describe: vi.fn(), readMatrix: vi.fn(), apply: vi.fn() }));
vi.mock("./suite-tenant-authority", () => ({ authenticateRecordAuthority: mocks.authenticate }));
vi.mock("./repository", () => ({ repository: mocks.repository }));
vi.mock("./shared-record-permissions", async () => {
  const actual = await vi.importActual<typeof import("./shared-record-permissions")>("./shared-record-permissions");
  return { ...actual, SharedRecordPermissionRepository: class { describe = mocks.describe; readMatrix = mocks.readMatrix; apply = mocks.apply; } };
});
import { GET, POST } from "../app/api/v1/workspaces/[id]/tenants/[tenantId]/record-permissions/route";

const tenantId = "00000000-0000-4000-8000-000000000002",
  recordId = "00000000-0000-4000-8000-000000000003",
  scope = () => ({ params: Promise.resolve({ id: "workspace-a", tenantId }) });
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("HS_ORIGIN", "https://hs.example");
  mocks.authenticate.mockResolvedValue({ actor: { id: "verified-user" }, authority: { verify: vi.fn() } });
  mocks.repository.mockResolvedValue({});
});

it("describes the caller permissions and separates the member matrix", async () => {
  mocks.describe.mockResolvedValue({ fields: [{ key: "core:job-title", label: "Job title" }], canManage: false });
  const described = await GET(new Request(`https://hs.example/api/permissions?collection=contacts&recordId=${recordId}`), scope());
  expect(described.status).toBe(200);
  expect(described.headers.get("cache-control")).toBe("no-store");
  expect(mocks.describe).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "workspace-a", tenantId }), "contacts", recordId);
  expect(mocks.readMatrix).not.toHaveBeenCalled();
  mocks.readMatrix.mockResolvedValue({ members: [], sensitiveFields: [] });
  expect((await GET(new Request(`https://hs.example/api/permissions?collection=contacts&recordId=${recordId}&manage=1`), scope())).status).toBe(200);
  expect(mocks.readMatrix).toHaveBeenCalledWith(expect.objectContaining({ actor: { id: "verified-user" } }), "contacts", recordId);
});

it("applies a strict same-origin permission change and preserves safe denials", async () => {
  const body = { operationId: "00000000-0000-4000-8000-000000000004", collection: "contacts", subjectId: "member-a", fields: [{ key: "core:email", expectedVersion: 0, canView: true, canWrite: false, canHistory: false }] };
  const request = (origin = "https://hs.example") => new Request("https://hs.example/api/permissions", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(body) });
  expect((await POST(request("https://attacker.example"), scope())).status).toBe(403);
  expect(mocks.authenticate).not.toHaveBeenCalled();
  mocks.apply.mockResolvedValue({ replayed: false });
  expect((await POST(request(), scope())).status).toBe(200);
  expect(mocks.apply).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "workspace-a", tenantId }), body);
  mocks.apply.mockRejectedValue(new DocumentError("Record is restricted or unavailable.", "record_not_found", 404));
  const denied = await POST(request(), scope());
  expect(denied.status).toBe(404);
  expect(await denied.json()).toMatchObject({ code: "record_not_found", retryable: false });
});

it("rejects forged permission fields before storage", async () => {
  const response = await POST(new Request("https://hs.example/api/permissions", { method: "POST", headers: { Origin: "https://hs.example", "Content-Type": "application/json" }, body: JSON.stringify({ operationId: "00000000-0000-4000-8000-000000000004", collection: "contacts", subjectId: "member-a", actorId: "forged", fields: [{ key: "core:email", expectedVersion: 0, canView: true, canWrite: false, canHistory: false }] }) }), scope());
  expect(response.status).toBe(400);
  expect(mocks.apply).not.toHaveBeenCalled();
});
