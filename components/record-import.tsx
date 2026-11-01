"use client";
import { FormEvent, useEffect, useRef, useState } from "react";
import ImportMappingProfiles from "./import-mapping-profiles";
import type { PositionalImportMapping } from "../lib/import-mapping-profile";
import {
  acceptedImport,
  buildImportMapping,
  importCommitBody,
  importCommitKeepsCommand,
  importRequestError,
  recordImportMetadata,
  recordImportSourceLimit,
  RecordImportRequestError,
  type ImportCommitChoices,
  type ImportFieldDraft,
  type ImportFieldInput,
  type ImportJobView,
  type ImportMappingMode,
  type ImportPreviewRow,
} from "../lib/record-import-contract";

const emptyDraft = (): ImportFieldDraft => ({ column: "", lookup: "id", currencyCode: "", currencyScale: "" });
const emptyChoices = (): ImportCommitChoices => ({ allowValidSubset: false, allowDuplicates: false, acknowledgeWarnings: false });

function showValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value.length > 200 ? `${value.slice(0, 200)}…` : value;
  if (typeof value === "boolean" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(showValue).join(", ");
  if (typeof value === "object") {
    const currency = value as { currency?: string; minorUnits?: string; scale?: number };
    if (currency.currency && currency.minorUnits) return `${currency.currency} ${currency.minorUnits} scale ${currency.scale ?? ""}`.trim();
  }
  return "";
}

function guidance(error: RecordImportRequestError) {
  if (error.code === "record_schema_conflict") return "Schema or policy changed. Remaining rows need a separate review. This screen leaves them unchanged.";
  if (error.code === "record_import_authority_changed") return "Earlier rows may have committed. Retry this same command after checking the import.";
  if (error.code === "record_import_limit") return "Finish or cancel an active import before staging another. A job opened in another session stays in that session until it expires.";
  return "";
}

export default function RecordImport({
  workspaceId,
  tenantId,
  collection,
  canCreate,
  canManageSharedProfiles = false,
  fields,
  onCommitted,
}: {
  workspaceId: string;
  tenantId: string;
  collection: string;
  canCreate: boolean;
  canManageSharedProfiles?: boolean;
  fields: ImportFieldInput[];
  onCommitted?: () => void;
}) {
  const root = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/tenants/${encodeURIComponent(tenantId)}/record-imports`;
  const fieldKeys = fields.map((field) => field.key);
  const fieldSignature = fieldKeys.join("\n");
  const [file, setFile] = useState<File | null>(null);
  const [sheetIndex, setSheetIndex] = useState("");
  const [mode, setMode] = useState<ImportMappingMode>(canCreate ? "create" : "update");
  const [nameColumn, setNameColumn] = useState("");
  const [idColumn, setIdColumn] = useState("");
  const [parentColumn, setParentColumn] = useState("");
  const [legalColumn, setLegalColumn] = useState("");
  const [accountColumn, setAccountColumn] = useState("");
  const [drafts, setDrafts] = useState<Record<string, ImportFieldDraft>>({});
  const [savedMapping, setSavedMapping] = useState("");
  const [job, setJob] = useState<ImportJobView | null>(null);
  const [rows, setRows] = useState<ImportPreviewRow[]>([]);
  const [nextOffset, setNextOffset] = useState<number | null>(null);
  const [choices, setChoices] = useState<ImportCommitChoices>(emptyChoices);
  const [commandHold, setCommandHold] = useState<{ id: string; body: string } | null>(null);
  const [commandUncertain, setCommandUncertain] = useState(false);
  const [cancelConfirmed, setCancelConfirmed] = useState(false);
  const [cancelVersion, setCancelVersion] = useState<number | null>(null);
  const [stageUncertain, setStageUncertain] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const intent = useRef<{ id: string; name: string; format: "csv" | "xlsx"; sheetIndex?: number } | null>(null);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; };
  }, []);
  useEffect(() => {
    if (!canCreate) setMode("update");
  }, [canCreate]);
  useEffect(() => {
    setDrafts((current) => {
      const keys = fieldSignature ? fieldSignature.split("\n") : [];
      if (keys.length === Object.keys(current).length && keys.every((key) => current[key])) return current;
      const next: Record<string, ImportFieldDraft> = {};
      for (const key of keys) next[key] = current[key] ?? emptyDraft();
      return next;
    });
  }, [fieldSignature]);

  const draft = job ? buildImportMapping({
    mode,
    collection,
    canCreate,
    headerCount: job.headers.length,
    nameColumn,
    idColumn,
    parentOrganisationColumn: parentColumn,
    legalOrganisationColumn: legalColumn,
    accountColumn: accountColumn,
    fields,
    drafts,
  }) : { ok: false as const, message: "Stage a source before mapping columns." };
  const draftKey = draft.ok ? JSON.stringify(draft.mapping) : "";
  const mappingDirty = !savedMapping || draftKey !== savedMapping;
  const locked = busy || !!commandHold || cancelVersion !== null;
  const editable = !!job && job.counts.applied === 0 && ["staged", "reviewing", "reviewed"].includes(job.state);
  const visibleDuplicate = rows.some((row) => row.duplicateWarning);
  const needsSubset = !!job && job.counts.invalid > 0 && !choices.allowValidSubset;
  const needsWarnings = !!job && job.warnings.length > 0 && !choices.acknowledgeWarnings;
  const needsDuplicates = visibleDuplicate && !choices.allowDuplicates;
  const hasWork = !!job && (job.counts.valid > 0 || job.counts.blocked > 0);
  const canCommit = !!job?.reviewHash && !!job.mode && ["reviewed", "running", "partial"].includes(job.state) && (commandHold !== null || (!mappingDirty && !needsSubset && !needsWarnings && !needsDuplicates && hasWork));

  function applyJob(next: ImportJobView, append = false) {
    setJob(next);
    if (next.rows) {
      setRows((current) => append ? [...current, ...next.rows!] : next.rows!);
      setNextOffset(next.nextOffset);
    }
  }
  async function readJob(response: Response) {
    if (!response.ok) throw await importRequestError(response);
    const next = acceptedImport(await response.json(), fieldKeys);
    if (!next) throw new RecordImportRequestError("The import response was incomplete.", 502, "record_import_unavailable", true);
    return next;
  }
  async function stage() {
    if (!file || locked) return;
    const format = /\.csv$/i.test(file.name) ? "csv" as const : /\.xlsx$/i.test(file.name) ? "xlsx" as const : null;
    if (!format || !file.size || file.size > recordImportSourceLimit) {
      setError("Choose one non-empty .csv or .xlsx file of at most 20 MiB.");
      return;
    }
    let sheet: number | undefined;
    if (format === "xlsx" && sheetIndex.trim()) {
      if (!/^\d+$/.test(sheetIndex.trim()) || Number(sheetIndex) > 99) {
        setError("Choose a visible worksheet from 0 to 99, or leave the worksheet blank.");
        return;
      }
      sheet = Number(sheetIndex.trim());
    }
    intent.current ??= { id: crypto.randomUUID(), name: file.name, format, ...(sheet !== undefined ? { sheetIndex: sheet } : {}) };
    setBusy(true);
    setError("");
    setNotice("");
    setStageUncertain(true);
    try {
      const response = await fetch(root, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/octet-stream", "x-hs-record-import": recordImportMetadata({ ...intent.current, collection }) },
        body: file,
      });
      const next = await readJob(response);
      if (!alive.current) return;
      applyJob(next);
      setRows([]);
      setNextOffset(null);
      setSavedMapping("");
      setChoices(emptyChoices());
      setStageUncertain(false);
      if (mode === "create") setNameColumn((current) => current || "0");
      if (mode === "update") setIdColumn((current) => current || "0");
      setNotice("Source staged. Records stay unchanged until a reviewed batch is committed.");
    } catch (reason) {
      if (!alive.current) return;
      const requestError = reason instanceof RecordImportRequestError ? reason : null;
      if (requestError && requestError.status < 500) {
        setStageUncertain(false);
        intent.current = null;
      }
      setError(requestError ? `${requestError.message} ${guidance(requestError)}`.trim() : "Staging was not confirmed. Keep this file selected and retry.");
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function saveMapping(event: FormEvent) {
    event.preventDefault();
    if (!job || !draft.ok || !editable || locked) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`${root}/${encodeURIComponent(job.id)}`, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "configure", expectedVersion: job.version, mapping: draft.mapping }),
      });
      const next = await readJob(response);
      if (!alive.current) return;
      applyJob({ ...next, rows: null });
      setRows([]);
      setNextOffset(null);
      setSavedMapping(JSON.stringify(draft.mapping));
      setChoices(emptyChoices());
      setNotice("Mapping saved. Review the next 100 rows before committing.");
    } catch (reason) {
      if (alive.current) setError(reason instanceof Error ? `${reason.message} ${reason instanceof RecordImportRequestError ? guidance(reason) : ""}`.trim() : "The mapping was not saved.");
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function reviewBatch() {
    if (!job || mappingDirty || job.state !== "reviewing" || locked) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`${root}/${encodeURIComponent(job.id)}`, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "review", expectedVersion: job.version }),
      });
      const next = await readJob(response);
      if (!alive.current) return;
      applyJob(next);
      setNotice(next.state === "reviewed" ? "Review is complete. Choose what to commit." : `Reviewed ${next.reviewOffset} of ${next.rowCount} data rows.`);
      await loadPreview(next.id, 0);
    } catch (reason) {
      if (alive.current) setError(reason instanceof Error ? `${reason.message} ${reason instanceof RecordImportRequestError ? guidance(reason) : ""}`.trim() : "The review batch was not confirmed.");
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function loadPreview(jobId: string, offset: number) {
    const response = await fetch(`${root}/${encodeURIComponent(jobId)}?offset=${offset}`, { credentials: "same-origin", cache: "no-store" });
    const next = await readJob(response);
    if (!alive.current) return;
    applyJob(next, offset > 0);
  }
  async function commit(event: FormEvent) {
    event.preventDefault();
    if (!job || !canCommit || busy) return;
    const hold = commandHold ?? (() => {
      const id = crypto.randomUUID();
      const body = importCommitBody(job, id, choices);
      return body ? { id, body: JSON.stringify(body) } : null;
    })();
    if (!hold) return;
    setCommandHold(hold);
    setBusy(true);
    setError("");
    setNotice("");
    setCommandUncertain(true);
    try {
      const response = await fetch(`${root}/${encodeURIComponent(job.id)}`, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: hold.body,
      });
      const next = await readJob(response);
      if (!alive.current) return;
      const blockedStop = next.state === "partial" && next.counts.blocked > 0;
      applyJob(next);
      if (next.state === "cancelled") {
        setCommandHold(null);
        setCommandUncertain(false);
        setNotice("The import is cancelled. Records already committed stay.");
      } else if (blockedStop) {
        setCommandUncertain(true);
        setError(`Applied ${next.counts.applied}. Blocked ${next.counts.blocked}. Retry this same command to resume it.`);
      } else {
        setCommandHold(null);
        setCommandUncertain(false);
        setNotice(`Applied ${next.counts.applied}. Blocked ${next.counts.blocked}. Invalid ${next.counts.invalid}.`);
      }
      onCommitted?.();
    } catch (reason) {
      if (!alive.current) return;
      const requestError = reason instanceof RecordImportRequestError ? reason : new RecordImportRequestError("The commit response was not confirmed.", 503, "service_unavailable", true);
      const keep = importCommitKeepsCommand(requestError) || !(reason instanceof RecordImportRequestError);
      setCommandUncertain(keep);
      if (!keep) setCommandHold(null);
      setError(`${requestError.message} ${guidance(requestError)} ${keep ? "Retry this same command. It does not start another batch." : ""}`.trim());
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  function resetSource() {
    intent.current = null;
    setJob(null);
    setFile(null);
    setRows([]);
    setNextOffset(null);
    setSavedMapping("");
    setChoices(emptyChoices());
    setCommandHold(null);
    setCommandUncertain(false);
    setCancelConfirmed(false);
    setCancelVersion(null);
    setStageUncertain(false);
    setSheetIndex("");
    setNameColumn("");
    setIdColumn("");
    setParentColumn("");
    setLegalColumn("");
    setAccountColumn("");
    setDrafts((current) => Object.fromEntries(Object.keys(current).map((key) => [key, emptyDraft()])));
    setError("");
    setNotice("");
  }
  async function cancel() {
    if (!job) return;
    const expectedVersion = cancelVersion ?? job.version;
    setCancelVersion(expectedVersion);
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(`${root}/${encodeURIComponent(job.id)}`, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "cancel", expectedVersion }),
      });
      const next = await readJob(response);
      if (!alive.current) return;
      applyJob(next);
      setCancelVersion(null);
      setCommandHold(null);
      setCommandUncertain(false);
      setNotice("Import cancelled. Records already committed stay.");
    } catch (reason) {
      if (!alive.current) return;
      const requestError = reason instanceof RecordImportRequestError ? reason : null;
      if (requestError && requestError.status < 500 && requestError.code !== "service_unavailable") setCancelVersion(null);
      setError(requestError ? `${requestError.message} Refresh the import if cancellation already finished.` : "Cancellation was not confirmed. Retry it.");
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function morePreview(offset: number) {
    if (!job || busy) return;
    setBusy(true);
    setError("");
    try {
      await loadPreview(job.id, offset);
    } catch (reason) {
      if (alive.current) setError(reason instanceof Error ? reason.message : "The next preview page could not be loaded.");
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function refresh() {
    if (!job || busy) return;
    setBusy(true);
    setError("");
    try {
      await loadPreview(job.id, 0);
    } catch (reason) {
      if (alive.current) setError(reason instanceof Error ? reason.message : "The import could not be refreshed.");
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  async function downloadReport() {
    if (!job || busy) return;
    setBusy(true);
    setError("");
    try {
      const response = await fetch(`${root}/${encodeURIComponent(job.id)}/report`, { credentials: "same-origin", cache: "no-store" });
      if (!response.ok) throw await importRequestError(response);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "record-import-report.csv";
      document.body.append(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (reason) {
      if (alive.current) setError(reason instanceof Error ? reason.message : "The error report could not be downloaded.");
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  function applyProfileMapping(mapping: PositionalImportMapping) {
    setMode(mapping.mode);
    setNameColumn(mapping.nameColumn === undefined ? "" : String(mapping.nameColumn));
    setIdColumn(mapping.idColumn === undefined ? "" : String(mapping.idColumn));
    setParentColumn(mapping.parentOrganisationColumn === undefined ? "" : String(mapping.parentOrganisationColumn));
    setLegalColumn(mapping.legalOrganisationColumn === undefined ? "" : String(mapping.legalOrganisationColumn));
    setAccountColumn(mapping.accountColumn === undefined ? "" : String(mapping.accountColumn));
    setDrafts((current) => {
      const next: Record<string, ImportFieldDraft> = {};
      for (const key of Object.keys(current)) next[key] = emptyDraft();
      for (const field of mapping.fields) next[field.fieldKey] = { column: String(field.column), lookup: field.referenceLookup ?? "id", currencyCode: field.currency?.code ?? "", currencyScale: field.currency ? String(field.currency.scale) : "" };
      return next;
    });
    setSavedMapping("");
    setNotice("Profile applied to the mapping draft. Records stay unchanged until you save the mapping and commit a reviewed batch.");
  }
  function updateDraft(key: string, patch: Partial<ImportFieldDraft>) {
    setDrafts((current) => ({ ...current, [key]: { ...(current[key] ?? emptyDraft()), ...patch } }));
  }
  const labelFor = (key: string) => fields.find((field) => field.key === key)?.label ?? "Field";

  return (
    <section aria-label="Import records">
      <h2>Import records</h2>
      <p>Current collection view and import permission are required. Create, edit, link, and each field read or write right are checked separately when a row is reviewed and committed. Columns map by position onto fields you can already write. This import does not create fields.</p>
      <p>Updates address records by immutable HS ID and the version pinned during review. Relationship changes and approved-unique-key matching stay in their own workflows. An empty mapped optional cell clears that value. An unmapped update field stays as it is. A required blank is rejected. False and zero remain valid values.</p>
      <p>One UTF-8 CSV or non-macro XLSX file, up to 20 MiB, 10,000 data rows, 100 columns and 20,000 characters per cell. Excel uses the selected visible worksheet, with 1900 and 1904 dates. Formulas are never evaluated. Cached formula values need warning acknowledgement, and a missing cache becomes a row error. Staging is private to you and this workspace for about 24 hours. The original file is not kept. Two active imports are allowed. Expired staging is removed by operator maintenance.</p>
      <p>Review checks the current schema, permissions, uniqueness, typed values and required same-tenant relationships in batches of 100 rows. Records stay unchanged until you commit. Each commit writes at most 100 valid rows, together with the ledger and protected event. A lost response retries that same command.</p>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {!job && (
        <>
          <label>
            Source file{" "}
            <input
              type="file"
              accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              disabled={locked || stageUncertain}
              onChange={(event) => {
                const selected = event.target.files?.[0] ?? null;
                intent.current = null;
                setError("");
                setStageUncertain(false);
                if (selected && (!/\.(csv|xlsx)$/i.test(selected.name) || !selected.size || selected.size > recordImportSourceLimit)) {
                  setFile(null);
                  setError("Choose one non-empty .csv or .xlsx file of at most 20 MiB.");
                  return;
                }
                setFile(selected);
              }}
            />
          </label>
          {file && /\.xlsx$/i.test(file.name) && (
            <label>
              Worksheet index{" "}
              <input inputMode="numeric" value={sheetIndex} disabled={locked || stageUncertain} onChange={(event) => { setSheetIndex(event.target.value); intent.current = null; }} placeholder="Blank uses the selected visible worksheet" />
            </label>
          )}
          <button type="button" disabled={locked || !file} onClick={() => void stage()}>{stageUncertain ? "Retry staging" : "Stage import"}</button>
          {stageUncertain && <p role="status">Staging was not confirmed. Retry the same file before choosing another source.</p>}
        </>
      )}
      {job && (
        <>
          <p>{job.name} · {job.format.toUpperCase()} · {job.rowCount} data rows · {job.headers.length} columns · version {job.version} · {job.state}</p>
          <p>Private staging expires {job.expiresAt}. Reviewed {job.reviewOffset} of {job.rowCount}.</p>
          <p>Unreviewed {job.counts.unreviewed}. Valid {job.counts.valid}. Invalid {job.counts.invalid}. Applied {job.counts.applied}. Blocked {job.counts.blocked}.</p>
          {!!job.warnings.length && (
            <ul aria-label="Source warnings">
              {job.warnings.map((warning) => <li key={warning}>{warning}</li>)}
            </ul>
          )}
          <form aria-label="Import mapping" onSubmit={saveMapping}>
            <label>
              Import mode{" "}
              <select aria-label="Import mode" value={mode} disabled={!editable || locked} onChange={(event) => setMode(event.target.value as ImportMappingMode)}>
                <option value="create" disabled={!canCreate}>Create records</option>
                <option value="update">Update records by immutable ID</option>
              </select>
            </label>
            {!canCreate && <p>Create needs the create capability. Update still checks edit on each target record.</p>}
            <ColumnSelect label="Name column" value={nameColumn} headers={job.headers} optional={mode === "update"} disabled={!editable || locked} onChange={setNameColumn} />
            {mode === "update" && <ColumnSelect label="Record ID column" value={idColumn} headers={job.headers} disabled={!editable || locked} onChange={setIdColumn} />}
            {mode === "create" && collection === "accounts" && <ColumnSelect label="Parent organisation column" value={parentColumn} headers={job.headers} disabled={!editable || locked} onChange={setParentColumn} />}
            {mode === "create" && collection === "contracts" && (
              <>
                <ColumnSelect label="Legal organisation column" value={legalColumn} headers={job.headers} disabled={!editable || locked} onChange={setLegalColumn} />
                <ColumnSelect label="Covered account column" value={accountColumn} headers={job.headers} optional disabled={!editable || locked} onChange={setAccountColumn} />
              </>
            )}
            {fields.map((field) => {
              const draftField = drafts[field.key] ?? emptyDraft();
              return (
                <fieldset key={field.key} aria-label={`Map ${field.label}`}>
                  <legend>{field.label}</legend>
                  <ColumnSelect label={`Column for ${field.label}`} value={draftField.column} headers={job.headers} optional disabled={!editable || locked} onChange={(value) => updateDraft(field.key, { column: value })} />
                  {field.referenceList && draftField.column && (
                    <label>
                      Reference identity{" "}
                      <select aria-label={`Reference identity for ${field.label}`} value={draftField.lookup} disabled={!editable || locked} onChange={(event) => updateDraft(field.key, { lookup: event.target.value as ImportFieldDraft["lookup"] })}>
                        <option value="id">Immutable ID</option>
                        <option value="code">Code</option>
                        <option value="label">Label</option>
                      </select>
                    </label>
                  )}
                  {field.kind === "currency" && draftField.column && (
                    <>
                      <label>Currency code <input aria-label={`Currency code for ${field.label}`} value={draftField.currencyCode} maxLength={3} disabled={!editable || locked} onChange={(event) => updateDraft(field.key, { currencyCode: event.target.value.toUpperCase() })} placeholder="Blank uses a portable currency cell" /></label>
                      <label>Currency scale <input aria-label={`Currency scale for ${field.label}`} inputMode="numeric" value={draftField.currencyScale} maxLength={1} disabled={!editable || locked} onChange={(event) => updateDraft(field.key, { currencyScale: event.target.value })} /></label>
                    </>
                  )}
                </fieldset>
              );
            })}
            {!fields.length && <p>No writable fields are available. Name and the required relationship columns can still be mapped.</p>}
            {!draft.ok && editable && <p role="status">{draft.message}</p>}
            {mappingDirty && savedMapping && <p>Save the mapping before review or commit.</p>}
            <button disabled={!editable || locked || !draft.ok || (!!savedMapping && !mappingDirty)}>Save mapping</button>
          </form>
          <ImportMappingProfiles
            workspaceId={workspaceId}
            tenantId={tenantId}
            collection={collection}
            jobId={job.id}
            mapping={draft.ok ? draft.mapping : null}
            canManageShared={canManageSharedProfiles}
            disabled={!editable || locked}
            onUseMapping={applyProfileMapping}
          />
          {job.state === "reviewing" && <button type="button" disabled={locked || mappingDirty} onClick={() => void reviewBatch()}>Review next 100 rows</button>}
          {!!rows.length && (
            <table aria-label="Import preview">
              <caption>Preview rechecks current access. Hidden values are omitted.</caption>
              <thead>
                <tr>
                  <th scope="col">Source row</th>
                  <th scope="col">Status</th>
                  <th scope="col">Duplicate</th>
                  <th scope="col">Issue codes</th>
                  <th scope="col">Proposed name</th>
                  <th scope="col">Permitted values</th>
                  <th scope="col">Record</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.ordinal}>
                    <td>{row.sourceRow}</td>
                    <td>{row.state}</td>
                    <td>{row.duplicateWarning ? "Visible duplicate" : ""}</td>
                    <td>{row.errors.map((issue) => issue.fieldKey ? `${labelFor(issue.fieldKey)} ${issue.code}` : issue.code).join(", ")}</td>
                    <td>{row.name ? showValue(row.name) : ""}</td>
                    <td>{row.values ? Object.entries(row.values).map(([key, value]) => `${labelFor(key)}: ${showValue(value)}`).join("; ") : ""}</td>
                    <td>{row.recordId ? `${row.recordId}${row.appliedVersion ? ` · version ${row.appliedVersion}` : ""}` : ""}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {nextOffset !== null && <button type="button" disabled={locked} onClick={() => void morePreview(nextOffset)}>Load 50 more preview rows</button>}
          {job.reviewHash && ["reviewed", "running", "partial"].includes(job.state) && (
            <form aria-label="Commit import" onSubmit={commit}>
              <p>Committing uses the saved {job.mode} mapping. Invalid rows, visible duplicates and source warnings need an explicit choice. This command covers at most 100 valid rows.</p>
              <label className="record-check"><input type="checkbox" checked={choices.allowValidSubset} disabled={locked} onChange={(event) => setChoices((current) => ({ ...current, allowValidSubset: event.target.checked }))} /> Import the valid rows and leave invalid rows uncommitted</label>
              <label className="record-check"><input type="checkbox" checked={choices.allowDuplicates} disabled={locked} onChange={(event) => setChoices((current) => ({ ...current, allowDuplicates: event.target.checked }))} /> Allow visible duplicate warnings</label>
              <label className="record-check"><input type="checkbox" checked={choices.acknowledgeWarnings} disabled={locked} onChange={(event) => setChoices((current) => ({ ...current, acknowledgeWarnings: event.target.checked }))} /> Acknowledge source conversion warnings</label>
              {needsSubset && <p>Invalid rows are present. Choose the valid subset before committing.</p>}
              {needsDuplicates && <p>This page includes a visible duplicate warning. Allow it before committing. The import also checks warnings on rows that are not on this page.</p>}
              {needsWarnings && <p>Acknowledge the source conversion warnings before committing.</p>}
              {!hasWork && job.counts.blocked === 0 && <p>No valid rows are ready to commit.</p>}
              {commandUncertain && <p role="status">The commit response was not confirmed. Retry this same command before starting another batch.</p>}
              <button disabled={busy || !canCommit}>{commandUncertain ? "Retry this import command" : job.mode === "create" ? "Commit reviewed creates" : "Commit reviewed updates"}</button>
            </form>
          )}
          <button type="button" disabled={busy} onClick={() => void refresh()}>Refresh import</button>
          <button type="button" disabled={busy} onClick={() => void downloadReport()}>Download error report</button>
          {job.state !== "completed" && job.state !== "cancelled" && (
            <>
              <label className="record-check"><input type="checkbox" checked={cancelConfirmed} disabled={busy || !!commandHold} onChange={(event) => setCancelConfirmed(event.target.checked)} /> Cancel this import. Records already committed stay.</label>
              <button type="button" disabled={busy || (!cancelConfirmed && cancelVersion === null) || !!commandHold} onClick={() => void cancel()}>{cancelVersion !== null && !busy ? "Retry cancellation" : "Cancel import"}</button>
            </>
          )}
          {(job.state === "cancelled" || job.state === "completed") && <button type="button" disabled={busy} onClick={resetSource}>Stage another import</button>}
          {job.state === "cancelled" && <p>This import is cancelled. Records already committed stay.</p>}
          {job.state === "completed" && <p>This import is complete. A later schema or version change for any remaining row needs a separate review.</p>}
        </>
      )}
    </section>
  );
}

function ColumnSelect({ label, value, headers, optional = false, disabled, onChange }: { label: string; value: string; headers: string[]; optional?: boolean; disabled: boolean; onChange: (value: string) => void }) {
  return (
    <label>
      {label}{" "}
      <select aria-label={label} value={value} disabled={disabled} onChange={(event) => onChange(event.target.value)}>
        {optional && <option value="">Not mapped</option>}
        {!optional && !value && <option value="">Choose a column</option>}
        {headers.map((header, index) => <option key={`${index}-${header}`} value={String(index)}>{index + 1}. {header}</option>)}
      </select>
    </label>
  );
}
