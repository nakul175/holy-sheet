"use client";
import { FormEvent, useEffect, useRef, useState } from "react";
import {
  acceptedHistoryPage,
  acceptedHistoryPreview,
  acceptedHistoryRestore,
  historyApplyBody,
  historyPreviewBody,
  historyRequestError,
  historyRestoreNeedsReview,
  restorableHistoryFields,
  RecordHistoryRequestError,
  type HistoryEventView,
  type HistoryFieldInput,
  type HistoryPage,
  type HistoryPreviewView,
  type HistorySide,
  type HistorySnapshot,
} from "../lib/record-history-contract";

function displayValue(value: unknown) {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function guidance(error: RecordHistoryRequestError) {
  if (error.code === "record_history_cursor") return "This history page expired or no longer matches the record. Reload the newest changes.";
  if (error.code === "record_history_reference_unavailable") return "A selected reference cannot be restored without a qualified current reference read.";
  if (error.code === "record_history_field_unavailable") return "A selected field is missing, deprecated, or not both readable in history and writable now.";
  if (error.code === "record_unique_conflict") return "A selected value is no longer unique. Review the current record before trying again.";
  if (error.code === "record_history_expired") return "The ten-minute review expired. Review the selection again.";
  if (historyRestoreNeedsReview(error.code)) return "The record, schema, or access changed. Review the selection again.";
  if (error.status === 403 || error.status === 404) return "History is not available with your current access.";
  return "";
}

function ReviewValues({ title, name, values, keys, fields }: { title: string; name?: string; values: Record<string, unknown>; keys: readonly string[]; fields: readonly HistoryFieldInput[] }) {
  return (
    <div>
      <h4>{title}</h4>
      <dl>
        {keys.map((key) => <div key={key}><dt>{key === "name" ? "Name" : fields.find((field) => field.key === key)?.label ?? "Unavailable field"}</dt><dd>{key === "name" ? (name ?? "—") : displayValue(values[key])}</dd></div>)}
      </dl>
    </div>
  );
}

function Snapshot({ title, snapshot, fields }: { title: string; snapshot: HistorySnapshot | null; fields: readonly HistoryFieldInput[] }) {
  if (!snapshot) return <p>{title}: none. This side cannot be selected.</p>;
  return (
    <div>
      <h4>{title}</h4>
      <dl>
        <div><dt>Name</dt><dd>{snapshot.name}</dd></div>
        {Object.entries(snapshot.values).map(([key, value]) => <div key={key}><dt>{fields.find((field) => field.key === key)?.label ?? "Unavailable field"}</dt><dd>{displayValue(value)}</dd></div>)}
      </dl>
    </div>
  );
}

export default function RecordHistory({
  workspaceId,
  tenantId,
  recordId,
  recordVersion,
  canRestore,
  fields,
  onRestored,
}: {
  workspaceId: string;
  tenantId: string;
  recordId: string;
  recordVersion: number;
  canRestore: boolean;
  fields: readonly HistoryFieldInput[];
  onRestored: (result: { replayed: boolean }) => Promise<void> | void;
}) {
  const root = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/tenants/${encodeURIComponent(tenantId)}/records/${encodeURIComponent(recordId)}/history`;
  const [page, setPage] = useState<HistoryPage | null>(null);
  const [events, setEvents] = useState<HistoryEventView[]>([]);
  const [eventId, setEventId] = useState("");
  const [side, setSide] = useState<HistorySide>("after");
  const [checked, setChecked] = useState<string[]>([]);
  const [preview, setPreview] = useState<HistoryPreviewView | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const operation = useRef<{ previewId: string; operationId: string } | null>(null);
  const pageRef = useRef<HistoryPage | null>(null);
  const requestSeq = useRef(0);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  async function load(cursor: string | null, mode: "replace" | "append") {
    const token = ++requestSeq.current;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(cursor ? `${root}?cursor=${encodeURIComponent(cursor)}` : root, { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) throw await historyRequestError(response);
      const next = acceptedHistoryPage(await response.json());
      if (!next) throw new RecordHistoryRequestError("History could not be read.", 502, "record_history_unavailable", true);
      if (!alive.current || token !== requestSeq.current) return;
      if (mode === "append") {
        const current = pageRef.current;
        if (!current || current.anchorVersion !== next.anchorVersion || next.events.some((event) => current.events.some((item) => item.id === event.id))) {
          setError("This history page could not be added. Reload the newest changes.");
          return;
        }
        const combined = { anchorVersion: current.anchorVersion, nextCursor: next.nextCursor, events: [...current.events, ...next.events] };
        pageRef.current = combined;
        setPage(combined);
        setEvents(combined.events);
      } else {
        pageRef.current = next;
        setEvents(next.events);
        setPage(next);
        setEventId("");
        setSide("after");
        setChecked([]);
        setPreview(null);
        setConfirmed(false);
        operation.current = null;
        setUncertain(false);
      }
    } catch (reason) {
      if (!alive.current || token !== requestSeq.current) return;
      const requestError = reason instanceof RecordHistoryRequestError ? reason : null;
      setError(requestError ? `${requestError.message} ${guidance(requestError)}`.replace(/\s+/g, " ").trim() : "History could not be loaded.");
    } finally {
      if (alive.current && token === requestSeq.current) setBusy(false);
    }
  }
  useEffect(() => { void load(null, "replace"); }, [root, recordVersion]);

  const selected = events.find((event) => event.id === eventId) ?? null;
  const snapshot = selected ? (side === "before" ? selected.before : selected.after) : null;
  const choices = restorableHistoryFields(fields, snapshot);
  const allowed = new Set(choices.map((choice) => choice.key));
  const fieldsToRestore = checked.filter((key) => allowed.has(key));
  const request = selected ? historyPreviewBody({ eventId: selected.id, side, fields: fieldsToRestore, expectedVersion: recordVersion, allowedFields: choices.map((choice) => choice.key) }) : null;
  const pinned = preview && request && preview.fields.join("\0") === request.fields.join("\0") && preview.side === request.side && preview.expectedVersion === request.expectedVersion ? preview : null;

  function clearReview() {
    setPreview(null);
    setConfirmed(false);
    if (!uncertain) operation.current = null;
  }
  function chooseEvent(id: string) {
    if (uncertain) return;
    setEventId(id);
    setSide("after");
    setChecked([]);
    clearReview();
  }
  function chooseSide(next: HistorySide) {
    if (uncertain) return;
    setSide(next);
    setChecked([]);
    clearReview();
  }
  function toggle(key: string) {
    if (uncertain) return;
    setChecked((current) => current.includes(key) ? current.filter((item) => item !== key) : [...current, key]);
    clearReview();
  }
  async function review(event: FormEvent) {
    event.preventDefault();
    if (!request || busy || uncertain || pinned) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(root, { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) });
      if (!response.ok) throw await historyRequestError(response);
      const next = acceptedHistoryPreview(await response.json(), request, recordId);
      if (!next) throw new RecordHistoryRequestError("The restore review was incomplete.", 502, "record_history_unavailable", true);
      if (!alive.current) return;
      setPreview(next);
      setConfirmed(false);
      setNotice("Review expires in about ten minutes. It uses the stored values below, and only the fields you selected.");
    } catch (reason) {
      if (!alive.current) return;
      const requestError = reason instanceof RecordHistoryRequestError ? reason : null;
      if (requestError && historyRestoreNeedsReview(requestError.code)) clearReview();
      setError(requestError ? `${requestError.message} ${guidance(requestError)}`.replace(/\s+/g, " ").trim() : "The restore could not be reviewed.");
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function apply() {
    if (!pinned || busy || !confirmed) return;
    const operationId = operation.current?.previewId === pinned.previewId ? operation.current.operationId : crypto.randomUUID();
    operation.current = { previewId: pinned.previewId, operationId };
    const body = historyApplyBody({ previewId: pinned.previewId, reviewHash: pinned.reviewHash, operationId });
    if (!body) return;
    setBusy(true);
    setError("");
    setNotice("");
    setUncertain(true);
    let saved = false;
    try {
      const response = await fetch(root, { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      if (!response.ok) throw await historyRequestError(response);
      const result = acceptedHistoryRestore(await response.json(), recordId);
      if (!result) throw new RecordHistoryRequestError("The restore result was incomplete.", 502, "record_history_unavailable", true);
      saved = true;
      await onRestored(result);
      if (!alive.current) return;
      setUncertain(false);
      setNotice(result.replayed ? "This restore was already saved. The record was opened again under your current access." : "Selected values were saved as a new version. Unselected fields, identity, relationships, documents, lifecycle and grants were kept.");
    } catch (reason) {
      if (!alive.current) return;
      const requestError = reason instanceof RecordHistoryRequestError ? reason : null;
      if (saved) {
        setUncertain(false);
        setError("The restore was saved, but the record could not be opened again. Open it before making another change.");
        return;
      }
      if (requestError && historyRestoreNeedsReview(requestError.code)) {
        setUncertain(false);
        operation.current = null;
        setPreview(null);
        setConfirmed(false);
      } else if (!requestError || !requestError.retryable) setUncertain(false);
      setError(requestError ? `${requestError.message} ${guidance(requestError)} ${requestError.retryable ? "Retry the same restore." : ""}`.replace(/\s+/g, " ").trim() : "The restore was not confirmed. Retry the same restore.");
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  return (
    <section aria-label="Record history">
      <h3>Record history</h3>
      <p>Newest changes are shown first, up to 50 at a time. Times are UTC. Older pages stay on the version that was current when you opened history; reload to see a newer change. History stays after Trash. This screen does not delete history.</p>
      <p>Attachment and record references are omitted unless a qualified current reference read is configured, and they cannot be restored here. A field that is missing or deprecated cannot be restored. Relationships, documents, lifecycle and grants stay as they are.</p>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {!page && !error && <p role="status">Loading history…</p>}
      {page && !events.length && <p>No visible changes.</p>}
      {page && <p>Anchored at version {page.anchorVersion}.</p>}
      {events.map((event) => (
        <article key={event.id}>
          <h4>{event.kind} · version {event.version}</h4>
          <p><time dateTime={event.at}>{event.at} UTC</time></p>
          <p>Actor {event.actorId} · {event.sourceApp} · operation {event.operationId}</p>
          {event.serviceSubject && <p>Service subject {event.serviceSubject}</p>}
          {event.batchId && <p>Import batch {event.batchId}{event.sourceRow !== null ? ` · source row ${event.sourceRow}` : ""}</p>}
          <Snapshot title="Before" snapshot={event.before} fields={fields} />
          <Snapshot title="After" snapshot={event.after} fields={fields} />
        </article>
      ))}
      {page?.nextCursor && <button type="button" disabled={busy || uncertain} onClick={() => void load(page.nextCursor, "append")}>Older changes</button>}
      {page && <button type="button" disabled={busy || uncertain} onClick={() => void load(null, "replace")}>Reload newest changes</button>}
      {canRestore ? (
        <form aria-label="Restore selected values" onSubmit={(event) => void review(event)}>
          <p>Restoring needs history, edit and restore-values separately. Choose a stored change, the before or after side, and the fields to write. The new version uses those stored values. You cannot type a replacement.</p>
          <label>
            Change{" "}
            <select value={eventId} disabled={busy || uncertain} onChange={(event) => chooseEvent(event.target.value)}>
              <option value="">Select a change</option>
              {events.map((event) => <option key={event.id} value={event.id}>{event.kind} · version {event.version} · {event.at} UTC</option>)}
            </select>
          </label>
          <fieldset>
            <legend>Stored side</legend>
            <label className="record-check"><input type="radio" name={`history-side-${recordId}`} value="before" checked={side === "before"} disabled={!selected?.before || busy || uncertain} onChange={() => chooseSide("before")} /> Before</label>
            <label className="record-check"><input type="radio" name={`history-side-${recordId}`} value="after" checked={side === "after"} disabled={!selected || busy || uncertain} onChange={() => chooseSide("after")} /> After</label>
          </fieldset>
          <fieldset>
            <legend>Fields</legend>
            {choices.length ? choices.map((choice) => <label className="record-check" key={choice.key}><input type="checkbox" checked={fieldsToRestore.includes(choice.key)} disabled={busy || uncertain} onChange={() => toggle(choice.key)} /> {choice.label}</label>) : <p>Select a change with a stored side. Only the name and current writable history fields can be restored.</p>}
          </fieldset>
          <button disabled={busy || uncertain || !request || !!pinned}>Review selected values</button>
          {pinned && (
            <section aria-label="Restore review">
              <p>Version {pinned.sourceVersion} supplies the stored values. The record is currently version {pinned.expectedVersion}.</p>
              <ReviewValues title="Current value" name={pinned.before.name} values={pinned.before.values} keys={pinned.fields} fields={fields} />
              <ReviewValues title="Value to write" name={pinned.after.name} values={pinned.after.values} keys={pinned.fields} fields={fields} />
              <label className="record-check"><input type="checkbox" checked={confirmed} disabled={busy} onChange={(event) => setConfirmed(event.target.checked)} /> Restore these selected values as a new version</label>
              <button type="button" disabled={busy || !confirmed} onClick={() => void apply()}>{uncertain ? "Retry the same restore" : "Restore selected values"}</button>
            </section>
          )}
        </form>
      ) : <p>Restoring selected values also needs edit and restore-values on this record.</p>}
    </section>
  );
}
