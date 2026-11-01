// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { VersionDrawer } from "../components/attachment-versions";
import RecordHistory from "../components/record-history";

const fetchMock = vi.fn();
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); document.body.replaceChildren(); });
const response = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
const version = {
  id: "00000000-0000-4000-8000-0000000000a1",
  versionNo: 2,
  uploaderId: "U-OWN",
  atLabel: "01 Nov 2026, 07:17 IST",
  size: 12,
  checksum: "ab".repeat(32),
  note: "signed copy",
  scanStatus: "clean",
  current: false,
  deleted: false,
  purgeAfterLabel: null,
  deleteReason: null,
};

async function mount(node: ReturnType<typeof createElement>) {
  vi.stubGlobal("fetch", fetchMock);
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  return { host, dispose: async () => { await act(async () => root.unmount()); host.remove(); } };
}

it("lists versions, restores a copy and shows a pinned version as not latest", async () => {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    const address = String(url);
    if (init?.method === "POST") return response({ restored: true, versionNo: 4, note: "Restored from v1" });
    if (address.includes("versionNo=2")) return response({ versionNo: 2, currentVersionNo: 4, label: "Not latest", pinLabel: "@v2", atLabel: "01 Nov 2026, 07:17 IST", scanStatus: "clean", name: "contract.pdf" });
    return response({ fileId: "00000000-0000-4000-8000-0000000000bb", name: "contract.pdf", currentVersionNo: 4, canUpload: true, versions: [{ ...version, versionNo: 1, current: false }, { ...version, id: "00000000-0000-4000-8000-0000000000a2", versionNo: 4, current: true, note: null }] });
  });
  const view = await mount(createElement(VersionDrawer, { workspaceId: "ws-a", tenantId: "00000000-0000-4000-8000-000000000002", recordId: "00000000-0000-4000-8000-0000000000cc", fileId: "00000000-0000-4000-8000-0000000000bb", fileName: "contract.pdf" }));
  try {
    await act(async () => [...view.host.querySelectorAll("button")].find(button => button.textContent === "Versions")!.click());
    expect(view.host.textContent).toContain("Current v4");
    expect(view.host.textContent).toContain("01 Nov 2026, 07:17 IST");
    expect(view.host.textContent).toContain("clean");
    expect(view.host.textContent).toContain("signed copy");
    await act(async () => [...view.host.querySelectorAll("button")].find(button => button.textContent === "Restore v1")!.click());
    const restored = fetchMock.mock.calls.filter(call => call[1]?.method === "POST").map(call => JSON.parse(String(call[1].body)));
    expect(restored.at(-1)).toMatchObject({ action: "restore", versionNo: 1 });
    await act(async () => [...view.host.querySelectorAll("button")].find(button => button.textContent === "Copy pinned link")!.click());
    expect(view.host.textContent).toContain("Pinned link @v1");
    const form = view.host.querySelector<HTMLFormElement>('form[aria-label="Open pinned version"]')!;
    await act(async () => { form.querySelector("input")!.value = "2"; form.requestSubmit(); });
    expect(view.host.textContent).toContain("@v2");
    expect(view.host.textContent).toContain("Not latest");
  } finally { await view.dispose(); }
});

it("shows attachment history with the actor and IST time", async () => {
  fetchMock.mockImplementation(async () => response({
    anchorVersion: 3,
    nextCursor: null,
    events: [{
      id: "00000000-0000-4000-8000-0000000000e1",
      version: 3,
      actorId: "U-OWN",
      sourceApp: "holy-sheet",
      serviceSubject: null,
      operationId: "00000000-0000-4000-8000-0000000000e2",
      kind: "attachment-version-2",
      batchId: null,
      sourceRow: null,
      at: "2026-11-01T01:00:00.000Z",
      before: null,
      after: { name: "R-100", values: {} },
    }],
  }));
  const view = await mount(createElement(RecordHistory, { workspaceId: "ws-a", tenantId: "00000000-0000-4000-8000-000000000002", recordId: "00000000-0000-4000-8000-0000000000cc", recordVersion: 3, canRestore: false, fields: [], onRestored: () => undefined }));
  try {
    expect(view.host.textContent).toContain("attachment-version-2");
    expect(view.host.textContent).toContain("U-OWN");
    expect(view.host.textContent).toContain("01 Nov 2026, 06:30 IST");
  } finally { await view.dispose(); }
});
