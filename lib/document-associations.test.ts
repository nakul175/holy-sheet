// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { LinkedRecords, RecordDocuments } from "../components/document-associations";

const fetchMock = vi.fn();
afterEach(() => { vi.unstubAllGlobals(); vi.clearAllMocks(); });
const response = (body: unknown, status = 200) => Promise.resolve(new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));

function list(title: string, extra: Record<string, unknown> = {}) {
  return { items: [{ linkId: "00000000-0000-4000-8000-0000000000aa", docType: "file", docId: "00000000-0000-4000-8000-0000000000bb", recordId: "00000000-0000-4000-8000-0000000000cc", title, availability: "visible", label: null, linkedAtLabel: "01 Nov 2026, 06:30 IST", href: null, canUnlink: true, ...extra }], nextCursor: null, countLabel: "1 you can see", canLink: true };
}

async function mount(node: ReturnType<typeof createElement>) {
  vi.stubGlobal("fetch", fetchMock);
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  return { host, dispose: async () => { await act(async () => root.unmount()); host.remove(); } };
}

it("links and unlinks from the documents tab without showing a hidden title", async () => {
  fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") {
      const body = JSON.parse(String(init.body));
      if (body.action === "unlink" && !body.disposition) return response({ error: "Choose delete or keep this file in Unlinked files for 30 days.", code: "unlink_choice_required" }, 422);
      return response({ unlinked: true });
    }
    return response(list("contract.pdf"));
  });
  const view = await mount(createElement(RecordDocuments, { workspaceId: "ws-a", tenantId: "00000000-0000-4000-8000-000000000002", recordId: "00000000-0000-4000-8000-0000000000cc" }));
  try {
    await act(async () => [...view.host.querySelectorAll("button")].find(button => button.textContent === "Documents")!.click());
    expect(view.host.textContent).toContain("contract.pdf");
    expect(view.host.textContent).toContain("1 you can see");
    expect(view.host.textContent).toContain("01 Nov 2026, 06:30 IST");
    expect(view.host.textContent).not.toContain("P-200 secret");
    await act(async () => view.host.querySelector<HTMLSelectElement>('[aria-label="Document type"]')!.value = "file");
    await act(async () => view.host.querySelector<HTMLSelectElement>('[aria-label="Document type"]')!.dispatchEvent(new Event("change", { bubbles: true })));
    await act(async () => [...view.host.querySelectorAll("button")].find(button => button.textContent === "Apply filters")!.click());
    expect(fetchMock.mock.calls.some(call => String(call[0]).includes("type=file"))).toBe(true);
    await act(async () => [...view.host.querySelectorAll("button")].find(button => button.textContent === "Unlink")!.click());
    expect(view.host.textContent).toContain("Keep in Unlinked files");
    await act(async () => [...view.host.querySelectorAll("button")].find(button => button.textContent === "Keep in Unlinked files")!.click());
    const kept = fetchMock.mock.calls.filter(call => call[1]?.method === "POST").map(call => JSON.parse(String(call[1].body)));
    expect(kept.at(-1)).toMatchObject({ action: "unlink", disposition: "keep", docType: "file" });
    await act(async () => { const form = view.host.querySelector<HTMLFormElement>('form[aria-label="Also link contract.pdf"]')!; form.querySelector("input")!.value = "00000000-0000-4000-8000-0000000000dd"; form.requestSubmit(); });
    const linked = fetchMock.mock.calls.filter(call => call[1]?.method === "POST").map(call => JSON.parse(String(call[1].body)));
    expect(linked.at(-1)).toMatchObject({ action: "link", docType: "file", recordId: "00000000-0000-4000-8000-0000000000dd" });
  } finally { await view.dispose(); }
});

it("adds a linked record from the page sidebar", async () => {
  fetchMock.mockImplementation(async (_url: string, init?: RequestInit) => init?.method === "POST" ? response({ linked: true }) : response({ items: [], nextCursor: null, countLabel: "0 you can see", canLink: true }));
  const view = await mount(createElement(LinkedRecords, { pageId: "page-100" }));
  try {
    expect(view.host.querySelector("aside")?.getAttribute("aria-label")).toBe("Linked records");
    const form = view.host.querySelector<HTMLFormElement>('form[aria-label="Add linked record"]')!;
    await act(async () => { form.querySelector("input")!.value = "00000000-0000-4000-8000-0000000000cc"; form.requestSubmit(); });
    const body = JSON.parse(String(fetchMock.mock.calls.find(call => call[1]?.method === "POST")?.[1].body));
    expect(body).toMatchObject({ action: "link", recordId: "00000000-0000-4000-8000-0000000000cc" });
    expect(String(fetchMock.mock.calls.find(call => call[1]?.method === "POST")?.[0])).toContain("/api/v1/pages/page-100/linked-records");
  } finally { await view.dispose(); }
});
