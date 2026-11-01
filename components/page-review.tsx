"use client";
import { useEffect, useRef, useState } from "react";
import { Dialog } from "./editor/dialog";
import { ApiError, requestJson } from "./editor/use-document-session";
import type { PageReviewView } from "../lib/page-review";

export function PageReviewChrome({ view }: { view: PageReviewView }) {
  return <div className="page-review">
    {view.banner && <div className="review-expired-banner" role="status">{view.banner}</div>}
    {view.header && <p className="review-next">{view.header}</p>}
    {view.verified && <p className="review-verified-badge">Verified · {view.reviewerName} · {view.reviewedAtIst}</p>}
    {view.badge === "Overdue" && <p className="review-overdue-badge">Overdue</p>}
  </div>;
}

export function PageReviewHost({ pageId, workspaceId, spaceId }: { pageId: string; workspaceId: string; spaceId: string }) {
  const [view, setView] = useState<PageReviewView | null>(null);
  const [open, setOpen] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const pending = useRef<{ id: string; body: string } | null>(null);
  const load = async () => {
    const data = await requestJson<PageReviewView>(`/api/v1/pages/${encodeURIComponent(pageId)}/review`);
    setView(data);
    setError("");
    return data;
  };
  useEffect(() => {
    let alive = true;
    void requestJson<PageReviewView>(`/api/v1/pages/${encodeURIComponent(pageId)}/review`).then(data => { if (alive) setView(data); }).catch(() => { if (alive) setView(null); });
    return () => { alive = false; };
  }, [pageId]);
  function operationId(body: string) {
    if (pending.current?.body === body) return pending.current.id;
    const id = crypto.randomUUID();
    pending.current = { id, body };
    return id;
  }
  async function send(fields: Record<string, unknown>) {
    const payload = JSON.stringify(fields);
    setBusy(true);
    setError("");
    try {
      await requestJson(`/api/v1/pages/${encodeURIComponent(pageId)}/review`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...fields, operationId: operationId(payload) }) });
      pending.current = null;
      await load();
      setOpen(false);
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "Review status is unavailable.");
    } finally {
      setBusy(false);
    }
  }
  if (!view || (!view.canManage && !view.header && !view.banner && !view.verified && view.badge !== "Overdue")) return null;
  return <>
    <PageReviewChrome view={view} />
    {view.canManage && <p className="review-actions"><button type="button" onClick={() => { setError(""); setOpen(true); }}>Review settings</button> <a href={`/workspaces/${encodeURIComponent(workspaceId)}/spaces/${encodeURIComponent(spaceId)}/reviews`}>Space reviews</a></p>}
    {open && <ReviewSettings view={view} busy={busy} error={error} onClose={() => { if (!busy) setOpen(false); }} onSave={send} />}
  </>;
}

function ReviewSettings({ view, busy, error, onClose, onSave }: { view: PageReviewView; busy: boolean; error: string; onClose: () => void; onSave: (fields: Record<string, unknown>) => Promise<void> }) {
  const [months, setMonths] = useState(String(view.cycleMonths ?? 6));
  const [startsOn, setStartsOn] = useState(view.startsOn ?? "");
  const [expiresOn, setExpiresOn] = useState(view.expiresOn ?? "");
  const [note, setNote] = useState("");
  return <Dialog title="Review settings" onClose={onClose}><form className="review-settings" onSubmit={event => { event.preventDefault(); void onSave({ action: "set", cycleMonths: Number(months), startsOn, expiresOn }); }}>
    <p>Set the review cycle and expiry. Dates use the workspace calendar (IST). Expiry flags the page for readers and does not unpublish it.</p>
    {error && <p className="form-error" role="alert">{error}</p>}
    <label>Review every <input aria-label="Review cycle months" type="number" min={1} max={120} required value={months} onChange={event => setMonths(event.target.value)} /> months</label>
    <label>Starting <input aria-label="Review start date" type="date" required value={startsOn} onChange={event => setStartsOn(event.target.value)} /></label>
    <label>Expires <input aria-label="Expiry date" type="date" required value={expiresOn} onChange={event => setExpiresOn(event.target.value)} /></label>
    <button type="submit" disabled={busy}>Save review cycle</button>
    {view.cycleMonths && <div className="review-mark">
      <label>Review note <textarea aria-label="Review note" maxLength={500} required={false} value={note} onChange={event => setNote(event.target.value)} /></label>
      <button type="button" disabled={busy || !note.trim()} onClick={() => void onSave({ action: "mark-reviewed", note: note.trim() })}>Mark as reviewed</button>
    </div>}
  </form></Dialog>;
}
