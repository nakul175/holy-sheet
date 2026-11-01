"use client";
import { useEffect, useState } from "react";
import { Dialog } from "./dialog";
import { requestJson } from "./use-document-session";

type PickerSnippet = { id: string; title: string; versions: { number: number }[] };

export function SnippetPicker({ pageId, onClose }: { pageId: string; onClose: () => void }) {
  const [snippets, setSnippets] = useState<PickerSnippet[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    requestJson<{ snippets: PickerSnippet[] }>(`/api/v1/pages/${encodeURIComponent(pageId)}/snippets?picker=1`).then(data => {
      if (live) setSnippets(data.snippets);
    }).catch(reason => {
      if (live) setError(reason instanceof Error ? reason.message : "Snippets are unavailable");
    }).finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [pageId]);
  async function insert(snippetId: string, pinVersion: number | null) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await requestJson(`/api/v1/pages/${encodeURIComponent(pageId)}/snippets`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "insert", operationId: crypto.randomUUID(), snippetId, pinVersion }) });
      window.location.reload();
    } catch (reason) {
      setBusy(false);
      setError(reason instanceof Error ? reason.message : "Snippet is restricted or unavailable");
    }
  }
  return <Dialog title="Insert snippet" onClose={onClose}>
    {loading && <p role="status">Loading approved snippets…</p>}
    {error && <p role="alert">{error}</p>}
    {!loading && !snippets.length && !error && <p>No approved snippets are available.</p>}
    <ul aria-label="Approved snippets">{snippets.map(snippet => <li key={snippet.id}><strong>{snippet.title}</strong><div className="actions"><button type="button" disabled={busy} onClick={() => void insert(snippet.id, null)}>Follow latest</button>{snippet.versions.map(version => <button type="button" key={version.number} disabled={busy} onClick={() => void insert(snippet.id, version.number)}>Pin v{version.number}</button>)}</div></li>)}</ul>
  </Dialog>;
}
