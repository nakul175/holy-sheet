import { beforeEach, expect, it, vi } from "vitest";
import { DocumentError } from "./document";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  repository: vi.fn(),
  listRecordHistory: vi.fn(),
  previewValueRestore: vi.fn(),
  applyValueRestore: vi.fn(),
  constructed: [] as unknown[][],
}));
vi.mock("./suite-tenant-authority", () => ({ authenticateRecordAuthority: mocks.authenticate }));
vi.mock("./repository", () => ({ repository: mocks.repository }));
vi.mock("./shared-record-history", () => ({
  SharedRecordHistoryRepository: class {
    constructor(...args: unknown[]) { mocks.constructed.push(args); }
    listRecordHistory = mocks.listRecordHistory;
    previewValueRestore = mocks.previewValueRestore;
    applyValueRestore = mocks.applyValueRestore;
  },
}));
import { GET, POST } from "../app/api/v1/workspaces/[id]/tenants/[tenantId]/records/[recordId]/history/route";

const tenantId = "00000000-0000-4000-8000-000000000002";
const recordId = "00000000-0000-4000-8000-0000000000a1";
const eventId = "00000000-0000-4000-8000-0000000000e1";
const previewId = "00000000-0000-4000-8000-0000000000e3";
const operationId = "00000000-0000-4000-8000-0000000000e4";
const hash = "ab".repeat(32);
const cursor = "a".repeat(43);
const authority = { verify: vi.fn() };
const scope = () => ({ params: Promise.resolve({ id: "workspace-a", tenantId, recordId }) });
const previewBody = { kind: "preview", eventId, side: "before", fields: ["name", "core:notes"], expectedVersion: 4 };
const applyBody = { kind: "apply", previewId, reviewHash: hash, operationId, confirm: "restore-selected-values" };
const post = (data: unknown, origin = "https://hs.example") => new Request("https://hs.example/api/history", { method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: JSON.stringify(data) });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.constructed.length = 0;
  vi.stubEnv("HS_ORIGIN", "https://hs.example");
  mocks.authenticate.mockResolvedValue({ actor: { id: "verified-user" }, authority });
  mocks.repository.mockResolvedValue({});
});

it("lists anchored history through suite-tenant authority without a reference adapter", async () => {
  const page = { events: [], nextCursor: cursor, anchorVersion: 9 };
  mocks.listRecordHistory.mockResolvedValue(page);
  const response = await GET(new Request(`https://hs.example/api/history?cursor=${cursor}`), scope());
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual(page);
  expect(mocks.listRecordHistory).toHaveBeenCalledWith(expect.objectContaining({ actor: { id: "verified-user" }, workspaceId: "workspace-a", tenantId }), recordId, cursor);
  expect(mocks.constructed).toEqual([[{}, authority]]);
  mocks.listRecordHistory.mockResolvedValue({ events: [], nextCursor: null, anchorVersion: 9 });
  expect((await GET(new Request("https://hs.example/api/history"), scope())).status).toBe(200);
  expect(mocks.listRecordHistory).toHaveBeenLastCalledWith(expect.anything(), recordId, undefined);
  expect((await GET(new Request("https://hs.example/api/history?cursor=short"), scope())).status).toBe(400);
  expect(mocks.listRecordHistory).toHaveBeenCalledTimes(2);
  mocks.listRecordHistory.mockRejectedValue(new DocumentError("Record is restricted or unavailable.", "record_not_found", 404));
  const denied = await GET(new Request("https://hs.example/api/history"), scope());
  expect(denied.status).toBe(404);
  expect(await denied.json()).toMatchObject({ code: "record_not_found", retryable: false });
  mocks.authenticate.mockRejectedValue(new DocumentError("Structured records are not enabled in this environment.", "record_feature_disabled", 503));
  const disabled = await GET(new Request("https://hs.example/api/history"), scope());
  expect(disabled.status).toBe(503);
  expect(await disabled.json()).toMatchObject({ code: "record_feature_disabled", retryable: true });
  expect(mocks.constructed.every((args) => args.length === 2 && args[1] === authority)).toBe(true);
});

it("previews and applies a stored selection without accepting submitted values", async () => {
  mocks.previewValueRestore.mockResolvedValue({ previewId, reviewHash: hash });
  const reviewed = await POST(post(previewBody), scope());
  expect(reviewed.status).toBe(200);
  expect(reviewed.headers.get("cache-control")).toBe("no-store");
  expect(mocks.previewValueRestore).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "workspace-a", tenantId }), recordId, { eventId, side: "before", fields: ["name", "core:notes"], expectedVersion: 4 });
  mocks.applyValueRestore.mockResolvedValue({ appliedVersion: 5, replayed: false });
  const applied = await POST(post(applyBody), scope());
  expect(applied.status).toBe(200);
  expect(mocks.applyValueRestore).toHaveBeenCalledWith(expect.anything(), { previewId, reviewHash: hash, operationId, confirm: "restore-selected-values", recordId });
  expect((await POST(post({ ...previewBody, values: { name: "typed replacement" } }), scope())).status).toBe(400);
  expect((await POST(post({ ...previewBody, fields: ["name", "name"] }), scope())).status).toBe(400);
  expect((await POST(post({ ...applyBody, confirm: "restore-anything" }), scope())).status).toBe(400);
  const authenticated = mocks.authenticate.mock.calls.length;
  expect((await POST(post(previewBody, "https://attacker.example"), scope())).status).toBe(403);
  expect(mocks.authenticate.mock.calls.length).toBe(authenticated);
  mocks.applyValueRestore.mockRejectedValue(new Error("database unavailable"));
  const unavailable = await POST(post(applyBody), scope());
  expect(unavailable.status).toBe(503);
  expect(await unavailable.json()).toMatchObject({ code: "service_unavailable", retryable: true });
  expect(mocks.previewValueRestore).toHaveBeenCalledTimes(1);
  expect(mocks.constructed.every((args) => args.length === 2 && args[1] === authority)).toBe(true);
});
