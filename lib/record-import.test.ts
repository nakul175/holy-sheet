// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import RecordImport from "../components/record-import";

const fetchMock = vi.fn();
const jobId = "00000000-0000-4000-8000-0000000000c1";
const hash = "ab".repeat(32);
const secret = "Private staged note";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
const counts = { unreviewed: 1, valid: 0, invalid: 0, applied: 0, blocked: 0 };
const summary = (extra: Record<string, unknown> = {}) => ({ id: jobId, collection: "organisations", name: "people.csv", format: "csv", headers: ["Name", "Notes"], state: "staged", mode: null, rowCount: 2, version: 1, reviewOffset: 0, reviewHash: null, warnings: ["Duplicate header"], expiresAt: "2026-11-01T00:00:00.000Z", counts, ...extra });
async function mount(props: { collection?: string; canCreate?: boolean; fields?: { key: string; label: string; kind: string; referenceList?: boolean }[]; onCommitted?: () => void } = {}) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("fetch", fetchMock);
  const host = document.createElement("div");
  document.body.append(host);
  const root: Root = createRoot(host);
  await act(async () => root.render(createElement(RecordImport, { workspaceId: "ws one", tenantId: "00000000-0000-4000-8000-000000000002", collection: props.collection ?? "organisations", canCreate: props.canCreate ?? true, fields: props.fields ?? [{ key: "core:notes", label: "Notes", kind: "long-text" }], onCommitted: props.onCommitted })));
  return { host, dispose: async () => { await act(async () => root.unmount()); host.remove(); } };
}
async function chooseFile(host: HTMLElement, name: string, contents: string) {
  const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
  const file = new File([contents], name, { type: "text/csv" });
  await act(async () => {
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  return file;
}
async function click(host: ParentNode, name: string) {
  const button = [...host.querySelectorAll("button")].find((item) => item.textContent === name) as HTMLButtonElement;
  await act(async () => { button.click(); });
}
async function select(element: HTMLSelectElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event("change", { bubbles: true }));
  });
}
function posted() {
  return fetchMock.mock.calls.filter((call) => call[1]?.method === "POST").map((call) => ({ url: String(call[0]), body: call[1].body, headers: call[1].headers }));
}

it("stages a csv and saves a positional create mapping without inventing a field", async () => {
  fetchMock.mockImplementation((url: string) => String(url).endsWith("/record-imports") ? json(summary()) : json(summary({ state: "reviewing", mode: "create", version: 2 })));
  const view = await mount();
  try {
    expect(fetchMock).not.toHaveBeenCalled();
    await chooseFile(view.host, "people.csv", "Name,Notes\nAda,Hello");
    await click(view.host, "Stage import");
    const staged = posted()[0];
    const meta = JSON.parse(Buffer.from(staged.headers["x-hs-record-import"], "base64url").toString("utf8"));
    expect(staged.headers["Content-Type"]).toBe("application/octet-stream");
    expect(meta).toMatchObject({ collection: "organisations", name: "people.csv", format: "csv" });
    expect(meta.sheetIndex).toBeUndefined();
    expect(meta.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(await staged.body.text()).toBe("Name,Notes\nAda,Hello");
    expect(view.host.textContent).toContain("Duplicate header");
    expect([...view.host.querySelectorAll("legend")].map((item) => item.textContent)).toEqual(["Notes"]);
    await select(view.host.querySelector('[aria-label="Column for Notes"]')!, "1");
    await act(async () => view.host.querySelector<HTMLFormElement>('form[aria-label="Import mapping"]')!.requestSubmit());
    const mapping = JSON.parse(String(posted().at(-1)?.body));
    expect(mapping).toEqual({ kind: "configure", expectedVersion: 1, mapping: { mode: "create", nameColumn: 0, fields: [{ column: 1, fieldKey: "core:notes" }] } });
    expect(JSON.stringify(mapping)).not.toContain("idColumn");
    expect(view.host.querySelector('input[name="fieldKey"]')).toBeNull();
  } finally {
    await view.dispose();
  }
});

it("updates by immutable id and does not send relationship columns", async () => {
  fetchMock.mockImplementation(() => json(summary({ collection: "accounts", headers: ["ID", "Notes", "Parent"] })));
  const view = await mount({ collection: "accounts", canCreate: false });
  try {
    await chooseFile(view.host, "accounts.csv", "ID,Notes,Parent\n00000000-0000-4000-8000-0000000000a1,Hello,parent");
    await click(view.host, "Stage import");
    const mode = view.host.querySelector('select[aria-label="Import mode"]') as HTMLSelectElement;
    expect(mode.value).toBe("update");
    expect((mode.querySelector('option[value="create"]') as HTMLOptionElement).disabled).toBe(true);
    expect(view.host.querySelector('[aria-label="Parent organisation column"]')).toBeNull();
    expect(view.host.textContent).toContain("Update needs a name column or a mapped field.");
    expect(posted().filter((call) => String(call.body).includes("configure"))).toHaveLength(0);
    await select(view.host.querySelector('[aria-label="Column for Notes"]')!, "1");
    await act(async () => view.host.querySelector<HTMLFormElement>('form[aria-label="Import mapping"]')!.requestSubmit());
    expect(JSON.parse(String(posted().at(-1)?.body)).mapping).toEqual({ mode: "update", idColumn: 0, fields: [{ column: 1, fieldKey: "core:notes" }] });
  } finally {
    await view.dispose();
  }
});

it("requires explicit review choices and retries the same commit command", async () => {
  const committed = vi.fn();
  let commits = 0;
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = String(init?.body ?? "");
    if (method === "GET" && String(url).endsWith("/report")) return Promise.resolve(new Response("Source row,Status,Columns,Issue codes\r\n\"2\",\"invalid\",\"2\",\"field_value_invalid\"\r\n", { status: 200, headers: { "Content-Type": "text/csv; charset=utf-8" } }));
    if (method === "GET") return json(summary({ state: "reviewed", mode: "create", version: 3, reviewOffset: 2, reviewHash: hash, counts: { unreviewed: 0, valid: 1, invalid: 1, applied: 0, blocked: 0 }, rows: [{ ordinal: 0, sourceRow: 2, state: "invalid", duplicateWarning: true, errors: [{ code: "field_value_invalid", fieldKey: "core:notes" }, { code: "field_value_invalid", fieldKey: "hidden-field" }, { code: `=${secret}` }], name: "Ada", values: { "core:notes": secret, "hidden-field": secret } }], nextOffset: null }));
    if (body.includes('"configure"')) return json(summary({ state: "reviewing", mode: "create", version: 2 }));
    if (body.includes('"review"')) return json(summary({ state: "reviewed", mode: "create", version: 3, reviewOffset: 2, reviewHash: hash, counts: { unreviewed: 0, valid: 1, invalid: 1, applied: 0, blocked: 0 } }));
    if (body.includes('"commit"')) {
      commits += 1;
      if (commits === 1) return json({ error: "Service temporarily unavailable.", code: "service_unavailable", retryable: true }, 503);
      return json(summary({ state: "completed", mode: "create", version: 5, reviewHash: hash, counts: { unreviewed: 0, valid: 0, invalid: 1, applied: 1, blocked: 0 }, rows: [] }));
    }
    return json(summary());
  });
  const blobs: Blob[] = [];
  const previousCreate = URL.createObjectURL;
  const previousRevoke = URL.revokeObjectURL;
  URL.createObjectURL = ((blob: Blob) => { blobs.push(blob); return "blob:report"; }) as typeof URL.createObjectURL;
  URL.revokeObjectURL = (() => {}) as typeof URL.revokeObjectURL;
  const view = await mount({ onCommitted: committed });
  try {
    await chooseFile(view.host, "people.csv", "Name,Notes\nAda,Hello");
    await click(view.host, "Stage import");
    await select(view.host.querySelector('[aria-label="Column for Notes"]')!, "1");
    await act(async () => view.host.querySelector<HTMLFormElement>('form[aria-label="Import mapping"]')!.requestSubmit());
    await click(view.host, "Review next 100 rows");
    expect(view.host.textContent).toContain("Notes field_value_invalid");
    expect(view.host.textContent).toContain("Visible duplicate");
    expect(view.host.textContent).toContain(secret);
    expect(view.host.textContent).not.toContain("hidden-field");
    expect(view.host.textContent).not.toContain(`=${secret}`);
    const commitButton = () => [...view.host.querySelectorAll("button")].find((item) => item.textContent === "Commit reviewed creates" || item.textContent === "Retry this import command") as HTMLButtonElement;
    expect(commitButton().disabled).toBe(true);
    for (const name of ["Import the valid rows and leave invalid rows uncommitted", "Allow visible duplicate warnings", "Acknowledge source conversion warnings"]) {
      const box = [...view.host.querySelectorAll("label")].find((item) => item.textContent?.includes(name))!.querySelector("input")!;
      await act(async () => box.click());
    }
    expect(commitButton().disabled).toBe(false);
    await click(view.host, "Commit reviewed creates");
    expect(view.host.textContent).toContain("Retry this same command");
    await click(view.host, "Retry this import command");
    const commitsSent = posted().filter((call) => String(call.body).includes('"commit"')).map((call) => JSON.parse(String(call.body)));
    expect(commitsSent).toHaveLength(2);
    expect(commitsSent[0]).toEqual(commitsSent[1]);
    expect(commitsSent[0]).toMatchObject({ confirm: "create-records", allowValidSubset: true, allowDuplicates: true, acknowledgeWarnings: true, reviewHash: hash });
    expect(commitsSent[0].uniqueKey).toBeUndefined();
    expect(committed).toHaveBeenCalledTimes(1);
    await click(view.host, "Download error report");
    const reportCall = fetchMock.mock.calls.find((call) => String(call[0]).endsWith("/report"));
    expect(String(reportCall?.[0])).toBe(`/api/v1/workspaces/${encodeURIComponent("ws one")}/tenants/00000000-0000-4000-8000-000000000002/record-imports/${jobId}/report`);
    expect(String(reportCall?.[0])).not.toContain(secret);
    expect(await blobs.at(-1)?.text()).not.toContain(secret);
    expect(await blobs.at(-1)?.text()).toContain("field_value_invalid");
  } finally {
    URL.createObjectURL = previousCreate;
    URL.revokeObjectURL = previousRevoke;
    await view.dispose();
  }
});
