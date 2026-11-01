// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { readFileSync } from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import BulkRelationships from "../components/bulk-relationships";

const fetchMock = vi.fn();
const source = "00000000-0000-4000-8000-0000000000a1";
const target = "00000000-0000-4000-8000-0000000000b1";
const draftId = "00000000-0000-4000-8000-0000000000c1";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  document.body.replaceChildren();
});
const response = (body: unknown, status = 200, type = "application/json") => Promise.resolve(new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "Content-Type": type } }));

async function mount() {
  vi.stubGlobal("fetch", fetchMock);
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(BulkRelationships, { workspaceId: "ws-a", tenantId: "00000000-0000-4000-8000-000000000002", collection: "contacts", records: [{ id: source, name: "Ada Contact" }] })));
  return { host, dispose: async () => { await act(async () => root.unmount()); host.remove(); } };
}
function setValue(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}
const bodies = () => fetchMock.mock.calls.map((call) => JSON.parse(String(call[1].body)));

it("previews from the keyboard, cancels without saving, then confirms and recovers a draft", async () => {
  fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body));
    if (body.action === "list-drafts") return response({ drafts: [{ draftId, version: 2, payload: { collection: "contacts", sourceIds: [source], kind: "contact-account", operation: "add", targetId: target, role: "Buyer", primary: false, status: "active" } }] });
    if (body.action === "preview") return response({ previewToken: "ab".repeat(32), legalPartiesWillChange: false, counts: { success: 1, skipped: 0, error: 0 }, rows: [{ sourceId: source, sourceName: "Ada Contact", outcome: "success", code: "applied", message: "Link added.", contextReferences: [{ sourceApp: "sho", sourceType: "project", sourceId: "project-1" }], deletionConstraints: [{ code: "deletion_blocked", message: "Existing associations must be resolved before this record can be deleted." }], affectedContracts: [], hiddenAffectedContracts: false, legalPartiesWillChange: false }] });
    if (body.action === "execute") return response({ batchId: "00000000-0000-4000-8000-0000000000d1", replayed: false, legalPartiesWillChange: false, counts: { success: 1, skipped: 0, error: 0 }, rows: [{ sourceId: source, sourceName: "Ada Contact", outcome: "success", code: "applied", message: "Link added.", contextReferences: [], deletionConstraints: [], affectedContracts: [], hiddenAffectedContracts: false }] });
    if (body.action === "read-draft") return response({ draftId, version: 2, payload: { collection: "contacts", sourceIds: [source], kind: "contact-account", operation: "remove", targetId: target, role: "", primary: false, status: "active" } });
    if (body.action === "download") return response("batchId,sourceId,outcome,code,message\n", 200, "text/csv; charset=utf-8");
    return response({ draftId, version: 1, replayed: false });
  });
  const view = await mount();
  try {
    const css = readFileSync("app/globals.css", "utf8");
    expect(css).toContain(".bulk-relationships button,.bulk-relationships input,.bulk-relationships select{min-height:44px}");
    expect(css).toContain("@media(max-width:720px)");
    expect(view.host.querySelector("section[aria-label='Bulk relationships']")).toBeTruthy();
    expect([...view.host.querySelectorAll("button")].every((button) => button.tagName === "BUTTON")).toBe(true);
    await act(async () => view.host.querySelector<HTMLInputElement>(`input[aria-label="Select Ada Contact"]`)!.click());
    const targetInput = view.host.querySelector<HTMLInputElement>('input[aria-label="Target record ID"]')!;
    await act(async () => setValue(targetInput, target));
    const form = view.host.querySelector<HTMLFormElement>('form[aria-label="Relationship batch"]')!;
    await act(async () => form.requestSubmit());
    expect(view.host.textContent).toContain("Link added.");
    expect(view.host.textContent).toContain("Existing associations must be resolved");
    expect(view.host.textContent).toContain("Legal parties will not change.");
    await act(async () => [...view.host.querySelectorAll("button")].find((button) => button.textContent === "Cancel")!.click());
    expect(bodies().some((body) => body.action === "execute")).toBe(false);
    expect(view.host.textContent).toContain("Saved relationships were not changed.");
    await act(async () => form.requestSubmit());
    const confirmBox = [...view.host.querySelectorAll('input[type="checkbox"]')].find((input) => input.parentElement?.textContent?.includes("Confirm this impact")) as HTMLInputElement;
    await act(async () => confirmBox.click());
    await act(async () => [...view.host.querySelectorAll("button")].find((button) => button.textContent === "Apply to selected records")!.click());
    const executed = bodies().filter((body) => body.action === "execute");
    expect(executed).toHaveLength(1);
    expect(executed[0]).toMatchObject({ confirmed: true, targetId: target, sourceIds: [source], kind: "contact-account", operation: "add" });
    expect(view.host.textContent).toContain("00000000-0000-4000-8000-0000000000d1");
    const draftForm = view.host.querySelector<HTMLFormElement>('form[aria-label="Recover relationship draft"]')!;
    const draftSelect = draftForm.querySelector("select")!;
    const selectSetter = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
    await act(async () => {
      selectSetter?.call(draftSelect, draftId);
      draftSelect.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await act(async () => draftForm.requestSubmit());
    expect(bodies().some((body) => body.action === "read-draft" && body.draftId === draftId)).toBe(true);
    expect(view.host.textContent).toContain("Draft restored");
    const operation = view.host.querySelector<HTMLInputElement>('input[name="bulk-operation"][value="remove"]')!;
    expect(operation.checked).toBe(true);
  } finally {
    await view.dispose();
  }
});
