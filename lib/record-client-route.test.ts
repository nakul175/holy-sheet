import { beforeEach, expect, it, vi } from "vitest";
import { DocumentError } from "./document";
import { unavailableRecordClientAuthority } from "./record-client-authority";

const mocks = vi.hoisted(() => ({
  authenticate: vi.fn(),
  repository: vi.fn(),
  execute: vi.fn(),
  constructed: [] as unknown[][],
}));
vi.mock("./suite-tenant-authority", () => ({ authenticateRecordAuthority: mocks.authenticate }));
vi.mock("./repository", () => ({ repository: mocks.repository }));
vi.mock("./shared-record-api", () => ({
  SharedRecordApiV1: class {
    constructor(...args: unknown[]) { mocks.constructed.push(args); }
    execute = mocks.execute;
  },
}));
import { POST } from "../app/api/v1/workspaces/[id]/tenants/[tenantId]/record-client/route";

const tenantId = "00000000-0000-4000-8000-000000000002";
const authority = { verify: vi.fn() };
const pages = { kind: "repository" };
const scope = () => ({ params: Promise.resolve({ id: "workspace-a", tenantId }) });
const command = { apiVersion: 1, operation: "records.query", payload: { collection: "organisations", query: "Acme", clientId: "holy-sheet", tenantId: "browser-tenant", sourceApp: "holy-sheet" } };
const published = { apiVersion: 1, data: { results: [] }, authority: { verifiedAt: "2026-10-31T00:00:00.000Z", validUntil: "2026-10-31T00:05:00.000Z" }, cacheControl: "private, no-store", offline: false };
const post = (data: unknown, origin = "https://hs.example", extra: Record<string, string> = {}) => new Request("https://hs.example/api/record-client?clientId=holy-sheet&tenantId=browser-tenant", {
  method: "POST",
  headers: { Origin: origin, "Content-Type": "application/json", Authorization: "Bearer synthetic-secret", ...extra },
  body: typeof data === "string" ? data : JSON.stringify(data),
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.constructed.length = 0;
  vi.stubEnv("HS_ORIGIN", "https://hs.example");
  mocks.authenticate.mockResolvedValue({ actor: { id: "verified-user" }, authority });
  mocks.repository.mockResolvedValue(pages);
  mocks.execute.mockRejectedValue(new DocumentError("Current application delegation is unavailable.", "record_client_denied", 403));
});

it("submits the command through suite authority and an unavailable client adapter", async () => {
  const denied = await POST(post(command), scope());
  expect(denied.status).toBe(403);
  expect(denied.headers.get("cache-control")).toBe("private, no-store");
  expect(denied.headers.get("vary")).toBe("Cookie, Authorization");
  expect(await denied.json()).toEqual({ error: "Current application delegation is unavailable.", code: "record_client_denied", retryable: false });
  expect(mocks.execute).toHaveBeenCalledWith(
    { actor: { id: "verified-user" }, workspaceId: "workspace-a", tenantId, credential: {} },
    command,
  );
  expect(JSON.stringify(mocks.execute.mock.calls)).not.toContain("synthetic-secret");
  expect(mocks.constructed).toHaveLength(1);
  expect(mocks.constructed[0].slice(0, 2)).toEqual([pages, authority]);
  expect(mocks.constructed[0]).toHaveLength(3);
  const clients = mocks.constructed[0][2] as ReturnType<typeof unavailableRecordClientAuthority>;
  await expect(clients.verify({ actor: { id: "verified-user" }, workspaceId: "workspace-a", tenantId, credential: { authorization: "Bearer synthetic-secret" } })).rejects.toMatchObject({ code: "record_client_denied" });
  mocks.execute.mockResolvedValue(published);
  const ok = await POST(post(command), scope());
  expect(ok.status).toBe(200);
  expect(ok.headers.get("cache-control")).toBe("private, no-store");
  expect(await ok.json()).toEqual(published);
  mocks.execute.mockResolvedValue({ ...published, cacheControl: "public", credential: "Bearer synthetic-secret" });
  const cached = await POST(post(command), scope());
  const cachedBody = await cached.json();
  expect(cached.status).toBe(503);
  expect(cachedBody).toMatchObject({ code: "service_unavailable", retryable: true });
  expect(JSON.stringify(cachedBody)).not.toContain("synthetic-secret");
  mocks.execute.mockResolvedValue({ ...published, offline: true });
  expect((await POST(post(command), scope())).status).toBe(503);
  mocks.execute.mockRejectedValue(new Error("database unavailable"));
  expect((await POST(post(command), scope())).status).toBe(503);
});

it("authenticates before the body and ignores browser authority on failure", async () => {
  const calls = mocks.authenticate.mock.calls.length;
  expect((await POST(post(command, "https://attacker.example"), scope())).status).toBe(403);
  expect(mocks.authenticate.mock.calls.length).toBe(calls);
  expect(mocks.execute).not.toHaveBeenCalled();
  mocks.authenticate.mockRejectedValue(new DocumentError("Structured records are not enabled in this environment.", "record_feature_disabled", 503));
  const disabled = await POST(post("{not json"), scope());
  expect(disabled.status).toBe(503);
  expect(await disabled.json()).toMatchObject({ code: "record_feature_disabled", retryable: true });
  expect(mocks.execute).not.toHaveBeenCalled();
  mocks.authenticate.mockResolvedValue({ actor: { id: "verified-user" }, authority });
  expect((await POST(post("{not json"), scope())).status).toBe(422);
  expect((await POST(new Request("https://hs.example/api/record-client", { method: "POST", headers: { Origin: "https://hs.example" } }), scope())).status).toBe(422);
  expect((await POST(post("x".repeat(128_001)), scope())).status).toBe(413);
  expect(mocks.execute).not.toHaveBeenCalled();
  expect(mocks.constructed.every((args) => args.length === 3 && args[1] === authority)).toBe(true);
});
