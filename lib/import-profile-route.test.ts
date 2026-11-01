import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), repository: vi.fn(), listProfiles: vi.fn(), saveProfile: vi.fn(), saveDraft: vi.fn(), discardDraft: vi.fn(), deleteProfile: vi.fn(), applyProfile: vi.fn(), profileHistory: vi.fn(), downloadProfile: vi.fn() }));
vi.mock("./suite-tenant-authority", () => ({ authenticateRecordAuthority: mocks.authenticate }));
vi.mock("./repository", () => ({ repository: mocks.repository }));
vi.mock("./shared-record-import-profiles", () => ({ SharedRecordImportProfileRepository: class { listProfiles = mocks.listProfiles; saveProfile = mocks.saveProfile; saveDraft = mocks.saveDraft; discardDraft = mocks.discardDraft; deleteProfile = mocks.deleteProfile; applyProfile = mocks.applyProfile; profileHistory = mocks.profileHistory; downloadProfile = mocks.downloadProfile; } }));
import { GET, POST } from "../app/api/v1/workspaces/[id]/tenants/[tenantId]/import-profiles/route";
import { GET as HISTORY } from "../app/api/v1/workspaces/[id]/tenants/[tenantId]/import-profiles/[profileId]/history/route";
import { GET as DOWNLOAD } from "../app/api/v1/workspaces/[id]/tenants/[tenantId]/import-profiles/[profileId]/download/route";

const tenantId = "00000000-0000-4000-8000-000000000002";
const profileId = "00000000-0000-4000-8000-000000000011";
const operationId = "00000000-0000-4000-8000-000000000004";
const jobId = "00000000-0000-4000-8000-0000000000c1";
const scope = () => ({ params: Promise.resolve({ id: "workspace-a", tenantId }) });
const detail = () => ({ params: Promise.resolve({ id: "workspace-a", tenantId, profileId }) });
const mapping = { mode: "create" as const, nameColumn: 0, fields: [{ column: 1, fieldKey: "core:notes" }] };
const request = (data: unknown, origin = "https://hs.example") => new Request("https://hs.example/api/import-profiles", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(data) });

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("HS_ORIGIN", "https://hs.example");
  mocks.authenticate.mockResolvedValue({ actor: { id: "verified-user" }, authority: { verify: vi.fn() } });
  mocks.repository.mockResolvedValue({});
});

it("lists and searches profiles for the authenticated tenant without trusting a caller actor", async () => {
  mocks.listProfiles.mockResolvedValue({ profiles: [], drafts: [] });
  const response = await GET(new Request(`https://hs.example/api/import-profiles?collection=organisations&q=repeat`), scope());
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(mocks.listProfiles).toHaveBeenCalledWith(expect.objectContaining({ actor: { id: "verified-user" }, workspaceId: "workspace-a", tenantId }), "organisations", "repeat");
});

it("rejects a forged actor, a cross-origin write, and a sample payload before the repository", async () => {
  const save = { kind: "save", id: profileId, operationId, jobId, collection: "organisations", scope: "personal", name: "Repeat", expectedVersion: 0, mapping };
  expect((await POST(request(save, "https://attacker.example"), scope())).status).toBe(403);
  expect((await POST(request({ ...save, actorId: "forged" }), scope())).status).toBe(400);
  expect((await POST(request({ ...save, samples: ["secret-sample-value"] }), scope())).status).toBe(400);
  expect(mocks.saveProfile).not.toHaveBeenCalled();
  mocks.saveProfile.mockResolvedValue({ id: profileId, appliedVersion: 1, replayed: false });
  expect((await POST(request(save), scope())).status).toBe(200);
  expect(mocks.saveProfile).toHaveBeenCalledWith(expect.anything(), expect.not.objectContaining({ kind: "save", samples: expect.anything() }));
});

it("applies a profile as a preview and does not ask the repository to commit an import", async () => {
  mocks.applyProfile.mockResolvedValue({ repairRequired: true, mapping: null, samplesStored: false });
  const response = await POST(request({ kind: "apply", id: profileId, operationId, jobId }), scope());
  expect(response.status).toBe(200);
  expect(mocks.applyProfile).toHaveBeenCalledWith(expect.anything(), { id: profileId, operationId, jobId });
  expect(mocks.saveProfile).not.toHaveBeenCalled();
});

it("guards history and download with the same authority", async () => {
  mocks.profileHistory.mockResolvedValue({ profileId, versions: [] });
  mocks.downloadProfile.mockResolvedValue({ filename: "import-mapping-profile.json", contentType: "application/json; charset=utf-8", bytes: Buffer.from("{\"samplesStored\":false}") });
  expect((await HISTORY(new Request("https://hs.example/api/import-profiles/history"), detail())).status).toBe(200);
  const download = await DOWNLOAD(new Request("https://hs.example/api/import-profiles/download"), detail());
  expect(download.status).toBe(200);
  expect(download.headers.get("content-disposition")).toContain("import-mapping-profile.json");
  expect(mocks.profileHistory).toHaveBeenCalledWith(expect.objectContaining({ actor: { id: "verified-user" } }), profileId);
  expect(mocks.downloadProfile).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "workspace-a", tenantId }), profileId);
});
