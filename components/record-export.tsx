"use client";
import { FormEvent, useEffect, useRef, useState } from "react";
import {
  acceptedExport,
  acceptedExportCancellation,
  explicitExportColumns,
  exportDownloadBody,
  exportPrepareBody,
  exportPrepareRetiresId,
  exportRequestError,
  isRecordExportId,
  recordExportRecordLimit,
  recordExportScope,
  RecordExportRequestError,
  relationshipColumnCount,
  viewExportScope,
  withheldReferenceFields,
  type ExportFieldInput,
  type ExportFormat,
  type ExportJobView,
} from "../lib/record-export-contract";

type ExportView = { id: string; name: string; version: number; columns: string[] };
type ExportRecord = { id: string; name: string };

function relationshipLabel(collection: string) {
  if (collection === "accounts") return "Include the parent organisation ID";
  if (collection === "contracts") return "Include legal organisation and covered account IDs";
  if (collection === "contacts" || collection === "employees") return "Include account IDs";
  return "";
}

function warningText(code: string) {
  if (code === "csv-spreadsheet-text-escaping") return "CSV text that a spreadsheet could read as a formula is prefixed with an apostrophe, including leading whitespace and control prefixes. Typed negative numbers stay numbers.";
  return code;
}

function guidance(error: RecordExportRequestError) {
  if (error.code === "record_export_ack_required") return "Acknowledge spreadsheet-safe CSV text escaping before downloading.";
  if (error.code === "record_export_reference_unavailable") return "A column needs a qualified reference read that is not configured. Export chosen records without attachment or record fields, or remove that column from the saved view.";
  if (error.code === "record_export_limit") return "Finish or cancel an active export before preparing another. A job opened in another session stays in that session until it expires.";
  if (error.code === "record_export_expired" || error.code === "record_export_cancelled") return "Prepare a new export. This snapshot is no longer available.";
  if (error.code === "record_export_conflict" || error.code === "record_export_field_unavailable") return "Schema, policy, or a selected field changed. Prepare a fresh export.";
  return "";
}

export default function RecordExport({
  workspaceId,
  tenantId,
  collection,
  schemaVersion,
  view,
  records,
  fields,
}: {
  workspaceId: string;
  tenantId: string;
  collection: string;
  schemaVersion: number;
  view: ExportView | null;
  records: ExportRecord[];
  fields: ExportFieldInput[];
}) {
  const root = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/tenants/${encodeURIComponent(tenantId)}/record-exports`;
  const [preferRecords, setPreferRecords] = useState(false);
  const [format, setFormat] = useState<ExportFormat>("csv");
  const [includeIds, setIncludeIds] = useState(false);
  const [includeRelationships, setIncludeRelationships] = useState(false);
  const [columnChoice, setColumnChoice] = useState<string[]>(["name"]);
  const [chosen, setChosen] = useState<string[]>([]);
  const [job, setJob] = useState<{ key: string; view: ExportJobView } | null>(null);
  const [pendingKey, setPendingKey] = useState("");
  const [ackHash, setAckHash] = useState("");
  const [cancelFor, setCancelFor] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const intent = useRef<{ key: string; id: string } | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);

  const mode = view && !preferRecords ? "view" : "records";
  const catalogue = explicitExportColumns(fields);
  const allowed = new Set(catalogue.map((column) => column.key));
  const columns = catalogue.map((column) => column.key).filter((key) => columnChoice.includes(key) && allowed.has(key));
  const seen = new Set<string>();
  const visible: ExportRecord[] = [];
  for (const record of records) {
    if (!isRecordExportId(record.id) || seen.has(record.id)) continue;
    seen.add(record.id);
    visible.push(record);
  }
  const chosenSet = new Set(chosen);
  const recordIds = visible.filter((record) => chosenSet.has(record.id)).map((record) => record.id);
  const relationships = relationshipColumnCount(collection) > 0 && includeRelationships;
  const scope = mode === "view"
    ? view ? viewExportScope({ collection, viewId: view.id, expectedViewVersion: view.version, viewColumnCount: view.columns.length, expectedSchemaVersion: schemaVersion, format, includeIds, includeRelationships: relationships }) : null
    : recordExportScope({ collection, recordIds, columns, allowedColumns: catalogue.map((column) => column.key), expectedSchemaVersion: schemaVersion, format, includeIds, includeRelationships: relationships });
  const scopeKey = scope ? JSON.stringify(scope) : "";
  const scopeKeyRef = useRef(scopeKey);
  scopeKeyRef.current = scopeKey;
  const prepared = job?.key === scopeKey ? job.view : null;
  const uncertain = pendingKey === scopeKey && scopeKey !== "";
  const acknowledged = !!prepared && ackHash === prepared.reviewHash;
  const downloadBody = prepared ? exportDownloadBody(prepared, acknowledged) : null;
  const cancelConfirmed = !!prepared && cancelFor === prepared.id;
  const withheld = withheldReferenceFields(fields);
  const viewWithheld = view ? withheld.filter((field) => view.columns.includes(field.key)) : [];
  const hint = scope ? "" : mode === "view"
    ? view ? "This saved view cannot be exported with the selected ID options. A view needs columns, and the total including optional IDs stays within 100." : "Choose a saved view, or export chosen records."
    : recordIds.length === 0 ? "Choose at least one loaded record."
      : columns.length === 0 ? "Choose at least one column."
        : "Optional IDs make this export wider than 100 columns.";

  function idFor(key: string) {
    if (!intent.current || intent.current.key !== key) intent.current = { key, id: crypto.randomUUID() };
    return intent.current.id;
  }
  function retire(key: string) {
    if (intent.current?.key === key) intent.current = null;
  }
  function toggleColumn(key: string) {
    setColumnChoice((current) => current.includes(key) ? current.filter((item) => item !== key) : [...current, key]);
  }
  function toggleRecord(id: string) {
    setChosen((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  }
  function selectVisible() {
    const ids: string[] = [];
    for (const record of visible) {
      ids.push(record.id);
      if (ids.length >= recordExportRecordLimit) break;
    }
    setChosen(ids);
  }
  async function readJob(response: Response) {
    if (!response.ok) throw await exportRequestError(response);
    const next = acceptedExport(await response.json());
    if (!next) throw new RecordExportRequestError("The export response was incomplete.", 502, "record_export_unavailable", true);
    return next;
  }
  async function prepare(event?: FormEvent) {
    event?.preventDefault();
    const key = scopeKey;
    if (!scope || !key || busy || (prepared && !uncertain)) return;
    const body = exportPrepareBody(idFor(key), scope);
    if (!body) return;
    setBusy(true);
    setError("");
    setNotice("");
    setPendingKey(key);
    try {
      const response = await fetch(root, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const next = await readJob(response);
      if (!alive.current || scopeKeyRef.current !== key) return;
      setPendingKey("");
      setJob({ key, view: next });
      setNotice("Snapshot pinned for fifteen minutes. Later edits stay out of this file until you cancel it and prepare again.");
    } catch (reason) {
      if (!alive.current || scopeKeyRef.current !== key) return;
      const requestError = reason instanceof RecordExportRequestError ? reason : null;
      if (!requestError || requestError.status < 500) setPendingKey("");
      if (requestError && exportPrepareRetiresId(requestError)) retire(key);
      const retry = requestError && requestError.status >= 500 ? "Retry the same scope." : "";
      setError(requestError ? `${requestError.message} ${guidance(requestError)} ${retry}`.replace(/\s+/g, " ").trim() : "The export was not confirmed. Retry the same scope.");
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function refresh() {
    if (!prepared || busy) return;
    const key = scopeKey;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`${root}/${encodeURIComponent(prepared.id)}`, { credentials: "same-origin", cache: "no-store" });
      const next = await readJob(response);
      if (!alive.current || scopeKeyRef.current !== key) return;
      if (next.id !== prepared.id) throw new RecordExportRequestError("The export response was incomplete.", 502, "record_export_unavailable", true);
      setJob({ key, view: next });
    } catch (reason) {
      if (!alive.current) return;
      const requestError = reason instanceof RecordExportRequestError ? reason : null;
      if (requestError && [403, 404, 409, 410].includes(requestError.status)) {
        retire(key);
        setJob(null);
      }
      setError(requestError ? `${requestError.message} ${guidance(requestError)}`.trim() : "The preview could not be refreshed.");
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function download() {
    if (!prepared || !downloadBody || busy) return;
    const key = scopeKey;
    const current = prepared;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`${root}/${encodeURIComponent(current.id)}/download`, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(downloadBody),
      });
      if (!response.ok) throw await exportRequestError(response);
      const expected = current.format === "csv" ? "text/csv" : "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
      if (!response.headers.get("content-type")?.startsWith(expected)) throw new RecordExportRequestError("The export file did not match this snapshot.", 502, "record_export_unavailable", true);
      const blob = await response.blob();
      if (!alive.current || scopeKeyRef.current !== key) return;
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `holy-sheet-records.${current.format}`;
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setNotice("Download started. The same pinned snapshot can be downloaded again until it expires.");
    } catch (reason) {
      if (!alive.current) return;
      const requestError = reason instanceof RecordExportRequestError ? reason : null;
      if (requestError && [403, 404, 409, 410].includes(requestError.status)) {
        retire(key);
        setJob(null);
      }
      setError(requestError ? `${requestError.message} ${guidance(requestError)}`.trim() : "The export file could not be downloaded.");
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function cancel() {
    if (!prepared || !cancelConfirmed || busy) return;
    const key = scopeKey;
    const id = prepared.id;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`${root}/${encodeURIComponent(id)}`, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "cancel" }),
      });
      if (!response.ok) throw await exportRequestError(response);
      const next = acceptedExportCancellation(await response.json(), id);
      if (!alive.current || scopeKeyRef.current !== key) return;
      if (!next) throw new RecordExportRequestError("Cancellation was not confirmed.", 502, "record_export_unavailable", true);
      retire(key);
      setJob(null);
      setCancelFor("");
      setNotice("Export cancelled. The pinned values were discarded.");
    } catch (reason) {
      if (!alive.current) return;
      const requestError = reason instanceof RecordExportRequestError ? reason : null;
      setError(requestError ? `${requestError.message} ${guidance(requestError)}`.trim() : "Cancellation was not confirmed. Retry it.");
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  return (
    <section aria-label="Export records">
      <h2>Export records</h2>
      <p>Current collection view and export permission are required. Create, edit and link stay in their own workflows. Each selected field is read with the current field permission when the snapshot is prepared, previewed and issued.</p>
      <p>A saved view exports its current version, filtered rows and permitted default columns. Chosen records export only the checked rows of this collection. Duplicates and mixed collections are rejected. HS IDs and core relationship IDs stay out of the file until you opt in. They do not grant access to related records.</p>
      <p>At most 10,000 records, 100 columns and a 20 MiB snapshot. Eight active exports can be open for you. The snapshot is pinned for fifteen minutes. CSV uses a UTF-8 BOM and quoted cells. XLSX uses literal typed cells, a frozen header and no formulas, links or macros. Expired snapshots are removed when operator maintenance runs. This screen does not schedule that cleanup.</p>
      {withheld.length > 0 ? <p>Attachment and record columns are omitted from a chosen-record export. No qualified reference-read authority is configured, so a saved view that includes one fails closed when an exported row has a value.</p> : null}
      {mode === "view" && viewWithheld.length > 0 ? <p>This saved view includes {viewWithheld.map((field) => field.label).join(", ")}. Prepare fails closed if a matching row has a value.</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      <form aria-label="Prepare record export" onSubmit={(event) => void prepare(event)}>
        <fieldset>
          <legend>Scope</legend>
          <label className="record-check"><input type="radio" name="export-scope" value="view" checked={mode === "view"} disabled={!view || busy} onChange={() => setPreferRecords(false)} /> Saved view{view ? ` · ${view.name} · version ${view.version}` : ""}</label>
          <label className="record-check"><input type="radio" name="export-scope" value="records" checked={mode === "records"} disabled={busy} onChange={() => setPreferRecords(true)} /> Chosen records</label>
        </fieldset>
        <label>
          Format{" "}
          <select aria-label="Export format" value={format} disabled={busy} onChange={(event) => setFormat(event.target.value as ExportFormat)}>
            <option value="csv">CSV</option>
            <option value="xlsx">Excel</option>
          </select>
        </label>
        <label className="record-check"><input type="checkbox" checked={includeIds} disabled={busy} onChange={(event) => setIncludeIds(event.target.checked)} /> Include HS record IDs</label>
        {relationshipColumnCount(collection) > 0 ? <label className="record-check"><input type="checkbox" checked={includeRelationships} disabled={busy} onChange={(event) => setIncludeRelationships(event.target.checked)} /> {relationshipLabel(collection)}</label> : null}
        {mode === "records" ? (
          <>
            <fieldset>
              <legend>Columns</legend>
              {catalogue.map((column) => (
                <label className="record-check" key={column.key}>
                  <input type="checkbox" checked={columns.includes(column.key)} disabled={busy} onChange={() => toggleColumn(column.key)} /> {column.label}
                </label>
              ))}
            </fieldset>
            <fieldset>
              <legend>Loaded records</legend>
              <p>IDs in this list are for selection. They are written to the file only when HS record IDs are included. Load more records before they can be selected.</p>
              {visible.length === 0 ? <p>No loaded records to choose.</p> : null}
              {visible.map((record) => (
                <label className="record-check" key={record.id}>
                  <input type="checkbox" checked={chosenSet.has(record.id)} disabled={busy} onChange={() => toggleRecord(record.id)} /> {record.name} · {record.id}
                </label>
              ))}
              <button type="button" disabled={busy || visible.length === 0} onClick={selectVisible}>Select loaded records</button>
              <button type="button" disabled={busy || chosen.length === 0} onClick={() => setChosen([])}>Clear selection</button>
            </fieldset>
          </>
        ) : null}
        {hint ? <p role="status">{hint}</p> : null}
        <button disabled={busy || !scope || (!!prepared && !uncertain)}>{uncertain ? "Retry prepare" : "Prepare export"}</button>
      </form>
      {prepared ? (
        <section aria-label="Pinned export">
          <p>{prepared.format.toUpperCase()} · {prepared.rowCount} {prepared.rowCount === 1 ? "record" : "records"} · {prepared.columns.length} {prepared.columns.length === 1 ? "column" : "columns"} · pinned · expires {prepared.expiresAt}</p>
          <ul aria-label="Export columns">
            {prepared.columns.map((column) => <li key={column.key}>{column.label}</li>)}
          </ul>
          {prepared.warnings.length > 0 ? (
            <ul aria-label="Export warnings">
              {prepared.warnings.map((warning) => <li key={warning}>{warningText(warning)}</li>)}
            </ul>
          ) : null}
          <p>This preview lists columns and the row count. Cell values stay in the pinned file.</p>
          {prepared.warnings.length > 0 ? (
            <label className="record-check">
              <input type="checkbox" checked={acknowledged} disabled={busy} onChange={(event) => setAckHash(event.target.checked ? prepared.reviewHash : "")} /> Acknowledge spreadsheet-safe CSV text escaping
            </label>
          ) : null}
          <button type="button" disabled={busy || !downloadBody} onClick={() => void download()}>Download {prepared.format.toUpperCase()}</button>
          <button type="button" disabled={busy} onClick={() => void refresh()}>Refresh preview</button>
          <label className="record-check"><input type="checkbox" checked={cancelConfirmed} disabled={busy} onChange={(event) => setCancelFor(event.target.checked ? prepared.id : "")} /> Cancel this pinned export</label>
          <button type="button" disabled={busy || !cancelConfirmed} onClick={() => void cancel()}>Cancel export</button>
        </section>
      ) : null}
    </section>
  );
}
