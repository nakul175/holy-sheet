"use client";
import { FormEvent, useRef, useState } from "react";
import { identifierPayloadHasCredential } from "../lib/external-identifier-mapping";
import { mismatchLabel, parseConsumerIdentity, repairChoices, type MismatchClass } from "../lib/integration-health";

type Failure = { deliveryId: string; eventId: string; recordId: string; recordVersion: number; state: string; attemptCount: number; failureCode: string | null; failureRedacted: string; atIst: string };
type Consumer = {
  id: string;
  clientId: string;
  label: string;
  outage: string;
  version: number;
  deliveryMode: string;
  schedule: string;
  liveActivation: boolean;
  lastAcknowledgement: { sequence: number; recordVersion: number | null; atIst: string } | null;
  queueAgeSeconds: number | null;
  oldestUnacknowledgedAtIst: string | null;
  failures: Failure[];
  canRepair: boolean;
  canReconcile: boolean;
  canExport: boolean;
  canHistory: boolean;
};
type Draft = { id: string; consumerId: string; note: string; version: number };
type Preview = { previewId: string; reviewHash: string; action: string; confirm: string; impact: string; consumerId: string | null };
type Mismatch = { id: string; class: MismatchClass; recordId: string | null; canonicalVersion: number | null; observedVersion: number | null };
type Run = { runId: string; version: number; phase: string; resume: boolean; mismatches: Mismatch[] };

const classes = new Set(["unacknowledged", "version-lag", "version-ahead", "unknown-record", "missing-reference", "extra-reference", "reference-version", "poison"]);

export default function IntegrationHealth({ workspaceId, tenantId, collection }: { workspaceId: string; tenantId: string; collection: string }) {
  const root = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/tenants/${encodeURIComponent(tenantId)}/integration-health`;
  const [open, setOpen] = useState(false);
  const [consumers, setConsumers] = useState<Consumer[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [query, setQuery] = useState("");
  const [clientId, setClientId] = useState("");
  const [label, setLabel] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [run, setRun] = useState<Run | null>(null);
  const [observedRecord, setObservedRecord] = useState("");
  const [observedVersion, setObservedVersion] = useState("1");
  const [note, setNote] = useState("");
  const [history, setHistory] = useState<string>("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const saveIntent = useRef<{ key: string; operationId: string } | null>(null);
  const selected = consumers[0];

  async function load(search = query) {
    const response = await fetch(`${root}?collection=${encodeURIComponent(collection)}&q=${encodeURIComponent(search)}`, { credentials: "same-origin", cache: "no-store" });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(typeof body?.error === "string" ? body.error : "Integration health could not be loaded.");
    setConsumers(Array.isArray(body?.consumers) ? body.consumers.filter(acceptedConsumer) : []);
    setDrafts(Array.isArray(body?.drafts) ? body.drafts.filter(acceptedDraft) : []);
  }
  async function toggle() {
    const next = !open;
    setOpen(next);
    if (!next) return;
    setBusy(true);
    setError("");
    try { await load(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Integration health could not be loaded."); } finally { setBusy(false); }
  }
  async function post(body: Record<string, unknown>) {
    const response = await fetch(root, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(typeof payload?.error === "string" ? payload.error : "The integration action could not be saved.");
    return payload;
  }
  function operation(key: string) {
    if (saveIntent.current?.key !== key) saveIntent.current = { key, operationId: crypto.randomUUID() };
    return saveIntent.current.operationId;
  }
  async function reviewRegistration(event: FormEvent) {
    event.preventDefault();
    const parsed = parseConsumerIdentity({ clientId, label });
    if (!parsed.ok) { setError(parsed.message); setPreview(null); return; }
    setBusy(true);
    setError("");
    try {
      const body = await post({ kind: "preview", action: "register", collection, clientId: parsed.clientId, label: parsed.label });
      const next = acceptedPreview(body);
      if (!next) throw new Error("Review the consumer.");
      setPreview(next);
      setConfirmed(false);
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Review the consumer."); } finally { setBusy(false); }
  }
  async function reviewRetry(failure: Failure) {
    if (!selected) return;
    setBusy(true);
    setError("");
    try {
      const body = await post({ kind: "preview", action: "retry", collection, consumerId: selected.id, deliveryId: failure.deliveryId });
      const next = acceptedPreview(body);
      if (!next) throw new Error("Review the retry.");
      setPreview(next);
      setConfirmed(false);
      saveIntent.current = null;
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Review the retry."); } finally { setBusy(false); }
  }
  async function reviewRepair(mismatch: Mismatch, decision: string) {
    if (!selected) return;
    setBusy(true);
    setError("");
    try {
      const body = await post({ kind: "preview", action: "repair", collection, consumerId: selected.id, mismatchId: mismatch.id, decision });
      const next = acceptedPreview(body);
      if (!next) throw new Error("Review the repair.");
      setPreview(next);
      setConfirmed(false);
      saveIntent.current = null;
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Review the repair."); } finally { setBusy(false); }
  }
  async function confirm(event: FormEvent) {
    event.preventDefault();
    if (!preview || !confirmed || busy) return;
    setBusy(true);
    setError("");
    try {
      await post({ kind: "confirm", operationId: operation(`${preview.previewId}:${preview.confirm}`), previewId: preview.previewId, reviewHash: preview.reviewHash, confirm: preview.confirm });
      setPreview(null);
      setConfirmed(false);
      setNotice("Saved. Delivery stays paused and canonical data was not overwritten.");
      saveIntent.current = null;
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The integration action could not be saved."); } finally { setBusy(false); }
  }
  async function reconcile(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    const version = Number(observedVersion);
    const observations = observedRecord ? { records: [{ recordId: observedRecord, version }] } : {};
    if (observedRecord && (!/^[0-9a-f-]{36}$/i.test(observedRecord) || !Number.isInteger(version) || version < 1)) { setError("Review the observed record id and version."); return; }
    setBusy(true);
    setError("");
    try {
      const body = await post({ kind: "reconcile", collection, consumerId: selected.id, operationId: operation(`reconcile:${run?.runId ?? "new"}:${run?.version ?? 0}`), ...(run ? { runId: run.runId, expectedVersion: run.version } : { observations }), bound: 25 });
      const next = acceptedRun(body);
      if (!next) throw new Error("Review the reconciliation.");
      setRun(next);
      setNotice(next.resume ? "Bounded scan saved. Continue reconciliation to resume." : "Reconciliation finished.");
      saveIntent.current = null;
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Review the reconciliation."); } finally { setBusy(false); }
  }
  async function saveDraft(event: FormEvent) {
    event.preventDefault();
    if (!selected) return;
    if (note.trim() && identifierPayloadHasCredential({ note })) { setError("A draft cannot carry a credential or secret."); return; }
    setBusy(true);
    setError("");
    try {
      const existing = drafts.find((draft) => draft.consumerId === selected.id);
      await post({ kind: "draft", draftId: existing?.id ?? crypto.randomUUID(), consumerId: selected.id, collection, operationId: crypto.randomUUID(), expectedVersion: existing?.version ?? 0, note, observations: {} });
      setNotice("Draft saved. Delivery and canonical records were not changed.");
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The draft could not be saved."); } finally { setBusy(false); }
  }
  async function discardDraft() {
    if (!selected) return;
    const existing = drafts.find((draft) => draft.consumerId === selected.id);
    if (!existing) return;
    setBusy(true);
    setError("");
    try {
      await post({ kind: "discard", consumerId: selected.id, collection, operationId: crypto.randomUUID(), expectedVersion: existing.version });
      setNote("");
      setNotice("Draft discarded. Delivery was not changed.");
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The draft could not be discarded."); } finally { setBusy(false); }
  }
  async function showHistory() {
    if (!selected) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`${root}/${selected.id}/history?collection=${encodeURIComponent(collection)}`, { credentials: "same-origin", cache: "no-store" });
      const body = await response.json().catch(() => null);
      if (!response.ok) throw new Error(typeof body?.error === "string" ? body.error : "History is unavailable.");
      const version = Array.isArray(body?.versions) ? body.versions[0] : null;
      setHistory(version ? `Version ${version.version} · ${version.atIst} · ${version.source}` : "No saved versions.");
    } catch (reason) { setError(reason instanceof Error ? reason.message : "History is unavailable."); } finally { setBusy(false); }
  }

  return (
    <section className="integration-health" aria-label="Integration health">
      <h2>Integration health</h2>
      <p>Delivery stays paused. A consumer registration does not activate a live connection, rotate credentials, or grant record access.</p>
      <button type="button" aria-expanded={open} aria-controls="integration-health-panel" onClick={() => void toggle()}>{open ? "Hide integration health" : "Integration health"}</button>
      {open && (
        <div id="integration-health-panel">
          {error && <p role="alert">{error}</p>}
          {notice && <p role="status">{notice}</p>}
          <form aria-label="Find consumers" onSubmit={(event) => { event.preventDefault(); setBusy(true); setError(""); void load(query).catch((reason) => setError(reason instanceof Error ? reason.message : "Integration health could not be loaded.")).finally(() => setBusy(false)); }}>
            <label>Find consumers <input value={query} maxLength={100} onChange={(event) => setQuery(event.target.value)} /></label>
            <button type="submit" disabled={busy}>Search</button>
          </form>
          {selected?.canExport && <a className="integration-health-link" href={`${root}/download?collection=${encodeURIComponent(collection)}&consumerId=${encodeURIComponent(selected.id)}`}>Download redacted evidence</a>}
          <ul>
            {consumers.map((consumer) => (
              <li key={consumer.id}>
                <strong>{consumer.label}</strong>
                <span> {consumer.clientId}</span>
                <p>Schedule {consumer.schedule}. Outage {consumer.outage}. {consumer.liveActivation ? "Live" : "Not live"}.</p>
                <p>{consumer.lastAcknowledgement ? `Last acknowledgement ${consumer.lastAcknowledgement.atIst}, version ${consumer.lastAcknowledgement.recordVersion ?? "none"}, sequence ${consumer.lastAcknowledgement.sequence}.` : "No acknowledgement yet."}</p>
                <p>{consumer.queueAgeSeconds === null ? "Queue is clear." : `Queue age ${consumer.queueAgeSeconds} seconds${consumer.oldestUnacknowledgedAtIst ? `, oldest ${consumer.oldestUnacknowledgedAtIst}` : ""}.`}</p>
                {consumer.failures.map((failure) => (
                  <p key={failure.deliveryId}>
                    {failure.state} · {failure.attemptCount} attempts · {failure.failureRedacted || failure.failureCode} · {failure.atIst}
                    {consumer.canRepair && failure.state === "failed" && <button type="button" onClick={() => void reviewRetry(failure)}>Preview retry</button>}
                  </p>
                ))}
                {consumer.canHistory && <button type="button" onClick={() => void showHistory()}>History</button>}
              </li>
            ))}
          </ul>
          {history && <p role="status">{history}</p>}
          <form aria-label="Register paused consumer" onSubmit={reviewRegistration}>
            <label>Consumer id <input value={clientId} maxLength={64} onChange={(event) => { setClientId(event.target.value); setPreview(null); setConfirmed(false); }} /></label>
            <label>Label <input value={label} maxLength={100} onChange={(event) => { setLabel(event.target.value); setPreview(null); setConfirmed(false); }} /></label>
            <button type="submit" disabled={busy}>Review consumer</button>
          </form>
          {selected?.canReconcile && (
            <form aria-label="Reconcile consumer" onSubmit={reconcile}>
              <label>Observed record <input value={observedRecord} onChange={(event) => { setObservedRecord(event.target.value); setRun(null); }} /></label>
              <label>Observed version <input inputMode="numeric" value={observedVersion} onChange={(event) => { setObservedVersion(event.target.value); setRun(null); }} /></label>
              <button type="submit" disabled={busy}>{run?.resume ? "Continue reconciliation" : "Run bounded reconciliation"}</button>
            </form>
          )}
          {run && (
            <div>
              <p>{run.resume ? `Reconciliation ${run.phase} can resume.` : `Reconciliation ${run.phase}.`}</p>
              <ul>
                {run.mismatches.map((mismatch) => (
                  <li key={mismatch.id}>
                    <p>{mismatch.class}. {mismatchLabel(mismatch.class)}</p>
                    {selected?.canRepair && repairChoices(mismatch.class).map((choice) => (
                      <button key={choice.decision} type="button" onClick={() => void reviewRepair(mismatch, choice.decision)}>{choice.label}</button>
                    ))}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {preview && (
            <form aria-label="Confirm integration action" onSubmit={confirm}>
              <p>{preview.impact}</p>
              <label className="check"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> I confirm this paused action</label>
              <button type="submit" disabled={busy || !confirmed}>Confirm action</button>
              <button type="button" onClick={() => { setPreview(null); setConfirmed(false); setNotice("Cancelled. Durable delivery was not changed."); }}>Cancel</button>
            </form>
          )}
          {selected?.canRepair && (
            <form aria-label="Save reconciliation draft" onSubmit={saveDraft}>
              <label>Draft note <textarea value={note} maxLength={500} onChange={(event) => setNote(event.target.value)} /></label>
              <div className="actions">
                <button type="submit" disabled={busy}>Save draft</button>
                <button type="button" onClick={() => void discardDraft()} disabled={busy}>Discard draft</button>
              </div>
            </form>
          )}
        </div>
      )}
    </section>
  );
}

function acceptedConsumer(value: unknown): value is Consumer {
  if (!value || typeof value !== "object") return false;
  const consumer = value as Consumer;
  return typeof consumer.id === "string" && typeof consumer.clientId === "string" && typeof consumer.label === "string" && Array.isArray(consumer.failures);
}
function acceptedDraft(value: unknown): value is Draft {
  if (!value || typeof value !== "object") return false;
  const draft = value as Draft;
  return typeof draft.id === "string" && typeof draft.consumerId === "string" && typeof draft.note === "string" && typeof draft.version === "number";
}
function acceptedPreview(value: unknown): Preview | null {
  if (!value || typeof value !== "object") return null;
  const preview = value as Preview;
  if (typeof preview.previewId !== "string" || typeof preview.reviewHash !== "string" || typeof preview.confirm !== "string" || typeof preview.impact !== "string") return null;
  return preview;
}
function acceptedRun(value: unknown): Run | null {
  if (!value || typeof value !== "object") return null;
  const run = value as Run;
  if (typeof run.runId !== "string" || typeof run.version !== "number" || typeof run.resume !== "boolean" || !Array.isArray(run.mismatches)) return null;
  return { ...run, mismatches: run.mismatches.filter((item) => item && typeof item.id === "string" && classes.has(item.class)) };
}
