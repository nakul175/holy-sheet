// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import RecordGraph from "../components/record-graph";
import { acceptedRecordGraph } from "./record-graph-contract";

const fetchMock = vi.fn();
const recordId = "00000000-0000-4000-8000-0000000000a1";
const accountId = "00000000-0000-4000-8000-0000000000a2";
const graph = {
  focalId: recordId,
  nodes: [
    { id: recordId, kind: "record", label: "Acme", state: "active", collection: "organisations" },
    { id: accountId, kind: "record", label: "North account", state: "archived", collection: "accounts" },
  ],
  edges: [{ id: "edge-1", kind: "parent-organisation", fromId: accountId, toId: recordId }],
  limited: false,
  secretNeighbor: "Do not leak this neighbor",
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  document.body.replaceChildren();
});

async function mount(version = 1) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("fetch", fetchMock);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const props = { workspaceId: "ws one", tenantId: "00000000-0000-4000-8000-000000000002", recordId, version, onOpenRecord: vi.fn() };
  await act(async () => root.render(createElement(RecordGraph, props)));
  return {
    host,
    props,
    render: async (nextVersion: number) => {
      await act(async () => root.render(createElement(RecordGraph, { ...props, version: nextVersion })));
    },
    dispose: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

it("moves through the graph with the keyboard and refreshes when relationships change", async () => {
  fetchMock.mockImplementation(() => Promise.resolve(new Response(JSON.stringify(graph), { status: 200, headers: { "Content-Type": "application/json" } })));
  const view = await mount();
  try {
    expect(view.host.textContent).not.toContain("Do not leak this neighbor");
    expect(fetchMock).not.toHaveBeenCalled();
    await act(async () => view.host.querySelector("button")!.click());
    const options = () => [...view.host.querySelectorAll<HTMLButtonElement>("[role=option]")];
    expect(options()[0].getAttribute("aria-selected")).toBe("true");
    expect(options()[0].tabIndex).toBe(0);
    expect(options()[1].tabIndex).toBe(-1);
    expect(view.host.textContent).toContain("North account, accounts, archived");
    expect(view.host.textContent).not.toContain("Do not leak this neighbor");
    await act(async () => options()[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(options()[1].getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(options()[1]);
    expect(view.host.textContent).toContain("Links to Acme");
    await act(async () => options()[1].dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
    expect(options()[1].getAttribute("aria-selected")).toBe("true");
    await act(async () => options()[1].dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })));
    expect(options()[0].getAttribute("aria-selected")).toBe("true");
    await view.render(2);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(view.host.textContent).toContain("Relationship graph updated.");
    await act(async () => options()[0].dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });
    expect(view.host.querySelector("[role=listbox]")).toBeNull();
    expect(document.activeElement).toBe(view.host.querySelector("button"));
  } finally {
    await view.dispose();
  }
});

it("drops a graph that would render an unavailable neighbor", () => {
  expect(acceptedRecordGraph({ ...graph, nodes: [...graph.nodes, { unavailable: true, id: "hidden", label: "Secret field partner" }] })).toBeNull();
  expect(JSON.stringify(acceptedRecordGraph(graph))).not.toContain("secretNeighbor");
});
