// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { AcknowledgementBanner, AcknowledgementDashboard, AcknowledgementRequestDialog } from "../components/acknowledgement-panel";
import { acknowledgementCsv, type AcknowledgementOwnerView } from "./acknowledgement-copy";

afterEach(() => {
  document.body.replaceChildren();
  vi.useRealTimers();
});

async function mount(node: ReturnType<typeof createElement>) {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  return { host, dispose: async () => { await act(async () => root.unmount()); host.remove(); } };
}

it("keeps Acknowledge disabled until the reader confirms and reaches the end or waits on a short document", async () => {
  const acknowledge = vi.fn();
  const scroll = document.createElement("div");
  Object.defineProperty(scroll, "clientHeight", { value: 200 });
  Object.defineProperty(scroll, "scrollHeight", { value: 2000 });
  let scrollTop = 0;
  Object.defineProperty(scroll, "scrollTop", { get: () => scrollTop, set: value => { scrollTop = value; } });
  const view = await mount(createElement(AcknowledgementBanner, { copy: "Please read and acknowledge v3", shortDocument: false, scrollTarget: scroll, onAcknowledge: acknowledge }));
  const button = () => [...view.host.querySelectorAll("button")].find(item => item.textContent === "Acknowledge")!;
  expect(view.host.textContent).toContain("Please read and acknowledge v3");
  await act(async () => button().click());
  expect(acknowledge).not.toHaveBeenCalled();
  await act(async () => view.host.querySelector("input")!.click());
  expect(button().disabled).toBe(true);
  scrollTop = 1900;
  await act(async () => scroll.dispatchEvent(new Event("scroll")));
  expect(button().disabled).toBe(false);
  await act(async () => button().click());
  expect(acknowledge).toHaveBeenCalledWith(expect.objectContaining({ confirm: true, reachedEnd: true }));
  await view.dispose();

  vi.useFakeTimers();
  const shortAcknowledge = vi.fn();
  const short = await mount(createElement(AcknowledgementBanner, { copy: "Please read and acknowledge v3", shortDocument: true, onAcknowledge: shortAcknowledge }));
  const shortButton = () => [...short.host.querySelectorAll("button")].find(item => item.textContent === "Acknowledge")!;
  await act(async () => short.host.querySelector("input")!.click());
  expect(shortButton().disabled).toBe(true);
  await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
  expect(shortButton().disabled).toBe(false);
  await short.dispose();
});

it("shows completion, filters and an IST CSV for the acknowledgement dashboard", async () => {
  const assignments = [
    ...Array.from({ length: 12 }, (_, index) => ({ userId: `ack-${index}`, name: `Reader ${index}`, status: "acknowledged" as const, statusLabel: "Acknowledged", versionLabel: "v3", acknowledgedAt: "2026-11-01T04:30:00.000Z", acknowledgedAtIst: "01 Nov 2026, 10:00 IST" })),
    ...Array.from({ length: 8 }, (_, index) => ({ userId: `pend-${index}`, name: `Pending ${index}`, status: index < 4 ? "overdue" as const : "pending" as const, statusLabel: index < 4 ? "Overdue" : "Pending", versionLabel: "v3", acknowledgedAt: null, acknowledgedAtIst: null })),
  ];
  const view: AcknowledgementOwnerView = {
    scope: "owner",
    publication: { versionId: "00000000-0000-4000-8000-0000000000a1", versionLabel: "v3", bump: "major" },
    audienceChoices: { users: [], groups: [{ id: "group-ops", name: "Ops team" }], roles: [], space: { id: "space-product", name: "Operations" } },
    campaign: { id: "00000000-0000-4000-8000-0000000000b1", status: "active", paused: false, versionId: "00000000-0000-4000-8000-0000000000a1", versionLabel: "v3", dueAt: "2026-11-07T18:29:59.999Z", dueAtIst: "07 Nov 2026, 23:59 IST", completion: { acknowledged: 12, assigned: 20, label: "12/20" }, retainedRecords: 12 },
    assignments,
    excluded: [{ userId: "blocked", name: "Blocked reader", reason: "Cannot be assigned — no access" }],
    banner: null,
  };
  const exported = vi.fn();
  const dashboard = await mount(createElement(AcknowledgementDashboard, { view, onClose: () => {}, onExport: exported, onReacknowledge: async () => {} }));
  expect(dashboard.host.textContent).toContain("Completion 12/20");
  expect(dashboard.host.textContent).toContain("01 Nov 2026, 10:00 IST");
  expect(dashboard.host.textContent).toContain("Cannot be assigned — no access");
  await act(async () => { dashboard.host.querySelector("select")!.value = "pending"; dashboard.host.querySelector("select")!.dispatchEvent(new Event("change", { bubbles: true })); });
  expect(dashboard.host.textContent).toContain("Pending 4");
  expect(dashboard.host.textContent).not.toContain("Reader 0");
  await act(async () => [...dashboard.host.querySelectorAll("button")].find(button => button.textContent === "Export CSV")!.click());
  expect(exported).toHaveBeenCalledWith("csv", "pending");
  const csv = acknowledgementCsv(assignments.filter(item => item.status === "acknowledged").map(item => ({ name: item.name, status: item.statusLabel, versionLabel: item.versionLabel, acknowledgedAtIst: item.acknowledgedAtIst ?? "" })));
  expect(csv).toContain("acknowledged_at_ist");
  expect(csv).toContain("01 Nov 2026, 10:00 IST");
  await dashboard.dispose();

  const submitted = vi.fn(async () => {});
  const request = await mount(createElement(AcknowledgementRequestDialog, { versionLabel: "v3", choices: view.audienceChoices, onClose: () => {}, onSubmit: submitted }));
  const group = [...request.host.querySelectorAll("label")].find(label => label.textContent?.includes("Ops team"))!.querySelector("input")!;
  await act(async () => group.click());
  const date = request.host.querySelector<HTMLInputElement>('input[type="date"]')!;
  await act(async () => { date.value = "2026-11-07"; date.dispatchEvent(new Event("change", { bubbles: true })); request.host.querySelector("form")!.requestSubmit(); });
  expect(submitted).toHaveBeenCalledWith({ dueOn: "2026-11-07", audience: [{ kind: "group", id: "group-ops" }] });
  await request.dispose();
});
