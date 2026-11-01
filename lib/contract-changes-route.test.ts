import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), repository: vi.fn(), list: vi.fn(), preview: vi.fn(), confirm: vi.fn(), saveDraft: vi.fn(), discardDraft: vi.fn(), restoreDraft: vi.fn(), history: vi.fn(), download: vi.fn() }));
vi.mock("./suite-tenant-authority", () => ({ authenticateRecordAuthority: mocks.authenticate }));
vi.mock("./repository", () => ({ repository: mocks.repository }));
vi.mock("./contract-changes-store", () => ({ ContractChangeRepository: class { listChanges = mocks.list; preview = mocks.preview; confirm = mocks.confirm; saveDraft = mocks.saveDraft; discardDraft = mocks.discardDraft; restoreDraft = mocks.restoreDraft; changeHistory = mocks.history; download = mocks.download; } }));
import { GET, POST } from "../app/api/v1/workspaces/[id]/tenants/[tenantId]/contract-changes/route";
import { GET as DOWNLOAD } from "../app/api/v1/workspaces/[id]/tenants/[tenantId]/contract-changes/download/route";
import { GET as HISTORY } from "../app/api/v1/workspaces/[id]/tenants/[tenantId]/contract-changes/history/route";

const tenantId = "00000000-0000-4000-8000-000000000002";
const changeId = "00000000-0000-4000-8000-000000000011";
const previewId = "00000000-0000-4000-8000-000000000023";
const scope = () => ({ params: Promise.resolve({ id: "workspace-a", tenantId }) });
const request = (data: unknown, origin = "https://hs.example") => new Request("https://hs.example/api/contract-changes", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(data) });

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("HS_ORIGIN", "https://hs.example");
  mocks.authenticate.mockResolvedValue({ actor: { id: "verified-user" }, authority: { verify: vi.fn() } });
  mocks.repository.mockResolvedValue({});
});

it("lists contract changes for the authenticated tenant", async () => {
  mocks.list.mockResolvedValue({ changes: [], endDates: [], drafts: [], accessGranted: false, legalCommitment: false });
  const response = await GET(new Request(`https://hs.example/api/contract-changes?collection=contracts&changeId=${changeId}`), scope());
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(mocks.list).toHaveBeenCalledWith(expect.objectContaining({ actor: { id: "verified-user" }, workspaceId: "workspace-a", tenantId }), expect.objectContaining({ changeId }));
});

it("rejects a cross-origin write and an unexpected field before the repository", async () => {
  const preview = { kind: "preview", action: "configure", collection: "contracts", reviewRequired: true };
  expect((await POST(request(preview, "https://attacker.example"), scope())).status).toBe(403);
  expect((await POST(request({ ...preview, password: "hunter2" }), scope())).status).toBe(400);
  expect(mocks.preview).not.toHaveBeenCalled();
  mocks.preview.mockResolvedValue({ previewId, reviewHash: "a".repeat(64), confirm: "configure-contract-change" });
  expect((await POST(request(preview), scope())).status).toBe(200);
  mocks.history.mockResolvedValue({ events: [] });
  mocks.download.mockResolvedValue({ filename: "contract-change.json", contentType: "application/json; charset=utf-8", bytes: Buffer.from("{\"legalCommitment\":false}") });
  expect((await HISTORY(new Request(`https://hs.example/api/contract-changes/history?collection=contracts&changeId=${changeId}`), scope())).status).toBe(200);
  const download = await DOWNLOAD(new Request(`https://hs.example/api/contract-changes/download?collection=contracts&changeId=${changeId}`), scope());
  expect(download.status).toBe(200);
  expect(download.headers.get("content-disposition")).toContain("contract-change.json");
  expect(await download.text()).toContain("legalCommitment");
});
