"use client";
import { FormEvent, useRef, useState } from "react";

type Policy = { fieldKey: string; label: string; kind: string; enabled: boolean; version: number };
type Interval = {
  id: string;
  recordId: string;
  recordName?: string;
  fieldKey: string;
  state: string;
  value?: unknown;
  effectiveStart: string | null;
  effectiveEnd: string | null;
  timezone: string;
  enteredAt: string | null;
  blockedCode: string | null;
  halfOpen: boolean;
};
type Draft = { id: string; recordId: string; fieldKey: string; value: unknown; start: string; end: string | null; timezone: string; reason: string; version: number };
type Preview = { previewId: string; reviewHash: string; action: string; confirm: string; impact: string };
type AsOf = { asOf: string; state: string; value: unknown; enteredAt: string | null; effectiveStart: string | null; effectiveEnd: string | null; calculation?: { asOf: string; engine: string; identified: boolean } };

const zones = ["Asia/Calcutta", "Asia/Kolkata", "UTC", "Europe/London", "America/New_York"];

export default function EffectiveDates({ workspaceId, tenantId, collection }: { workspaceId: string; tenantId: string; collection: string }) {
  const root = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/tenants/${encodeURIComponent(tenantId)}/effective-dates`;
  const [open, setOpen] = useState(false);
  const [policies, setPolicies] = useState<Policy[]>([]);
  const [intervals, setIntervals] = useState<Interval[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [recordId, setRecordId] = useState("");
  const [fieldKey, setFieldKey] = useState("");
  const [recordVersion, setRecordVersion] = useState("1");
  const [value, setValue] = useState("");
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [timezone, setTimezone] = useState("");
  const [reason, setReason] = useState("");
  const [asOf, setAsOf] = useState("");
  const [resolved, setResolved] = useState<AsOf | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const saveIntent = useRef<{ key: string; operationId: string } | null>(null);

  async function load(searchRecord = recordId) {
    const params = new URLSearchParams({ collection });
    if (searchRecord) params.set("recordId", searchRecord);
    if (fieldKey) params.set("fieldKey", fieldKey);
    if (asOf) params.set("asOf", asOf);
    const response = await fetch(`${root}?${params}`, { credentials: "same-origin", cache: "no-store" });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(typeof body?.error === "string" ? body.error : "Effective dates could not be loaded.");
    setPolicies(Array.isArray(body?.policies) ? body.policies.filter(acceptedPolicy) : []);
    setIntervals(Array.isArray(body?.intervals) ? body.intervals.filter(acceptedInterval) : []);
    setDrafts(Array.isArray(body?.drafts) ? body.drafts.filter(acceptedDraft) : []);
    setResolved(acceptedAsOf(body?.asOf));
  }
  async function toggle() {
    const next = !open;
    setOpen(next);
    if (!next) return;
    setBusy(true);
    setError("");
    try { await load(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Effective dates could not be loaded."); } finally { setBusy(false); }
  }
  async function post(body: Record<string, unknown>) {
    const response = await fetch(root, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(typeof payload?.error === "string" ? payload.error : "The effective-date action could not be saved.");
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
  async function reviewProposal(event: FormEvent) {
    event.preventDefault();
    if (!timezone) { setError("Choose an explicit timezone."); return; }
    setBusy(true);
    setError("");
    try {
      const body = await post({ kind: "preview", action: "propose", collection, recordId, fieldKey, value: parseFieldValue(value), start, end: end.trim() ? end : null, timezone, reason, expectedRecordVersion: Number(recordVersion) });
      const next = acceptedPreview(body);
      if (!next) throw new Error("Review the effective value.");
      setPreview(next);
      setConfirmed(false);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Review the effective value."); setPreview(null); } finally { setBusy(false); }
  }
  async function confirm(event: FormEvent) {
    event.preventDefault();
    if (!preview || !confirmed) return;
    setBusy(true);
    setError("");
    try {
      await post({ kind: "confirm", operationId: operation(`${preview.confirm}:${preview.previewId}`), previewId: preview.previewId, reviewHash: preview.reviewHash, confirm: preview.confirm });
      saveIntent.current = null;
      setNotice("Saved. Entered time and effective time stay separate.");
      clearReview();
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The effective-date action could not be saved."); } finally { setBusy(false); }
  }
  async function reviewInterval(action: "activate" | "cancel", interval: Interval) {
    setBusy(true);
    setError("");
    try {
      const body = await post({ kind: "preview", action, collection, recordId: interval.recordId, intervalId: interval.id, reason, expectedRecordVersion: Number(recordVersion) });
      const next = acceptedPreview(body);
      if (!next) throw new Error("Review the effective value.");
      setPreview(next);
      setConfirmed(false);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Review the effective value."); } finally { setBusy(false); }
  }
  async function saveDraft(event: FormEvent) {
    event.preventDefault();
    const draft = drafts[0];
    const draftId = draft?.id ?? crypto.randomUUID();
    setBusy(true);
    setError("");
    try {
      await post({ kind: "draft", draftId, collection, recordId, fieldKey, value: parseFieldValue(value), start, end: end.trim() ? end : null, timezone, reason, operationId: operation(`draft:${draftId}`), expectedVersion: draft?.version ?? 0 });
      saveIntent.current = null;
      setNotice("Draft saved on the server. You can come back to it.");
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The draft could not be saved."); } finally { setBusy(false); }
  }
  async function lookup(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try { await load(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Effective dates could not be loaded."); setResolved(null); } finally { setBusy(false); }
  }

  return (
    <section className="effective-dates" aria-labelledby="effective-dates-heading">
      <h2 id="effective-dates-heading">Effective dates</h2>
      <p>Record when a scalar or reference value becomes valid. Effective time is separate from the time you enter it. Intervals include the start and exclude the end. Activation is manual and checks the field again.</p>
      <button type="button" onClick={() => void toggle()} aria-expanded={open}>{open ? "Close effective dates" : "Effective dates"}</button>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {open && (
        <div>
          <form aria-label="Look up effective value" onSubmit={lookup}>
            <label>Record <input value={recordId} onChange={(event) => { setRecordId(event.target.value); clearReview(); }} autoComplete="off" /></label>
            <label>Field <input value={fieldKey} onChange={(event) => { setFieldKey(event.target.value); clearReview(); }} autoComplete="off" /></label>
            <label>As of <input value={asOf} onChange={(event) => setAsOf(event.target.value)} placeholder="2026-11-01T17:30:00+05:30" autoComplete="off" /></label>
            <button type="submit" disabled={busy}>Look up as of</button>
          </form>
          {resolved && (
            <p>
              As of {resolved.asOf}: {resolved.state}. Entered {resolved.enteredAt ?? "not entered"}. Effective {resolved.effectiveStart ?? "none"} to {resolved.effectiveEnd ?? "open"}.
              {resolved.calculation?.identified ? ` Calculation uses ${resolved.calculation.engine} at ${resolved.calculation.asOf}.` : ""}
            </p>
          )}
          <ul>
            {policies.filter((policy) => policy.enabled).map((policy) => <li key={policy.fieldKey}>{policy.label} is effective-dated. Setting version {policy.version}. This setting does not grant access.</li>)}
          </ul>
          <ul>
            {intervals.map((interval) => (
              <li key={interval.id}>
                <p>{interval.recordName ?? interval.recordId} · {interval.fieldKey} · {interval.state}{interval.blockedCode ? ` · blocked ${interval.blockedCode}` : ""}</p>
                <p>Entered {interval.enteredAt}. Effective {interval.effectiveStart} to {interval.effectiveEnd ?? "open"} ({interval.timezone}). {interval.halfOpen ? "Half-open." : ""}</p>
                <button type="button" onClick={() => void reviewInterval("activate", interval)} disabled={busy || interval.state !== "scheduled"}>Activate</button>
                <button type="button" onClick={() => void reviewInterval("cancel", interval)} disabled={busy || interval.state === "cancelled"}>Cancel interval</button>
              </li>
            ))}
          </ul>
          {drafts[0] && <p role="status">Recoverable draft version {drafts[0].version} for {drafts[0].fieldKey}.</p>}
          <form aria-label="Propose effective value" onSubmit={reviewProposal}>
            <label>Record version <input inputMode="numeric" value={recordVersion} onChange={(event) => { setRecordVersion(event.target.value); clearReview(); }} /></label>
            <label>Value <input value={value} onChange={(event) => { setValue(event.target.value); clearReview(); }} /></label>
            <label>Effective start <input value={start} onChange={(event) => { setStart(event.target.value); clearReview(); }} placeholder="2026-12-01T09:00:00+05:30" aria-describedby="effective-window-help" /></label>
            <label>Effective end, optional <input value={end} onChange={(event) => { setEnd(event.target.value); clearReview(); }} aria-describedby="effective-window-help" /></label>
            <p id="effective-window-help">Use an offset that matches the timezone. The end is excluded.</p>
            <label>
              Timezone
              <select value={timezone} onChange={(event) => { setTimezone(event.target.value); clearReview(); }} required>
                <option value="">Choose a timezone</option>
                {zones.map((zone) => <option key={zone} value={zone}>{zone}</option>)}
              </select>
            </label>
            <label>Backdated reason <input value={reason} onChange={(event) => { setReason(event.target.value); clearReview(); }} /></label>
            <button type="submit" disabled={busy}>Review effective value</button>
          </form>
          {preview && (
            <form aria-label="Confirm effective action" onSubmit={confirm}>
              <p>{preview.impact}</p>
              <label className="check"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> I confirm this effective-date action</label>
              <button type="submit" disabled={busy || !confirmed}>Confirm action</button>
              <button type="button" onClick={() => { clearReview(); setNotice("Cancelled. Durable effective values were not changed."); }}>Cancel</button>
            </form>
          )}
          <form aria-label="Save effective draft" onSubmit={saveDraft}>
            <div className="actions">
              <button type="submit" disabled={busy}>Save draft</button>
            </div>
          </form>
          {recordId && fieldKey && asOf && <a className="effective-dates-link" href={`${root}/download?collection=${encodeURIComponent(collection)}&recordId=${encodeURIComponent(recordId)}&fieldKey=${encodeURIComponent(fieldKey)}&asOf=${encodeURIComponent(asOf)}`}>Download as-of value</a>}
          <p><a className="effective-dates-link" href={`${root}/history?collection=${encodeURIComponent(collection)}&recordId=${encodeURIComponent(recordId)}&fieldKey=${encodeURIComponent(fieldKey)}`}>Effective history</a> shows when the value was entered and when it is effective.</p>
        </div>
      )}
    </section>
  );
}

function parseFieldValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try { return JSON.parse(trimmed) as unknown; } catch { return raw; }
  }
  return raw;
}

function acceptedPolicy(value: unknown): value is Policy {
  if (!value || typeof value !== "object") return false;
  const policy = value as Policy;
  return typeof policy.fieldKey === "string" && typeof policy.label === "string" && typeof policy.enabled === "boolean";
}
function acceptedInterval(value: unknown): value is Interval {
  if (!value || typeof value !== "object") return false;
  const interval = value as Interval;
  return typeof interval.id === "string" && typeof interval.state === "string" && typeof interval.fieldKey === "string";
}
function acceptedDraft(value: unknown): value is Draft {
  if (!value || typeof value !== "object") return false;
  const draft = value as Draft;
  return typeof draft.id === "string" && typeof draft.version === "number" && typeof draft.fieldKey === "string";
}
function acceptedPreview(value: unknown): Preview | null {
  if (!value || typeof value !== "object") return null;
  const preview = value as Preview;
  if (typeof preview.previewId !== "string" || typeof preview.reviewHash !== "string" || typeof preview.confirm !== "string" || typeof preview.impact !== "string") return null;
  return preview;
}
function acceptedAsOf(value: unknown): AsOf | null {
  if (!value || typeof value !== "object") return null;
  const resolved = value as AsOf;
  if (typeof resolved.asOf !== "string" || typeof resolved.state !== "string") return null;
  return resolved;
}
