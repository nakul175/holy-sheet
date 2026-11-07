'use client';
import {applicationDisplayName} from '../lib/application-display-name';
import { useEffect, useRef, useState } from 'react';
import { Dialog } from './editor/rich-editor';
import { ApiError, requestJson } from './editor/use-document-session';

type Field = { collection: string; key: string; label: string; kind: string; writable: boolean };
type Health = { id: string; kind: string; status: string; reason: string | null };
type Definition = {
  navigation: { id: string; label: string; screenId: string }[];
  screens: { id: string; name: string; components: Record<string, unknown>[] }[];
  roles: string[];
};
type InterfaceItem = {
  id: string; name: string; status: string; version: number; sharing: string; definition: Definition;
  screens?: { id: string; name: string; components: Health[] }[];
  recoverableDraft?: { baseVersion: number; definition: Definition } | null;
};
type Catalogue = {
  manage: boolean; boundary: string; assignment: string; authority: string; review: string; schedules: string; accounts: string; sharing: string;
  interfaces: InterfaceItem[]; collections: { id: string; name: string }[]; fields: Field[];
  views: { id: string; collection: string }[]; buttons: { id: string; label: string; status: string }[];
};
type Preview = { previewId: string; action?: string; review: string; version: number; plan: { componentId?: string; fields?: string[] } | null };

const control = { minHeight: 44, minWidth: 44 };

export default function RoleInterfaceDialog({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null);
  const [interfaceId, setInterfaceId] = useState('');
  const [name, setName] = useState('');
  const [collection, setCollection] = useState('');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<{ id: string; name: string; status: string; version: number }[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [history, setHistory] = useState('');
  const [download, setDownload] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirm, setConfirm] = useState<'create' | null>(null);
  const alive = useRef(true);
  const ops = useRef<Record<string, string>>({});
  const root = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/role-interfaces`;

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
    setError(reason instanceof Error ? reason.message : 'Interfaces are restricted or unavailable.');
    if (!(reason instanceof ApiError) || reason.status >= 500) return;
    ops.current = {};
  }

  async function load() {
    const value = await requestJson<Catalogue>(root);
    if (!alive.current) return value;
    setCatalogue(value);
    if (!collection && value.collections[0]) setCollection(value.collections[0].id);
    return value;
  }

  useEffect(() => {
    let ignore = false;
    void load().catch(reason => { if (!ignore && alive.current) setError(reason instanceof Error ? reason.message : 'Interfaces are restricted or unavailable.'); });
    return () => { ignore = true };
  }, [workspaceId]);

  const selected = catalogue?.interfaces.find(item => item.id === interfaceId) ?? null;
  const field = (catalogue?.fields ?? []).find(item => item.collection === collection && item.writable);
  const view = (catalogue?.views ?? []).find(item => item.collection === collection);
  const button = catalogue?.buttons[0];
  const definition: Definition = {
    navigation: [{ id: 'home', label: 'Clinic', screenId: 'clinic' }],
    screens: [{
      id: 'clinic',
      name: 'Clinic',
      components: [
        { id: 'roster', kind: 'list', collection, viewId: view?.id ?? null, fields: field ? [{ key: field.key, version: 1 }] : [] },
        { id: 'focus', kind: 'detail', collection, fields: field ? [{ key: field.key, version: 1 }] : [] },
        { id: 'edit', kind: 'form', collection, fields: field ? [{ key: field.key, version: 1 }] : [] },
        { id: 'mix', kind: 'chart', collection, viewId: null, field: field ? { key: field.key, version: 1 } : { key: '', version: 1 } },
        { id: 'go', kind: 'button', buttonId: button?.id ?? '' },
      ],
    }],
    roles: ['member'],
  };
  const broken = catalogue?.interfaces.some(item => item.screens?.some(screen => screen.components.some(component => component.status === 'broken'))) ?? false;

  async function command(key: string, body: Record<string, unknown>, done: string) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const value = await requestJson<Preview & { conflict?: boolean; body?: string }>(root, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, operationId: operation(key) }) });
      if (!alive.current) return;
      clearOperation(key);
      setConfirm(null);
      if (body.action === 'preview') setPreview(value);
      if (value.body) setDownload(value.body);
      setNotice(value.conflict ? 'The interface version changed. The draft is kept.' : done);
      await load();
    } catch (reason) { if (alive.current) failed(reason); } finally { if (alive.current) setBusy(false); }
  }

  return <Dialog title="Interfaces" onClose={() => { if (!busy) onClose(); }}>
    <div className="export-dialog role-interface-dialog">
      <p>{catalogue?.boundary} {catalogue?.assignment}</p>
      <p>{catalogue?.authority}</p>
      <p>{catalogue?.sharing} {catalogue?.schedules} {catalogue?.accounts}</p>
      {catalogue?.interfaces.some(item => item.recoverableDraft) ? <p role="status">A recoverable draft is kept.</p> : null}
      {broken ? <p role="status">A component needs review. The other parts stay available.</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {!catalogue && error ? <p>Interfaces are unavailable in this workspace.</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      {catalogue ? <>
        <label>Interface
          <select aria-label="Interface" value={interfaceId} disabled={busy} onChange={event => { setInterfaceId(event.target.value); setPreview(null); setConfirm(null); const item = catalogue.interfaces.find(candidate => candidate.id === event.target.value); if (item) { setName(item.name); setCollection(item.definition.screens[0]?.components.find(component => 'collection' in component && typeof component.collection === 'string')?.collection as string ?? collection); } }}>
            <option value="">New interface</option>
            {catalogue.interfaces.map(item => <option key={item.id} value={item.id}>{item.name} · {item.status} · v{item.version}</option>)}
          </select>
        </label>
        <label>Name <input aria-label="Interface name" value={name} disabled={busy} onChange={event => setName(event.target.value)} /></label>
        <label>Collection
          <select aria-label="Interface collection" value={collection} disabled={busy || !!selected} onChange={event => setCollection(event.target.value)}>
            <option value="">Choose a collection</option>
            {catalogue.collections.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        {catalogue.manage ? <div className="actions">
          {!selected && (confirm === 'create' ? <button type="button" style={control} disabled={busy} onClick={() => void command('create', { action: 'create', name, definition }, 'Interface saved as a private draft.')}>Confirm new interface</button> : <button type="button" style={control} disabled={busy} onClick={() => setConfirm('create')}>Create interface</button>)}
          {selected ? <>
            <button type="button" style={control} disabled={busy} onClick={() => void command(`stash:${selected.id}`, { action: 'stash', interfaceId: selected.id, expectedVersion: selected.version, definition }, 'Draft kept. Cancel leaves the saved interface unchanged.')}>Keep draft</button>
            <button type="button" style={control} disabled={busy} onClick={() => void command(`stage-preview:${selected.id}`, { action: 'preview', interfaceId: selected.id, kind: 'stage', expectedVersion: selected.version }, 'Review the preview, then confirm it.')}>Review preview</button>
            <button type="button" style={control} disabled={busy || preview?.action !== 'stage'} onClick={() => void command(`stage:${selected.id}`, { action: 'apply', previewId: preview?.previewId, expectedVersion: selected.version }, 'Preview version saved.')}>Confirm preview</button>
            <button type="button" style={control} disabled={busy} onClick={() => void command(`publish-preview:${selected.id}`, { action: 'preview', interfaceId: selected.id, kind: 'publish', expectedVersion: selected.version }, 'Review publishing, then confirm it.')}>Review publish</button>
            <button type="button" style={control} disabled={busy || preview?.action !== 'publish'} onClick={() => void command(`publish:${selected.id}`, { action: 'apply', previewId: preview?.previewId, expectedVersion: selected.version }, 'Interface published.')}>Confirm publish</button>
          </> : null}
        </div> : null}
        <p>{preview?.review} {preview?.plan ? `Impact on ${preview.plan.componentId}.` : ''}</p>
        <div className="actions">
          <button type="button" style={control} disabled={busy || !selected} onClick={() => void requestJson<{ events: { action: string; actorName: string; atIst: string; source: string; revision: number | null }[] }>(`${root}?view=history&interfaceId=${encodeURIComponent(selected?.id ?? '')}`).then(value => { if (alive.current) setHistory(value.events.map(item => `${item.action} · ${item.actorName} · ${item.atIst} · ${applicationDisplayName(item.source)} · revision ${item.revision ?? ''}`).join('\n')); }).catch(failed)}>Interface history</button>
          <button type="button" style={control} disabled={busy || !selected} onClick={() => void command(`download:${selected?.id}`, { action: 'download', interfaceId: selected?.id, expectedVersion: selected?.version }, 'Download ready.')}>Download interface</button>
        </div>
        <label>Search <input aria-label="Interface search" value={query} disabled={busy} onChange={event => setQuery(event.target.value)} /></label>
        <div className="actions">
          <button type="button" style={control} disabled={busy || !query.trim()} onClick={() => void requestJson<{ results: { id: string; name: string; status: string; version: number }[] }>(`${root}?view=search&q=${encodeURIComponent(query.trim())}`).then(value => { if (alive.current) setResults(value.results); }).catch(failed)}>Search interfaces</button>
        </div>
        <ul aria-label="Interface search results">{results.map(result => <li key={result.id}>{result.name} · {result.status} · v{result.version}</li>)}</ul>
        {history ? <pre>{history}</pre> : null}
        {download ? <pre>{download}</pre> : null}
      </> : null}
      <button type="button" style={control} disabled={busy} onClick={onClose}>Cancel</button>
    </div>
  </Dialog>;
}
