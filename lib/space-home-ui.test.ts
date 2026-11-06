// @vitest-environment jsdom
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import SpaceHome, { SpaceHomePins } from "../components/space-home";
import { SPACE_HOME_LOAD_FAILED, SPACE_HOME_PAGE_UNAVAILABLE, SPACE_HOME_REFRESH_MS, SPACE_HOME_UNAVAILABLE, type SpaceHomePinView, type SpaceHomeView } from "../lib/space-home-shared";

const fetchMock = vi.fn();
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  document.body.innerHTML = "";
});

async function render(node: ReturnType<typeof createElement>) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div");
  document.body.append(host);
  const root: Root = createRoot(host);
  await act(async () => root.render(node));
  return { host, rerender: async (next: ReturnType<typeof createElement>) => { await act(async () => root.render(next)); }, unmount: async () => { await act(async () => root.unmount()); host.remove(); } };
}

function pins(ids: string[]): SpaceHomePinView[] {
  return ids.map(id => ({ pageId: id, title: `Page ${id}`, summary: `${id} summary`, icon: "document", updatedAtIst: "01 Nov 2026, 10:00 IST" }));
}

it("reorders pinned pages from the keyboard and from a drag", async () => {
  const reorder = vi.fn();
  const view = await render(createElement(SpaceHomePins, { pins: pins(["a", "b", "c"]), canManage: true, busy: false, onReorder: reorder, onUnpin: vi.fn(), onSetHome: vi.fn() }));
  const first = view.host.querySelector("[data-page-id='a']") as HTMLElement;
  first.focus();
  await act(async () => { first.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); });
  expect(reorder).toHaveBeenCalledWith(["b", "a", "c"]);
  const third = view.host.querySelector("[data-page-id='c']") as HTMLElement;
  await act(async () => {
    first.dispatchEvent(new Event("dragstart", { bubbles: true }));
    third.dispatchEvent(new Event("drop", { bubbles: true }));
  });
  expect(reorder).toHaveBeenLastCalledWith(["b", "c", "a"]);
  expect(view.host.querySelector("button[aria-label='Move Page a down']")).toBeTruthy();
  await view.unmount();
  reorder.mockClear();
  const locked = await render(createElement(SpaceHomePins, { pins: pins(["a", "b"]), canManage: false, busy: false, onReorder: reorder, onUnpin: vi.fn(), onSetHome: vi.fn() }));
  const item = locked.host.querySelector("[data-page-id='a']") as HTMLElement;
  await act(async () => { item.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })); });
  expect(reorder).not.toHaveBeenCalled();
  await locked.unmount();
});

it("clears the landing after access is revoked on the next refresh", async () => {
  vi.stubGlobal("fetch", fetchMock);
  const payload: SpaceHomeView = {
    workspaceId: "ws-a",
    spaceId: "sp-ops",
    spaceName: "Ops home",
    canManage: false,
    archived: false,
    archivedAtIst: null,
    canUnarchive: false,
    home: null,
    widgets: {
      pinned: pins(["pin-1"]),
      recent: [{ pageId: "recent-1", title: "Recent page", editorName: "U-ED", updatedAtIst: "01 Nov 2026, 10:05 IST" }],
      recordViews: [],
      owners: [{ userId: "owner-1", name: "U-OWN", role: "leader" }],
    },
    pinCandidates: [],
  };
  let calls = 0;
  fetchMock.mockImplementation(async () => {
    calls += 1;
    if (calls === 1) return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
    return new Response(JSON.stringify({ error: SPACE_HOME_UNAVAILABLE, code: "not_found" }), { status: 404, headers: { "Content-Type": "application/json" } });
  });
  vi.useFakeTimers();
  const view = await render(createElement(SpaceHome, { workspaceId: "ws-a", spaceId: "sp-ops" }));
  await act(async () => { await Promise.resolve(); });
  expect(view.host.textContent).toContain("Ops home");
  expect(view.host.querySelector(".space-home-widgets")).toBeTruthy();
  expect(view.host.textContent).toContain("Shared knowledge, working notes, and decisions");
  expect(view.host.textContent).not.toContain(SPACE_HOME_PAGE_UNAVAILABLE);
  await act(async () => { await vi.advanceTimersByTimeAsync(SPACE_HOME_REFRESH_MS); });
  expect(view.host.textContent).not.toContain("Ops home");
  expect(view.host.textContent).not.toContain("P-100");
  expect(view.host.textContent).not.toContain("Recent page");
  expect(view.host.textContent).toContain(SPACE_HOME_UNAVAILABLE);
  expect(view.host.querySelector(".space-home-widgets")).toBeNull();
  await view.unmount();
});

it("shows a neutral load, then a readable empty overview with one-write manager actions", async () => {
  vi.stubGlobal("fetch", fetchMock);
  let finish: (response: Response) => void = () => undefined;
  fetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
  const payload: SpaceHomeView = {
    workspaceId: "ws-a",
    spaceId: "sp-ops",
    spaceName: "Ops home",
    canManage: true,
    archived: false,
    archivedAtIst: null,
    canUnarchive: false,
    home: null,
    widgets: { pinned: [], recent: [], recordViews: [], owners: [] },
    pinCandidates: [{ pageId: "page-1", title: "Operating guide" }],
  };
  const view = await render(createElement(SpaceHome, { workspaceId: "ws-a", spaceId: "sp-ops" }));
  expect(view.host.textContent).toContain("Opening space home…");
  expect(view.host.textContent).not.toContain(SPACE_HOME_PAGE_UNAVAILABLE);
  await act(async () => finish(new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } })));
  expect(view.host.textContent).toContain("No overview page has been set for this space.");
  expect(view.host.querySelector("main a[href='/workspaces']")?.textContent).toBe("Create a page");
  const submit = Array.from(view.host.querySelectorAll("button")).find(button => button.textContent === "Set as overview")!;
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ ...payload, home: { pageId: "page-1", title: "Operating guide", summary: "", headings: [], templateName: null, role: "owner", updatedAtIst: "04 Nov 2026, 12:00 IST" } }), { status: 200, headers: { "Content-Type": "application/json" } }));
  await act(async () => submit.click());
  const writes = fetchMock.mock.calls.filter(call => call[1]?.method === "POST");
  expect(writes).toHaveLength(1);
  expect(JSON.parse(String(writes[0][1]?.body))).toMatchObject({ action: "set-home", pageId: "page-1" });
  expect(view.host.textContent).toContain("Open Operating guide");
  await view.unmount();
});

it("does not offer overview mutations to a readable non-manager", async () => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
    workspaceId: "ws-a", spaceId: "sp-ops", spaceName: "Ops home", canManage: false,
    archived: false, archivedAtIst: null, canUnarchive: false, home: null,
    widgets: { pinned: [], recent: [], recordViews: [], owners: [] }, pinCandidates: [],
  } satisfies SpaceHomeView), { status: 200, headers: { "Content-Type": "application/json" } }));
  const view = await render(createElement(SpaceHome, { workspaceId: "ws-a", spaceId: "sp-ops" }));
  await act(async () => { await Promise.resolve(); });
  expect(view.host.textContent).toContain("Ask a space leader to create or choose an overview page.");
  expect(view.host.textContent).not.toContain("Set as overview");
  expect(view.host.querySelector("main a[href='/workspaces']")).toBeNull();
  expect(fetchMock.mock.calls.filter(call => call[1]?.method === "POST")).toHaveLength(0);
  await view.unmount();
});

it("shows a true permission denial without rendering readable space content", async () => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ error: "You do not have access to this space", code: "not_allowed" }), { status: 403, headers: { "Content-Type": "application/json" } }));
  const view = await render(createElement(SpaceHome, { workspaceId: "ws-a", spaceId: "sp-ops" }));
  await act(async () => { await Promise.resolve(); });
  expect(view.host.querySelector("[role='alert']")?.textContent).toBe("You do not have access to this space");
  expect(view.host.textContent).not.toContain("No overview page has been set");
  expect(view.host.querySelector(".space-home-widgets")).toBeNull();
  await view.unmount();
});

it("reports transport failures neutrally instead of calling the space restricted", async () => {
  vi.stubGlobal("fetch", fetchMock);
  fetchMock.mockRejectedValueOnce(new TypeError("network failed"));
  const view = await render(createElement(SpaceHome, { workspaceId: "ws-a", spaceId: "sp-ops" }));
  await act(async () => { await Promise.resolve(); });
  expect(view.host.querySelector("[role='alert']")?.textContent).toBe(SPACE_HOME_LOAD_FAILED);
  expect(view.host.textContent).not.toContain(SPACE_HOME_UNAVAILABLE);
  expect(view.host.querySelector(".space-home-widgets")).toBeNull();
  await view.unmount();
});

it("hides the prior space immediately while a route switch is loading", async () => {
  vi.stubGlobal("fetch", fetchMock);
  let finishNext: (response: Response) => void = () => undefined;
  const first: SpaceHomeView = {
    workspaceId: "ws-a", spaceId: "sp-one", spaceName: "First space", canManage: false,
    archived: false, archivedAtIst: null, canUnarchive: false, home: null,
    widgets: { pinned: [], recent: [], recordViews: [], owners: [] }, pinCandidates: [],
  };
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(first), { status: 200, headers: { "Content-Type": "application/json" } }));
  const view = await render(createElement(SpaceHome, { workspaceId: "ws-a", spaceId: "sp-one" }));
  await act(async () => { await Promise.resolve(); });
  expect(view.host.textContent).toContain("First space");
  fetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { finishNext = resolve; }));
  await view.rerender(createElement(SpaceHome, { workspaceId: "ws-a", spaceId: "sp-two" }));
  expect(view.host.textContent).not.toContain("First space");
  expect(view.host.textContent).toContain("Opening space home…");
  const second = { ...first, spaceId: "sp-two", spaceName: "Second space" };
  await act(async () => finishNext(new Response(JSON.stringify(second), { status: 200, headers: { "Content-Type": "application/json" } })));
  expect(view.host.textContent).toContain("Second space");
  await view.unmount();
});
