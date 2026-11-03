'use client';
import { useEffect, useRef, useState } from 'react';
import { Dialog } from './editor/rich-editor';
import { ApiError, requestJson } from './editor/use-document-session';

type Tag = { id: string; code: string; label: string; status: string; parentId: string | null; documents: boolean; handling: 'metadata' | 'restrict'; version: number; collections?: string[]; clearedUserIds?: string[]; recoverableDraft?: { label: string; parentId: string | null; documents: boolean; collections: string[]; handling: 'metadata' | 'restrict'; baseVersion: number } | null };
type Assignment = { kind: 'page' | 'record'; id: string; title: string; version: number; canAssign: boolean; tags: { id: string; code: string; label: string; status: string }[]; choices: { id: string; code: string; label: string }[] };
type Catalogue = { manage: boolean; boundary: string; assignment: string; tags: Tag[]; page: Assignment | null; record: Assignment | null; collections: { id: string; name: string }[]; colleagues: { id: string; name: string }[] };
type Facet = { tagId: string; code: string; label: string; count: number };
type Preview = { previewId: string; review: string; version: number; references: { kind: string; id: string; title: string }[]; intoCode: string | null };

const control = { minHeight: 44, minWidth: 44 };

export default function ClassificationDialog({ workspaceId, pageId, onClose }: { workspaceId: string; pageId: string; onClose: () => void }) {
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [recordId, setRecordId] = useState('');
  const [record, setRecord] = useState<Assignment | null>(null);
  const [recordTags, setRecordTags] = useState<string[]>([]);
  const [code, setCode] = useState('');
  const [label, setLabel] = useState('');
  const [parentId, setParentId] = useState('');
  const [documents, setDocuments] = useState(true);
  const [collections, setCollections] = useState<string[]>([]);
  const [handling, setHandling] = useState<'metadata' | 'restrict'>('metadata');
  const [tagId, setTagId] = useState('');
  const [facets, setFacets] = useState<Facet[]>([]);
  const [results, setResults] = useState<{ kind: string; id: string; title: string }[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [history, setHistory] = useState('');
  const [download, setDownload] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirm, setConfirm] = useState<'page' | 'record' | 'create' | 'save' | 'deprecate' | 'merge' | 'remove' | null>(null);
  const alive = useRef(true);
  const ops = useRef<Record<string, string>>({});
  const root = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/classification`;

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
    setError(reason instanceof Error ? reason.message : 'Classification is restricted or unavailable.');
    if (!(reason instanceof ApiError) || reason.status >= 500) return;
    ops.current = {};
  }

  async function load() {
    const value = await requestJson<Catalogue>(`${root}?pageId=${encodeURIComponent(pageId)}`);
    if (!alive.current) return value;
    setCatalogue(value);
    setSelected(value.page?.tags.map(tag => tag.id) ?? []);
    const editing = value.tags.find(tag => tag.id === tagId);
    if (editing) applyTag(editing);
    return value;
  }

  function applyTag(tag: Tag) {
    const draft = tag.recoverableDraft;
    setTagId(tag.id);
    setLabel(draft?.label ?? tag.label);
    setParentId(draft?.parentId ?? tag.parentId ?? '');
    setDocuments(draft?.documents ?? tag.documents);
    setCollections(draft?.collections ?? tag.collections ?? []);
    setHandling(draft?.handling ?? tag.handling);
  }

  useEffect(() => {
    let ignore = false;
    void Promise.all([
      load(),
      requestJson<{ facets: Facet[] }>(`${root}?view=facets&kind=page`),
    ]).then(([value, facet]) => {
      if (ignore || !value || !alive.current) return;
      setFacets(facet.facets);
    }).catch(reason => { if (!ignore && alive.current) setError(reason instanceof Error ? reason.message : 'Classification is restricted or unavailable.'); });
    return () => { ignore = true; };
  }, [workspaceId, pageId]);

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

  function toggle(list: string[], id: string, set: (value: string[]) => void) {
    set(list.includes(id) ? list.filter(item => item !== id) : [...list, id]);
    setConfirm(null);
  }

  const page = catalogue?.page;
  const editing = catalogue?.tags.find(tag => tag.id === tagId) ?? null;
  const draftFields = { label, parentId: parentId || null, documents, collections, handling, clearedUserIds: handling === 'restrict' ? editing?.clearedUserIds ?? [] : [] };

  return <Dialog title="Classification" onClose={() => { if (!busy) onClose(); }}>
    <div className="export-dialog classification-dialog">
      <p>{catalogue?.boundary ?? 'No generative model. Classification tags are controlled metadata.'} {catalogue?.assignment ?? 'Defining or assigning a tag does not grant access to a page, record, or field.'}</p>
      {catalogue?.tags.some(tag => tag.recoverableDraft) && <p role="status">A recoverable draft is kept.</p>}
      <fieldset>
        <legend>Tags on this page</legend>
        {(page?.choices ?? []).map(choice => <label key={choice.id}><input type="checkbox" checked={selected.includes(choice.id)} disabled={busy || !page?.canAssign} onChange={() => toggle(selected, choice.id, setSelected)} /> {choice.code} — {choice.label}</label>)}
        {page?.tags.filter(tag => tag.status === 'deprecated').map(tag => <label key={tag.id}><input type="checkbox" checked={selected.includes(tag.id)} disabled={busy || !page.canAssign} onChange={() => toggle(selected, tag.id, setSelected)} /> {tag.code} — {tag.label} (deprecated)</label>)}
        {!page?.choices.length && !page?.tags.length && <p>No visible tags.</p>}
      </fieldset>
      {page?.canAssign && <div className="actions">
        {confirm === 'page' ? <button type="button" style={control} disabled={busy} onClick={() => void command('assign-page', { action: 'assign', targetKind: 'page', targetId: pageId, expectedVersion: page.version, tagIds: selected }, 'Page tags saved.')}>Confirm page tags</button> : <button type="button" style={control} disabled={busy} onClick={() => setConfirm('page')}>Save page tags</button>}
      </div>}
      <div className="actions">
        <button type="button" style={control} disabled={busy || !page} onClick={() => void requestJson<{ events: { action: string; actorName: string; atIst: string; source: string }[] }>(`${root}?view=history&targetKind=page&targetId=${encodeURIComponent(pageId)}`).then(value => { if (alive.current) setHistory(value.events.map(event => `${event.action} · ${event.actorName} · ${event.atIst} · ${event.source}`).join('\n')); }).catch(failed)}>Page tag history</button>
        <button type="button" style={control} disabled={busy || !page} onClick={() => void requestJson<{ body: string }>(root, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'download', operationId: operation('download-page'), targetKind: 'page', targetId: pageId, expectedVersion: page?.version ?? 0 }) }).then(value => { if (alive.current) setDownload(value.body); }).catch(failed)}>Download classification</button>
      </div>
      <label>Record id
        <input aria-label="Classification record id" value={recordId} disabled={busy} onChange={event => setRecordId(event.target.value)} />
      </label>
      <div className="actions">
        <button type="button" style={control} disabled={busy || !recordId.trim()} onClick={() => void requestJson<Catalogue>(`${root}?recordId=${encodeURIComponent(recordId.trim())}`).then(value => { if (!alive.current) return; setRecord(value.record); setRecordTags(value.record?.tags.map(tag => tag.id) ?? []); }).catch(failed)}>Load record tags</button>
      </div>
      {record && <fieldset>
        <legend>Tags on this record</legend>
        {record.choices.map(choice => <label key={choice.id}><input type="checkbox" checked={recordTags.includes(choice.id)} disabled={busy || !record.canAssign} onChange={() => toggle(recordTags, choice.id, setRecordTags)} /> {choice.code} — {choice.label}</label>)}
        {record.canAssign && (confirm === 'record' ? <button type="button" style={control} disabled={busy} onClick={() => void command('assign-record', { action: 'assign', targetKind: 'record', targetId: record.id, expectedVersion: record.version, tagIds: recordTags }, 'Record tags saved.')}>Confirm record tags</button> : <button type="button" style={control} disabled={busy} onClick={() => setConfirm('record')}>Save record tags</button>)}
      </fieldset>}
      <label>Search by tag
        <select aria-label="Classification search tag" value={tagId} disabled={busy} onChange={event => { const tag = catalogue?.tags.find(item => item.id === event.target.value); if (tag) applyTag(tag); setConfirm(null); setPreview(null); }}>
          <option value="">Choose a tag</option>
          {catalogue?.tags.map(tag => <option key={tag.id} value={tag.id}>{tag.code} — {tag.label}{tag.status === 'deprecated' ? ' (deprecated)' : ''}</option>)}
        </select>
      </label>
      <div className="actions">
        <button type="button" style={control} disabled={busy || !tagId} onClick={() => void requestJson<{ results: { kind: string; id: string; title: string }[] }>(`${root}?view=search&tagId=${encodeURIComponent(tagId)}`).then(value => { if (alive.current) setResults(value.results); }).catch(failed)}>Search by tag id</button>
      </div>
      <ul aria-label="Classification search results">{results.map(result => <li key={`${result.kind}:${result.id}`}>{result.kind} · {result.title}</li>)}</ul>
      <ul aria-label="Classification facets">{facets.map(facet => <li key={facet.tagId}>{facet.code} · {facet.label} · {facet.count}</li>)}</ul>
      {catalogue?.manage && <section aria-label="Classification taxonomy">
        <p>Tag version {editing?.version ?? 0}. {editing?.recoverableDraft ? 'A recoverable draft is kept for this tag.' : ''}</p>
        <label>Stable code <input aria-label="Tag code" value={code} disabled={busy || !!editing} onChange={event => setCode(event.target.value)} /></label>
        <label>Label <input aria-label="Tag label" value={label} disabled={busy} onChange={event => setLabel(event.target.value)} /></label>
        <label>Parent
          <select aria-label="Tag parent" value={parentId} disabled={busy} onChange={event => setParentId(event.target.value)}>
            <option value="">No parent</option>
            {catalogue.tags.filter(tag => tag.id !== editing?.id && tag.status === 'active').map(tag => <option key={tag.id} value={tag.id}>{tag.code}</option>)}
          </select>
        </label>
        <label><input type="checkbox" checked={documents} disabled={busy} onChange={event => setDocuments(event.target.checked)} /> Documents</label>
        {catalogue.collections.map(collection => <label key={collection.id}><input type="checkbox" checked={collections.includes(collection.id)} disabled={busy} onChange={() => toggle(collections, collection.id, setCollections)} /> {collection.name}</label>)}
        <label>Handling
          <select aria-label="Tag handling" value={handling} disabled={busy} onChange={event => setHandling(event.target.value === 'restrict' ? 'restrict' : 'metadata')}>
            <option value="metadata">Metadata only</option>
            <option value="restrict">Explicit handling policy</option>
          </select>
        </label>
        <div className="actions">
          <button type="button" style={control} disabled={busy} onClick={() => { setTagId(''); setCode(''); setLabel(''); setParentId(''); setDocuments(true); setCollections([]); setHandling('metadata'); setConfirm(null); setPreview(null); }}>New tag</button>
          {!editing && (confirm === 'create' ? <button type="button" style={control} disabled={busy} onClick={() => void command('create', { action: 'create', code, expectedVersion: 0, ...draftFields }, 'Tag created.')}>Confirm new tag</button> : <button type="button" style={control} disabled={busy} onClick={() => setConfirm('create')}>Create tag</button>)}
          {editing && <>
            <button type="button" style={control} disabled={busy} onClick={() => void command(`save:${editing.id}`, { action: 'save', tagId: editing.id, expectedVersion: editing.version, ...draftFields }, 'Tag saved.')}>Save tag</button>
            <button type="button" style={control} disabled={busy} onClick={() => void command(`stash:${editing.id}`, { action: 'stash', tagId: editing.id, expectedVersion: editing.version, ...draftFields }, 'Draft kept. Cancel leaves the saved tag unchanged.')}>Keep draft</button>
            {confirm === 'deprecate' ? <button type="button" style={control} disabled={busy} onClick={() => void command(`deprecate:${editing.id}`, { action: 'deprecate', tagId: editing.id, expectedVersion: editing.version }, 'Tag deprecated. Existing assignments stay in history.')}>Confirm deprecate</button> : <button type="button" style={control} disabled={busy} onClick={() => setConfirm('deprecate')}>Deprecate tag</button>}
          </>}
        </div>
        {editing && <div className="actions">
          <button type="button" style={control} disabled={busy} onClick={() => void requestJson<Preview>(`${root}?view=preview&tagId=${encodeURIComponent(editing.id)}&action=merge&intoId=${encodeURIComponent(parentId || catalogue.tags.find(tag => tag.id !== editing.id)?.id || '')}`).then(value => { if (alive.current) { setPreview(value); setConfirm(null); } }).catch(failed)}>Preview merge</button>
          <button type="button" style={control} disabled={busy} onClick={() => void requestJson<Preview>(`${root}?view=preview&tagId=${encodeURIComponent(editing.id)}&action=remove`).then(value => { if (alive.current) { setPreview(value); setConfirm(null); } }).catch(failed)}>Preview removal</button>
          {preview && confirm === 'merge' ? <button type="button" style={control} disabled={busy} onClick={() => void command(`apply:${preview.previewId}`, { action: 'apply', previewId: preview.previewId, expectedVersion: preview.version }, 'Tag remap saved.')}>Confirm remap</button> : preview && <button type="button" style={control} disabled={busy} onClick={() => setConfirm('merge')}>Confirm remap</button>}
        </div>}
        {preview && <section aria-label="Classification preview"><p>{preview.review}</p><ul>{preview.references.map(item => <li key={`${item.kind}:${item.id}`}>{item.kind} · {item.title}</li>)}</ul></section>}
      </section>}
      {history && <pre aria-label="Classification history">{history}</pre>}
      {download && <pre aria-label="Classification download">{download}</pre>}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
      <button type="button" style={control} disabled={busy} onClick={onClose}>Cancel</button>
    </div>
  </Dialog>;
}
