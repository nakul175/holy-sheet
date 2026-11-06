'use client';
import { useEffect, useRef, useState } from 'react';
import { Dialog } from './editor/rich-editor';
import { ApiError, requestJson } from './editor/use-document-session';
import { captureStorageKey, readLocalCapture, rememberLocalCapture, type LocalCaptureDraft } from '../lib/quick-capture-local';

type Catalogue = {
  actorId: string;
  manage: boolean;
  boundary: string;
  assignment: string;
  sharing: string;
  offline: string;
  schedules: string;
  recoverable: string;
  provenance: string;
  assets: string;
  policy: { version: number; kinds: string[]; defaultDestination: string; visibility: string; inheritExternal: boolean; offlinePolicy: string; recoverableDraft: { kinds: string[] } | null } | null;
  destinations: { spaces: { id: string; name: string }[]; forms: { id: string; name: string; collection: string }[] };
  defaultDestination: { kind: 'space' | 'intake'; id: string; name: string } | null;
  captures: { id: string; title: string; kind: string; sourceAccess: string; version: number }[];
  drafts: { draftKey: string; payload: { text?: string; sourceAccess?: string } }[];
};
type Preview = { previewId: string; action: string; review: string; version: number; text: string; audience: string; externalShare: boolean; sourceStatement: string };

const control = { minHeight: 44, minWidth: 44 };

export default function QuickCaptureDialog({ workspaceId, pageId, onClose }: { workspaceId: string; pageId: string; onClose: () => void }) {
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null);
  const [kind, setKind] = useState<'text' | 'link' | 'note'>('text');
  const [title, setTitle] = useState('Captured note');
  const [body, setBody] = useState('');
  const [sourceUrl, setSourceUrl] = useState('');
  const [sourceTitle, setSourceTitle] = useState('');
  const [destination, setDestination] = useState('');
  const [assetName, setAssetName] = useState('');
  const [assetSelected, setAssetSelected] = useState(false);
  const [captureId, setCaptureId] = useState('');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<{ id: string; title: string; kind: string; sourceAccess: string }[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [history, setHistory] = useState('');
  const [source, setSource] = useState('');
  const [download, setDownload] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirm, setConfirm] = useState(false);
  const alive = useRef(true);
  const ops = useRef<Record<string, string>>({});
  const root = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/quick-capture`;

  useEffect(() => {
    alive.current = true;
    const logout = () => { alive.current = false; onClose(); };
    window.addEventListener('holy-sheet:logout', logout);
    return () => { alive.current = false; window.removeEventListener('holy-sheet:logout', logout); };
  }, [onClose]);

  function operation(key: string) {
    ops.current[key] ??= crypto.randomUUID();
    return ops.current[key];
  }
  function clearOperation(key: string) { delete ops.current[key]; }
  function failed(reasonValue: unknown) {
    setError(reasonValue instanceof Error ? reasonValue.message : 'Quick capture is restricted or unavailable.');
    if (!(reasonValue instanceof ApiError) || reasonValue.status >= 500) return;
    ops.current = {};
  }
  function destinationValue(value: Catalogue | null) {
    if (destination) return destination;
    if (!value?.defaultDestination) return '';
    return `${value.defaultDestination.kind}:${value.defaultDestination.id}`;
  }
  async function load() {
    const value = await requestJson<Catalogue>(root);
    if (!alive.current) return value;
    setCatalogue(value);
    setDestination(current => current || (value.defaultDestination ? `${value.defaultDestination.kind}:${value.defaultDestination.id}` : ''));
    return value;
  }
  useEffect(() => {
    let ignore = false;
    void load().catch(reasonValue => { if (!ignore && alive.current) setError(reasonValue instanceof Error ? reasonValue.message : 'Quick capture is restricted or unavailable.'); });
    return () => { ignore = true };
  }, [workspaceId]);

  const selected = catalogue?.captures.find(item => item.id === captureId) ?? null;
  const [destinationKind, destinationId] = (destination || destinationValue(catalogue)).split(':');
  async function post(key: string, payload: Record<string, unknown>) {
    setBusy(true);
    setError('');
    try {
      const result = await requestJson<Record<string, unknown>>(root, { method: 'POST', body: JSON.stringify({ ...payload, operationId: operation(key) }) });
      if (!alive.current) return result;
      clearOperation(key);
      setNotice('Saved.');
      await load();
      return result;
    } catch (reasonValue) {
      if (alive.current) failed(reasonValue);
      return null;
    } finally {
      if (alive.current) setBusy(false);
    }
  }
  function keepLocal() {
    if (!catalogue) return;
    const draft: LocalCaptureDraft = {
      version: 1, policy: 'local-draft', authoritative: false, actorId: catalogue.actorId, workspaceId, operationId: operation('offline'),
      kind, title, body, sourceUrl, sourceTitle, sourceAccess: 'not-opened', destinationKind: destinationKind === 'intake' ? 'intake' : destinationKind === 'space' ? 'space' : '',
      destinationId: destinationId ?? '', savedAt: new Date().toISOString(),
    };
    try {
      const key = captureStorageKey(catalogue.actorId, workspaceId);
      const current = readLocalCapture(JSON.parse(localStorage.getItem(key) || 'null'), catalogue.actorId, workspaceId);
      const saved = rememberLocalCapture(current, draft);
      localStorage.setItem(key, JSON.stringify(saved.store));
      setError('');
      setNotice(saved.replayed ? 'This device already has this draft. It was not sent.' : 'Saved on this device. Not sent. The source address was not opened.');
    } catch (reasonValue) {
      setNotice('');
      setError(reasonValue instanceof Error ? reasonValue.message : 'The local draft is kept.');
    }
  }

  return <Dialog title="Quick capture" onClose={() => { if (!busy) onClose(); }}>
    <div className="quick-capture-dialog">
      <p>{catalogue?.boundary ?? 'Quick capture saves only the text, link, or note you select. It does not browse, watch, or fetch a page for you.'}</p>
      <p>{catalogue?.assignment ?? 'Configuring capture or naming an operator does not grant access to a page, record, collection, space, or field.'}</p>
      <p>{catalogue?.sharing ?? 'The default destination is private and permitted. Capture does not inherit external sharing.'}</p>
      <p>{catalogue?.offline ?? 'An offline capture stays as a local draft on this device. It is not an authoritative save until a permitted destination accepts it.'}</p>
      <p>{catalogue?.schedules ?? 'Existing schedules stay paused. Capture does not activate a schedule.'}</p>
      <p>{catalogue?.recoverable ?? 'A recoverable draft is kept when the version changes.'}</p>
      <p>{catalogue?.provenance ?? 'Each capture records the source address, title, and time you supply. Pages by Aplyd does not open that address.'}</p>
      <p>{catalogue?.assets ?? 'Source assets are imported only when you select them. Remote images, hidden form values, and cookies are not collected.'}</p>
      {catalogue?.drafts.length ? <p>A recoverable draft is kept for this capture.</p> : null}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <fieldset>
        <label><span>Kind</span><select aria-label="Capture kind" value={kind} disabled={busy} onChange={event => setKind(event.target.value as 'text' | 'link' | 'note')}><option value="text">Text</option><option value="link">Link</option><option value="note">Note</option></select></label>
        <label><span>Title</span><input aria-label="Capture title" value={title} disabled={busy} onChange={event => setTitle(event.target.value)} /></label>
        <label><span>Selection</span><textarea aria-label="Capture text" value={body} disabled={busy} onChange={event => setBody(event.target.value)} /></label>
        <label><span>Source address</span><input aria-label="Capture source address" inputMode="url" value={sourceUrl} disabled={busy} onChange={event => setSourceUrl(event.target.value)} /></label>
        <label><span>Source title</span><input aria-label="Capture source title" value={sourceTitle} disabled={busy} onChange={event => setSourceTitle(event.target.value)} /></label>
        <label><span>Page</span><input aria-label="Capture source page" value={pageId} readOnly /></label>
        <label><span>Destination</span><select aria-label="Capture destination" value={destination || destinationValue(catalogue)} disabled={busy} onChange={event => setDestination(event.target.value)}>{(catalogue?.destinations.spaces ?? []).map(space => <option key={space.id} value={`space:${space.id}`}>{space.name}</option>)}{(catalogue?.destinations.forms ?? []).map(form => <option key={form.id} value={`intake:${form.id}`}>{form.name}</option>)}</select></label>
        <label><span>Asset</span><input aria-label="Capture asset name" value={assetName} disabled={busy} onChange={event => setAssetName(event.target.value)} /></label>
        <label><span>Select asset</span><input aria-label="Capture asset selected" type="checkbox" checked={assetSelected} disabled={busy} onChange={event => setAssetSelected(event.target.checked)} /></label>
        <label><span>Saved capture</span><select aria-label="Saved capture" value={captureId} disabled={busy} onChange={event => { setCaptureId(event.target.value); setPreview(null); setConfirm(false); }}><option value="">Choose a capture</option>{(catalogue?.captures ?? []).map(item => <option key={item.id} value={item.id}>{item.kind} · {item.title}</option>)}</select></label>
        <label><span>Search</span><input aria-label="Capture search" value={query} disabled={busy} onChange={event => setQuery(event.target.value)} /></label>
      </fieldset>
      {selected && <section aria-label="Capture scope"><p>Audience private. Source access {selected.sourceAccess}. External sharing is not inherited.</p></section>}
      <div className="actions">
        <button type="button" style={control} disabled={busy} onClick={() => { setConfirm(true); setPreview(null); }}>Review capture</button>
        {confirm && <button type="button" style={control} disabled={busy} onClick={() => void post('preview', { action: 'preview', expectedVersion: catalogue?.policy?.version ?? 0, kind, title, body, sourceUrl, sourceTitle, sourcePageId: pageId, destinationKind, destinationId, assets: assetName ? [{ name: assetName, selected: assetSelected }] : [] }).then(result => { if (result?.previewId) setPreview(result as Preview); })}>Confirm review</button>}
        {preview?.action === 'capture' && <button type="button" style={control} disabled={busy} onClick={() => void post('apply', { action: 'apply', previewId: preview.previewId, expectedVersion: preview.version }).then(() => { setPreview(null); setConfirm(false); })}>Confirm capture</button>}
        <button type="button" style={control} disabled={busy || !catalogue} onClick={keepLocal}>Keep on this device</button>
        <button type="button" style={control} disabled={busy} onClick={() => { setBusy(true); setError(''); void requestJson<{ results: { id: string; title: string; kind: string; sourceAccess: string }[] }>(`${root}?view=search&q=${encodeURIComponent(query)}`).then(value => { if (alive.current) setResults(value.results); }).catch(reasonValue => { if (alive.current) failed(reasonValue); }).finally(() => { if (alive.current) setBusy(false); }); }}>Search captures</button>
        <button type="button" style={control} disabled={busy || !selected} onClick={() => { if (!selected) return; setBusy(true); void requestJson<{ events: { action: string; source: string; atIst: string; sourceAccess: string | null }[] }>(`${root}?view=history&captureId=${encodeURIComponent(selected.id)}`).then(value => { if (alive.current) setHistory(value.events.map(event => `${event.action} ${event.source} ${event.atIst} ${event.sourceAccess ?? ''}`).join('\n')); }).catch(reasonValue => { if (alive.current) failed(reasonValue); }).finally(() => { if (alive.current) setBusy(false); }); }}>Capture history</button>
        <button type="button" style={control} disabled={busy || !selected} onClick={() => { if (!selected) return; setBusy(true); void requestJson<{ text: string; sourceStatement: string; visibility: string }>(`${root}?view=source&captureId=${encodeURIComponent(selected.id)}`).then(value => { if (alive.current) setSource(`${value.visibility}. ${value.sourceStatement} ${value.text}`); }).catch(reasonValue => { if (alive.current) failed(reasonValue); }).finally(() => { if (alive.current) setBusy(false); }); }}>Source preview</button>
        <button type="button" style={control} disabled={busy || !selected} onClick={() => { if (!selected) return; void post('download', { action: 'download', captureId: selected.id, expectedVersion: selected.version }).then(result => { if (result && typeof result.body === 'string') setDownload(result.body); }); }}>Download capture</button>
        <button type="button" style={control} disabled={busy} onClick={onClose}>Cancel</button>
      </div>
      <ul aria-label="Capture search results">{results.map(result => <li key={result.id}>{result.kind} · {result.title} · {result.sourceAccess}</li>)}</ul>
      {preview && <section aria-label="Capture preview"><p>{preview.review}</p><p>Audience {preview.audience}. External sharing {preview.externalShare ? 'yes' : 'no'}.</p><p>{preview.sourceStatement}</p><pre>{preview.text}</pre></section>}
      {history && <pre aria-label="Capture history">{history}</pre>}
      {source && <pre aria-label="Capture source preview">{source}</pre>}
      {download && <pre aria-label="Capture download">{download}</pre>}
    </div>
  </Dialog>;
}
