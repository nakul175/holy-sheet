import { beforeEach, expect, it, vi } from "vitest";
import { DocumentError } from "./document";
const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  repository: vi.fn(),
  list: vi.fn(),
  create: vi.fn(),
  get: vi.fn(),
  update: vi.fn(),
  mutateRelationship: vi.fn(),
  previewReparent: vi.fn(),
  reparent: vi.fn(),
}));
vi.mock("./suite-tenant-authority", () => ({
  authenticateRecordAuthority: mocks.authenticate,
}));
vi.mock("./repository", () => ({ repository: mocks.repository }));
vi.mock("./shared-records", () => ({
  SharedRecordRepository: class {
    list = mocks.list;
    create = mocks.create;
    get = mocks.get;
    update = mocks.update;
  },
}));
vi.mock("./shared-record-relationships", () => ({
  SharedRecordRelationshipRepository: class {
    mutateRelationship = mocks.mutateRelationship;
    previewReparent = mocks.previewReparent;
    reparent = mocks.reparent;
  },
}));
import { GET as LIST, POST as CREATE } from "../app/api/v1/workspaces/[id]/tenants/[tenantId]/records/route";
import { GET as GET_ONE, PATCH as UPDATE } from "../app/api/v1/workspaces/[id]/tenants/[tenantId]/records/[recordId]/route";
import { POST as RELATIONSHIP } from "../app/api/v1/workspaces/[id]/tenants/[tenantId]/records/[recordId]/relationships/route";
import { POST as REPARENT } from "../app/api/v1/workspaces/[id]/tenants/[tenantId]/records/[recordId]/reparent/route";
const tenantId = "00000000-0000-4000-8000-000000000002",
  recordId = "00000000-0000-4000-8000-000000000003",
  operationId = "00000000-0000-4000-8000-000000000004",
  scope = () => ({ params: Promise.resolve({ id: "workspace-a", tenantId }) }),
  detail = () => ({
    params: Promise.resolve({ id: "workspace-a", tenantId, recordId }),
  });
const change = (method: string, body: unknown, origin = "https://hs.example") =>
  new Request("https://hs.example/api/records", {
    method,
    headers: { Origin: origin, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("HS_ORIGIN", "https://hs.example");
  mocks.authenticate.mockResolvedValue({
    actor: { id: "verified-user" },
    authority: { verify: vi.fn() },
  });
  mocks.repository.mockResolvedValue({});
});
it("binds deterministic list and detail reads to the authenticated URL scope", async () => {
  mocks.list.mockResolvedValue({
    schemaVersion: 2,
    results: [],
    nextCursor: null,
  });
  const listed = await LIST(new Request(`https://hs.example/api/records?collection=organisations&query=Acme&cursor=${"a".repeat(43)}`), scope());
  expect(listed.status).toBe(200);
  expect(listed.headers.get("cache-control")).toBe("no-store");
  expect(mocks.list).toHaveBeenCalledWith(
    { actor: { id: "verified-user" }, workspaceId: "workspace-a", tenantId },
    {
      collection: "organisations",
      query: "Acme",
      cursor: "a".repeat(43),
      includeArchived: false,
    },
  );
  mocks.get.mockResolvedValue({ id: recordId });
  expect((await GET_ONE(new Request("https://hs.example/api/record"), detail())).status).toBe(200);
  expect(mocks.get).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "workspace-a", tenantId }), recordId);
});
it("creates and edits with strict server inputs and current URL authority", async () => {
  const creation = {
    kind: "create",
    operationId,
    collection: "organisations",
    name: " Acme ",
    schemaVersion: 1,
    values: {},
  };
  mocks.create.mockResolvedValue({ record: { id: recordId } });
  expect((await CREATE(change("POST", creation), scope())).status).toBe(200);
  expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "workspace-a", tenantId }), {
    operationId,
    collection: "organisations",
    name: " Acme ",
    schemaVersion: 1,
    values: {},
  });
  const update = {
    operationId,
    expectedVersion: 2,
    schemaVersion: 1,
    name: "Renamed",
  };
  mocks.update.mockResolvedValue({ record: { id: recordId, version: 3 } });
  expect((await UPDATE(change("PATCH", update), detail())).status).toBe(200);
  expect(mocks.update).toHaveBeenCalledWith(expect.anything(), recordId, update);
});
it("denies cross-origin writes before authentication and preserves safe domain errors", async () => {
  expect((await CREATE(change("POST", { kind: "create" }, "https://attacker.example"), scope())).status).toBe(403);
  expect(mocks.authenticate).not.toHaveBeenCalled();
  mocks.authenticate.mockResolvedValue({
    actor: { id: "verified-user" },
    authority: { verify: vi.fn() },
  });
  mocks.list.mockRejectedValue(new DocumentError("Record is restricted or unavailable.", "record_not_found", 404));
  const response = await LIST(new Request("https://hs.example/api/records?collection=organisations"), scope());
  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({
    code: "record_not_found",
    retryable: false,
  });
});
it("rejects forged or unknown mutation fields without calling storage", async () => {
  const response = await CREATE(
    change("POST", {
      kind: "create",
      operationId,
      collection: "organisations",
      name: "Acme",
      schemaVersion: 1,
      values: {},
      actorId: "forged",
    }),
    scope(),
  );
  expect(response.status).toBe(400);
  expect(mocks.create).not.toHaveBeenCalled();
});
it("routes strict relationship mutations through current authenticated authority", async () => {
  const targetId = "00000000-0000-4000-8000-000000000005",
    input = {
      operationId,
      expectedVersion: 2,
      kind: "contact-account",
      targetId,
      action: "upsert",
      role: "Buyer",
      primary: true,
      status: "active",
    };
  mocks.mutateRelationship.mockResolvedValue({
    record: { id: recordId, version: 3 },
  });
  const response = await RELATIONSHIP(change("POST", input), detail());
  expect(response.status).toBe(200);
  expect(mocks.mutateRelationship).toHaveBeenCalledWith({ actor: { id: "verified-user" }, workspaceId: "workspace-a", tenantId }, recordId, input);
  const forged = await RELATIONSHIP(change("POST", { ...input, tenantId: "forged" }), detail());
  expect(forged.status).toBe(400);
});
it("separates account reparent preview from explicit confirmed apply", async () => {
  const newOrganisationId = "00000000-0000-4000-8000-000000000006",
    preview = { action: "preview", newOrganisationId };
  mocks.previewReparent.mockResolvedValue({ previewToken: "a".repeat(64) });
  expect((await REPARENT(change("POST", preview), detail())).status).toBe(200);
  expect(mocks.previewReparent).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: "workspace-a", tenantId }), recordId, preview);
  const apply = {
    action: "apply",
    operationId,
    expectedVersion: 2,
    newOrganisationId,
    previewToken: "a".repeat(64),
    confirmed: true,
  };
  mocks.reparent.mockResolvedValue({ record: { id: recordId, version: 3 } });
  expect((await REPARENT(change("POST", apply), detail())).status).toBe(200);
  expect(mocks.reparent).toHaveBeenCalledWith(expect.anything(), recordId, apply);
  expect((await REPARENT(change("POST", { ...apply, confirmed: false }), detail())).status).toBe(400);
});
