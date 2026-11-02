// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../components/editor/use-document-session", async () => ({ ...await vi.importActual("../components/editor/use-document-session"), requestJson: mocks.request }));
vi.mock("../components/editor/rich-editor", () => ({ Dialog: ({ children, title, onClose }: { children: ReactNode; title: string; onClose: () => void }) => createElement("div", { role: "dialog", "aria-label": title }, createElement("button", { type: "button", onClick: onClose }, "Close dialog"), children) }));
import DocumentBundleDialog from "../components/document-bundle-dialog";

const bundle = {
  id: "bundle-1", name: "Clinic packet", description: "Shared references", ownerId: "owner-1", version: 2,
  access: "manage" as const, publicationId: null, publicationNo: null,
  members: [{ pageId: "page-1", title: "Visible clinic", mode: "live" as const, modeLabel: "Live — latest published", publishedVersionNo: 4, availability: "ready" }],
  recoverableDraft: null,
};
let cleanup: () => Promise<void>;
const posts: unknown[] = [];

beforeEach(() => {
  posts.length = 0;
  mocks.request.mockImplementation(async (url: string, init?: RequestInit) => {
    if (!init && String(url).includes("/document-bundles/bundle-1")) return bundle;
    if (!init) return { manage: true, bundles: [bundle], colleagues: [{ id: "owner-1", name: "Ada Admin" }], currentPage: { id: "page-1", title: "Visible clinic", publishedVersions: [4] } };
    const body = JSON.parse(String(init.body));
    posts.push(body);
    if (body.action === "create") return { ...bundle, id: "bundle-new", members: [{ ...bundle.members[0], mode: body.members[0].mode, modeLabel: "Live — latest published" }] };
    if (body.action === "publish") return { ...bundle, publicationNo: 1, publicationId: "pub-1" };
    return bundle;
  });
});
afterEach(async () => { await cleanup?.(); vi.restoreAllMocks(); });

async function mount(onClose = () => undefined) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(DocumentBundleDialog, { workspaceId: "ws-aplyd", pageId: "page-1", onClose })));
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

it("creates an ordered live reference from keyboard controls and keeps cancel free of writes", async () => {
  const closed = vi.fn();
  const view = await mount(closed);
  expect(view.host.textContent).toContain("does not grant access");
  expect(view.host.querySelectorAll("button").length).toBeGreaterThan(0);
  for (const button of view.host.querySelectorAll("button")) {
    expect(button.getAttribute("type")).toBe("button");
    expect(button.style.minHeight === "" || button.style.minHeight === "44px").toBe(true);
  }
  const create = view.button("Create bundle");
  expect(create.style.minHeight).toBe("44px");
  await act(async () => { view.setValue(view.input("Bundle name"), "Clinic packet"); });
  await act(async () => { view.setValue(view.input("Bundle description"), "Shared references"); });
  await act(async () => { create.click(); });
  const body = posts.find(item => (item as { action?: string }).action === "create") as { name: string; description: string; ownerId: string; members: { pageId: string; mode: string }[] };
  expect(body).toMatchObject({ name: "Clinic packet", description: "Shared references", ownerId: "owner-1", members: [{ pageId: "page-1", mode: "live" }] });
  expect(view.host.textContent).toContain("Live — latest published");
  await act(async () => { view.button("Cancel").click(); });
  expect(closed).toHaveBeenCalledOnce();
  expect(posts.some(item => (item as { action?: string }).action === "save")).toBe(false);
});

it("requires a second confirmation before publishing and does not save on cancel", async () => {
  const closed = vi.fn();
  const view = await mount(closed);
  const bundleSelect = view.host.querySelector<HTMLSelectElement>('select[aria-label="Document bundles"]');
  if (!bundleSelect) throw new Error(view.host.innerHTML);
  if (bundleSelect.tagName !== "SELECT") throw new Error(bundleSelect.tagName + view.host.innerHTML);
  await act(async () => {
    bundleSelect.value = "bundle-1";
    bundleSelect.dispatchEvent(new Event("change", { bubbles: true }));
  });
  expect(view.host.textContent).toContain("Live — latest published");
  await act(async () => { view.button("Publish package").click(); });
  expect(posts.some(item => (item as { action?: string }).action === "publish")).toBe(false);
  expect(view.host.textContent).toContain("Confirm publish");
  await act(async () => { view.button("Cancel").click(); });
  expect(closed).toHaveBeenCalledOnce();
  expect(posts.some(item => (item as { action?: string }).action === "publish")).toBe(false);
  await act(async () => { view.button("Publish package").click(); });
  await act(async () => { view.button("Publish package").click(); });
  expect(posts.some(item => (item as { action?: string }).action === "publish")).toBe(true);
});
