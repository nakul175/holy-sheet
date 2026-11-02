/** @vitest-environment jsdom */
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { afterEach, expect, it, vi } from "vitest";
import axe from "axe-core";
import { NotLatestBanner, PublishForm, PublishedBanner, PublishedNotFound, StablePublishedPage, StablePublishedView, UnpublishedChanges, VersionList, copyStableLink } from "../components/published-page";
import type { DraftPublication, PublishedResolution } from "./published-pages";

const mocks = vi.hoisted(() => {
  class ApiError extends Error { status: number; code: string; constructor(message: string, status = 404, code = "not_found") { super(message); this.status = status; this.code = code; } }
  return { request: vi.fn(), ApiError };
});
vi.mock("../components/editor/use-document-session", () => ({ requestJson: mocks.request, ApiError: mocks.ApiError }));

afterEach(() => { document.body.replaceChildren(); mocks.request.mockReset(); });

async function render(node: ReturnType<typeof createElement>) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => { root.render(node); });
  return host;
}

const published: Extract<PublishedResolution, { kind: "published" }> = {
  kind: "published",
  pageId: "p-100",
  title: "Onboarding runbook",
  text: "Approved runbook text",
  versionNo: 1,
  revisionId: "p-100:2",
  banner: "Published 31 Oct 2026, 9:10 PM IST by U-OWN",
  stablePath: "/s/ops/onboarding-runbook",
  canonicalPath: "/p/p-100",
  latest: false,
  notLatestBanner: "This is not the latest version",
  latestPath: "/s/ops/onboarding-runbook",
  versions: [{ versionNo: 1, publishedAt: "2026-10-31T15:40:00.000Z", publishedAtIst: "31 Oct 2026, 9:10 PM IST", publisher: "U-OWN", note: "Initial publication" }],
  records: [{ blockId: "card", status: "visible", title: "R-100", fields: [{ key: "core:job-title", label: "Job title", access: "visible", value: "Nurse" }, { key: "core:email", label: "Email", access: "hidden" }], valuesAsOf: "Values as of 31 Oct 2026, 9:10 PM IST" }],
};

const draft: DraftPublication = {
  canPublish: true,
  suggestedSlug: "onboarding-runbook",
  slug: null,
  spaceSlug: "ops",
  stablePath: null,
  canonicalPath: "/p/p-100",
  live: false,
  unpublished: false,
  unpublishReason: null,
  versionNo: null,
  banner: null,
  unpublishedChanges: true,
  diff: { changed: true, lines: [{ kind: "removed", text: "Approved runbook text" }, { kind: "added", text: "Draft secret sentence" }] },
  versions: [],
};

it("shows the published banner, copy link, versions and not-latest banner", async () => {
  const write = vi.fn(async () => undefined);
  Object.assign(navigator, { clipboard: { writeText: write } });
  const host = await render(createElement(StablePublishedView, { result: { ...published, latest: false } }));
  expect(host.textContent).toContain("Published 31 Oct 2026, 9:10 PM IST by U-OWN");
  expect(host.textContent).toContain("This is not the latest version");
  expect(host.querySelector("a[href='/s/ops/onboarding-runbook']")?.textContent).toBe("Latest version");
  await act(async () => { host.querySelector("button")?.click(); });
  expect(await copyStableLink("/s/ops/onboarding-runbook")).toBe(`${location.origin}/s/ops/onboarding-runbook`);
  expect(write).toHaveBeenCalledWith(`${location.origin}/s/ops/onboarding-runbook`);
  const versions = host.querySelector("button[aria-expanded]");
  await act(async () => { (versions as HTMLButtonElement).click(); });
  expect(host.textContent).toContain("v1 · 31 Oct 2026, 9:10 PM IST · U-OWN · Initial publication");
  expect(host.textContent).toContain("Values as of 31 Oct 2026, 9:10 PM IST");
  expect(host.textContent).toContain("Email: Hidden");
  const audit = await axe.run(host, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } });
  expect(audit.violations).toEqual([]);
});

it("shows unpublished changes and the publish dialog", async () => {
  const host = await render(createElement("div", null, createElement(UnpublishedChanges, { lines: draft.diff.lines }), createElement(PublishForm, { pageId: "p-100", state: draft, onClose: () => undefined, onPublished: () => undefined })));
  expect(host.textContent).toContain("Unpublished changes");
  expect(host.textContent).toContain("Added: Draft secret sentence");
  expect(host.textContent).toContain("Removed: Approved runbook text");
  expect((host.querySelector("input[name=slug]") as HTMLInputElement).value).toBe("onboarding-runbook");
  expect(host.textContent).toContain("Freeze record values at publish");
  const dialog = host.querySelector("[role=dialog]");
  expect(dialog).toBeTruthy();
  const audit = await axe.run(dialog as HTMLElement, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa"] } });
  expect(audit.violations.map(item => item.id)).toEqual([]);
});

it("uses one not-found page with no slug and clears published text after access is revoked", async () => {
  const missing = await render(createElement(PublishedNotFound));
  expect(missing.textContent).toBe("Page not found");
  expect(missing.innerHTML).not.toContain("board-minutes");
  mocks.request.mockRejectedValue(new mocks.ApiError("Page not found"));
  const page = await render(createElement(StablePublishedPage, { initial: { ...published, latest: true, notLatestBanner: null }, space: "ops", slug: "onboarding-runbook", workspaceId: "ws" }));
  expect(page.textContent).toContain("Approved runbook text");
  await act(async () => { window.dispatchEvent(new Event("focus")); });
  expect(page.textContent).toBe("Page not found");
  expect(page.textContent).not.toContain("Onboarding runbook");
  expect(createElement(PublishedBanner, { banner: published.banner })).toBeTruthy();
  expect(createElement(NotLatestBanner, { href: published.latestPath })).toBeTruthy();
  expect(createElement(VersionList, { versions: published.versions })).toBeTruthy();
});
