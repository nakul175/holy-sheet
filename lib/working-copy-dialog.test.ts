// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../components/editor/use-document-session", async () => ({ ...await vi.importActual("../components/editor/use-document-session"), requestJson: mocks.request }));
vi.mock("../components/editor/rich-editor", () => ({ Dialog: ({ children, title }: { children: ReactNode; title: string }) => createElement("div", { role: "dialog", "aria-label": title }, children) }));
import WorkingCopyDialog from "../components/working-copy-dialog";

const copy = { id: "copy-1", copyPageId: "page-copy", sourcePageId: "page-1", baseVersion: 2, state: "open", version: 1, title: "Working copy of Clinic", sourceTitle: "Clinic", sourceReadable: true, sourceEditable: true };
let cleanup: () => Promise<void>;

beforeEach(() => {
  let copies: typeof copy[] = [];
  mocks.request.mockImplementation(async (url: string, init?: RequestInit) => {
    if (!init) return { copies };
    const body = JSON.parse(String(init.body));
    if (String(url).includes("/working-copies") && !body.action) {
      copies = [copy];
      return copy;
    }
    if (body.action === "reconcile") return { sourceVersion: 4, conflicts: [{ key: "block-a", kind: "edit", label: "Block", base: "Base", original: "Original", copy: "Copy" }], preservedRestricted: 1, ready: false, state: "open" };
    if (body.action === "apply") return { sourceVersion: 5, replayed: false };
    return { copies };
  });
});
afterEach(async () => { await cleanup?.(); vi.restoreAllMocks(); });

async function mount() {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const opened: string[] = [];
  await act(async () => root.render(createElement(WorkingCopyDialog, { pageId: "page-1", onClose: () => undefined, onOpen: id => opened.push(id) })));
  cleanup = async () => { await act(async () => root.unmount()); host.remove(); };
  const button = (text: string) => Array.from(host.querySelectorAll("button")).find(item => item.textContent === text)!;
  return { host, button, opened };
}

it("creates a copy, requires a conflict choice, and applies that choice from the keyboard controls", async () => {
  const view = await mount();
  await act(async () => { view.button("Create working copy").click(); });
  expect(view.host.textContent).toContain("base revision 2");
  expect(view.host.querySelector("button")?.getAttribute("type")).not.toBe("submit");
  await act(async () => { view.button("Compare with original").click(); });
  expect(view.host.textContent).toContain("Restricted blocks stay on the original.");
  expect(view.host.textContent).toContain("Original");
  await act(async () => { view.button("Apply to original").click(); });
  expect(view.host.querySelector("[role=alert]")?.textContent).toContain("Choose each conflict");
  const choice = view.host.querySelector<HTMLInputElement>("input[type=radio][name=block-a]");
  expect(choice).toBeTruthy();
  await act(async () => { choice!.click(); });
  await act(async () => { view.button("Apply to original").click(); });
  const apply = mocks.request.mock.calls.map(call => JSON.parse(String(call[1]?.body ?? "{}"))).find(body => body.action === "apply");
  expect(apply.choices).toEqual({ "block-a": "original" });
  expect(apply.expectedSourceVersion).toBe(4);
  expect(view.host.textContent).toContain("Publishing review was not skipped");
  await act(async () => { view.button("Open copy").click(); });
  expect(view.opened).toEqual(["page-copy"]);
});
