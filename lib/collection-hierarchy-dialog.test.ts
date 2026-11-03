// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../components/editor/use-document-session", async () => ({ ...await vi.importActual("../components/editor/use-document-session"), requestJson: mocks.request }));
vi.mock("../components/editor/rich-editor", () => ({ Dialog: ({ children, title, onClose }: { children: ReactNode; title: string; onClose: () => void }) => createElement("div", { role: "dialog", "aria-label": title }, createElement("button", { type: "button", onClick: onClose, style: { minHeight: 44 } }, "Close dialog"), children) }));
import CollectionHierarchyDialog from "../components/collection-hierarchy-dialog";

const config = { collection: "assets", name: "Assets", eligible: true, enabled: true, allowRoots: true, depthLimit: 20, version: 2, recoverableDraft: { enabled: true, allowRoots: true, depthLimit: 20, baseVersion: 2 } };
let cleanup: () => Promise<void>;
const posts: unknown[] = [];

beforeEach(() => {
  posts.length = 0;
  mocks.request.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") { posts.push(JSON.parse(String(init.body))); return { replayed: false, body: "# Collection hierarchy\nAssets" }; }
    if (String(url).includes("view=tree")) return { entries: [{ id: "rec-1", name: "North", version: 1, parentId: null, child: false }], more: false };
    if (String(url).includes("view=search")) return { results: [{ id: "rec-1", name: "North", parentId: null }], more: false };
    if (String(url).includes("view=preview")) return { previewId: "preview-1", review: "Descendants stay in place", version: 1, parent: null, subtree: [{ id: "rec-1", name: "North" }], references: [], cascade: false, inheritsPermissions: false };
    return { manage: true, boundary: "No generative model", assignment: "does not grant access", accountRelationship: "Accounts still require an Organisation", configs: [config] };
  });
});
afterEach(async () => { await cleanup?.(); vi.restoreAllMocks(); });

async function mount(onClose = () => undefined) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(CollectionHierarchyDialog, { workspaceId: "ws-aplyd", onClose })));
  await act(async () => { await Promise.resolve(); });
  cleanup = async () => { await act(async () => root.unmount()); host.remove(); };
  const button = (text: string) => Array.from(host.querySelectorAll("button")).find(item => item.textContent === text)!;
  const input = (label: string) => host.querySelector<HTMLInputElement>(`[aria-label="${label}"]`)!;
  const setValue = (element: HTMLInputElement, value: string) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  };
  return { host, button, input, setValue };
}

it("keeps hierarchy controls on the keyboard and off the crowded action row", async () => {
  const view = await mount();
  expect(view.host.textContent).toContain("No generative model");
  expect(view.host.textContent).toContain("does not grant access");
  expect(view.host.textContent).toContain("Accounts still require an Organisation");
  expect(view.host.textContent).toContain("A recoverable draft is kept");
  for (const button of view.host.querySelectorAll("button")) {
    expect(button.getAttribute("type")).toBe("button");
    expect(button.style.minHeight === "" || button.style.minHeight === "44px").toBe(true);
  }
  await act(async () => { view.button("Save hierarchy").click(); });
  expect(posts).toEqual([]);
  await act(async () => { view.button("Confirm hierarchy").click(); });
  expect(posts[0]).toMatchObject({ action: "save-config", collection: "assets", enabled: true, allowRoots: true, depthLimit: 20 });
  await act(async () => { view.setValue(view.input("Hierarchy search"), "North"); });
  await act(async () => { view.button("Search hierarchy").click(); });
  expect(view.host.textContent).toContain("North");
  expect(view.button("Show roots").style.minHeight).toBe("44px");
  const app = readFileSync("components/holy-sheet-app.tsx", "utf8");
  const start = app.indexOf('className="page-io-actions"');
  const io = app.slice(start, app.indexOf("</div>", start));
  expect(io).toContain("Export page");
  expect(io).not.toContain("Collection hierarchy");
  expect(app).toContain(">Collection hierarchy</button>");
  const css = readFileSync("app/workspace.css", "utf8");
  expect(css).not.toMatch(/\.page-io-actions \{[^}]*flex-wrap/);
  expect(css).toMatch(/\.page-io-actions \{[^}]*z-index:7/);
  expect(css).toContain(".collection-hierarchy-dialog .actions { display:flex; flex-wrap:wrap;");
});

it("leaves saved hierarchy unchanged when cancel is chosen before confirm", async () => {
  const closed = vi.fn();
  const view = await mount(closed);
  await act(async () => { view.button("Save hierarchy").click(); });
  expect(posts).toEqual([]);
  await act(async () => { view.button("Cancel").click(); });
  expect(closed).toHaveBeenCalledOnce();
  expect(posts).toEqual([]);
});
