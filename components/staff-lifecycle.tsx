"use client";
import { FormEvent, useRef, useState } from "react";

type ChecklistItem = { id: string; phase: string; title: string; dueOn: string; ownerUserId: string; done: boolean };
type Lifecycle = {
  id: string;
  employeeName?: string;
  state: string;
  version: number;
  handoverState?: string;
  cleanHandover?: boolean;
  accessTransferred: boolean;
  credentialsTransferred: boolean;
  accessRevoked?: boolean;
  revocationClaim?: string;
  checklist?: ChecklistItem[];
  dates?: { plannedOn: string | null; startOn: string | null; leavingOn: string | null; leftOn: string | null };
  outstanding?: { total: number; hiddenCount: number; items: { id: string; kind: string; label: string }[] };
};
type Draft = { id: string; employeeRecordId: string; plannedOn: string | null; version: number };
type Preview = { previewId: string; reviewHash: string; action: string; confirm: string; impact: string };
type Policy = { acknowledgementRequired: boolean; version: number; accessGranted: false };
const nextState: Record<string, string> = { planned: "start", start: "active", active: "leaving", leaving: "left" };

export default function StaffLifecycle({ workspaceId, tenantId }: { workspaceId: string; tenantId: string }) {
  const root = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/tenants/${encodeURIComponent(tenantId)}/staff-lifecycle`;
  const [open, setOpen] = useState(false);
  const [lifecycles, setLifecycles] = useState<Lifecycle[]>([]);
  const [drafts, setDrafts] = useState<Draft[]>([]);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [note, setNote] = useState("");
  const [employeeRecordId, setEmployeeRecordId] = useState("");
  const [plannedOn, setPlannedOn] = useState("");
  const [directoryUserId, setDirectoryUserId] = useState("");
  const [stepDate, setStepDate] = useState("");
  const [checklistTitle, setChecklistTitle] = useState("");
  const [checklistDue, setChecklistDue] = useState("");
  const [checklistOwner, setChecklistOwner] = useState("");
  const [checklistPhase, setChecklistPhase] = useState("onboarding");
  const [accountIds, setAccountIds] = useState("");
  const [recipientUserId, setRecipientUserId] = useState("");
  const [exceptionNote, setExceptionNote] = useState("");
  const [acknowledge, setAcknowledge] = useState(false);
  const [evidenceReference, setEvidenceReference] = useState("");
  const [sourceSystem, setSourceSystem] = useState("");
  const [observedRevoked, setObservedRevoked] = useState(false);
  const [query, setQuery] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const saveIntent = useRef<{ key: string; operationId: string } | null>(null);
  const current = lifecycles[0];

  async function load(search = query) {
    const params = new URLSearchParams({ collection: "employees" });
    if (search.trim()) params.set("q", search.trim());
    const response = await fetch(`${root}?${params}`, { credentials: "same-origin", cache: "no-store" });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(typeof body?.error === "string" ? body.error : "Staff lifecycle could not be loaded.");
    setLifecycles(Array.isArray(body?.lifecycles) ? body.lifecycles.filter(acceptedLifecycle) : []);
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
    try { await load(); } catch (reason) { setError(reason instanceof Error ? reason.message : "Staff lifecycle could not be loaded."); } finally { setBusy(false); }
  }
  async function post(body: Record<string, unknown>) {
    const response = await fetch(root, { method: "POST", credentials: "same-origin", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new Error(typeof payload?.error === "string" ? payload.error : "The staff lifecycle could not be saved.");
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
  async function review(body: Record<string, unknown>) {
    const next = acceptedPreview(await post(body));
    if (!next) throw new Error("Review the staff lifecycle.");
    setPreview(next);
    setConfirmed(false);
  }
  async function reviewCreate(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await review({ kind: "preview", action: "create", collection: "employees", employeeRecordId, plannedOn, directoryUserId: directoryUserId.trim() || null, checklist: [] });
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Review the staff lifecycle."); setPreview(null); } finally { setBusy(false); }
  }
  async function reviewStep() {
    if (!current) { setError("Open a staff lifecycle before changing its state."); return; }
    const to = nextState[current.state];
    if (!to) { setError("This lifecycle has no further HR state."); return; }
    setBusy(true);
    setError("");
    try { await review({ kind: "preview", action: "transition", collection: "employees", lifecycleId: current.id, expectedVersion: current.version, to, date: to === "active" ? null : stepDate }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Review the staff lifecycle."); } finally { setBusy(false); }
  }
  async function reviewChecklist(event: FormEvent) {
    event.preventDefault();
    if (!current) { setError("Open a staff lifecycle before saving a checklist item."); return; }
    setBusy(true);
    setError("");
    try {
      const items = [...(current.checklist ?? []), { id: crypto.randomUUID(), phase: checklistPhase, title: checklistTitle, dueOn: checklistDue, ownerUserId: checklistOwner, done: false }];
      await review({ kind: "preview", action: "checklist", collection: "employees", lifecycleId: current.id, expectedVersion: current.version, items });
    } catch (reason) { setError(reason instanceof Error ? reason.message : "Review the checklist."); } finally { setBusy(false); }
  }
  async function reviewAccounts(event: FormEvent) {
    event.preventDefault();
    if (!current) { setError("Open a staff lifecycle before linking accounts."); return; }
    setBusy(true);
    setError("");
    try { await review({ kind: "preview", action: "link-accounts", collection: "employees", lifecycleId: current.id, expectedVersion: current.version, accountIds: accountIds.split(/[\s,]+/).filter(Boolean) }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Review the account links."); } finally { setBusy(false); }
  }
  async function reviewRecipient(event: FormEvent) {
    event.preventDefault();
    if (!current) { setError("Open a staff lifecycle before naming a recipient."); return; }
    setBusy(true);
    setError("");
    try { await review({ kind: "preview", action: "name-recipient", collection: "employees", lifecycleId: current.id, expectedVersion: current.version, recipientUserId: recipientUserId.trim() || null }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Review the handover recipient."); } finally { setBusy(false); }
  }
  async function reviewHandover(event: FormEvent) {
    event.preventDefault();
    if (!current) { setError("Open a staff lifecycle before recording a handover."); return; }
    if ((current.outstanding?.total ?? 0) > 0 && !acknowledge) {
      setError("Acknowledge outstanding records and approvals before completing the handover.");
      return;
    }
    setBusy(true);
    setError("");
    try { await review({ kind: "preview", action: "complete-handover", collection: "employees", lifecycleId: current.id, expectedVersion: current.version, exceptionsAcknowledged: acknowledge, exceptionNote: exceptionNote.trim() || null }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Review the handover."); } finally { setBusy(false); }
  }
  async function reviewEvidence(event: FormEvent) {
    event.preventDefault();
    if (!current) { setError("Open a staff lifecycle before recording identity evidence."); return; }
    setBusy(true);
    setError("");
    try { await review({ kind: "preview", action: "identity-evidence", collection: "employees", lifecycleId: current.id, expectedVersion: current.version, evidenceReference, sourceSystem, observedAccessRevoked: observedRevoked }); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Review the identity evidence."); } finally { setBusy(false); }
  }
  async function confirm(event: FormEvent) {
    event.preventDefault();
    if (!preview || !confirmed) return;
    setBusy(true);
    setError("");
    try {
      await post({ kind: "confirm", operationId: operation(`${preview.confirm}:${preview.previewId}`), previewId: preview.previewId, reviewHash: preview.reviewHash, confirm: preview.confirm });
      saveIntent.current = null;
      setNotice("Saved. Access and login credentials were not transferred.");
      clearReview();
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The staff lifecycle could not be saved."); } finally { setBusy(false); }
  }
  async function saveDraft(event: FormEvent) {
    event.preventDefault();
    const draft = drafts[0];
    const draftId = draft?.id ?? crypto.randomUUID();
    setBusy(true);
    setError("");
    try {
      await post({ kind: "draft", collection: "employees", draftId, employeeRecordId, directoryUserId: directoryUserId.trim() || null, plannedOn: plannedOn || null, startOn: null, leavingOn: null, leftOn: null, checklist: [], accountIds: accountIds.split(/[\s,]+/).filter(Boolean), recipientUserId: recipientUserId.trim() || null, exceptionsAcknowledged: acknowledge, exceptionNote: exceptionNote.trim() || null, operationId: operation(`draft:${draftId}`), expectedVersion: draft?.version ?? 0 });
      saveIntent.current = null;
      setNotice("Draft saved on the server. You can come back to it.");
      await load();
    } catch (reason) { setError(reason instanceof Error ? reason.message : "The draft could not be saved."); } finally { setBusy(false); }
  }

  return (
    <section className="staff-lifecycle" aria-labelledby="staff-lifecycle-heading">
      <h2 id="staff-lifecycle-heading">Staff lifecycle</h2>
      <p id="staff-lifecycle-boundary">Track planned, start, active, leaving, and left states, plus checklists, for an employee you can already view. This does not transfer access or login credentials, and an HR state does not revoke access.</p>
      <p>Configuration and assignment do not grant access.</p>
      <button type="button" onClick={() => void toggle()} aria-expanded={open}>{open ? "Close staff lifecycle" : "Staff lifecycle"}</button>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {open && (
        <div>
          <form aria-label="Find staff lifecycles" onSubmit={(event) => { event.preventDefault(); setBusy(true); setError(""); void load().then(() => setBusy(false)).catch((reason) => { setError(reason instanceof Error ? reason.message : "Staff lifecycle could not be loaded."); setBusy(false); }); }}>
            <label>Find <input value={query} onChange={(event) => setQuery(event.target.value)} autoComplete="off" /></label>
            <button type="submit" disabled={busy}>Find lifecycles</button>
          </form>
          {policy && <p>Acknowledgement required: {policy.acknowledgementRequired ? "yes" : "no"}. Setting version {policy.version}. This setting does not grant access.</p>}
          {note && <p>{note}</p>}
          <ul>
            {lifecycles.map((lifecycle) => (
              <li key={lifecycle.id}>
                <p>{lifecycle.employeeName ?? "Employee"} · {lifecycle.state}. Handover {lifecycle.handoverState ?? "open"}. Access transferred: no. Credentials transferred: no.</p>
                <p>Revocation claim: {lifecycle.revocationClaim ?? "not-recorded"}.</p>
                {(lifecycle.outstanding?.total ?? 0) > 0 && <p>Outstanding owned records or approvals: {lifecycle.outstanding?.total}. Acknowledge them before a complete handover. Restricted items: {lifecycle.outstanding?.hiddenCount ?? 0}.</p>}
                <ul>
                  {(lifecycle.checklist ?? []).map((item) => <li key={item.id}>{item.phase}: {item.title}. Due {item.dueOn}. Owner {item.ownerUserId}. {item.done ? "Done" : "Open"}.</li>)}
                </ul>
              </li>
            ))}
          </ul>
          {drafts[0] && <p role="status">Recoverable draft version {drafts[0].version}.</p>}
          <form aria-label="Open staff lifecycle" onSubmit={reviewCreate}>
            <label>Employee record <input value={employeeRecordId} onChange={(event) => { setEmployeeRecordId(event.target.value); clearReview(); }} autoComplete="off" aria-describedby="staff-lifecycle-boundary" /></label>
            <label>Planned date <input value={plannedOn} onChange={(event) => { setPlannedOn(event.target.value); clearReview(); }} placeholder="2026-04-01" inputMode="numeric" autoComplete="off" /></label>
            <label>Directory user, optional <input value={directoryUserId} onChange={(event) => { setDirectoryUserId(event.target.value); clearReview(); }} autoComplete="off" /></label>
            <button type="submit" disabled={busy}>Review staff lifecycle</button>
          </form>
          <form aria-label="Change lifecycle state" onSubmit={(event) => { event.preventDefault(); void reviewStep(); }}>
            <label>State date <input value={stepDate} onChange={(event) => { setStepDate(event.target.value); clearReview(); }} placeholder="2026-05-01" inputMode="numeric" autoComplete="off" /></label>
            <button type="submit" disabled={busy || !current || !nextState[current.state]}>Record next state</button>
          </form>
          <form aria-label="Save checklist item" onSubmit={reviewChecklist}>
            <label>
              Phase
              <select value={checklistPhase} onChange={(event) => { setChecklistPhase(event.target.value); clearReview(); }}>
                <option value="onboarding">Onboarding</option>
                <option value="offboarding">Offboarding</option>
              </select>
            </label>
            <label>Checklist title <input value={checklistTitle} onChange={(event) => { setChecklistTitle(event.target.value); clearReview(); }} autoComplete="off" /></label>
            <label>Due date <input value={checklistDue} onChange={(event) => { setChecklistDue(event.target.value); clearReview(); }} placeholder="2026-05-15" inputMode="numeric" autoComplete="off" /></label>
            <label>Responsible owner <input value={checklistOwner} onChange={(event) => { setChecklistOwner(event.target.value); clearReview(); }} autoComplete="off" /></label>
            <button type="submit" disabled={busy}>Review checklist item</button>
          </form>
          <form aria-label="Link account responsibilities" onSubmit={reviewAccounts}>
            <label>Account records <input value={accountIds} onChange={(event) => { setAccountIds(event.target.value); clearReview(); }} autoComplete="off" aria-describedby="staff-lifecycle-boundary" /></label>
            <button type="submit" disabled={busy}>Review account links</button>
          </form>
          <form aria-label="Name handover recipient" onSubmit={reviewRecipient}>
            <label>Handover recipient <input value={recipientUserId} onChange={(event) => { setRecipientUserId(event.target.value); clearReview(); }} autoComplete="off" aria-describedby="staff-lifecycle-boundary" /></label>
            <button type="submit" disabled={busy}>Review recipient</button>
          </form>
          <form aria-label="Complete handover" onSubmit={reviewHandover}>
            <p>Acknowledge outstanding records and approvals before a complete handover. This does not transfer access or login credentials.</p>
            <label className="check"><input type="checkbox" checked={acknowledge} onChange={(event) => { setAcknowledge(event.target.checked); clearReview(); }} /> I acknowledge the outstanding records and approvals</label>
            <label>Exception note <input value={exceptionNote} onChange={(event) => { setExceptionNote(event.target.value); clearReview(); }} autoComplete="off" /></label>
            <button type="submit" disabled={busy}>Review handover</button>
          </form>
          <form aria-label="Record identity evidence" onSubmit={reviewEvidence}>
            <p>An HR status does not revoke access. Leave the evidence box unchecked unless the identity service says access was revoked.</p>
            <label>Identity service <input value={sourceSystem} onChange={(event) => { setSourceSystem(event.target.value); clearReview(); }} autoComplete="off" /></label>
            <label>Evidence reference <input value={evidenceReference} onChange={(event) => { setEvidenceReference(event.target.value); clearReview(); }} autoComplete="off" /></label>
            <label className="check"><input type="checkbox" checked={observedRevoked} onChange={(event) => { setObservedRevoked(event.target.checked); clearReview(); }} /> The identity service evidence says access was revoked</label>
            <button type="submit" disabled={busy}>Review identity evidence</button>
          </form>
          {preview && (
            <form aria-label="Confirm staff lifecycle" onSubmit={confirm}>
              <p>{preview.impact}</p>
              <label className="check"><input type="checkbox" checked={confirmed} onChange={(event) => setConfirmed(event.target.checked)} /> I confirm this staff lifecycle action</label>
              <button type="submit" disabled={busy || !confirmed}>Confirm action</button>
              <button type="button" onClick={() => { clearReview(); setNotice("Cancelled. Durable staff records were not changed."); }}>Cancel</button>
            </form>
          )}
          <form aria-label="Save staff lifecycle draft" onSubmit={saveDraft}>
            <div className="actions">
              <button type="submit" disabled={busy}>Save draft</button>
            </div>
          </form>
          {current && (
            <p>
              <a className="staff-lifecycle-link" href={`${root}/history?collection=employees&lifecycleId=${encodeURIComponent(current.id)}`}>Lifecycle history</a>
              {" "}
              <a className="staff-lifecycle-link" href={`${root}/download?collection=employees&lifecycleId=${encodeURIComponent(current.id)}`}>Download lifecycle</a>
            </p>
          )}
        </div>
      )}
    </section>
  );
}

function acceptedLifecycle(value: unknown): value is Lifecycle {
  if (!value || typeof value !== "object") return false;
  const lifecycle = value as Lifecycle;
  return typeof lifecycle.id === "string" && typeof lifecycle.state === "string" && typeof lifecycle.version === "number" && lifecycle.accessTransferred === false && lifecycle.credentialsTransferred === false;
}
function acceptedDraft(value: unknown): value is Draft {
  if (!value || typeof value !== "object") return false;
  const draft = value as Draft;
  return typeof draft.id === "string" && typeof draft.version === "number";
}
function acceptedPolicy(value: unknown): Policy | null {
  if (!value || typeof value !== "object") return null;
  const policy = value as Policy;
  if (typeof policy.acknowledgementRequired !== "boolean" || typeof policy.version !== "number") return null;
  return policy;
}
function acceptedPreview(value: unknown): Preview | null {
  if (!value || typeof value !== "object") return null;
  const preview = value as Preview;
  if (typeof preview.previewId !== "string" || typeof preview.reviewHash !== "string" || typeof preview.confirm !== "string" || typeof preview.impact !== "string") return null;
  return preview;
}
