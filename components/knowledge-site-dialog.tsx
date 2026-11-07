'use client';
import {applicationDisplayName} from '../lib/application-display-name';
import { useEffect, useRef, useState } from 'react';
import { Dialog } from './editor/rich-editor';
import { ApiError, requestJson } from './editor/use-document-session';

type Site = { id: string; name: string; status: string; version: number; sharing: string; liveSite: boolean; domain: null; audienceConfirmed: boolean; schedulesPaused: boolean; paths: string[] };
type Catalogue = {
  boundary: string;
  assignment: string;
  audience: string;
  live: string;
  schedules: string;
  recoverable: string;
  edge: string;
  cacheBound: string;
  retraction: string;
  quarantine: string;
  sites: Site[];
  drafts: { siteKey: string; kind: string }[];
};
type Preview = { sharing?: string; liveSite?: boolean; accessGranted?: boolean; dryRun?: boolean; publicText?: string; manifest?: { kind: string; reason: string }[]; projection?: { cache?: string } };

const control = { minHeight: 44, minWidth: 44 };

export default function KnowledgeSiteDialog({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null);
  const [name, setName] = useState('Help centre');
  const [pageId, setPageId] = useState('');
  const [revision, setRevision] = useState('1');
  const [path, setPath] = useState('help/start');
  const [label, setLabel] = useState('Start');
  const [mediaId, setMediaId] = useState('');
  const [recordId, setRecordId] = useState('');
  const [fieldKey, setFieldKey] = useState('core:notes');
  const [siteId, setSiteId] = useState('');
  const [query, setQuery] = useState('');
  const [audience, setAudience] = useState(false);
  const [results, setResults] = useState<{ id: string; name: string; status: string; sharing: string }[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [history, setHistory] = useState('');
  const [download, setDownload] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmSave, setConfirmSave] = useState(false);
  const [confirmPublish, setConfirmPublish] = useState(false);
  const [confirmUnpublish, setConfirmUnpublish] = useState(false);
  const [confirmRollback, setConfirmRollback] = useState(false);
  const alive = useRef(true);
  const ops = useRef<Record<string, string>>({});
  const root = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/knowledge-sites`;

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
    setError(reasonValue instanceof Error ? reasonValue.message : 'Knowledge sites are restricted or unavailable.');
    if (!(reasonValue instanceof ApiError) || reasonValue.status >= 500) return;
    ops.current = {};
  }
  async function load() {
    const value = await requestJson<Catalogue>(root);
    if (!alive.current) return value;
    setCatalogue(value);
    return value;
  }
  useEffect(() => {
    let ignore = false;
    void load().catch(reasonValue => { if (!ignore && alive.current) setError(reasonValue instanceof Error ? reasonValue.message : 'Knowledge sites are restricted or unavailable.'); });
    return () => { ignore = true; };
  }, [workspaceId]);

  const selected = catalogue?.sites.find(item => item.id === siteId) ?? null;
  function definition() {
    const assets = mediaId.trim() ? [{ mediaId: mediaId.trim(), pageId: pageId.trim() }] : [];
    const records = recordId.trim() ? [{ recordId: recordId.trim(), fields: [fieldKey.trim()] }] : [];
    return {
      pages: [{ pageId: pageId.trim(), revision: Number(revision), path, label }],
      navigation: [{ path, label, parent: null }],
      assets,
      records,
      edge: { cache: 'no-store', residency: 'tenant', public: false },
      cacheBoundSeconds: 0,
    };
  }
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

  return <Dialog title="Knowledge sites" onClose={() => { if (!busy) onClose(); }}>
    <div className="knowledge-site-dialog">
      <p>{catalogue?.boundary ?? 'A knowledge site publishes a reviewed subset of approved page revisions, paths, and navigation. It does not open a live public site, domain, or share.'}</p>
      <p>{catalogue?.assignment ?? 'Configuring a site, naming a publisher, or assigning a page, record, or asset does not grant access.'}</p>
      <p>{catalogue?.audience ?? 'Publish needs the separate publish capability and an explicit public-audience confirmation. Internal edits never publish themselves.'}</p>
      <p>{catalogue?.live ?? 'No public site, domain, or sharing is enabled by this task.'}</p>
      <p>{catalogue?.schedules ?? 'Existing schedules stay paused. Knowledge sites do not activate a schedule.'}</p>
      <p>{catalogue?.recoverable ?? 'A recoverable draft is kept when the version changes.'}</p>
      <p>{catalogue?.edge ?? 'Knowledge-site responses stay with the tenant and use cache no-store. Public caching is off.'}</p>
      <p>{catalogue?.quarantine ?? 'An asset is served only when it is pinned to the approved revision and its scan is clean. Direct asset URLs are removed.'}</p>
      <p>{catalogue?.retraction ?? 'Unpublish and rollback do not retract copies already held by a third party.'}</p>
      <p>{catalogue?.cacheBound ?? 'Responses use cache no-store and a zero-second bound.'}</p>
      {catalogue?.drafts.length ? <p>A recoverable draft is kept for this knowledge site.</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      <fieldset>
        <label><span>Name</span><input aria-label="Knowledge site name" value={name} disabled={busy} onChange={event => setName(event.target.value)} /></label>
        <label><span>Page</span><input aria-label="Approved page" value={pageId} disabled={busy} onChange={event => setPageId(event.target.value)} /></label>
        <label><span>Revision</span><input aria-label="Approved revision" inputMode="numeric" value={revision} disabled={busy} onChange={event => setRevision(event.target.value)} /></label>
        <label><span>Path</span><input aria-label="Public path" value={path} disabled={busy} onChange={event => setPath(event.target.value)} /></label>
        <label><span>Label</span><input aria-label="Navigation label" value={label} disabled={busy} onChange={event => setLabel(event.target.value)} /></label>
        <label><span>Asset</span><input aria-label="Pinned asset" value={mediaId} disabled={busy} onChange={event => setMediaId(event.target.value)} /></label>
        <label><span>Record</span><input aria-label="Included record" value={recordId} disabled={busy} onChange={event => setRecordId(event.target.value)} /></label>
        <label><span>Field</span><input aria-label="Included field" value={fieldKey} disabled={busy} onChange={event => setFieldKey(event.target.value)} /></label>
        <label><span>Site</span><select aria-label="Saved knowledge site" value={siteId} disabled={busy} onChange={event => { setSiteId(event.target.value); setPreview(null); setConfirmSave(false); setConfirmPublish(false); setConfirmUnpublish(false); setConfirmRollback(false); }}><option value="">Choose a site</option>{(catalogue?.sites ?? []).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label><span>Search</span><input aria-label="Knowledge site search" value={query} disabled={busy} onChange={event => setQuery(event.target.value)} /></label>
        <label><span>Audience</span><input aria-label="Public audience confirmation" type="checkbox" checked={audience} disabled={busy} onChange={event => setAudience(event.target.checked)} /></label>
      </fieldset>
      {selected ? <section aria-label="Knowledge site summary"><p>Status {selected.status}. Sharing {selected.sharing}. Live site {selected.liveSite ? 'yes' : 'no'}. Domain none. Audience confirmed {selected.audienceConfirmed ? 'yes' : 'no'}. Schedules paused {selected.schedulesPaused ? 'yes' : 'no'}. Paths {selected.paths.join(', ') || 'none'}. Configuration does not grant access.</p></section> : null}
      <div className="actions">
        <button type="button" style={control} disabled={busy} onClick={() => { setConfirmSave(true); setPreview(null); }}>Review site</button>
        {confirmSave ? <button type="button" style={control} disabled={busy} onClick={() => void post('configure', { action: 'configure', expectedVersion: selected?.version ?? 0, siteId: siteId || undefined, name, definition: definition() }).then(result => { if (result) setPreview(result as Preview); })}>Confirm site</button> : null}
        <button type="button" style={control} disabled={busy || !selected} onClick={() => { if (!selected) return; void post('preview', { action: 'preview', siteId: selected.id, expectedVersion: selected.version }).then(result => { if (result) setPreview(result as Preview); }); }}>Public preview</button>
        <button type="button" style={control} disabled={busy || !selected} onClick={() => setConfirmPublish(true)}>Review publish</button>
        {confirmPublish && selected ? <button type="button" style={control} disabled={busy || !audience} onClick={() => void post('publish', { action: 'publish', siteId: selected.id, expectedVersion: selected.version, audience: 'public' })}>Confirm public audience</button> : null}
        <button type="button" style={control} disabled={busy || !selected} onClick={() => setConfirmUnpublish(true)}>Unpublish site</button>
        {confirmUnpublish && selected ? <button type="button" style={control} disabled={busy} onClick={() => void post('unpublish', { action: 'unpublish', siteId: selected.id, expectedVersion: selected.version })}>Confirm unpublish</button> : null}
        <button type="button" style={control} disabled={busy || !selected} onClick={() => setConfirmRollback(true)}>Roll back site</button>
        {confirmRollback && selected ? <button type="button" style={control} disabled={busy} onClick={() => void post('rollback', { action: 'rollback', siteId: selected.id, expectedVersion: selected.version })}>Confirm rollback</button> : null}
        <button type="button" style={control} disabled={busy} onClick={() => { setBusy(true); setError(''); void requestJson<{ results: { id: string; name: string; status: string; sharing: string }[] }>(`${root}?view=search&q=${encodeURIComponent(query)}`).then(value => { if (alive.current) setResults(value.results); }).catch(reasonValue => { if (alive.current) failed(reasonValue); }).finally(() => { if (alive.current) setBusy(false); }); }}>Search knowledge sites</button>
        <button type="button" style={control} disabled={busy || !selected} onClick={() => { if (!selected) return; setBusy(true); void requestJson<{ events: { action: string; source: string; atIst: string }[] }>(`${root}?view=history&siteId=${encodeURIComponent(selected.id)}`).then(value => { if (alive.current) setHistory(value.events.map(event => `${event.action} ${applicationDisplayName(event.source)} ${event.atIst}`).join('\n')); }).catch(reasonValue => { if (alive.current) failed(reasonValue); }).finally(() => { if (alive.current) setBusy(false); }); }}>Site history</button>
        <button type="button" style={control} disabled={busy || !selected} onClick={() => { if (!selected) return; void post('download', { action: 'download', siteId: selected.id, expectedVersion: selected.version }).then(result => { if (result && typeof result.body === 'string') setDownload(result.body); }); }}>Download site</button>
        <button type="button" style={control} disabled={busy} onClick={onClose}>Cancel</button>
      </div>
      <ul aria-label="Knowledge site search results">{results.map(result => <li key={result.id}>{result.name} · {result.status} · {result.sharing}</li>)}</ul>
      {preview ? <section aria-label="Public preview"><p>Sharing {preview.sharing ?? 'off'}. Live site {preview.liveSite ? 'yes' : 'no'}. Dry run {preview.dryRun === false ? 'no' : 'yes'}. Access granted {preview.accessGranted ? 'yes' : 'no'}. Cache {preview.projection?.cache ?? 'no-store'}. Sensitive dependencies {preview.manifest?.length ?? 0}. {preview.publicText ?? ''}</p></section> : null}
      {history ? <pre aria-label="Knowledge site history">{history}</pre> : null}
      {download ? <pre aria-label="Knowledge site download">{download}</pre> : null}
    </div>
  </Dialog>;
}
