import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), repository: vi.fn(), listHealth: vi.fn(), preview: vi.fn(), confirm: vi.fn(), reconcile: vi.fn(), saveDraft: vi.fn(), discardDraft: vi.fn(), grantHealth: vi.fn(), history: vi.fn(), downloadEvidence: vi.fn() }));
vi.mock("./suite-tenant-authority", () => ({ authenticateRecordAuthority: mocks.authenticate }));
vi.mock("./repository", () => ({ repository: mocks.repository }));
vi.mock("./integration-health-store", () => ({ IntegrationHealthRepository: class { listHealth = mocks.listHealth; preview = mocks.preview; confirm = mocks.confirm; reconcile = mocks.reconcile; saveDraft = mocks.saveDraft; discardDraft = mocks.discardDraft; grantHealth = mocks.grantHealth; consumerHistory = mocks.history; downloadEvidence = mocks.downloadEvidence; } }));
import { GET, POST } from "../app/api/v1/workspaces/[id]/tenants/[tenantId]/integration-health/route";
import { GET as DOWNLOAD } from "../app/api/v1/workspaces/[id]/tenants/[tenantId]/integration-health/download/route";
import { GET as HISTORY } from "../app/api/v1/workspaces/[id]/tenants/[tenantId]/integration-health/[consumerId]/history/route";

const tenantId = "00000000-0000-4000-8000-000000000002";
const consumerId = "00000000-0000-4000-8000-000000000021";
const operationId = "00000000-0000-4000-8000-000000000004";
const previewId = "00000000-0000-4000-8000-000000000023";
const scope = () => ({ params: Promise.resolve({ id: "workspace-a", tenantId }) });
const detail = () => ({ params: Promise.resolve({ id: "workspace-a", tenantId, consumerId }) });
const request = (data: unknown, origin = "https://hs.example") => new Request("https://hs.example/api/integration-health", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(data) });

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("HS_ORIGIN", "https://hs.example");
  mocks.authenticate.mockResolvedValue({ actor: { id: "verified-user" }, authority: { verify: vi.fn() } });
  mocks.repository.mockResolvedValue({});
});

it("lists health for the authenticated tenant without trusting a caller actor", async () => {
  mocks.listHealth.mockResolvedValue({ consumers: [], drafts: [], credentialsStored: false, accessGranted: false, liveActivation: false });
  const response = await GET(new Request("https://hs.example/api/integration-health?collection=organisations&q=billing"), scope());
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(mocks.listHealth).toHaveBeenCalledWith(expect.objectContaining({ actor: { id: "verified-user" }, workspaceId: "workspace-a", tenantId }), { collection: "organisations", query: "billing", recordId: undefined });
});

it("rejects a cross-origin write and a credential payload before the repository", async () => {
  const preview = { kind: "preview", action: "register", collection: "organisations", clientId: "billing-app", label: "Billing" };
  expect((await POST(request(preview, "https://attacker.example"), scope())).status).toBe(403);
  expect((await POST(request({ ...preview, password: "hunter2" }), scope())).status).toBe(400);
  expect(mocks.preview).not.toHaveBeenCalled();
  mocks.preview.mockResolvedValue({ previewId, reviewHash: "a".repeat(64), confirm: "register-paused-consumer" });
  expect((await POST(request(preview), scope())).status).toBe(200);
  expect(mocks.preview).toHaveBeenCalledWith(expect.anything(), expect.not.objectContaining({ kind: "preview", password: expect.anything() }));
});

it("passes an idempotent retry confirmation through unchanged", async () => {
  mocks.confirm.mockResolvedValue({ replayed: false, action: "retry" });
  const response = await POST(request({ kind: "confirm", operationId, previewId, reviewHash: "b".repeat(64), confirm: "retry-delivery" }), scope());
  expect(response.status).toBe(200);
  expect(mocks.confirm).toHaveBeenCalledWith(expect.anything(), { operationId, previewId, reviewHash: "b".repeat(64), confirm: "retry-delivery" });
});

it("guards history and the redacted download with the same authority", async () => {
  mocks.history.mockResolvedValue({ consumerId, versions: [], repairs: [] });
  mocks.downloadEvidence.mockResolvedValue({ filename: "integration-health-evidence.json", contentType: "application/json; charset=utf-8", bytes: Buffer.from("{\"accessGranted\":false}") });
  expect((await HISTORY(new Request(`https://hs.example/api/integration-health/history?collection=organisations`), detail())).status).toBe(200);
  const download = await DOWNLOAD(new Request(`https://hs.example/api/integration-health/download?collection=organisations&consumerId=${consumerId}`), scope());
  expect(download.status).toBe(200);
  expect(download.headers.get("content-disposition")).toContain("integration-health-evidence.json");
  expect(mocks.history).toHaveBeenCalledWith(expect.objectContaining({ actor: { id: "verified-user" } }), consumerId, "organisations");
  expect(mocks.downloadEvidence).toHaveBeenCalledWith(expect.objectContaining({ tenantId }), { collection: "organisations", consumerId });
});
