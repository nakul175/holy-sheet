import { beforeEach, expect, it, vi } from "vitest";
import { DocumentError } from "./document";
const mocks = vi.hoisted(() => ({ authenticate: vi.fn(), repository: vi.fn(), graph: vi.fn() }));
vi.mock("./suite-tenant-authority", () => ({ authenticateRecordAuthority: mocks.authenticate }));
vi.mock("./repository", () => ({ repository: mocks.repository }));
vi.mock("./shared-record-graph", () => ({ SharedRecordGraphRepository: class { graph = mocks.graph; } }));
import { GET } from "../app/api/v1/workspaces/[id]/tenants/[tenantId]/records/[recordId]/graph/route";

const tenantId = "00000000-0000-4000-8000-000000000002", recordId = "00000000-0000-4000-8000-0000000000a1";
const context = () => ({ params: Promise.resolve({ id: "workspace-a", tenantId, recordId }) });
const empty = { focalId: recordId, nodes: [{ id: recordId, kind: "record", label: "Acme", state: "active", collection: "organisations" }], edges: [], limited: false };
beforeEach(() => {
  vi.resetAllMocks();
  mocks.authenticate.mockResolvedValue({ actor: { id: "verified-user" }, authority: { verify: vi.fn() } });
  mocks.repository.mockResolvedValue({});
});

it("fails closed when records are disabled, before storage access", async () => {
  mocks.authenticate.mockRejectedValueOnce(new DocumentError("Structured records are not enabled in this environment.", "record_feature_disabled", 503));
  const response = await GET(new Request("https://hs.example/api/graph"), context());
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ code: "record_feature_disabled", retryable: true });
  expect(mocks.repository).not.toHaveBeenCalled();
  expect(mocks.graph).not.toHaveBeenCalled();
});

it("binds the graph to the verified actor and URL record", async () => {
  mocks.graph.mockResolvedValue(empty);
  const response = await GET(new Request("https://hs.example/api/graph"), context());
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("vary")).toContain("Authorization");
  expect(mocks.graph).toHaveBeenCalledWith({ actor: { id: "verified-user" }, workspaceId: "workspace-a", tenantId }, recordId);
  expect(await response.json()).toEqual(empty);
});

it("rejects unexpected query fields before authentication and does not echo them", async () => {
  const response = await GET(new Request("https://hs.example/api/graph?secret=hidden-salary-value"), context());
  expect(response.status).toBe(400);
  expect(JSON.stringify(await response.json())).not.toContain("hidden-salary-value");
  expect(mocks.authenticate).not.toHaveBeenCalled();
  expect(mocks.graph).not.toHaveBeenCalled();
});

it("hides provider errors", async () => {
  mocks.graph.mockRejectedValue(new Error("private provider detail"));
  const logger = vi.spyOn(console, "error").mockImplementation(() => {});
  const response = await GET(new Request("https://hs.example/api/graph"), context());
  expect(response.status).toBe(503);
  expect(JSON.stringify(await response.json())).not.toContain("private provider detail");
  logger.mockRestore();
});
