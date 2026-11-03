import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  catalogue: vi.fn(), read: vi.fn(), search: vi.fn(), history: vi.fn(), source: vi.fn(),
  configure: vi.fn(), stashPolicy: vi.fn(), discardPolicy: vi.fn(), field: vi.fn(), actions: vi.fn(),
  grant: vi.fn(), revoke: vi.fn(), stash: vi.fn(), discard: vi.fn(), preview: vi.fn(), apply: vi.fn(),
  download: vi.fn(), repository: vi.fn(async () => ({})),
}));
vi.mock("./repository", () => ({ repository: mocks.repository }));
vi.mock("./quick-capture", () => ({
  quickCaptureCatalogue: mocks.catalogue,
  readQuickCapture: mocks.read,
  searchQuickCapture: mocks.search,
  quickCaptureHistory: mocks.history,
  quickCaptureSourcePreview: mocks.source,
  saveQuickCapturePolicy: mocks.configure,
  stashQuickCapturePolicy: mocks.stashPolicy,
  discardQuickCapturePolicy: mocks.discardPolicy,
  saveQuickCaptureFieldPolicy: mocks.field,
  setQuickCaptureActions: mocks.actions,
  grantQuickCaptureOperator: mocks.grant,
  revokeQuickCaptureOperator: mocks.revoke,
  stashQuickCapture: mocks.stash,
  discardQuickCaptureDraft: mocks.discard,
  previewQuickCapture: mocks.preview,
  applyQuickCapture: mocks.apply,
  downloadQuickCapture: mocks.download,
}));
import { GET, POST } from "../app/api/v1/workspaces/[id]/quick-capture/route";

const origin = "http://localhost:3000";
const workspaceId = "ws-aplyd";
const captureId = "00000000-0000-4000-8000-0000000000b1";
const operationId = "00000000-0000-4000-8000-0000000000b2";
const previewId = "00000000-0000-4000-8000-0000000000b3";
const params = { params: Promise.resolve({ id: workspaceId }) };
const request = (body: unknown, extra: Record<string, string> = {}) => new Request(origin + "/api/test", { method: "POST", headers: { origin, "content-type": "application/json", ...extra }, body: JSON.stringify(body) });

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("HS_LOCAL_PREVIEW", "1");
  vi.stubEnv("HS_ORIGIN", origin);
  vi.clearAllMocks();
  mocks.catalogue.mockResolvedValue({ manage: false, captures: [] });
  mocks.search.mockResolvedValue({ results: [] });
  mocks.history.mockResolvedValue({ events: [] });
  mocks.source.mockResolvedValue({ text: "", sourceStatement: "The source address was not opened." });
  mocks.read.mockResolvedValue({ id: captureId });
  mocks.preview.mockResolvedValue({ previewId, externalShare: false, audience: "private" });
  mocks.apply.mockResolvedValue({ id: captureId, visibility: "private" });
  mocks.download.mockResolvedValue({ body: "# Capture\nAudience: private.", version: 1 });
});
afterEach(() => vi.unstubAllEnvs());

it("rejects cookies, hidden transport fields, and a foreign origin before capture", async () => {
  const listed = await GET(new Request(`${origin}/api/v1/workspaces/${workspaceId}/quick-capture`), params);
  expect(listed.status).toBe(200);
  expect(listed.headers.get("cache-control")).toBe("no-store");
  const body = { action: "preview", operationId, expectedVersion: 0, kind: "note", title: "Clinic", body: "Visible", cookies: "session=abc", hidden: "secret-token" };
  expect((await POST(request(body, { origin: "https://foreign.invalid" }), params)).status).toBe(403);
  expect(mocks.preview).not.toHaveBeenCalled();
  expect((await POST(request(body), params)).status).toBe(422);
  expect(mocks.preview).not.toHaveBeenCalled();
  expect((await POST(request({ action: "preview", operationId, expectedVersion: 0, kind: "note", title: "Clinic", body: "Visible" }), params)).status).toBe(200);
  expect(mocks.preview).toHaveBeenCalled();
});

it("uses the same not-found response for a missing capture and a denied read", async () => {
  expect((await GET(new Request(`${origin}/api/v1/workspaces/${workspaceId}/quick-capture?view=search`), params)).status).toBe(422);
  expect(mocks.search).not.toHaveBeenCalled();
  expect((await GET(new Request(`${origin}/api/v1/workspaces/${workspaceId}/quick-capture?view=capture`), params)).status).toBe(404);
  const { DocumentError } = await import("./document");
  mocks.read.mockRejectedValueOnce(new DocumentError("Quick capture is restricted or unavailable.", "not_found", 404));
  const denied = await GET(new Request(`${origin}/api/v1/workspaces/${workspaceId}/quick-capture?view=capture&captureId=${captureId}`), params);
  expect(denied.status).toBe(404);
  const payload = await denied.json();
  expect(payload).toEqual({ error: "Quick capture is restricted or unavailable.", code: "not_found", retryable: false });
  expect(JSON.stringify(payload)).not.toContain("secret");
});
