'use client';
import { useEffect, useRef, useState } from 'react';
import { Dialog } from './editor/rich-editor';
import { ApiError, requestJson } from './editor/use-document-session';

type Hit = {
  filename: string; page: number; snippet?: string; versionId: string; versionNo: number; fileId: string; recordId: string;
  language: string; status: string; recognition: 'text' | 'ocr'; ocrError: boolean; ocrErrors: string[]; exact: boolean; pinned: boolean;
  canDownload?: boolean; canHistory?: boolean; text?: string;
};
type FileRow = { fileId: string; filename: string; versionId: string; versionNo: number; recordId: string; status: string | null; language: string; version: number; canReindex: boolean; canDownload: boolean; canHistory: boolean };
type Config = { language: 'en'; enabled: boolean; version: number; manage: boolean; boundary: string; assignment: string; recoverableDraft: { language: 'en'; enabled: boolean; baseVersion: number } | null };
const control = { minHeight: 44, minWidth: 44 };

export default function AttachmentTextDialog({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const [config, setConfig] = useState<Config | null>(null);
  const [files, setFiles] = useState<FileRow[]>([]);
  const [fileId, setFileId] = useState('');
  const [query, setQuery] = useState('');
  const [hits, setHits] = useState<Hit[]>([]);
  const [openHit, setOpenHit] = useState<Hit | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [history, setHistory] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirm, setConfirm] = useState(false);
  const alive = useRef(true);
  const ops = useRef<Record<string, string>>({});
  const root = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/attachment-text`;

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
  function failed(reason: unknown) {
    setError(reason instanceof Error ? reason.message : 'Attachment text is unavailable.');
    if (!(reason instanceof ApiError) || reason.status >= 500) return;
    ops.current = {};
  }

  async function load() {
    const [next, catalogue] = await Promise.all([
      requestJson<Config>(`${root}?view=config`),
      requestJson<{ files: FileRow[] }>(`${root}?view=catalogue`),
    ]);
    if (!alive.current) return;
    setConfig(next);
    setEnabled(next.recoverableDraft?.enabled ?? next.enabled);
    setFiles(catalogue.files);
    setFileId(current => current || catalogue.files[0]?.fileId || '');
  }

  useEffect(() => {
    let ignore = false;
    void load().catch(reason => { if (!ignore && alive.current) setError(reason instanceof Error ? reason.message : 'Attachment text is unavailable.'); });
    return () => { ignore = true; };
  }, [workspaceId]);

  async function search() {
    if (busy) return;
    if (query.trim().length < 2) { setError('Enter at least two characters.'); return; }
    setBusy(true);
    setError('');
    try {
      const result = await requestJson<{ hits: Hit[] }>(`${root}?q=${encodeURIComponent(query.trim())}`);
      if (!alive.current) return;
      setHits(result.hits);
      setOpenHit(null);
      setNotice(result.hits.length ? '' : 'No permitted attachment text matched.');
    } catch (reason) { if (alive.current) failed(reason); } finally { if (alive.current) setBusy(false); }
  }

  async function openResult(hit: Hit) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const preview = await requestJson<Hit>(`${root}?view=preview&recordId=${encodeURIComponent(hit.recordId)}&versionId=${encodeURIComponent(hit.versionId)}&page=${hit.page}`);
      if (alive.current) setOpenHit(preview);
    } catch (reason) { if (alive.current) failed(reason); } finally { if (alive.current) setBusy(false); }
  }

  async function command(key: string, body: Record<string, unknown>, done: string) {
    if (busy) return;
    const operationId = operation(key);
    setBusy(true);
    setError('');
    try {
      await requestJson(root, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, operationId }) });
      if (!alive.current) return;
      clearOperation(key);
      setConfirm(false);
      setNotice(done);
      await load();
    } catch (reason) { if (alive.current) failed(reason); } finally { if (alive.current) setBusy(false); }
  }

  async function download(hit: Hit) {
    if (busy || !hit.canDownload) return;
    const operationId = operation(`download:${hit.versionId}`);
    setBusy(true);
    setError('');
    try {
      const response = await fetch(root, { method: 'POST', cache: 'no-store', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'download', operationId, recordId: hit.recordId, versionId: hit.versionId }) });
      if (!response.ok) {
        const data = await response.json() as { error?: string };
        throw new ApiError(data.error ?? 'Download unavailable', response.status, 'error', 0);
      }
      const version = response.headers.get('x-hs-attachment-version');
      if (version && version !== String(hit.versionNo)) throw new ApiError('The download was not the pinned version.', 409, 'attachment_text_integrity', 0);
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = hit.filename || 'attachment';
      link.click();
      URL.revokeObjectURL(url);
      if (alive.current) { clearOperation(`download:${hit.versionId}`); setNotice(`Download started for version ${hit.versionNo}, page ${hit.page}.`); }
    } catch (reason) { if (alive.current) failed(reason); } finally { if (alive.current) setBusy(false); }
  }

  const selected = files.find(file => file.fileId === fileId) ?? null;

  return <Dialog title="Attachment text" onClose={() => { if (!busy) onClose(); }}>
    <div className="export-dialog attachment-text-dialog">
      <p>{config?.boundary ?? 'Text is extracted and recognised inside this workspace. No generative model, summary, field extraction, record update, or external processor is used.'} {config?.assignment ?? 'Assigning a text index manager does not grant access to a file, record, or field.'}</p>
      <label>Find text
        <input aria-label="Attachment text query" value={query} disabled={busy} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Enter') void search(); }} />
      </label>
      <div className="actions">
        <button type="button" style={control} disabled={busy} onClick={() => void search()}>Search attachments</button>
      </div>
      <ul aria-label="Attachment text results">
        {hits.map(hit => <li key={`${hit.versionId}:${hit.page}`}>
          <p>{hit.filename} · page {hit.page} · version {hit.versionNo} · {hit.language} · {hit.status}{hit.pinned ? ' · pinned version' : ' · exact version'}</p>
          <p>{hit.snippet}</p>
          {hit.ocrError && <p role="status">OCR error: {hit.ocrErrors.join('; ')}</p>}
          <button type="button" style={control} disabled={busy} onClick={() => void openResult(hit)}>Open page {hit.page}</button>
        </li>)}
      </ul>
      {openHit && <section aria-label="Pinned attachment page">
        <p>{openHit.filename} · version {openHit.versionNo} · page {openHit.page} · {openHit.language} · {openHit.status} · {openHit.exact ? 'Opens this exact version' : ''}{openHit.pinned ? ' · record pin matches' : ''}</p>
        {openHit.ocrError && <p role="status">OCR error: {openHit.ocrErrors.join('; ')}</p>}
        <pre aria-label="Attachment page text">{openHit.text}</pre>
        <div className="actions">
          {openHit.canDownload && <button type="button" style={control} disabled={busy} onClick={() => void download(openHit)}>Download version</button>}
          {openHit.canHistory && <button type="button" style={control} disabled={busy} onClick={() => void requestJson<{ events: { action: string; actorName: string; atIst: string; source: string }[] }>(`${root}?view=history&recordId=${encodeURIComponent(openHit.recordId)}&fileId=${encodeURIComponent(openHit.fileId)}`).then(value => { if (alive.current) setHistory(value.events.map(event => `${event.action} · ${event.actorName} · ${event.atIst} · ${event.source}`).join('\n')); }).catch(failed)}>Text history</button>}
        </div>
      </section>}
      <label>Permitted files
        <select aria-label="Attachment files" value={fileId} disabled={busy} onChange={event => { setFileId(event.target.value); setConfirm(false); }}>
          <option value="">Choose a file</option>
          {files.map(file => <option key={`${file.fileId}:${file.recordId}`} value={file.fileId}>{file.filename} · {file.status ?? 'not indexed'} · {file.language}</option>)}
        </select>
      </label>
      {selected?.canReindex && <div className="actions">
        {confirm ? <button type="button" style={control} disabled={busy} onClick={() => void command('reindex', { action: 'reindex', items: [{ recordId: selected.recordId, fileId: selected.fileId, ...(selected.version ? { expectedVersion: selected.version } : {}) }] }, 'Index saved. The source file was not changed.')}>Confirm reindex</button> : <button type="button" style={control} disabled={busy} onClick={() => setConfirm(true)}>Reindex file</button>}
      </div>}
      {config?.manage && <section aria-label="Attachment text configuration">
        <p>Configuration version {config.version}. Language is English. {config.recoverableDraft ? 'A recoverable draft is kept.' : ''}</p>
        <label className="check"><input type="checkbox" checked={enabled} disabled={busy} onChange={event => setEnabled(event.target.checked)} /> Indexing enabled</label>
        <div className="actions">
          <button type="button" style={control} disabled={busy} onClick={() => void command('save', { action: 'save', expectedVersion: config.version, enabled, language: 'en' }, 'Configuration saved.')}>Save configuration</button>
          <button type="button" style={control} disabled={busy} onClick={() => void command('stash', { action: 'stash', expectedVersion: config.version, enabled, language: 'en' }, 'Draft kept. Cancel leaves the saved configuration unchanged.')}>Keep draft</button>
          <button type="button" style={control} disabled={busy} onClick={() => void requestJson<{ events: { action: string; actorName: string; atIst: string; source: string }[] }>(`${root}?view=config-history`).then(value => { if (alive.current) setHistory(value.events.map(event => `${event.action} · ${event.actorName} · ${event.atIst} · ${event.source}`).join('\n')); }).catch(failed)}>Configuration history</button>
        </div>
      </section>}
      {history && <pre aria-label="Attachment text history">{history}</pre>}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
      <button type="button" style={control} disabled={busy} onClick={onClose}>Cancel</button>
    </div>
  </Dialog>;
}
