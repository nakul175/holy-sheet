// @vitest-environment jsdom
import { createElement } from "react";
import { createRoot } from "react-dom/client";
import { act } from "react";
import { expect, it } from "vitest";
import { PageReviewChrome } from "../components/page-review";
import { SpaceReviewTable } from "../components/space-reviews";
import { EXPIRED_BANNER, OWNER_NEEDED } from "./page-review-copy";
import type { PageReviewView, SpaceReviewDashboard } from "./page-review";

const view = (patch: Partial<PageReviewView>): PageReviewView => ({
  pageId: "p-100",
  canManage: false,
  cycleMonths: 6,
  startsOn: "2026-11-01",
  nextReviewOn: "2027-05-01",
  expiresOn: "2027-05-01",
  header: "Next review 1 May 2027",
  banner: null,
  badge: "Verified",
  verified: true,
  overdue: false,
  expired: false,
  reviewerName: "U-OWN",
  reviewedAtIst: "01 Nov 2026, 10:00 IST",
  note: null,
  coversPublishedVersion: true,
  ...patch,
});

async function render(node: ReturnType<typeof createElement>) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(node));
  return { host, unmount: async () => { await act(async () => root.unmount()); host.remove(); } };
}

it("shows the next review date, verified badge, and expired banner", async () => {
  const verified = await render(createElement(PageReviewChrome, { view: view({}) }));
  expect(verified.host.textContent).toContain("Next review 1 May 2027");
  expect(verified.host.textContent).toContain("Verified · U-OWN · 01 Nov 2026, 10:00 IST");
  await verified.unmount();
  const expired = await render(createElement(PageReviewChrome, { view: view({ verified: false, badge: null, banner: EXPIRED_BANNER, expired: true, reviewerName: null, reviewedAtIst: null }) }));
  expect(expired.host.textContent).toContain(EXPIRED_BANNER);
  expect(expired.host.querySelector(".review-expired-banner")?.getAttribute("role")).toBe("status");
  await expired.unmount();
});

it("lists review rows with owner needed and the expired status", async () => {
  const dashboard: SpaceReviewDashboard = {
    workspaceId: "ws-a",
    spaceId: "space-product",
    spaceName: "Product",
    filter: "open",
    canManagePolicy: true,
    hideExpiredFromReaders: false,
    counts: { due: 1, overdue: 0, expired: 1, scheduled: 0 },
    rows: [
      { pageId: "p-100", title: "SOP", ownerId: "owner", ownerLabel: OWNER_NEEDED, ownerNeeded: true, cycleMonths: 6, nextReviewOn: "2026-10-01", nextReviewLabel: "1 Oct 2026", expiresOn: "2026-10-01", expiresLabel: "1 Oct 2026", lastReviewedAtIst: null, statuses: ["expired", "overdue"] },
    ],
  };
  const rendered = await render(createElement(SpaceReviewTable, { dashboard }));
  expect(rendered.host.textContent).toContain("Due 1");
  expect(rendered.host.textContent).toContain(OWNER_NEEDED);
  expect(rendered.host.textContent).toContain("expired");
  await rendered.unmount();
});
