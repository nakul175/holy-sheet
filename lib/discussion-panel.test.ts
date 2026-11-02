// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import type { ThreadView } from "./discussion-types";

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../components/editor/use-document-session", () => ({ requestJson: mocks.request, ApiError: class ApiError extends Error { status: number; constructor(message: string, status: number) { super(message); this.status = status; } } }));
import DiscussionPanel from "../components/discussion-panel";

const thread = (id: string, status: "open" | "resolved" = "open", extra: Partial<ThreadView> = {}): ThreadView => ({
  id, creatorId: "editor", status, version: 1, anchors: [], anchorUnavailable: false, createdAt: "2026-11-02T00:00:00.000Z", canResolve: true, mine: false, mentionsMe: false, activity: [],
  comments: [{ id: `${id}-c`, authorId: "editor", authorName: status === "open" ? "Open author" : "Resolved author", body: status === "open" ? "Open words" : "Resolved words", version: 1, createdAt: "2026-11-02T00:00:00.000Z", editedAt: null, deletedAt: null, canEdit: false, canDelete: false, canRestore: false, records: [] }],
  ...extra,
});

let root: Root | undefined;
afterEach(async () => { await act(async () => { root?.unmount(); }); root = undefined; document.body.innerHTML = ""; localStorage.clear(); vi.restoreAllMocks(); });

function media(matches: boolean) {
  vi.stubGlobal("matchMedia", () => ({ matches, addEventListener() {}, removeEventListener() {} }));
}

async function mount(threads: ThreadView[], actorId = "actor-a", matches = false, respond: () => void = () => { mocks.request.mockResolvedValue({ threads, role: "editor" }); }) {
  media(matches);
  respond();
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div");
  document.body.append(host);
  const onActive = vi.fn();
  root = createRoot(host);
  await act(async () => { root!.render(createElement(DiscussionPanel, { pageId: "page-1", role: "editor", version: 1, open: true, selection: null, activeId: null, actorId, onClose: vi.fn(), onActive, onNavigate: vi.fn(), onThreads: vi.fn(), onDirty: vi.fn() })); });
  return { host, onActive };
}

it("filters open, resolved, mine and mentions with counts and keyboard movement", async () => {
  const threads = [thread("11111111-1111-4111-8111-111111111111"), thread("22222222-2222-4222-8222-222222222222", "resolved"), thread("33333333-3333-4333-8333-333333333333", "open", { mine: true, mentionsMe: true, comments: [{ ...thread("33333333-3333-4333-8333-333333333333").comments[0], authorName: "Mine author", body: "Mine words" }] })];
  const view = await mount(threads);
  expect(view.host.textContent).toContain("Open · 2");
  expect(view.host.textContent).toContain("Show resolved · 1");
  expect(view.host.textContent).toContain("Mine · 1");
  expect(view.host.textContent).toContain("Mentions · 1");
  expect(view.host.textContent).toContain("Open words");
  expect(view.host.textContent).not.toContain("Resolved words");
  const button = (label: string) => Array.from(view.host.querySelectorAll("button")).find(item => item.textContent?.startsWith(label))!;
  await act(async () => { button("Show resolved").click(); });
  expect(view.host.textContent).toContain("Resolved words");
  expect(view.host.textContent).not.toContain("Open words");
  await act(async () => { button("Mine").click(); });
  expect(view.host.textContent).toContain("Mine words");
  await act(async () => { button("Open").click(); });
  view.host.querySelector("aside")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
  expect(view.onActive).toHaveBeenCalledWith(threads[0].id);
  expect(view.host.querySelector("aside")?.getAttribute("data-presentation")).toBe("sidebar");
});

it("uses a bottom sheet on a narrow viewport and shows detached quotes", async () => {
  const detached = thread("11111111-1111-4111-8111-111111111111", "open", { anchors: [{ blockId: "block", start: 0, end: 6, quote: "orchid", status: "detached" }] });
  const view = await mount([detached], "actor-a", true);
  expect(view.host.querySelector("aside")?.getAttribute("data-presentation")).toBe("sheet");
  expect(view.host.querySelector("aside")?.className).toContain("discussion-sheet");
  expect(view.host.textContent).toContain("Detached");
  expect(view.host.textContent).toContain("orchid");
});

it("mounts discussions when localStorage throws and keyboard navigation still runs", async () => {
  const errors = vi.spyOn(console, "error").mockImplementation(() => {});
  const previous = Object.getOwnPropertyDescriptor(window, "localStorage");
  Object.defineProperty(window, "localStorage", { configurable: true, get() { throw new DOMException("Denied", "SecurityError"); } });
  try {
    const view = await mount([thread("11111111-1111-4111-8111-111111111111")]);
    expect(view.host.querySelector("h2")?.textContent).toBe("Discussions");
    expect(view.host.querySelector("textarea")).toBeTruthy();
    view.host.querySelector("aside")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    expect(view.onActive).toHaveBeenCalledWith("11111111-1111-4111-8111-111111111111");
    expect(errors.mock.calls.some(call => String(call.join(" ")).includes("SecurityError") || String(call.join(" ")).includes("Denied"))).toBe(false);
  } finally {
    errors.mockRestore();
    if (previous) Object.defineProperty(window, "localStorage", previous);
  }
});

it("keeps a revoked post draft encrypted for the same actor only", async () => {
  const { ApiError } = await import("../components/editor/use-document-session");
  const view = await mount([], "actor-a", false, () => {
    mocks.request.mockImplementation((_url: string, init?: RequestInit) => init?.method === "POST" ? Promise.reject(new ApiError("Page is restricted or unavailable", 404, "not_found")) : Promise.resolve({ threads: [], role: "editor" }));
  });
  const box = view.host.querySelector("textarea")!;
  const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")!.set!;
  await act(async () => { set.call(box, "SECRET_DRAFT"); box.dispatchEvent(new Event("input", { bubbles: true })); });
  await act(async () => { view.host.querySelector<HTMLButtonElement>("button.primary")!.click(); });
  expect(box.value).toBe("SECRET_DRAFT");
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 220)); });
  const stored = localStorage.getItem("hs-discussion-draft:v1:page-1") ?? "";
  expect(stored).not.toContain("SECRET_DRAFT");
  expect(stored.length).toBeGreaterThan(0);
});
