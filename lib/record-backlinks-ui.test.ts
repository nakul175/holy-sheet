/** @vitest-environment jsdom */
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { RECORD_BACKLINK_POLL_MS } from "./record-backlinks";
import RecordBacklinks from "../components/record-backlinks";

const recordId = "00000000-0000-4000-8000-0000000000aa";
const pageId = "page-chip";
const blockId = "block-chip";
const list = {
  heading: "Mentioned in 3 pages you can see",
  count: 3,
  nextCursor: "cursor-1",
  spaces: [{ id: "space-ops", name: "SP-OPS" }],
  canIncludeTrash: false,
  sort: "edited",
  order: "desc",
  spaceId: null,
  items: [{
    pageId,
    title: "Chip page",
    spaceId: "space-ops",
    spaceName: "SP-OPS",
    breadcrumb: "SP-OPS / Client notes",
    referenceType: "chip",
    referenceTypes: ["chip"],
    referenceLabel: "Chip",
    icon: "▣",
    snippet: "Renewal context for the client policy pack.",
    editedAt: "2026-10-31T12:00:00.000Z",
    editedAtIst: "31 Oct 2026, 17:30 IST",
    blockId,
    href: `/pages/${pageId}#block-${blockId}`,
    trashLabel: null,
  }],
};

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

function media(matches: boolean) {
  Object.defineProperty(window, "matchMedia", { configurable: true, value: (query: string) => ({ matches: query.includes("max-width") ? matches : false, media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent() { return false; }, onchange: null }) });
}

async function mount(onNavigate = vi.fn()) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => { root.render(createElement(RecordBacklinks, { workspaceId: "ws", tenantId: "00000000-0000-4000-8000-000000000002", recordId, onNavigate })); });
  await act(async () => { await Promise.resolve(); });
  return { host, onNavigate, dispose: async () => { await act(async () => root.unmount()); host.remove(); } };
}

it("renders a labelled list, snippet and mobile sheet, and refreshes within five seconds", async () => {
  media(true);
  vi.useFakeTimers();
  const fetchMock = vi.fn(async (url: string) => new Response(JSON.stringify(String(url).includes("section=views") ? { section: "views", heading: "Appears in view blocks", items: [{ pageId: "page-view", title: "Renewals page", spaceName: "SP-OPS", viewName: "Renewals this quarter", blockId: "view-1", href: "/pages/page-view#block-view-1" }], limit: 20 } : list), { status: 200, headers: { "Content-Type": "application/json" } }));
  vi.stubGlobal("fetch", fetchMock);
  const view = await mount();
  try {
    await act(async () => { [...view.host.querySelectorAll("button")].find(button => button.textContent === "Mentioned in pages")!.click(); });
    await act(async () => { await Promise.resolve(); });
    const region = view.host.querySelector("section[data-record-backlinks]");
    expect(region?.getAttribute("aria-labelledby")).toBeTruthy();
    expect(region?.getAttribute("data-layout")).toBe("sheet");
    expect(view.host.querySelector("ul")).toBeTruthy();
    expect(view.host.textContent).toContain("Mentioned in 3 pages you can see");
    expect(view.host.textContent).toContain("Chip");
    expect(view.host.textContent).toContain("Renewal context for the client policy pack.");
    expect(view.host.textContent).toContain("31 Oct 2026, 17:30 IST");
    const link = view.host.querySelector("a");
    expect(link?.getAttribute("href")).toContain(`#block-${blockId}`);
    expect(link?.tabIndex).toBe(0);
    const css = readFileSync("components/record-backlinks.module.css", "utf8");
    expect(css).toContain("@media (max-width: 480px)");
    expect(css).toContain("position: fixed");
    expect(css).toContain("bottom: 0");
    expect(RECORD_BACKLINK_POLL_MS).toBeLessThan(5000);
    const calls = fetchMock.mock.calls.length;
    await act(async () => { await vi.advanceTimersByTimeAsync(RECORD_BACKLINK_POLL_MS); });
    expect(fetchMock.mock.calls.length).toBeGreaterThan(calls);
    await act(async () => { view.host.querySelector("button")!.click(); });
    const viewsButton = [...view.host.querySelectorAll("button")].find(button => button.textContent === "Appears in view blocks");
    await act(async () => { viewsButton!.click(); });
    expect(view.host.textContent).toContain("Renewals this quarter");
  } finally { await view.dispose(); }
});

it("shows not found when a stale mention is opened", async () => {
  media(false);
  const fetchMock = vi.fn(async (url: string) => {
    if (String(url).includes("open=")) return new Response(JSON.stringify({ error: "Page is restricted or unavailable.", code: "not_found" }), { status: 404, headers: { "Content-Type": "application/json" } });
    return new Response(JSON.stringify(list), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  vi.stubGlobal("fetch", fetchMock);
  const view = await mount();
  try {
    await act(async () => { [...view.host.querySelectorAll("button")].find(button => button.textContent === "Mentioned in pages")!.click(); });
    await act(async () => { await Promise.resolve(); });
    expect(view.host.querySelector("section")?.getAttribute("data-layout")).toBe("panel");
    await act(async () => { view.host.querySelector("a")!.click(); });
    expect(view.host.textContent).toContain("Page is restricted or unavailable.");
    expect(view.onNavigate).not.toHaveBeenCalled();
  } finally { await view.dispose(); }
});
