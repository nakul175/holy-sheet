import { afterEach, beforeEach, expect, it } from "vitest";
import { vi } from "vitest";

const mocks = vi.hoisted(() => ({
  catalogue: vi.fn(), read: vi.fn(), search: vi.fn(), history: vi.fn(), receipt: vi.fn(), create: vi.fn(), stash: vi.fn(), discard: vi.fn(),
  preview: vi.fn(), apply: vi.fn(), retry: vi.fn(), download: vi.fn(), grant: vi.fn(), revoke: vi.fn(),
  repository: vi.fn(async () => ({})),
}));
vi.mock("./repository", () => ({ repository: mocks.repository }));
vi.mock("./action-button", () => ({
  actionButtonCatalogue: mocks.catalogue,
  readActionButton: mocks.read,
  searchActionButtons: mocks.search,
  actionButtonHistory: mocks.history,
  readActionReceipt: mocks.receipt,
  createActionButton: mocks.create,
  stashActionButton: mocks.stash,
  discardActionButtonDraft: mocks.discard,
  previewActionButton: mocks.preview,
  applyActionButtonPreview: mocks.apply,
  retryActionButtonLink: mocks.retry,
  downloadActionButton: mocks.download,
  grantActionButtonManager: mocks.grant,
  revokeActionButtonManager: mocks.revoke,
}));
import { GET, POST } from "../app/api/v1/workspaces/[id]/action-buttons/route";

const origin = "http://localhost:3000";
const workspaceId = "ws-aplyd";
const buttonId = "00000000-0000-4000-8000-0000000000e1";
const operationId = "00000000-0000-4000-8000-0000000000e2";
const params = { params: Promise.resolve({ id: workspaceId }) };
const definition = {
  context: { collection: "organisations", placement: "record" },
  inputs: [{ id: "note", field: "core:notes", required: true, default: "Hello" }],
  target: { actionId: "hs.record.append-note", field: "core:notes", inputId: "note" },
  link: null,
};
const request = (body: unknown, extra: Record<string, string> = {}) => new Request(origin + "/api/test", { method: "POST", headers: { origin, "content-type": "application/json", ...extra }, body: JSON.stringify(body) });

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("HS_LOCAL_PREVIEW", "1");
  vi.stubEnv("HS_ORIGIN", origin);
  vi.clearAllMocks();
  mocks.catalogue.mockResolvedValue({ manage: false, buttons: [] });
  mocks.search.mockResolvedValue({ results: [] });
  mocks.history.mockResolvedValue({ events: [], receipts: [] });
  mocks.receipt.mockResolvedValue({ id: operationId, recoverable: true });
  mocks.read.mockResolvedValue({ id: buttonId });
  mocks.create.mockResolvedValue({ id: buttonId, status: "draft", version: 1 });
  mocks.preview.mockResolvedValue({ previewId: operationId });
  mocks.apply.mockResolvedValue({ actionStatus: "succeeded", linkStatus: "failed" });
  mocks.retry.mockResolvedValue({ actionStatus: "succeeded", linkStatus: "failed", recoverable: true });
});
afterEach(() => vi.unstubAllEnvs());

it("rejects a foreign origin, a script, and a url before creating an action button", async () => {
  const listed = await GET(new Request(`${origin}/api/v1/workspaces/${workspaceId}/action-buttons`), params);
  expect(listed.status).toBe(200);
  expect(listed.headers.get("cache-control")).toBe("no-store");
  expect(mocks.catalogue).toHaveBeenCalledWith({}, expect.any(Object), workspaceId, { recordId: null, pageId: null });
  const body = { action: "create", operationId, collection: "organisations", label: "Add a note", definition, script: "alert(1)" };
  expect((await POST(request(body, { origin: "https://foreign.invalid" }), params)).status).toBe(403);
  expect(mocks.create).not.toHaveBeenCalled();
  expect((await POST(request(body), params)).status).toBe(422);
  expect((await POST(request({ action: "create", operationId, collection: "organisations", label: "Add a note", definition, url: "https://evil.example" }), params)).status).toBe(422);
  expect(mocks.create).not.toHaveBeenCalled();
  expect((await POST(request({ action: "create", operationId, collection: "organisations", label: "Add a note", definition }), params)).status).toBe(200);
  expect(mocks.create).toHaveBeenCalledWith({}, expect.any(Object), workspaceId, expect.objectContaining({ label: "Add a note", collection: "organisations" }));
});

it("uses the same not-found response for a missing button and a denied read", async () => {
  expect((await GET(new Request(`${origin}/api/v1/workspaces/${workspaceId}/action-buttons?view=search`), params)).status).toBe(422);
  expect(mocks.search).not.toHaveBeenCalled();
  expect((await GET(new Request(`${origin}/api/v1/workspaces/${workspaceId}/action-buttons?view=button`), params)).status).toBe(404);
  const { DocumentError } = await import("./document");
  mocks.read.mockRejectedValueOnce(new DocumentError("Action buttons are restricted or unavailable.", "not_found", 404));
  const denied = await GET(new Request(`${origin}/api/v1/workspaces/${workspaceId}/action-buttons?view=button&buttonId=${buttonId}`), params);
  expect(denied.status).toBe(404);
  expect(await denied.json()).toEqual({ error: "Action buttons are restricted or unavailable.", code: "not_found", retryable: false });
  expect((await GET(new Request(`${origin}/api/v1/workspaces/nope/action-buttons`), { params: Promise.resolve({ id: "" }) })).status).toBe(404);
  expect((await POST(request({ action: "preview", operationId, buttonId, kind: "invoke", expectedVersion: 1, recordId: buttonId, script: true }), params)).status).toBe(422);
  expect(mocks.preview).not.toHaveBeenCalled();
  expect((await POST(request({ action: "preview", operationId, buttonId, kind: "invoke", expectedVersion: 1, recordId: buttonId }), params)).status).toBe(200);
  expect(mocks.preview).toHaveBeenCalled();
  expect((await POST(request({ action: "retry-link", operationId, receiptId: buttonId }), params)).status).toBe(200);
  expect(mocks.retry).toHaveBeenCalled();
});
