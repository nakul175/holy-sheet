// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../components/editor/use-document-session", async () => ({ ...await vi.importActual("../components/editor/use-document-session"), requestJson: mocks.request }));
vi.mock("../components/editor/rich-editor", () => ({ Dialog: ({ children, title, onClose }: { children: ReactNode; title: string; onClose: () => void }) => createElement("div", { role: "dialog", "aria-label": title }, createElement("button", { type: "button", onClick: onClose, style: { minHeight: 44 } }, "Close dialog"), children) }));
import WorkflowAutomationDialog from "../components/workflow-automation-dialog";

const definition = { trigger: { event: "record.created" }, conditions: { all: [] }, actions: [{ type: "set-field", field: "core:notes", value: "Hello" }], identity: { kind: "delegated" as const, subjectId: "user-1" } };
const workflow = { id: "wf-1", collection: "organisations", name: "Notes draft", status: "draft", version: 1, definition, recoverableDraft: { baseVersion: 1, definition } };
let cleanup: () => Promise<void>;
const posts: unknown[] = [];

beforeEach(() => {
  posts.length = 0;
  mocks.request.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") { posts.push(JSON.parse(String(init.body))); return { replayed: false, previewId: "preview-1", version: 1, plan: null, body: "# Workflow\nNotes draft" }; }
    if (String(url).includes("view=search")) return { results: [{ id: "wf-1", name: "Notes draft", status: "draft", version: 1 }] };
    if (String(url).includes("view=history")) return { events: [{ action: "create", actorName: "Ada", atIst: "03 Nov 2026, 09:00 IST", source: "workflow-automation", outcome: null }], runs: [] };
    return {
      manage: true,
      boundary: "Deterministic triggers, conditions, and actions only. No AI agent runs a workflow.",
      assignment: "Configuring or assigning a workflow does not grant access to a page, record, collection, or field.",
      review: "Review the impact.",
      schedules: "Existing schedules stay paused.",
      accounts: "Accounts still require an Organisation.",
      workflows: [workflow],
      collections: [{ id: "organisations", name: "Organisations" }],
      fields: [{ collection: "organisations", key: "core:notes", label: "Notes", kind: "long-text", writable: true }],
      colleagues: [{ id: "user-1", name: "Ada" }],
    };
  });
});
afterEach(async () => { await cleanup?.(); vi.restoreAllMocks(); });

async function mount(onClose = () => undefined) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(WorkflowAutomationDialog, { workspaceId: "ws-aplyd", onClose })));
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

it("keeps workflow controls on the keyboard and off the crowded action row", async () => {
  const view = await mount();
  expect(view.host.textContent).toContain("No AI agent");
  expect(view.host.textContent).toContain("does not grant access");
  expect(view.host.textContent).toContain("Existing schedules stay paused");
  expect(view.host.textContent).toContain("Accounts still require an Organisation");
  expect(view.host.textContent).toContain("A recoverable draft is kept");
  for (const button of view.host.querySelectorAll("button")) {
    expect(button.getAttribute("type")).toBe("button");
    expect(button.style.minHeight === "" || button.style.minHeight === "44px").toBe(true);
  }
  await act(async () => { view.setValue(view.input("Workflow name"), "Notes"); });
  await act(async () => { view.button("Create workflow").click(); });
  expect(posts).toEqual([]);
  await act(async () => { view.button("Confirm new workflow").click(); });
  expect(posts[0]).toMatchObject({ action: "create", name: "Notes", collection: "organisations" });
  await act(async () => { view.setValue(view.input("Workflow search"), "Notes"); });
  await act(async () => { view.button("Search workflows").click(); });
  expect(view.host.textContent).toContain("Notes draft");
  expect(view.button("Dry-run").style.minHeight).toBe("44px");
  const app = readFileSync("components/holy-sheet-app.tsx", "utf8");
  const start = app.indexOf('className="page-io-actions"');
  const io = app.slice(start, app.indexOf("</div>", start));
  expect(io).toContain("Export page");
  expect(io).not.toContain("Workflows");
  expect(app).toContain(">Workflows</button>");
  const css = readFileSync("app/workspace.css", "utf8");
  expect(css).not.toMatch(/\.page-io-actions \{[^}]*flex-wrap/);
  expect(css).toMatch(/\.page-io-actions \{[^}]*z-index:7/);
  expect(css).toContain(".workflow-dialog .actions { display:flex; flex-wrap:wrap;");
});

it("leaves saved workflows unchanged when cancel is chosen before confirm", async () => {
  const closed = vi.fn();
  const view = await mount(closed);
  await act(async () => { view.button("Create workflow").click(); });
  expect(posts).toEqual([]);
  await act(async () => { view.button("Cancel").click(); });
  expect(closed).toHaveBeenCalledOnce();
  expect(posts).toEqual([]);
});
