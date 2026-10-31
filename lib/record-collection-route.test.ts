import { beforeEach, expect, it, vi } from "vitest";
import { DocumentError } from "./document";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  repository: vi.fn(),
  list: vi.fn(),
  preview: vi.fn(),
  apply: vi.fn(),
  previewRemoval: vi.fn(),
  remove: vi.fn(),
  constructed: [] as unknown[][],
}));
vi.mock("./suite-tenant-authority", () => ({ authenticateRecordAuthority: mocks.authenticate }));
vi.mock("./repository", () => ({ repository: mocks.repository }));
vi.mock("./shared-record-collections", () => ({
  SharedRecordCollectionRepository: class {
    constructor(...args: unknown[]) { mocks.constructed.push(args); }
    listCollections = mocks.list;
    previewCollection = mocks.preview;
    applyCollection = mocks.apply;
    previewCollectionRemoval = mocks.previewRemoval;
    removeCollection = mocks.remove;
  },
}));
import { GET, POST } from "../app/api/v1/workspaces/[id]/tenants/[tenantId]/collections/route";

const tenantId = "00000000-0000-4000-8000-000000000002";
const collectionId = "00000000-0000-4000-8000-0000000000c1";
const previewId = "00000000-0000-4000-8000-0000000000c2";
const operationId = "00000000-0000-4000-8000-0000000000c3";
const hash = "ab".repeat(32);
const authority = { verify: vi.fn() };
const pages = { kind: "repository" };
const scope = () => ({ params: Promise.resolve({ id: "workspace-a", tenantId }) });
const proposal = { id: collectionId, name: "Synthetic assets", description: "Actor-private configuration", ownerId: "verified-user", expectedVersion: 0, expectedSchemaVersion: 1, initialFields: [] as unknown[] };
const post = (data: unknown, origin = "https://hs.example") => new Request("https://hs.example/api/collections", {
  method: "POST",
  headers: { Origin: origin, "Content-Type": "application/json" },
  body: typeof data === "string" ? data : JSON.stringify(data),
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.constructed.length = 0;
  vi.stubEnv("HS_ORIGIN", "https://hs.example");
  mocks.authenticate.mockResolvedValue({ actor: { id: "verified-user" }, authority });
  mocks.repository.mockResolvedValue(pages);
});

it("lists collections for the verified actor without an owner or inventory adapter", async () => {
  const page = { collections: [{ id: collectionId, name: "Synthetic assets" }], truncated: false };
  mocks.list.mockResolvedValue(page);
  const response = await GET(new Request("https://hs.example/api/collections"), scope());
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("vary")).toBe("Cookie, Authorization");
  expect(await response.json()).toEqual(page);
  expect(mocks.list).toHaveBeenCalledWith({ actor: { id: "verified-user" }, workspaceId: "workspace-a", tenantId }, false);
  expect(mocks.constructed).toEqual([[pages, authority]]);
  mocks.list.mockResolvedValue({ collections: [], truncated: false });
  expect((await GET(new Request("https://hs.example/api/collections?includeDeprecated=1"), scope())).status).toBe(200);
  expect(mocks.list).toHaveBeenLastCalledWith(expect.anything(), true);
  expect((await GET(new Request("https://hs.example/api/collections?includeDeprecated=true"), scope())).status).toBe(400);
  expect((await GET(new Request("https://hs.example/api/collections?actorId=forged"), scope())).status).toBe(400);
  expect(mocks.list).toHaveBeenCalledTimes(2);
  mocks.authenticate.mockRejectedValue(new DocumentError("Structured records are not enabled in this environment.", "record_feature_disabled", 503));
  const disabled = await GET(new Request("https://hs.example/api/collections?includeDeprecated=nope"), scope());
  expect(disabled.status).toBe(503);
  expect(await disabled.json()).toMatchObject({ code: "record_feature_disabled", retryable: true });
  expect(disabled.headers.get("cache-control")).toBe("no-store");
  expect(mocks.repository).toHaveBeenCalledTimes(2);
  expect(mocks.constructed.every((args) => args.length === 2 && args[1] === authority)).toBe(true);
});

it("previews and applies create, rename and deprecation without keeping the transport kind", async () => {
  const reviewed = { previewId, reviewHash: hash, grantsCreated: false };
  mocks.preview.mockResolvedValue(reviewed);
  const preview = await POST(post({ kind: "preview", proposal }), scope());
  expect(preview.status).toBe(200);
  expect(preview.headers.get("cache-control")).toBe("no-store");
  expect(await preview.json()).toEqual(reviewed);
  expect(mocks.preview).toHaveBeenCalledWith({ actor: { id: "verified-user" }, workspaceId: "workspace-a", tenantId }, { ...proposal, deprecated: false });
  const saved = { ...proposal, name: "Renamed assets", expectedVersion: 1, expectedSchemaVersion: 2, deprecated: true };
  const apply = { previewId, reviewHash: hash, operationId, confirm: "save-custom-collection" as const, proposal: saved };
  mocks.apply.mockResolvedValue({ appliedVersion: 2, replayed: false, grantsCreated: false });
  expect((await POST(post({ kind: "apply", ...apply }), scope())).status).toBe(200);
  expect(mocks.apply).toHaveBeenCalledWith(expect.objectContaining({ actor: { id: "verified-user" } }), apply);
  expect(JSON.stringify(mocks.apply.mock.calls[0][1])).not.toContain('"kind"');
  expect(mocks.constructed.every((args) => args.length === 2 && args[1] === authority)).toBe(true);
});

it("previews and removes only through the empty-collection confirmation", async () => {
  mocks.previewRemoval.mockResolvedValue({ previewId, reviewHash: hash, blocked: false });
  expect((await POST(post({ kind: "preview-removal", collection: collectionId, expectedVersion: 1 }), scope())).status).toBe(200);
  expect(mocks.previewRemoval).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "workspace-a", tenantId }), collectionId, 1);
  const removal = { previewId, reviewHash: hash, operationId, confirm: "remove-empty-custom-collection" as const };
  mocks.remove.mockResolvedValue({ id: collectionId, version: 2, removed: true, replayed: false });
  const response = await POST(post({ kind: "remove", ...removal }), scope());
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ removed: true, replayed: false });
  expect(mocks.remove).toHaveBeenCalledWith(expect.anything(), removal);
  expect((await POST(post({ kind: "preview-removal", collection: "organisations", expectedVersion: 1 }), scope())).status).toBe(400);
  expect((await POST(post({ kind: "remove", ...removal, confirm: "save-custom-collection" }), scope())).status).toBe(400);
  expect(mocks.previewRemoval).toHaveBeenCalledTimes(1);
  expect(mocks.remove).toHaveBeenCalledTimes(1);
});

it("fails closed on a missing flag, cross-origin write, forged scope, or unexpected state", async () => {
  const calls = mocks.authenticate.mock.calls.length;
  expect((await POST(post({ kind: "preview", proposal }, "https://attacker.example"), scope())).status).toBe(403);
  expect(mocks.authenticate.mock.calls.length).toBe(calls);
  expect(mocks.repository).not.toHaveBeenCalled();
  mocks.authenticate.mockRejectedValue(new DocumentError("Structured records are not enabled in this environment.", "record_feature_disabled", 503));
  const disabled = await POST(post("{not json"), scope());
  expect(disabled.status).toBe(503);
  expect(await disabled.json()).toMatchObject({ code: "record_feature_disabled", retryable: true });
  expect(mocks.preview).not.toHaveBeenCalled();
  mocks.authenticate.mockResolvedValue({ actor: { id: "verified-user" }, authority });
  expect((await POST(post({ kind: "preview", proposal, grants: ["manage-collections"] }), scope())).status).toBe(400);
  expect((await POST(post({ kind: "apply", previewId, reviewHash: hash, operationId, confirm: "save-custom-collection", proposal, actorId: "forged" }), scope())).status).toBe(400);
  expect((await POST(post("x".repeat(128_001)), scope())).status).toBe(413);
  expect(mocks.preview).not.toHaveBeenCalled();
  expect(mocks.apply).not.toHaveBeenCalled();
  mocks.apply.mockRejectedValue(new DocumentError("The custom collection is unavailable or changed. Review the current configuration.", "record_collection_forbidden", 403));
  const forbidden = await POST(post({ kind: "apply", previewId, reviewHash: hash, operationId, confirm: "save-custom-collection", proposal }), scope());
  expect(forbidden.status).toBe(403);
  expect(await forbidden.json()).toMatchObject({ code: "record_collection_forbidden", retryable: false });
  expect(forbidden.headers.get("cache-control")).toBe("no-store");
  mocks.remove.mockRejectedValue(new Error("dependency inventory names"));
  const unavailable = await POST(post({ kind: "remove", previewId, reviewHash: hash, operationId, confirm: "remove-empty-custom-collection" }), scope());
  expect(unavailable.status).toBe(503);
  const body = await unavailable.json();
  expect(body).toMatchObject({ code: "service_unavailable", retryable: true });
  expect(JSON.stringify(body)).not.toContain("dependency inventory names");
  expect(mocks.constructed.every((args) => args.length === 2 && args[1] === authority)).toBe(true);
});
