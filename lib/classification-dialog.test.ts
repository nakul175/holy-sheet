// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../components/editor/use-document-session", async () => ({ ...await vi.importActual("../components/editor/use-document-session"), requestJson: mocks.request }));
vi.mock("../components/editor/rich-editor", () => ({ Dialog: ({ children, title, onClose }: { children: ReactNode; title: string; onClose: () => void }) => createElement("div", { role: "dialog", "aria-label": title }, createElement("button", { type: "button", onClick: onClose, style: { minHeight: 44 } }, "Close dialog"), children) }));
import ClassificationDialog from "../components/classification-dialog";

const tag = { id: "tag-1", code: "CLINIC", label: "Clinic", status: "active", parentId: null, documents: true, handling: "metadata" as const, version: 2, collections: ["contacts"], clearedUserIds: [], recoverableDraft: { label: "Draft clinic", parentId: null, documents: true, collections: ["contacts"], handling: "metadata" as const, baseVersion: 2 } };
const page = { kind: "page" as const, id: "page-1", title: "Visible clinic", version: 1, canAssign: true, tags: [{ id: "tag-1", code: "CLINIC", label: "Clinic", status: "active" }], choices: [{ id: "tag-1", code: "CLINIC", label: "Clinic" }] };
let cleanup: () => Promise<void>;
const posts: unknown[] = [];

beforeEach(() => {
  posts.length = 0;
  mocks.request.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") { posts.push(JSON.parse(String(init.body))); return { replayed: false, body: "# Classification\nCLINIC — Clinic" }; }
    if (String(url).includes("view=facets")) return { facets: [{ tagId: "tag-1", code: "CLINIC", label: "Clinic", count: 1 }] };
    if (String(url).includes("view=search")) return { results: [{ kind: "page", id: "page-1", title: "Visible clinic" }] };
    if (String(url).includes("view=history")) return { events: [{ action: "assign", actorName: "Ada", atIst: "03 Nov 2026, 09:00 IST", source: "classification" }] };
    if (String(url).includes("view=preview")) return { previewId: "preview-1", review: "These are the references you can see.", version: 2, references: [{ kind: "page", id: "page-1", title: "Visible clinic" }], intoCode: null };
    return { manage: true, boundary: "No generative model", assignment: "does not grant access", tags: [tag], page, record: null, collections: [{ id: "contacts", name: "Contacts" }], colleagues: [] };
  });
});
afterEach(async () => { await cleanup?.(); vi.restoreAllMocks(); });

async function mount(onClose = () => undefined) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(ClassificationDialog, { workspaceId: "ws-aplyd", pageId: "page-1", onClose })));
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

it("keeps classification controls on the keyboard and off the crowded action row", async () => {
  const view = await mount();
  expect(view.host.textContent).toContain("No generative model");
  expect(view.host.textContent).toContain("does not grant access");
  expect(view.host.textContent).toContain("A recoverable draft is kept");
  expect(view.host.textContent).toContain("CLINIC · Clinic · 1");
  for (const button of view.host.querySelectorAll("button")) {
    expect(button.getAttribute("type")).toBe("button");
    expect(button.style.minHeight === "" || button.style.minHeight === "44px").toBe(true);
  }
  await act(async () => { view.setValue(view.input("Tag code"), "WARD"); view.setValue(view.input("Tag label"), "Ward"); });
  await act(async () => { view.button("Create tag").click(); });
  expect(posts).toEqual([]);
  await act(async () => { view.button("Confirm new tag").click(); });
  expect(posts[0]).toMatchObject({ action: "create", code: "WARD", label: "Ward", documents: true });
  const select = view.host.querySelector<HTMLSelectElement>('[aria-label="Classification search tag"]')!;
  await act(async () => { select.value = "tag-1"; select.dispatchEvent(new Event("change", { bubbles: true })); });
  await act(async () => { view.button("Search by tag id").click(); });
  expect(view.host.textContent).toContain("Visible clinic");
  expect(view.button("Save page tags").style.minHeight).toBe("44px");
  const app = readFileSync("components/holy-sheet-app.tsx", "utf8");
  const start = app.indexOf('className="page-io-actions"');
  const io = app.slice(start, app.indexOf("</div>", start));
  expect(io).toContain("Export page");
  expect(io).not.toContain("Classification");
  expect(app).toContain(">Classification</button>");
  const css = readFileSync("app/workspace.css", "utf8");
  expect(css).not.toMatch(/\.page-io-actions \{[^}]*flex-wrap/);
  expect(css).toMatch(/\.page-io-actions \{[^}]*z-index:7/);
  expect(css).toContain(".classification-dialog .actions { display:flex; flex-wrap:wrap;");
});

it("leaves saved tags unchanged when cancel is chosen before confirm", async () => {
  const closed = vi.fn();
  const view = await mount(closed);
  await act(async () => { view.button("Save page tags").click(); });
  expect(posts).toEqual([]);
  await act(async () => { view.button("Cancel").click(); });
  expect(closed).toHaveBeenCalledOnce();
  expect(posts).toEqual([]);
});
