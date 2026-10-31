"use client";
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { acceptedRecordComparison, compareStatusText, compareValueText, type CompareStatus, type RecordComparison } from "../lib/record-compare-contract";

export default function RecordCompare({
  workspaceId,
  tenantId,
  recordIds,
  onClear,
}: {
  workspaceId: string;
  tenantId: string;
  recordIds: string[];
  onClear: () => void;
}) {
  const root = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/tenants/${encodeURIComponent(tenantId)}/record-compare`;
  const [open, setOpen] = useState(false);
  const [comparison, setComparison] = useState<RecordComparison | null>(null);
  const [differencesOnly, setDifferencesOnly] = useState(false);
  const [active, setActive] = useState("");
  const [busy, setBusy] = useState(false);
  const [denied, setDenied] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [reload, setReload] = useState(0);
  const openButton = useRef<HTMLButtonElement>(null);
  const differences = useRef<HTMLInputElement>(null);
  const focusDifferences = useRef(false);
  const moveFocus = useRef(false);
  const hadComparison = useRef(false);
  const selection = recordIds.join("|");

  useEffect(() => {
    if (recordIds.length < 2 && open) {
      setOpen(false);
      setComparison(null);
    }
  }, [open, recordIds.length]);

  useEffect(() => {
    if (!open || recordIds.length < 2) return;
    const abort = new AbortController();
    setBusy(true);
    setDenied(false);
    setError("");
    void (async () => {
      try {
        const response = await fetch(root, {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ recordIds }),
          signal: abort.signal,
        });
        const payload = await response.json().catch(() => null);
        if (abort.signal.aborted) return;
        if (response.status === 401 || response.status === 403 || response.status === 404) {
          setDenied(true);
          setComparison(null);
          return;
        }
        const next = acceptedRecordComparison(payload);
        if (!response.ok || !next) {
          setError("Record comparison is temporarily unavailable.");
          setComparison(null);
          return;
        }
        setNotice(hadComparison.current ? "Record comparison updated." : "");
        hadComparison.current = true;
        setComparison(next);
      } catch {
        if (!abort.signal.aborted) setError("Record comparison is temporarily unavailable.");
      } finally {
        if (!abort.signal.aborted) setBusy(false);
      }
    })();
    return () => abort.abort();
  }, [open, reload, root, selection]);

  const rows = comparison ? comparison.fields.filter((field) => !differencesOnly || field.status !== "same") : [];

  useEffect(() => {
    if (!comparison) return;
    setActive((current) => (rows.some((field) => field.key === current) ? current : rows[0]?.key ?? ""));
  }, [comparison, differencesOnly, rows.length]);

  useEffect(() => {
    if (!focusDifferences.current || busy || !comparison) return;
    focusDifferences.current = false;
    differences.current?.focus();
  }, [busy, comparison]);

  useEffect(() => {
    if (!moveFocus.current || !active) return;
    moveFocus.current = false;
    document.getElementById(`compare-field-${active}`)?.focus();
  }, [active, comparison, differencesOnly]);

  function show() {
    focusDifferences.current = true;
    setOpen(true);
  }

  function close() {
    hadComparison.current = false;
    setOpen(false);
    setComparison(null);
    setNotice("");
    setDenied(false);
    setError("");
    requestAnimationFrame(() => openButton.current?.focus());
  }

  function onRowKeyDown(event: ReactKeyboardEvent<HTMLTableRowElement>, index: number) {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    const last = rows.length - 1;
    if (last < 0) return;
    let next = index;
    if (event.key === "ArrowDown") next = index === last ? 0 : index + 1;
    else if (event.key === "ArrowUp") next = index === 0 ? last : index - 1;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = last;
    else return;
    event.preventDefault();
    moveFocus.current = true;
    setActive(rows[next].key);
  }

  return (
    <section aria-label="Record comparison" className="record-compare" onKeyDown={(event) => { if (open && event.key === "Escape") { event.preventDefault(); close(); } }}>
      <h2>Compare records</h2>
      <p>Select two to four records you can view. Only fields you can see are compared. Hidden fields and hidden related records are left out. Archived records stay in the comparison. Records in Trash are not compared.</p>
      <p>{recordIds.length} selected.</p>
      {!open ? (
        <div className="record-compare-toolbar">
          <button ref={openButton} type="button" disabled={recordIds.length < 2} onClick={show}>Compare selected records</button>
          {recordIds.length > 0 && <button type="button" onClick={onClear}>Clear comparison</button>}
        </div>
      ) : (
        <div className="record-compare-toolbar">
          <button ref={openButton} type="button" disabled={busy} onClick={() => setReload((value) => value + 1)}>Refresh comparison</button>
          <button type="button" onClick={close}>Close comparison</button>
          {recordIds.length > 0 && <button type="button" onClick={() => { onClear(); close(); }}>Clear comparison</button>}
        </div>
      )}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
      {denied && <p role="alert">This comparison is not available with your current access.</p>}
      {open && busy && <p role="status">Comparing records…</p>}
      {comparison && (
        <>
          {comparison.mixedCollections && <p>These records are in different collections. Each column shows the fields you can view on that record.</p>}
          <label className="record-check">
            <input ref={differences} type="checkbox" checked={differencesOnly} onChange={(event) => setDifferencesOnly(event.target.checked)} /> Differences only
          </label>
          <p>Up and Down move between fields. Home and End jump to the ends. Escape closes the comparison.</p>
          {rows.length ? (
            <div className="record-compare-scroll">
              <table aria-label="Side-by-side record comparison">
                <caption>Field values for the selected records. Status names the difference as well as the highlight.</caption>
                <thead>
                  <tr>
                    <th scope="col">Field</th>
                    <th scope="col">Status</th>
                    {comparison.records.map((record) => (
                      <th key={record.id} scope="col">
                        {record.name}
                        <span className="record-compare-meta">, {record.collection}{record.state === "archived" ? ", archived" : ""}, version {record.version}</span>
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((field, index) => (
                    <tr
                      key={field.key}
                      id={`compare-field-${field.key}`}
                      data-status={field.status}
                      className={rowClass(field.status)}
                      tabIndex={field.key === active ? 0 : -1}
                      aria-selected={field.key === active}
                      onKeyDown={(event) => onRowKeyDown(event, index)}
                      onClick={() => { moveFocus.current = true; setActive(field.key); }}
                    >
                      <th scope="row">{field.label}</th>
                      <td>{compareStatusText(field.status)}</td>
                      {field.values.map((cell) => (
                        <td key={cell.recordId}>{cell.present ? compareValueText(cell.value) : "—"}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p>No field differences in the fields you can view.</p>
          )}
        </>
      )}
    </section>
  );
}

function rowClass(status: CompareStatus) {
  if (status === "changed") return "record-compare-changed";
  if (status === "only-left") return "record-compare-only-left";
  if (status === "only-right") return "record-compare-only-right";
  return undefined;
}
