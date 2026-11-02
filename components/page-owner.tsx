"use client";
import { useEffect, useRef, useState, type FormEvent } from "react";
import { Dialog } from "./editor/dialog";
import { ApiError, requestJson } from "./editor/use-document-session";

type Person = { id: string; name: string; avatar: string };
type OwnerView = { owner: Person | null; canChange: boolean; canHandover: boolean; candidates?: Person[]; atIst?: string; replayed?: boolean };

function isPerson(value: unknown): value is Person {
  if (!value || typeof value !== "object") return false;
  const person = value as Person;
  return typeof person.id === "string" && typeof person.name === "string" && typeof person.avatar === "string";
}

/** A navigation stub or a page with no active owner must not throw. */
function readOwner(value: unknown): OwnerView | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  const canChange = record.canChange === true;
  const canHandover = record.canHandover === true;
  const candidates = Array.isArray(record.candidates) ? record.candidates.filter(isPerson) : undefined;
  const atIst = typeof record.atIst === "string" ? record.atIst : undefined;
  if (record.owner == null) return { owner: null, canChange, canHandover, candidates, atIst };
  if (!isPerson(record.owner)) return { owner: null, canChange: false, canHandover: false };
  return { owner: record.owner, canChange, canHandover, candidates, atIst };
}

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
    requestJson<unknown>(`/api/v1/pages/${encodeURIComponent(pageId)}/owner`, { signal: controller.signal })
      .then(next => {
        if (controller.signal.aborted) return;
        const view = readOwner(next);
        setView(view);
        setOwnerId(view?.candidates?.[0]?.id ?? "");
      })
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
      const next = readOwner(await requestJson<unknown>(`/api/v1/pages/${encodeURIComponent(pageId)}/owner`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operationId: operationFor(ownerId), ownerId }),
      }));
      if (!next) throw new Error("Page is restricted or unavailable");
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
  const owner = view.owner;
  return <div className="page-owner">
    {owner ? <p className="page-owner-chip" aria-label={`Owner ${owner.name}`}>
      <span className="page-owner-avatar" aria-hidden="true">{owner.avatar}</span>
      <span>Owner {owner.name}</span>
    </p> : <p className="page-owner-chip" aria-label="No active owner">No active owner</p>}
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
