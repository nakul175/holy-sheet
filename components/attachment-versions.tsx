"use client";

import { FormEvent, useCallback, useEffect, useState } from "react";
import { ApiError, requestJson } from "./editor/use-document-session";

type Version = {
  id: string;
  versionNo: number;
  uploaderId: string;
  atLabel: string;
  size: number;
  checksum: string;
  note: string | null;
  scanStatus: string;
  current: boolean;
  deleted: boolean;
  purgeAfterLabel: string | null;
  deleteReason: string | null;
};

type VersionList = { fileId: string; name: string; currentVersionNo: number | null; canUpload: boolean; versions: Version[] };
type Opened = { versionNo: number; currentVersionNo: number; label: "Not latest" | null; pinLabel: string | null; atLabel: string; scanStatus: string; name: string };

function isList(value: unknown): value is VersionList {
  if (!value || typeof value !== "object") return false;
  const body = value as VersionList;
  return Array.isArray(body.versions) && typeof body.canUpload === "boolean";
}

export function VersionDrawer(props: { workspaceId: string; tenantId: string; recordId: string; fileId: string; fileName: string | null }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" aria-expanded={open} onClick={() => setOpen(current => !current)}>Versions</button>
      {open && <AttachmentVersions {...props} />}
    </>
  );
}

export function AttachmentVersions({ workspaceId, tenantId, recordId, fileId, fileName }: { workspaceId: string; tenantId: string; recordId: string; fileId: string; fileName: string | null }) {
  const root = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/attachment-versions`;
  const [list, setList] = useState<VersionList | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState("");
  const [opened, setOpened] = useState<Opened | null>(null);
  const [notice, setNotice] = useState("");
  const load = useCallback(async () => {
    const params = new URLSearchParams({ recordId, fileId, tenantId });
    const body = await requestJson<unknown>(`${root}?${params}`);
    if (!isList(body)) throw new ApiError("This item is restricted or unavailable.", 404, "not_found");
    setList(body);
  }, [fileId, recordId, root, tenantId]);
  useEffect(() => {
    let alive = true;
    void load().catch(reason => { if (alive) setError(reason instanceof Error ? reason.message : "This item is restricted or unavailable."); });
    return () => { alive = false; };
  }, [load]);
  async function mutate(body: Record<string, unknown>) {
    setBusy(true);
    setError("");
    try {
      return await requestJson<Record<string, unknown>>(root, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, tenantId, recordId, fileId, operationId: crypto.randomUUID() }) });
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "This item is restricted or unavailable.");
      return null;
    } finally { setBusy(false); }
  }
  async function upload(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const file = form.get("file");
    if (!(file instanceof File) || file.size < 1) return;
    const note = String(form.get("note") ?? "").trim();
    setBusy(true);
    setError("");
    setPhase("Scanning");
    try {
      const reserved = await requestJson<{ reservationId?: string }>(root, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "reserve", operationId: crypto.randomUUID(), tenantId, recordId, fileId, name: file.name, size: file.size, ...(note ? { note } : {}) }) });
      if (!reserved.reservationId) throw new ApiError("This item is restricted or unavailable.", 404, "not_found");
      const params = new URLSearchParams({ reservationId: reserved.reservationId, recordId, tenantId });
      await requestJson(`${root}?${params}`, { method: "POST", headers: { "content-type": "application/octet-stream", "x-hs-operation-id": crypto.randomUUID() }, body: file });
      event.currentTarget.reset();
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "This item is restricted or unavailable.");
    } finally { setBusy(false); setPhase(""); }
  }
  async function restore(versionNo: number) {
    const result = await mutate({ action: "restore", versionNo });
    if (result) await load();
  }
  async function remove(event: FormEvent<HTMLFormElement>, version: Version) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const reason = String(form.get("reason") ?? "");
    const successor = String(form.get("successor") ?? "");
    const result = await mutate({ action: "delete", versionNo: version.versionNo, reason, ...(version.current && successor ? { successorVersionNo: Number(successor) } : {}) });
    if (result) await load();
  }
  async function openPinned(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const versionNo = Number(new FormData(event.currentTarget).get("versionNo"));
    if (!Number.isSafeInteger(versionNo) || versionNo < 1) return;
    setError("");
    try {
      const params = new URLSearchParams({ recordId, fileId, tenantId, versionNo: String(versionNo) });
      const body = await requestJson<Opened>(`${root}?${params}`);
      setOpened(body);
    } catch (reason) {
      setOpened(null);
      setError(reason instanceof Error ? reason.message : "This item is restricted or unavailable.");
    }
  }
  async function copyPin(versionNo: number) {
    const label = `@v${versionNo}`;
    setNotice(`Pinned link ${label}`);
    if (navigator.clipboard) await navigator.clipboard.writeText(label).catch(() => undefined);
  }
  async function download(versionNo: number) {
    const issued = await mutate({ action: "download", versionNo });
    const url = issued && typeof issued.url === "string" ? issued.url : "";
    if (url) window.location.assign(url);
  }
  const alternatives = (list?.versions ?? []).filter(version => !version.deleted && !version.current);
  return (
    <section aria-label={`Versions of ${fileName ?? "file"}`}>
      <p>{list?.currentVersionNo ? `Current v${list.currentVersionNo}` : "No version yet"}</p>
      {phase && <p role="status">{phase}</p>}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <ul>
        {(list?.versions ?? []).map(version => (
          <li key={version.id}>
            <strong>v{version.versionNo}</strong>
            {version.current && <small>Current</small>}
            {version.deleted && <small>Retained until {version.purgeAfterLabel}</small>}
            <span>{version.uploaderId}</span>
            <time>{version.atLabel}</time>
            <span>{version.size} bytes</span>
            <span>{version.scanStatus}</span>
            {version.note && <span>{version.note}</span>}
            {version.deleteReason && <span>{version.deleteReason}</span>}
            <button type="button" disabled={busy} onClick={() => void download(version.versionNo)}>Download v{version.versionNo}</button>
            {list?.canUpload && !version.deleted && !version.current && <button type="button" disabled={busy} onClick={() => void restore(version.versionNo)}>Restore v{version.versionNo}</button>}
            {list?.canUpload && !version.deleted && (
              <form aria-label={`Delete version ${version.versionNo}`} onSubmit={event => void remove(event, version)}>
                <label>Reason <input name="reason" aria-label="Delete reason" required maxLength={500} /></label>
                {version.current && (
                  <label>New current <select name="successor" aria-label="Replacement current version" required>
                    <option value="">Choose another current version</option>
                    {alternatives.map(item => <option key={item.id} value={item.versionNo}>v{item.versionNo}</option>)}
                  </select></label>
                )}
                <button type="submit" disabled={busy}>Delete version</button>
              </form>
            )}
            <button type="button" disabled={busy} onClick={() => void copyPin(version.versionNo)}>Copy pinned link</button>
          </li>
        ))}
      </ul>
      {list?.canUpload && (
        <form aria-label="Upload new version" onSubmit={event => void upload(event)}>
          <p>Files must match the allowed types and stay within 50 MB. A file is scanned before it becomes a version.</p>
          <label>File <input name="file" aria-label="Version file" type="file" required /></label>
          <label>Note <input name="note" aria-label="Version note" maxLength={500} /></label>
          <button type="submit" disabled={busy}>Upload new version</button>
        </form>
      )}
      <form aria-label="Open pinned version" onSubmit={event => void openPinned(event)}>
        <label>Pinned version <input name="versionNo" aria-label="Pinned version number" inputMode="numeric" required /></label>
        <button type="submit" disabled={busy}>Open pinned</button>
      </form>
      {opened && (
        <p>
          Opens v{opened.versionNo}
          {opened.pinLabel ? ` ${opened.pinLabel}` : ""}
          {opened.label ? ` ${opened.label}` : ""}
          {opened.versionNo === opened.currentVersionNo ? " Latest" : ""}
        </p>
      )}
    </section>
  );
}
