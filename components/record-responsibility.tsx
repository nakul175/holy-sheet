"use client";
import { FormEvent, useEffect, useRef, useState } from "react";
import {
  acceptedResponsibility,
  acceptedResponsibilityPeople,
  type RecordResponsibilityPerson,
  type RecordResponsibilityState,
} from "../lib/record-responsibility-contract";

export default function RecordResponsibility({ workspaceId, tenantId, recordId }: { workspaceId: string; tenantId: string; recordId: string }) {
  const root = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/tenants/${encodeURIComponent(tenantId)}/records/${encodeURIComponent(recordId)}/responsibility`;
  const [state, setState] = useState<RecordResponsibilityState | null>(null);
  const [query, setQuery] = useState("");
  const [people, setPeople] = useState<RecordResponsibilityPerson[]>([]);
  const [chosen, setChosen] = useState<RecordResponsibilityPerson | null>(null);
  const [busy, setBusy] = useState(false);
  const [denied, setDenied] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const offer = useRef<{ operationId: string; toUserId: string } | null>(null);
  const decision = useRef<{ operationId: string; action: "accept" | "cancel" } | null>(null);

  useEffect(() => {
    const abort = new AbortController();
    setDenied(false);
    setError("");
    setNotice("");
    setState(null);
    void (async () => {
      try {
        const response = await fetch(root, { credentials: "same-origin", cache: "no-store", signal: abort.signal });
        const payload = await response.json();
        if (abort.signal.aborted) return;
        if (response.status === 401 || response.status === 403 || response.status === 404) {
          setDenied(true);
          return;
        }
        const next = acceptedResponsibility(payload);
        if (!response.ok || !next) {
          setError("Responsibility is temporarily unavailable.");
          return;
        }
        setState(next);
      } catch {
        if (!abort.signal.aborted) setError("Responsibility is temporarily unavailable.");
      }
    })();
    return () => abort.abort();
  }, [root]);

  useEffect(() => {
    setPeople([]);
    if (!state?.canOffer || chosen || [...query.trim()].length < 2) return;
    const abort = new AbortController();
    const timer = setTimeout(() => {
      void fetch(`${root}?q=${encodeURIComponent(query)}`, { credentials: "same-origin", cache: "no-store", signal: abort.signal })
        .then(async (response) => {
          const payload = await response.json();
          if (!abort.signal.aborted && response.ok) setPeople(acceptedResponsibilityPeople(payload) ?? []);
        })
        .catch(() => undefined);
    }, 150);
    return () => {
      clearTimeout(timer);
      abort.abort();
    };
  }, [chosen, query, root, state?.canOffer]);

  async function send(action: "offer" | "accept" | "cancel", toUserId?: string) {
    if (busy || denied) return;
    let operationId = crypto.randomUUID();
    if (action === "offer") {
      if (!toUserId) return;
      const saved = offer.current;
      if (saved?.toUserId === toUserId) operationId = saved.operationId;
      offer.current = { operationId, toUserId };
    } else {
      const saved = decision.current;
      if (saved?.action === action) operationId = saved.operationId;
      decision.current = { operationId, action };
    }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = await fetch(root, {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(action === "offer" ? { operationId, action, toUserId } : { operationId, action }),
      });
      const payload = await response.json();
      if (response.status === 401 || response.status === 403 || response.status === 404) {
        offer.current = null;
        decision.current = null;
        setDenied(true);
        setState(null);
        setError("Responsibility is not available with your current access.");
        return;
      }
      const next = acceptedResponsibility(payload);
      if (!response.ok || !next) {
        if (response.status < 500) {
          offer.current = null;
          decision.current = null;
        }
        setError(payload && typeof payload === "object" && typeof payload.error === "string" ? payload.error : "Could not update responsibility.");
        return;
      }
      if (action === "offer") offer.current = null;
      else decision.current = null;
      setState(next);
      setQuery("");
      setPeople([]);
      setChosen(null);
      setNotice(payload.replayed ? "This handover was already saved." : action === "offer" ? "Handover offered." : action === "accept" ? "You are now responsible for this record." : "Handover cancelled.");
    } catch {
      setError("Could not update responsibility.");
    } finally {
      setBusy(false);
    }
  }

  function submitOffer(event: FormEvent) {
    event.preventDefault();
    if (!chosen) return;
    void send("offer", chosen.id);
  }

  return (
    <section aria-label="Record responsibility" className="record-responsibility">
      <h3>Responsibility</h3>
      <p>Handing over responsibility does not grant access. The next person must already be able to view this record.</p>
      {state?.responsible ? <p>Responsible: {state.responsible.name}</p> : state && <p>No one is responsible for this record.</p>}
      {state?.pending && <p>Handover from {state.pending.from.name} to {state.pending.to.name} is waiting.</p>}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
      {denied && !error && <p role="alert">Responsibility is not available with your current access.</p>}
      {state?.canAccept && <button type="button" disabled={busy} onClick={() => void send("accept")}>Accept responsibility</button>}
      {state?.canCancel && <button type="button" disabled={busy} onClick={() => void send("cancel")}>Cancel handover</button>}
      {state?.canOffer && (
        <form aria-label="Hand over responsibility" onSubmit={submitOffer}>
          <label>
            Member who can view this record
            <input value={query} disabled={busy} onChange={(event) => { setQuery(event.target.value); setChosen(null); }} />
          </label>
          {!!people.length && (
            <div role="listbox" aria-label="Members who can view this record">
              {people.map((person) => (
                <button key={person.id} type="button" role="option" aria-selected={chosen?.id === person.id} onClick={() => { setChosen(person); setQuery(person.name); setPeople([]); }}>{person.name}</button>
              ))}
            </div>
          )}
          <button disabled={busy || !chosen}>Hand over responsibility</button>
        </form>
      )}
    </section>
  );
}
