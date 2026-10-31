import { beforeEach, expect, it, vi } from "vitest";
import { DocumentError } from "./document";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  repository: vi.fn(),
  read: vi.fn(),
  published: vi.fn(),
  save: vi.fn(),
  preview: vi.fn(),
  publish: vi.fn(),
  constructed: [] as unknown[][],
}));
vi.mock("./suite-tenant-authority", () => ({ authenticateRecordAuthority: mocks.authenticate }));
vi.mock("./repository", () => ({ repository: mocks.repository }));
vi.mock("./shared-record-layouts", () => ({
  SharedRecordLayoutRepository: class {
    constructor(...args: unknown[]) { mocks.constructed.push(args); }
    readLayoutDraft = mocks.read;
    getPublishedLayout = mocks.published;
    saveLayoutDraft = mocks.save;
    previewLayoutPublication = mocks.preview;
    publishLayout = mocks.publish;
  },
}));
import { GET, POST } from "../app/api/v1/workspaces/[id]/tenants/[tenantId]/record-layouts/route";

const tenantId = "00000000-0000-4000-8000-000000000002";
const recordId = "00000000-0000-4000-8000-0000000000c1";
const operationId = "00000000-0000-4000-8000-0000000000c3";
const previewId = "00000000-0000-4000-8000-0000000000c4";
const hash = "ab".repeat(32);
const authority = { verify: vi.fn() };
const pages = { kind: "repository" };
const scope = () => ({ params: Promise.resolve({ id: "workspace-a", tenantId }) });
const ctx = { actor: { id: "verified-user" }, workspaceId: "workspace-a", tenantId };
const definition = { tabs: [{ id: "00000000-0000-4000-8000-0000000000d1", label: "General", sections: [{ id: "00000000-0000-4000-8000-0000000000d2", label: "Details", description: "", columns: 1, fields: [{ field: "name", mode: "edit" }] }] }] };
const post = (data: unknown, origin = "https://hs.example") => new Request("https://hs.example/api/record-layouts", {
  method: "POST",
  headers: { Origin: origin, "Content-Type": "application/json" },
  body: JSON.stringify(data),
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.constructed.length = 0;
  vi.stubEnv("HS_ORIGIN", "https://hs.example");
  mocks.authenticate.mockResolvedValue({ actor: { id: "verified-user" }, authority });
  mocks.repository.mockResolvedValue(pages);
});

it("returns the published layout without the management draft", async () => {
  const published = { publicationRevision: 2, fields: [{ key: "name", label: "Name" }], canCreate: true };
  mocks.published.mockResolvedValue(published);
  mocks.read.mockResolvedValue({ draft: { definition: { tabs: [{ label: "Unpublished salary" }] } } });
  const response = await GET(new Request(`https://hs.example/api/record-layouts?collection=organisations&recordId=${recordId}`), scope());
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("vary")).toBe("Cookie, Authorization");
  expect(await response.json()).toEqual({ published });
  expect(mocks.published).toHaveBeenCalledWith(ctx, "organisations", recordId);
  expect(mocks.read).not.toHaveBeenCalled();
  expect(mocks.constructed).toEqual([[pages, authority]]);
});

it("keeps draft reads behind an explicit management request and fails closed without it", async () => {
  const draft = { draft_version: 1, publication_revision: 0, draft: null };
  const published = { publicationRevision: 0, fields: [] };
  mocks.read.mockResolvedValue(draft);
  mocks.published.mockResolvedValue(published);
  const allowed = await GET(new Request("https://hs.example/api/record-layouts?collection=organisations&includeDraft=1"), scope());
  expect(allowed.status).toBe(200);
  expect(await allowed.json()).toEqual({ draft, published });
  expect(mocks.read).toHaveBeenCalledWith(ctx, "organisations");
  mocks.read.mockRejectedValue(new DocumentError("The layout is unavailable or changed. Review the current draft.", "record_layout_forbidden", 403));
  const denied = await GET(new Request("https://hs.example/api/record-layouts?collection=organisations&includeDraft=1"), scope());
  expect(denied.status).toBe(403);
  const deniedBody = await denied.json();
  expect(deniedBody).toMatchObject({ code: "record_layout_forbidden", retryable: false });
  expect(JSON.stringify(deniedBody)).not.toContain("Unpublished");
});

it("rejects forged queries and a disabled record feature before storage access", async () => {
  expect((await GET(new Request("https://hs.example/api/record-layouts?collection=organisations&includeDraft=true"), scope())).status).toBe(400);
  expect((await GET(new Request("https://hs.example/api/record-layouts?collection=organisations&actorId=forged"), scope())).status).toBe(400);
  expect((await GET(new Request("https://hs.example/api/record-layouts?collection=organisations&recordId=not-a-record"), scope())).status).toBe(400);
  expect(mocks.authenticate).not.toHaveBeenCalled();
  expect(mocks.repository).not.toHaveBeenCalled();
  mocks.authenticate.mockRejectedValue(new DocumentError("Structured records are not enabled in this environment.", "record_feature_disabled", 503));
  const disabled = await GET(new Request("https://hs.example/api/record-layouts?collection=organisations"), scope());
  expect(disabled.status).toBe(503);
  expect(await disabled.json()).toMatchObject({ code: "record_feature_disabled", retryable: true });
  expect(mocks.repository).not.toHaveBeenCalled();
  mocks.published.mockRejectedValue(new Error("postgres://secret-host/holy"));
  mocks.authenticate.mockResolvedValue({ actor: { id: "verified-user" }, authority });
  const broken = await GET(new Request("https://hs.example/api/record-layouts?collection=organisations"), scope());
  expect(broken.status).toBe(503);
  const brokenBody = await broken.json();
  expect(JSON.stringify(brokenBody)).not.toContain("secret-host");
  expect(brokenBody).toMatchObject({ code: "service_unavailable", retryable: true });
});

it("saves, reviews and publishes without transport kind, record values or a cross-origin caller", async () => {
  const denied = await POST(post({ kind: "save", collection: "organisations", values: { name: "Secret" } }, "https://attacker.example"), scope());
  expect(denied.status).toBe(403);
  expect(mocks.authenticate).not.toHaveBeenCalled();
  const save = { collection: "organisations", expectedVersion: 1, expectedSchemaVersion: 2, operationId, definition };
  mocks.save.mockResolvedValue({ version: 2, replayed: false });
  expect((await POST(post({ kind: "save", ...save, values: { name: "Secret" } }), scope())).status).toBe(400);
  expect(mocks.save).not.toHaveBeenCalled();
  const saved = await POST(post({ kind: "save", ...save }), scope());
  expect(saved.status).toBe(200);
  expect(mocks.save).toHaveBeenCalledWith(ctx, save);
  const preview = { collection: "organisations", sourceVersion: 2, expectedPublicationRevision: 0, expectedSchemaVersion: 2 };
  mocks.preview.mockResolvedValue({ previewId, reviewHash: hash, definition });
  expect((await POST(post({ kind: "preview", ...preview }), scope())).status).toBe(200);
  expect(mocks.preview).toHaveBeenCalledWith(ctx, preview);
  mocks.preview.mockRejectedValue(new DocumentError("The layout is unavailable or changed. Review the current draft.", "record_layout_required_unreachable", 422));
  const unreachable = await POST(post({ kind: "preview", ...preview }), scope());
  expect(unreachable.status).toBe(422);
  expect(await unreachable.json()).toMatchObject({ code: "record_layout_required_unreachable", retryable: false });
  const publish = { previewId, reviewHash: hash, operationId, confirm: "publish-record-layout" as const };
  mocks.publish.mockResolvedValue({ publicationRevision: 1, replayed: false });
  expect((await POST(post({ kind: "publish", ...publish }), scope())).status).toBe(200);
  expect(mocks.publish).toHaveBeenCalledWith(ctx, publish);
  expect((await POST(post({ kind: "publish", ...publish, confirm: "publish" }), scope())).status).toBe(400);
  expect(mocks.constructed.every((args) => args.length === 2 && args[1] === authority)).toBe(true);
});
