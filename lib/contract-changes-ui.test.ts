// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import ContractChanges from "../components/contract-changes";

const fetchMock = vi.fn();
const changeId = "00000000-0000-4000-8000-000000000011";
const previewId = "00000000-0000-4000-8000-000000000023";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));

async function mount() {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("fetch", fetchMock);
  const host = document.createElement("div");
  document.body.append(host);
  const root: Root = createRoot(host);
  await act(async () => root.render(createElement(ContractChanges, { workspaceId: "ws one", tenantId: "00000000-0000-4000-8000-000000000002" })));
  return host;
}
function button(host: ParentNode, name: string) {
  const found = [...host.querySelectorAll("button")].find((item) => item.textContent === name) as HTMLButtonElement | undefined;
  expect(found, name).toBeTruthy();
  return found!;
}
function setInput(input: HTMLInputElement | HTMLSelectElement, value: string) {
  const prototype = input instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

it("reviews a contract change from the keyboard and leaves it unchanged on cancel", async () => {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = String(init?.body ?? "");
    if (method === "GET") return json({ changes: [{ id: changeId, kind: "renewal", status: "draft", parentName: "Original", successorName: "Successor", version: 1, legalCommitment: false }], endDates: [{ id: changeId, kind: "renewal", status: "draft", parentName: "Original", originalEnd: "2026-12-31", proposedEnd: "2028-01-01", responsibility: { userId: null, explicit: true, assigned: false }, decision: { value: "undecided", explicit: true }, legalCommitment: false, commitsRenewal: false, note: "A date or status is an internal record only. It does not sign, execute, or commit a renewal." }], drafts: [], policy: { reviewRequired: true, version: 1, accessGranted: false }, note: "A date or status is an internal record only. It does not sign, execute, or commit a renewal.", accessGranted: false, legalCommitment: false });
    if (body.includes('"create"')) return json({ previewId, reviewHash: "a".repeat(64), action: "create", confirm: "create-contract-change", impact: "This saves a renewal in draft." });
    if (body.includes('"confirm"')) return json({ replayed: false, status: "draft", legalCommitment: false });
    return json({ error: "unexpected" }, 500);
  });
  const host = await mount();
  expect(fetchMock).not.toHaveBeenCalled();
  await act(async () => button(host, "Contract changes").click());
  expect(host.textContent).toContain("does not sign, execute, or commit");
  expect(host.textContent).toContain("does not grant access");
  expect(host.textContent).toContain("Responsibility unset");
  const form = host.querySelector<HTMLFormElement>('form[aria-label="Create contract change"]');
  expect(form).toBeTruthy();
  const inputs = [...form!.querySelectorAll("input")];
  await act(async () => {
    setInput(inputs[0], "00000000-0000-4000-8000-000000000031");
    setInput(inputs[1], "00000000-0000-4000-8000-000000000032");
    setInput(inputs[2], "2027-01-01T00:00:00+05:30");
    setInput(form!.querySelectorAll("select")[1] as HTMLSelectElement, "Asia/Calcutta");
    setInput(inputs[3], "00000000-0000-4000-8000-000000000033");
    setInput(inputs[4], "1");
  });
  await act(async () => form!.requestSubmit());
  expect(host.textContent).toContain("saves a renewal");
  expect(button(host, "Confirm action").disabled).toBe(true);
  await act(async () => button(host, "Cancel").click());
  expect(host.textContent).toContain("Durable contract records were not changed.");
  expect(fetchMock.mock.calls.some((call) => String(call[1]?.body ?? "").includes("create-contract-change"))).toBe(false);
  await act(async () => form!.requestSubmit());
  const box = host.querySelector<HTMLInputElement>('form[aria-label="Confirm contract change"] input[type="checkbox"]');
  await act(async () => {
    box!.click();
    host.querySelector<HTMLFormElement>('form[aria-label="Confirm contract change"]')!.requestSubmit();
  });
  const posted = fetchMock.mock.calls.map((call) => String(call[1]?.body ?? "")).find((body) => body.includes("create-contract-change"));
  expect(posted).toContain(previewId);
  expect(host.querySelector("a.contract-changes-link")).toBeTruthy();
  expect(host.querySelector("a.contract-changes-link")?.getAttribute("href")).toContain("changeId=");
});

it("uses phone-sized targets and a visible keyboard focus style", () => {
  const sidebar = readFileSync("app/workspace.css", "utf8");
  const surface = readFileSync("app/globals.css", "utf8");
  expect(sidebar).toContain(".sidebar .contract-changes-link:link");
  expect(sidebar).toContain(".sidebar .contract-changes-link:focus-visible");
  expect(surface).toContain(".contract-changes input");
  expect(surface).toContain(".contract-changes button");
  expect(surface).toContain("min-height:44px");
  expect(surface).toContain("@media(max-width:720px)");
  expect(surface).toContain(".contract-changes{font-size:1rem}");
});
