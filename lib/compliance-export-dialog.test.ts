// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ request: vi.fn(), fetch: vi.fn() }));
vi.mock("../components/editor/use-document-session", async () => ({ ...await vi.importActual("../components/editor/use-document-session"), requestJson: mocks.request }));
vi.mock("../components/editor/rich-editor", () => ({ Dialog: ({ children, title }: { children: ReactNode; title: string }) => createElement("div", { role: "dialog", "aria-label": title }, children) }));
import ComplianceExportDialog from "../components/compliance-export-dialog";

const policy = { spaceId: "space-product", attachments: true, version: 1, manage: true };
const history = { jobs: [{ id: "old", scope: "page", format: "pdf", state: "ready", progress: 100, etaSeconds: 0, counts: { pages: 1, records: 0, restrictedRecords: 0, attachments: 0, acknowledgements: 0, auditRows: 0 }, notes: [], manifestHash: null, expiresAt: null, downloadToken: null, atIst: "02 Nov 2026, 12:00 IST" }] };
const job = { id: "job", scope: "space", format: "compliance-pack", state: "ready", progress: 100, etaSeconds: 0, counts: history.jobs[0].counts, notes: [], manifestHash: "ab", expiresAt: "2026-11-03T00:00:00.000Z", downloadToken: "token-token-token-token", atIst: "02 Nov 2026, 12:00 IST" };
let cleanup: () => Promise<void>;

beforeEach(() => {
  mocks.request.mockImplementation(async (url: string) => {
    if (String(url).includes("/policy")) return policy;
    if (String(url).includes("/compliance-exports")) return history;
    return history;
  });
  mocks.fetch.mockResolvedValue(new Response("PK", { headers: { "content-type": "application/zip" } }));
  vi.stubGlobal("fetch", mocks.fetch);
  vi.spyOn(URL, "createObjectURL").mockReturnValue("blob:pack");
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => undefined);
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => undefined);
});
afterEach(async () => { await cleanup?.(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

async function mount() {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(ComplianceExportDialog, { workspaceId: "ws-a", spaceId: "space-product", pageId: "page-1", onClose: () => undefined })));
  cleanup = async () => { await act(async () => root.unmount()); host.remove(); };
  const button = (text: string) => Array.from(host.querySelectorAll("button")).find(item => item.textContent === text)!;
  return { host, button };
}

it("lets an administrator choose space scope and the compliance pack format", async () => {
  mocks.request.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") return job;
    if (String(url).includes("/policy")) return policy;
    return history;
  });
  const view = await mount();
  expect(view.host.textContent).toContain("does not include pack contents");
  expect(view.host.textContent).toContain("Recent exports");
  const selects = view.host.querySelectorAll("select");
  await act(async () => { selects[0].value = "space"; selects[0].dispatchEvent(new Event("change", { bubbles: true })); selects[1].value = "compliance-pack"; selects[1].dispatchEvent(new Event("change", { bubbles: true })); });
  await act(async () => view.button("Start export").click());
  const body = JSON.parse(mocks.request.mock.calls.find(call => call[1]?.method === "POST")![1].body);
  expect(body).toMatchObject({ scope: "space", format: "compliance-pack", targetId: "space-product", includeDraft: false, includeTrash: false, allAttachmentVersions: false });
  expect(view.host.textContent).toContain("Progress 100%");
  expect(view.host.textContent).toContain("about 0 seconds");
  await act(async () => view.button("Download pack").click());
  expect(JSON.parse(mocks.fetch.mock.calls[0][1].body)).toEqual({ token: job.downloadToken });
});

it("uses the same unavailable wording when the export cannot be started", async () => {
  const { ApiError } = await import("../components/editor/use-document-session");
  mocks.request.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") throw new ApiError("Export unavailable", 404, "not_found");
    if (String(url).includes("/policy")) return { ...policy, manage: false };
    return { jobs: [] };
  });
  const view = await mount();
  expect(view.host.textContent).toContain("Only a workspace administrator can change export policy.");
  await act(async () => view.button("Start export").click());
  expect(view.host.textContent).toContain("Export unavailable");
});
