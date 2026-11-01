"use client";

import { FormEvent, useCallback, useEffect, useRef, useState } from "react";
import { VersionDrawer } from "./attachment-versions";
import { ApiError, requestJson } from "./editor/use-document-session";

type Item = {
  linkId: string;
  docType: "page" | "file";
  docId: string;
  recordId: string;
  title: string | null;
  availability: "visible" | "in-trash";
  label: "In trash" | null;
  linkedAtLabel: string;
  href: string | null;
  canUnlink: boolean;
  currentVersionNo?: number | null;
};

type ListReply = { items: Item[]; nextCursor: string | null; countLabel: string; canLink: boolean };
type BinItem = { fileId: string; name: string; unlinkedAtLabel: string; purgeAfterLabel: string };
type BinReply = { items: BinItem[]; nextCursor: string | null; countLabel: string };
type Filters = { type: string; owner: string; updatedFrom: string; updatedTo: string };

const emptyFilters: Filters = { type: "", owner: "", updatedFrom: "", updatedTo: "" };

function isList(value: unknown): value is ListReply {
  if (!value || typeof value !== "object") return false;
  const body = value as ListReply;
  return Array.isArray(body.items) && typeof body.countLabel === "string";
}

function isBin(value: unknown): value is BinReply {
  if (!value || typeof value !== "object") return false;
  const body = value as BinReply;
  return Array.isArray(body.items) && typeof body.countLabel === "string";
}

async function readList(url: string) {
  const body = await requestJson<unknown>(url);
  if (!isList(body)) throw new ApiError("This item is restricted or unavailable.", 404, "not_found");
  return body;
}

export function RecordDocuments({ workspaceId, tenantId, recordId }: { workspaceId: string; tenantId: string; recordId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <section className="document-associations" aria-label="Documents">
      <button type="button" aria-expanded={open} onClick={() => setOpen(current => !current)}>Documents</button>
      {open && <RecordDocumentsPanel workspaceId={workspaceId} tenantId={tenantId} recordId={recordId} />}
    </section>
  );
}

function RecordDocumentsPanel({ workspaceId, tenantId, recordId }: { workspaceId: string; tenantId: string; recordId: string }) {
  const [tab, setTab] = useState<"documents" | "unlinked">("documents");
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [applied, setApplied] = useState<Filters>(emptyFilters);
  const cursor = useRef<string | undefined>(undefined);
  const request = useRef(0);
  const [list, setList] = useState<ListReply | null>(null);
  const [bin, setBin] = useState<BinReply | null>(null);
  const [error, setError] = useState("");
  const [choice, setChoice] = useState<{ docId: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(async (nextCursor?: string, nextFilters = applied) => {
    const token = ++request.current;
    const params = new URLSearchParams({ scope: "record", recordId, tenantId });
    if (nextFilters.type) params.set("type", nextFilters.type);
    if (nextFilters.owner) params.set("owner", nextFilters.owner);
    if (nextFilters.updatedFrom) params.set("updatedFrom", nextFilters.updatedFrom);
    if (nextFilters.updatedTo) params.set("updatedTo", nextFilters.updatedTo);
    if (nextCursor) params.set("cursor", nextCursor);
    try {
      const body = await readList(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/document-record-links?${params}`);
      if (token !== request.current) return;
      cursor.current = nextCursor;
      setList(body);
      setError("");
    } catch (reason) {
      if (token !== request.current) return;
      setError(reason instanceof Error ? reason.message : "This item is restricted or unavailable.");
    }
  }, [applied, recordId, tenantId, workspaceId]);
  useEffect(() => {
    void load();
    const refresh = () => { if (document.visibilityState === "visible") void load(cursor.current).catch(() => undefined); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { request.current += 1; window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [load]);
  async function mutate(body: Record<string, unknown>) {
    setBusy(true);
    setError("");
    try {
      await requestJson(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/document-record-links`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, tenantId, operationId: crypto.randomUUID() }) });
      setChoice(null);
      await load();
    } catch (reason) {
      if (reason instanceof ApiError && reason.code === "unlink_choice_required" && typeof body.docId === "string") setChoice({ docId: body.docId });
      setError(reason instanceof Error ? reason.message : "This action is not permitted.");
    } finally { setBusy(false); }
  }
  async function openBin() {
    setTab("unlinked");
    setError("");
    try {
      const body = await requestJson<unknown>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/document-record-links?scope=unlinked&tenantId=${encodeURIComponent(tenantId)}`);
      if (!isBin(body)) throw new ApiError("This item is restricted or unavailable.", 404, "not_found");
      setBin(body);
    } catch (reason) {
      setBin(null);
      setError(reason instanceof Error ? reason.message : "This item is restricted or unavailable.");
    }
  }
  function applyFilters(event: FormEvent) {
    event.preventDefault();
    setApplied(filters);
  }
  return (
    <>
      <div role="tablist" aria-label="Document views">
        <button type="button" role="tab" aria-selected={tab === "documents"} onClick={() => setTab("documents")}>Documents</button>
        <button type="button" role="tab" aria-selected={tab === "unlinked"} onClick={() => void openBin()}>Unlinked files</button>
      </div>
      {error && <p role="alert">{error}</p>}
      {tab === "documents" && (
        <>
          <p>{list?.countLabel ?? "Documents you can see"}</p>
          <form aria-label="Filter documents" onSubmit={applyFilters}>
            <label>Type <select aria-label="Document type" value={filters.type} onChange={event => setFilters(current => ({ ...current, type: event.target.value }))}><option value="">Page or file</option><option value="page">Page</option><option value="file">File</option></select></label>
            <label>Owner <input aria-label="Owner" value={filters.owner} onChange={event => setFilters(current => ({ ...current, owner: event.target.value }))} /></label>
            <label>Updated from <input aria-label="Updated from" type="date" value={filters.updatedFrom} onChange={event => setFilters(current => ({ ...current, updatedFrom: event.target.value }))} /></label>
            <label>Updated to <input aria-label="Updated to" type="date" value={filters.updatedTo} onChange={event => setFilters(current => ({ ...current, updatedTo: event.target.value }))} /></label>
            <button type="submit">Apply filters</button>
          </form>
          <ul>
            {(list?.items ?? []).map(item => (
              <li key={item.linkId}>
                {item.href ? <a href={item.href}>{item.title}</a> : <span>{item.title ?? item.label}</span>}
                {item.label && <small>{item.label}</small>}
                <small>{item.docType} · {item.linkedAtLabel}</small>
                {item.docType === "file" && typeof item.currentVersionNo === "number" && <small>Current v{item.currentVersionNo}</small>}
                {item.docType === "file" && item.availability === "visible" && <VersionDrawer workspaceId={workspaceId} tenantId={tenantId} recordId={recordId} fileId={item.docId} fileName={item.title} />}
                {item.canUnlink && <button type="button" disabled={busy} onClick={() => void mutate({ action: "unlink", docType: item.docType, docId: item.docId, recordId })}>Unlink</button>}
                {item.docType === "file" && item.canUnlink && item.availability === "visible" && (
                  <form aria-label={`Also link ${item.title ?? "file"}`} onSubmit={event => { event.preventDefault(); const record = new FormData(event.currentTarget).get("recordId"); if (typeof record === "string" && record.trim()) void mutate({ action: "link", docType: "file", docId: item.docId, recordId: record.trim() }); }}>
                    <label>Also link to <input name="recordId" aria-label="Also link to record" required /></label>
                    <button type="submit" disabled={busy}>Also link to…</button>
                  </form>
                )}
                {choice?.docId === item.docId && (
                  <div role="group" aria-label="Last link">
                    <button type="button" disabled={busy} onClick={() => void mutate({ action: "unlink", docType: "file", docId: item.docId, recordId, disposition: "delete" })}>Delete</button>
                    <button type="button" disabled={busy} onClick={() => void mutate({ action: "unlink", docType: "file", docId: item.docId, recordId, disposition: "keep" })}>Keep in Unlinked files</button>
                  </div>
                )}
              </li>
            ))}
          </ul>
          {!list?.items.length && <p>No documents you can see.</p>}
          {list?.nextCursor && <button type="button" disabled={busy} onClick={() => void load(list.nextCursor ?? undefined).catch(reason => setError(reason instanceof Error ? reason.message : "This item is restricted or unavailable."))}>Next</button>}
          {list?.canLink && (
            <>
              <form aria-label="Link page" onSubmit={event => { event.preventDefault(); const pageId = new FormData(event.currentTarget).get("pageId"); if (typeof pageId === "string" && pageId.trim()) void mutate({ action: "link", docType: "page", docId: pageId.trim(), recordId }); }}>
                <label>Page <input name="pageId" aria-label="Page to link" required /></label>
                <button type="submit" disabled={busy}>Link page</button>
              </form>
              <form aria-label="Add file" onSubmit={event => { event.preventDefault(); const name = new FormData(event.currentTarget).get("name"); if (typeof name === "string" && name.trim()) void mutate({ action: "register-file", name: name.trim(), recordId }); }}>
                <label>File name <input name="name" aria-label="File name" required maxLength={240} /></label>
                <button type="submit" disabled={busy}>Add file</button>
              </form>
            </>
          )}
        </>
      )}
      {tab === "unlinked" && (
        <>
          <p>{bin?.countLabel ?? ""}</p>
          <ul>
            {(bin?.items ?? []).map(item => <li key={item.fileId}><strong>{item.name}</strong><small>Kept {item.unlinkedAtLabel}. Leaves the bin {item.purgeAfterLabel}.</small></li>)}
          </ul>
          {!bin?.items.length && <p>No unlinked files you can see.</p>}
        </>
      )}
    </>
  );
}

export function LinkedRecords({ pageId }: { pageId: string }) {
  const [list, setList] = useState<ListReply | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const request = useRef(0);
  const load = useCallback(async () => {
    const token = ++request.current;
    try {
      const body = await readList(`/api/v1/pages/${encodeURIComponent(pageId)}/linked-records`);
      if (token !== request.current) return;
      setList(body);
      setError("");
    } catch (reason) {
      if (token !== request.current) return;
      setError(reason instanceof Error ? reason.message : "This item is restricted or unavailable.");
    }
  }, [pageId]);
  useEffect(() => {
    void load();
    const refresh = () => { if (document.visibilityState === "visible") void load().catch(() => undefined); };
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { request.current += 1; window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [load]);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const recordId = new FormData(event.currentTarget).get("recordId");
    if (typeof recordId !== "string" || !recordId.trim()) return;
    setBusy(true);
    setError("");
    try {
      await requestJson(`/api/v1/pages/${encodeURIComponent(pageId)}/linked-records`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "link", operationId: crypto.randomUUID(), recordId: recordId.trim() }) });
      event.currentTarget.reset();
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "This action is not permitted.");
    } finally { setBusy(false); }
  }
  async function unlink(recordId: string) {
    setBusy(true);
    setError("");
    try {
      await requestJson(`/api/v1/pages/${encodeURIComponent(pageId)}/linked-records`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "unlink", operationId: crypto.randomUUID(), recordId }) });
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "This action is not permitted.");
    } finally { setBusy(false); }
  }
  return (
    <aside className="linked-records-sidebar" aria-label="Linked records">
      <h2>Linked records</h2>
      <p>Association is a link, not a copy. {list?.countLabel ?? ""}</p>
      {error && <p role="alert">{error}</p>}
      <ul>
        {(list?.items ?? []).map(item => (
          <li key={item.linkId}>
            {item.href ? <a href={item.href}>{item.title}</a> : <span>{item.label ?? "In trash"}</span>}
            {item.label && item.title && <small>{item.label}</small>}
            <small>{item.linkedAtLabel}</small>
            {item.canUnlink && <button type="button" disabled={busy} onClick={() => void unlink(item.recordId)}>Unlink</button>}
          </li>
        ))}
      </ul>
      {!list?.items.length && <p>No records you can see.</p>}
      {list?.canLink && (
        <form aria-label="Add linked record" onSubmit={event => void submit(event)}>
          <label>Record <input name="recordId" aria-label="Record to link" required /></label>
          <button type="submit" disabled={busy}>Add linked record</button>
        </form>
      )}
    </aside>
  );
}
