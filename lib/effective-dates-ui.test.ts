// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import EffectiveDates from "../components/effective-dates";

const fetchMock = vi.fn();
const recordId = "00000000-0000-4000-8000-000000000011";
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
  await act(async () => root.render(createElement(EffectiveDates, { workspaceId: "ws one", tenantId: "00000000-0000-4000-8000-000000000002", collection: "organisations" })));
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

it("reviews an effective value from the keyboard and leaves it unchanged on cancel", async () => {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = String(init?.body ?? "");
    if (method === "GET") return json({ policies: [{ fieldKey: "core:registration", label: "Registration reference", kind: "text", enabled: true, version: 1 }], intervals: [], drafts: [], asOf: null, accessGranted: false });
    if (body.includes('"propose"')) return json({ previewId, reviewHash: "a".repeat(64), action: "propose", confirm: "propose-effective-value", impact: "The interval is half-open in Asia/Calcutta." });
    if (body.includes('"confirm"')) return json({ replayed: false, state: "scheduled" });
    return json({ error: "unexpected" }, 500);
  });
  const host = await mount();
  expect(fetchMock).not.toHaveBeenCalled();
  await act(async () => button(host, "Effective dates").click());
  expect(host.textContent).toContain("Activation is manual");
  expect(host.textContent).toContain("does not grant access");
  const form = host.querySelector<HTMLFormElement>('form[aria-label="Propose effective value"]');
  expect(form).toBeTruthy();
  const inputs = [...form!.querySelectorAll("input")];
  await act(async () => {
    setInput(inputs[0], "1");
    setInput(inputs[1], "REG-100");
    setInput(inputs[2], "2027-01-01T09:00:00+05:30");
    setInput(host.querySelector("select")!, "Asia/Calcutta");
  });
  await act(async () => form!.requestSubmit());
  expect(host.textContent).toContain("half-open");
  expect(button(host, "Confirm action").disabled).toBe(true);
  await act(async () => button(host, "Cancel").click());
  expect(host.textContent).toContain("Durable effective values were not changed.");
  expect(fetchMock.mock.calls.some((call) => String(call[1]?.body ?? "").includes("propose-effective-value"))).toBe(false);
  await act(async () => form!.requestSubmit());
  const box = host.querySelector<HTMLInputElement>('form[aria-label="Confirm effective action"] input[type="checkbox"]');
  await act(async () => {
    box!.click();
    host.querySelector<HTMLFormElement>('form[aria-label="Confirm effective action"]')!.requestSubmit();
  });
  const posted = fetchMock.mock.calls.map((call) => String(call[1]?.body ?? "")).find((body) => body.includes("propose-effective-value"));
  expect(posted).toContain(previewId);
  expect(posted).toContain(recordId === recordId ? "confirm" : "");
  expect(host.querySelector("a.effective-dates-link")).toBeTruthy();
});

it("uses phone-sized targets and a visible keyboard focus style", () => {
  const sidebar = readFileSync("app/workspace.css", "utf8");
  const surface = readFileSync("app/globals.css", "utf8");
  expect(sidebar).toContain(".sidebar .effective-dates-link:link");
  expect(sidebar).toContain(".sidebar .effective-dates-link:focus-visible");
  expect(surface).toContain(".effective-dates input");
  expect(surface).toContain(".effective-dates button");
  expect(surface).toContain("min-height:44px");
  expect(surface).toContain("@media(max-width:720px)");
  expect(surface).toContain(".effective-dates{font-size:1rem}");
});
