// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../components/editor/use-document-session", async () => ({ ...await vi.importActual("../components/editor/use-document-session"), requestJson: mocks.request }));
vi.mock("../components/editor/rich-editor", () => ({ Dialog: ({ children, title, onClose }: { children: ReactNode; title: string; onClose: () => void }) => createElement("div", { role: "dialog", "aria-label": title }, createElement("button", { type: "button", onClick: onClose, style: { minHeight: 44, minWidth: 44 } }, "Close dialog"), children) }));
import GuestPortalDialog from "../components/guest-portal-dialog";

const portal = { id: "portal-1", name: "Clinic portal", status: "preview", version: 2, sharing: "off", admitted: false };
let cleanup: () => Promise<void>;
const posts: unknown[] = [];

beforeEach(() => {
  posts.length = 0;
  mocks.request.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts.push(JSON.parse(String(init.body)));
      return { audience: "admin-preview", sharing: "off", accessGranted: false, cacheGeneration: 3, body: "# Portal\nSharing: off.", screens: [{ name: "Clinic" }], records: [] };
    }
    if (String(url).includes("view=search")) return { results: [{ id: "portal-1", name: "Clinic portal", status: "preview", version: 2, sharing: "off", admitted: false }] };
    if (String(url).includes("view=history")) return { events: [{ action: "preview", source: "guest-portal", atIst: "03 Nov 2026, 09:00 IST" }] };
    return {
      manage: true,
      boundary: "A guest portal shows only the screens, records, fields, and actions an administrator configures.",
      assignment: "Configuring a portal, linking a suite identity, or naming a manager does not grant access.",
      authority: "Guest access needs an explicit current grant and eligible suite authentication.",
      activation: "Sharing stays off until a separate explicit activation path.",
      schedules: "Existing schedules stay paused.",
      recoverable: "A recoverable draft is kept when the version changes.",
      edge: "Guest responses stay with the tenant and use cache no-store.",
      sharing: "off",
      accessGranted: false,
      invitationSent: false,
      portals: [portal],
      drafts: [{ portalKey: "portal-1", kind: "configure" }],
    };
  });
});
afterEach(async () => { await cleanup?.(); vi.restoreAllMocks(); });

async function mount(onClose = () => undefined) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(GuestPortalDialog, { workspaceId: "ws-aplyd", onClose })));
  await act(async () => { await Promise.resolve(); });
  cleanup = async () => { await act(async () => root.unmount()); host.remove(); };
  const button = (text: string) => Array.from(host.querySelectorAll("button")).find(item => item.textContent === text)!;
  const input = (label: string) => host.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
  const select = (label: string) => host.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!;
  const setValue = (element: HTMLInputElement | HTMLSelectElement, value: string) => {
    const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  };
  return { host, button, input, select, setValue };
}

it("keeps portal actions on the keyboard and at least 44px, off the export row", async () => {
  const view = await mount();
  expect(view.host.textContent).toContain("does not grant access");
  expect(view.host.textContent).toContain("explicit current grant");
  expect(view.host.textContent).toContain("Sharing stays off");
  expect(view.host.textContent).toContain("Existing schedules stay paused");
  expect(view.host.textContent).toContain("A recoverable draft is kept");
  expect(view.host.textContent).toContain("cache no-store");
  for (const button of view.host.querySelectorAll("button")) {
    expect(button.getAttribute("type")).toBe("button");
    const height = button.style.minHeight;
    expect(height === "" || height === "44px").toBe(true);
    if (height === "44px") expect(button.style.minWidth === "44px" || button.style.minWidth === "").toBe(true);
  }
  expect(view.host.querySelectorAll("button").length).toBeGreaterThan(3);
  await act(async () => { view.setValue(view.input("Portal name"), "Clinic portal"); view.setValue(view.input("Portal record"), "00000000-0000-4000-8000-00000000f101"); });
  await act(async () => { view.button("Review portal").click(); });
  expect(posts).toEqual([]);
  await act(async () => { view.button("Confirm portal").click(); });
  expect(posts[0]).toMatchObject({ action: "configure", name: "Clinic portal" });
  expect(JSON.stringify(posts[0])).toContain("\"guestPreview\":true");
  expect(JSON.stringify(posts[0])).toContain("\"public\":false");
  await act(async () => { view.setValue(view.select("Saved portal"), "portal-1"); });
  await act(async () => { view.button("Guest preview").click(); });
  expect(posts.at(-1)).toMatchObject({ action: "preview", portalId: "portal-1" });
  await act(async () => { view.button("Pause portal").click(); });
  expect(posts.at(-1)).toMatchObject({ action: "preview" });
  await act(async () => { view.button("Confirm pause").click(); });
  expect(posts.at(-1)).toMatchObject({ action: "pause" });
  await act(async () => { view.setValue(view.input("Portal search"), "Clinic"); });
  await act(async () => { view.button("Search portals").click(); });
  expect(view.host.textContent).toContain("Clinic portal");
  await act(async () => { view.button("Portal history").click(); });
  expect(view.host.textContent).toContain("guest-portal");
  const app = readFileSync("components/holy-sheet-app.tsx", "utf8");
  const start = app.indexOf('className="page-io-actions"');
  const io = app.slice(start, app.indexOf("</div>", start));
  expect(io).toContain("Export page");
  expect(io).not.toContain("Guest portals");
  expect(app).toContain(">Guest portals</button>");
  const css = readFileSync("app/workspace.css", "utf8");
  expect(css).toContain(".guest-portal-dialog .actions { display:flex; flex-wrap:wrap;");
  expect(css).toContain(".guest-portal-dialog label { display:flex; align-items:center; gap:.5rem; min-height:44px; }");
  expect(css).toContain("@media (max-width:360px)");
});

it("leaves a portal unchanged when cancel is chosen before confirm", async () => {
  const closed = vi.fn();
  const view = await mount(closed);
  await act(async () => { view.button("Review portal").click(); });
  expect(posts).toEqual([]);
  await act(async () => { view.button("Cancel").click(); });
  expect(closed).toHaveBeenCalledOnce();
  expect(posts).toEqual([]);
});
