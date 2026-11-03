// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../components/editor/use-document-session", async () => ({ ...await vi.importActual("../components/editor/use-document-session"), requestJson: mocks.request }));
vi.mock("../components/editor/rich-editor", () => ({ Dialog: ({ children, title, onClose }: { children: ReactNode; title: string; onClose: () => void }) => createElement("div", { role: "dialog", "aria-label": title }, createElement("button", { type: "button", onClick: onClose, style: { minHeight: 44 } }, "Close dialog"), children) }));
import DependencyImpactDialog from "../components/dependency-impact-dialog";

const edge = {
  id: "edge-1", kind: "link" as const, kindLabel: "Explicit link", sourceId: "source-1", sourceTitle: "Policy", sourceRevision: 2, liveSourceRevision: 2,
  sourceState: "active", dependentPageId: "page-1", dependentTitle: "Ward", liveDependentRevision: 3, reviewerId: "editor-1", reviewerName: "Ed Editor",
  reviewerAuthority: true, reviewState: "needs_review" as const, reviewReason: "Source material changed at revision 2", note: "", version: 2, sourceVersion: 2,
  access: "manage" as const, recoverableDraft: null,
};
let cleanup: () => Promise<void>;
const posts: unknown[] = [];

beforeEach(() => {
  posts.length = 0;
  mocks.request.mockImplementation(async (url: string, init?: RequestInit) => {
    if (!init && String(url).includes("/dependency-impact/edge-1")) return edge;
    if (!init) return { manage: true, edges: [{ id: edge.id, kindLabel: edge.kindLabel, sourceTitle: edge.sourceTitle, dependentTitle: edge.dependentTitle, reviewState: edge.reviewState }], colleagues: [{ id: "editor-1", name: "Ed Editor" }], currentPage: { id: "page-1", title: "Ward", version: 3 } };
    const body = JSON.parse(String(init.body));
    posts.push(body);
    if (body.action === "record") return { ...edge, id: "edge-new" };
    return edge;
  });
});
afterEach(async () => { await cleanup?.(); vi.restoreAllMocks(); });

async function mount(onClose = () => undefined) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(DependencyImpactDialog, { workspaceId: "ws-aplyd", pageId: "page-1", onClose })));
  cleanup = async () => { await act(async () => root.unmount()); host.remove(); };
  const button = (text: string) => Array.from(host.querySelectorAll("button")).find(item => item.textContent === text)!;
  const input = (label: string) => host.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(`[aria-label="${label}"]`)!;
  const setValue = (element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) => {
    const prototype = element.tagName === "TEXTAREA" ? HTMLTextAreaElement.prototype : element.tagName === "SELECT" ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
    element.dispatchEvent(new Event("change", { bubbles: true }));
  };
  return { host, button, input, setValue };
}

it("records a typed dependency from keyboard controls and keeps cancel free of writes", async () => {
  const closed = vi.fn();
  const view = await mount(closed);
  expect(view.host.textContent).toContain("does not guess");
  expect(view.host.textContent).toContain("does not mark dependents Needs review");
  expect(view.host.textContent).toContain("does not grant access");
  for (const button of view.host.querySelectorAll("button")) {
    expect(button.getAttribute("type")).toBe("button");
    expect(button.style.minHeight === "" || button.style.minHeight === "44px").toBe(true);
  }
  const record = view.button("Record dependency");
  expect(record.style.minHeight).toBe("44px");
  await act(async () => { view.setValue(view.input("Source id"), "source-1"); });
  await act(async () => { view.setValue(view.input("Source revision"), "2"); });
  await act(async () => { record.click(); });
  const body = posts.find(item => (item as { action?: string }).action === "record") as { kind: string; sourceId: string; sourceRevision: number; reviewerId: string; dependentPageId: string };
  expect(body).toMatchObject({ kind: "link", sourceId: "source-1", sourceRevision: 2, reviewerId: "editor-1", dependentPageId: "page-1" });
  await act(async () => { view.button("Cancel").click(); });
  expect(closed).toHaveBeenCalledOnce();
  expect(posts.some(item => (item as { action?: string }).action === "save")).toBe(false);
});

it("requires a second confirmation before retiring and does not save on cancel", async () => {
  const closed = vi.fn();
  const view = await mount(closed);
  const select = view.host.querySelector<HTMLSelectElement>('select[aria-label="Dependency edges"]');
  if (!select) throw new Error(view.host.innerHTML);
  await act(async () => {
    select.value = "edge-1";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(view.host.textContent).toContain("Needs review");
  await act(async () => { view.button("Retire source").click(); });
  expect(posts.some(item => (item as { action?: string }).action === "retire")).toBe(false);
  expect(view.host.textContent).toContain("Confirm retire");
  await act(async () => { view.button("Cancel").click(); });
  expect(closed).toHaveBeenCalledOnce();
  expect(posts.some(item => (item as { action?: string }).action === "retire")).toBe(false);
});
