"use client";
import { WorkspaceSection, SpaceTabs } from "./workspace-section";
import { useEffect, useState } from "react";
import { ApiError, requestJson } from "./editor/use-document-session";
import type { SpaceReviewDashboard } from "../lib/page-review";
import { OWNER_NEEDED, reviewFilters } from "../lib/page-review-copy";

export function SpaceReviewTable({ dashboard }: { dashboard: SpaceReviewDashboard }) {
  return <div className="space-reviews">
    <p className="review-counts">Due {dashboard.counts.due} · Overdue {dashboard.counts.overdue} · Expired {dashboard.counts.expired}</p>
    {!dashboard.rows.length && <p>No pages in this filter.</p>}
    {!!dashboard.rows.length && <div className="space-reviews-scroll"><table>
      <thead><tr><th>Page</th><th>Status</th><th>Owner</th><th>Next review</th><th>Expires</th></tr></thead>
      <tbody>{dashboard.rows.map(row => <tr key={row.pageId}>
        <td><a href={`/pages/${encodeURIComponent(row.pageId)}`}>{row.title}</a></td>
        <td>{row.statuses.filter(status => status !== "scheduled").join(", ") || "Scheduled"}</td>
        <td>{row.ownerNeeded ? OWNER_NEEDED : row.ownerLabel}</td>
        <td>{row.nextReviewLabel}</td>
        <td>{row.expiresLabel}</td>
      </tr>)}</tbody>
    </table></div>}
  </div>;
}

export function isEmptyReviewDashboard(dashboard: SpaceReviewDashboard) {
  return Object.values(dashboard.counts).every(count => count === 0);
}

export default function SpaceReviews({ workspaceId, spaceId }: { workspaceId: string; spaceId: string }) {
  const [filter, setFilter] = useState("open");
  const [dashboard, setDashboard] = useState<SpaceReviewDashboard | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = async (next = filter) => {
    const data = await requestJson<SpaceReviewDashboard>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/spaces/${encodeURIComponent(spaceId)}/reviews?filter=${encodeURIComponent(next)}`);
    setDashboard(data);
    setError("");
    return data;
  };
  useEffect(() => {
    let alive = true;
    setDashboard(null);
    void requestJson<SpaceReviewDashboard>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/spaces/${encodeURIComponent(spaceId)}/reviews?filter=${encodeURIComponent(filter)}`).then(data => { if (alive) setDashboard(data); }).catch(reason => { if (alive) setError(reason instanceof ApiError ? reason.message : "Space is restricted or unavailable"); });
    return () => { alive = false; };
  }, [workspaceId, spaceId, filter]);
  async function togglePolicy(hideExpiredFromReaders: boolean) {
    if (!dashboard) return;
    setBusy(true);
    setError("");
    try {
      await requestJson(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/spaces/${encodeURIComponent(spaceId)}/reviews`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "policy", operationId: crypto.randomUUID(), hideExpiredFromReaders }) });
      await load();
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "Review status is unavailable.");
    } finally {
      setBusy(false);
    }
  }
  const csv = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/spaces/${encodeURIComponent(spaceId)}/reviews?export=csv&filter=${encodeURIComponent(filter)}`;
  const empty = dashboard ? isEmptyReviewDashboard(dashboard) : false;
  return <WorkspaceSection workspaceId={workspaceId} section="Spaces" spaces={dashboard ? [{id:spaceId,name:dashboard.spaceName}] : []}><main className="space-reviews-page"><a className="skip-link" href="#space-reviews">Skip to reviews</a><p><a href="/">Pages by Aplyd</a> / <a href={`/workspaces/${encodeURIComponent(workspaceId)}/spaces`}>Spaces</a> / Page reviews</p>
    {error && <p role="alert">{error}</p>}
    {!dashboard && !error && <p role="status">Opening reviews…</p>}
    {dashboard && <div id="space-reviews">
      <h1>{dashboard.spaceName}</h1><SpaceTabs workspaceId={workspaceId} spaceId={spaceId} reviews/>
      {empty ? <section className="reviews-empty" aria-labelledby="reviews-empty-title">
        <span className="reviews-empty-icon" aria-hidden="true">✓</span>
        <h2 id="reviews-empty-title">No page reviews yet</h2>
        <p>Set a date for the page owner to check that the content is still accurate.</p>
        <a className="reviews-empty-cta" href={`/workspaces/${encodeURIComponent(workspaceId)}/spaces/${encodeURIComponent(spaceId)}`}>Choose a page to review</a>
        <small>You can add a review from a page’s ••• menu.</small>
      </section> : <><div className="review-toolbar">
        <label>Filter <select aria-label="Review filter" value={filter} onChange={event => setFilter(event.target.value)}>{reviewFilters.map(item => <option key={item} value={item}>{item === "open" ? "Due, overdue, and expired" : item[0].toUpperCase() + item.slice(1)}</option>)}</select></label>
        <a href={csv} download="page-reviews.csv">Export CSV</a>
      </div>
      {dashboard.canManagePolicy && <label className="review-policy"><input type="checkbox" checked={dashboard.hideExpiredFromReaders} disabled={busy} onChange={event => void togglePolicy(event.target.checked)} /> Hide expired from search for readers</label>}
      <SpaceReviewTable dashboard={dashboard} />
      </>}
    </div>}
  </main></WorkspaceSection>;
}
