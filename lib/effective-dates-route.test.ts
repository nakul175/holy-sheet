import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), repository: vi.fn(), list: vi.fn(), preview: vi.fn(), confirm: vi.fn(), saveDraft: vi.fn(), discardDraft: vi.fn(), history: vi.fn(), download: vi.fn() }));
vi.mock("./suite-tenant-authority", () => ({ authenticateRecordAuthority: mocks.authenticate }));
vi.mock("./repository", () => ({ repository: mocks.repository }));
vi.mock("./effective-dates-store", () => ({ EffectiveDateRepository: class { listEffective = mocks.list; preview = mocks.preview; confirm = mocks.confirm; saveDraft = mocks.saveDraft; discardDraft = mocks.discardDraft; intervalHistory = mocks.history; download = mocks.download; } }));
import { GET, POST } from "../app/api/v1/workspaces/[id]/tenants/[tenantId]/effective-dates/route";
import { GET as DOWNLOAD } from "../app/api/v1/workspaces/[id]/tenants/[tenantId]/effective-dates/download/route";
import { GET as HISTORY } from "../app/api/v1/workspaces/[id]/tenants/[tenantId]/effective-dates/history/route";

const tenantId = "00000000-0000-4000-8000-000000000002";
const recordId = "00000000-0000-4000-8000-000000000011";
const previewId = "00000000-0000-4000-8000-000000000023";
const scope = () => ({ params: Promise.resolve({ id: "workspace-a", tenantId }) });
const request = (data: unknown, origin = "https://hs.example") => new Request("https://hs.example/api/effective-dates", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(data) });

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("HS_ORIGIN", "https://hs.example");
  mocks.authenticate.mockResolvedValue({ actor: { id: "verified-user" }, authority: { verify: vi.fn() } });
  mocks.repository.mockResolvedValue({});
});

it("lists effective values for the authenticated tenant", async () => {
  mocks.list.mockResolvedValue({ policies: [], intervals: [], drafts: [], asOf: null, accessGranted: false });
  const response = await GET(new Request(`https://hs.example/api/effective-dates?collection=organisations&recordId=${recordId}&asOf=2026-11-01T17:30:00%2B05:30`), scope());
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(mocks.list).toHaveBeenCalledWith(expect.objectContaining({ actor: { id: "verified-user" }, workspaceId: "workspace-a", tenantId }), expect.objectContaining({ collection: "organisations", recordId, asOf: "2026-11-01T17:30:00+05:30" }));
});

it("rejects a cross-origin write and an unexpected field before the repository", async () => {
  const preview = { kind: "preview", action: "configure", collection: "organisations", fieldKey: "core:registration", enabled: true };
  expect((await POST(request(preview, "https://attacker.example"), scope())).status).toBe(403);
  expect((await POST(request({ ...preview, password: "hunter2" }), scope())).status).toBe(400);
  expect(mocks.preview).not.toHaveBeenCalled();
  mocks.preview.mockResolvedValue({ previewId, reviewHash: "a".repeat(64), confirm: "configure-effective-field" });
  expect((await POST(request(preview), scope())).status).toBe(200);
  mocks.history.mockResolvedValue({ intervals: [] });
  mocks.download.mockResolvedValue({ filename: "effective-dates-as-of.json", contentType: "application/json; charset=utf-8", bytes: Buffer.from("{\"asOf\":\"2026-11-01T12:00:00.000Z\"}") });
  expect((await HISTORY(new Request(`https://hs.example/api/effective-dates/history?collection=organisations&recordId=${recordId}&fieldKey=core:registration`), scope())).status).toBe(200);
  const download = await DOWNLOAD(new Request(`https://hs.example/api/effective-dates/download?collection=organisations&recordId=${recordId}&fieldKey=core:registration&asOf=2026-11-01T17:30:00%2B05:30`), scope());
  expect(download.status).toBe(200);
  expect(download.headers.get("content-disposition")).toContain("effective-dates-as-of.json");
});
