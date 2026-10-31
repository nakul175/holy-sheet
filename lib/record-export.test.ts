// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import RecordExport from "../components/record-export";

const fetchMock = vi.fn();
const viewId = "00000000-0000-4000-8000-0000000000b1";
const recordA = "00000000-0000-4000-8000-0000000000a1";
const recordB = "00000000-0000-4000-8000-0000000000a2";
const jobId = "00000000-0000-4000-8000-0000000000c1";
const hash = "ab".repeat(32);
const secret = "Private pinned cell";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
const preview = (extra: Record<string, unknown> = {}) => ({
  id: jobId,
  collection: "organisations",
  format: "csv",
  rowCount: 1,
  columns: [{ key: "name", label: "Name", kind: "text" }, { key: "core:notes", label: "Notes", kind: "long-text" }],
  warnings: [],
  reviewHash: hash,
  state: "ready",
  createdAt: "2026-10-31T00:00:00.000Z",
  expiresAt: "2026-10-31T00:15:00.000Z",
  pinned: true,
  rows: [{ name: secret }],
  ...extra,
});
const fields = [
  { key: "core:notes", label: "Notes", kind: "long-text" },
  { key: "00000000-0000-4000-8000-0000000000f1", label: "Brief", kind: "attachment" },
  { key: "00000000-0000-4000-8000-0000000000f2", label: "Linked organisation", kind: "record" },
];
async function mount(props: { collection?: string; view?: { id: string; name: string; version: number; columns: string[] } | null; records?: { id: string; name: string }[] } = {}) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("fetch", fetchMock);
  const host = document.createElement("div");
  document.body.append(host);
  const root: Root = createRoot(host);
  await act(async () => root.render(createElement(RecordExport, {
    workspaceId: "ws one",
    tenantId: "00000000-0000-4000-8000-000000000002",
    collection: props.collection ?? "organisations",
    schemaVersion: 4,
    view: props.view === undefined ? { id: viewId, name: "Open organisations", version: 3, columns: ["name", "core:notes"] } : props.view,
    records: props.records ?? [{ id: recordA, name: "Ada" }, { id: recordB, name: "Ada" }, { id: recordA, name: "Ada duplicate" }],
    fields,
  })));
  return { host, dispose: async () => { await act(async () => root.unmount()); host.remove(); } };
}
async function click(host: ParentNode, name: string) {
  const button = [...host.querySelectorAll("button")].find((item) => item.textContent === name) as HTMLButtonElement;
  await act(async () => { button.click(); });
}
async function check(host: ParentNode, label: string) {
  const box = [...host.querySelectorAll("label")].find((item) => item.textContent?.includes(label))!.querySelector("input")!;
  await act(async () => { box.click(); });
}
function posted() {
  return fetchMock.mock.calls.filter((call) => call[1]?.method === "POST").map((call) => ({ url: String(call[0]), body: JSON.parse(String(call[1].body)), credentials: call[1].credentials, cache: call[1].cache }));
}

it("prepares the current saved view without ids or a fetch on mount", async () => {
  fetchMock.mockImplementation(() => json(preview()));
  const view = await mount();
  try {
    expect(fetchMock).not.toHaveBeenCalled();
    expect(view.host.textContent).toContain("Open organisations");
    expect(view.host.textContent).toContain("fails closed");
    expect(view.host.textContent).not.toContain("Include the parent organisation ID");
    expect(view.host.querySelector('input[value="view"]')).not.toBeNull();
    await click(view.host, "Prepare export");
    const body = posted()[0];
    expect(body.url).toBe(`/api/v1/workspaces/${encodeURIComponent("ws one")}/tenants/00000000-0000-4000-8000-000000000002/record-exports`);
    expect(body.credentials).toBe("same-origin");
    expect(body.cache).toBe("no-store");
    expect(body.body).toMatchObject({ kind: "view", viewId, expectedViewVersion: 3, expectedSchemaVersion: 4, format: "csv", includeIds: false, includeRelationships: false });
    expect(body.body.recordIds).toBeUndefined();
    expect(body.body.columns).toBeUndefined();
    expect(body.body.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(view.host.textContent).toContain("1 record");
    expect(view.host.textContent).toContain("Notes");
    expect(view.host.textContent).not.toContain(secret);
    expect(view.host.textContent).toContain("Cell values stay in the pinned file");
  } finally {
    await view.dispose();
  }
});

it("exports chosen records and opt-in ids, and retries the same prepare", async () => {
  let attempts = 0;
  fetchMock.mockImplementation(() => {
    attempts += 1;
    return attempts === 1 ? json({ error: "Service temporarily unavailable.", code: "service_unavailable", retryable: true }, 503) : json(preview({ format: "xlsx", warnings: [] }));
  });
  const view = await mount({ collection: "accounts", view: null });
  try {
    expect((view.host.querySelector('input[value="view"]') as HTMLInputElement).disabled).toBe(true);
    expect(view.host.textContent).toContain("Include the parent organisation ID");
    expect(view.host.textContent).not.toContain("Brief");
    expect(view.host.textContent).not.toContain("Linked organisation");
    await check(view.host, "Include HS record IDs");
    await check(view.host, "Include the parent organisation ID");
    await check(view.host, "Notes");
    await check(view.host, recordA);
    await check(view.host, recordB);
    await click(view.host, "Prepare export");
    expect(view.host.textContent).toContain("Retry the same scope");
    await click(view.host, "Retry prepare");
    const bodies = posted().map((call) => call.body);
    expect(bodies).toHaveLength(2);
    expect(bodies[0]).toEqual(bodies[1]);
    expect(bodies[0]).toMatchObject({ kind: "records", collection: "accounts", recordIds: [recordA, recordB], columns: ["name", "core:notes"], format: "csv", includeIds: true, includeRelationships: true, expectedSchemaVersion: 4 });
    expect(bodies[0].recordIds).toHaveLength(2);
  } finally {
    await view.dispose();
  }
});

it("requires spreadsheet-escaping acknowledgement before downloading the pinned file", async () => {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (String(url).endsWith("/download")) return Promise.resolve(new Response("Name\nAda\n", { status: 200, headers: { "Content-Type": "text/csv; charset=utf-8" } }));
    if (init?.method === "POST" && String(init.body).includes("cancel")) return json({ id: jobId, state: "cancelled" });
    return json(preview({ warnings: ["csv-spreadsheet-text-escaping"], format: "csv" }));
  });
  const blobs: Blob[] = [];
  const previousCreate = URL.createObjectURL;
  const previousRevoke = URL.revokeObjectURL;
  URL.createObjectURL = ((blob: Blob) => { blobs.push(blob); return "blob:export"; }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;
  const view = await mount();
  try {
    await click(view.host, "Prepare export");
    const download = () => [...view.host.querySelectorAll("button")].find((item) => item.textContent === "Download CSV") as HTMLButtonElement;
    expect(download().disabled).toBe(true);
    expect(view.host.textContent).toContain("prefixed with an apostrophe");
    await check(view.host, "Acknowledge spreadsheet-safe CSV text escaping");
    expect(download().disabled).toBe(false);
    await click(view.host, "Download CSV");
    const file = posted().find((call) => call.url.endsWith("/download"));
    expect(file?.url).toBe(`/api/v1/workspaces/${encodeURIComponent("ws one")}/tenants/00000000-0000-4000-8000-000000000002/record-exports/${jobId}/download`);
    expect(file?.body).toEqual({ reviewHash: hash, acknowledgeEscaping: true });
    expect(await blobs.at(-1)?.text()).toContain("Ada");
    expect(await blobs.at(-1)?.text()).not.toContain(secret);
    await check(view.host, "Cancel this pinned export");
    await click(view.host, "Cancel export");
    expect(posted().at(-1)?.body).toEqual({ kind: "cancel" });
    expect(view.host.textContent).toContain("pinned values were discarded");
  } finally {
    URL.createObjectURL = previousCreate;
    URL.revokeObjectURL = previousRevoke;
    await view.dispose();
  }
});
