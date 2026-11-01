// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import StaffLifecycle from "../components/staff-lifecycle";

const fetchMock = vi.fn();
const lifecycleId = "00000000-0000-4000-8000-000000000011";
const previewId = "00000000-0000-4000-8000-000000000023";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
const lifecycle = { id: lifecycleId, employeeName: "Ward Nurse", state: "planned", version: 1, handoverState: "open", accessTransferred: false, credentialsTransferred: false, accessRevoked: false, revocationClaim: "not-recorded", checklist: [], outstanding: { total: 1, hiddenCount: 0, items: [{ id: "rec", kind: "owned-record", label: "Ward file" }] }, dates: { plannedOn: "2026-04-01", startOn: null, leavingOn: null, leftOn: null } };

async function mount() {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("fetch", fetchMock);
  const host = document.createElement("div");
  document.body.append(host);
  const root: Root = createRoot(host);
  await act(async () => root.render(createElement(StaffLifecycle, { workspaceId: "ws one", tenantId: "00000000-0000-4000-8000-000000000002" })));
  return host;
}
function button(host: ParentNode, name: string) {
  const found = [...host.querySelectorAll("button")].find((item) => item.textContent === name) as HTMLButtonElement | undefined;
  expect(found, name).toBeTruthy();
  return found!;
}
function setInput(input: HTMLInputElement, value: string) {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

it("reviews a staff lifecycle from the keyboard and leaves it unchanged on cancel", async () => {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = String(init?.body ?? "");
    if (method === "GET") return json({ lifecycles: [lifecycle], drafts: [], policy: { acknowledgementRequired: true, version: 1, accessGranted: false }, note: "Directory lifecycle is an HR record for this employee. It does not provision or deprovision an account, transfer access or login credentials, run payroll, or record an employment decision.", accessTransferred: false, credentialsTransferred: false });
    if (body.includes('"create"')) return json({ previewId, reviewHash: "a".repeat(64), action: "create", confirm: "create-staff-lifecycle", impact: "This opens a planned staff lifecycle." });
    if (body.includes('"confirm"')) return json({ replayed: false, state: "planned", accessTransferred: false, credentialsTransferred: false });
    return json({ error: "unexpected" }, 500);
  });
  const host = await mount();
  expect(fetchMock).not.toHaveBeenCalled();
  await act(async () => button(host, "Staff lifecycle").click());
  expect(host.textContent).toContain("does not transfer access or login credentials");
  expect(host.textContent).toContain("does not grant access");
  expect(host.textContent).toContain("Acknowledge outstanding");
  expect(host.textContent).toContain("does not revoke access");
  const form = host.querySelector<HTMLFormElement>('form[aria-label="Open staff lifecycle"]');
  expect(form).toBeTruthy();
  const inputs = [...form!.querySelectorAll("input")];
  await act(async () => {
    setInput(inputs[0], "00000000-0000-4000-8000-000000000031");
    setInput(inputs[1], "2026-04-01");
  });
  await act(async () => form!.requestSubmit());
  expect(host.textContent).toContain("opens a planned staff lifecycle");
  expect(button(host, "Confirm action").disabled).toBe(true);
  await act(async () => button(host, "Cancel").click());
  expect(host.textContent).toContain("Durable staff records were not changed.");
  expect(fetchMock.mock.calls.some((call) => String(call[1]?.body ?? "").includes("create-staff-lifecycle"))).toBe(false);
  await act(async () => form!.requestSubmit());
  const box = host.querySelector<HTMLInputElement>('form[aria-label="Confirm staff lifecycle"] input[type="checkbox"]');
  await act(async () => {
    box!.click();
    host.querySelector<HTMLFormElement>('form[aria-label="Confirm staff lifecycle"]')!.requestSubmit();
  });
  const posted = fetchMock.mock.calls.map((call) => String(call[1]?.body ?? "")).find((body) => body.includes("create-staff-lifecycle"));
  expect(posted).toContain(previewId);
  expect(host.querySelector("a.staff-lifecycle-link")).toBeTruthy();
  expect(host.querySelector("a.staff-lifecycle-link")?.getAttribute("href")).toContain("lifecycleId=");
});

it("uses phone-sized targets and a visible keyboard focus style", () => {
  const sidebar = readFileSync("app/workspace.css", "utf8");
  const surface = readFileSync("app/globals.css", "utf8");
  expect(sidebar).toContain(".sidebar .staff-lifecycle-link:link");
  expect(sidebar).toContain(".sidebar .staff-lifecycle-link:focus-visible");
  expect(surface).toContain(".staff-lifecycle input");
  expect(surface).toContain(".staff-lifecycle button");
  expect(surface).toContain("min-height:44px");
  expect(surface).toContain("@media(max-width:720px)");
  expect(surface).toContain(".staff-lifecycle{font-size:1rem}");
});
