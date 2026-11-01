import { beforeEach, expect, it, vi } from "vitest";
import { DocumentError } from "./document";
import { SNIPPET_HIDDEN_MESSAGE } from "./snippet-copy";

const mocks = vi.hoisted(() => ({ insert: vi.fn(), picker: vi.fn(), usage: vi.fn(), approve: vi.fn() }));
vi.mock("./repository", () => ({ repository: async () => ({}) }));
vi.mock("./snippets", async () => {
  const actual = await vi.importActual<typeof import("./snippets")>("./snippets");
  return { ...actual, insertSnippetPlacement: mocks.insert, listSnippetPicker: mocks.picker, snippetUsageReport: mocks.usage, approveSnippetVersion: mocks.approve };
});
import { GET as getPlacements, POST as postPlacement } from "../app/api/v1/pages/[id]/snippets/route";
import { POST as postSnippet } from "../app/api/v1/workspaces/[id]/snippets/[snippetId]/route";
import { GET as getUsage } from "../app/api/v1/workspaces/[id]/snippets/[snippetId]/usage/route";

const snippetId = "00000000-0000-4000-8000-000000000065";
const operationId = "00000000-0000-4000-8000-000000000066";
const pageContext = () => ({ params: Promise.resolve({ id: "page-1" }) });
const snippetContext = () => ({ params: Promise.resolve({ id: "ws-aplyd", snippetId }) });
const post = (url: string, body: unknown, origin = "http://localhost") => new Request(url, { method: "POST", headers: { origin, "content-type": "application/json" }, body: JSON.stringify(body) });

beforeEach(() => { vi.clearAllMocks(); });

it("serves the insert picker without caching", async () => {
  mocks.picker.mockResolvedValue({ snippets: [] });
  const response = await getPlacements(new Request("http://localhost/api/v1/pages/page-1/snippets?picker=1"), pageContext());
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(await response.json()).toEqual({ snippets: [] });
});

it("rejects a cross-origin insert before the snippet service runs", async () => {
  const response = await postPlacement(post("http://localhost/api/v1/pages/page-1/snippets", { action: "insert", operationId, snippetId, pinVersion: null }, "https://attacker.example"), pageContext());
  expect(response.status).toBe(403);
  expect(mocks.insert).not.toHaveBeenCalled();
});

it("returns one generic not-found shape for a denied insert", async () => {
  mocks.insert.mockRejectedValue(new DocumentError(SNIPPET_HIDDEN_MESSAGE, "not_found", 404));
  const response = await postPlacement(post("http://localhost/api/v1/pages/page-1/snippets", { action: "insert", operationId, snippetId, pinVersion: null }), pageContext());
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: SNIPPET_HIDDEN_MESSAGE, code: "not_found", retryable: false });
});

it("does not echo an approval note when approval is rejected", async () => {
  mocks.approve.mockRejectedValue(new DocumentError(SNIPPET_HIDDEN_MESSAGE, "not_found", 404));
  const response = await postSnippet(post("http://localhost/api/v1/workspaces/ws-aplyd/snippets/id", { action: "approve", operationId, versionNumber: 2, note: "SECRET_APPROVAL_NOTE" }), snippetContext());
  expect(response.status).toBe(404);
  expect(JSON.stringify(await response.json())).not.toContain("SECRET_APPROVAL_NOTE");
  expect(mocks.approve).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: "00000000-0000-4000-8000-000000000001" }), "ws-aplyd", snippetId, expect.objectContaining({ note: "SECRET_APPROVAL_NOTE", versionNumber: 2 }));
});

it("exports usage csv without a content column", async () => {
  mocks.usage.mockResolvedValue({ snippetId, placements: [{ pageId: "p-100", pageTitle: "P-100", pageOwnerId: "owner", pageOwnerName: "Ada", versionMode: "pinned", versionNumber: 1 }] });
  const response = await getUsage(new Request(`http://localhost/api/v1/workspaces/ws-aplyd/snippets/${snippetId}/usage?format=csv`), snippetContext());
  expect(response.headers.get("content-type")).toContain("text/csv");
  const csv = await response.text();
  expect(csv).toContain("page_id,page_title,page_owner_id,page_owner_name,version_mode,version_number");
  expect(csv).toContain("P-100");
  expect(csv).not.toContain("content");
});
