"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Dialog } from "./editor/dialog";
import { ApiError, requestJson } from "./editor/use-document-session";

type Person = { id: string; name: string; avatar: string };
type OwnerView = { owner: Person; canChange: boolean; canHandover: boolean; candidates?: Person[]; atIst?: string; replayed?: boolean };

export default function PageOwner({ pageId, workspaceId }: { pageId: string; workspaceId: string }) {
  const [view, setView] = useState<OwnerView | null>(null);
  const [open, setOpen] = useState(false);
  const [ownerId, setOwnerId] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef<{ key: string; id: string } | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    setView(null);
    setNotice("");
    setError("");
    requestJson<OwnerView>(`/api/v1/pages/${encodeURIComponent(pageId)}/owner`, { signal: controller.signal })
      .then(next => { if (!controller.signal.aborted) { setView(next); setOwnerId(next.candidates?.[0]?.id ?? ""); } })
      .catch(() => { if (!controller.signal.aborted) setView(null); });
    return () => controller.abort();
  }, [pageId]);

  function operationFor(key: string) {
    if (pending.current?.key === key) return pending.current.id;
    const id = crypto.randomUUID();
    pending.current = { key, id };
    return id;
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!ownerId) return;
    setBusy(true);
    setError("");
    try {
      const next = await requestJson<OwnerView>(`/api/v1/pages/${encodeURIComponent(pageId)}/owner`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operationId: operationFor(ownerId), ownerId }),
      });
      pending.current = null;
      setView(next);
      setOwnerId(next.candidates?.[0]?.id ?? "");
      setNotice(next.atIst ? `Owner updated · ${next.atIst}` : "Owner updated");
      setOpen(false);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "Page is restricted or unavailable");
    } finally {
      setBusy(false);
    }
  }

  if (!view) return null;
  return <div className="page-owner">
    <p className="page-owner-chip" aria-label={`Owner ${view.owner.name}`}>
      <span className="page-owner-avatar" aria-hidden="true">{view.owner.avatar}</span>
      <span>Owner {view.owner.name}</span>
    </p>
    {view.canChange && <button type="button" onClick={() => { setError(""); setOpen(true); }}>Change owner</button>}
    {view.canHandover && <a href={`/workspaces/${encodeURIComponent(workspaceId)}/handover`}>Hand over pages</a>}
    {notice && <p role="status">{notice}</p>}
    {open && <Dialog title="Change owner" onClose={() => { if (!busy) setOpen(false); }}>
      <form onSubmit={event => void save(event)}>
        <p>Ownership does not create a new permission. Manage rights come from the existing owner role. Choose a member who can already edit this page.</p>
        {error && <p role="alert">{error}</p>}
        {view.candidates?.length ? <label>New owner
          <select aria-label="New owner" value={ownerId} onChange={event => setOwnerId(event.target.value)}>
            {view.candidates.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}
          </select>
        </label> : <p>No other member can edit this page.</p>}
        <button type="submit" disabled={busy || !ownerId}>Save owner</button>
      </form>
    </Dialog>}
  </div>;
}
