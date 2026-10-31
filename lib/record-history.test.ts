// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import RecordHistory from "../components/record-history";

const fetchMock = vi.fn();
const recordId = "00000000-0000-4000-8000-0000000000a1";
const eventId = "00000000-0000-4000-8000-0000000000e1";
const olderId = "00000000-0000-4000-8000-0000000000e5";
const previewId = "00000000-0000-4000-8000-0000000000e3";
const operationId = "00000000-0000-4000-8000-0000000000aa";
const notes = "core:notes";
const attachment = "00000000-0000-4000-8000-0000000000f1";
const hash = "cd".repeat(32);
const cursor = "b".repeat(43);
const secret = "Do not submit this text";
const restored = vi.fn();
const event = (id: string, version: number) => ({
  id,
  version,
  actorId: "actor-1",
  sourceApp: "holy-sheet",
  serviceSubject: null,
  operationId: "00000000-0000-4000-8000-0000000000e2",
  kind: "update",
  batchId: "00000000-0000-4000-8000-0000000000b1",
  sourceRow: 4,
  at: "2026-10-31T01:02:03.000Z",
  before: { name: "Original", values: { [notes]: "Old note", [attachment]: [recordId] } },
  after: { name: "Current", values: { [notes]: secret, [attachment]: [recordId] } },
});
const fields = [
  { key: notes, label: "Notes", kind: "long-text", canWrite: true, canHistory: true },
  { key: attachment, label: "Brief", kind: "attachment", canWrite: true, canHistory: true },
  { key: "core:email", label: "Email", kind: "email", canWrite: false, canHistory: true },
];
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
  restored.mockReset();
});
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
async function mount(canRestore = true) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("fetch", fetchMock);
  const host = document.createElement("div");
  document.body.append(host);
  const root: Root = createRoot(host);
  await act(async () => root.render(createElement(RecordHistory, {
    workspaceId: "ws one",
    tenantId: "00000000-0000-4000-8000-000000000002",
    recordId,
    recordVersion: 4,
    canRestore,
    fields,
    onRestored: restored,
  })));
  return { host, dispose: async () => { await act(async () => root.unmount()); host.remove(); } };
}
async function click(host: ParentNode, name: string) {
  const button = [...host.querySelectorAll("button")].find((item) => item.textContent === name) as HTMLButtonElement;
  await act(async () => { button.click(); });
}
async function choose(host: ParentNode, value: string) {
  const element = host.querySelector("select") as HTMLSelectElement;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
function posted() {
  return fetchMock.mock.calls.filter((call) => call[1]?.method === "POST").map((call) => JSON.parse(String(call[1].body)));
}
const preview = {
  previewId,
  reviewHash: hash,
  recordId,
  expectedVersion: 4,
  sourceVersion: 2,
  side: "before",
  fields: ["name", notes],
  before: { name: "Current", values: { [notes]: secret } },
  after: { name: "Original", values: { [notes]: "Old note" } },
};

it("shows UTC history metadata and withholds restore without both edit and restore-values", async () => {
  fetchMock.mockImplementation(() => json({ anchorVersion: 4, nextCursor: null, events: [event(eventId, 2)] }));
  const view = await mount(false);
  try {
    expect(view.host.textContent).toContain("2026-10-31T01:02:03.000Z UTC");
    expect(view.host.textContent).toContain("Actor actor-1");
    expect(view.host.textContent).toContain("Import batch");
    expect(view.host.textContent).toContain("source row 4");
    expect(view.host.textContent).toContain("Old note");
    expect(view.host.textContent).toContain("also needs edit and restore-values");
    expect(view.host.querySelector("form")).toBeNull();
    expect(fetchMock.mock.calls.some((call) => String(call[0]).includes("/history") && call[1]?.method === "POST")).toBe(false);
  } finally {
    await view.dispose();
  }
});

it("reviews stored fields only and retries the same restore operation", async () => {
  vi.spyOn(crypto, "randomUUID").mockReturnValue(operationId);
  let attempts = 0;
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      if (body.kind === "preview") return json(preview);
      attempts += 1;
      return attempts === 1
        ? json({ error: "Service temporarily unavailable.", code: "service_unavailable", retryable: true }, 503)
        : json({ appliedVersion: 5, replayed: false, record: { id: recordId, values: { [notes]: secret } } });
    }
    return json({ anchorVersion: 4, nextCursor: cursor, events: [event(eventId, 4)] });
  });
  const view = await mount();
  try {
    await choose(view.host, eventId);
    const before = [...view.host.querySelectorAll('input[type="radio"]')].find((item) => item.getAttribute("value") === "before") as HTMLInputElement;
    await act(async () => { before.click(); });
    const boxes = [...view.host.querySelectorAll('form[aria-label="Restore selected values"] input[type="checkbox"]')] as HTMLInputElement[];
    expect(boxes.map((box) => box.parentElement?.textContent?.trim())).toEqual(["Name", "Notes"]);
    await act(async () => { boxes[0].click(); boxes[1].click(); });
    await click(view.host, "Review selected values");
    expect(posted()[0]).toEqual({ kind: "preview", eventId, side: "before", fields: ["name", notes], expectedVersion: 4 });
    expect(JSON.stringify(posted()[0])).not.toContain(secret);
    expect(view.host.textContent).toContain("Old note");
    const confirm = view.host.querySelector('section[aria-label="Restore review"] input[type="checkbox"]') as HTMLInputElement;
    await act(async () => { confirm.click(); });
    await click(view.host, "Restore selected values");
    expect(view.host.textContent).toContain("Retry the same restore");
    await click(view.host, "Retry the same restore");
    expect(posted().slice(1)).toEqual([
      { kind: "apply", previewId, reviewHash: hash, operationId, confirm: "restore-selected-values" },
      { kind: "apply", previewId, reviewHash: hash, operationId, confirm: "restore-selected-values" },
    ]);
    expect(restored).toHaveBeenCalledWith({ appliedVersion: 5, replayed: false });
    expect(fetchMock.mock.calls[0][1]).toMatchObject({ credentials: "same-origin", cache: "no-store" });
  } finally {
    await view.dispose();
  }
});

it("pages older changes with the cursor and asks for a fresh review after a conflict", async () => {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (init?.method === "POST") return json({ error: "The record changed.", code: "record_history_conflict" }, 409);
    if (String(url).includes("cursor=")) return json({ anchorVersion: 4, nextCursor: null, events: [event(olderId, 1)] });
    return json({ anchorVersion: 4, nextCursor: cursor, events: [event(eventId, 4)] });
  });
  const view = await mount();
  try {
    await click(view.host, "Older changes");
    expect(String(fetchMock.mock.calls.at(-1)?.[0])).toContain(`cursor=${cursor}`);
    expect(view.host.textContent).toContain("version 4");
    expect(view.host.textContent).toContain("version 1");
    await choose(view.host, eventId);
    const name = view.host.querySelector('form[aria-label="Restore selected values"] input[type="checkbox"]') as HTMLInputElement;
    await act(async () => { name.click(); });
    await click(view.host, "Review selected values");
    expect(view.host.textContent).toContain("Review the selection again");
    expect(view.host.querySelector('section[aria-label="Restore review"]')).toBeNull();
  } finally {
    await view.dispose();
  }
});
