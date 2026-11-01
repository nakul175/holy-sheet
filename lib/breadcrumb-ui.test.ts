// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import axe from "axe-core";
import BreadcrumbNav, { PageUnavailable } from "../components/breadcrumb-nav";
import { BREADCRUMB_MOBILE_QUERY, BREADCRUMB_REFRESH_MS, BREADCRUMB_TRASH, BREADCRUMB_UNAVAILABLE, type BreadcrumbReadable, type BreadcrumbSegment, type BreadcrumbView } from "./breadcrumb-model";

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../components/editor/use-document-session", () => ({ requestJson: mocks.request }));

const crumb = (id: string, title: string, extra: Partial<BreadcrumbReadable> = {}): BreadcrumbReadable => ({
  readable: true, kind: "page", id, title, href: `/pages/${id}`, current: false, siblings: [], siblingsTruncated: false, ...extra,
});
const ready = (segments: BreadcrumbSegment[], treeVersion = 1): BreadcrumbView => ({ state: "ready", treeVersion, segments });

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
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  mocks.request.mockReset();
});

async function render(node: ReactNode) {
  await act(async () => { root.render(node); });
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
}

function media(matches: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: query === BREADCRUMB_MOBILE_QUERY ? matches : false,
    media: query,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => false,
  }));
}

it("renders a full depth-4 breadcrumb with links and a current page that is not a link", async () => {
  const segments = [
    crumb("space", "Product", { kind: "space", href: "/workspaces/ws/spaces/space-product" }),
    crumb("p100", "P-100"),
    crumb("p103", "P-103"),
    crumb("p105", "P-105", { current: true }),
  ];
  mocks.request.mockResolvedValue(ready(segments));
  const onOpenPage = vi.fn();
  await render(createElement(BreadcrumbNav, { workspaceId: "ws", pageId: "p105", onOpenPage }));
  const nav = host.querySelector("nav[aria-label=Breadcrumb]")!;
  expect([...nav.querySelectorAll("a")].map(link => link.textContent)).toEqual(["Product", "P-100", "P-103"]);
  const current = nav.querySelector("[aria-current=page]");
  expect(current?.tagName).toBe("SPAN");
  expect(current?.textContent).toBe("P-105");
  expect(current?.closest("a")).toBeNull();
  expect(nav.querySelector("[aria-label='Show middle pages']")).toBeNull();
  await act(async () => nav.querySelector<HTMLAnchorElement>("a[href='/pages/p100']")!.click());
  expect(onOpenPage).toHaveBeenCalledExactlyOnceWith("p100");
  const results = await axe.run(nav, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] } });
  expect(results.violations.map(violation => violation.id)).toEqual([]);
});

it("collapses a depth-9 trail on desktop and shows only the parent back control on mobile", async () => {
  const segments: BreadcrumbSegment[] = [
    crumb("space", "Product", { kind: "space", href: "/spaces/product" }),
    ...Array.from({ length: 8 }, (_, index) => crumb(`p${index + 1}`, `P-${index + 1}`, { current: index === 7 })),
  ];
  mocks.request.mockResolvedValue(ready(segments));
  await render(createElement(BreadcrumbNav, { workspaceId: "ws", pageId: "p8" }));
  const nav = host.querySelector("nav")!;
  expect(nav.dataset.layout).toBe("desktop");
  expect(nav.textContent).toContain("Product");
  expect(nav.textContent).toContain("P-7");
  expect(nav.textContent).toContain("P-8");
  expect(nav.textContent).not.toContain("P-1");
  const middle = nav.querySelector<HTMLButtonElement>("[aria-label='Show middle pages']")!;
  await act(async () => middle.click());
  expect(nav.textContent).toContain("P-1");
  expect(nav.textContent).toContain("P-6");
  expect([...nav.querySelectorAll(".breadcrumb-menu a")].map(link => link.textContent)).toEqual(["P-1", "P-2", "P-3", "P-4", "P-5", "P-6"]);

  await act(async () => root.unmount());
  media(true);
  root = createRoot(host);
  await render(createElement(BreadcrumbNav, { workspaceId: "ws", pageId: "p8" }));
  const narrow = host.querySelector("nav")!;
  expect(narrow.dataset.layout).toBe("mobile");
  expect(narrow.querySelector("[aria-label='Back to P-7']")?.textContent).toContain("P-7");
  expect(narrow.textContent).not.toContain("P-6");
  expect(narrow.textContent).not.toContain("P-8");
  expect(narrow.textContent).not.toContain("Product");
  expect(narrow.querySelector("ol")).toBeNull();
});

it("opens a sibling menu of 20 pages plus Show all, then the readable remainder", async () => {
  const siblings = Array.from({ length: 20 }, (_, index) => ({ id: `s${index}`, title: `Mate ${index}`, href: `/pages/s${index}` }));
  const hidden = "Hidden mate title";
  const current = crumb("leaf", "Current", { current: true, siblings, siblingsTruncated: true });
  mocks.request.mockImplementation(async (url: string) => {
    if (String(url).includes("all=1")) return ready([{ readable: false }, crumb("leaf", "Current", { current: true, siblings: [...siblings, { id: "s20", title: "Mate 20", href: "/pages/s20" }], siblingsTruncated: false })]);
    return ready([{ readable: false }, current]);
  });
  await render(createElement(BreadcrumbNav, { workspaceId: "ws", pageId: "leaf" }));
  expect(host.textContent).not.toContain(hidden);
  const chevron = host.querySelector<HTMLButtonElement>("[aria-label='Show sibling pages for Current']")!;
  await act(async () => chevron.click());
  expect(host.querySelectorAll(".breadcrumb-menu a")).toHaveLength(20);
  expect(host.textContent).not.toContain("Mate 20");
  await act(async () => [...host.querySelectorAll("button")].find(button => button.textContent === "Show all")!.click());
  await act(async () => { await Promise.resolve(); await Promise.resolve(); });
  expect(host.querySelectorAll(".breadcrumb-menu a")).toHaveLength(21);
  expect(host.textContent).toContain("Mate 20");
  expect(host.textContent).not.toContain(hidden);
  expect(host.innerHTML).not.toContain("secret-sibling");
});

it("replaces the open breadcrumb after the refresh interval", async () => {
  vi.useFakeTimers();
  let title = "Before rename";
  mocks.request.mockImplementation(async () => ready([
    crumb("space", "Product", { kind: "space" }),
    crumb("parent", "Parent"),
    crumb("leaf", title, { current: true }),
  ]));
  await render(createElement(BreadcrumbNav, { workspaceId: "ws", pageId: "leaf" }));
  expect(host.textContent).toContain("Before rename");
  title = "After rename";
  await act(async () => { await vi.advanceTimersByTimeAsync(BREADCRUMB_REFRESH_MS); });
  expect(host.textContent).toContain("After rename");
  expect(host.textContent).not.toContain("Before rename");
});

it("does not put a hidden ancestor title or id in the breadcrumb DOM", async () => {
  mocks.request.mockResolvedValue(ready([{ readable: false }, crumb("leaf", "Visible leaf", { current: true })]));
  await render(createElement(BreadcrumbNav, { workspaceId: "ws", pageId: "leaf" }));
  const html = host.innerHTML;
  expect(host.textContent).toContain("…");
  expect(host.textContent).toContain("Visible leaf");
  expect(html).not.toContain("Hidden root title");
  expect(html).not.toContain("hidden-root");
  expect(html).not.toContain("space-product");
  expect(host.querySelector("[aria-current=page]")?.textContent).toBe("Visible leaf");
});

it("shows trash to a permitted reader and the same unavailable sentence otherwise", async () => {
  mocks.request.mockResolvedValueOnce({ state: "trash", message: BREADCRUMB_TRASH });
  await render(createElement(PageUnavailable, { pageId: "leaf", message: BREADCRUMB_UNAVAILABLE }));
  expect(host.textContent).toContain(BREADCRUMB_TRASH);
  expect(host.textContent).not.toContain("Trashed ancestor title");
  mocks.request.mockRejectedValueOnce(new Error(BREADCRUMB_UNAVAILABLE));
  await render(createElement(PageUnavailable, { pageId: "missing", message: BREADCRUMB_UNAVAILABLE }));
  expect(host.textContent).toContain(BREADCRUMB_UNAVAILABLE);
  expect(host.textContent).not.toContain(BREADCRUMB_TRASH);
});
