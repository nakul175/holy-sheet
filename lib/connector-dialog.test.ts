// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../components/editor/use-document-session", async () => ({ ...await vi.importActual("../components/editor/use-document-session"), requestJson: mocks.request }));
vi.mock("../components/editor/rich-editor", () => ({ Dialog: ({ children, title, onClose }: { children: ReactNode; title: string; onClose: () => void }) => createElement("div", { role: "dialog", "aria-label": title }, createElement("button", { type: "button", onClick: onClose, style: { minHeight: 44, minWidth: 44 } }, "Close dialog"), children) }));
import ConnectorDialog from "../components/connector-dialog";

const connector = { id: "connector-1", name: "Clinic connector", status: "enabled", version: 2, sharing: "off", type: "records", direction: "read-write", source: "clinic-source", residency: "tenant", health: "ready", writesStopped: false, liveActivation: false, secretVisible: false, schedulesPaused: true };
let cleanup: () => Promise<void>;
const posts: unknown[] = [];

beforeEach(() => {
  posts.length = 0;
  mocks.request.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      posts.push(JSON.parse(String(init.body)));
      return { direction: "read-write", sharing: "off", accessGranted: false, dryRun: true, canonicalMutated: false, liveActivation: false, secretVisible: false, type: "records", scope: { source: "clinic-source" }, body: "# Connector\nSharing: off.\nValue hidden." };
    }
    if (String(url).includes("view=search")) return { results: [connector] };
    if (String(url).includes("view=history")) return { events: [{ action: "preview", source: "governed-connector", atIst: "03 Nov 2026, 09:00 IST" }] };
    return {
      boundary: "A connector registers an approved type, tenant source, stable identifiers, and an explicit direction.",
      assignment: "Configuring a connector, naming a manager, or assigning a source does not grant access.",
      secrets: "Runtime credentials stay in the suite secret store.",
      delegation: "Runtime uses the delegated user and app rights and field ownership.",
      activation: "No connector is activated by this task.",
      schedules: "Existing schedules stay paused.",
      recoverable: "A recoverable draft is kept when the version changes.",
      edge: "Connector responses stay with the tenant and use cache no-store.",
      canonical: "Pause and disconnect keep canonical records unchanged and stop later writes.",
      secretStore: "suite-secret-store",
      connectors: [connector],
      drafts: [{ connectorKey: "connector-1", kind: "configure" }],
    };
  });
});
afterEach(async () => { await cleanup?.(); vi.restoreAllMocks(); });

async function mount(onClose = () => undefined) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(ConnectorDialog, { workspaceId: "ws-aplyd", onClose })));
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

it("keeps connector actions on the keyboard and at least 44px, off the export row", async () => {
  const view = await mount();
  expect(view.host.textContent).toContain("does not grant access");
  expect(view.host.textContent).toContain("suite secret store");
  expect(view.host.textContent).toContain("The value is hidden");
  expect(view.host.textContent).toContain("No connector is activated");
  expect(view.host.textContent).toContain("Existing schedules stay paused");
  expect(view.host.textContent).toContain("A recoverable draft is kept");
  expect(view.host.textContent).toContain("cache no-store");
  expect(view.host.textContent).not.toContain("hs-secret");
  for (const button of view.host.querySelectorAll("button")) {
    expect(button.getAttribute("type")).toBe("button");
    const height = button.style.minHeight;
    expect(height === "" || height === "44px").toBe(true);
    if (height === "44px") expect(button.style.minWidth === "44px" || button.style.minWidth === "").toBe(true);
  }
  expect(view.host.querySelectorAll("button").length).toBeGreaterThan(3);
  await act(async () => { view.setValue(view.input("Connector name"), "Clinic connector"); view.setValue(view.input("Secret reference"), "suite-secret:clinic-sync"); });
  await act(async () => { view.button("Review connector").click(); });
  expect(posts).toEqual([]);
  await act(async () => { view.button("Confirm connector").click(); });
  expect(posts[0]).toMatchObject({ action: "configure", name: "Clinic connector" });
  expect(JSON.stringify(posts[0])).toContain("\"direction\":\"read-write\"");
  expect(JSON.stringify(posts[0])).toContain("\"public\":false");
  await act(async () => { view.setValue(view.select("Saved connector"), "connector-1"); });
  expect(view.host.textContent).toContain("Residency tenant");
  expect(view.host.textContent).toContain("Secret visible no");
  await act(async () => { view.button("Dry-run preview").click(); });
  expect(posts.at(-1)).toMatchObject({ action: "preview", connectorId: "connector-1" });
  await act(async () => { view.button("Pause connector").click(); });
  expect(posts.at(-1)).toMatchObject({ action: "preview" });
  await act(async () => { view.button("Confirm pause").click(); });
  expect(posts.at(-1)).toMatchObject({ action: "pause" });
  await act(async () => { view.button("Review enable").click(); });
  await act(async () => { view.button("Confirm enable").click(); });
  expect(posts.at(-1)).toMatchObject({ action: "enable" });
  await act(async () => { view.button("Disconnect connector").click(); });
  await act(async () => { view.button("Confirm disconnect").click(); });
  expect(posts.at(-1)).toMatchObject({ action: "disconnect" });
  await act(async () => { view.setValue(view.input("Connector search"), "Clinic"); });
  await act(async () => { view.button("Search connectors").click(); });
  expect(view.host.textContent).toContain("Clinic connector");
  await act(async () => { view.button("Connector history").click(); });
  expect(view.host.textContent).toContain("governed-connector");
  const app = readFileSync("components/holy-sheet-app.tsx", "utf8");
  const start = app.indexOf('className="page-io-actions"');
  const io = app.slice(start, app.indexOf("</div>", start));
  expect(io).toContain("Export page");
  expect(io).not.toContain("Connectors");
  expect(app).toContain(">Connectors</button>");
  const css = readFileSync("app/workspace.css", "utf8");
  expect(css).toContain(".connector-dialog .actions { display:flex; flex-wrap:wrap;");
  expect(css).toContain(".connector-dialog label { display:flex; align-items:center; gap:.5rem; min-height:44px; }");
  expect(css).toContain("@media (max-width:360px)");
});

it("leaves a connector unchanged when cancel is chosen before confirm", async () => {
  const closed = vi.fn();
  const view = await mount(closed);
  await act(async () => { view.button("Review connector").click(); });
  expect(posts).toEqual([]);
  await act(async () => { view.button("Cancel").click(); });
  expect(closed).toHaveBeenCalledOnce();
  expect(posts).toEqual([]);
});
