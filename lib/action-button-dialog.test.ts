// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { vi } from "vitest";

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../components/editor/use-document-session", async () => ({ ...await vi.importActual("../components/editor/use-document-session"), requestJson: mocks.request }));
vi.mock("../components/editor/rich-editor", () => ({ Dialog: ({ children, title, onClose }: { children: ReactNode; title: string; onClose: () => void }) => createElement("div", { role: "dialog", "aria-label": title }, createElement("button", { type: "button", onClick: onClose, style: { minHeight: 44 } }, "Close dialog"), children) }));
import ActionButtonDialog from "../components/action-button-dialog";

const definition = {
  context: { collection: "organisations", placement: "record" as const },
  inputs: [{ id: "value", field: "core:notes", required: true, default: "Hello" }],
  target: { actionId: "hs.record.append-note", field: "core:notes", inputId: "value" },
  link: { linkId: "hs.record.open", inputId: "target" },
};
const legacy = {
  ...definition,
  target: { actionId: "hs.record.legacy-note", field: "core:notes", inputId: "value" },
};
const enabled = { id: "ab-1", collection: "organisations", label: "Add note", status: "active", version: 2, definition, availability: { enabled: true, reason: null }, recoverableDraft: { baseVersion: 2, definition } };
const disabled = { id: "ab-2", collection: "organisations", label: "Legacy note", status: "active", version: 1, definition: legacy, availability: { enabled: false, reason: "deprecated-target" } };
let cleanup: () => Promise<void>;
const posts: unknown[] = [];

beforeEach(() => {
  posts.length = 0;
  mocks.request.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts.push(JSON.parse(String(init.body)));
      return { replayed: false, previewId: "preview-1", action: "invoke", version: 2, plan: { actionId: "hs.record.append-note", field: "core:notes", linkId: "hs.record.open" }, actionStatus: "succeeded", linkStatus: "failed", source: "action-button", revision: 2, recoverable: true, id: "receipt-1", body: "# Action button\nAdd note" };
    }
    if (String(url).includes("view=search")) return { results: [{ id: "ab-1", label: "Add note", status: "active", version: 2 }] };
    if (String(url).includes("view=history")) return { events: [{ action: "invoke", actorName: "Ada", atIst: "03 Nov 2026, 09:00 IST", source: "action-button", revision: 2, actionId: "hs.record.append-note" }], receipts: [{ revision: 2, actionStatus: "succeeded", linkStatus: "failed" }] };
    return {
      manage: true,
      boundary: "Buttons run allowlisted Aplyd Pages action contracts only. They do not run scripts or open arbitrary URLs.",
      assignment: "Configuring or assigning an action button does not grant access to a page, record, collection, or field.",
      authority: "Seeing a button or belonging to the workspace does not grant the action.",
      review: "Review the impact.",
      schedules: "Existing schedules stay paused.",
      accounts: "Accounts still require an Organisation.",
      buttons: [enabled, disabled],
      collections: [{ id: "organisations", name: "Organisations" }],
      fields: [
        { collection: "organisations", key: "core:notes", label: "Notes", kind: "long-text", writable: true },
        { collection: "organisations", key: "core:registration", label: "Registration", kind: "text", writable: true },
      ],
    };
  });
});
afterEach(async () => { await cleanup?.(); vi.restoreAllMocks(); });

async function mount(onClose = () => undefined) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(ActionButtonDialog, { workspaceId: "ws-aplyd", pageId: "welcome", onClose })));
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

it("keeps action button controls on the keyboard and off the crowded action row", async () => {
  const view = await mount();
  expect(view.host.textContent).toContain("do not run scripts");
  expect(view.host.textContent).toContain("does not grant access");
  expect(view.host.textContent).toContain("does not grant the action");
  expect(view.host.textContent).toContain("Existing schedules stay paused");
  expect(view.host.textContent).toContain("A recoverable draft is kept");
  const legacy = view.button("Legacy note");
  expect(legacy.disabled).toBe(true);
  expect(legacy.getAttribute("aria-disabled")).toBe("true");
  expect(legacy.getAttribute("aria-label")).toContain("The target is deprecated.");
  expect(legacy.style.minHeight).toBe("44px");
  for (const button of view.host.querySelectorAll("button")) {
    expect(button.getAttribute("type")).toBe("button");
    expect(button.style.minHeight === "" || button.style.minHeight === "44px").toBe(true);
  }
  await act(async () => { view.setValue(view.input("Action label"), "Add note"); });
  await act(async () => { view.button("Create action button").click(); });
  expect(posts).toEqual([]);
  await act(async () => { view.button("Confirm new action button").click(); });
  expect(posts[0]).toMatchObject({ action: "create", label: "Add note", collection: "organisations" });
  expect(JSON.stringify(posts[0])).not.toContain("script");
  expect(JSON.stringify(posts[0])).not.toContain("http");
  await act(async () => { view.setValue(view.select("Action button"), "ab-1"); });
  await act(async () => { view.setValue(view.input("Action record id"), "00000000-0000-4000-8000-0000000000e1"); });
  await act(async () => { view.button("Review action").click(); });
  expect(posts.at(-1)).toMatchObject({ action: "preview", kind: "invoke" });
  await act(async () => { view.button("Confirm action").click(); });
  expect(posts.at(-1)).toMatchObject({ action: "apply", previewId: "preview-1" });
  expect(view.host.textContent).toContain("Action succeeded. Follow-up link failed.");
  expect(view.host.textContent).toContain("action-button");
  expect(view.host.textContent).toContain("The receipt is recoverable.");
  await act(async () => { view.setValue(view.input("Action search"), "Add"); });
  await act(async () => { view.button("Search action buttons").click(); });
  expect(view.host.textContent).toContain("Add note");
  const app = readFileSync("components/holy-sheet-app.tsx", "utf8");
  const start = app.indexOf('className="page-io-actions"');
  const io = app.slice(start, app.indexOf("</div>", start));
  expect(io).toContain("Export page");
  expect(io).not.toContain("Action buttons");
  expect(app).toContain(">Action buttons</button>");
  const css = readFileSync("app/workspace.css", "utf8");
  expect(css).toContain(".action-button-dialog .actions { display:flex; flex-wrap:wrap;");
  expect(css).toContain(".action-button-dialog label { display:flex; align-items:center; gap:.5rem; min-height:44px; }");
});

it("leaves saved action buttons unchanged when cancel is chosen before confirm", async () => {
  const closed = vi.fn();
  const view = await mount(closed);
  await act(async () => { view.button("Create action button").click(); });
  expect(posts).toEqual([]);
  await act(async () => { view.button("Cancel").click(); });
  expect(closed).toHaveBeenCalledOnce();
  expect(posts).toEqual([]);
});
