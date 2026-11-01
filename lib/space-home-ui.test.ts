// @vitest-environment jsdom
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import SpaceHome, { SpaceHomePins } from "../components/space-home";
import { SPACE_HOME_REFRESH_MS, SPACE_HOME_UNAVAILABLE, type SpaceHomePinView, type SpaceHomeView } from "../lib/space-home-shared";

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
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove(); } };
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
    home: { pageId: "p-100", title: "P-100", summary: "Overview", headings: ["Start here"], templateName: "Space home", role: "viewer", updatedAtIst: "01 Nov 2026, 10:00 IST" },
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
  expect(view.host.textContent).toContain("P-100");
  expect(view.host.querySelector(".space-home-widgets")).toBeTruthy();
  await act(async () => { await vi.advanceTimersByTimeAsync(SPACE_HOME_REFRESH_MS); });
  expect(view.host.textContent).not.toContain("Ops home");
  expect(view.host.textContent).not.toContain("P-100");
  expect(view.host.textContent).not.toContain("Recent page");
  expect(view.host.textContent).toContain(SPACE_HOME_UNAVAILABLE);
  expect(view.host.querySelector(".space-home-widgets")).toBeNull();
  await view.unmount();
});
