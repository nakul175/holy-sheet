// @vitest-environment jsdom
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../components/editor/use-document-session", async () => ({ ...await vi.importActual("../components/editor/use-document-session"), requestJson: mocks.request }));
vi.mock("../components/editor/rich-editor", () => ({ Dialog: ({ children, title, onClose }: { children: ReactNode; title: string; onClose: () => void }) => createElement("div", { role: "dialog", "aria-label": title }, createElement("button", { type: "button", onClick: onClose, style: { minHeight: 44 } }, "Close dialog"), children) }));
import AttachmentTextDialog from "../components/attachment-text-dialog";

const hit = {
  filename: "scan.png", page: 2, snippet: "WARD note", versionId: "version-1", versionNo: 3, fileId: "file-1", recordId: "record-1",
  language: "en", status: "ocr-error", recognition: "ocr" as const, ocrError: true, ocrErrors: ["Unrecognized mark 1 on page 2"], exact: true, pinned: true,
  canDownload: true, canHistory: true,
};
const file = { fileId: "file-1", filename: "scan.png", versionId: "version-1", versionNo: 3, recordId: "record-1", status: "ocr-error", language: "en", version: 2, canReindex: true, canDownload: true, canHistory: true };
let cleanup: () => Promise<void>;
const posts: unknown[] = [];

beforeEach(() => {
  posts.length = 0;
  mocks.request.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") { posts.push(JSON.parse(String(init.body))); return { replayed: false }; }
    if (String(url).includes("view=config")) return { language: "en", enabled: true, version: 2, manage: true, boundary: "No generative model", assignment: "does not grant access", recoverableDraft: { language: "en", enabled: false, baseVersion: 2 } };
    if (String(url).includes("view=catalogue")) return { files: [file] };
    if (String(url).includes("view=preview")) return { ...hit, text: "WARD note exact" };
    if (String(url).includes("q=")) return { hits: [hit] };
    return { events: [] };
  });
});
afterEach(async () => { await cleanup?.(); vi.restoreAllMocks(); });

async function mount(onClose = () => undefined) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(AttachmentTextDialog, { workspaceId: "ws-aplyd", onClose })));
  cleanup = async () => { await act(async () => root.unmount()); host.remove(); };
  const button = (text: string) => Array.from(host.querySelectorAll("button")).find(item => item.textContent === text)!;
  const input = host.querySelector<HTMLInputElement>('[aria-label="Attachment text query"]')!;
  const setValue = (element: HTMLInputElement, value: string) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  };
  return { host, button, input, setValue };
}

it("searches from the keyboard, shows the OCR error, and opens the exact page", async () => {
  const view = await mount();
  expect(view.host.textContent).toContain("No generative model");
  expect(view.host.textContent).toContain("does not grant access");
  expect(view.host.textContent).toContain("recoverable draft");
  for (const button of view.host.querySelectorAll("button")) {
    expect(button.getAttribute("type")).toBe("button");
    expect(button.style.minHeight === "" || button.style.minHeight === "44px").toBe(true);
  }
  await act(async () => { view.setValue(view.input, "WARD"); });
  await act(async () => { view.button("Search attachments").click(); });
  expect(view.host.textContent).toContain("scan.png");
  expect(view.host.textContent).toContain("page 2");
  expect(view.host.textContent).toContain("OCR error: Unrecognized mark 1 on page 2");
  await act(async () => { view.button("Open page 2").click(); });
  expect(view.host.textContent).toContain("WARD note exact");
  expect(view.host.textContent).toContain("Opens this exact version");
  expect(view.button("Search attachments").style.minHeight).toBe("44px");
});

it("keeps cancel and the first reindex click from writing", async () => {
  const closed = vi.fn();
  const view = await mount(closed);
  await act(async () => { view.button("Reindex file").click(); });
  expect(posts).toEqual([]);
  await act(async () => { view.button("Cancel").click(); });
  expect(closed).toHaveBeenCalledOnce();
  expect(posts.some(item => (item as { action?: string }).action === "save")).toBe(false);
});
