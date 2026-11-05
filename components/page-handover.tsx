"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { ApiError, requestJson } from "./editor/use-document-session";

type Member = { id: string; name: string; role: string; active: boolean };
type Access = { canManage: boolean; members: Member[] };
type PageRow = { pageId: string; title: string; trashed?: boolean; recipientCanEdit?: boolean };
type Preview = { from: { id: string; name: string } | null; to: { id: string; name: string }; pages: PageRow[]; trashed: PageRow[] };
type Report = { pages: PageRow[]; trashed: PageRow[] };
type JobItem = { pageId: string; disposition: string; code: string | null; decision: string; trashed: boolean };
type Job = { jobId: string; state: "running" | "completed"; replayed: boolean; atIst: string; counts: { transferred: number; granted: number; skipped: number; failed: number; pending: number }; items: JobItem[] };
type Decision = "transfer" | "grant" | "skip";

const post = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

function Choice({ row, value, onChange }: { row: PageRow; value: Decision; onChange: (value: Decision) => void }) {
  if (row.recipientCanEdit) return <span>Can edit</span>;
  return <select aria-label={`Access for ${row.title}`} value={value} onChange={event => onChange(event.target.value as Decision)}>
    <option value="skip">Skip</option>
    <option value="grant">Grant edit</option>
  </select>;
}

function Rows({ rows, decisions, onDecision }: { rows: PageRow[]; decisions: Record<string, Decision>; onDecision: (pageId: string, decision: Decision) => void }) {
  if (!rows.length) return <p>None</p>;
  return <table>
    <thead><tr><th>Page</th><th>Recipient access</th></tr></thead>
    <tbody>{rows.map(row => <tr key={row.pageId}>
      <td>{row.title}</td>
      <td>{row.recipientCanEdit === undefined ? "No active owner" : <Choice row={row} value={decisions[row.pageId] ?? (row.recipientCanEdit ? "transfer" as Decision : "skip")} onChange={decision => onDecision(row.pageId, decision)} />}</td>
    </tr>)}</tbody>
  </table>;
}

export default function PageHandover({ workspaceId }: { workspaceId: string }) {
  const [access, setAccess] = useState<Access | null>(null);
  const [report, setReport] = useState<Report | null>(null);
  const [fromUserId, setFromUserId] = useState("");
  const [toUserId, setToUserId] = useState("");
  const [assignTo, setAssignTo] = useState("");
  const [includeTrashed, setIncludeTrashed] = useState(false);
  const [assignTrashed, setAssignTrashed] = useState(false);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [assignPreview, setAssignPreview] = useState<Preview | null>(null);
  const [decisions, setDecisions] = useState<Record<string, Decision>>({});
  const [assignDecisions, setAssignDecisions] = useState<Record<string, Decision>>({});
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef<{ key: string; id: string } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    Promise.all([
      requestJson<Access>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/members`, { signal: controller.signal }),
      requestJson<Report>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/ownerless-pages`, { signal: controller.signal }),
    ]).then(([members, ownerless]) => {
      if (controller.signal.aborted) return;
      setAccess(members);
      setReport(ownerless);
      const active = members.members.filter(member => member.active && member.role !== "observer");
      setFromUserId(members.members[0]?.id ?? "");
      setToUserId(active[0]?.id ?? "");
      setAssignTo(active[0]?.id ?? "");
    }).catch(reason => {
      if (!controller.signal.aborted) setError(reason instanceof ApiError ? reason.message : "Workspace is restricted or unavailable");
    });
    return () => controller.abort();
  }, [workspaceId]);

  function operationFor(key: string) {
    if (pending.current?.key === key) return pending.current.id;
    const id = crypto.randomUUID();
    pending.current = { key, id };
    return id;
  }

  function chosen(rows: PageRow[], current: Record<string, Decision>) {
    return rows.map(row => ({ pageId: row.pageId, decision: current[row.pageId] ?? (row.recipientCanEdit ? "transfer" : "skip") }));
  }

  async function resumeUntilDone(started: Job) {
    let current = started;
    for (let attempt = 0; current.state === "running" && attempt < 120; attempt += 1) {
      current = await requestJson<Job>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/page-handover`, post({ action: "resume", operationId: crypto.randomUUID(), jobId: current.jobId }));
    }
    return current;
  }

  async function runPreview(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    setJob(null);
    try {
      const next = await requestJson<Preview>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/page-handover`, post({ action: "preview", fromUserId, toUserId }));
      setPreview(next);
      setDecisions(Object.fromEntries([...next.pages, ...next.trashed].map(row => [row.pageId, row.recipientCanEdit ? "transfer" : "skip"])));
    } catch (reason) {
      setPreview(null);
      setError(reason instanceof ApiError ? reason.message : "Workspace is restricted or unavailable");
    } finally {
      setBusy(false);
    }
  }

  async function runHandover() {
    if (!preview) return;
    const rows = includeTrashed ? [...preview.pages, ...preview.trashed] : preview.pages;
    const key = JSON.stringify({ fromUserId, toUserId, includeTrashed, rows: chosen(rows, decisions) });
    setBusy(true);
    setError("");
    try {
      const started = await requestJson<Job>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/page-handover`, post({
        action: "start",
        operationId: operationFor(key),
        fromUserId,
        toUserId,
        includeTrashed,
        decisions: chosen(rows, decisions),
      }));
      pending.current = null;
      setJob(await resumeUntilDone(started));
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "Review the handover and try again.");
    } finally {
      setBusy(false);
    }
  }

  async function checkOwnerless() {
    setBusy(true);
    setError("");
    try {
      const next = await requestJson<Preview>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/page-handover`, post({ action: "preview-ownerless", toUserId: assignTo }));
      setAssignPreview(next);
      setAssignDecisions(Object.fromEntries([...next.pages, ...next.trashed].map(row => [row.pageId, row.recipientCanEdit ? "transfer" : "skip"])));
    } catch (reason) {
      setAssignPreview(null);
      setError(reason instanceof ApiError ? reason.message : "Workspace is restricted or unavailable");
    } finally {
      setBusy(false);
    }
  }

  async function runAssign() {
    if (!assignPreview) return;
    const rows = assignTrashed ? [...assignPreview.pages, ...assignPreview.trashed] : assignPreview.pages;
    const key = JSON.stringify({ assignTo, assignTrashed, rows: chosen(rows, assignDecisions) });
    setBusy(true);
    setError("");
    try {
      const started = await requestJson<Job>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/ownerless-pages`, post({
        action: "assign",
        operationId: operationFor(key),
        toUserId: assignTo,
        includeTrashed: assignTrashed,
        decisions: chosen(rows, assignDecisions),
      }));
      pending.current = null;
      setJob(await resumeUntilDone(started));
      setReport(await requestJson<Report>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/ownerless-pages`));
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "Review the handover and try again.");
    } finally {
      setBusy(false);
    }
  }

  const members = access?.members ?? [];
  const recipients = members.filter(member => member.active && member.role !== "observer");
  return <main className="page-handover-page">
    <a className="skip-link" href="#page-handover">Skip to page handover</a>
    <p><a href="/">Aplyd Pages</a> / Page handover</p>
    <h1>Page handover</h1>
    <p>Transfer page ownership when someone changes role or leaves. Ownership is not a permission. Manage rights follow the existing role mapping. Pages the recipient cannot edit stay put unless you grant edit.</p>
    {error && <p role="alert">{error}</p>}
    {!access && !error && <p role="status">Opening page handover…</p>}
    {access && <div id="page-handover">
      <form onSubmit={event => void runPreview(event)}>
        <h2>Hand over pages</h2>
        <label>From <select aria-label="Handover from" value={fromUserId} onChange={event => { setFromUserId(event.target.value); setPreview(null); }}>
          {members.map(member => <option key={member.id} value={member.id}>{member.name}{member.active ? "" : " (inactive)"}</option>)}
        </select></label>
        <label>To <select aria-label="Handover to" value={toUserId} onChange={event => { setToUserId(event.target.value); setPreview(null); }}>
          {recipients.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}
        </select></label>
        <button type="submit" disabled={busy || !fromUserId || !toUserId}>Preview handover</button>
      </form>
      {preview && <>
        <h3>Pages</h3>
        <Rows rows={preview.pages} decisions={decisions} onDecision={(pageId, decision) => setDecisions(current => ({ ...current, [pageId]: decision }))} />
        <h3>Trash</h3>
        <p>Trashed pages are listed separately and move only if you include them.</p>
        <Rows rows={preview.trashed} decisions={decisions} onDecision={(pageId, decision) => setDecisions(current => ({ ...current, [pageId]: decision }))} />
        <label><input type="checkbox" checked={includeTrashed} onChange={event => setIncludeTrashed(event.target.checked)} /> Include trash</label>
        <button type="button" disabled={busy} onClick={() => void runHandover()}>Start handover</button>
      </>}
      <section aria-label="Pages without an active owner">
        <h2>Pages without an active owner</h2>
        {!report && <p role="status">Loading the report…</p>}
        {report && <>
          <h3>Pages</h3>
          <Rows rows={report.pages} decisions={{}} onDecision={() => undefined} />
          <h3>Trash</h3>
          <Rows rows={report.trashed} decisions={{}} onDecision={() => undefined} />
          <label>Assign to <select aria-label="Assign owner" value={assignTo} onChange={event => { setAssignTo(event.target.value); setAssignPreview(null); }}>
            {recipients.map(member => <option key={member.id} value={member.id}>{member.name}</option>)}
          </select></label>
          <button type="button" disabled={busy || !assignTo} onClick={() => void checkOwnerless()}>Check access</button>
          {assignPreview && <>
            <Rows rows={assignPreview.pages} decisions={assignDecisions} onDecision={(pageId, decision) => setAssignDecisions(current => ({ ...current, [pageId]: decision }))} />
            <h3>Trash</h3>
            <Rows rows={assignPreview.trashed} decisions={assignDecisions} onDecision={(pageId, decision) => setAssignDecisions(current => ({ ...current, [pageId]: decision }))} />
            <label><input type="checkbox" checked={assignTrashed} onChange={event => setAssignTrashed(event.target.checked)} /> Include trash</label>
            <button type="button" disabled={busy} onClick={() => void runAssign()}>Assign owners</button>
          </>}
        </>}
      </section>
      {job && <p role="status">Handover {job.state}. Transferred {job.counts.transferred}. Granted {job.counts.granted}. Skipped {job.counts.skipped}. Failed {job.counts.failed}. Pending {job.counts.pending}. Recorded {job.atIst}.</p>}
    </div>}
  </main>;
}
