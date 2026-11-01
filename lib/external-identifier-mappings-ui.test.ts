// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import ExternalIdentifierMappings from "../components/external-identifier-mappings";

const fetchMock = vi.fn();
const recordId = "00000000-0000-4000-8000-000000000011";
const mappingId = "00000000-0000-4000-8000-000000000012";
const previewId = "00000000-0000-4000-8000-000000000013";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
const mapping = { id: mappingId, namespace: "billing.app", externalId: "cust-1", recordId, originalRecordId: recordId, state: "active", version: 2, provenanceLabel: "billing import", atIst: "01 Nov 2026, 12:00 IST", canWrite: true, canExport: true, canHistory: true, credentialsStored: false, accessGranted: false };

async function mount() {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("fetch", fetchMock);
  const host = document.createElement("div");
  document.body.append(host);
  const root: Root = createRoot(host);
  await act(async () => root.render(createElement(ExternalIdentifierMappings, { workspaceId: "ws one", tenantId: "00000000-0000-4000-8000-000000000002", collection: "organisations", recordId })));
  return host;
}
function button(host: ParentNode, name: string) {
  const found = [...host.querySelectorAll("button")].find((item) => item.textContent === name) as HTMLButtonElement | undefined;
  expect(found, name).toBeTruthy();
  return found!;
}
function field(host: ParentNode, name: string) {
  const input = [...host.querySelectorAll("label")].find((label) => label.textContent?.includes(name))?.querySelector("input");
  expect(input, name).toBeTruthy();
  return input as HTMLInputElement;
}
function type(input: HTMLInputElement, value: string) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
}

it("opens from the keyboard, blocks a credential, and requires explicit reassignment", async () => {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = String(init?.body ?? "");
    if (method === "GET" && String(url).includes("/external-identifiers?")) return json({ mappings: [mapping], drafts: [], credentialsStored: false, accessGranted: false });
    if (body.includes('"preview"')) return json({ previewId, reviewHash: "a".repeat(64), impact: "This connects an external identifier to the canonical record. It does not grant access or store a credential.", conflict: { reviewable: true, mappingId, recordId: "00000000-0000-4000-8000-000000000099", state: "active", version: 2 }, namespace: "billing.app", externalId: "cust-2", provenanceLabel: "" });
    if (body.includes('"register"')) return json({ replayed: false, action: "reassign", credentialsStored: false, accessGranted: false });
    return json({ error: "unexpected" }, 500);
  });
  const host = await mount();
  expect(fetchMock).not.toHaveBeenCalled();
  await act(async () => button(host, "External identifiers").click());
  expect(host.textContent).toContain("does not grant access");
  expect(host.textContent).toContain("cust-1");
  expect(host.querySelector("a.external-identifier-link")?.getAttribute("href")).toContain("recordId=");
  const external = field(host, "External ID");
  const namespace = field(host, "Integration namespace");
  await act(async () => {
    type(namespace, "billing.app");
    type(external, "api_key=live");
    host.querySelector<HTMLFormElement>('form[aria-label="Connect external identifier"]')!.requestSubmit();
  });
  expect(host.textContent).toContain("credential");
  expect(fetchMock.mock.calls.some((call) => String(call[1]?.body ?? "").includes("api_key"))).toBe(false);
  await act(async () => {
    type(external, "cust-2");
    host.querySelector<HTMLFormElement>('form[aria-label="Connect external identifier"]')!.requestSubmit();
  });
  expect(host.textContent).toContain("already connected");
  expect(button(host, "Confirm connection").disabled).toBe(false);
  const reassign = [...host.querySelectorAll("label")].find((label) => label.textContent?.includes("Reassign to this record"))?.querySelector("input");
  expect([...host.querySelectorAll("label")].some((label) => label.textContent?.includes("I confirm this reassignment"))).toBe(false);
  await act(async () => reassign!.click());
  expect(button(host, "Confirm connection").disabled).toBe(true);
  const armed = [...host.querySelectorAll("label")].find((label) => label.textContent?.includes("I confirm this reassignment"))?.querySelector("input") as HTMLInputElement;
  await act(async () => {
    armed.click();
    host.querySelector<HTMLFormElement>('form[aria-label="Confirm external identifier"]')!.requestSubmit();
  });
  const registered = fetchMock.mock.calls.map((call) => String(call[1]?.body ?? "")).find((body) => body.includes('"register"'));
  expect(registered).toContain("reassign-external-identifier");
  expect(registered).toContain(mappingId);
});

it("cancels a reviewed connection without saving a mapping", async () => {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    const body = String(init?.body ?? "");
    if ((init?.method ?? "GET") === "GET") return json({ mappings: [], drafts: [], credentialsStored: false, accessGranted: false });
    if (body.includes('"preview"')) return json({ previewId, reviewHash: "a".repeat(64), impact: "This connects an external identifier to the canonical record. It does not grant access or store a credential.", conflict: null, namespace: "billing.app", externalId: "cust-3", provenanceLabel: "" });
    return json({ error: "unexpected" }, 500);
  });
  const host = await mount();
  await act(async () => button(host, "External identifiers").click());
  const namespace = field(host, "Integration namespace");
  const external = field(host, "External ID");
  await act(async () => {
    type(namespace, "billing.app");
    type(external, "cust-3");
    host.querySelector<HTMLFormElement>('form[aria-label="Connect external identifier"]')!.requestSubmit();
  });
  await act(async () => button(host, "Cancel").click());
  expect(host.textContent).toContain("Saved identifiers were not changed.");
  expect(fetchMock.mock.calls.some((call) => String(call[1]?.body ?? "").includes('"register"'))).toBe(false);
});
