import { afterEach, beforeEach, expect, it } from "vitest";
import { vi } from "vitest";

const mocks = vi.hoisted(() => ({
  catalogue: vi.fn(), read: vi.fn(), search: vi.fn(), history: vi.fn(), create: vi.fn(), stash: vi.fn(), discard: vi.fn(),
  preview: vi.fn(), apply: vi.fn(), ingest: vi.fn(), advance: vi.fn(), download: vi.fn(), grant: vi.fn(), revoke: vi.fn(),
  repository: vi.fn(async () => ({})),
}));
vi.mock("./repository", () => ({ repository: mocks.repository }));
vi.mock("./workflow-automation", () => ({
  workflowCatalogue: mocks.catalogue,
  readWorkflow: mocks.read,
  searchWorkflows: mocks.search,
  workflowHistory: mocks.history,
  createWorkflow: mocks.create,
  stashWorkflow: mocks.stash,
  discardWorkflowDraft: mocks.discard,
  previewWorkflow: mocks.preview,
  applyWorkflowPreview: mocks.apply,
  ingestWorkflow: mocks.ingest,
  advanceWorkflowRun: mocks.advance,
  downloadWorkflow: mocks.download,
  grantWorkflowManager: mocks.grant,
  revokeWorkflowManager: mocks.revoke,
}));
import { GET, POST } from "../app/api/v1/workspaces/[id]/workflows/route";

const origin = "http://localhost:3000";
const workspaceId = "ws-aplyd";
const workflowId = "00000000-0000-4000-8000-0000000000d1";
const operationId = "00000000-0000-4000-8000-0000000000d2";
const params = { params: Promise.resolve({ id: workspaceId }) };
const definition = { trigger: { event: "record.created" }, conditions: { all: [] }, actions: [{ type: "set-field", field: "core:notes", value: "Hello" }], identity: { kind: "delegated", subjectId: "editor" } };
const request = (body: unknown, extra: Record<string, string> = {}) => new Request(origin + "/api/test", { method: "POST", headers: { origin, "content-type": "application/json", ...extra }, body: JSON.stringify(body) });

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("HS_LOCAL_PREVIEW", "1");
  vi.stubEnv("HS_ORIGIN", origin);
  vi.clearAllMocks();
  mocks.catalogue.mockResolvedValue({ manage: false, workflows: [] });
  mocks.search.mockResolvedValue({ results: [] });
  mocks.history.mockResolvedValue({ events: [], runs: [] });
  mocks.read.mockResolvedValue({ id: workflowId });
  mocks.create.mockResolvedValue({ id: workflowId, status: "draft", version: 1 });
  mocks.preview.mockResolvedValue({ previewId: operationId });
  mocks.apply.mockResolvedValue({ status: "paused" });
});
afterEach(() => vi.unstubAllEnvs());

it("rejects a foreign origin and an extra field before creating a workflow", async () => {
  const listed = await GET(new Request(`${origin}/api/v1/workspaces/${workspaceId}/workflows`), params);
  expect(listed.status).toBe(200);
  expect(listed.headers.get("cache-control")).toBe("no-store");
  expect(mocks.catalogue).toHaveBeenCalledWith({}, expect.any(Object), workspaceId);
  const body = { action: "create", operationId, collection: "organisations", name: "Notes", definition, agent: true };
  expect((await POST(request(body, { origin: "https://foreign.invalid" }), params)).status).toBe(403);
  expect(mocks.create).not.toHaveBeenCalled();
  expect((await POST(request(body), params)).status).toBe(422);
  expect(mocks.create).not.toHaveBeenCalled();
  expect((await POST(request({ action: "create", operationId, collection: "organisations", name: "Notes", definition }), params)).status).toBe(200);
  expect(mocks.create).toHaveBeenCalledWith({}, expect.any(Object), workspaceId, expect.objectContaining({ name: "Notes", collection: "organisations" }));
});

it("uses the same not-found response for a missing workflow and a denied read", async () => {
  expect((await GET(new Request(`${origin}/api/v1/workspaces/${workspaceId}/workflows?view=search`), params)).status).toBe(422);
  expect(mocks.search).not.toHaveBeenCalled();
  expect((await GET(new Request(`${origin}/api/v1/workspaces/${workspaceId}/workflows?view=workflow`), params)).status).toBe(404);
  const { DocumentError } = await import("./document");
  mocks.read.mockRejectedValueOnce(new DocumentError("Workflow automation is restricted or unavailable.", "not_found", 404));
  const denied = await GET(new Request(`${origin}/api/v1/workspaces/${workspaceId}/workflows?view=workflow&workflowId=${workflowId}`), params);
  expect(denied.status).toBe(404);
  expect(await denied.json()).toEqual({ error: "Workflow automation is restricted or unavailable.", code: "not_found", retryable: false });
  expect((await GET(new Request(`${origin}/api/v1/workspaces/nope/workflows`), { params: Promise.resolve({ id: "" }) })).status).toBe(404);
  expect((await POST(request({ action: "ingest", operationId, workflowId, recordId: workflowId, event: "record.created", sourceKey: "one", now: "2099-01-01" }), params)).status).toBe(422);
  expect(mocks.ingest).not.toHaveBeenCalled();
  expect((await POST(request({ action: "preview", operationId, workflowId, kind: "activate", expectedVersion: 1 }), params)).status).toBe(200);
  expect(mocks.preview).toHaveBeenCalled();
});
