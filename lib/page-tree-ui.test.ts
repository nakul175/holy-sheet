// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import PageTree from "../components/page-tree";
import { ApiError } from "../components/editor/use-document-session";
import { PAGE_TREE_CREATE_DENIED, PAGE_TREE_UNAVAILABLE, PAGE_TREE_UNDO_MS, type PageTreeNode, type PageTreeSlice } from "./page-tree-model";

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../components/editor/use-document-session", () => ({ requestJson: mocks.request, ApiError: class ApiError extends Error { status: number; code: string; constructor(message: string, status: number, code: string) { super(message); this.status = status; this.code = code; } } }));
vi.mock("../components/editor/dialog", () => ({ Dialog: ({ title, children }: { title: string; children: ReactNode }) => createElement("div", { role: "dialog", "aria-label": title }, children) }));

const node = (id: string, extra: Partial<PageTreeNode> = {}): PageTreeNode => ({ id, title: id, spaceId: "space", parentId: null, position: 0, version: 1, role: "owner", hasVisibleChildren: false, ...extra });
const slice = (nodes: PageTreeNode[], extra: Partial<PageTreeSlice> = {}): PageTreeSlice => ({ workspaceId: "ws", spaceId: "space", parentId: null, treeVersion: 1, canCreateInSpace: true, nodes, nextCursor: null, ...extra });

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.useRealTimers();
  vi.restoreAllMocks();
  mocks.request.mockReset();
});

async function render(props: Partial<Parameters<typeof PageTree>[0]> = {}) {
  await act(async () => root.render(createElement(PageTree, { workspaceId: "ws", spaceId: "space", spaceName: "Ops", onOpen: vi.fn(), ...props })));
  await act(async () => { await Promise.resolve(); });
}

it("requires inherited-access confirmation before a move is applied", async () => {
  mocks.request.mockImplementation(async (_url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) as { kind?: string; confirmExpanded?: boolean } : null;
    if (body?.kind === "preview") return { pageId: "b", title: "Beta", descendantCount: 0, treeVersion: 2, sourcePath: ["Ops"], targetPath: ["Ops"], position: { index: 0, afterId: null, afterTitle: null }, changes: [{ pageId: "b", pageTitle: "Beta", recipientId: "reader", recipientName: "QA Reader", before: null, after: "viewer" }], expandsAccess: true, digest: "b".repeat(64) };
    if (body?.kind === "apply") return { pageId: "b", treeVersion: 3, replayed: false, atIst: "01 Nov 2026, 01:03 IST", confirmExpanded: body.confirmExpanded };
    return slice([node("a", { title: "Alpha" }), node("b", { title: "Beta" })]);
  });
  await render();
  const alpha = host.querySelector<HTMLElement>("#page-tree-item-a")!;
  await act(async () => alpha.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
  await act(async () => host.querySelector<HTMLElement>("#page-tree-item-b")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, altKey: true, shiftKey: true })));
  await act(async () => { await Promise.resolve(); });
  expect(host.textContent).toContain("QA Reader");
  expect(( [...host.querySelectorAll("button")].find(button => button.textContent === "Confirm move") as HTMLButtonElement).disabled).toBe(true);
  await act(async () => host.querySelector<HTMLInputElement>("input[type=checkbox]")!.click());
  const confirm = [...host.querySelectorAll("button")].find(button => button.textContent === "Confirm move") as HTMLButtonElement;
  expect(confirm.disabled).toBe(false);
  await act(async () => confirm.click());
  await act(async () => { await Promise.resolve(); });
  const applied = mocks.request.mock.calls.map(call => call[1]?.body).find(body => String(body).includes("\"kind\":\"apply\""));
  expect(JSON.parse(String(applied)).confirmExpanded).toBe(true);
});

it("does not claim an ARIA tree when a space has no visible pages", async () => {
  mocks.request.mockResolvedValue(slice([]));
  await render();
  expect(host.querySelector("[role=tree]")).toBeNull();
  expect(host.textContent).toContain("No pages yet");
  expect(host.querySelector("[aria-label='New page in Ops']")).toBeTruthy();
  expect(host.textContent).not.toContain("Ops pages");
});

it("hides the expander when a reader has no visible children and virtualises a long list", async () => {
  const many = Array.from({ length: 80 }, (_, index) => node(`p${index}`, { hasVisibleChildren: index === 0, title: index === 0 ? "P-100" : `Page ${index}` }));
  mocks.request.mockResolvedValue(slice(many));
  await render();
  expect(host.querySelector("[aria-label='Expand P-100']")).toBeTruthy();
  expect(host.querySelector("[aria-label='Expand Page 1']")).toBeNull();
  expect(host.textContent).not.toMatch(/childCount|hidden/i);
  expect(host.querySelectorAll("[role=treeitem]").length).toBeGreaterThan(0);
  expect(host.querySelectorAll("[role=treeitem]").length).toBeLessThan(40);
  expect(host.querySelector("[role=tree]")?.getAttribute("aria-label")).toBe("Pages in Ops");
});

it("shows a skeleton while a branch loads and then only the visible child", async () => {
  let release: () => void = () => undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  mocks.request.mockImplementation(async (url: string) => {
    if (String(url).includes("parentId=")) { await gate; return slice([node("child", { parentId: "parent", title: "Visible child" })], { parentId: "parent" }); }
    return slice([node("parent", { title: "P-100", hasVisibleChildren: true })]);
  });
  await render();
  await act(async () => host.querySelector<HTMLButtonElement>("[aria-label='Expand P-100']")!.click());
  expect(host.textContent).toContain("Loading pages");
  await act(async () => { release(); await gate; });
  expect(host.textContent).toContain("Visible child");
  expect(host.querySelector("[aria-label='Expand Visible child']")).toBeNull();
});

it("supports the keyboard tree, inline create cancel, and the move dialog", async () => {
  const opened = vi.fn();
  let drafting = false;
  mocks.request.mockImplementation(async (url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) as { kind?: string } : null;
    if (body?.kind === "create") { drafting = true; return { pageId: "draft", parentId: "a", spaceId: "space", title: "Untitled", version: 1, role: "owner", replayed: false, atIst: "01 Nov 2026, 01:00 IST" }; }
    if (body?.kind === "cancel") { drafting = false; return { cancelled: true, replayed: false, pageId: "draft" }; }
    if (body?.kind === "rename") return { pageId: "a", version: 2, replayed: false, atIst: "01 Nov 2026, 01:01 IST" };
    if (String(url).includes("parentId=a")) return slice(drafting ? [node("draft", { parentId: "a", title: "Untitled" })] : [node("child", { parentId: "a", title: "Child" })], { parentId: "a" });
    return slice([node("a", { title: "Alpha", hasVisibleChildren: true }), node("b", { title: "Beta" })]);
  });
  await render({ onOpen: opened });
  const tree = host.querySelector<HTMLElement>("[role=tree]")!;
  const press = async (target: HTMLElement, key: string, extra: KeyboardEventInit = {}) => act(async () => { target.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, ...extra })); });
  const item = (id: string) => host.querySelector<HTMLElement>(`#page-tree-item-${id}`)!;
  item("a").focus();
  await press(item("a"), "ArrowDown");
  expect(item("b").getAttribute("aria-selected")).toBe("true");
  await press(item("b"), "Enter");
  expect(opened).toHaveBeenCalledWith("b");
  await press(item("b"), "ArrowUp");
  await press(item("a"), "F2");
  expect(host.querySelector("input[aria-label='Rename Alpha']")).toBeTruthy();
  await act(async () => host.querySelector<HTMLInputElement>("input")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  expect(host.querySelector("input")).toBeNull();
  await press(tree, "n");
  await act(async () => { await Promise.resolve(); });
  const created = host.querySelector<HTMLInputElement>("[aria-label='New page title']");
  expect(created).toBeTruthy();
  await act(async () => created!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  await act(async () => { await Promise.resolve(); });
  expect(mocks.request.mock.calls.some(call => String(call[1]?.body ?? "").includes("\"kind\":\"cancel\""))).toBe(true);
  await press(tree, "m", { ctrlKey: true, shiftKey: true });
  expect(host.querySelector("[role=dialog]")?.getAttribute("aria-label")).toBe("Move page");
  expect(host.textContent).toContain("Review move and access");
});

it("shows before, inside, and after indicators, an undo toast, and refusal copy", async () => {
  vi.useFakeTimers();
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => ({ x: 0, y: 0, top: 0, left: 0, bottom: 36, right: 120, width: 120, height: 36, toJSON() { return {}; } }) as DOMRect);
  const pages = [node("a", { title: "Alpha" }), node("b", { title: "Beta" })];
  let dropped = false;
  mocks.request.mockImplementation(async (_url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) as { kind?: string; parentId?: string | null; index?: number } : null;
    if (body?.kind === "preview") {
      if (body.parentId === "missing") throw new ApiError(PAGE_TREE_UNAVAILABLE, 404, "not_found");
      if (body.parentId === null && body.index === 99) throw new ApiError(PAGE_TREE_CREATE_DENIED, 403, "destination_create_required");
      return { pageId: "b", title: "Beta", descendantCount: 0, treeVersion: 2, sourcePath: ["Ops"], targetPath: ["Ops", "Alpha"], position: { index: 0, afterId: null, afterTitle: null }, changes: body.parentId === "a" ? [{ pageId: "b", pageTitle: "Beta", recipientId: "reader", recipientName: "QA Reader", before: null, after: "viewer" }] : [], expandsAccess: body.parentId === "a", digest: "a".repeat(64) };
    }
    if (body?.kind === "apply") return { pageId: "b", treeVersion: 3, replayed: false, atIst: "01 Nov 2026, 01:02 IST" };
    if (dropped) return slice(pages.filter(item => item.id !== "b"));
    return slice(pages);
  });
  await render();
  const source = host.querySelector<HTMLElement>("#page-tree-item-b")!;
  const target = host.querySelector<HTMLElement>("#page-tree-item-a")!;
  const transfer = { effectAllowed: "move", setData() {}, getData: () => "b" };
  const fire = (name: string, element: HTMLElement, clientY: number) => element.dispatchEvent(Object.assign(new Event(name, { bubbles: true, cancelable: true }), { clientY, dataTransfer: transfer }));
  await act(async () => { fire("dragstart", source, 0); fire("dragover", target, 2); });
  expect(target.className).toContain("drop-before");
  await act(async () => fire("dragover", target, 18));
  expect(target.className).toContain("drop-inside");
  await act(async () => fire("dragover", target, 34));
  expect(target.className).toContain("drop-after");
  await act(async () => fire("drop", target, 34));
  await act(async () => { await Promise.resolve(); });
  expect(host.textContent).toContain("Undo is available for 10 seconds");
  expect(host.textContent).toContain("01 Nov 2026, 01:02 IST");
  await act(async () => { await vi.advanceTimersByTimeAsync(PAGE_TREE_UNDO_MS); });
  expect(host.textContent).not.toContain("Undo is available for 10 seconds");

  dropped = true;
  mocks.request.mockImplementation(async (_url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) as { kind?: string } : null;
    if (body?.kind === "preview") throw new ApiError(PAGE_TREE_UNAVAILABLE, 404, "not_found");
    return slice(pages.filter(item => item.id !== "b"));
  });
  await act(async () => { fire("dragstart", source, 0); fire("drop", target, 18); });
  await act(async () => { await Promise.resolve(); });
  expect(host.textContent).toContain(PAGE_TREE_UNAVAILABLE);
  expect(host.textContent).not.toContain("Beta");
});
