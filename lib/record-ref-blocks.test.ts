// @vitest-environment jsdom
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { expect, it } from "vitest";
import { RecordRefBody, RecordViewBody } from "../components/editor/record-ref-blocks";

async function render(node: ReturnType<typeof createElement>) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => { root.render(node); });
  return { host, root };
}

it("uses one placeholder shape for a restricted record and keeps hidden field values out of the card", async () => {
  const restricted = await render(createElement(RecordRefBody, { state: { status: "restricted" }, onRetry() {}, onRequest() {}, onRestore() {} }));
  const missing = restricted.host.textContent;
  restricted.root.unmount();
  const card = await render(createElement(RecordRefBody, {
    display: "card",
    state: { status: "visible", title: "Northwind", collectionName: "Clients", icon: "▣", href: "/records", updatedAt: new Date().toISOString(), fields: [{ key: "secret", label: "Contract Value", access: "hidden" }, { key: "status", label: "Status", access: "visible", value: "On hold" }] },
    onRetry() {}, onRequest() {}, onRestore() {},
  }));
  expect(missing).toContain("Restricted record");
  expect(missing).toContain("Request access");
  expect(card.host.textContent).toContain("Contract Value");
  expect(card.host.querySelector("[title]")?.getAttribute("title")).toBe("You don't have access to this field");
  expect(card.host.querySelector("[aria-label]")?.getAttribute("aria-label")).toContain("You don't have access to this field");
  expect(card.host.textContent).toContain("On hold");
  expect(card.host.textContent).toContain("Updated just now");
  expect(card.host.innerHTML).not.toContain("250000");
  card.root.unmount();
});

it("shows the live view empty state and a retry that does not replace the page", async () => {
  const view = await render(createElement(RecordViewBody, { state: { status: "error" }, onRetry() {} }));
  expect(view.host.textContent).toContain("Couldn't load records —");
  expect(view.host.textContent).toContain("Retry");
  view.root.unmount();
  const empty = await render(createElement(RecordViewBody, {
    state: { status: "visible", collectionName: "Clients", href: "/clients", viewAllLabel: "View all in Clients", layout: "table", columns: [{ key: "name", label: "Name", access: "visible" }], rows: [], countLabel: "0 of 0 you can see", emptyLabel: "No records you can access match this view", chips: ["Renewal Date is greater than 2026-10-01"], updatedAt: "2020-01-01T00:00:00.000Z" },
    onRetry() {},
  }));
  expect(empty.host.textContent).toContain("No records you can access match this view");
  expect(empty.host.textContent).toContain("0 of 0 you can see");
  expect(empty.host.textContent).toContain("View all in Clients");
  expect(empty.host.textContent).toContain("Renewal Date is greater than 2026-10-01");
  empty.root.unmount();
});
