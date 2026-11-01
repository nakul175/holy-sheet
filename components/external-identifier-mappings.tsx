"use client";
import { FormEvent, useRef, useState } from "react";
import { parseExternalIdentifier } from "../lib/external-identifier-mapping";

type Mapping = {
  id: string;
  namespace: string;
  externalId: string;
  recordId: string;
  originalRecordId: string;
  state: "active" | "archived" | "deleted";
  version: number;
  provenanceLabel: string;
  atIst: string;
  canWrite: boolean;
  canExport: boolean;
  canHistory: boolean;
};
type Draft = { id: string; mappingId: string; namespace: string; externalId: string; provenanceLabel: string; version: number };
type Conflict = { reviewable: false } | { reviewable: true; mappingId: string; recordId: string; state: string; version: number };
type Preview = { previewId: string; reviewHash: string; impact: string; conflict: Conflict | null; namespace: string; externalId: string; provenanceLabel: string };
type HistoryVersion = { version: number; recordId: string; originalRecordId: string; state: string; actorId: string; source: string; atIst: string; redirectReason: string | null };

export default function ExternalIdentifierMappings({ workspaceId, tenantId, collection, recordId }: { workspaceId: string; tenantId: string; collection: string; recordId: string }) {
  const root = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/tenants/${encodeURIComponent(tenantId)}/external-identifiers`;
  const [open, setOpen] = useState(false);
  const [mappings, setMappings] = useState<Mapping[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [query, setQuery] = useState("");
  const [namespace, setNamespace] = useState("");
  const [externalId, setExternalId] = useState("");
  const [provenance, setProvenance] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [decision, setDecision] = useState<"keep" | "reassign">("keep");
  const [confirmed, setConfirmed] = useState(false);
  const [history, setHistory] = useState<HistoryVersion[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const draftKey = useRef(crypto.randomUUID());
  const saveIntent = useRef<{ key: string; operationId: string } | null>(null);

  async function load(search = query) {
    const response = await fetch(`${root}?collection=${encodeURIComponent(collection)}&recordId=${encodeURIComponent(recordId)}&q=${encodeURIComponent(search)}`, { credentials: "same-origin", cache: "no-store" });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(typeof body?.error === "string" ? body.error : "External identifiers could not be loaded.");
    setMappings(Array.isArray(body?.mappings) ? body.mappings.filter(acceptedMapping) : []);
    setDrafts(Array.isArray(body?.drafts) ? body.drafts.filter(acceptedDraft) : []);
  }
  async function toggle() {
    const next = !open;
    setOpen(next);
    if (!next) return;
    setBusy(true);
    setError("");
    try { await load(); } catch (reason) { setError(reason instanceof Error ? reason.message : "External identifiers could not be loaded."); } finally { setBusy(false); }
  }
  function edit(field: "namespace" | "externalId" | "provenance", value: string) {
    setPreview(null);
    setConfirmed(false);
    setNotice("");
    if (field === "namespace") setNamespace(value);
    if (field === "externalId") setExternalId(value);
    if (field === "provenance") setProvenance(value);
  }
  async function post(body: Record<string, unknown>) {
    const response = await fetch(root, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const conflict = acceptedConflict(payload?.conflict);
      if (conflict) setPreview((current) => current ? { ...current, conflict } : current);
      throw new Error(typeof payload?.error === "string" ? payload.error : "The external identifier could not be saved.");
    }
    return payload;
  }
  async function review(event: FormEvent) {
    event.preventDefault();
    const parsed = parseExternalIdentifier({ namespace, externalId, provenanceLabel: provenance });
    if (!parsed.ok) { setError(parsed.message); setPreview(null); return; }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const body = await post({ kind: "preview", recordId, namespace: parsed.namespace, externalId: parsed.externalId, provenanceLabel: parsed.provenanceLabel });
      const next = acceptedPreview(body);
      if (!next) throw new Error("Review the external identifier.");
      setPreview(next);
      setDecision(next.conflict?.reviewable ? "keep" : "keep");
      setConfirmed(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Review the external identifier.");
    } finally {
      setBusy(false);
    }
  }
  async function confirm(event: FormEvent) {
    event.preventDefault();
    if (!preview || busy) return;
    if (preview.conflict?.reviewable && decision === "reassign" && !confirmed) { setError("Confirm the reassignment before saving it."); return; }
    const reviewBody = preview.conflict?.reviewable ? { decision, mappingId: preview.conflict.mappingId, version: preview.conflict.version, confirm: decision === "reassign" ? "reassign-external-identifier" : "keep-external-identifier" } : undefined;
    const key = JSON.stringify({ previewId: preview.previewId, review: reviewBody });
    if (!saveIntent.current || saveIntent.current.key !== key) saveIntent.current = { key, operationId: crypto.randomUUID() };
    setBusy(true);
    setError("");
    try {
      const saved = await post({ kind: "register", operationId: saveIntent.current.operationId, previewId: preview.previewId, reviewHash: preview.reviewHash, ...(reviewBody ? { review: reviewBody } : {}) });
      setNotice(saved?.replayed ? "This confirmation was already saved." : "External identifier saved. It does not grant access.");
      setPreview(null);
      setConfirmed(false);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The external identifier could not be saved.");
    } finally {
      setBusy(false);
    }
  }
  async function saveDraft(event: FormEvent) {
    event.preventDefault();
    const parsed = parseExternalIdentifier({ namespace, externalId, provenanceLabel: provenance });
    if (!parsed.ok) { setError(parsed.message); return; }
    const existing = drafts[0];
    const body = { kind: "draft", draftId: existing?.id ?? crypto.randomUUID(), mappingId: existing?.mappingId ?? draftKey.current, recordId, expectedVersion: existing?.version ?? 0, namespace: parsed.namespace, externalId: parsed.externalId, provenanceLabel: parsed.provenanceLabel };
    const key = JSON.stringify(body);
    if (!saveIntent.current || saveIntent.current.key !== key) saveIntent.current = { key, operationId: crypto.randomUUID() };
    setBusy(true);
    setError("");
    try {
      await post({ ...body, operationId: saveIntent.current.operationId });
      setNotice("Draft saved. The identifier mapping was not changed.");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The draft could not be saved.");
    } finally {
      setBusy(false);
    }
  }
  async function cancel() {
    setBusy(true);
    setError("");
    try {
      const existing = drafts[0];
      if (existing) await post({ kind: "discard", mappingId: existing.mappingId, operationId: crypto.randomUUID(), expectedVersion: existing.version });
      setPreview(null);
      setConfirmed(false);
      setNotice("Cancelled. Saved identifiers were not changed.");
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The draft could not be discarded.");
    } finally {
      setBusy(false);
    }
  }
  async function setState(mapping: Mapping, state: Mapping["state"]) {
    setBusy(true);
    setError("");
    try {
      await post({ kind: "state", mappingId: mapping.id, operationId: crypto.randomUUID(), expectedVersion: mapping.version, state, confirm: "set-external-identifier-state" });
      setNotice(`Mapping marked ${state}.`);
      await load();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "The mapping state could not be saved.");
    } finally {
      setBusy(false);
    }
  }
  async function showHistory(mappingId: string) {
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`${root}/${encodeURIComponent(mappingId)}/history`, { credentials: "same-origin", cache: "no-store" });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(typeof body?.error === "string" ? body.error : "History is unavailable.");
      setHistory(Array.isArray(body?.versions) ? body.versions.filter(acceptedHistory) : []);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "History is unavailable.");
    } finally {
      setBusy(false);
    }
  }

  const canExport = mappings.some((mapping) => mapping.canExport);
  return (
    <section className="external-identifiers" id="external-identifiers" aria-label="External identifiers">
      <h3>External identifiers</h3>
      <p>Connect this record to an identifier from another system. The mapping is identity metadata. It is not a credential and does not grant access.</p>
      <button type="button" aria-expanded={open} aria-controls="external-identifier-panel" onClick={() => void toggle()}>{open ? "Hide external identifiers" : "External identifiers"}</button>
      {open && (
        <div id="external-identifier-panel">
          {error && <p role="alert">{error}</p>}
          {notice && <p role="status">{notice}</p>}
          <form aria-label="Find external identifiers" onSubmit={(event) => { event.preventDefault(); setBusy(true); setError(""); void load(query).catch((reason) => setError(reason instanceof Error ? reason.message : "External identifiers could not be loaded.")).finally(() => setBusy(false)); }}>
            <label>Search by namespace or external ID <input value={query} maxLength={100} onChange={(event) => setQuery(event.target.value)} /></label>
            <button type="submit" disabled={busy}>Search identifiers</button>
          </form>
          <ul>
            {mappings.map((mapping) => (
              <li key={mapping.id}>
                <strong>{mapping.namespace}</strong> {mapping.externalId}
                <small> {mapping.state} · version {mapping.version} · {mapping.atIst}</small>
                {mapping.originalRecordId !== mapping.recordId && <small> Original record retained.</small>}
                <div className="actions">
                  {mapping.canHistory && <button type="button" disabled={busy} onClick={() => void showHistory(mapping.id)}>Mapping history</button>}
                  {mapping.canWrite && mapping.state !== "archived" && <button type="button" disabled={busy} onClick={() => void setState(mapping, "archived")}>Archive mapping</button>}
                  {mapping.canWrite && mapping.state !== "deleted" && <button type="button" disabled={busy} onClick={() => void setState(mapping, "deleted")}>Delete mapping</button>}
                  {mapping.canWrite && mapping.state !== "active" && <button type="button" disabled={busy} onClick={() => void setState(mapping, "active")}>Restore mapping</button>}
                </div>
              </li>
            ))}
          </ul>
          {canExport && <a className="external-identifier-link" href={`${root}/download?recordId=${encodeURIComponent(recordId)}`}>Download identifier mappings</a>}
          {history && (
            <ul aria-label="Identifier history">
              {history.map((version) => <li key={version.version}>Version {version.version} · {version.state} · {version.atIst} · {version.source} · {version.actorId}{version.redirectReason ? ` · ${version.redirectReason}` : ""}</li>)}
            </ul>
          )}
          <form aria-label="Connect external identifier" onSubmit={review}>
            <label>Integration namespace <input required value={namespace} maxLength={80} autoComplete="off" onChange={(event) => edit("namespace", event.target.value)} /></label>
            <label>External ID <input required value={externalId} maxLength={200} autoComplete="off" onChange={(event) => edit("externalId", event.target.value)} /></label>
            <label>Provenance <input value={provenance} maxLength={120} onChange={(event) => edit("provenance", event.target.value)} /></label>
            <button type="submit" disabled={busy}>Review connection</button>
          </form>
          {drafts.length > 0 && <p>Recoverable draft for {drafts[0].namespace} / {drafts[0].externalId}. The saved mapping is unchanged.</p>}
          <form aria-label="Save identifier draft" onSubmit={saveDraft}>
            <button type="submit" disabled={busy}>Save identifier draft</button>
          </form>
          {preview && (
            <form aria-label="Confirm external identifier" onSubmit={confirm}>
              <p>{preview.impact}</p>
              {preview.conflict?.reviewable === false && <p role="alert">This external ID is already connected. Reassignment needs permission on both records, so nothing was changed.</p>}
              {preview.conflict?.reviewable && (
                <fieldset>
                  <legend>This external ID is already connected to another record. Choose an explicit review.</legend>
                  <label className="check"><input type="radio" name="identifier-review" checked={decision === "keep"} onChange={() => setDecision("keep")} /> Keep the current record</label>
                  <label className="check"><input type="radio" name="identifier-review" checked={decision === "reassign"} onChange={() => setDecision("reassign")} /> Reassign to this record</label>
                  {decision === "reassign" && <label className="check"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> I confirm this reassignment</label>}
                  <p>The current mapping is {preview.conflict.state}. Reassignment does not change that state.</p>
                </fieldset>
              )}
              <div className="actions">
                <button type="submit" disabled={busy || (preview.conflict?.reviewable === true && decision === "reassign" && !confirmed) || preview.conflict?.reviewable === false}>Confirm connection</button>
                <button type="button" disabled={busy} onClick={() => void cancel()}>Cancel</button>
              </div>
            </form>
          )}
        </div>
      )}
    </section>
  );
}

function acceptedMapping(value: unknown): value is Mapping {
  if (!value || typeof value !== "object") return false;
  const mapping = value as Partial<Mapping>;
  return typeof mapping.id === "string" && typeof mapping.namespace === "string" && typeof mapping.externalId === "string" && typeof mapping.recordId === "string" && typeof mapping.originalRecordId === "string" && (mapping.state === "active" || mapping.state === "archived" || mapping.state === "deleted") && typeof mapping.version === "number" && typeof mapping.canWrite === "boolean" && typeof mapping.canExport === "boolean" && typeof mapping.canHistory === "boolean";
}
function acceptedDraft(value: unknown): value is Draft {
  if (!value || typeof value !== "object") return false;
  const draft = value as Partial<Draft>;
  return typeof draft.id === "string" && typeof draft.mappingId === "string" && typeof draft.namespace === "string" && typeof draft.externalId === "string" && typeof draft.version === "number";
}
function acceptedPreview(value: unknown): Preview | null {
  if (!value || typeof value !== "object") return null;
  const preview = value as Partial<Preview>;
  if (typeof preview.previewId !== "string" || typeof preview.reviewHash !== "string" || typeof preview.impact !== "string") return null;
  return { previewId: preview.previewId, reviewHash: preview.reviewHash, impact: preview.impact, namespace: String(preview.namespace ?? ""), externalId: String(preview.externalId ?? ""), provenanceLabel: String(preview.provenanceLabel ?? ""), conflict: acceptedConflict(preview.conflict) };
}
function acceptedConflict(value: unknown): Conflict | null {
  if (!value || typeof value !== "object") return null;
  const conflict = value as { reviewable?: boolean; mappingId?: unknown; recordId?: unknown; state?: unknown; version?: unknown };
  if (conflict.reviewable === false) return { reviewable: false };
  if (conflict.reviewable === true && typeof conflict.mappingId === "string" && typeof conflict.recordId === "string" && typeof conflict.state === "string" && typeof conflict.version === "number") return { reviewable: true, mappingId: conflict.mappingId, recordId: conflict.recordId, state: conflict.state, version: conflict.version };
  return null;
}
function acceptedHistory(value: unknown): value is HistoryVersion {
  if (!value || typeof value !== "object") return false;
  const version = value as Partial<HistoryVersion>;
  return typeof version.version === "number" && typeof version.state === "string" && typeof version.atIst === "string" && typeof version.actorId === "string" && typeof version.source === "string";
}
