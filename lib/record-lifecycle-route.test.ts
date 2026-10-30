import { beforeEach, expect, it, vi } from "vitest";
import { DocumentError } from "./document";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  repository: vi.fn(),
  archiveRecord: vi.fn(),
  previewDelete: vi.fn(),
  trashRecord: vi.fn(),
  restoreRecord: vi.fn(),
  listTrash: vi.fn(),
}));
vi.mock("./suite-tenant-authority", () => ({ authenticateRecordAuthority: mocks.authenticate }));
vi.mock("./repository", () => ({ repository: mocks.repository }));
vi.mock("./shared-record-lifecycle", () => ({
  SharedRecordLifecycleRepository: class {
    archiveRecord = mocks.archiveRecord;
    previewDelete = mocks.previewDelete;
    trashRecord = mocks.trashRecord;
    restoreRecord = mocks.restoreRecord;
    listTrash = mocks.listTrash;
  },
}));
import { POST } from "../app/api/v1/workspaces/[id]/tenants/[tenantId]/records/[recordId]/lifecycle/route";
import { GET } from "../app/api/v1/workspaces/[id]/tenants/[tenantId]/record-trash/route";

const tenantId = "00000000-0000-4000-8000-000000000002",
  recordId = "00000000-0000-4000-8000-000000000003",
  operationId = "00000000-0000-4000-8000-000000000004",
  previewId = "00000000-0000-4000-8000-000000000005",
  reviewHash = "ab".repeat(32),
  scope = () => ({ params: Promise.resolve({ id: "workspace-a", tenantId }) }),
  detail = () => ({ params: Promise.resolve({ id: "workspace-a", tenantId, recordId }) }),
  request = (data: unknown, origin = "https://hs.example") => new Request("https://hs.example/api/lifecycle", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(data) });
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("HS_ORIGIN", "https://hs.example");
  mocks.authenticate.mockResolvedValue({ actor: { id: "verified-user" }, authority: { verify: vi.fn() } });
  mocks.repository.mockResolvedValue({});
});

it("archives and unarchives through the authenticated record URL", async () => {
  mocks.archiveRecord.mockResolvedValue({ id: recordId, state: "archived", appliedVersion: 2, currentVersion: 2, replayed: false });
  const archived = await POST(request({ kind: "archive", operationId, expectedVersion: 1, archived: true }), detail());
  expect(archived.status).toBe(200);
  expect(archived.headers.get("cache-control")).toBe("no-store");
  expect(mocks.archiveRecord).toHaveBeenCalledWith(expect.objectContaining({ actor: { id: "verified-user" }, workspaceId: "workspace-a", tenantId }), recordId, { operationId, expectedVersion: 1, archived: true });
  await POST(request({ kind: "archive", operationId, expectedVersion: 2, archived: false }), detail());
  expect(mocks.archiveRecord).toHaveBeenLastCalledWith(expect.anything(), recordId, { operationId, expectedVersion: 2, archived: false });
});

it("reviews deletion and moves a record to Trash without adding denial details", async () => {
  const preview = { previewId, reviewHash, recordId, recordVersion: 4, blocked: true, message: "Resolve existing record, document or application associations before deletion.", expiresAt: "2026-10-30T23:00:00.000Z", trashDays: 30, permanentRemovalAvailable: false };
  mocks.previewDelete.mockResolvedValue(preview);
  const reviewed = await POST(request({ kind: "preview-delete", expectedVersion: 4 }), detail());
  expect(reviewed.status).toBe(200);
  expect(await reviewed.json()).toEqual(preview);
  expect(mocks.previewDelete).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "workspace-a", tenantId }), recordId, 4);
  mocks.trashRecord.mockRejectedValue(new DocumentError("Existing associations must be resolved before deletion.", "record_delete_referenced", 409));
  const denied = await POST(request({ kind: "trash", operationId, previewId, reviewHash, confirm: "move-to-tenant-trash" }), detail());
  expect(denied.status).toBe(409);
  expect(await denied.json()).toEqual({ error: "Existing associations must be resolved before deletion.", code: "record_delete_referenced", retryable: false });
  mocks.trashRecord.mockResolvedValue({ id: recordId, state: "trashed", appliedVersion: 5, currentVersion: 5, replayed: false, recoveryDeadline: "2026-11-29T23:00:00.000Z" });
  expect((await POST(request({ kind: "trash", operationId, previewId, reviewHash, confirm: "move-to-tenant-trash" }), detail())).status).toBe(200);
  expect(mocks.trashRecord).toHaveBeenLastCalledWith(expect.anything(), recordId, { operationId, previewId, reviewHash, confirm: "move-to-tenant-trash" });
});

it("restores by the same record ID and lists Trash with an opaque cursor", async () => {
  mocks.restoreRecord.mockResolvedValue({ id: recordId, state: "archived", appliedVersion: 6, currentVersion: 6, replayed: false });
  expect((await POST(request({ kind: "restore", operationId, expectedVersion: 5 }), detail())).status).toBe(200);
  expect(mocks.restoreRecord).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "workspace-a", tenantId }), recordId, { operationId, expectedVersion: 5 });
  const cursor = "a".repeat(43);
  mocks.listTrash.mockResolvedValue({ results: [], nextCursor: null, permanentRemovalAvailable: false });
  const listed = await GET(new Request(`https://hs.example/api/record-trash?collection=organisations&cursor=${cursor}`), scope());
  expect(listed.status).toBe(200);
  expect(listed.headers.get("cache-control")).toBe("no-store");
  expect(mocks.listTrash).toHaveBeenCalledWith(expect.objectContaining({ actor: { id: "verified-user" }, workspaceId: "workspace-a", tenantId }), "organisations", cursor);
});

it("denies cross-origin lifecycle writes before authentication and rejects forged fields", async () => {
  expect((await POST(request({ kind: "archive", operationId, expectedVersion: 1, archived: true }, "https://attacker.example"), detail())).status).toBe(403);
  expect(mocks.authenticate).not.toHaveBeenCalled();
  mocks.authenticate.mockResolvedValue({ actor: { id: "verified-user" }, authority: { verify: vi.fn() } });
  const forged = await POST(request({ kind: "trash", operationId, previewId, reviewHash, confirm: "move-to-tenant-trash", hiddenIds: ["secret"] }), detail());
  expect(forged.status).toBe(400);
  expect(mocks.trashRecord).not.toHaveBeenCalled();
  const wrong = await POST(request({ kind: "trash", operationId, previewId, reviewHash, confirm: "purge" }), detail());
  expect(wrong.status).toBe(400);
  expect(mocks.trashRecord).not.toHaveBeenCalled();
  const missing = await GET(new Request("https://hs.example/api/record-trash"), scope());
  expect(missing.status).toBe(400);
  expect(mocks.listTrash).not.toHaveBeenCalled();
});
