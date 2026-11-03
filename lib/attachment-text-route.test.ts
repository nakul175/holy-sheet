import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  search: vi.fn(), config: vi.fn(), catalogue: vi.fn(), preview: vi.fn(), history: vi.fn(), configHistory: vi.fn(),
  reindex: vi.fn(), save: vi.fn(), stash: vi.fn(), discard: vi.fn(), grant: vi.fn(), revoke: vi.fn(), download: vi.fn(),
  repository: vi.fn(async () => ({})),
}));
vi.mock("./repository", () => ({ repository: mocks.repository }));
vi.mock("./attachment-text", () => ({
  searchAttachmentText: mocks.search,
  readAttachmentTextConfig: mocks.config,
  listAttachmentText: mocks.catalogue,
  previewAttachmentText: mocks.preview,
  attachmentTextHistory: mocks.history,
  attachmentTextConfigHistory: mocks.configHistory,
  reindexAttachmentText: mocks.reindex,
  saveAttachmentTextConfig: mocks.save,
  stashAttachmentTextConfig: mocks.stash,
  discardAttachmentTextDraft: mocks.discard,
  grantAttachmentTextManager: mocks.grant,
  revokeAttachmentTextManager: mocks.revoke,
  downloadAttachmentText: mocks.download,
}));
import { GET, POST } from "../app/api/v1/workspaces/[id]/attachment-text/route";

const origin = "http://localhost:3000";
const workspaceId = "ws-aplyd";
const operationId = "00000000-0000-4000-8000-0000000000a1";
const recordId = "00000000-0000-4000-8000-0000000000a2";
const fileId = "00000000-0000-4000-8000-0000000000a3";
const versionId = "00000000-0000-4000-8000-0000000000a4";
const params = { params: Promise.resolve({ id: workspaceId }) };
const request = (body: unknown, extra: Record<string, string> = {}) => new Request(`${origin}/api/test`, { method: "POST", headers: { origin, "content-type": "application/json", ...extra }, body: JSON.stringify(body) });

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("HS_LOCAL_PREVIEW", "1");
  vi.stubEnv("HS_ORIGIN", origin);
  vi.clearAllMocks();
  mocks.search.mockResolvedValue({ hits: [] });
  mocks.config.mockResolvedValue({ language: "en", version: 0, manage: false });
  mocks.catalogue.mockResolvedValue({ files: [] });
  mocks.preview.mockResolvedValue({ filename: "notes.txt", page: 1 });
  mocks.history.mockResolvedValue({ events: [] });
  mocks.reindex.mockResolvedValue({ items: [], replayed: false });
  mocks.download.mockResolvedValue(new Response("open needle", { headers: { "content-type": "text/plain", "cache-control": "private, no-store" } }));
});
afterEach(() => vi.unstubAllEnvs());

it("routes search, preview, and history without accepting an external processor", async () => {
  expect((await GET(new Request(`${origin}/api/v1/workspaces/${workspaceId}/attachment-text?q=needle`), params)).status).toBe(200);
  expect(mocks.search).toHaveBeenCalledWith({}, expect.any(Object), workspaceId, "needle");
  expect((await GET(new Request(`${origin}/api/v1/workspaces/${workspaceId}/attachment-text?view=preview&recordId=${recordId}&versionId=${versionId}&page=2`), params)).status).toBe(200);
  expect(mocks.preview).toHaveBeenCalledWith({}, expect.any(Object), workspaceId, { recordId, versionId, page: 2 });
  expect((await GET(new Request(`${origin}/api/v1/workspaces/${workspaceId}/attachment-text?view=history&recordId=${recordId}&fileId=${fileId}`), params)).status).toBe(200);
  expect(mocks.history).toHaveBeenCalled();
  const extra = { action: "reindex", operationId, items: [{ recordId, fileId }], processorUrl: "https://ocr.example" };
  expect((await POST(request(extra, { origin: "https://foreign.invalid" }), params)).status).toBe(403);
  expect(mocks.reindex).not.toHaveBeenCalled();
  expect((await POST(request(extra), params)).status).toBe(422);
  expect(mocks.reindex).not.toHaveBeenCalled();
  expect((await POST(request({ action: "reindex", operationId, items: [{ recordId, fileId }] }), params)).status).toBe(200);
  expect(mocks.reindex).toHaveBeenCalledOnce();
  const download = await POST(request({ action: "download", operationId, recordId, versionId }), params);
  expect(download.status).toBe(200);
  expect(download.headers.get("cache-control")).toContain("no-store");
  expect(await download.text()).toBe("open needle");
});
