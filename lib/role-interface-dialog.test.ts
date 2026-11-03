// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { vi } from "vitest";

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../components/editor/use-document-session", async () => ({ ...await vi.importActual("../components/editor/use-document-session"), requestJson: mocks.request }));
vi.mock("../components/editor/rich-editor", () => ({ Dialog: ({ children, title, onClose }: { children: ReactNode; title: string; onClose: () => void }) => createElement("div", { role: "dialog", "aria-label": title }, createElement("button", { type: "button", onClick: onClose, style: { minHeight: 44 } }, "Close dialog"), children) }));
import RoleInterfaceDialog from "../components/role-interface-dialog";

const definition = {
  navigation: [{ id: "home", label: "Clinic", screenId: "clinic" }],
  screens: [{ id: "clinic", name: "Clinic", components: [{ id: "edit", kind: "form", collection: "organisations", fields: [{ key: "core:notes", version: 1 }] }] }],
  roles: ["member"],
};
const item = {
  id: "iface-1", collection: "organisations", name: "Clinic desk", status: "preview", version: 2, sharing: "private", definition,
  screens: [{ id: "clinic", name: "Clinic", components: [{ id: "roster", kind: "list", status: "broken", reason: "deprecated-field" }, { id: "focus", kind: "detail", status: "ready", reason: null }] }],
  recoverableDraft: { baseVersion: 2, definition },
};
let cleanup: () => Promise<void>;
const posts: unknown[] = [];

beforeEach(() => {
  posts.length = 0;
  mocks.request.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts.push(JSON.parse(String(init.body)));
      return { replayed: false, previewId: "preview-1", action: "publish", version: 2, plan: null, sharing: "private", body: "# Interface\nClinic desk" };
    }
    if (String(url).includes("view=search")) return { results: [{ id: "iface-1", name: "Clinic desk", status: "preview", version: 2 }] };
    if (String(url).includes("view=history")) return { events: [{ action: "publish", actorName: "Ada", atIst: "03 Nov 2026, 09:00 IST", source: "role-interface", revision: 2 }], submissions: [] };
    return {
      manage: true,
      boundary: "Interfaces compose approved record lists, details, forms, charts, and buttons. They do not run scripts or open public links.",
      assignment: "Configuring or assigning an interface does not grant access to a page, record, collection, or field.",
      authority: "A role shown on an interface is presentation only. It does not grant collection browse.",
      review: "Review the impact.",
      schedules: "Existing schedules stay paused.",
      accounts: "Accounts still require an Organisation.",
      sharing: "Interfaces are private. They are not shared publicly.",
      interfaces: [item],
      collections: [{ id: "organisations", name: "Organisations" }],
      fields: [{ collection: "organisations", key: "core:notes", label: "Notes", kind: "long-text", writable: true }],
      views: [{ id: "00000000-0000-4000-8000-0000000000c1", collection: "organisations" }],
      buttons: [{ id: "00000000-0000-4000-8000-0000000000b1", label: "Add note", status: "active" }],
    };
  });
});
afterEach(async () => { await cleanup?.(); vi.restoreAllMocks(); });

async function mount(onClose = () => undefined) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(RoleInterfaceDialog, { workspaceId: "ws-aplyd", onClose })));
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

it("keeps interface actions on the keyboard and off the crowded export row", async () => {
  const view = await mount();
  expect(view.host.textContent).toContain("do not run scripts");
  expect(view.host.textContent).toContain("does not grant access");
  expect(view.host.textContent).toContain("does not grant collection browse");
  expect(view.host.textContent).toContain("not shared publicly");
  expect(view.host.textContent).toContain("Existing schedules stay paused");
  expect(view.host.textContent).toContain("A recoverable draft is kept");
  expect(view.host.textContent).toContain("The other parts stay available");
  for (const button of view.host.querySelectorAll("button")) {
    expect(button.getAttribute("type")).toBe("button");
    expect(button.style.minHeight === "" || button.style.minHeight === "44px").toBe(true);
  }
  await act(async () => { view.setValue(view.input("Interface name"), "Clinic desk"); });
  await act(async () => { view.button("Create interface").click(); });
  expect(posts).toEqual([]);
  await act(async () => { view.button("Confirm new interface").click(); });
  expect(posts[0]).toMatchObject({ action: "create", name: "Clinic desk" });
  expect(JSON.stringify(posts[0])).toContain("\"list\"");
  expect(JSON.stringify(posts[0])).toContain("\"form\"");
  expect(JSON.stringify(posts[0])).toContain("\"chart\"");
  expect(JSON.stringify(posts[0])).toContain("\"button\"");
  expect(JSON.stringify(posts[0])).not.toContain("script");
  expect(JSON.stringify(posts[0])).not.toContain("public");
  await act(async () => { view.setValue(view.select("Interface"), "iface-1"); });
  await act(async () => { view.button("Review publish").click(); });
  expect(posts.at(-1)).toMatchObject({ action: "preview", kind: "publish" });
  await act(async () => { view.button("Confirm publish").click(); });
  expect(posts.at(-1)).toMatchObject({ action: "apply", previewId: "preview-1" });
  await act(async () => { view.setValue(view.input("Interface search"), "Clinic"); });
  await act(async () => { view.button("Search interfaces").click(); });
  expect(view.host.textContent).toContain("Clinic desk");
  await act(async () => { view.button("Interface history").click(); });
  expect(view.host.textContent).toContain("role-interface");
  const app = readFileSync("components/holy-sheet-app.tsx", "utf8");
  const start = app.indexOf('className="page-io-actions"');
  const io = app.slice(start, app.indexOf("</div>", start));
  expect(io).toContain("Export page");
  expect(io).not.toContain("Interfaces");
  expect(app).toContain(">Interfaces</button>");
  const css = readFileSync("app/workspace.css", "utf8");
  expect(css).toContain(".role-interface-dialog .actions { display:flex; flex-wrap:wrap;");
  expect(css).toContain(".role-interface-dialog label { display:flex; align-items:center; gap:.5rem; min-height:44px; }");
});

it("leaves a saved interface unchanged when cancel is chosen before confirm", async () => {
  const closed = vi.fn();
  const view = await mount(closed);
  await act(async () => { view.button("Create interface").click(); });
  expect(posts).toEqual([]);
  await act(async () => { view.button("Cancel").click(); });
  expect(closed).toHaveBeenCalledOnce();
  expect(posts).toEqual([]);
});
