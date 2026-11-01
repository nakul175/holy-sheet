// @vitest-environment jsdom
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { expect, it, vi } from "vitest";
import { VariantChrome, VariantHost } from "../components/document-variants";
import type { VariantView } from "../lib/document-variants";

const mocks = vi.hoisted(() => ({ request: vi.fn() }));
vi.mock("../components/editor/use-document-session", () => ({
  requestJson: mocks.request,
  ApiError: class ApiError extends Error { status: number; constructor(message: string, status = 0) { super(message); this.status = status; } },
}));

function view(patch: Partial<VariantView> = {}): VariantView {
  return {
    pageId: "p-100",
    canLink: false,
    canMarkSynced: false,
    canSetRouting: false,
    routing: "banner",
    profileLanguage: "hi",
    sourceLanguage: "en",
    currentLanguage: "en",
    switcher: [
      { language: "en", label: "EN", pageId: "p-100", current: true },
      { language: "hi", label: "हिन्दी", pageId: "p-110", current: false },
    ],
    banner: { pageId: "p-110", language: "hi", label: "हिन्दी", message: "A हिन्दी version of this document is available.", stayLabel: "Stay on English" },
    redirectTo: null,
    trashNotes: [],
    stale: null,
    ...patch,
  };
}

async function render(node: ReturnType<typeof createElement>) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove(); } };
}

it("renders the language switcher as EN | हिन्दी without a hidden language", async () => {
  const shown = await render(createElement(VariantChrome, { view: view(), placement: "document", onOpen: () => undefined }));
  expect(shown.host.textContent).toContain("EN");
  expect(shown.host.textContent).toContain("हिन्दी");
  expect(shown.host.querySelectorAll(".variant-switcher-link")).toHaveLength(2);
  expect(shown.host.querySelector("[aria-current='true']")?.textContent).toBe("EN");
  await shown.unmount();
  const hidden = await render(createElement(VariantChrome, { view: view({ switcher: [{ language: "en", label: "EN", pageId: "p-100", current: true }], banner: null }), placement: "sidebar", onOpen: () => undefined }));
  expect(hidden.host.textContent).not.toContain("हिन्दी");
  expect(hidden.host.querySelector(".variant-switcher-link")).toBeNull();
  await hidden.unmount();
});

it("shows the stale badge, an editor diff link, and the trash note", async () => {
  const stale = await render(createElement(VariantChrome, { view: view({ banner: null, canMarkSynced: true, stale: { badge: "Behind English source (v3 → v4)", syncedVersion: 3, sourceVersion: 4, diffHref: "/pages/p-110?variantDiff=3-4" }, trashNotes: [{ label: "हिन्दी", message: "variant in trash" }] }), placement: "document", onOpen: () => undefined }));
  expect(stale.host.textContent).toContain("Behind English source (v3 → v4)");
  expect(stale.host.querySelector(".variant-diff-link")?.getAttribute("href")).toContain("variantDiff=3-4");
  expect(stale.host.textContent).toContain("Mark up to date with v4");
  expect(stale.host.textContent).toContain("variant in trash");
  await stale.unmount();
  const reader = await render(createElement(VariantChrome, { view: view({ banner: null, stale: { badge: "Behind English source (v3 → v4)", syncedVersion: 3, sourceVersion: 4, diffHref: null } }), placement: "document", onOpen: () => undefined }));
  expect(reader.host.querySelector(".variant-diff-link")).toBeNull();
  expect(reader.host.textContent).not.toContain("Mark up to date");
  await reader.unmount();
});

it("auto-routes a reader to the preferred variant once", async () => {
  mocks.request.mockResolvedValue(view({ banner: null, redirectTo: { pageId: "p-110", language: "hi", remember: true } }));
  const onOpen = vi.fn();
  const rendered = await render(createElement(VariantHost, { pageId: "p-100", workspaceId: "ws-a", placement: "document", onOpen }));
  await act(async () => { await Promise.resolve(); });
  expect(onOpen).toHaveBeenCalledWith("p-110");
  expect(mocks.request.mock.calls.some(call => String(call[0]).includes("/variants") && call[1] && String((call[1] as { body?: string }).body).includes("\"choice\":\"hi\""))).toBe(true);
  await rendered.unmount();
});
