// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import IntegrationHealth from "../components/integration-health";

const fetchMock = vi.fn();
const consumerId = "00000000-0000-4000-8000-000000000021";
const deliveryId = "00000000-0000-4000-8000-000000000022";
const previewId = "00000000-0000-4000-8000-000000000023";
const mismatchId = "00000000-0000-4000-8000-000000000024";
const recordId = "00000000-0000-4000-8000-000000000011";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
const consumer = {
  id: consumerId,
  clientId: "billing-app",
  label: "Billing",
  outage: "partial",
  version: 2,
  deliveryMode: "paused",
  schedule: "paused",
  liveActivation: false,
  lastAcknowledgement: null,
  queueAgeSeconds: 120,
  oldestUnacknowledgedAtIst: "01 Nov 2026, 12:00 IST",
  failures: [{ deliveryId, eventId: "00000000-0000-4000-8000-000000000031", recordId, recordVersion: 2, state: "failed", attemptCount: 1, failureCode: "delivery-failed", failureRedacted: "[redacted]", atIst: "01 Nov 2026, 12:00 IST" }],
  canRepair: true,
  canReconcile: true,
  canExport: true,
  canHistory: true,
};

async function mount() {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("fetch", fetchMock);
  const host = document.createElement("div");
  document.body.append(host);
  const root: Root = createRoot(host);
  await act(async () => root.render(createElement(IntegrationHealth, { workspaceId: "ws one", tenantId: "00000000-0000-4000-8000-000000000002", collection: "organisations" })));
  return host;
}
function button(host: ParentNode, name: string) {
  const found = [...host.querySelectorAll("button")].find((item) => item.textContent === name) as HTMLButtonElement | undefined;
  expect(found, name).toBeTruthy();
  return found!;
}

it("opens from the keyboard, shows redacted health, and confirms one retry", async () => {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = String(init?.body ?? "");
    if (method === "GET" && String(url).includes("/integration-health?")) return json({ consumers: [consumer], drafts: [], credentialsStored: false, accessGranted: false, liveActivation: false });
    if (body.includes('"retry"')) return json({ previewId, reviewHash: "a".repeat(64), action: "retry", confirm: "retry-delivery", impact: "This queues one idempotent retry of a failed delivery. It does not send data to another app.", consumerId });
    if (body.includes('"confirm"')) return json({ replayed: false, action: "retry" });
    return json({ error: "unexpected" }, 500);
  });
  const host = await mount();
  expect(fetchMock).not.toHaveBeenCalled();
  await act(async () => button(host, "Integration health").click());
  expect(host.textContent).toContain("does not activate a live connection");
  expect(host.textContent).toContain("Queue age 120 seconds");
  expect(host.textContent).toContain("[redacted]");
  expect(host.textContent).not.toContain("hidden-field-secret");
  expect(host.querySelector("a.integration-health-link")?.getAttribute("href")).toContain("consumerId=");
  await act(async () => button(host, "Preview retry").click());
  expect(host.textContent).toContain("idempotent retry");
  expect(button(host, "Confirm action").disabled).toBe(true);
  const box = host.querySelector<HTMLInputElement>('form[aria-label="Confirm integration action"] input[type="checkbox"]');
  await act(async () => {
    box!.click();
    host.querySelector<HTMLFormElement>('form[aria-label="Confirm integration action"]')!.requestSubmit();
  });
  const posted = fetchMock.mock.calls.map((call) => String(call[1]?.body ?? "")).find((body) => body.includes("retry-delivery"));
  expect(posted).toContain(previewId);
  expect(posted).not.toContain("hidden-field-secret");
});

it("offers only non-destructive repair for a version conflict and can cancel", async () => {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    const body = String(init?.body ?? "");
    if ((init?.method ?? "GET") === "GET") return json({ consumers: [consumer], drafts: [] });
    if (body.includes('"reconcile"')) return json({ runId: "00000000-0000-4000-8000-000000000041", version: 2, phase: "completed", resume: false, mismatches: [{ id: mismatchId, class: "version-ahead", recordId, canonicalVersion: 2, observedVersion: 9 }] });
    if (body.includes('"repair"')) return json({ previewId, reviewHash: "b".repeat(64), action: "repair", confirm: "repair-keep-canonical", impact: "This keeps canonical data unchanged.", consumerId });
    return json({ error: "unexpected" }, 500);
  });
  const host = await mount();
  await act(async () => button(host, "Integration health").click());
  await act(async () => {
    host.querySelector<HTMLFormElement>('form[aria-label="Reconcile consumer"]')!.requestSubmit();
  });
  expect(host.textContent).toContain("Canonical data is kept");
  expect(host.textContent).not.toContain("Overwrite");
  expect(host.textContent).not.toContain("Delete");
  expect(button(host, "Keep canonical data unchanged")).toBeTruthy();
  await act(async () => button(host, "Keep canonical data unchanged").click());
  await act(async () => button(host, "Cancel").click());
  expect(host.textContent).toContain("Durable delivery was not changed.");
  expect(fetchMock.mock.calls.some((call) => String(call[1]?.body ?? "").includes("repair-keep-canonical"))).toBe(false);
});

it("uses the shared sidebar and phone target styles", () => {
  const sidebar = readFileSync("app/workspace.css", "utf8");
  const surface = readFileSync("app/globals.css", "utf8");
  expect(sidebar).toContain(".sidebar .integration-health-link:link");
  expect(sidebar).toContain(".sidebar .integration-health-link:focus-visible");
  expect(surface).toContain(".integration-health input");
  expect(surface).toContain("min-height:44px");
  expect(surface).toContain("@media(max-width:720px)");
});
