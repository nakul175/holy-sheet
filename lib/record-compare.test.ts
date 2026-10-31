// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import RecordCompare from "../components/record-compare";

const fetchMock = vi.fn();
const left = "00000000-0000-4000-8000-0000000000a1";
const right = "00000000-0000-4000-8000-0000000000a2";
const comparison = {
  mixedCollections: false,
  records: [
    { id: left, name: "Left record", collection: "organisations", state: "active", version: 2 },
    { id: right, name: "Right record", collection: "organisations", state: "archived", version: 4 },
  ],
  fields: [
    { key: "name", label: "Name", kind: "text", status: "changed", values: [{ recordId: left, present: true, value: "Left record" }, { recordId: right, present: true, value: "Right record" }] },
    { key: "notes", label: "Notes", kind: "long-text", status: "only-left", values: [{ recordId: left, present: true, value: "Only left note" }, { recordId: right, present: false }] },
    { key: "registration", label: "Registration reference", kind: "text", status: "only-right", values: [{ recordId: left, present: false }, { recordId: right, present: true, value: "REG-9" }] },
    { key: "domain", label: "Domain", kind: "url", status: "same", values: [{ recordId: left, present: true, value: "https://same.example/" }, { recordId: right, present: true, value: "https://same.example/" }] },
  ],
  secretNeighbor: "hidden-salary-value",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  document.body.replaceChildren();
});

async function mount() {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("fetch", fetchMock);
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(createElement(RecordCompare, {
    workspaceId: "ws one",
    tenantId: "00000000-0000-4000-8000-000000000002",
    recordIds: [left, right],
    onClear: vi.fn(),
  })));
  return {
    host,
    dispose: async () => {
      await act(async () => root.unmount());
      host.remove();
    },
  };
}

it("moves through comparison rows with the keyboard and hides unchanged fields", async () => {
  fetchMock.mockImplementation(() => Promise.resolve(new Response(JSON.stringify(comparison), { status: 200, headers: { "Content-Type": "application/json" } })));
  const view = await mount();
  try {
    expect(view.host.textContent).not.toContain("hidden-salary-value");
    expect(fetchMock).not.toHaveBeenCalled();
    const open = view.host.querySelector("button")!;
    expect(open.textContent).toBe("Compare selected records");
    await act(async () => open.click());
    expect(view.host.textContent).not.toContain("hidden-salary-value");
    expect(view.host.textContent).toContain("Changed");
    expect(view.host.textContent).toContain("Only on the left");
    expect(view.host.textContent).toContain("Only on the right");
    expect(view.host.textContent).toContain("Same");
    expect(view.host.textContent).toContain("Right record, organisations, archived");
    const rows = () => [...view.host.querySelectorAll<HTMLTableRowElement>("tbody tr")];
    expect(rows()[0].getAttribute("aria-selected")).toBe("true");
    expect(rows()[0].tabIndex).toBe(0);
    expect(rows()[1].tabIndex).toBe(-1);
    expect(rows()[0].className).toContain("record-compare-changed");
    expect(rows()[1].className).toContain("record-compare-only-left");
    expect(rows()[2].className).toContain("record-compare-only-right");
    await act(async () => rows()[0].dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    expect(rows()[1].getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement).toBe(rows()[1]);
    await act(async () => rows()[1].dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true })));
    expect(rows()[3].getAttribute("aria-selected")).toBe("true");
    await act(async () => rows()[3].dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true })));
    expect(rows()[0].getAttribute("aria-selected")).toBe("true");
    const differences = view.host.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
    await act(async () => differences.click());
    expect(view.host.textContent).not.toContain("https://same.example/");
    expect(view.host.textContent).toContain("Only left note");
    await act(async () => rows()[0].dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
    await act(async () => { await new Promise((resolve) => requestAnimationFrame(() => resolve(undefined))); });
    expect(view.host.querySelector("table")).toBeNull();
    expect(document.activeElement).toBe(view.host.querySelector("button"));
    expect(view.host.querySelector("button")!.textContent).toBe("Compare selected records");
  } finally {
    await view.dispose();
  }
});

it("does not render a denied comparison body", async () => {
  fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: "hidden-salary-value" }), { status: 404, headers: { "Content-Type": "application/json" } }));
  const view = await mount();
  try {
    await act(async () => view.host.querySelector("button")!.click());
    expect(view.host.textContent).toContain("This comparison is not available with your current access.");
    expect(view.host.textContent).not.toContain("hidden-salary-value");
    expect(view.host.querySelector("table")).toBeNull();
  } finally {
    await view.dispose();
  }
});
