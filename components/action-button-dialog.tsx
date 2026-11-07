'use client';
import {applicationDisplayName} from '../lib/application-display-name';
import { useEffect, useRef, useState } from 'react';
import { Dialog } from './editor/rich-editor';
import { ApiError, requestJson } from './editor/use-document-session';

type Input = { id: string; field: string; required: boolean; default?: string };
type Target = { actionId: string; field: string; inputId?: string };
type Link = { linkId: string; inputId?: string; pageId?: string } | null;
type Definition = { context: { collection: string; placement: 'record' | 'page' }; inputs: Input[]; target: Target; link: Link };
type ActionButton = {
  id: string; collection: string; label: string; status: string; version: number; definition: Definition;
  availability: { enabled: boolean; reason: string | null };
  recoverableDraft?: { baseVersion: number; definition: Definition } | null;
};
type Catalogue = {
  manage: boolean; boundary: string; assignment: string; authority: string; review: string; schedules: string; accounts: string;
  buttons: ActionButton[]; collections: { id: string; name: string }[]; fields: { collection: string; key: string; label: string; kind: string; writable: boolean }[];
};
type Preview = { previewId: string; action?: string; review: string; version: number; plan: { actionId: string; field: string; linkId: string | null } | null };
type Receipt = { actionStatus: string; linkStatus: string; source: string; revision: number; recoverable: boolean; id?: string };

const control = { minHeight: 44, minWidth: 44 };
const contracts = [
  ['hs.record.set-field', 'Set field'],
  ['hs.record.clear-field', 'Clear field'],
  ['hs.record.append-note', 'Append note'],
] as const;

function reasonText(reason: string | null | undefined) {
  if (reason === 'deprecated-target') return 'The target is deprecated.';
  if (reason === 'stale-target') return 'The target is stale.';
  if (reason === 'paused') return 'The action is paused.';
  if (reason === 'draft') return 'The action is still a draft.';
  if (reason === 'context') return 'The record is outside this action.';
  if (reason === 'forbidden') return 'You cannot run this action.';
  return 'This action is unavailable.';
}

export default function ActionButtonDialog({ workspaceId, pageId, onClose }: { workspaceId: string; pageId: string; onClose: () => void }) {
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null);
  const [buttonId, setButtonId] = useState('');
  const [label, setLabel] = useState('');
  const [collection, setCollection] = useState('');
  const [placement, setPlacement] = useState<'record' | 'page'>('record');
  const [inputField, setInputField] = useState('');
  const [required, setRequired] = useState(true);
  const [defaultValue, setDefaultValue] = useState('');
  const [actionId, setActionId] = useState('hs.record.set-field');
  const [actionField, setActionField] = useState('');
  const [linkId, setLinkId] = useState('');
  const [linkField, setLinkField] = useState('');
  const [linkPage, setLinkPage] = useState('');
  const [recordId, setRecordId] = useState('');
  const [inputValue, setInputValue] = useState('');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<{ id: string; label: string; status: string; version: number }[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [history, setHistory] = useState('');
  const [download, setDownload] = useState('');
  const [rollbackVersion, setRollbackVersion] = useState('1');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirm, setConfirm] = useState<'create' | null>(null);
  const alive = useRef(true);
  const ops = useRef<Record<string, string>>({});
  const root = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/action-buttons`;

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
    setError(reason instanceof Error ? reason.message : 'Action buttons are restricted or unavailable.');
    if (!(reason instanceof ApiError) || reason.status >= 500) return;
    ops.current = {};
  }

  function applyDefinition(definition: Definition) {
    setPlacement(definition.context.placement);
    const first = definition.inputs[0];
    setInputField(first?.field ?? '');
    setRequired(first?.required ?? true);
    setDefaultValue(first?.default ?? '');
    setActionId(definition.target.actionId);
    setActionField(definition.target.field);
    setLinkId(definition.link?.linkId ?? '');
    setLinkField(definition.inputs.find(item => item.id === definition.link?.inputId)?.field ?? '');
    setLinkPage(definition.link?.pageId ?? '');
  }

  async function load() {
    const value = await requestJson<Catalogue>(`${root}?pageId=${encodeURIComponent(pageId)}`);
    if (!alive.current) return value;
    setCatalogue(value);
    if (!collection && value.collections[0]) setCollection(value.collections[0].id);
    if (!inputField && value.fields[0]) {
      setInputField(value.fields[0].key);
      setActionField(value.fields[0].key);
    }
    return value;
  }

  useEffect(() => {
    let ignore = false;
    void load().catch(reason => { if (!ignore && alive.current) setError(reason instanceof Error ? reason.message : 'Action buttons are restricted or unavailable.'); });
    return () => { ignore = true };
  }, [workspaceId, pageId]);

  const selected = catalogue?.buttons.find(item => item.id === buttonId) ?? null;
  const fields = (catalogue?.fields ?? []).filter(field => field.collection === (selected?.collection || collection));
  const inputs: Input[] = [];
  if (actionId !== 'hs.record.clear-field' && inputField) inputs.push({ id: 'value', field: inputField, required, ...(defaultValue.trim() ? { default: defaultValue } : {}) });
  if ((linkId === 'hs.record.open' || linkId === 'suite.record.open') && (linkField || inputField)) inputs.push({ id: 'target', field: linkField || inputField, required: false });
  const definition: Definition = {
    context: { collection, placement },
    inputs,
    target: actionId === 'hs.record.clear-field' ? { actionId, field: actionField || inputField } : { actionId, field: actionField || inputField, inputId: 'value' },
    link: linkId === 'hs.page.open' ? { linkId, pageId: linkPage.trim() } : linkId === 'hs.record.open' || linkId === 'suite.record.open' ? { linkId, inputId: 'target' } : null,
  };

  async function command(key: string, body: Record<string, unknown>, done: string) {
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const value = await requestJson<Preview & Receipt & { conflict?: boolean; body?: string }>(root, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, operationId: operation(key) }) });
      if (!alive.current) return;
      clearOperation(key);
      setConfirm(null);
      if (body.action === 'preview') setPreview(value);
      if (body.action === 'apply' || body.action === 'retry-link') setReceipt(value);
      if (value.body) setDownload(value.body);
      setNotice(value.conflict ? 'The action button version changed. The draft is kept.' : done);
      await load();
    } catch (reason) { if (alive.current) failed(reason); } finally { if (alive.current) setBusy(false); }
  }

  const unavailableButton = selected ? !selected.availability.enabled : false;

  return <Dialog title="Action buttons" onClose={() => { if (!busy) onClose(); }}>
    <div className="export-dialog action-button-dialog">
      <p>{catalogue?.boundary} {catalogue?.assignment}</p>
      <p>{catalogue?.authority}</p>
      <p>{catalogue?.schedules} {catalogue?.accounts}</p>
      {catalogue?.buttons.some(item => item.recoverableDraft) ? <p role="status">A recoverable draft is kept.</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {!catalogue && error ? <p>Action buttons are unavailable in this workspace.</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      {catalogue ? <>
        <ul aria-label="Action buttons">
          {catalogue.buttons.map(button => <li key={button.id}>
            <button type="button" style={control} disabled={!button.availability.enabled} aria-disabled={!button.availability.enabled} aria-describedby={button.availability.enabled ? undefined : `action-reason-${button.id}`} aria-label={button.availability.enabled ? button.label : `${button.label} is unavailable. ${reasonText(button.availability.reason)}`}>{button.label}</button>
            {!button.availability.enabled ? <span id={`action-reason-${button.id}`}>{reasonText(button.availability.reason)}</span> : null}
          </li>)}
        </ul>
        <label>Action button
          <select aria-label="Action button" value={buttonId} disabled={busy} onChange={event => {
            const button = catalogue.buttons.find(item => item.id === event.target.value);
            setButtonId(event.target.value);
            setPreview(null);
            setReceipt(null);
            setConfirm(null);
            if (!button) return;
            setLabel(button.label);
            setCollection(button.collection);
            applyDefinition(button.recoverableDraft?.definition ?? button.definition);
          }}>
            <option value="">New action button</option>
            {catalogue.buttons.map(button => <option key={button.id} value={button.id}>{button.label} · {button.status} · v{button.version}</option>)}
          </select>
        </label>
        <label>Label <input aria-label="Action label" value={label} disabled={busy} onChange={event => setLabel(event.target.value)} /></label>
        <label>Collection
          <select aria-label="Action collection" value={collection} disabled={busy || !!selected} onChange={event => { setCollection(event.target.value); setInputField(''); setActionField(''); }}>
            <option value="">Choose a collection</option>
            {catalogue.collections.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
          </select>
        </label>
        <label>Context
          <select aria-label="Action placement" value={placement} disabled={busy} onChange={event => setPlacement(event.target.value === 'page' ? 'page' : 'record')}>
            <option value="record">Record</option>
            <option value="page">Page</option>
          </select>
        </label>
        <fieldset>
          <legend>Input</legend>
          <label>Field
            <select aria-label="Input field" value={inputField} disabled={busy} onChange={event => { setInputField(event.target.value); if (!actionField) setActionField(event.target.value); }}>
              <option value="">Choose a field</option>
              {fields.map(field => <option key={field.key} value={field.key}>{field.label}</option>)}
            </select>
          </label>
          <label style={control}>Required <input aria-label="Required input" type="checkbox" checked={required} disabled={busy} onChange={event => setRequired(event.target.checked)} /></label>
          <label>Default <input aria-label="Default value" value={defaultValue} disabled={busy} onChange={event => setDefaultValue(event.target.value)} /></label>
        </fieldset>
        <fieldset>
          <legend>Action target</legend>
          <label>Contract
            <select aria-label="Action contract" value={actionId} disabled={busy} onChange={event => setActionId(event.target.value)}>
              {contracts.map(([id, name]) => <option key={id} value={id}>{name}</option>)}
            </select>
          </label>
          <label>Field
            <select aria-label="Target field" value={actionField} disabled={busy} onChange={event => setActionField(event.target.value)}>
              <option value="">Choose a field</option>
              {fields.filter(field => actionId === 'hs.record.append-note' ? field.kind === 'long-text' : field.writable || actionId !== 'hs.record.clear-field').map(field => <option key={field.key} value={field.key}>{field.label}</option>)}
            </select>
          </label>
        </fieldset>
        <label>Follow-up link
          <select aria-label="Follow-up link" value={linkId} disabled={busy} onChange={event => setLinkId(event.target.value)}>
            <option value="">No follow-up link</option>
            <option value="hs.record.open">Open record</option>
            <option value="suite.record.open">Open suite record</option>
            <option value="hs.page.open">Open page</option>
          </select>
        </label>
        {linkId === 'hs.record.open' || linkId === 'suite.record.open' ? <label>Link field
          <select aria-label="Link field" value={linkField} disabled={busy} onChange={event => setLinkField(event.target.value)}>
            <option value="">Choose a field</option>
            {fields.filter(field => field.kind === 'text' || field.kind === 'long-text').map(field => <option key={field.key} value={field.key}>{field.label}</option>)}
          </select>
        </label> : null}
        {linkId === 'hs.page.open' ? <label>Page <input aria-label="Link page" value={linkPage} disabled={busy} onChange={event => setLinkPage(event.target.value)} /></label> : null}
        {catalogue.manage ? <div className="actions">
          {!selected && (confirm === 'create' ? <button type="button" style={control} disabled={busy} onClick={() => void command('create', { action: 'create', collection, label, definition }, 'Action button saved as a draft. It is not active.')}>Confirm new action button</button> : <button type="button" style={control} disabled={busy} onClick={() => setConfirm('create')}>Create action button</button>)}
          {selected ? <>
            <button type="button" style={control} disabled={busy} onClick={() => void command(`stash:${selected.id}`, { action: 'stash', buttonId: selected.id, expectedVersion: selected.version, definition }, 'Draft kept. Cancel leaves the saved action button unchanged.')}>Keep draft</button>
            <button type="button" style={control} disabled={busy} onClick={() => void command(`preview:${selected.id}`, { action: 'preview', buttonId: selected.id, kind: 'version-change', expectedVersion: selected.version, definition }, 'Review the version change, then confirm it.')}>Review version change</button>
            <button type="button" style={control} disabled={busy || preview?.action !== 'version-change'} onClick={() => void command(`apply:${selected.id}`, { action: 'apply', previewId: preview?.previewId, expectedVersion: selected.version }, 'Version saved. An active action button returns to paused.')}>Confirm version change</button>
            {selected.status !== 'active' ? <>
              <button type="button" style={control} disabled={busy} onClick={() => void command(`activate-preview:${selected.id}`, { action: 'preview', buttonId: selected.id, kind: 'activate', expectedVersion: selected.version }, 'Review activation, then confirm it.')}>Review activation</button>
              <button type="button" style={control} disabled={busy || preview?.action !== 'activate'} onClick={() => void command(`activate:${selected.id}`, { action: 'apply', previewId: preview?.previewId, expectedVersion: selected.version }, 'Action button activated.')}>Confirm activation</button>
            </> : <>
              <button type="button" style={control} disabled={busy} onClick={() => void command(`pause-preview:${selected.id}`, { action: 'preview', buttonId: selected.id, kind: 'pause', expectedVersion: selected.version }, 'Review the pause, then confirm it.')}>Review pause</button>
              <button type="button" style={control} disabled={busy || preview?.action !== 'pause'} onClick={() => void command(`pause:${selected.id}`, { action: 'apply', previewId: preview?.previewId, expectedVersion: selected.version }, 'Action button paused.')}>Confirm pause</button>
            </>}
          </> : null}
        </div> : null}
        {selected && catalogue.manage ? <div className="actions">
          <label>Rollback version <input aria-label="Rollback version" value={rollbackVersion} disabled={busy} onChange={event => setRollbackVersion(event.target.value)} /></label>
          <button type="button" style={control} disabled={busy} onClick={() => void command(`rollback-preview:${selected.id}`, { action: 'preview', buttonId: selected.id, kind: 'rollback', expectedVersion: selected.version, targetVersion: Number(rollbackVersion) }, 'Review the rollback, then confirm it.')}>Review rollback</button>
          <button type="button" style={control} disabled={busy || preview?.action !== 'rollback'} onClick={() => void command(`rollback:${selected.id}`, { action: 'apply', previewId: preview?.previewId, expectedVersion: selected.version }, 'Rolled back. The action button stays paused.')}>Confirm rollback</button>
        </div> : null}
        <p>{preview?.review} {preview?.plan ? `Impact ${preview.plan.actionId} on ${preview.plan.field}.` : ''}</p>
        <label>Record <input aria-label="Action record id" value={recordId} disabled={busy} onChange={event => setRecordId(event.target.value)} /></label>
        <label>Value <input aria-label="Input value" value={inputValue} disabled={busy} onChange={event => setInputValue(event.target.value)} /></label>
        <div className="actions">
          <button type="button" style={control} disabled={busy || !selected || unavailableButton || !recordId.trim()} aria-label={unavailableButton ? `${selected?.label ?? 'Action'} is unavailable. ${reasonText(selected?.availability.reason)}` : 'Review action'} onClick={() => void command(`invoke:${selected?.id}`, { action: 'preview', buttonId: selected?.id, kind: 'invoke', expectedVersion: selected?.version, recordId: recordId.trim(), ...(inputValue.trim() ? { inputs: { value: inputValue } } : {}), ...(selected?.definition.context.placement === 'page' ? { pageId } : {}) }, 'Review the impact, then confirm it.')}>Review action</button>
          <button type="button" style={control} disabled={busy || preview?.action !== 'invoke'} onClick={() => void command(`confirm:${selected?.id}`, { action: 'apply', previewId: preview?.previewId, expectedVersion: selected?.version }, 'Action saved.')}>Confirm action</button>
          <button type="button" style={control} disabled={busy || !receipt?.id || receipt.linkStatus === 'none'} onClick={() => void command(`retry:${receipt?.id}`, { action: 'retry-link', receiptId: receipt?.id }, 'Follow-up link checked again. The saved action was not repeated.')}>Retry follow-up link</button>
        </div>
        {receipt ? <p role="status">Action {receipt.actionStatus}. Follow-up link {receipt.linkStatus}. Source {applicationDisplayName(receipt.source)}. Revision {receipt.revision}. The receipt is recoverable.</p> : null}
        <div className="actions">
          <button type="button" style={control} disabled={busy || !selected} onClick={() => void requestJson<{ events: { action: string; actorName: string; atIst: string; source: string; revision: number | null; actionId: string | null }[]; receipts: { revision: number; actionStatus: string; linkStatus: string }[] }>(`${root}?view=history&buttonId=${encodeURIComponent(selected?.id ?? '')}`).then(value => { if (alive.current) setHistory([...value.events.map(item => `${item.action} · ${item.actorName} · ${item.atIst} · ${applicationDisplayName(item.source)} · ${item.actionId ?? ''} · revision ${item.revision ?? ''}`), ...value.receipts.map(item => `revision ${item.revision} · action ${item.actionStatus} · link ${item.linkStatus}`)].join('\n')); }).catch(failed)}>Action history</button>
          <button type="button" style={control} disabled={busy || !selected} onClick={() => void command(`download:${selected?.id}`, { action: 'download', buttonId: selected?.id, expectedVersion: selected?.version }, 'Download ready.')}>Download action button</button>
        </div>
        <label>Search <input aria-label="Action search" value={query} disabled={busy} onChange={event => setQuery(event.target.value)} /></label>
        <div className="actions">
          <button type="button" style={control} disabled={busy || !query.trim()} onClick={() => void requestJson<{ results: { id: string; label: string; status: string; version: number }[] }>(`${root}?view=search&q=${encodeURIComponent(query.trim())}`).then(value => { if (alive.current) setResults(value.results); }).catch(failed)}>Search action buttons</button>
        </div>
        <ul aria-label="Action search results">{results.map(result => <li key={result.id}>{result.label} · {result.status} · v{result.version}</li>)}</ul>
        {history ? <pre>{history}</pre> : null}
        {download ? <pre>{download}</pre> : null}
      </> : null}
      <button type="button" style={control} disabled={busy} onClick={onClose}>Cancel</button>
    </div>
  </Dialog>;
}
