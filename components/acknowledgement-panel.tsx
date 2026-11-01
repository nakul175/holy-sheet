"use client";
import { useEffect, useState } from "react";
import { acknowledgementAllowed, acknowledgementBannerCopy, type AcknowledgementAudienceChoices, type AcknowledgementOwnerView, type AcknowledgementView, type AudienceTarget } from "../lib/acknowledgement-copy";
import { Dialog } from "./editor/dialog";
import { requestJson } from "./editor/use-document-session";

export function AcknowledgementBanner({ copy, shortDocument, scrollTarget, onAcknowledge }: { copy: string; shortDocument: boolean; scrollTarget?: HTMLElement | null; onAcknowledge: (input: { confirm: boolean; reachedEnd: boolean; waitedSeconds: number }) => Promise<void> | void }) {
  const [confirm, setConfirm] = useState(false);
  const [reachedEnd, setReachedEnd] = useState(false);
  const [waited, setWaited] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!shortDocument) return;
    const timer = window.setTimeout(() => setWaited(true), 30_000);
    return () => window.clearTimeout(timer);
  }, [shortDocument]);
  useEffect(() => {
    const root = scrollTarget;
    if (!root) return;
    const mark = () => {
      if (root.clientHeight <= 0) return;
      const atEnd = root.scrollTop + root.clientHeight >= root.scrollHeight - 8;
      if (root.scrollHeight <= root.clientHeight + 8 || atEnd) setReachedEnd(true);
    };
    mark();
    root.addEventListener("scroll", mark, { passive: true });
    window.addEventListener("scroll", mark, { passive: true });
    window.addEventListener("resize", mark);
    return () => {
      root.removeEventListener("scroll", mark);
      window.removeEventListener("scroll", mark);
      window.removeEventListener("resize", mark);
    };
  }, [scrollTarget]);
  const ready = acknowledgementAllowed({ confirm, reachedEnd, shortDocument, waitedSeconds: waited ? 30 : 0 }) === "ready";
  return <div className="ack-banner" role="region" aria-label="Acknowledgement">
    <p>{copy}</p>
    <label><input type="checkbox" checked={confirm} onChange={event => setConfirm(event.target.checked)} />I have read this published version</label>
    <button type="button" disabled={!ready} onClick={() => { setError(""); void Promise.resolve(onAcknowledge({ confirm: true, reachedEnd, waitedSeconds: waited ? 30 : 0 })).catch(error => setError(error instanceof Error ? error.message : "Acknowledgement could not be saved.")); }}>Acknowledge</button>
    {error && <p role="alert">{error}</p>}
  </div>;
}

export function AcknowledgementRequestDialog({ versionLabel, choices, onClose, onSubmit }: { versionLabel: string; choices: AcknowledgementAudienceChoices; onClose: () => void; onSubmit: (input: { dueOn: string; audience: AudienceTarget[] }) => Promise<void> }) {
  const [dueOn, setDueOn] = useState("2026-11-07");
  const [selected, setSelected] = useState<AudienceTarget[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  function toggle(target: AudienceTarget, checked: boolean) {
    setSelected(current => checked ? [...current, target] : current.filter(item => !(item.kind === target.kind && item.id === target.id)));
  }
  return <Dialog title="Request acknowledgement" onClose={onClose}><form className="ack-request" onSubmit={event => { event.preventDefault(); if (!selected.length || !dueOn) { setError("Choose an audience and a due date."); return; } setBusy(true); setError(""); void onSubmit({ dueOn, audience: selected }).catch(reason => { setError(reason instanceof Error ? reason.message : "The acknowledgement request could not be saved."); setBusy(false); }); }}>
    <p>Ask people who can already read {versionLabel} to acknowledge it. This does not grant access.</p>
    <fieldset><legend>Audience</legend>
      {choices.groups.map(group => <label key={group.id}><input type="checkbox" checked={selected.some(item => item.kind === "group" && item.id === group.id)} onChange={event => toggle({ kind: "group", id: group.id }, event.target.checked)} />{group.name}</label>)}
      {choices.users.map(user => <label key={user.id}><input type="checkbox" checked={selected.some(item => item.kind === "user" && item.id === user.id)} onChange={event => toggle({ kind: "user", id: user.id }, event.target.checked)} />{user.name}</label>)}
      {choices.roles.map(role => <label key={role.id}><input type="checkbox" checked={selected.some(item => item.kind === "role" && item.id === role.id)} onChange={event => toggle({ kind: "role", id: role.id }, event.target.checked)} />{role.label}</label>)}
      {choices.space && <label><input type="checkbox" checked={selected.some(item => item.kind === "space" && item.id === choices.space!.id)} onChange={event => toggle({ kind: "space", id: choices.space!.id }, event.target.checked)} />Space members · {choices.space.name}</label>}
    </fieldset>
    <label>Due date <input type="date" value={dueOn} onChange={event => setDueOn(event.target.value)} required /></label>
    {error && <p role="alert">{error}</p>}
    <button type="submit" disabled={busy}>Request acknowledgement</button>
  </form></Dialog>;
}

export function AcknowledgementDashboard({ view, onClose, onExport, onReacknowledge }: { view: AcknowledgementOwnerView; onClose: () => void; onExport: (kind: "csv" | "evidence", status: string) => void; onReacknowledge: () => Promise<void> }) {
  const [filter, setFilter] = useState("all");
  const [error, setError] = useState("");
  const rows = view.assignments.filter(item => filter === "all" || item.status === filter);
  const newerMajor = view.publication && view.campaign && view.publication.bump === "major" && view.publication.versionId !== view.campaign.versionId;
  const newerMinor = view.publication && view.campaign && view.publication.bump === "minor" && view.publication.versionId !== view.campaign.versionId;
  return <Dialog title="Acknowledgements" onClose={onClose}><div className="ack-dashboard">
    {view.campaign ? <>
      <p>Completion {view.campaign.completion.label}</p>
      <p>Version {view.campaign.versionLabel}. Due {view.campaign.dueAtIst}.</p>
      {view.campaign.paused && <p>This acknowledgement request is paused.</p>}
      {newerMinor && <p>A minor publication keeps existing acknowledgements.</p>}
      <label>Filter <select aria-label="Acknowledgement filter" value={filter} onChange={event => setFilter(event.target.value)}><option value="all">All</option><option value="pending">Pending</option><option value="overdue">Overdue</option><option value="acknowledged">Acknowledged</option></select></label>
      <table><thead><tr><th>Name</th><th>Status</th><th>Version</th><th>Acknowledged</th></tr></thead><tbody>
        {rows.map(row => <tr key={row.userId}><td>{row.name}</td><td>{row.statusLabel}</td><td>{row.versionLabel}</td><td>{row.acknowledgedAtIst ?? ""}</td></tr>)}
      </tbody></table>
      {!!view.excluded.length && <ul>{view.excluded.map(item => <li key={item.userId}>{item.name ?? "Workspace member"}: {item.reason}</li>)}</ul>}
      <p>Earlier acknowledgement records remain in the evidence pack ({view.campaign.retainedRecords}).</p>
      <button type="button" onClick={() => onExport("csv", filter)}>Export CSV</button>
      <button type="button" onClick={() => onExport("evidence", "all")}>Export evidence pack</button>
      {newerMajor && <button type="button" onClick={() => { setError(""); void onReacknowledge().catch(reason => setError(reason instanceof Error ? reason.message : "Re-acknowledgement could not be saved.")); }}>Require re-acknowledgement</button>}
    </> : <p>No acknowledgement request is open.</p>}
    {error && <p role="alert">{error}</p>}
  </div></Dialog>;
}

export function AcknowledgementHost({ pageId, scrollTarget, requestOpen, dashboardOpen, onCloseRequest, onCloseDashboard }: { pageId: string; scrollTarget?: { current: HTMLElement | null }; requestOpen: boolean; dashboardOpen: boolean; onCloseRequest: () => void; onCloseDashboard: () => void }) {
  const [view, setView] = useState<AcknowledgementView | null>(null);
  const [scrollElement, setScrollElement] = useState<HTMLElement | null>(null);
  async function load() {
    const data = await requestJson<AcknowledgementView>(`/api/v1/pages/${encodeURIComponent(pageId)}/acknowledgements`);
    if (data && (data.scope === "owner" || data.scope === "reader")) setView(data);
  }
  useEffect(() => { let alive = true; void requestJson<AcknowledgementView>(`/api/v1/pages/${encodeURIComponent(pageId)}/acknowledgements`).then(data => { if (alive && data && (data.scope === "owner" || data.scope === "reader")) setView(data); }).catch(() => { if (alive) setView(null); }); return () => { alive = false; }; }, [pageId]);
  useEffect(() => { setScrollElement(scrollTarget?.current ?? null); }, [scrollTarget, view]);
  const owner = view?.scope === "owner" ? view : null;
  const banner = view?.banner?.status === "pending" ? view.banner : null;
  async function submit(input: { dueOn: string; audience: AudienceTarget[] }) {
    await requestJson(`/api/v1/pages/${encodeURIComponent(pageId)}/acknowledgements`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "request", operationId: crypto.randomUUID(), ...input }) });
    await load();
    onCloseRequest();
  }
  async function acknowledge(input: { confirm: boolean; reachedEnd: boolean; waitedSeconds: number }) {
    if (!banner) return;
    await requestJson(`/api/v1/pages/${encodeURIComponent(pageId)}/acknowledgements`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "acknowledge", operationId: crypto.randomUUID(), versionId: banner.versionId, ...input }) });
    await load();
  }
  function download(kind: "csv" | "evidence", status: string) {
    const address = `/api/v1/pages/${encodeURIComponent(pageId)}/acknowledgements?export=${kind}${kind === "csv" && status !== "all" ? `&status=${encodeURIComponent(status)}` : ""}`;
    const link = document.createElement("a");
    link.href = address;
    link.download = kind === "csv" ? "acknowledgements.csv" : "acknowledgement-evidence.json";
    link.click();
  }
  return <>
    {banner && <AcknowledgementBanner copy={banner.copy || acknowledgementBannerCopy(banner.versionLabel)} shortDocument={banner.shortDocument} scrollTarget={scrollElement} onAcknowledge={acknowledge} />}
    {requestOpen && owner && <AcknowledgementRequestDialog versionLabel={owner.publication?.versionLabel ?? owner.campaign?.versionLabel ?? "the published version"} choices={owner.audienceChoices} onClose={onCloseRequest} onSubmit={submit} />}
    {dashboardOpen && owner && <AcknowledgementDashboard view={owner} onClose={onCloseDashboard} onExport={download} onReacknowledge={async () => { await requestJson(`/api/v1/pages/${encodeURIComponent(pageId)}/acknowledgements`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "require-reacknowledgement", operationId: crypto.randomUUID() }) }); await load(); }} />}
  </>;
}
