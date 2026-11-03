import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  catalogue: vi.fn(), read: vi.fn(), search: vi.fn(), history: vi.fn(), source: vi.fn(), project: vi.fn(),
  configure: vi.fn(), stashPolicy: vi.fn(), discardPolicy: vi.fn(), field: vi.fn(), actions: vi.fn(),
  grant: vi.fn(), revoke: vi.fn(), stash: vi.fn(), discard: vi.fn(), preview: vi.fn(), apply: vi.fn(),
  report: vi.fn(), download: vi.fn(), repository: vi.fn(async () => ({})),
}));
vi.mock("./repository", () => ({ repository: mocks.repository }));
vi.mock("./knowledge-verification", () => ({
  knowledgeVerificationCatalogue: mocks.catalogue,
  readKnowledgeBadge: mocks.read,
  searchKnowledgeVerification: mocks.search,
  knowledgeVerificationHistory: mocks.history,
  knowledgeVerificationSourcePreview: mocks.source,
  projectKnowledgeVerification: mocks.project,
  saveKnowledgeVerificationPolicy: mocks.configure,
  stashKnowledgeVerificationPolicy: mocks.stashPolicy,
  discardKnowledgeVerificationPolicy: mocks.discardPolicy,
  saveKnowledgeVerificationFieldPolicy: mocks.field,
  setKnowledgeVerificationActions: mocks.actions,
  grantKnowledgeSteward: mocks.grant,
  revokeKnowledgeSteward: mocks.revoke,
  stashKnowledgeVerification: mocks.stash,
  discardKnowledgeVerificationDraft: mocks.discard,
  previewKnowledgeVerification: mocks.preview,
  applyKnowledgeVerification: mocks.apply,
  reportKnowledgeConcern: mocks.report,
  downloadKnowledgeVerification: mocks.download,
}));
import { GET, POST } from "../app/api/v1/workspaces/[id]/knowledge-verification/route";

const origin = "http://localhost:3000";
const workspaceId = "ws-aplyd";
const badgeId = "00000000-0000-4000-8000-0000000000a1";
const operationId = "00000000-0000-4000-8000-0000000000a2";
const previewId = "00000000-0000-4000-8000-0000000000a3";
const params = { params: Promise.resolve({ id: workspaceId }) };
const request = (body: unknown, extra: Record<string, string> = {}) => new Request(origin + "/api/test", { method: "POST", headers: { origin, "content-type": "application/json", ...extra }, body: JSON.stringify(body) });

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("HS_LOCAL_PREVIEW", "1");
  vi.stubEnv("HS_ORIGIN", origin);
  vi.clearAllMocks();
  mocks.catalogue.mockResolvedValue({ manage: false, badges: [] });
  mocks.search.mockResolvedValue({ results: [] });
  mocks.history.mockResolvedValue({ events: [] });
  mocks.source.mockResolvedValue({ excerpt: "", badge: null });
  mocks.project.mockResolvedValue({ records: [], pages: [] });
  mocks.read.mockResolvedValue({ id: badgeId });
  mocks.preview.mockResolvedValue({ previewId });
  mocks.apply.mockResolvedValue({ id: badgeId, status: "current" });
  mocks.download.mockResolvedValue({ body: "# Knowledge verification", version: 1 });
  mocks.report.mockResolvedValue({ reported: true });
});
afterEach(() => vi.unstubAllEnvs());

it("rejects a foreign origin and a truth-score field before verification", async () => {
  const listed = await GET(new Request(`${origin}/api/v1/workspaces/${workspaceId}/knowledge-verification`), params);
  expect(listed.status).toBe(200);
  expect(listed.headers.get("cache-control")).toBe("no-store");
  const body = { action: "preview", operationId, kind: "verify", expectedVersion: 0, targetKind: "record", targetId: badgeId, ownerId: "owner", basis: "source-reviewed", basisNote: "Read the source", expiryDays: 90, score: 0.99 };
  expect((await POST(request(body, { origin: "https://foreign.invalid" }), params)).status).toBe(403);
  expect(mocks.preview).not.toHaveBeenCalled();
  expect((await POST(request(body), params)).status).toBe(422);
  expect(mocks.preview).not.toHaveBeenCalled();
  expect((await POST(request({ action: "preview", operationId, kind: "verify", expectedVersion: 0, targetKind: "record", targetId: badgeId, ownerId: "owner", basis: "source-reviewed", basisNote: "Read the source", expiryDays: 90 }), params)).status).toBe(200);
  expect(mocks.preview).toHaveBeenCalled();
});

it("uses the same not-found response for a missing badge and a denied read", async () => {
  expect((await GET(new Request(`${origin}/api/v1/workspaces/${workspaceId}/knowledge-verification?view=search`), params)).status).toBe(422);
  expect(mocks.search).not.toHaveBeenCalled();
  expect((await GET(new Request(`${origin}/api/v1/workspaces/${workspaceId}/knowledge-verification?view=badge`), params)).status).toBe(404);
  const { DocumentError } = await import("./document");
  mocks.read.mockRejectedValueOnce(new DocumentError("Verification is restricted or unavailable.", "not_found", 404));
  const denied = await GET(new Request(`${origin}/api/v1/workspaces/${workspaceId}/knowledge-verification?view=badge&badgeId=${badgeId}`), params);
  expect(denied.status).toBe(404);
  expect(await denied.json()).toEqual({ error: "Verification is restricted or unavailable.", code: "not_found", retryable: false });
  expect((await GET(new Request(`${origin}/api/v1/workspaces/nope/knowledge-verification`), { params: Promise.resolve({ id: "" }) })).status).toBe(404);
  expect((await GET(new Request(`${origin}/api/v1/workspaces/${workspaceId}/knowledge-verification?view=source&badgeId=${badgeId}`), params)).status).toBe(200);
  expect(mocks.source).toHaveBeenCalled();
  expect((await GET(new Request(`${origin}/api/v1/workspaces/${workspaceId}/knowledge-verification?view=interfaces&recordId=${badgeId}`), params)).status).toBe(200);
  expect(mocks.project).toHaveBeenCalledWith({}, expect.any(Object), workspaceId, { recordIds: [badgeId], pageIds: [] });
  expect((await GET(new Request(`${origin}/api/v1/workspaces/${workspaceId}/knowledge-verification?view=history&badgeId=${badgeId}`), params)).status).toBe(200);
  expect((await POST(request({ action: "report", operationId, badgeId, reason: "The source disagrees." }), params)).status).toBe(200);
  expect(mocks.report).toHaveBeenCalled();
  expect((await POST(request({ action: "download", operationId, badgeId, expectedVersion: 1 }), params)).status).toBe(200);
  expect(mocks.download).toHaveBeenCalled();
  expect((await POST(request({ action: "apply", operationId, previewId, expectedVersion: 0 }), params)).status).toBe(200);
  expect(mocks.apply).toHaveBeenCalled();
});
