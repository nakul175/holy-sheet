// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import PageFollow from "../components/page-follow";

const fetchMock = vi.fn();
afterEach(() => { vi.unstubAllGlobals(); document.body.replaceChildren(); });

function response(body: unknown, status = 200) {
  return Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
}

async function render() {
  vi.stubGlobal("fetch", fetchMock);
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => { root.render(createElement(PageFollow, { pageId: "page-1" })); });
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove(); } };
}

it("shows Following after a page follow and lists settings without a hidden title", async () => {
  let following = false;
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (String(url).endsWith("/follow") && init?.method === "POST") {
      following = true;
      return response({ following: true, includeChildren: false, frequency: "daily" });
    }
    if (String(url).endsWith("/follow")) return response({ following, includeChildren: false, frequency: following ? "daily" : null });
    return response({ timezone: "Asia/Kolkata", follows: [{ pageId: "page-1", title: "Visible handbook", unavailable: false, includeChildren: false, frequency: "daily" }, { pageId: "hidden", title: null, unavailable: true, includeChildren: false, frequency: "daily" }] });
  });
  const view = await render();
  try {
    await act(async () => { await Promise.resolve(); });
    expect(view.host.textContent).toContain("Follow");
    const followPage = [...view.host.querySelectorAll("button")].find(button => button.textContent === "Follow this page");
    await act(async () => { followPage!.click(); });
    expect(view.host.querySelector("summary")?.textContent).toBe("Following");
    expect(view.host.querySelector("summary")?.getAttribute("aria-pressed")).toBe("true");
    const settings = [...view.host.querySelectorAll("button")].find(button => button.textContent === "Pages you follow");
    await act(async () => { settings!.click(); });
    expect(view.host.textContent).toContain("Visible handbook");
    expect(view.host.textContent).toContain("A page you follow is unavailable");
    expect(view.host.textContent).not.toContain("SECRET");
  } finally { await view.unmount(); }
});
