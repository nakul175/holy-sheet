// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import RecordImport from "../components/record-import";

const fetchMock = vi.fn();
const jobId = "00000000-0000-4000-8000-0000000000c1";
const profileId = "00000000-0000-4000-8000-000000000011";
const secret = "secret-sample-value";
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});
const json = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
const counts = { unreviewed: 1, valid: 0, invalid: 0, applied: 0, blocked: 0 };
const summary = { id: jobId, collection: "organisations", name: "people.csv", format: "csv", headers: ["Name", "Notes"], state: "staged", mode: null, rowCount: 1, version: 1, reviewOffset: 0, reviewHash: null, warnings: [], expiresAt: "2026-11-01T00:00:00.000Z", counts };
const profile = { id: profileId, collection: "organisations", scope: "personal", name: "Repeat organisations", mode: "create", version: 1, schemaVersion: 1, canManage: true, canUse: true, compatibility: "compatible", restricted: false, columns: [{ header: "Name", role: "name" }, { header: "Notes", role: "field", fieldId: "core:notes" }], reasons: [] };

async function mount() {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.stubGlobal("fetch", fetchMock);
  const host = document.createElement("div");
  document.body.append(host);
  const root: Root = createRoot(host);
  await act(async () => root.render(createElement(RecordImport, { workspaceId: "ws one", tenantId: "00000000-0000-4000-8000-000000000002", collection: "organisations", canCreate: true, canManageSharedProfiles: false, fields: [{ key: "core:notes", label: "Notes", kind: "long-text" }] })));
  return host;
}
function button(host: ParentNode, name: string) {
  const found = [...host.querySelectorAll("button")].find((item) => item.textContent === name) as HTMLButtonElement | undefined;
  expect(found, name).toBeTruthy();
  return found!;
}

it("opens profiles from the keyboard, previews a repair, and does not commit the import", async () => {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const body = String(init?.body ?? "");
    if (method === "GET" && String(url).includes("/import-profiles")) return json({ schemaVersion: 1, canManageShared: false, profiles: [profile], drafts: [] });
    if (body.includes('"apply"')) return json({ compatibility: "incompatible", reasons: [{ code: "ambiguous_header" }], repairRequired: true, restricted: false, issues: [{ code: "ambiguous_header", header: "Notes", repair: true }], headerDiffs: [{ header: "Notes", status: "ambiguous" }], typeDiffs: [{ header: "Notes", expectedKind: "long-text", observedKind: "text", difference: false, choiceMismatch: false }], mapping: null, samplesStored: false, profileId, version: 1 });
    if (String(url).includes("/record-imports") && method === "POST") return json(summary);
    return json({ error: "unexpected" }, 500);
  });
  const host = await mount();
  const input = host.querySelector<HTMLInputElement>('input[type="file"]')!;
  const file = new File(["Name,Notes\nAda," + secret], "people.csv", { type: "text/csv" });
  await act(async () => {
    Object.defineProperty(input, "files", { configurable: true, value: [file] });
    input.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => button(host, "Stage import").click());
  expect(host.querySelector('a[href*="import-profiles"]')).toBeNull();
  await act(async () => button(host, "Import mapping profiles").click());
  expect(button(host, "Hide import profiles").getAttribute("aria-expanded")).toBe("true");
  expect(host.textContent).toContain("Shared profiles need the manage-import-profiles capability");
  const shared = host.querySelector<HTMLInputElement>('input[name="import-profile-audience"][value="shared"]')!;
  expect(shared.disabled).toBe(true);
  const saved = host.querySelector<HTMLSelectElement>('[aria-label="Saved import profile"]')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(saved, profileId);
    saved.dispatchEvent(new Event("change", { bubbles: true }));
  });
  await act(async () => button(host, "Apply profile").click());
  expect(host.textContent).toContain("Repair is required");
  expect(button(host, "Use this mapping draft").disabled).toBe(true);
  const posts = fetchMock.mock.calls.filter((call) => call[1]?.method === "POST").map((call) => String(call[1].body));
  expect(posts.some((body) => body.includes('"configure"') || body.includes('"commit"'))).toBe(false);
  expect(posts.filter((body) => body.includes('"apply"')).every((body) => !body.includes(secret))).toBe(true);
  const download = host.querySelector<HTMLAnchorElement>("a")!;
  expect(download.textContent).toBe("Download mapping");
  expect(download.getAttribute("href")).toContain("/import-profiles/");
  expect(download.getAttribute("href")).toContain("/download");
});
