"use client";
import { FormEvent, useRef, useState } from "react";

type Change = {
  id: string;
  kind: string;
  status: string;
  parentName?: string;
  successorName?: string;
  version: number;
  legalCommitment: boolean;
};
type EndDate = {
  id: string;
  kind: string;
  status: string;
  parentName?: string;
  originalEnd: string | null;
  proposedEnd: string | null;
  responsibility: { userId: string | null; explicit: boolean; assigned: boolean };
  decision: { value: string; explicit: boolean };
  legalCommitment: boolean;
  commitsRenewal: boolean;
  note: string;
};
type Draft = { id: string; kind: string; parentRecordId: string; successorRecordId: string; start: string; proposedEnd: string | null; timezone: string; documentFileId: string; documentVersionNo: number; responsibleUserId: string | null; decision: string; version: number };
type Preview = { previewId: string; reviewHash: string; action: string; confirm: string; impact: string };
type Policy = { reviewRequired: boolean; version: number; accessGranted: false };

const zones = ["Asia/Calcutta", "Asia/Kolkata", "UTC", "Europe/London", "America/New_York"];
const kinds = ["amendment", "extension", "renewal"] as const;

export default function ContractChanges({ workspaceId, tenantId }: { workspaceId: string; tenantId: string }) {
  const root = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/tenants/${encodeURIComponent(tenantId)}/contract-changes`;
  const [open, setOpen] = useState(false);
  const [changes, setChanges] = useState<Change[]>([]);
  const [endDates, setEndDates] = useState<EndDate[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [note, setNote] = useState("");
  const [kind, setKind] = useState<(typeof kinds)[number]>("amendment");
  const [parentRecordId, setParentRecordId] = useState("");
  const [successorRecordId, setSuccessorRecordId] = useState("");
  const [start, setStart] = useState("");
  const [timezone, setTimezone] = useState("");
  const [documentFileId, setDocumentFileId] = useState("");
  const [documentVersionNo, setDocumentVersionNo] = useState("1");
  const [proposedEnd, setProposedEnd] = useState("");
  const [query, setQuery] = useState("");
  const [decision, setDecision] = useState("undecided");
  const [responsibleUserId, setResponsibleUserId] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const saveIntent = useRef<{ key: string; operationId: string } | null>(null);

  async function load(search = query) {
    const params = new URLSearchParams({ collection: "contracts" });
    if (search.trim()) params.set("q", search.trim());
    const response = await fetch(`${root}?${params}`, { credentials: "same-origin", cache: "no-store" });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(typeof body?.error === "string" ? body.error : "Contract changes could not be loaded.");
    setChanges(Array.isArray(body?.changes) ? body.changes.filter(acceptedChange) : []);
    setEndDates(Array.isArray(body?.endDates) ? body.endDates.filter(acceptedEndDate) : []);
    setDrafts(Array.isArray(body?.drafts) ? body.drafts.filter(acceptedDraft) : []);
    setPolicy(acceptedPolicy(body?.policy));
    setNote(typeof body?.note === "string" ? body.note : "");
  }
  async function toggle() {
    const next = !open;
    setOpen(next);
    if (!next) return;
    setBusy(true);
    setError("");
    try { await load(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Contract changes could not be loaded."); } finally { setBusy(false); }
  }
  async function post(body: Record<string, unknown>) {
    const response = await fetch(root, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(typeof payload?.error === "string" ? payload.error : "The contract change could not be saved.");
    return payload;
  }
  function operation(key: string) {
    if (saveIntent.current?.key !== key) saveIntent.current = { key, operationId: crypto.randomUUID() };
    return saveIntent.current.operationId;
  }
  function clearReview() {
    setPreview(null);
    setConfirmed(false);
  }
  function createBody() {
    return { kind: "preview" as const, action: "create" as const, collection: "contracts", relationKind: kind, parentRecordId, successorRecordId, start, timezone, documentFileId, documentVersionNo: Number(documentVersionNo), proposedEnd: proposedEnd.trim() ? proposedEnd.trim() : null, decision: "undecided", responsibleUserId: null };
  }
  async function reviewCreate(event: FormEvent) {
    event.preventDefault();
    if (!timezone) { setError("Choose an explicit timezone."); return; }
    setBusy(true);
    setError("");
    try {
      const next = acceptedPreview(await post(createBody()));
      if (!next) throw new Error("Review the contract change.");
      setPreview(next);
      setConfirmed(false);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Review the contract change."); setPreview(null); } finally { setBusy(false); }
  }
  async function reviewStatus(action: "propose" | "approve" | "effectuate", change: Change) {
    setBusy(true);
    setError("");
    try {
      const next = acceptedPreview(await post({ kind: "preview", action, collection: "contracts", changeId: change.id, expectedVersion: change.version }));
      if (!next) throw new Error("Review the contract change.");
      setPreview(next);
      setConfirmed(false);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Review the contract change."); } finally { setBusy(false); }
  }
  async function reviewDecision(event: FormEvent) {
    event.preventDefault();
    const change = changes[0];
    if (!change) { setError("Open a contract change before recording a decision."); return; }
    setBusy(true);
    setError("");
    try {
      const next = acceptedPreview(await post({ kind: "preview", action: "decide", collection: "contracts", changeId: change.id, expectedVersion: change.version, decision, responsibleUserId: responsibleUserId.trim() ? responsibleUserId.trim() : null }));
      if (!next) throw new Error("Review the renewal decision.");
      setPreview(next);
      setConfirmed(false);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Review the renewal decision."); } finally { setBusy(false); }
  }
  async function confirm(event: FormEvent) {
    event.preventDefault();
    if (!preview || !confirmed) return;
    setBusy(true);
    setError("");
    try {
      await post({ kind: "confirm", operationId: operation(`${preview.confirm}:${preview.previewId}`), previewId: preview.previewId, reviewHash: preview.reviewHash, confirm: preview.confirm });
      saveIntent.current = null;
      setNotice("Saved. A date or status does not commit a renewal.");
      clearReview();
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The contract change could not be saved."); } finally { setBusy(false); }
  }
  async function saveDraft(event: FormEvent) {
    event.preventDefault();
    const draft = drafts[0];
    const draftId = draft?.id ?? crypto.randomUUID();
    setBusy(true);
    setError("");
    try {
      await post({ kind: "draft", collection: "contracts", draftId, relationKind: kind, parentRecordId, successorRecordId, start, proposedEnd: proposedEnd.trim() ? proposedEnd.trim() : null, timezone, documentFileId, documentVersionNo: Number(documentVersionNo), responsibleUserId: responsibleUserId.trim() ? responsibleUserId.trim() : null, decision, operationId: operation(`draft:${draftId}`), expectedVersion: draft?.version ?? 0 });
      saveIntent.current = null;
      setNotice("Draft saved on the server. You can come back to it.");
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The draft could not be saved."); } finally { setBusy(false); }
  }

  const linked = changes[0];
  return (
    <section className="contract-changes" aria-labelledby="contract-changes-heading">
      <h2 id="contract-changes-heading">Contract changes</h2>
      <p id="contract-change-commitment">Connect an amendment, extension, or renewal to its original contract. A date or status is an internal record only. It does not sign, execute, or commit a renewal.</p>
      <p>Configuration and assignment do not grant access.</p>
      <button type="button" onClick={() => void toggle()} aria-expanded={open}>{open ? "Close contract changes" : "Contract changes"}</button>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {open && (
        <div>
          <form aria-label="Find contract changes" onSubmit={(event) => { event.preventDefault(); setBusy(true); setError(""); void load().then(() => setBusy(false)).catch((reason) => { setError(reason instanceof Error ? reason.message : "Contract changes could not be loaded."); setBusy(false); }); }}>
            <label>Find <input value={query} onChange={(event) => setQuery(event.target.value)} autoComplete="off" /></label>
            <button type="submit" disabled={busy}>Find changes</button>
          </form>
          {policy && <p>Review required: {policy.reviewRequired ? "yes" : "no"}. Setting version {policy.version}. This setting does not grant access.</p>}
          {note && <p>{note}</p>}
          <h3>Renewal and end dates</h3>
          <ul>
            {endDates.map((item) => (
              <li key={item.id}>
                <p>{item.parentName ?? item.id} · {item.kind} · {item.status}. Original end {item.originalEnd ?? "unset"}. Proposed end {item.proposedEnd ?? "unset"}.</p>
                <p>Responsibility {item.responsibility.assigned ? item.responsibility.userId : "unset"}. Decision {item.decision.value}. Both are explicit.</p>
                <p>{item.note}</p>
              </li>
            ))}
          </ul>
          <ul>
            {changes.map((change) => (
              <li key={change.id}>
                <p>{change.parentName ?? "Original"} to {change.successorName ?? "successor"} · {change.kind} · {change.status}. No legal commitment.</p>
                <button type="button" onClick={() => void reviewStatus("propose", change)} disabled={busy || change.status !== "draft"}>Propose</button>
                <button type="button" onClick={() => void reviewStatus("approve", change)} disabled={busy || change.status !== "proposed"}>Approve</button>
                <button type="button" onClick={() => void reviewStatus("effectuate", change)} disabled={busy || change.status !== "approved"}>Make effective</button>
              </li>
            ))}
          </ul>
          {drafts[0] && <p role="status">Recoverable draft version {drafts[0].version} for {drafts[0].kind}.</p>}
          <form aria-label="Create contract change" onSubmit={reviewCreate}>
            <label>
              Kind
              <select value={kind} onChange={(event) => { setKind(event.target.value as (typeof kinds)[number]); clearReview(); }}>
                {kinds.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            </label>
            <label>Original contract <input value={parentRecordId} onChange={(event) => { setParentRecordId(event.target.value); clearReview(); }} autoComplete="off" /></label>
            <label>Successor contract <input value={successorRecordId} onChange={(event) => { setSuccessorRecordId(event.target.value); clearReview(); }} autoComplete="off" /></label>
            <label>Effective date <input value={start} onChange={(event) => { setStart(event.target.value); clearReview(); }} placeholder="2027-01-01T00:00:00+05:30" aria-describedby="contract-change-commitment" /></label>
            <label>
              Timezone
              <select value={timezone} onChange={(event) => { setTimezone(event.target.value); clearReview(); }} required>
                <option value="">Choose a timezone</option>
                {zones.map((zone) => <option key={zone} value={zone}>{zone}</option>)}
              </select>
            </label>
            <label>Supporting document <input value={documentFileId} onChange={(event) => { setDocumentFileId(event.target.value); clearReview(); }} autoComplete="off" /></label>
            <label>Document version <input inputMode="numeric" value={documentVersionNo} onChange={(event) => { setDocumentVersionNo(event.target.value); clearReview(); }} /></label>
            <label>Proposed end, optional <input value={proposedEnd} onChange={(event) => { setProposedEnd(event.target.value); clearReview(); }} placeholder="2028-01-01" aria-describedby="contract-change-commitment" /></label>
            <button type="submit" disabled={busy}>Review contract change</button>
          </form>
          <form aria-label="Record renewal decision" onSubmit={reviewDecision}>
            <label>
              Decision
              <select value={decision} onChange={(event) => { setDecision(event.target.value); clearReview(); }}>
                <option value="undecided">Undecided</option>
                <option value="renew">Renew</option>
                <option value="do-not-renew">Do not renew</option>
              </select>
            </label>
            <label>Responsible person <input value={responsibleUserId} onChange={(event) => { setResponsibleUserId(event.target.value); clearReview(); }} autoComplete="off" aria-describedby="contract-change-commitment" /></label>
            <button type="submit" disabled={busy}>Review renewal decision</button>
          </form>
          {preview && (
            <form aria-label="Confirm contract change" onSubmit={confirm}>
              <p>{preview.impact}</p>
              <label className="check"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> I confirm this contract change</label>
              <button type="submit" disabled={busy || !confirmed}>Confirm action</button>
              <button type="button" onClick={() => { clearReview(); setNotice("Cancelled. Durable contract records were not changed."); }}>Cancel</button>
            </form>
          )}
          <form aria-label="Save contract change draft" onSubmit={saveDraft}>
            <div className="actions">
              <button type="submit" disabled={busy}>Save draft</button>
            </div>
          </form>
          {linked && (
            <p>
              <a className="contract-changes-link" href={`${root}/history?collection=contracts&changeId=${encodeURIComponent(linked.id)}`}>Change history</a>
              {" "}
              <a className="contract-changes-link" href={`${root}/download?collection=contracts&changeId=${encodeURIComponent(linked.id)}`}>Download change</a>
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function acceptedChange(value: unknown): value is Change {
  if (!value || typeof value !== "object") return false;
  const change = value as Change;
  return typeof change.id === "string" && typeof change.kind === "string" && typeof change.status === "string" && typeof change.version === "number";
}
function acceptedEndDate(value: unknown): value is EndDate {
  if (!value || typeof value !== "object") return false;
  const item = value as EndDate;
  return typeof item.id === "string" && typeof item.note === "string" && item.legalCommitment === false && item.responsibility?.explicit === true && item.decision?.explicit === true;
}
function acceptedDraft(value: unknown): value is Draft {
  if (!value || typeof value !== "object") return false;
  const draft = value as Draft;
  return typeof draft.id === "string" && typeof draft.version === "number" && typeof draft.kind === "string";
}
function acceptedPolicy(value: unknown): Policy | null {
  if (!value || typeof value !== "object") return null;
  const policy = value as Policy;
  if (typeof policy.reviewRequired !== "boolean" || typeof policy.version !== "number") return null;
  return policy;
}
function acceptedPreview(value: unknown): Preview | null {
  if (!value || typeof value !== "object") return null;
  const preview = value as Preview;
  if (typeof preview.previewId !== "string" || typeof preview.reviewHash !== "string" || typeof preview.confirm !== "string" || typeof preview.impact !== "string") return null;
  return preview;
}
