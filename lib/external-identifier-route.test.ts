import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), repository: vi.fn(), listMappings: vi.fn(), previewMapping: vi.fn(), registerMapping: vi.fn(), setMappingState: vi.fn(), saveDraft: vi.fn(), discardDraft: vi.fn(), grantIntegration: vi.fn(), mappingHistory: vi.fn(), downloadMappings: vi.fn() }));
vi.mock("./suite-tenant-authority", () => ({ authenticateRecordAuthority: mocks.authenticate }));
vi.mock("./repository", () => ({ repository: mocks.repository }));
vi.mock("./external-identifier-mappings", () => ({ ExternalIdentifierRepository: class { listMappings = mocks.listMappings; previewMapping = mocks.previewMapping; registerMapping = mocks.registerMapping; setMappingState = mocks.setMappingState; saveDraft = mocks.saveDraft; discardDraft = mocks.discardDraft; grantIntegration = mocks.grantIntegration; mappingHistory = mocks.mappingHistory; downloadMappings = mocks.downloadMappings; } }));
import { GET, POST } from "../app/api/v1/workspaces/[id]/tenants/[tenantId]/external-identifiers/route";
import { GET as DOWNLOAD } from "../app/api/v1/workspaces/[id]/tenants/[tenantId]/external-identifiers/download/route";
import { GET as HISTORY } from "../app/api/v1/workspaces/[id]/tenants/[tenantId]/external-identifiers/[mappingId]/history/route";

const tenantId = "00000000-0000-4000-8000-000000000002";
const recordId = "00000000-0000-4000-8000-000000000011";
const mappingId = "00000000-0000-4000-8000-000000000012";
const operationId = "00000000-0000-4000-8000-000000000004";
const previewId = "00000000-0000-4000-8000-000000000013";
const scope = () => ({ params: Promise.resolve({ id: "workspace-a", tenantId }) });
const detail = () => ({ params: Promise.resolve({ id: "workspace-a", tenantId, mappingId }) });
const request = (data: unknown, origin = "https://hs.example") => new Request("https://hs.example/api/external-identifiers", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(data) });

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("HS_ORIGIN", "https://hs.example");
  mocks.authenticate.mockResolvedValue({ actor: { id: "verified-user" }, authority: { verify: vi.fn() } });
  mocks.repository.mockResolvedValue({});
});

it("searches identifiers for the authenticated tenant without trusting a caller actor", async () => {
  mocks.listMappings.mockResolvedValue({ mappings: [], drafts: [], credentialsStored: false, accessGranted: false });
  const response = await GET(new Request(`https://hs.example/api/external-identifiers?collection=organisations&recordId=${recordId}&q=cust`), scope());
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(mocks.listMappings).toHaveBeenCalledWith(expect.objectContaining({ actor: { id: "verified-user" }, workspaceId: "workspace-a", tenantId }), { collection: "organisations", recordId, query: "cust", namespace: undefined });
});

it("rejects a forged actor, a cross-origin write, and a credential payload before the repository", async () => {
  const preview = { kind: "preview", recordId, namespace: "billing.app", externalId: "cust-1", provenanceLabel: "billing import" };
  expect((await POST(request(preview, "https://attacker.example"), scope())).status).toBe(403);
  expect((await POST(request({ ...preview, actorId: "forged" }), scope())).status).toBe(400);
  expect((await POST(request({ ...preview, password: "hunter2" }), scope())).status).toBe(400);
  expect(mocks.previewMapping).not.toHaveBeenCalled();
  mocks.previewMapping.mockResolvedValue({ previewId, reviewHash: "a".repeat(64), conflict: null });
  expect((await POST(request(preview), scope())).status).toBe(200);
  expect(mocks.previewMapping).toHaveBeenCalledWith(expect.anything(), expect.not.objectContaining({ kind: "preview", password: expect.anything() }));
});

it("passes an explicit reassignment review through unchanged", async () => {
  mocks.registerMapping.mockResolvedValue({ replayed: false, action: "reassign" });
  const response = await POST(request({ kind: "register", operationId, previewId, reviewHash: "b".repeat(64), review: { decision: "reassign", mappingId, version: 2, confirm: "reassign-external-identifier" } }), scope());
  expect(response.status).toBe(200);
  expect(mocks.registerMapping).toHaveBeenCalledWith(expect.anything(), { operationId, previewId, reviewHash: "b".repeat(64), review: { decision: "reassign", mappingId, version: 2, confirm: "reassign-external-identifier" } });
});

it("guards history and download with the same authority", async () => {
  mocks.mappingHistory.mockResolvedValue({ mappingId, versions: [] });
  mocks.downloadMappings.mockResolvedValue({ filename: "external-identifier-mappings.json", contentType: "application/json; charset=utf-8", bytes: Buffer.from("{\"accessGranted\":false}") });
  expect((await HISTORY(new Request("https://hs.example/api/external-identifiers/history"), detail())).status).toBe(200);
  const download = await DOWNLOAD(new Request(`https://hs.example/api/external-identifiers/download?recordId=${recordId}`), scope());
  expect(download.status).toBe(200);
  expect(download.headers.get("content-disposition")).toContain("external-identifier-mappings.json");
  expect(mocks.mappingHistory).toHaveBeenCalledWith(expect.objectContaining({ actor: { id: "verified-user" } }), mappingId);
  expect(mocks.downloadMappings).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "workspace-a", tenantId }), { recordId, namespace: undefined });
});
