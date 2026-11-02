/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ApiError } from "../components/editor/use-document-session";
import { SEARCH_JUMP_UNAVAILABLE, SEARCH_LINK_COPIED, SEARCH_SHORTCUT_HINT } from "./search-jump-model";

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../components/editor/use-document-session", async () => {
  const actual = await vi.importActual<typeof import("../components/editor/use-document-session")>("../components/editor/use-document-session");
  return { ...actual, requestJson: mocks.request };
});
import SearchDialog from "../components/search-dialog";

afterEach(() => { vi.clearAllMocks(); vi.useRealTimers(); document.body.innerHTML = ""; });

const recordId = "00000000-0000-4000-8000-000000000010";
const page = { id: "page-100", kind: "page" as const, title: "Client runbook", preview: "Setup", path: ["Product"], updatedAt: "2026-11-01T00:00:00Z", match: "title" as const, spaceId: "space-product", href: "/pages/page-100" };
const record = { id: `record:${recordId}`, kind: "record" as const, title: "Acme Hospital", preview: "Acme", path: ["Organisations"], updatedAt: "2026-11-01T00:00:00Z", match: "title" as const, spaceId: "", href: `/workspaces/w/tenants/t/records?collection=organisations&record=${recordId}`, collection: "organisations" };

async function mount(editing = true) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const open = vi.fn(), openTab = vi.fn(), jump = vi.fn(), created = vi.fn(), close = vi.fn();
  await act(async () => root.render(createElement(SearchDialog, { commandBar: true, editing, pageId: "page-edit", workspaceId: "w", workspaceName: "Acme", spaces: [{ id: "space-product", workspaceId: "w", name: "Product" }], onClose: close, onOpen: open, onOpenTab: openTab, onJump: jump, onCreated: created })));
  return { host, open, openTab, jump, created, close, dispose: async () => { await act(async () => root.unmount()); host.remove(); } };
}
async function typeQuery(host: HTMLElement, value: string) {
  await act(async () => {
    const input = host.querySelector<HTMLInputElement>('input[aria-label="Search titles and content"]')!;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => { await vi.advanceTimersByTimeAsync(170); });
}
function button(host: ParentNode, name: string) {
  return [...host.querySelectorAll("button")].find(item => item.textContent === name || item.getAttribute("aria-label") === name);
}

it("shows permitted actions, shortcut hints, and hides insert while viewing", async () => {
  mocks.request.mockImplementation(async (url: string) => {
    if (String(url).includes("search-actions")) return { recents: [], quickActions: [], headings: [{ pageId: "page-100", pageTitle: "Client runbook", blockId: "esc", level: 2, text: "Escalation", href: "/pages/page-100#block-esc" }], creates: [] };
    return { results: [page, record], nextCursor: null };
  });
  const view = await mount(true);
  try {
    await typeQuery(view.host, "acme");
    expect(view.host.textContent).toContain(SEARCH_SHORTCUT_HINT);
    const recordRow = view.host.querySelector<HTMLElement>('[role="option"][aria-selected="false"], [role="option"]')!;
    const rows = [...view.host.querySelectorAll<HTMLElement>('[role="option"]')];
    await act(async () => { button(rows[0], "Actions for Client runbook")!.click(); });
    expect(view.host.textContent).toContain("Insert as link");
    expect(view.host.textContent).toContain("Jump to section");
    expect(view.host.textContent).toContain("Jump to Escalation");
    await act(async () => { button(rows[1], "Actions for Acme Hospital")!.click(); });
    expect(view.host.textContent).toContain("Insert as inline chip");
    expect(view.host.textContent).toContain("Insert as card");
    expect(view.host.textContent).toContain("Open record in side peek");
    expect(view.host.textContent).not.toContain("Jump to section");
    void recordRow;
  } finally { await view.dispose(); }
  const viewer = await mount(false);
  try {
    mocks.request.mockImplementation(async (url: string) => String(url).includes("search-actions") ? { recents: [], quickActions: [], headings: [], creates: [] } : { results: [record], nextCursor: null });
    await typeQuery(viewer.host, "acme");
    await act(async () => { button(viewer.host, "Actions for Acme Hospital")!.click(); });
    expect(viewer.host.textContent).not.toContain("Insert as inline chip");
    expect(viewer.host.textContent).toContain("Copy link");
  } finally { await viewer.dispose(); }
});

it("runs keyboard shortcuts, copies a link, and removes a result when insertion is revoked", async () => {
  const write = vi.fn(async () => undefined);
  Object.assign(navigator, { clipboard: { writeText: write } });
  mocks.request.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST" && String(url).includes("/references")) throw new ApiError(SEARCH_JUMP_UNAVAILABLE, 404, "not_found");
    if (String(url).includes("search-actions")) return { recents: [], quickActions: [], headings: [], creates: [] };
    return { results: [record], nextCursor: null };
  });
  const view = await mount();
  try {
    await typeQuery(view.host, "acme");
    const option = view.host.querySelector<HTMLElement>('[role="option"]')!;
    await act(async () => { option.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    expect(view.open).toHaveBeenCalledWith(expect.objectContaining({ id: record.id }));
    await act(async () => { option.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", ctrlKey: true, bubbles: true })); });
    expect(view.openTab).toHaveBeenCalled();
    await act(async () => { option.dispatchEvent(new KeyboardEvent("keydown", { key: "c", ctrlKey: true, shiftKey: true, bubbles: true })); });
    expect(write).toHaveBeenCalledWith(expect.stringContaining(`/workspaces/w/tenants/t/records`));
    expect(view.host.textContent).toContain(SEARCH_LINK_COPIED);
    await act(async () => { option.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true })); });
    expect(view.host.textContent).toContain(SEARCH_JUMP_UNAVAILABLE);
    expect(view.host.querySelector('[role="option"]')).toBeNull();
    const body = JSON.parse(String(mocks.request.mock.calls.find(call => call[1]?.method === "POST")?.[1].body));
    expect(body.stage).toBe(true);
    expect(body.record_id).toBe(recordId);
  } finally { await view.dispose(); }
});

it("offers create-on-miss and recents without saying a hidden match exists", async () => {
  const creates = [{ kind: "page" as const, label: 'Create page "Vendor offboarding" in Product', spaceId: "space-product", title: "Vendor offboarding" }];
  mocks.request.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") return { href: "/pages/created", pageId: "created", title: "Vendor offboarding", replayed: false };
    if (String(url).includes("search-actions") && String(url).includes("q=")) return { recents: [], quickActions: [], headings: [], creates };
    if (String(url).includes("search-actions")) return { recents: [{ id: "recent-1", title: "Recent runbook", href: "/pages/recent-1", spaceName: "Product" }], quickActions: [{ id: "new", label: "New page", kind: "new-page", spaceId: "space-product" }, { id: "record", label: "New record", kind: "new-record", collection: "organisations" }, { id: "home", label: "Go to space home", kind: "space-home", href: "/workspaces/w/spaces/space-product", spaceId: "space-product" }], headings: [], creates: [] };
    return { results: [], nextCursor: null };
  });
  const view = await mount();
  try {
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(view.host.textContent).toContain("Recent runbook");
    expect(view.host.textContent).toContain("New page");
    expect(view.host.textContent).toContain("New record");
    expect(view.host.textContent).toContain("Go to space home");
    await typeQuery(view.host, "Vendor offboarding");
    expect(view.host.textContent).toContain('Create page "Vendor offboarding" in Product');
    expect(view.host.textContent?.toLowerCase()).not.toMatch(/hidden|already exists/);
    const create = button(view.host, 'Create page "Vendor offboarding" in Product')!;
    await act(async () => { create.click(); create.click(); });
    const posts = mocks.request.mock.calls.filter(call => call[1]?.method === "POST").map(call => JSON.parse(String(call[1].body)));
    expect(posts.length).toBeGreaterThan(0);
    expect(new Set(posts.map(item => item.operationId)).size).toBe(1);
    expect(view.created).toHaveBeenCalledWith("/pages/created");
  } finally { await view.dispose(); }
});
