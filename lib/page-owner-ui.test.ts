// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import PageHandover from "../components/page-handover";
import PageOwner from "../components/page-owner";

const fetchMock = vi.fn();
afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });

function response(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
}

async function render(node: ReturnType<typeof createElement>) {
  vi.stubGlobal("fetch", fetchMock);
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => { root.render(node); });
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove(); } };
}

it("shows an owner chip and changes the owner without rendering page content", async () => {
  fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
    if (init?.method === "POST") return response({ owner: { id: "own", name: "U-OWN", avatar: "U" }, canChange: true, canHandover: false, candidates: [], atIst: "02 Nov 2026, 12:00 IST" });
    return response({ owner: { id: "ed", name: "U-ED", avatar: "U" }, canChange: true, canHandover: true, candidates: [{ id: "own", name: "U-OWN", avatar: "U" }], secretBody: "SECRET_BODY_SENTENCE" });
  });
  const view = await render(createElement(PageOwner, { pageId: "page-1", workspaceId: "ws one" }));
  try {
    await act(async () => { await Promise.resolve(); });
    expect(view.host.querySelector("[aria-label='Owner U-ED']")?.textContent).toContain("Owner U-ED");
    expect(view.host.querySelector(".page-owner-avatar")?.textContent).toBe("U");
    expect(view.host.textContent).not.toContain("SECRET_BODY_SENTENCE");
    await act(async () => { [...view.host.querySelectorAll("button")].find(button => button.textContent === "Change owner")!.click(); });
    await act(async () => { view.host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    const post = fetchMock.mock.calls.find(call => call[1]?.method === "POST")!;
    expect(JSON.parse(String(post[1].body))).toMatchObject({ ownerId: "own" });
    expect(view.host.textContent).toContain("Owner U-OWN");
    expect(view.host.textContent).toContain("02 Nov 2026, 12:00 IST");
  } finally { await view.unmount(); }
});

it("shows an ownerless state when the owner payload is missing", async () => {
  fetchMock.mockImplementation(async () => response({ pages: [], spaces: [] }));
  const view = await render(createElement(PageOwner, { pageId: "page-1", workspaceId: "ws one" }));
  try {
    await act(async () => { await Promise.resolve(); });
    expect(view.host.querySelector("[aria-label='No active owner']")?.textContent).toBe("No active owner");
    expect(view.host.textContent).not.toContain("Change owner");
  } finally { await view.unmount(); }
});

it("flags pages the recipient cannot edit and keeps trash separate", async () => {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const href = String(url);
    if (href.endsWith("/members")) return response({ canManage: true, members: [{ id: "ed", name: "U-ED", role: "member", active: true }, { id: "own", name: "U-OWN", role: "member", active: true }] });
    if (href.endsWith("/ownerless-pages") && !init?.method) return response({ pages: [{ pageId: "orphan", title: "Orphan one" }], trashed: [] });
    if (init?.method === "POST") return response({ from: { id: "ed", name: "U-ED" }, to: { id: "own", name: "U-OWN" }, pages: [{ pageId: "ready", title: "Ready page", trashed: false, recipientCanEdit: true }, { pageId: "blocked", title: "Blocked page", trashed: false, recipientCanEdit: false }], trashed: [{ pageId: "trash", title: "Trashed handover", trashed: true, recipientCanEdit: false }] });
    return response({});
  });
  const view = await render(createElement(PageHandover, { workspaceId: "ws one" }));
  try {
    await act(async () => { await Promise.resolve(); });
    expect(view.host.textContent).toContain("Pages without an active owner");
    expect(view.host.textContent).toContain("Orphan one");
    await act(async () => { view.host.querySelector("form")!.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); });
    expect(view.host.querySelector("[aria-label='Access for Blocked page']")).toBeTruthy();
    expect(view.host.textContent).toContain("Trashed handover");
    expect(view.host.textContent).toContain("Include trash");
    expect(view.host.textContent).not.toContain("SECRET_BODY_SENTENCE");
  } finally { await view.unmount(); }
});
