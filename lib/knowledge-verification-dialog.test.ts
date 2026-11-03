// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act, createElement, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../components/editor/use-document-session", async () => ({ ...await vi.importActual("../components/editor/use-document-session"), requestJson: mocks.request }));
vi.mock("../components/editor/rich-editor", () => ({ Dialog: ({ children, title, onClose }: { children: ReactNode; title: string; onClose: () => void }) => createElement("div", { role: "dialog", "aria-label": title }, createElement("button", { type: "button", onClick: onClose, style: { minHeight: 44 } }, "Close dialog"), children) }));
import KnowledgeVerificationDialog from "../components/knowledge-verification-dialog";

const badge = {
  id: "badge-1", targetKind: "page", targetId: "page-1", title: "Clinic handbook", status: "current", label: "Verified", version: 1,
  owner: "Ada", basis: "source-reviewed", basisNote: "Read the source", expiryDays: 90, attestedRevision: 2, titleChanged: false,
  titleOnlyRule: "A title-only change keeps the badge current. A change to the body or to the recorded source marks the badge stale.",
  statement: "Steward attestation of one published revision. Not an AI truth score. Not a legal certification.",
  reason: null,
  recoverableDraft: { baseVersion: 1, payload: { basisNote: "Kept" } },
};
let cleanup: () => Promise<void>;
const posts: unknown[] = [];

beforeEach(() => {
  posts.length = 0;
  mocks.request.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      posts.push(body);
      if (body.action === "preview") return { previewId: "preview-1", action: body.kind, review: "Review the attestation.", version: body.expectedVersion };
      if (body.action === "download") return { body: "# Knowledge verification\nNot a legal certification", version: 1 };
      return { reported: true };
    }
    if (String(url).includes("view=search")) return { results: [{ id: "badge-1", title: "Clinic handbook", label: "Verified", status: "current" }] };
    if (String(url).includes("view=history")) return { events: [{ action: "concern", actorName: "Rae", atIst: "03 Nov 2026, 09:00 IST", source: "knowledge-verification", reason: "Hours disagree" }] };
    if (String(url).includes("view=source")) return { excerpt: "Clinic hours", badge: { label: "Verified", statement: "Not an AI truth score. Not a legal certification." } };
    return {
      manage: true, steward: true,
      boundary: "Verification is a steward attestation of one published revision. It is not an AI truth score and it is not a legal certification.",
      assignment: "Configuring verification or naming a steward does not grant access to a page, record, collection, or field.",
      titleOnlyRule: badge.titleOnlyRule,
      statement: badge.statement,
      schedules: "Existing schedules stay paused. Verification does not activate a schedule.",
      recoverable: "A recoverable draft is kept when the version changes.",
      policy: { version: 1, bases: ["source-reviewed"], defaultExpiryDays: 90, titleOnlyPolicy: "preserve", recoverableDraft: null },
      badges: [badge],
      members: [{ id: "ada", name: "Ada" }],
    };
  });
});
afterEach(async () => { await cleanup?.(); vi.restoreAllMocks(); });

async function mount(onClose = () => undefined) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(KnowledgeVerificationDialog, { workspaceId: "ws-aplyd", pageId: "page-1", onClose })));
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

it("keeps verification actions on the keyboard and off the crowded export row", async () => {
  const view = await mount();
  expect(view.host.textContent).toContain("not an AI truth score");
  expect(view.host.textContent).toContain("not a legal certification");
  expect(view.host.textContent).toContain("does not grant access");
  expect(view.host.textContent).toContain("title-only change keeps the badge current");
  expect(view.host.textContent).toContain("Existing schedules stay paused");
  expect(view.host.textContent).toContain("A recoverable draft is kept");
  for (const button of view.host.querySelectorAll("button")) {
    expect(button.getAttribute("type")).toBe("button");
    expect(button.style.minHeight === "" || button.style.minHeight === "44px").toBe(true);
  }
  await act(async () => { view.button("Review verification").click(); });
  expect(posts).toEqual([]);
  await act(async () => { view.button("Confirm review").click(); });
  expect(posts.at(-1)).toMatchObject({ action: "preview", kind: "verify" });
  await act(async () => { view.button("Confirm verification").click(); });
  expect(posts.at(-1)).toMatchObject({ action: "apply", previewId: "preview-1" });
  await act(async () => { view.setValue(view.select("Verification badge"), "badge-1"); });
  expect(view.host.textContent).toContain("Owner Ada");
  expect(view.host.textContent).toContain("source-reviewed");
  expect(view.host.textContent).toContain("Revision 2");
  await act(async () => { view.setValue(view.input("Verification reason"), "Hours disagree"); });
  await act(async () => { view.button("Report concern").click(); });
  expect(posts.filter(item => (item as { action?: string }).action === "report")).toEqual([]);
  await act(async () => { view.button("Confirm concern").click(); });
  expect(posts.at(-1)).toMatchObject({ action: "report", reason: "Hours disagree" });
  await act(async () => { view.setValue(view.input("Verification search"), "Clinic"); });
  await act(async () => { view.button("Search verification").click(); });
  expect(view.host.textContent).toContain("Clinic handbook");
  await act(async () => { view.button("Verification history").click(); });
  expect(view.host.textContent).toContain("knowledge-verification");
  await act(async () => { view.button("Source preview").click(); });
  expect(view.host.textContent).toContain("Not an AI truth score");
  const app = readFileSync("components/holy-sheet-app.tsx", "utf8");
  const start = app.indexOf('className="page-io-actions"');
  const io = app.slice(start, app.indexOf("</div>", start));
  expect(io).toContain("Export page");
  expect(io).not.toContain("Verification");
  expect(app).toContain(">Verification</button>");
  const css = readFileSync("app/workspace.css", "utf8");
  expect(css).toContain(".knowledge-verification-dialog .actions { display:flex; flex-wrap:wrap;");
  expect(css).toContain(".knowledge-verification-dialog label { display:flex; align-items:center; gap:.5rem; min-height:44px; }");
});

it("leaves verification unchanged when cancel is chosen before confirm", async () => {
  const closed = vi.fn();
  const view = await mount(closed);
  await act(async () => { view.button("Review verification").click(); });
  expect(posts).toEqual([]);
  await act(async () => { view.button("Cancel").click(); });
  expect(closed).toHaveBeenCalledOnce();
  expect(posts).toEqual([]);
});
