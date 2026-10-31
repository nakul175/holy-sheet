import { beforeEach, expect, it, vi } from "vitest";
import { DocumentError } from "./document";

const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), repository: vi.fn(), compare: vi.fn() }));
vi.mock("./suite-tenant-authority", () => ({ authenticateRecordAuthority: mocks.authenticate }));
vi.mock("./repository", () => ({ repository: mocks.repository }));
vi.mock("./shared-record-compare", () => ({ SharedRecordCompareRepository: class { compare = mocks.compare; } }));
import { POST } from "../app/api/v1/workspaces/[id]/tenants/[tenantId]/record-compare/route";

const tenantId = "00000000-0000-4000-8000-000000000002";
const left = "00000000-0000-4000-8000-0000000000a1";
const right = "00000000-0000-4000-8000-0000000000a2";
const context = () => ({ params: Promise.resolve({ id: "workspace-a", tenantId }) });
const request = (body: unknown, origin = "https://hs.example", query = "") => new Request(`https://hs.example/api/record-compare${query}`, {
  method: "POST",
  headers: { Origin: origin, "Content-Type": "application/json" },
  body: JSON.stringify(body),
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("HS_ORIGIN", "https://hs.example");
  mocks.authenticate.mockResolvedValue({ actor: { id: "verified-user" }, authority: { verify: vi.fn() } });
  mocks.repository.mockResolvedValue({});
});

it("fails closed when records are disabled, before storage access", async () => {
  mocks.authenticate.mockRejectedValueOnce(new DocumentError("Structured records are not enabled in this environment.", "record_feature_disabled", 503));
  const response = await POST(request({ recordIds: [left, right] }), context());
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ code: "record_feature_disabled", retryable: true });
  expect(mocks.repository).not.toHaveBeenCalled();
  expect(mocks.compare).not.toHaveBeenCalled();
});

it("rejects unexpected query fields before authentication and does not echo them", async () => {
  const response = await POST(request({ recordIds: [left, right] }, "https://hs.example", "?secret=hidden-salary-value"), context());
  expect(response.status).toBe(400);
  expect(JSON.stringify(await response.json())).not.toContain("hidden-salary-value");
  expect(mocks.authenticate).not.toHaveBeenCalled();
  expect(mocks.compare).not.toHaveBeenCalled();
});

it("denies a foreign origin before authority or storage access", async () => {
  const response = await POST(request({ recordIds: [left, right] }, "https://attacker.example"), context());
  expect(response.status).toBe(403);
  expect(mocks.authenticate).not.toHaveBeenCalled();
  expect(mocks.repository).not.toHaveBeenCalled();
});

it("compares the verified actor's selected records and does not store the response", async () => {
  const comparison = { records: [], fields: [], mixedCollections: false };
  mocks.compare.mockResolvedValue(comparison);
  const response = await POST(request({ recordIds: [left, right] }), context());
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("vary")).toContain("Authorization");
  expect(mocks.compare).toHaveBeenCalledWith({ actor: { id: "verified-user" }, workspaceId: "workspace-a", tenantId }, { recordIds: [left, right] });
  expect(await response.json()).toEqual(comparison);
});

it("rejects forged fields without echoing them or opening storage", async () => {
  const response = await POST(request({ recordIds: [left, right], secret: "hidden-salary-value" }), context());
  expect(response.status).toBe(400);
  expect(JSON.stringify(await response.json())).not.toContain("hidden-salary-value");
  expect(mocks.repository).not.toHaveBeenCalled();
  expect(mocks.compare).not.toHaveBeenCalled();
});

it("hides provider errors", async () => {
  mocks.compare.mockRejectedValue(new Error("private provider detail"));
  const logger = vi.spyOn(console, "error").mockImplementation(() => {});
  const response = await POST(request({ recordIds: [left, right] }), context());
  expect(response.status).toBe(503);
  expect(JSON.stringify(await response.json())).not.toContain("private provider detail");
  logger.mockRestore();
});
