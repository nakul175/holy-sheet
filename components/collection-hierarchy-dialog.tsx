'use client';
import { useEffect, useRef, useState } from 'react';
import { Dialog } from './editor/rich-editor';
import { ApiError, requestJson } from './editor/use-document-session';

type Draft = { enabled: boolean; allowRoots: boolean; depthLimit: number; baseVersion: number };
type Config = { collection: string; name: string; eligible: boolean; enabled: boolean; allowRoots: boolean; depthLimit: number; version: number; recoverableDraft?: Draft | null };
type Catalogue = { manage: boolean; boundary: string; assignment: string; accountRelationship: string; configs: Config[] };
type Entry = { id: string; name: string; version: number; parentId: string | null; child: boolean };
type Preview = { previewId: string; review: string; version: number; parent: { id: string; name: string } | null; subtree: { id: string; name: string }[]; references: { sourceApp: string; sourceType: string; sourceId: string; recordName: string }[]; cascade: boolean; inheritsPermissions: boolean };

const control = { minHeight: 44, minWidth: 44 };

export default function CollectionHierarchyDialog({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null);
  const [collection, setCollection] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [allowRoots, setAllowRoots] = useState(true);
  const [depthLimit, setDepthLimit] = useState(20);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [more, setMore] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<{ id: string; name: string; parentId: string | null }[]>([]);
  const [recordId, setRecordId] = useState('');
  const [parentId, setParentId] = useState('');
  const [preview, setPreview] = useState<Preview | null>(null);
  const [history, setHistory] = useState('');
  const [download, setDownload] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirm, setConfirm] = useState<'config' | 'apply' | null>(null);
  const alive = useRef(true);
  const ops = useRef<Record<string, string>>({});
  const root = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/collection-hierarchy`;

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
    setError(reason instanceof Error ? reason.message : 'Collection hierarchy is restricted or unavailable.');
    if (!(reason instanceof ApiError) || reason.status >= 500) return;
    ops.current = {};
  }

  function applyConfig(config: Config) {
    const draft = config.recoverableDraft;
    setCollection(config.collection);
    setEnabled(draft?.enabled ?? config.enabled);
    setAllowRoots(draft?.allowRoots ?? config.allowRoots);
    setDepthLimit(draft?.depthLimit ?? config.depthLimit);
  }

  async function load() {
    const value = await requestJson<Catalogue>(root);
    if (!alive.current) return value;
    setCatalogue(value);
    const selected = value.configs.find(item => item.collection === collection) ?? value.configs[0];
    if (selected) applyConfig(selected);
    return value;
  }

  useEffect(() => {
    let ignore = false;
    void load().then(value => {
      if (ignore || !value || !alive.current) return;
      const selected = value.configs[0];
      if (selected?.enabled) return requestJson<{ entries: Entry[]; more: boolean }>(`${root}?view=tree&collection=${encodeURIComponent(selected.collection)}`);
      return null;
    }).then(tree => {
      if (ignore || !tree || !alive.current) return;
      setEntries(tree.entries);
      setMore(tree.more);
    }).catch(reason => { if (!ignore && alive.current) setError(reason instanceof Error ? reason.message : 'Collection hierarchy is restricted or unavailable.'); });
    return () => { ignore = true; };
  }, [workspaceId]);

  async function command(key: string, body: Record<string, unknown>, done: string) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      await requestJson(root, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, operationId: operation(key) }) });
      if (!alive.current) return;
      clearOperation(key);
      setConfirm(null);
      setPreview(null);
      setNotice(done);
      await load();
    } catch (reason) { if (alive.current) failed(reason); } finally { if (alive.current) setBusy(false); }
  }

  const selected = catalogue?.configs.find(item => item.collection === collection) ?? null;
  const configBody = { collection, expectedVersion: selected?.version ?? 0, enabled, allowRoots, depthLimit };

  return <Dialog title="Collection hierarchy" onClose={() => { if (!busy) onClose(); }}>
    <div className="export-dialog collection-hierarchy-dialog">
      <p>{catalogue?.boundary ?? 'No generative model. Hierarchy is an optional structure inside one custom collection.'} {catalogue?.assignment ?? 'Enabling hierarchy or choosing a parent does not grant access.'}</p>
      <p>{catalogue?.accountRelationship ?? 'Accounts still require an Organisation. This hierarchy does not replace that link.'}</p>
      {catalogue?.configs.some(item => item.recoverableDraft) && <p role="status">A recoverable draft is kept.</p>}
      <label>Collection
        <select aria-label="Hierarchy collection" value={collection} disabled={busy} onChange={event => { const config = catalogue?.configs.find(item => item.collection === event.target.value); if (config) applyConfig(config); setConfirm(null); setPreview(null); setEntries([]); }}>
          <option value="">Choose a collection</option>
          {catalogue?.configs.map(item => <option key={item.collection} value={item.collection}>{item.name}{item.eligible ? '' : ' (not eligible)'}</option>)}
        </select>
      </label>
      {selected && <p>Hierarchy version {selected.version}. Depth limit {selected.depthLimit}. One parent for each record.</p>}
      {catalogue?.manage && selected?.eligible && <section aria-label="Hierarchy configuration">
        <label><input type="checkbox" checked={enabled} disabled={busy} onChange={event => setEnabled(event.target.checked)} /> Enable same-collection hierarchy</label>
        <label><input type="checkbox" checked={allowRoots} disabled={busy} onChange={event => setAllowRoots(event.target.checked)} /> Allow records without a parent</label>
        <label>Depth limit
          <input aria-label="Hierarchy depth limit" inputMode="numeric" value={String(depthLimit)} disabled={busy} onChange={event => setDepthLimit(Number(event.target.value))} />
        </label>
        <div className="actions">
          <button type="button" style={control} disabled={busy} onClick={() => void command(`stash:${collection}`, { action: 'stash-config', ...configBody }, 'Draft kept. Cancel leaves the saved hierarchy unchanged.')}>Keep draft</button>
          {confirm === 'config' ? <button type="button" style={control} disabled={busy} onClick={() => void command(`config:${collection}`, { action: 'save-config', ...configBody }, 'Hierarchy saved.')}>Confirm hierarchy</button> : <button type="button" style={control} disabled={busy} onClick={() => setConfirm('config')}>Save hierarchy</button>}
        </div>
      </section>}
      <ul aria-label="Hierarchy records">{entries.map(entry => <li key={entry.id}>{entry.name}{entry.child ? ' · has visible children' : ''}</li>)}</ul>
      {more && <div className="actions"><button type="button" style={control} disabled={busy || !entries.length} onClick={() => void requestJson<{ entries: Entry[]; more: boolean }>(`${root}?view=tree&collection=${encodeURIComponent(collection)}&afterId=${encodeURIComponent(entries.at(-1)?.id ?? '')}`).then(value => { if (!alive.current) return; setEntries(current => [...current, ...value.entries]); setMore(value.more); }).catch(failed)}>Show more siblings</button></div>}
      <label>Search records
        <input aria-label="Hierarchy search" value={query} disabled={busy} onChange={event => setQuery(event.target.value)} />
      </label>
      <div className="actions">
        <button type="button" style={control} disabled={busy || !collection || !query.trim()} onClick={() => void requestJson<{ results: { id: string; name: string; parentId: string | null }[] }>(`${root}?view=search&collection=${encodeURIComponent(collection)}&q=${encodeURIComponent(query.trim())}`).then(value => { if (alive.current) setResults(value.results); }).catch(failed)}>Search hierarchy</button>
        <button type="button" style={control} disabled={busy || !collection} onClick={() => void requestJson<{ entries: Entry[]; more: boolean }>(`${root}?view=tree&collection=${encodeURIComponent(collection)}`).then(value => { if (!alive.current) return; setEntries(value.entries); setMore(value.more); }).catch(failed)}>Show roots</button>
      </div>
      <ul aria-label="Hierarchy search results">{results.map(result => <li key={result.id}>{result.name}</li>)}</ul>
      <label>Record id
        <input aria-label="Hierarchy record id" value={recordId} disabled={busy} onChange={event => { setRecordId(event.target.value); setPreview(null); setConfirm(null); }} />
      </label>
      <label>Parent id
        <input aria-label="Hierarchy parent id" value={parentId} disabled={busy} onChange={event => { setParentId(event.target.value); setPreview(null); setConfirm(null); }} />
      </label>
      <div className="actions">
        <button type="button" style={control} disabled={busy || !recordId.trim()} onClick={() => void requestJson<Preview>(`${root}?view=preview&action=reparent&collection=${encodeURIComponent(collection)}&recordId=${encodeURIComponent(recordId.trim())}&parentId=${encodeURIComponent(parentId.trim())}`).then(value => { if (alive.current) { setPreview(value); setConfirm(null); } }).catch(failed)}>Preview reparent</button>
        <button type="button" style={control} disabled={busy || !recordId.trim()} onClick={() => void requestJson<Preview>(`${root}?view=preview&action=archive&collection=${encodeURIComponent(collection)}&recordId=${encodeURIComponent(recordId.trim())}`).then(value => { if (alive.current) { setPreview(value); setConfirm(null); } }).catch(failed)}>Preview archive</button>
        <button type="button" style={control} disabled={busy || !recordId.trim()} onClick={() => void requestJson<Preview>(`${root}?view=preview&action=delete&collection=${encodeURIComponent(collection)}&recordId=${encodeURIComponent(recordId.trim())}`).then(value => { if (alive.current) { setPreview(value); setConfirm(null); } }).catch(failed)}>Preview delete</button>
      </div>
      {preview && <section aria-label="Hierarchy preview">
        <p>{preview.review} Permissions stay on each record. Descendants are not archived or deleted.</p>
        <ul>{preview.subtree.map(item => <li key={item.id}>{item.name}</li>)}</ul>
        <ul>{preview.references.map(item => <li key={`${item.sourceApp}:${item.sourceType}:${item.sourceId}`}>{item.recordName} · {item.sourceApp} · {item.sourceType} · {item.sourceId}</li>)}</ul>
        <div className="actions">
          {confirm === 'apply' ? <button type="button" style={control} disabled={busy} onClick={() => void command(`apply:${preview.previewId}`, { action: 'apply', previewId: preview.previewId, expectedVersion: preview.version }, 'Hierarchy change saved.')}>Confirm change</button> : <button type="button" style={control} disabled={busy} onClick={() => setConfirm('apply')}>Confirm change</button>}
        </div>
      </section>}
      <div className="actions">
        <button type="button" style={control} disabled={busy || !recordId.trim()} onClick={() => void requestJson<{ events: { action: string; actorName: string; atIst: string; source: string }[] }>(`${root}?view=history&collection=${encodeURIComponent(collection)}&recordId=${encodeURIComponent(recordId.trim())}`).then(value => { if (alive.current) setHistory(value.events.map(event => `${event.action} · ${event.actorName} · ${event.atIst} · ${event.source}`).join('\n')); }).catch(failed)}>Record history</button>
        <button type="button" style={control} disabled={busy || !collection} onClick={() => void requestJson<{ body: string }>(root, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'download', operationId: operation('download'), collection }) }).then(value => { if (alive.current) setDownload(value.body); }).catch(failed)}>Download hierarchy</button>
      </div>
      {history && <pre aria-label="Hierarchy history">{history}</pre>}
      {download && <pre aria-label="Hierarchy download">{download}</pre>}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
      <button type="button" style={control} disabled={busy} onClick={onClose}>Cancel</button>
    </div>
  </Dialog>;
}
