// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import LayoutManager from "../components/layout-manager";

const fetchMock = vi.fn();
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
const response = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
const tab = "00000000-0000-4000-8000-0000000000b1";
const section = "00000000-0000-4000-8000-0000000000b2";
const notesTab = "00000000-0000-4000-8000-0000000000b3";
const notesSection = "00000000-0000-4000-8000-0000000000b4";
const definition = { tabs: [
  { id: tab, label: "Overview", sections: [{ id: section, label: "Identity", description: "Who", columns: 1 as const, fields: [{ field: "name", mode: "edit" as const }, { field: "core:notes", mode: "edit" as const }] }] },
  { id: notesTab, label: "Notes", sections: [{ id: notesSection, label: "Narrative", description: "", columns: 2 as const, fields: [{ field: "core:domain", mode: "read" as const }] }] },
] };
const fields = [
  { key: "name", label: "Name", required: true, canWrite: true },
  { key: "core:notes", label: "Notes", required: false, canWrite: true },
  { key: "core:domain", label: "Domain", required: false, canWrite: true },
  { key: "core:code", label: "Code", required: true, canWrite: true },
];
const previewId = "00000000-0000-4000-8000-0000000000b5";
const hash = "cd".repeat(32);

async function mount() {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("fetch", fetchMock);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(LayoutManager, { workspaceId: "ws one", tenantId: "00000000-0000-4000-8000-000000000002", collection: "organisations" })));
  return { host, dispose: async () => { await act(async () => root.unmount()); host.remove(); } };
}
async function input(element: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
async function choose(element: HTMLSelectElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

it("arranges stable slots into a draft and publishes that review without record values", async () => {
  let saved = definition;
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    const body = init?.body ? JSON.parse(String(init.body)) : null;
    if (body?.kind === "save") { saved = body.definition; return response({ version: 3, replayed: false }); }
    if (body?.kind === "preview") return response({ previewId, reviewHash: hash, definition: saved, sourceVersion: 3, publicationRevision: 4, schemaVersion: 3 });
    if (body?.kind === "publish") return response({ publicationRevision: 5, replayed: false });
    return response({ draft: { draft: { definition }, draft_version: 2, publication_revision: 4 }, published: { schemaVersion: 3, fields, definition, canCreate: true } });
  });
  const view = await mount();
  try {
    expect(String(fetchMock.mock.calls[0][0])).toContain("includeDraft=1");
    expect(String(fetchMock.mock.calls[0][0])).not.toContain("recordId=");
    expect((view.host.querySelector('input[aria-label="Tab 1 label"]') as HTMLInputElement).value).toBe("Overview");
    expect(view.host.textContent).toContain("Code (required)");
    const notes = [...view.host.querySelectorAll("button")].filter((button) => button.textContent === "Move up")[1] as HTMLButtonElement;
    await act(async () => notes.click());
    await input(view.host.querySelector('input[aria-label="Tab 2 label"]') as HTMLInputElement, "Context");
    await choose(view.host.querySelector('select[aria-label="Add field to Identity"]') as HTMLSelectElement, "core:code");
    await act(async () => [...view.host.querySelectorAll("button")].find((button) => button.textContent === "Save draft")!.click());
    const save = JSON.parse(String(fetchMock.mock.calls.find((call) => call[1]?.method === "POST")![1].body));
    expect(save).toMatchObject({ kind: "save", collection: "organisations", expectedVersion: 2, expectedSchemaVersion: 3 });
    expect(save.definition.tabs[0].id).toBe(tab);
    expect(save.definition.tabs[0].sections[0].fields.map((slot: { field: string }) => slot.field)).toEqual(["core:notes", "name", "core:code"]);
    expect(save.definition.tabs[1]).toMatchObject({ id: notesTab, label: "Context", sections: [{ id: notesSection, columns: 2, fields: [{ field: "core:domain", mode: "read" }] }] });
    expect(save.values).toBeUndefined();
    expect(JSON.stringify(save)).not.toContain("salary");
    await act(async () => [...view.host.querySelectorAll("button")].find((button) => button.textContent === "Review publication")!.click());
    expect(view.host.querySelector('section[aria-label="Publication confirmation"]')).not.toBeNull();
    await input(view.host.querySelector('input[aria-label="Tab 2 label"]') as HTMLInputElement, "Changed again");
    expect(view.host.querySelector('section[aria-label="Publication confirmation"]')).toBeNull();
    await act(async () => [...view.host.querySelectorAll("button")].find((button) => button.textContent === "Review publication")!.click());
    await act(async () => [...view.host.querySelectorAll("button")].find((button) => button.textContent === "Publish reviewed layout")!.click());
    const sent = fetchMock.mock.calls.filter((call) => call[1]?.method === "POST").map((call) => JSON.parse(String(call[1].body)));
    expect(sent.at(-2)).toMatchObject({ kind: "preview", sourceVersion: 3, expectedPublicationRevision: 4, expectedSchemaVersion: 3 });
    expect(sent.at(-1)).toMatchObject({ kind: "publish", previewId, reviewHash: hash, confirm: "publish-record-layout" });
    expect(sent.at(-1).values).toBeUndefined();
    expect(view.host.textContent).toContain("Open forms keep their current layout");
  } finally { await view.dispose(); }
});

it("does not save a section that has no field", async () => {
  fetchMock.mockImplementation(() => response({ draft: { draft: { definition }, draft_version: 2, publication_revision: 4 }, published: { schemaVersion: 3, fields, definition, canCreate: true } }));
  const view = await mount();
  try {
    for (let count = 0; count < 3; count += 1) {
      const button = [...view.host.querySelectorAll("button")].find((item) => item.textContent === "Remove field") as HTMLButtonElement;
      await act(async () => button.click());
    }
    await act(async () => [...view.host.querySelectorAll("button")].find((button) => button.textContent === "Save draft")!.click());
    expect(view.host.textContent).toContain("at least one field");
    expect(fetchMock.mock.calls.some((call) => call[1]?.method === "POST")).toBe(false);
  } finally { await view.dispose(); }
});
it("shows a forbidden management response without draft fields", async () => {
  fetchMock.mockResolvedValueOnce(await response({ error: "The layout is unavailable or changed. Review the current draft." }, 403));
  const view = await mount();
  try {
    expect(view.host.textContent).toContain("The layout is unavailable or changed. Review the current draft.");
    expect(view.host.textContent).not.toContain("Unpublished salary");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  } finally { await view.dispose(); }
});
