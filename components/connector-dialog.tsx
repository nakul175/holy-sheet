'use client';
import {applicationDisplayName} from '../lib/application-display-name';
import { useEffect, useRef, useState } from 'react';
import { Dialog } from './editor/rich-editor';
import { ApiError, requestJson } from './editor/use-document-session';

type Connector = {
  id: string;
  name: string;
  status: string;
  version: number;
  sharing: string;
  type: string;
  direction: string;
  source: string;
  residency: string;
  health: string;
  writesStopped: boolean;
  liveActivation: boolean;
  secretVisible: boolean;
  schedulesPaused: boolean;
};
type Catalogue = {
  boundary: string;
  assignment: string;
  secrets: string;
  delegation: string;
  activation: string;
  schedules: string;
  recoverable: string;
  edge: string;
  canonical: string;
  secretStore?: string;
  connectors: Connector[];
  drafts: { connectorKey: string; kind: string }[];
};
type Preview = { direction?: string; sharing?: string; accessGranted?: boolean; liveActivation?: boolean; dryRun?: boolean; canonicalMutated?: boolean; secretVisible?: boolean; type?: string; scope?: { source: string } };

const control = { minHeight: 44, minWidth: 44 };

export default function ConnectorDialog({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null);
  const [name, setName] = useState('Clinic connector');
  const [connectorType, setConnectorType] = useState('records');
  const [source, setSource] = useState('clinic-source');
  const [direction, setDirection] = useState('read-write');
  const [externalId, setExternalId] = useState('ext-clinic');
  const [recordId, setRecordId] = useState('00000000-0000-4000-8000-00000000f301');
  const [fieldKey, setFieldKey] = useState('core:notes');
  const [secretRef, setSecretRef] = useState('');
  const [connectorId, setConnectorId] = useState('');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Connector[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [history, setHistory] = useState('');
  const [download, setDownload] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmSave, setConfirmSave] = useState(false);
  const [confirmEnable, setConfirmEnable] = useState(false);
  const [confirmPause, setConfirmPause] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState(false);
  const alive = useRef(true);
  const ops = useRef<Record<string, string>>({});
  const root = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/connectors`;

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
    setError(reasonValue instanceof Error ? reasonValue.message : 'Connectors are restricted or unavailable.');
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
    void load().catch(reasonValue => { if (!ignore && alive.current) setError(reasonValue instanceof Error ? reasonValue.message : 'Connectors are restricted or unavailable.'); });
    return () => { ignore = true; };
  }, [workspaceId]);

  const selected = catalogue?.connectors.find(item => item.id === connectorId) ?? null;
  function definition() {
    return {
      type: connectorType,
      scope: { source, collection: 'organisations', recordIds: [recordId] },
      direction,
      stableIds: [{ externalId, recordId }],
      mappings: [{ externalField: 'notes', field: fieldKey }],
      secretRef: secretRef.trim() ? secretRef.trim() : null,
      edge: { cache: 'no-store', residency: 'tenant', public: false },
      retry: { bound: 3 },
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

  return <Dialog title="Connectors" onClose={() => { if (!busy) onClose(); }}>
    <div className="connector-dialog">
      <p>{catalogue?.boundary ?? 'A connector registers an approved type, tenant source, stable identifiers, and an explicit direction. It does not open a live connection.'}</p>
      <p>{catalogue?.assignment ?? 'Configuring a connector, naming a manager, or assigning a source does not grant access to a page, record, collection, or field.'}</p>
      <p>{catalogue?.secrets ?? 'Runtime credentials stay in the suite secret store. Secret values are not collected, rotated, exported, logged, or shown.'}</p>
      <p>{catalogue?.delegation ?? 'Runtime uses the delegated user and app rights and field ownership. Connector configuration does not grant those rights.'}</p>
      <p>{catalogue?.activation ?? 'No connector is activated by this task. Connection setup stays separately authorised and sharing stays off.'}</p>
      <p>{catalogue?.schedules ?? 'Existing schedules stay paused. Connectors do not activate a schedule.'}</p>
      <p>{catalogue?.recoverable ?? 'A recoverable draft is kept when the version changes.'}</p>
      <p>{catalogue?.edge ?? 'Connector responses stay with the tenant and use cache no-store. Public caching is off.'}</p>
      <p>{catalogue?.canonical ?? 'Pause and disconnect keep canonical records unchanged and stop later writes.'}</p>
      <p>Secret store: {catalogue?.secretStore ?? 'suite-secret-store'}. The value is hidden.</p>
      {catalogue?.drafts.length ? <p>A recoverable draft is kept for this connector.</p> : null}
      {error ? <p role="alert">{error}</p> : null}
      {notice ? <p role="status">{notice}</p> : null}
      <fieldset>
        <label><span>Name</span><input aria-label="Connector name" value={name} disabled={busy} onChange={event => setName(event.target.value)} /></label>
        <label><span>Type</span><select aria-label="Connector type" value={connectorType} disabled={busy} onChange={event => setConnectorType(event.target.value)}><option value="records">Records</option><option value="directory">Directory</option></select></label>
        <label><span>Source</span><input aria-label="Connector source" value={source} disabled={busy} onChange={event => setSource(event.target.value)} /></label>
        <label><span>Direction</span><select aria-label="Connector direction" value={direction} disabled={busy} onChange={event => setDirection(event.target.value)}><option value="read">Read</option><option value="write">Write</option><option value="read-write">Read and write</option></select></label>
        <label><span>Stable id</span><input aria-label="Stable external id" value={externalId} disabled={busy} onChange={event => setExternalId(event.target.value)} /></label>
        <label><span>Record</span><input aria-label="Connector record" value={recordId} disabled={busy} onChange={event => setRecordId(event.target.value)} /></label>
        <label><span>Field</span><input aria-label="Connector field" value={fieldKey} disabled={busy} onChange={event => setFieldKey(event.target.value)} /></label>
        <label><span>Secret reference</span><input aria-label="Secret reference" value={secretRef} disabled={busy} onChange={event => setSecretRef(event.target.value)} /></label>
        <label><span>Connector</span><select aria-label="Saved connector" value={connectorId} disabled={busy} onChange={event => { setConnectorId(event.target.value); setPreview(null); setConfirmSave(false); setConfirmEnable(false); setConfirmPause(false); setConfirmDisconnect(false); }}><option value="">Choose a connector</option>{(catalogue?.connectors ?? []).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label><span>Search</span><input aria-label="Connector search" value={query} disabled={busy} onChange={event => setQuery(event.target.value)} /></label>
      </fieldset>
      {selected ? <section aria-label="Connector inventory"><p>Status {selected.status}. Sharing {selected.sharing}. Type {selected.type}. Direction {selected.direction}. Source {applicationDisplayName(selected.source)}. Residency {selected.residency}. Health {selected.health}. Live activation {selected.liveActivation ? 'yes' : 'no'}. Secret visible {selected.secretVisible ? 'yes' : 'no'}. Writes stopped {selected.writesStopped ? 'yes' : 'no'}. Schedules paused {selected.schedulesPaused ? 'yes' : 'no'}. Configuration does not grant access.</p></section> : null}
      <div className="actions">
        <button type="button" style={control} disabled={busy} onClick={() => { setConfirmSave(true); setPreview(null); }}>Review connector</button>
        {confirmSave ? <button type="button" style={control} disabled={busy} onClick={() => void post('configure', { action: 'configure', expectedVersion: selected?.version ?? 0, connectorId: connectorId || undefined, name, definition: definition() }).then(result => { if (result) setPreview(result as Preview); })}>Confirm connector</button> : null}
        <button type="button" style={control} disabled={busy || !selected} onClick={() => { if (!selected) return; void post('preview', { action: 'preview', connectorId: selected.id, expectedVersion: selected.version }).then(result => { if (result) setPreview(result as Preview); }); }}>Dry-run preview</button>
        <button type="button" style={control} disabled={busy || !selected} onClick={() => setConfirmEnable(true)}>Review enable</button>
        {confirmEnable && selected ? <button type="button" style={control} disabled={busy} onClick={() => void post('enable', { action: 'enable', connectorId: selected.id, expectedVersion: selected.version })}>Confirm enable</button> : null}
        <button type="button" style={control} disabled={busy || !selected} onClick={() => setConfirmPause(true)}>Pause connector</button>
        {confirmPause && selected ? <button type="button" style={control} disabled={busy} onClick={() => void post('pause', { action: 'pause', connectorId: selected.id, expectedVersion: selected.version })}>Confirm pause</button> : null}
        <button type="button" style={control} disabled={busy || !selected} onClick={() => setConfirmDisconnect(true)}>Disconnect connector</button>
        {confirmDisconnect && selected ? <button type="button" style={control} disabled={busy} onClick={() => void post('disconnect', { action: 'disconnect', connectorId: selected.id, expectedVersion: selected.version })}>Confirm disconnect</button> : null}
        <button type="button" style={control} disabled={busy} onClick={() => { setBusy(true); setError(''); void requestJson<{ results: Connector[] }>(`${root}?view=search&q=${encodeURIComponent(query)}`).then(value => { if (alive.current) setResults(value.results); }).catch(reasonValue => { if (alive.current) failed(reasonValue); }).finally(() => { if (alive.current) setBusy(false); }); }}>Search connectors</button>
        <button type="button" style={control} disabled={busy || !selected} onClick={() => { if (!selected) return; setBusy(true); void requestJson<{ events: { action: string; source: string; atIst: string }[] }>(`${root}?view=history&connectorId=${encodeURIComponent(selected.id)}`).then(value => { if (alive.current) setHistory(value.events.map(event => `${event.action} ${applicationDisplayName(event.source)} ${event.atIst}`).join('\n')); }).catch(reasonValue => { if (alive.current) failed(reasonValue); }).finally(() => { if (alive.current) setBusy(false); }); }}>Connector history</button>
        <button type="button" style={control} disabled={busy || !selected} onClick={() => { if (!selected) return; void post('download', { action: 'download', connectorId: selected.id, expectedVersion: selected.version }).then(result => { if (result && typeof result.body === 'string') setDownload(result.body); }); }}>Download report</button>
        <button type="button" style={control} disabled={busy} onClick={onClose}>Cancel</button>
      </div>
      <ul aria-label="Connector search results">{results.map(result => <li key={result.id}>{result.name} · {result.status} · {result.sharing}</li>)}</ul>
      {preview ? <section aria-label="Connector preview"><p>Type {preview.type ?? connectorType}. Direction {preview.direction ?? direction}. Source {preview.scope?.source ?? source}. Sharing {preview.sharing ?? 'off'}. Dry run {preview.dryRun === false ? 'no' : 'yes'}. Canonical mutated {preview.canonicalMutated ? 'yes' : 'no'}. Live activation {preview.liveActivation ? 'yes' : 'no'}. Access granted {preview.accessGranted ? 'yes' : 'no'}. Secret visible {preview.secretVisible ? 'yes' : 'no'}.</p></section> : null}
      {history ? <pre aria-label="Connector history">{history}</pre> : null}
      {download ? <pre aria-label="Connector report">{download}</pre> : null}
    </div>
  </Dialog>;
}
