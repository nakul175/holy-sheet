// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../components/editor/use-document-session", async () => ({ ...await vi.importActual("../components/editor/use-document-session"), requestJson: mocks.request }));
vi.mock("../components/editor/rich-editor", () => ({ Dialog: ({ children, title, onClose }: { children: ReactNode; title: string; onClose: () => void }) => createElement("div", { role: "dialog", "aria-label": title }, createElement("button", { type: "button", onClick: onClose, style: { minHeight: 44, minWidth: 44 } }, "Close dialog"), children) }));
import IntakeFormDialog from "../components/intake-form-dialog";

const form = { id: "form-1", name: "Clinic intake", status: "draft", version: 2, sharing: "off", audience: "public", queue: "clinic-intake", anonymous: false };
let cleanup: () => Promise<void>;
const posts: unknown[] = [];

beforeEach(() => {
  posts.length = 0;
  mocks.request.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts.push(JSON.parse(String(init.body)));
      return { audience: "public", sharing: "off", accessGranted: false, activated: false, queue: { name: "clinic-intake", private: true }, body: "# Intake\nSharing: off." };
    }
    if (String(url).includes("view=search")) return { results: [form] };
    if (String(url).includes("view=history")) return { events: [{ action: "configure", source: "intake-form", atIst: "03 Nov 2026, 09:00 IST" }] };
    return {
      manage: true,
      boundary: "An intake form accepts allowlisted fields into a private queue.",
      assignment: "Configuring a form, naming a manager, or assigning a queue does not grant access.",
      anonymousPolicy: "Anonymous intake is optional only when an administrator sets an explicit policy.",
      activation: "No external form is activated by this task.",
      quarantine: "Untrusted intake stays in quarantine until a permitted reviewer commits it.",
      schedules: "Existing schedules stay paused.",
      recoverable: "A recoverable draft is kept when the version changes.",
      edge: "Intake responses stay with the tenant and use cache no-store.",
      receipt: "Received. This receipt does not confirm a record was created.",
      sharing: "off",
      accessGranted: false,
      activated: false,
      anonymousAllowed: false,
      forms: [form],
      drafts: [{ formKey: "form-1", kind: "configure" }],
    };
  });
});
afterEach(async () => { await cleanup?.(); vi.restoreAllMocks(); });

async function mount(onClose = () => undefined) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(IntakeFormDialog, { workspaceId: "ws-aplyd", onClose })));
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

it("keeps intake actions on the keyboard and at least 44px, off the export row", async () => {
  const view = await mount();
  expect(view.host.textContent).toContain("does not grant access");
  expect(view.host.textContent).toContain("explicit policy");
  expect(view.host.textContent).toContain("No external form is activated");
  expect(view.host.textContent).toContain("stays in quarantine");
  expect(view.host.textContent).toContain("Existing schedules stay paused");
  expect(view.host.textContent).toContain("A recoverable draft is kept");
  expect(view.host.textContent).toContain("cache no-store");
  for (const button of view.host.querySelectorAll("button")) {
    expect(button.getAttribute("type")).toBe("button");
    const height = button.style.minHeight;
    expect(height === "" || height === "44px").toBe(true);
    if (height === "44px") expect(button.style.minWidth === "44px" || button.style.minWidth === "").toBe(true);
  }
  expect(view.host.querySelectorAll("button").length).toBeGreaterThan(3);
  await act(async () => { view.setValue(view.input("Form name"), "Clinic intake"); view.setValue(view.input("Private queue"), "clinic-intake"); });
  await act(async () => { view.button("Review form").click(); });
  expect(posts).toEqual([]);
  await act(async () => { view.button("Confirm form").click(); });
  expect(posts[0]).toMatchObject({ action: "configure", name: "Clinic intake" });
  expect(JSON.stringify(posts[0])).toContain("\"private\":true");
  expect(JSON.stringify(posts[0])).toContain("\"audience\":\"public\"");
  expect(JSON.stringify(posts[0])).toContain("\"anonymous\":false");
  expect(JSON.stringify(posts[0])).toContain("\"public\":false");
  await act(async () => { view.setValue(view.select("Saved form"), "form-1"); });
  await act(async () => { view.button("Preview form").click(); });
  expect(posts.at(-1)).toMatchObject({ action: "preview", formId: "form-1" });
  await act(async () => { view.button("Disable form").click(); });
  expect(posts.at(-1)).toMatchObject({ action: "preview" });
  await act(async () => { view.button("Confirm disable").click(); });
  expect(posts.at(-1)).toMatchObject({ action: "disable" });
  await act(async () => { view.setValue(view.input("Form search"), "Clinic"); });
  await act(async () => { view.button("Search forms").click(); });
  expect(view.host.textContent).toContain("Clinic intake");
  await act(async () => { view.button("Form history").click(); });
  expect(view.host.textContent).toContain("intake-form");
  const app = readFileSync("components/holy-sheet-app.tsx", "utf8");
  const start = app.indexOf('className="page-io-actions"');
  const io = app.slice(start, app.indexOf("</div>", start));
  expect(io).toContain("Export page");
  expect(io).not.toContain("Intake forms");
  expect(app).toContain(">Intake forms</button>");
  const css = readFileSync("app/workspace.css", "utf8");
  expect(css).toContain(".intake-form-dialog .actions { display:flex; flex-wrap:wrap;");
  expect(css).toContain(".intake-form-dialog label { display:flex; align-items:center; gap:.5rem; min-height:44px; }");
  expect(css).toContain("@media (max-width:360px)");
});

it("leaves a form unchanged when cancel is chosen before confirm", async () => {
  const closed = vi.fn();
  const view = await mount(closed);
  await act(async () => { view.button("Review form").click(); });
  expect(posts).toEqual([]);
  await act(async () => { view.button("Cancel").click(); });
  expect(closed).toHaveBeenCalledOnce();
  expect(posts).toEqual([]);
});
