"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ApiError, requestJson } from "./editor/use-document-session";
import UiIcon from "./ui-icon";
import {
  dropPin,
  movePin,
  SPACE_HOME_LOAD_FAILED,
  SPACE_HOME_REFRESH_MS,
  SPACE_HOME_UNAVAILABLE,
  type SpaceHomePinView,
  type SpaceHomeView,
} from "../lib/space-home-shared";
import { SPACE_ARCHIVED_BANNER } from "../lib/space-directory-shared";

type PinsProps = {
  pins: SpaceHomePinView[];
  canManage: boolean;
  busy: boolean;
  onReorder: (pageIds: string[]) => void;
  onUnpin: (pageId: string) => void;
  onSetHome: (pageId: string) => void;
};

export function SpaceHomePins({ pins, canManage, busy, onReorder, onUnpin, onSetHome }: PinsProps) {
  const helpId = useId();
  const dragging = useRef("");
  const ids = pins.map(pin => pin.pageId);
  function reorder(next: string[]) {
    if (next.join("\0") !== ids.join("\0")) onReorder(next);
  }
  return <div>
    {canManage && <p id={helpId}>Use the up and down arrow keys, or drag a card, to reorder pinned pages.</p>}
    {!pins.length && <p>Nothing pinned yet.</p>}
    {!!pins.length && <ul className="space-home-pins" aria-label="Pinned pages" aria-describedby={canManage ? helpId : undefined}>
      {pins.map((pin, index) => <li
        key={pin.pageId}
        className="space-home-pin"
        data-page-id={pin.pageId}
        tabIndex={0}
        draggable={canManage && !busy}
        aria-keyshortcuts={canManage ? "ArrowUp ArrowDown" : undefined}
        onDragStart={() => { dragging.current = pin.pageId; }}
        onDragOver={event => { if (canManage) event.preventDefault(); }}
        onDrop={event => { event.preventDefault(); if (canManage && dragging.current) reorder(dropPin(ids, dragging.current, pin.pageId)); dragging.current = ""; }}
        onKeyDown={event => {
          if (!canManage || busy) return;
          if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
          event.preventDefault();
          reorder(movePin(ids, pin.pageId, event.key === "ArrowUp" ? -1 : 1));
        }}
      >
        <span className="space-home-pin-icon" aria-hidden="true"><UiIcon name="document" /></span>
        <div>
          <a href={`/pages/${encodeURIComponent(pin.pageId)}`}>{pin.title}</a>
          {pin.summary && <p>{pin.summary}</p>}
        </div>
        {canManage && <div className="space-home-pin-actions">
          <button type="button" disabled={busy || index === 0} aria-label={`Move ${pin.title} up`} onClick={() => reorder(movePin(ids, pin.pageId, -1))}>Up</button>
          <button type="button" disabled={busy || index === pins.length - 1} aria-label={`Move ${pin.title} down`} onClick={() => reorder(movePin(ids, pin.pageId, 1))}>Down</button>
          <button type="button" disabled={busy} aria-label={`Set ${pin.title} as space home`} onClick={() => onSetHome(pin.pageId)}>Set as home</button>
          <button type="button" disabled={busy} aria-label={`Remove ${pin.title}`} onClick={() => onUnpin(pin.pageId)}>Remove</button>
        </div>}
      </li>)}
    </ul>}
  </div>;
}

export default function SpaceHome({ workspaceId, spaceId }: { workspaceId: string; spaceId: string }) {
  const [home, setHome] = useState<SpaceHomeView | null>(null);
  const [reload, setReload] = useState(0);
  const [unavailable, setUnavailable] = useState<{ endpoint: string; message: string } | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [candidate, setCandidate] = useState("");
  const endpoint = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/spaces/${encodeURIComponent(spaceId)}/home`;
  useEffect(() => {
    let alive = true;
    const load = () => {
      void requestJson<SpaceHomeView>(endpoint).then(data => {
        if (!alive) return;
        setHome(data);
        setUnavailable(null);
        setError("");
        setCandidate(current => data.pinCandidates.some(item => item.pageId === current) ? current : data.pinCandidates[0]?.pageId ?? "");
      }).catch(reason => {
        if (!alive) return;
        setHome(null);
        setUnavailable({ endpoint, message: reason instanceof ApiError && (reason.status === 403 || reason.status === 404) ? reason.message : SPACE_HOME_LOAD_FAILED });
      });
    };
    load();
    const timer = window.setInterval(load, SPACE_HOME_REFRESH_MS);
    const refresh = () => { if (document.visibilityState === "visible") load(); };
    const logout = () => { setHome(null); setUnavailable({ endpoint, message: SPACE_HOME_UNAVAILABLE }); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    window.addEventListener("holy-sheet:logout", logout);
    return () => {
      alive = false;
      window.clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
      window.removeEventListener("holy-sheet:logout", logout);
    };
  }, [endpoint, reload]);
  async function send(body: Record<string, unknown>) {
    setBusy(true);
    setError("");
    try {
      const data = await requestJson<SpaceHomeView>(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, operationId: crypto.randomUUID() }) });
      setHome(data);
      setUnavailable(null);
      setCandidate(data.pinCandidates[0]?.pageId ?? "");
    } catch (reason) {
      if (reason instanceof ApiError && reason.status === 404) {
        setHome(null);
        setUnavailable({ endpoint, message: reason.message });
        setError("");
      } else setError(reason instanceof ApiError ? reason.message : "Space home could not be saved.");
    } finally {
      setBusy(false);
    }
  }
  const shownHome = home?.workspaceId === workspaceId && home.spaceId === spaceId ? home : null;
  const shownUnavailable = unavailable?.endpoint === endpoint ? unavailable.message : "";
  return <main className="space-home-page">
    <a className="skip-link" href="#space-home">Skip to space home</a>
    <p><a href="/">Holy Sheet</a> / <a href={`/workspaces/${encodeURIComponent(workspaceId)}/spaces`}>Spaces</a> / <span>Space</span></p>
    {shownUnavailable && <p role="alert">{shownUnavailable}</p>}
    {!shownHome && !shownUnavailable && <p role="status">Opening space home…</p>}
    {shownHome && <div id="space-home">
      <h1>{shownHome.spaceName}</h1>
      <p className="space-home-purpose">Shared knowledge, working notes, and decisions for everyone in this space.</p>
      {shownHome.archived && <p className="space-archive-banner" role="status">{SPACE_ARCHIVED_BANNER}{shownHome.archivedAtIst ? ` Archived ${shownHome.archivedAtIst}.` : ""} {shownHome.canUnarchive && <button type="button" disabled={busy} onClick={() => void requestJson(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/spaces/directory`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "unarchive", spaceId, operationId: crypto.randomUUID() }) }).then(() => setReload(value => value + 1)).catch(reason => setError(reason instanceof ApiError ? reason.message : "This space is archived and read-only"))}>Unarchive</button>}</p>}
      {error && <p role="alert">{error}</p>}
      <section className="space-home-overview" aria-labelledby="space-home-overview-heading">
        <h2 id="space-home-overview-heading">Overview</h2>
        {shownHome.home ? <>
          <p className="space-home-kicker">{shownHome.home.templateName ?? "Space page"}</p>
          <h3>{shownHome.home.title}</h3>
          {shownHome.home.summary && <p>{shownHome.home.summary}</p>}
          {shownHome.home.headings.map(heading => <p key={heading}>{heading}</p>)}
          <p className="space-home-meta">Updated {shownHome.home.updatedAtIst}</p>
          <a href={`/pages/${encodeURIComponent(shownHome.home.pageId)}`}>Open {shownHome.home.title}</a>
        </> : <div className="space-home-overview-empty">
          <p>No overview page has been set for this space.</p>
          {shownHome.canManage ? <>
            {!!shownHome.pinCandidates.length && <form className="space-home-select-form" onSubmit={event => { event.preventDefault(); if (candidate) void send({ action: "set-home", pageId: candidate }); }}>
              <label>Choose an existing page <select aria-label="Choose an existing overview page" value={candidate} disabled={busy} onChange={event => setCandidate(event.target.value)}>{shownHome.pinCandidates.map(item => <option key={item.pageId} value={item.pageId}>{item.title}</option>)}</select></label>
              <button type="submit" disabled={busy || !candidate}>Set as overview</button>
            </form>}
            <p><a href="/workspaces">Create a page</a>, then return here to set it as the overview.</p>
          </> : <p>Ask a space leader to create or choose an overview page.</p>}
        </div>}
      </section>
      <div className="space-home-widgets">
        <section aria-labelledby="space-home-pinned-heading">
          <h2 id="space-home-pinned-heading">Pinned</h2>
          {shownHome.canManage && !!shownHome.pinCandidates.length && <form className="space-home-pin-form space-home-select-form" onSubmit={event => { event.preventDefault(); if (candidate) void send({ action: "pin", pageId: candidate }); }}>
            <label>Pin a page <select aria-label="Pin a page" value={candidate} disabled={busy} onChange={event => setCandidate(event.target.value)}>{shownHome.pinCandidates.map(item => <option key={item.pageId} value={item.pageId}>{item.title}</option>)}</select></label>
            <button type="submit" disabled={busy || !candidate}>Pin page</button>
          </form>}
          <SpaceHomePins
            pins={shownHome.widgets.pinned}
            canManage={shownHome.canManage}
            busy={busy}
            onReorder={pageIds => void send({ action: "reorder", pageIds })}
            onUnpin={pageId => void send({ action: "unpin", pageId })}
            onSetHome={pageId => void send({ action: "set-home", pageId })}
          />
        </section>
        <section aria-labelledby="space-home-recent-heading">
          <h2 id="space-home-recent-heading">Recently updated</h2>
          {!shownHome.widgets.recent.length && <p>No recent updates.</p>}
          {!!shownHome.widgets.recent.length && <ul className="space-home-list">{shownHome.widgets.recent.map(item => <li key={item.pageId}>
            <a href={`/pages/${encodeURIComponent(item.pageId)}`}>{item.title}</a>
            <span>{item.editorName ? `${item.editorName} · ` : ""}{item.updatedAtIst}</span>
          </li>)}</ul>}
        </section>
        <section aria-labelledby="space-home-views-heading">
          <h2 id="space-home-views-heading">Key record views</h2>
          {!shownHome.widgets.recordViews.length && <p>No record views.</p>}
          {!!shownHome.widgets.recordViews.length && <ul className="space-home-list">{shownHome.widgets.recordViews.map(item => <li key={`${item.pageId}:${item.viewId}`}>
            <span className="space-home-pin-icon" aria-hidden="true"><UiIcon name="grid" /></span>
            <a href={`/pages/${encodeURIComponent(item.pageId)}`}>{item.pageTitle}</a>
            <span>{item.collectionId} · {item.layout}</span>
          </li>)}</ul>}
        </section>
        <section aria-labelledby="space-home-owners-heading">
          <h2 id="space-home-owners-heading">Owners</h2>
          {!shownHome.widgets.owners.length && <p>No owners to show.</p>}
          {!!shownHome.widgets.owners.length && <ul className="space-home-list">{shownHome.widgets.owners.map(owner => <li key={owner.userId}>
            <span className="space-home-pin-icon" aria-hidden="true"><UiIcon name="user" /></span>
            <span>{owner.name}</span>
            <span>{owner.role === "leader" ? "Leader" : "Page owner"}</span>
          </li>)}</ul>}
        </section>
      </div>
    </div>}
  </main>;
}
