"use client";

import { FormEvent, useCallback, useEffect, useMemo, useState } from "react";

type Kind = "contact-account" | "employee-account" | "contract-legal-party" | "contract-account" | "parent-organisation";
type Operation = "add" | "remove" | "replace";
type Collection = "accounts" | "contacts" | "employees" | "contracts";
type PreviewRow = {
  sourceId: string;
  sourceName: string | null;
  outcome: "success" | "skipped" | "error";
  code: string;
  message: string;
  contextReferences: { sourceApp: string; sourceType: string; sourceId: string }[];
  deletionConstraints: { code: string; message: string }[];
  affectedContracts: { id: string; name: string }[];
  hiddenAffectedContracts: boolean;
  legalPartiesWillChange: boolean;
};
type Preview = {
  previewToken: string;
  legalPartiesWillChange: boolean;
  counts: { success: number; skipped: number; error: number };
  rows: PreviewRow[];
};
type DraftPayload = {
  collection: Collection;
  sourceIds: string[];
  kind: Kind;
  operation: Operation;
  targetId: string;
  role: string;
  primary: boolean;
  status: "active" | "inactive";
};
type Draft = { draftId: string; version: number; payload: DraftPayload };
type Result = Preview & { batchId: string; replayed?: boolean };

const kinds: Record<Collection, { value: Kind; label: string }[]> = {
  accounts: [{ value: "parent-organisation", label: "Parent organisation" }],
  contacts: [{ value: "contact-account", label: "Account" }],
  employees: [{ value: "employee-account", label: "Account" }],
  contracts: [
    { value: "contract-account", label: "Covered account" },
    { value: "contract-legal-party", label: "Legal organisation" },
  ],
};

const limit = 1000;

export default function BulkRelationships({ workspaceId, tenantId, collection, records }: { workspaceId: string; tenantId: string; collection: Collection; records: { id: string; name: string }[] }) {
  const endpoint = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/tenants/${encodeURIComponent(tenantId)}/relationship-batches`;
  const options = kinds[collection];
  const [selected, setSelected] = useState<string[]>([]);
  const [kind, setKind] = useState<Kind>(options[0].value);
  const [operation, setOperation] = useState<Operation>("add");
  const [targetId, setTargetId] = useState("");
  const [targetQuery, setTargetQuery] = useState("");
  const [targets, setTargets] = useState<{ id: string; name: string }[]>([]);
  const [role, setRole] = useState("");
  const [primary, setPrimary] = useState(false);
  const [status, setStatus] = useState<"active" | "inactive">("active");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [operationId, setOperationId] = useState("");
  const [result, setResult] = useState<Result | null>(null);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [draftId, setDraftId] = useState("");
  const [draftVersion, setDraftVersion] = useState(0);
  const [chosenDraft, setChosenDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const names = useMemo(() => new Map(records.map((record) => [record.id, record.name])), [records]);
  const offPage = selected.filter((id) => !names.has(id)).length;

  const post = useCallback(async (body: unknown) => {
    const response = await fetch(endpoint, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (response.headers.get("content-type")?.includes("text/csv")) {
      if (!response.ok) throw new Error("Unable to download this batch.");
      return response.text();
    }
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "Unable to update relationships.");
    return data;
  }, [endpoint]);

  async function refreshDrafts() {
    const data = await post({ action: "list-drafts" });
    setDrafts(Array.isArray(data.drafts) ? data.drafts : []);
  }

  useEffect(() => {
    let cancelled = false;
    void post({ action: "list-drafts" })
      .then((data) => {
        if (!cancelled) setDrafts(Array.isArray(data.drafts) ? data.drafts : []);
      })
      .catch(() => {
        if (!cancelled) setDrafts([]);
      });
    return () => {
      cancelled = true;
    };
  }, [post]);

  function toggle(id: string) {
    setPreview(null);
    setConfirmed(false);
    setResult(null);
    setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : current.length >= limit ? current : [...current, id]);
    if (!selected.includes(id) && selected.length >= limit) setNotice("Select at most 1000 records.");
  }

  function payload(): DraftPayload {
    return { collection, sourceIds: selected, kind, operation, targetId, role: kind === "parent-organisation" ? "" : role, primary: kind === "contact-account" && primary, status: kind === "parent-organisation" ? "active" : status };
  }

  async function previewImpact(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setNotice("");
    setResult(null);
    setConfirmed(false);
    try {
      if (!selected.length) throw new Error("Select at least one record.");
      if (selected.length > limit) throw new Error("Select at most 1000 records.");
      const data = await post({ action: "preview", ...payload() });
      setPreview(data);
      setOperationId(crypto.randomUUID());
      setNotice("Preview only. Nothing was saved. Confirm the impact to apply it.");
    } catch (cause) {
      setPreview(null);
      setError(cause instanceof Error ? cause.message : "Unable to preview relationships.");
    } finally {
      setBusy(false);
    }
  }

  async function apply() {
    if (!preview || !confirmed || !operationId) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const data = await post({ action: "execute", operationId, previewToken: preview.previewToken, confirmed: true, ...payload() });
      setResult(data);
      setNotice(data.replayed ? "This batch was already saved. No duplicate links were added." : "Batch saved. Each record succeeded, was skipped, or reported an error.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to apply relationships.");
    } finally {
      setBusy(false);
    }
  }

  function cancel() {
    setPreview(null);
    setConfirmed(false);
    setNotice("Cancelled. Saved relationships were not changed.");
  }

  async function searchTargets() {
    setBusy(true);
    setError("");
    try {
      const data = await post({ action: "search", kind, query: targetQuery });
      setTargets(Array.isArray(data.results) ? data.results : []);
      if (!data.results?.length) setNotice("No targets you can link matched that search.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to search targets.");
    } finally {
      setBusy(false);
    }
  }

  async function saveDraft() {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const id = draftId || crypto.randomUUID();
      const data = await post({ action: "save-draft", draftId: id, operationId: crypto.randomUUID(), expectedVersion: draftId ? draftVersion : 0, payload: payload() });
      setDraftId(data.draftId);
      setDraftVersion(data.version);
      setNotice(data.replayed ? "This draft was already saved." : "Draft saved on this server. Relationships were not changed.");
      await refreshDrafts();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to save this draft.");
    } finally {
      setBusy(false);
    }
  }

  async function recover() {
    if (!chosenDraft) return;
    setBusy(true);
    setError("");
    try {
      const data = await post({ action: "read-draft", draftId: chosenDraft });
      const body = data.payload as DraftPayload;
      setDraftId(data.draftId);
      setDraftVersion(data.version);
      setSelected(body.sourceIds ?? []);
      setKind(options.some((option) => option.value === body.kind) ? body.kind : options[0].value);
      setOperation(body.operation);
      setTargetId(body.targetId ?? "");
      setRole(body.role ?? "");
      setPrimary(body.primary === true);
      setStatus(body.status === "inactive" ? "inactive" : "active");
      setPreview(null);
      setConfirmed(false);
      setResult(null);
      setNotice("Draft restored. Review it, then preview the impact before applying.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to restore this draft.");
    } finally {
      setBusy(false);
    }
  }

  async function download() {
    if (!result) return;
    setBusy(true);
    setError("");
    try {
      const csv = await post({ action: "download", batchId: result.batchId });
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = "relationship-batch.csv";
      link.click();
      URL.revokeObjectURL(url);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Unable to download this batch.");
    } finally {
      setBusy(false);
    }
  }

  const rows = result?.rows ?? preview?.rows ?? [];
  return (
    <section className="bulk-relationships" aria-label="Bulk relationships">
      <h2>Bulk relationships</h2>
      <p>Add, remove, or replace links for up to 1000 records you can edit and link. A preview is required. Cancel leaves saved data unchanged. Linking never grants access.</p>
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      <p aria-live="polite">{selected.length} of {limit} records selected.{offPage ? ` ${offPage} selected record${offPage === 1 ? " is" : "s are"} not on this page.` : ""}</p>
      <form aria-label="Relationship batch" onSubmit={previewImpact}>
        <fieldset>
          <legend>Source records</legend>
          <div className="bulk-relationships-sources">
            {records.map((record) => (
              <label className="record-check" key={record.id}>
                <input type="checkbox" checked={selected.includes(record.id)} aria-label={`Select ${record.name}`} onChange={() => toggle(record.id)} />
                {record.name}
              </label>
            ))}
          </div>
          {!records.length ? <p>No records on this page yet.</p> : null}
        </fieldset>
        <label>
          Relationship type
          <select aria-label="Relationship type" value={kind} onChange={(event) => { setKind(event.target.value as Kind); setPreview(null); setConfirmed(false); }}>
            {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
        </label>
        <fieldset>
          <legend>Operation</legend>
          {(["add", "remove", "replace"] as const).map((value) => (
            <label className="record-check" key={value}>
              <input type="radio" name="bulk-operation" value={value} checked={operation === value} onChange={() => { setOperation(value); setPreview(null); setConfirmed(false); }} />
              {value[0].toUpperCase() + value.slice(1)}
            </label>
          ))}
        </fieldset>
        <label>
          Find a target
          <input aria-label="Find a target" value={targetQuery} maxLength={200} onChange={(event) => setTargetQuery(event.target.value)} />
        </label>
        <button type="button" disabled={busy} onClick={() => void searchTargets()}>Search targets</button>
        {targets.length ? (
          <fieldset>
            <legend>Targets you can link</legend>
            {targets.map((target) => (
              <label className="record-check" key={target.id}>
                <input type="radio" name="bulk-target" value={target.id} checked={targetId === target.id} onChange={() => { setTargetId(target.id); setPreview(null); setConfirmed(false); }} />
                {target.name}
              </label>
            ))}
          </fieldset>
        ) : null}
        <label>
          Target record ID
          <input aria-label="Target record ID" required value={targetId} onChange={(event) => { setTargetId(event.target.value); setPreview(null); setConfirmed(false); }} />
        </label>
        {kind !== "parent-organisation" ? (
          <>
            <label>
              Role
              <input aria-label="Relationship role" maxLength={100} value={role} onChange={(event) => { setRole(event.target.value); setPreview(null); }} />
            </label>
            <label>
              Status
              <select aria-label="Relationship status" value={status} onChange={(event) => { setStatus(event.target.value as "active" | "inactive"); setPreview(null); }}>
                <option value="active">Active</option>
                <option value="inactive">Inactive</option>
              </select>
            </label>
          </>
        ) : <p>An account keeps exactly one parent organisation. Remove is refused. Replace keeps legal parties unchanged.</p>}
        {kind === "contact-account" ? (
          <label className="record-check">
            <input type="checkbox" checked={primary} onChange={(event) => { setPrimary(event.target.checked); setPreview(null); }} /> Primary account
          </label>
        ) : null}
        <div className="bulk-relationships-actions">
          <button type="submit" disabled={busy || !selected.length}>Preview impact</button>
          <button type="button" disabled={busy} onClick={() => void saveDraft()}>Save draft</button>
          <button type="button" disabled={busy || !selected.length} onClick={() => { setSelected([]); setPreview(null); setConfirmed(false); setNotice("Selection cleared. Saved relationships were not changed."); }}>Clear selection</button>
        </div>
      </form>
      <form aria-label="Recover relationship draft" onSubmit={(event) => { event.preventDefault(); void recover(); }}>
        <label>
          Saved draft
          <select aria-label="Saved draft" value={chosenDraft} onChange={(event) => setChosenDraft(event.target.value)}>
            <option value="">Choose a draft</option>
            {drafts.map((draft) => <option key={draft.draftId} value={draft.draftId}>{draft.payload.operation} · {draft.payload.kind} · {draft.payload.sourceIds.length} records</option>)}
          </select>
        </label>
        <button type="submit" disabled={busy || !chosenDraft}>Recover draft</button>
      </form>
      {preview ? (
        <section aria-label="Impact preview">
          <h3>Impact preview</h3>
          <p>{preview.counts.success} would change, {preview.counts.skipped} already match, {preview.counts.error} would be refused. Legal parties will not change.</p>
          <ResultTable rows={rows} />
          <label className="record-check">
            <input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> Confirm this impact
          </label>
          <div className="bulk-relationships-actions">
            <button type="button" disabled={busy || !confirmed} onClick={() => void apply()}>Apply to selected records</button>
            <button type="button" disabled={busy} onClick={cancel}>Cancel</button>
          </div>
        </section>
      ) : null}
      {result ? (
        <section aria-label="Batch result">
          <h3>Batch result</h3>
          <p>Batch {result.batchId}. {result.counts.success} changed, {result.counts.skipped} unchanged, {result.counts.error} refused.</p>
          <ResultTable rows={result.rows} />
          <div className="bulk-relationships-actions">
            <button type="button" disabled={busy} onClick={() => void apply()}>Retry this batch</button>
            <button type="button" disabled={busy} onClick={() => void download()}>Download results</button>
          </div>
        </section>
      ) : null}
    </section>
  );
}

function ResultTable({ rows }: { rows: PreviewRow[] }) {
  return (
    <div className="bulk-relationships-scroll">
      <table>
        <caption>Per-record impact. One record is saved or left unchanged on its own.</caption>
        <thead>
          <tr>
            <th scope="col">Record</th>
            <th scope="col">Result</th>
            <th scope="col">Detail</th>
            <th scope="col">Connected references</th>
            <th scope="col">Deletion constraints</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.sourceId}>
              <th scope="row">{row.sourceName || "Restricted or unavailable"}</th>
              <td>{row.outcome}</td>
              <td>{row.message}</td>
              <td>{row.contextReferences.length ? row.contextReferences.map((ref) => `${ref.sourceApp} ${ref.sourceType}`).join(", ") : "None"}{row.affectedContracts.length ? `. Contracts: ${row.affectedContracts.map((contract) => contract.name).join(", ")}` : ""}{row.hiddenAffectedContracts ? " Other affected contracts are hidden." : ""}</td>
              <td>{row.deletionConstraints.length ? row.deletionConstraints.map((item) => item.message).join(" ") : "None"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
