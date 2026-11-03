// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../components/editor/use-document-session", async () => ({ ...await vi.importActual("../components/editor/use-document-session"), requestJson: mocks.request }));
vi.mock("../components/editor/rich-editor", () => ({ Dialog: ({ children, title, onClose }: { children: ReactNode; title: string; onClose: () => void }) => createElement("div", { role: "dialog", "aria-label": title }, createElement("button", { type: "button", onClick: onClose, style: { minHeight: 44, minWidth: 44 } }, "Close dialog"), children) }));
import KnowledgeSiteDialog from "../components/knowledge-site-dialog";

const site = { id: "site-1", name: "Help centre", status: "published", version: 2, sharing: "off", liveSite: false, domain: null, audienceConfirmed: true, schedulesPaused: true, paths: ["help/start"] };
let cleanup: () => Promise<void>;
const posts: unknown[] = [];

beforeEach(() => {
  posts.length = 0;
  mocks.request.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts.push(JSON.parse(String(init.body)));
      return { sharing: "off", liveSite: false, accessGranted: false, dryRun: true, publicText: "APPROVED_HELP_TEXT", manifest: [{ kind: "comment", reason: "stripped" }], projection: { cache: "no-store" }, body: "# Help centre\nSharing: off.\nThird-party copies are not retracted." };
    }
    if (String(url).includes("view=search")) return { results: [site] };
    if (String(url).includes("view=history")) return { events: [{ action: "preview", source: "knowledge-site", atIst: "03 Nov 2026, 09:00 IST" }] };
    return {
      boundary: "A knowledge site publishes a reviewed subset of approved page revisions.",
      assignment: "Configuring a site does not grant access.",
      audience: "Publish needs the separate publish capability and an explicit public-audience confirmation.",
      live: "No public site, domain, or sharing is enabled by this task.",
      schedules: "Existing schedules stay paused.",
      recoverable: "A recoverable draft is kept when the version changes.",
      edge: "Knowledge-site responses stay with the tenant and use cache no-store.",
      quarantine: "Direct asset URLs are removed.",
      retraction: "Unpublish and rollback do not retract copies already held by a third party.",
      cacheBound: "Responses use cache no-store and a zero-second bound.",
      sites: [site],
      drafts: [{ siteKey: "site-1", kind: "configure" }],
    };
  });
});
afterEach(async () => { await cleanup?.(); vi.restoreAllMocks(); });

async function mount(onClose = () => undefined) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(KnowledgeSiteDialog, { workspaceId: "ws-aplyd", onClose })));
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

it("keeps knowledge-site actions on the keyboard and at least 44px, off the export row", async () => {
  const view = await mount();
  expect(view.host.textContent).toContain("does not grant access");
  expect(view.host.textContent).toContain("explicit public-audience confirmation");
  expect(view.host.textContent).toContain("No public site, domain, or sharing");
  expect(view.host.textContent).toContain("Existing schedules stay paused");
  expect(view.host.textContent).toContain("A recoverable draft is kept");
  expect(view.host.textContent).toContain("cache no-store");
  expect(view.host.textContent).toContain("do not retract");
  for (const button of view.host.querySelectorAll("button")) {
    expect(button.getAttribute("type")).toBe("button");
    const height = button.style.minHeight;
    expect(height === "" || height === "44px").toBe(true);
    if (height === "44px") expect(button.style.minWidth === "44px" || button.style.minWidth === "").toBe(true);
  }
  await act(async () => { view.setValue(view.input("Approved page"), "00000000-0000-4000-8000-00000000a101"); view.setValue(view.input("Approved revision"), "2"); });
  await act(async () => { view.button("Review site").click(); });
  expect(posts).toEqual([]);
  await act(async () => { view.button("Confirm site").click(); });
  expect(posts[0]).toMatchObject({ action: "configure", name: "Help centre" });
  expect(JSON.stringify(posts[0])).toContain("\"public\":false");
  await act(async () => { view.setValue(view.select("Saved knowledge site"), "site-1"); });
  expect(view.host.textContent).toContain("Live site no");
  await act(async () => { view.button("Public preview").click(); });
  expect(posts.at(-1)).toMatchObject({ action: "preview", siteId: "site-1" });
  expect(view.host.textContent).toContain("APPROVED_HELP_TEXT");
  await act(async () => { view.button("Review publish").click(); });
  expect(view.button("Confirm public audience").disabled).toBe(true);
  await act(async () => { view.input("Public audience confirmation").click(); });
  await act(async () => { view.button("Confirm public audience").click(); });
  expect(posts.at(-1)).toMatchObject({ action: "publish", audience: "public" });
  await act(async () => { view.button("Unpublish site").click(); });
  await act(async () => { view.button("Confirm unpublish").click(); });
  expect(posts.at(-1)).toMatchObject({ action: "unpublish" });
  await act(async () => { view.button("Roll back site").click(); });
  await act(async () => { view.button("Confirm rollback").click(); });
  expect(posts.at(-1)).toMatchObject({ action: "rollback" });
  await act(async () => { view.setValue(view.input("Knowledge site search"), "Help"); });
  await act(async () => { view.button("Search knowledge sites").click(); });
  expect(view.host.textContent).toContain("Help centre");
  await act(async () => { view.button("Site history").click(); });
  expect(view.host.textContent).toContain("knowledge-site");
  const app = readFileSync("components/holy-sheet-app.tsx", "utf8");
  const start = app.indexOf('className="page-io-actions"');
  const io = app.slice(start, app.indexOf("</div>", start));
  expect(io).toContain("Export page");
  expect(io).not.toContain("Knowledge sites");
  expect(app).toContain(">Knowledge sites</button>");
  const css = readFileSync("app/workspace.css", "utf8");
  expect(css).toContain(".knowledge-site-dialog .actions { display:flex; flex-wrap:wrap;");
  expect(css).toContain(".knowledge-site-dialog label { display:flex; align-items:center; gap:.5rem; min-height:44px; }");
  expect(css).toContain("@media (max-width:360px)");
});

it("leaves a knowledge site unchanged when cancel is chosen before confirm", async () => {
  const closed = vi.fn();
  const view = await mount(closed);
  await act(async () => { view.button("Review site").click(); });
  expect(posts).toEqual([]);
  await act(async () => { view.button("Cancel").click(); });
  expect(closed).toHaveBeenCalledOnce();
  expect(posts).toEqual([]);
});
