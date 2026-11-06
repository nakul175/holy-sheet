// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../components/editor/use-document-session", async () => ({ ...await vi.importActual("../components/editor/use-document-session"), requestJson: mocks.request }));
vi.mock("../components/editor/rich-editor", () => ({ Dialog: ({ children, title, onClose }: { children: ReactNode; title: string; onClose: () => void }) => createElement("div", { role: "dialog", "aria-label": title }, createElement("button", { type: "button", onClick: onClose, style: { minHeight: 44 } }, "Close dialog"), children) }));
import QuickCaptureDialog from "../components/quick-capture-dialog";
import { captureStorageKey } from "./quick-capture-local";

const capture = { id: "00000000-0000-4000-8000-0000000000d1", title: "Clinic note", kind: "note", sourceAccess: "not-opened", version: 1 };
let cleanup: () => Promise<void>;
const posts: unknown[] = [];

beforeEach(() => {
  posts.length = 0;
  localStorage.clear();
  mocks.request.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      posts.push(body);
      if (body.action === "preview") return { previewId: "preview-1", action: "capture", review: "Audience: private. External sharing is not inherited. The source address was not opened.", version: body.expectedVersion, text: "Visible note", audience: "private", externalShare: false, sourceStatement: "The source address was not opened." };
      if (body.action === "download") return { body: "# Clinic note\nAudience: private.\nExternal sharing: none.", version: 1 };
      return { id: capture.id, visibility: "private" };
    }
    if (String(url).includes("view=search")) return { results: [{ id: capture.id, title: "Clinic note", kind: "note", sourceAccess: "not-opened" }] };
    if (String(url).includes("view=history")) return { events: [{ action: "commit", source: "quick-capture", atIst: "03 Nov 2026, 09:00 IST", sourceAccess: "not-opened" }] };
    if (String(url).includes("view=source")) return { text: "Visible note", sourceStatement: "The source address was not opened.", visibility: "private" };
    return {
      actorId: "ada", manage: true,
      boundary: "Quick capture saves only the text, link, or note you select. It does not browse, watch, or fetch a page for you.",
      assignment: "Configuring capture or naming an operator does not grant access to a page, record, collection, space, or field.",
      sharing: "The default destination is private and permitted. Capture does not inherit external sharing.",
      offline: "An offline capture stays as a local draft on this device.",
      schedules: "Existing schedules stay paused. Capture does not activate a schedule.",
      recoverable: "A recoverable draft is kept when the version changes.",
      provenance: "Pages by Aplyd does not open that address.",
      assets: "Source assets are imported only when you select them.",
      policy: { version: 1, kinds: ["text", "link", "note"], defaultDestination: "space", visibility: "private", inheritExternal: false, offlinePolicy: "local-draft", recoverableDraft: null },
      destinations: { spaces: [{ id: "space-private", name: "My pages" }], forms: [] },
      defaultDestination: { kind: "space", id: "space-private", name: "My pages" },
      captures: [capture],
      drafts: [{ draftKey: "current", payload: { text: "Kept", sourceAccess: "not-opened" } }],
    };
  });
});
afterEach(async () => { await cleanup?.(); vi.restoreAllMocks(); });

async function mount(onClose = () => undefined) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(QuickCaptureDialog, { workspaceId: "ws-aplyd", pageId: "page-1", onClose })));
  await act(async () => { await Promise.resolve(); });
  cleanup = async () => { await act(async () => root.unmount()); host.remove(); };
  const button = (text: string) => Array.from(host.querySelectorAll("button")).find(item => item.textContent === text)!;
  const input = (label: string) => host.querySelector<HTMLInputElement | HTMLTextAreaElement>(`[aria-label="${label}"]`)!;
  const select = (label: string) => host.querySelector<HTMLSelectElement>(`[aria-label="${label}"]`)!;
  const setValue = (element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) => {
    const prototype = element instanceof HTMLSelectElement ? HTMLSelectElement.prototype : element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  };
  return { host, button, input, select, setValue };
}

it("keeps capture actions on the keyboard and off the crowded export row", async () => {
  const view = await mount();
  expect(view.host.textContent).toContain("does not browse");
  expect(view.host.textContent).toContain("does not grant access");
  expect(view.host.textContent).toContain("does not inherit external sharing");
  expect(view.host.textContent).toContain("Existing schedules stay paused");
  expect(view.host.textContent).toContain("A recoverable draft is kept");
  for (const button of view.host.querySelectorAll("button")) {
    expect(button.getAttribute("type")).toBe("button");
    expect(button.style.minHeight === "" || button.style.minHeight === "44px").toBe(true);
  }
  await act(async () => { view.button("Review capture").click(); });
  expect(posts).toEqual([]);
  await act(async () => { view.setValue(view.input("Capture text"), "Visible note"); });
  await act(async () => { view.button("Confirm review").click(); });
  expect(posts.at(-1)).toMatchObject({ action: "preview", kind: "text", destinationKind: "space", destinationId: "space-private" });
  await act(async () => { view.button("Confirm capture").click(); });
  expect(posts.at(-1)).toMatchObject({ action: "apply", previewId: "preview-1" });
  await act(async () => { view.setValue(view.select("Saved capture"), capture.id); });
  expect(view.host.textContent).toContain("Audience private");
  await act(async () => { view.setValue(view.input("Capture search"), "Clinic"); });
  await act(async () => { view.button("Search captures").click(); });
  expect(view.host.textContent).toContain("Clinic note");
  await act(async () => { view.button("Capture history").click(); });
  expect(view.host.textContent).toContain("quick-capture");
  await act(async () => { view.button("Source preview").click(); });
  expect(view.host.textContent).toContain("not opened");
  await act(async () => { view.button("Download capture").click(); });
  expect(view.host.textContent).toContain("External sharing: none");
  const app = readFileSync("components/holy-sheet-app.tsx", "utf8");
  const start = app.indexOf('className="page-io-actions"');
  const io = app.slice(start, app.indexOf("</div>", start));
  expect(io).toContain("Export page");
  expect(io).not.toContain("Quick capture");
  expect(app).toContain(">Quick capture</button>");
  const css = readFileSync("app/workspace.css", "utf8");
  expect(css).toContain(".quick-capture-dialog .actions { display:flex; flex-wrap:wrap;");
  expect(css).toContain(".quick-capture-dialog label { display:flex; align-items:center; gap:.5rem; min-height:44px; }");
  expect(css).toContain(".quick-capture-dialog label { flex-direction:column; align-items:stretch; }");
});

it("keeps an offline draft on this device and does not send it twice", async () => {
  const view = await mount();
  await act(async () => { view.setValue(view.input("Capture text"), "Visible note"); });
  await act(async () => { view.button("Keep on this device").click(); });
  expect(posts).toEqual([]);
  expect(view.host.textContent).toContain("Saved on this device");
  expect(view.host.textContent).toContain("not opened");
  const stored = JSON.parse(localStorage.getItem(captureStorageKey("ada", "ws-aplyd")) ?? "{}") as { drafts: Record<string, { body: string }> };
  expect(Object.keys(stored.drafts)).toHaveLength(1);
  await act(async () => { view.button("Keep on this device").click(); });
  expect(view.host.textContent).toContain("already has this draft");
  expect(Object.keys(JSON.parse(localStorage.getItem(captureStorageKey("ada", "ws-aplyd")) ?? "{}").drafts)).toHaveLength(1);
  await act(async () => { view.setValue(view.input("Capture title"), "Changed title"); });
  await act(async () => { view.button("Keep on this device").click(); });
  expect(view.host.textContent).toContain("local draft is kept");
  const kept = JSON.parse(localStorage.getItem(captureStorageKey("ada", "ws-aplyd")) ?? "{}") as { drafts: Record<string, { body: string }> };
  expect(Object.values(kept.drafts)[0].body).toBe("Visible note");
});

it("leaves the capture unchanged when cancel is chosen before confirm", async () => {
  const closed = vi.fn();
  const view = await mount(closed);
  await act(async () => { view.button("Review capture").click(); });
  expect(posts).toEqual([]);
  await act(async () => { view.button("Cancel").click(); });
  expect(closed).toHaveBeenCalledOnce();
  expect(posts).toEqual([]);
});
