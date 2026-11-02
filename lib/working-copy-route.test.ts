import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ create: vi.fn(), list: vi.fn(), read: vi.fn(), reconcile: vi.fn(), apply: vi.fn(), abandon: vi.fn(), archive: vi.fn(), choices: vi.fn(), repository: vi.fn(async () => ({})) }));
vi.mock("./repository", () => ({ repository: mocks.repository }));
vi.mock("./working-copies", () => ({
  createWorkingCopy: mocks.create,
  listWorkingCopies: mocks.list,
  readWorkingCopy: mocks.read,
  reconcileWorkingCopy: mocks.reconcile,
  applyWorkingCopy: mocks.apply,
  abandonWorkingCopy: mocks.abandon,
  archiveWorkingCopy: mocks.archive,
  saveWorkingCopyChoices: mocks.choices,
}));
import { GET as list, POST as create } from "../app/api/v1/pages/[id]/working-copies/route";
import { GET as read, POST as command } from "../app/api/v1/working-copies/[id]/route";

const origin = "http://localhost:3000";
const pageId = "page-1";
const copyId = "00000000-0000-4000-8000-0000000000c1";
const operationId = "00000000-0000-4000-8000-0000000000c2";
const pageParams = { params: Promise.resolve({ id: pageId }) };
const copyParams = { params: Promise.resolve({ id: copyId }) };
const request = (path: string, body: unknown, extra: Record<string, string> = {}) => new Request(origin + path, { method: "POST", headers: { origin, "content-type": "application/json", ...extra }, body: JSON.stringify(body) });

beforeEach(() => {
  vi.stubEnv("NODE_ENV", "test");
  vi.stubEnv("HS_LOCAL_PREVIEW", "1");
  vi.stubEnv("HS_ORIGIN", origin);
  vi.clearAllMocks();
  mocks.list.mockResolvedValue({ copies: [] });
  mocks.create.mockResolvedValue({ id: copyId, state: "open" });
  mocks.read.mockResolvedValue({ id: copyId, state: "open" });
  mocks.reconcile.mockResolvedValue({ conflicts: [], ready: true });
  mocks.apply.mockResolvedValue({ state: "applied", sourceVersion: 3 });
  mocks.abandon.mockResolvedValue({ state: "abandoned" });
  mocks.archive.mockResolvedValue({ state: "archived" });
  mocks.choices.mockResolvedValue({ version: 2 });
});
afterEach(() => vi.unstubAllEnvs());

it("rejects a foreign origin and an extra field before creating a copy", async () => {
  expect((await list(new Request(`${origin}/api/v1/pages/${pageId}/working-copies`), pageParams)).status).toBe(200);
  expect(mocks.list).toHaveBeenCalledWith({}, expect.any(Object), pageId);
  const body = { operationId, extra: true };
  expect((await create(request("/api/test", body, { origin: "https://foreign.invalid" }), pageParams)).status).toBe(403);
  expect(mocks.create).not.toHaveBeenCalled();
  expect((await create(request("/api/test", body), pageParams)).status).toBe(422);
  expect(mocks.create).not.toHaveBeenCalled();
  expect((await create(request("/api/test", { operationId }), pageParams)).status).toBe(200);
  expect(mocks.create).toHaveBeenCalledWith({}, expect.any(Object), pageId, operationId);
});

it("uses the same not-found response for a bad copy id and a denied read", async () => {
  expect((await read(new Request(`${origin}/api/test`), { params: Promise.resolve({ id: "not-a-uuid" }) })).status).toBe(404);
  expect(mocks.read).not.toHaveBeenCalled();
  const { DocumentError } = await import("./document");
  mocks.read.mockRejectedValueOnce(new DocumentError("Working copy unavailable", "not_found", 404));
  const denied = await read(new Request(`${origin}/api/test`), copyParams);
  expect(denied.status).toBe(404);
  expect(await denied.json()).toEqual({ error: "Working copy unavailable", code: "not_found", retryable: false });
});

it("requires explicit apply choices and does not call apply for a partial command", async () => {
  expect((await command(request("/api/test", { action: "reconcile" }), copyParams)).status).toBe(200);
  expect(mocks.reconcile).toHaveBeenCalledWith({}, expect.any(Object), copyId);
  expect((await command(request("/api/test", { action: "apply", operationId, expectedVersion: 1, expectedSourceVersion: 2 }), copyParams)).status).toBe(422);
  expect(mocks.apply).not.toHaveBeenCalled();
  expect((await command(request("/api/test", { action: "apply", operationId, expectedVersion: 1, expectedSourceVersion: 2, choices: { block: "copy" } }), copyParams)).status).toBe(200);
  expect(mocks.apply).toHaveBeenCalled();
  expect((await command(request("/api/test", { action: "abandon", operationId, expectedVersion: 1 }), copyParams)).status).toBe(200);
  expect(mocks.abandon).toHaveBeenCalled();
});
