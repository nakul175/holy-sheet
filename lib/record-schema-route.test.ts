import { beforeEach, expect, it, vi } from "vitest";
import { DocumentError } from "./document";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), repository: vi.fn(), describeSchema: vi.fn(), previewSchema: vi.fn(), applySchema: vi.fn() }));
vi.mock("./suite-tenant-authority", () => ({ authenticateRecordAuthority: mocks.authenticate }));
vi.mock("./repository", () => ({ repository: mocks.repository }));
vi.mock("./shared-record-schema", async () => {
  const actual = await vi.importActual<typeof import("./shared-record-schema")>("./shared-record-schema");
  return { ...actual, SharedRecordSchemaRepository: class { describeSchema = mocks.describeSchema; previewSchema = mocks.previewSchema; applySchema = mocks.applySchema; } };
});
import { GET, POST } from "../app/api/v1/workspaces/[id]/tenants/[tenantId]/record-schema/route";

const tenantId = "00000000-0000-4000-8000-000000000002",
  operationId = "00000000-0000-4000-8000-000000000004",
  scope = () => ({ params: Promise.resolve({ id: "workspace-a", tenantId }) }),
  request = (data: unknown, origin = "https://hs.example") => new Request("https://hs.example/api/record-schema", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(data) });
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("HS_ORIGIN", "https://hs.example");
  mocks.authenticate.mockResolvedValue({ actor: { id: "verified-user" }, authority: { verify: vi.fn() } });
  mocks.repository.mockResolvedValue({});
});

it("describes collection fields for the authenticated workspace and tenant", async () => {
  mocks.describeSchema.mockResolvedValue({ schemaVersion: 2, canManage: true, customFieldCount: 0, fields: [{ key: "core:domain", core: true }] });
  const response = await GET(new Request("https://hs.example/api/record-schema?collection=organisations"), scope());
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(mocks.describeSchema).toHaveBeenCalledWith(expect.objectContaining({ actor: { id: "verified-user" }, workspaceId: "workspace-a", tenantId }), "organisations");
});

it("previews and applies a typed custom field without treating schema review as a value read", async () => {
  const definition = { label: "Department", kind: "text", required: false, defaultValue: "Future", choices: [], sensitive: true, unique: false, deprecated: false };
  const prepare = { prepareId: operationId, collection: "organisations", expectedSchemaVersion: 3, definition };
  mocks.previewSchema.mockResolvedValue({ previewId: operationId, reviewHash: "ab".repeat(32), impact: { blockers: [] } });
  expect((await POST(request({ kind: "preview", ...prepare }), scope())).status).toBe(200);
  expect(mocks.previewSchema).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "workspace-a", tenantId }), prepare);
  const apply = { previewId: operationId, operationId, reviewHash: "ab".repeat(32) };
  mocks.applySchema.mockResolvedValue({ fieldKey: operationId, appliedSchemaVersion: 4, currentSchemaVersion: 4, replayed: false });
  expect((await POST(request({ kind: "apply", ...apply }), scope())).status).toBe(200);
  expect(mocks.applySchema).toHaveBeenCalledWith(expect.objectContaining({ actor: { id: "verified-user" } }), apply);
});

it("rejects cross-origin writes, forged fields, and unknown types before storage", async () => {
  const definition = { label: "Department", kind: "text", required: false, choices: [], sensitive: false, unique: false, deprecated: false };
  expect((await POST(request({ kind: "preview", prepareId: operationId, collection: "organisations", expectedSchemaVersion: 1, definition }, "https://attacker.example"), scope())).status).toBe(403);
  expect(mocks.authenticate).not.toHaveBeenCalled();
  const forged = await POST(request({ kind: "preview", prepareId: operationId, collection: "organisations", expectedSchemaVersion: 1, definition, actorId: "forged" }), scope());
  expect(forged.status).toBe(400);
  expect(mocks.previewSchema).not.toHaveBeenCalled();
  const core = await POST(request({ kind: "preview", prepareId: operationId, collection: "organisations", fieldKey: "core:domain", expectedSchemaVersion: 1, definition }), scope());
  expect(core.status).toBe(400);
  const computed = await POST(request({ kind: "preview", prepareId: operationId, collection: "organisations", expectedSchemaVersion: 1, definition: { ...definition, kind: "formula" } }), scope());
  expect(computed.status).toBe(400);
  expect(mocks.previewSchema).not.toHaveBeenCalled();
  mocks.applySchema.mockRejectedValue(new DocumentError("The schema preview expired.", "schema_preview_expired", 410));
  const expired = await POST(request({ kind: "apply", previewId: operationId, operationId, reviewHash: "a".repeat(64) }), scope());
  expect(expired.status).toBe(410);
  expect(await expired.json()).toMatchObject({ code: "schema_preview_expired", retryable: false });
});
