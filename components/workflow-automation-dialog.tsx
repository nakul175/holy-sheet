'use client';
import { useEffect, useRef, useState } from 'react';
import { Dialog } from './editor/rich-editor';
import { ApiError, requestJson } from './editor/use-document-session';

type Definition = { trigger: { event: string; field?: string }; conditions: { all: { field: string; operator: string; value?: string }[] }; actions: Record<string, unknown>[]; identity: { kind: 'delegated' | 'service'; subjectId: string } };
type Workflow = { id: string; collection: string; name: string; status: string; version: number; definition: Definition; recoverableDraft?: { baseVersion: number; definition: Definition } | null };
type Catalogue = { manage: boolean; boundary: string; assignment: string; review: string; schedules: string; accounts: string; workflows: Workflow[]; collections: { id: string; name: string }[]; fields: { collection: string; key: string; label: string; kind: string; writable: boolean }[]; colleagues: { id: string; name: string }[] };
type Preview = { previewId: string; action?: string; review: string; version: number; plan: { matched: boolean; blocked: string | null; actions: { type: string; field: string }[] } | null };

const control = { minHeight: 44, minWidth: 44 };
const operators = ['is-empty', 'is-not-empty', 'equals', 'not-equals', 'greater-than', 'less-than'];

export default function WorkflowAutomationDialog({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null);
  const [workflowId, setWorkflowId] = useState('');
  const [name, setName] = useState('');
  const [collection, setCollection] = useState('');
  const [event, setEvent] = useState('record.created');
  const [triggerField, setTriggerField] = useState('');
  const [conditionField, setConditionField] = useState('');
  const [operator, setOperator] = useState('is-empty');
  const [conditionValue, setConditionValue] = useState('');
  const [actionType, setActionType] = useState('set-field');
  const [actionField, setActionField] = useState('');
  const [actionValue, setActionValue] = useState('');
  const [identityKind, setIdentityKind] = useState<'delegated' | 'service'>('delegated');
  const [subjectId, setSubjectId] = useState('');
  const [recordId, setRecordId] = useState('');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<{ id: string; name: string; status: string; version: number }[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [history, setHistory] = useState('');
  const [download, setDownload] = useState('');
  const [rollbackVersion, setRollbackVersion] = useState('1');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirm, setConfirm] = useState<'create' | null>(null);
  const alive = useRef(true);
  const ops = useRef<Record<string, string>>({});
  const root = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/workflows`;

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
    setError(reason instanceof Error ? reason.message : 'Workflow automation is restricted or unavailable.');
    if (!(reason instanceof ApiError) || reason.status >= 500) return;
    ops.current = {};
  }

  function applyDefinition(definition: Definition) {
    setEvent(definition.trigger.event);
    setTriggerField(definition.trigger.field ?? '');
    setConditionField(definition.conditions.all[0]?.field ?? '');
    setOperator(definition.conditions.all[0]?.operator ?? 'is-empty');
    setConditionValue(definition.conditions.all[0]?.value ?? '');
    const action = definition.actions[0] ?? {};
    setActionType(typeof action.type === 'string' ? action.type : 'set-field');
    setActionField(typeof action.field === 'string' ? action.field : '');
    setActionValue(typeof action.value === 'string' ? action.value : typeof action.text === 'string' ? action.text : '');
    setIdentityKind(definition.identity.kind);
    setSubjectId(definition.identity.subjectId);
  }

  async function load() {
    const value = await requestJson<Catalogue>(root);
    if (!alive.current) return value;
    setCatalogue(value);
    if (!collection && value.collections[0]) setCollection(value.collections[0].id);
    if (!subjectId && value.colleagues[0]) setSubjectId(value.colleagues[0].id);
    if (!actionField && value.fields[0]) setActionField(value.fields[0].key);
    return value;
  }

  useEffect(() => {
    let ignore = false;
    void load().catch(reason => { if (!ignore && alive.current) setError(reason instanceof Error ? reason.message : 'Workflow automation is restricted or unavailable.'); });
    return () => { ignore = true; };
  }, [workspaceId]);

  const selected = catalogue?.workflows.find(item => item.id === workflowId) ?? null;
  const fields = (catalogue?.fields ?? []).filter(field => field.collection === (selected?.collection || collection));
  const definition: Definition = {
    trigger: event === 'record.field-changed' && triggerField ? { event, field: triggerField } : { event },
    conditions: { all: conditionField ? [{ field: conditionField, operator, ...(!['is-empty', 'is-not-empty'].includes(operator) ? { value: conditionValue } : {}) }] : [] },
    actions: [actionType === 'clear-field' ? { type: actionType, field: actionField } : actionType === 'append-note' ? { type: actionType, field: actionField, text: actionValue } : { type: actionType, field: actionField, value: actionValue }],
    identity: { kind: identityKind, subjectId },
  };

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
      setNotice(value.conflict ? 'The workflow version changed. The draft is kept.' : done);
      await load();
    } catch (reason) { if (alive.current) failed(reason); } finally { if (alive.current) setBusy(false); }
  }

  return <Dialog title="Workflows" onClose={() => { if (!busy) onClose(); }}>
    <div className="export-dialog workflow-dialog">
      <p>{catalogue?.boundary} {catalogue?.assignment}</p>
      <p>{catalogue?.schedules} {catalogue?.accounts}</p>
      {catalogue?.workflows.some(item => item.recoverableDraft) && <p role="status">A recoverable draft is kept.</p>}
      {error && <p role="alert">{error}</p>}
      {!catalogue && error && <p>Workflows are unavailable in this workspace.</p>}
      {notice && <p role="status">{notice}</p>}
      {catalogue && <>
      <label>Workflow
        <select aria-label="Workflow" value={workflowId} disabled={busy} onChange={event => {
          const workflow = catalogue?.workflows.find(item => item.id === event.target.value);
          setWorkflowId(event.target.value);
          setPreview(null);
          setConfirm(null);
          if (!workflow) return;
          setName(workflow.name);
          setCollection(workflow.collection);
          applyDefinition(workflow.recoverableDraft?.definition ?? workflow.definition);
        }}>
          <option value="">New workflow</option>
          {catalogue?.workflows.map(workflow => <option key={workflow.id} value={workflow.id}>{workflow.name} · {workflow.status} · v{workflow.version}</option>)}
        </select>
      </label>
      <label>Name <input aria-label="Workflow name" value={name} disabled={busy} onChange={event => setName(event.target.value)} /></label>
      <label>Collection
        <select aria-label="Workflow collection" value={collection} disabled={busy || !!selected} onChange={event => { setCollection(event.target.value); setActionField(''); }}>
          <option value="">Choose a collection</option>
          {catalogue?.collections.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </label>
      <label>Event
        <select aria-label="Workflow event" value={event} disabled={busy} onChange={event => setEvent(event.target.value)}>
          <option value="record.created">Record created</option>
          <option value="record.updated">Record updated</option>
          <option value="record.field-changed">Field changed</option>
        </select>
      </label>
      {event === 'record.field-changed' && <label>Trigger field
        <select aria-label="Trigger field" value={triggerField} disabled={busy} onChange={event => setTriggerField(event.target.value)}>
          <option value="">Choose a field</option>
          {fields.map(field => <option key={field.key} value={field.key}>{field.label}</option>)}
        </select>
      </label>}
      <fieldset>
        <legend>Condition</legend>
        <label>Field
          <select aria-label="Condition field" value={conditionField} disabled={busy} onChange={event => setConditionField(event.target.value)}>
            <option value="">Always</option>
            {fields.map(field => <option key={field.key} value={field.key}>{field.label}</option>)}
          </select>
        </label>
        <label>Operator
          <select aria-label="Condition operator" value={operator} disabled={busy} onChange={event => setOperator(event.target.value)}>
            {operators.map(item => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>
        {!['is-empty', 'is-not-empty'].includes(operator) && <label>Value <input aria-label="Condition value" value={conditionValue} disabled={busy} onChange={event => setConditionValue(event.target.value)} /></label>}
      </fieldset>
      <fieldset>
        <legend>Action</legend>
        <label>Type
          <select aria-label="Action type" value={actionType} disabled={busy} onChange={event => setActionType(event.target.value)}>
            <option value="set-field">Set field</option>
            <option value="clear-field">Clear field</option>
            <option value="append-note">Append note</option>
          </select>
        </label>
        <label>Field
          <select aria-label="Action field" value={actionField} disabled={busy} onChange={event => setActionField(event.target.value)}>
            <option value="">Choose a field</option>
            {fields.filter(field => actionType === 'append-note' ? field.kind === 'long-text' : field.writable || actionType !== 'clear-field').map(field => <option key={field.key} value={field.key}>{field.label}</option>)}
          </select>
        </label>
        {actionType !== 'clear-field' && <label>Value <input aria-label="Action value" value={actionValue} disabled={busy} onChange={event => setActionValue(event.target.value)} /></label>}
      </fieldset>
      <label>Runtime identity
        <select aria-label="Runtime identity kind" value={identityKind} disabled={busy} onChange={event => setIdentityKind(event.target.value === 'service' ? 'service' : 'delegated')}>
          <option value="delegated">Delegated user</option>
          <option value="service">Service identity</option>
        </select>
      </label>
      <label>Identity subject
        <select aria-label="Identity subject" value={subjectId} disabled={busy} onChange={event => setSubjectId(event.target.value)}>
          <option value="">Choose a person</option>
          {catalogue?.colleagues.map(person => <option key={person.id} value={person.id}>{person.name}</option>)}
        </select>
      </label>
      {catalogue?.manage && <div className="actions">
        {!selected && (confirm === 'create' ? <button type="button" style={control} disabled={busy} onClick={() => void command('create', { action: 'create', collection, name, definition }, 'Workflow saved as a draft. It is not active.')}>Confirm new workflow</button> : <button type="button" style={control} disabled={busy} onClick={() => setConfirm('create')}>Create workflow</button>)}
        {selected && <>
          <button type="button" style={control} disabled={busy} onClick={() => void command(`stash:${selected.id}`, { action: 'stash', workflowId: selected.id, expectedVersion: selected.version, definition }, 'Draft kept. Cancel leaves the saved workflow unchanged.')}>Keep draft</button>
          <button type="button" style={control} disabled={busy} onClick={() => void command(`preview:${selected.id}`, { action: 'preview', workflowId: selected.id, kind: 'version-change', expectedVersion: selected.version, definition }, 'Review the version change, then confirm it.')}>Review version change</button>
          <button type="button" style={control} disabled={busy || preview?.action !== 'version-change'} onClick={() => void command(`apply:${selected.id}`, { action: 'apply', previewId: preview?.previewId, expectedVersion: selected.version }, 'Version saved. An active workflow returns to paused.')}>Confirm version change</button>
          {selected.status !== 'active' && <>
            <button type="button" style={control} disabled={busy} onClick={() => void command(`activate-preview:${selected.id}`, { action: 'preview', workflowId: selected.id, kind: 'activate', expectedVersion: selected.version }, 'Review activation, then confirm it.')}>Review activation</button>
            <button type="button" style={control} disabled={busy || preview?.action !== 'activate'} onClick={() => void command(`activate:${selected.id}`, { action: 'apply', previewId: preview?.previewId, expectedVersion: selected.version }, 'Workflow activated.')}>Confirm activation</button>
          </>}
          {selected.status === 'active' && <>
            <button type="button" style={control} disabled={busy} onClick={() => void command(`pause-preview:${selected.id}`, { action: 'preview', workflowId: selected.id, kind: 'pause', expectedVersion: selected.version }, 'Review the pause, then confirm it.')}>Review pause</button>
            <button type="button" style={control} disabled={busy || preview?.action !== 'pause'} onClick={() => void command(`pause:${selected.id}`, { action: 'apply', previewId: preview?.previewId, expectedVersion: selected.version }, 'Workflow paused.')}>Confirm pause</button>
          </>}
        </>}
      </div>}
      {selected && catalogue?.manage && <div className="actions">
        <label>Rollback version <input aria-label="Rollback version" value={rollbackVersion} disabled={busy} onChange={event => setRollbackVersion(event.target.value)} /></label>
        <button type="button" style={control} disabled={busy} onClick={() => void command(`rollback-preview:${selected.id}`, { action: 'preview', workflowId: selected.id, kind: 'rollback', expectedVersion: selected.version, targetVersion: Number(rollbackVersion) }, 'Review the rollback, then confirm it.')}>Review rollback</button>
        <button type="button" style={control} disabled={busy || preview?.action !== 'rollback'} onClick={() => void command(`rollback:${selected.id}`, { action: 'apply', previewId: preview?.previewId, expectedVersion: selected.version }, 'Rolled back. The workflow stays paused.')}>Confirm rollback</button>
      </div>}
      <p>{preview?.review} {preview?.plan ? `Dry-run ${preview.plan.blocked ?? (preview.plan.matched ? 'matched' : 'not matched')}.` : ''}</p>
      <label>Record id <input aria-label="Workflow record id" value={recordId} disabled={busy} onChange={event => setRecordId(event.target.value)} /></label>
      <div className="actions">
        <button type="button" style={control} disabled={busy || !selected || !recordId.trim()} onClick={() => void command(`dry:${selected?.id}`, { action: 'preview', workflowId: selected?.id, kind: 'dry-run', expectedVersion: selected?.version, recordId: recordId.trim(), useDraft: !!selected?.recoverableDraft }, 'Dry-run finished. No record was changed.')}>Dry-run</button>
        <button type="button" style={control} disabled={busy || !selected} onClick={() => void requestJson<{ events: { action: string; actorName: string; atIst: string; source: string; outcome: string | null }[]; runs: { revision: number; outcome: string; status: string }[] }>(`${root}?view=history&workflowId=${encodeURIComponent(selected?.id ?? '')}`).then(value => { if (alive.current) setHistory([...value.events.map(item => `${item.action} · ${item.actorName} · ${item.atIst} · ${item.source}`), ...value.runs.map(item => `revision ${item.revision} · ${item.outcome} · ${item.status}`)].join('\n')); }).catch(failed)}>Workflow history</button>
        <button type="button" style={control} disabled={busy || !selected} onClick={() => void command(`download:${selected?.id}`, { action: 'download', workflowId: selected?.id, expectedVersion: selected?.version }, 'Download ready.')}>Download workflow</button>
      </div>
      <label>Search <input aria-label="Workflow search" value={query} disabled={busy} onChange={event => setQuery(event.target.value)} /></label>
      <div className="actions">
        <button type="button" style={control} disabled={busy || !query.trim()} onClick={() => void requestJson<{ results: { id: string; name: string; status: string; version: number }[] }>(`${root}?view=search&q=${encodeURIComponent(query.trim())}`).then(value => { if (alive.current) setResults(value.results); }).catch(failed)}>Search workflows</button>
      </div>
      <ul aria-label="Workflow search results">{results.map(result => <li key={result.id}>{result.name} · {result.status} · v{result.version}</li>)}</ul>
      {history && <pre>{history}</pre>}
      {download && <pre>{download}</pre>}
      </>}
      <button type="button" style={control} disabled={busy} onClick={onClose}>Cancel</button>
    </div>
  </Dialog>;
}
