"use client";
import { WorkspaceSection } from "./workspace-section";

import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError, requestJson } from "./editor/use-document-session";
import { SPACE_UNAVAILABLE, type DirectoryView, type MigrationJob, type MigrationPreview } from "../lib/space-directory-shared";

const labels = { open: "Open to the workspace", discoverable: "Restricted", private: "Private" };

export default function SpaceDirectory({ workspaceId, includeArchivedInitially = false }: { workspaceId: string; includeArchivedInitially?: boolean }) {
  const [view, setView] = useState<DirectoryView | null>(null);
  const [includeArchived, setIncludeArchived] = useState(includeArchivedInitially);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [rootPageId, setRootPageId] = useState("");
  const [targetSpaceId, setTargetSpaceId] = useState("");
  const [parentId, setParentId] = useState("");
  const [preview, setPreview] = useState<MigrationPreview | null>(null);
  const moveHeading = useRef<HTMLHeadingElement>(null);
  const [moveOpen, setMoveOpen] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [job, setJob] = useState<MigrationJob | null>(null);
  const endpoint = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/spaces/directory`;

  const load = useCallback(() => {
    const query = includeArchived ? "?archived=1" : "";
    return requestJson<DirectoryView>(`${endpoint}${query}`).then(data => {
      setView(data);
      setError("");
      setTargetSpaceId(current => current || data.spaces.find(space => !space.archived)?.id || "");
    }).catch(reason => {
      setView(null);
      setError(reason instanceof ApiError ? reason.message : SPACE_UNAVAILABLE);
    });
  }, [endpoint, includeArchived]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => { if (moveOpen) moveHeading.current?.focus(); }, [moveOpen]);

  async function send(body: Record<string, unknown>) {
    setBusy(true);
    setNotice("");
    setError("");
    try {
      await requestJson(endpoint, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, operationId: crypto.randomUUID() }) });
      setNotice("Saved.");
      await load();
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : SPACE_UNAVAILABLE);
    } finally {
      setBusy(false);
    }
  }

  async function reviewMove(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setJob(null);
    try {
      const data = await requestJson<MigrationPreview>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/spaces/migrations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "preview", rootPageId: rootPageId.trim(), targetSpaceId, parentId: parentId.trim() || null }),
      });
      setPreview(data);
      setConfirm(false);
    } catch (reason) {
      setPreview(null);
      setError(reason instanceof ApiError ? reason.message : SPACE_UNAVAILABLE);
    } finally {
      setBusy(false);
    }
  }

  async function runMove() {
    if (!preview) return;
    setBusy(true);
    setError("");
    try {
      let current = await requestJson<MigrationJob>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/spaces/migrations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "start", rootPageId: preview.rootPageId, targetSpaceId: preview.targetSpaceId, parentId: preview.parentId, operationId: crypto.randomUUID(), previewDigest: preview.digest, confirmAccess: confirm || preview.gains.length === 0 }),
      });
      setJob(current);
      let guard = 0;
      while (current.status === "running" && guard < 1000) {
        guard += 1;
        current = await requestJson<MigrationJob>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/spaces/migrations`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "step", jobId: current.jobId, operationId: crypto.randomUUID() }),
        });
        setJob(current);
      }
      setNotice(current.status === "completed" ? "Page tree moved. Old addresses redirect." : "Migration paused.");
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : SPACE_UNAVAILABLE);
    } finally {
      setBusy(false);
    }
  }

  async function resumeMove() {
    if (!job || job.status !== "halted") return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      let current = await requestJson<MigrationJob>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/spaces/migrations`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "resume", jobId: job.jobId, operationId: crypto.randomUUID() }),
      });
      setJob(current);
      let guard = 0;
      while (current.status === "running" && guard < 1000) {
        guard += 1;
        current = await requestJson<MigrationJob>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/spaces/migrations`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "step", jobId: current.jobId, operationId: crypto.randomUUID() }),
        });
        setJob(current);
      }
      setNotice(current.status === "completed" ? "Page tree moved. Old addresses redirect." : "Migration paused again.");
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : SPACE_UNAVAILABLE);
    } finally {
      setBusy(false);
    }
  }

  return <WorkspaceSection workspaceId={workspaceId} section="Spaces" spaces={view?.spaces.filter(space => space.action === "open" && !space.archived)}><main className="space-directory">
    <a className="skip-link" href="#space-directory">Skip to spaces</a>
    <p><a href="/">Aplyd Pages</a> / <span>Spaces</span></p>
    <h1 id="space-directory">Spaces</h1>

    <label><input type="checkbox" checked={includeArchived} onChange={event => setIncludeArchived(event.target.checked)} /> Include archived</label>
    {error && <p role="alert">{error}</p>}
    {notice && <p role="status">{notice}</p>}
    {!view && !error && <p role="status">Opening spaces…</p>}
    {view && <ul className="space-directory-list">
      {view.spaces.map(space => <li key={space.id}>
        <div>
          <a href={`/workspaces/${encodeURIComponent(workspaceId)}/spaces/${encodeURIComponent(space.id)}`}>{space.name}</a>
          <span>{labels[space.visibility]}{space.archived ? " · Archived" : ""}{space.archivedAtIst ? ` · ${space.archivedAtIst}` : ""}</span>
        </div>
        <div className="space-directory-actions">
          {space.action === "join" && <button type="button" disabled={busy} onClick={() => void send({ action: "join", spaceId: space.id })}>Join</button>}
          {space.action === "request" && <button type="button" disabled={busy || space.requestPending} onClick={() => void send({ action: "request-access", spaceId: space.id })}>{space.requestPending ? "Access requested" : "Request access"}</button>}
          {view.canAdminister && <details><summary aria-label={`Actions for ${space.name}`}>···</summary>
          {!space.archived && <button type="button" onClick={() => { setTargetSpaceId(space.id); setPreview(null); setMoveOpen(true); }}>Move a page tree here</button>}
          {view.canAdminister && !space.archived && <button type="button" disabled={busy} onClick={() => void send({ action: "archive", spaceId: space.id })}>Archive</button>}
          {view.canAdminister && space.archived && <button type="button" disabled={busy} onClick={() => void send({ action: "unarchive", spaceId: space.id })}>Unarchive</button>}
          </details>}
        </div>
      </li>)}
      {!view.spaces.length && <li>No spaces to show.</li>}
    </ul>}
    {view?.canAdminister && moveOpen && <section aria-labelledby="move-tree-heading" className="space-migration">
      <h2 id="move-tree-heading" tabIndex={-1} ref={moveHeading}>Move a page tree</h2>
      <button type="button" disabled={busy} onClick={() => setMoveOpen(false)}>Close move form</button>
      <form onSubmit={event => void reviewMove(event)}>
        <label>Page <input aria-label="Page to move" value={rootPageId} onChange={event => setRootPageId(event.target.value)} required /></label>
        <label>Destination space <select aria-label="Destination space" value={targetSpaceId} onChange={event => setTargetSpaceId(event.target.value)} required>
          {view.spaces.filter(space => !space.archived).map(space => <option key={space.id} value={space.id}>{space.name}</option>)}
        </select></label>
        <label>Destination parent <input aria-label="Destination parent page" value={parentId} onChange={event => setParentId(event.target.value)} placeholder="Leave empty for the top of the space" /></label>
        <button type="submit" disabled={busy}>Preview move</button>
      </form>
      {preview && <div>
        <p>{preview.pageCount} pages{preview.trashedCount ? `, ${preview.trashedCount} still in trash` : ""}. {preview.brokenReferences} broken references. {preview.redirectCount} old addresses will redirect.</p>
        <p>Gains access: {preview.gains.length ? preview.gains.map(person => person.name).join(", ") : "nobody"}.</p>
        <p>Loses access: {preview.loses.length ? preview.loses.map(person => person.name).join(", ") : "nobody"}.</p>
        {!!preview.gains.length && <label><input type="checkbox" checked={confirm} onChange={event => setConfirm(event.target.checked)} /> I reviewed who gains access</label>}
        <button type="button" disabled={busy || (preview.gains.length > 0 && !confirm)} onClick={() => void runMove()}>Move pages</button>
      </div>}
      {job && <div>
        <p role="status">{job.status === "completed" ? `Moved ${job.movedPageIds.length} pages.` : job.status === "halted" ? `Stopped after ${job.movedPageIds.length} of ${job.pageCount} pages. ${job.remainingPageIds.length} pages were not moved.` : `Moving pages. ${job.movedPageIds.length} of ${job.pageCount} moved.`} {job.atIst}</p>
        {job.status === "halted" && <button type="button" disabled={busy} onClick={() => void resumeMove()}>Resume migration</button>}
      </div>}
    </section>}
  </main></WorkspaceSection>;
}
