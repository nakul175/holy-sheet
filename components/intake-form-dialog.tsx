'use client';
import {applicationDisplayName} from '../lib/application-display-name';
import { useEffect, useRef, useState } from 'react';
import { Dialog } from './editor/rich-editor';
import { ApiError, requestJson } from './editor/use-document-session';

type IntakeForm = { id: string; name: string; status: string; version: number; sharing: string; audience: string; queue: string; anonymous: boolean };
type Catalogue = {
  actorId: string;
  manage: boolean;
  boundary: string;
  assignment: string;
  anonymousPolicy: string;
  activation: string;
  quarantine: string;
  schedules: string;
  recoverable: string;
  edge: string;
  receipt: string;
  sharing: string;
  accessGranted: false;
  activated: false;
  anonymousAllowed: boolean;
  forms: IntakeForm[];
  drafts: { formKey: string; kind: string }[];
};
type Preview = { audience?: string; sharing?: string; accessGranted?: boolean; activated?: boolean; queue?: { name: string; private: boolean }; validation?: { required: string[] }; anonymous?: boolean };

const control = { minHeight: 44, minWidth: 44 };

export default function IntakeFormDialog({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null);
  const [name, setName] = useState('Clinic intake');
  const [fieldKey, setFieldKey] = useState('core:notes');
  const [queue, setQueue] = useState('clinic-intake');
  const [audience, setAudience] = useState('public');
  const [anonymous, setAnonymous] = useState(false);
  const [consent, setConsent] = useState('');
  const [expiry, setExpiry] = useState('24');
  const [formId, setFormId] = useState('');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<IntakeForm[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [history, setHistory] = useState('');
  const [download, setDownload] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmSave, setConfirmSave] = useState(false);
  const [confirmDisable, setConfirmDisable] = useState(false);
  const alive = useRef(true);
  const ops = useRef<Record<string, string>>({});
  const root = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/intake-forms`;

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
    setError(reasonValue instanceof Error ? reasonValue.message : 'Intake forms are restricted or unavailable.');
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
    void load().catch(reasonValue => { if (!ignore && alive.current) setError(reasonValue instanceof Error ? reasonValue.message : 'Intake forms are restricted or unavailable.'); });
    return () => { ignore = true };
  }, [workspaceId]);

  const selected = catalogue?.forms.find(item => item.id === formId) ?? null;
  function definition() {
    return {
      collection: 'organisations',
      fields: [{ key: fieldKey, type: 'text', required: false, maxLength: 200 }],
      validation: { required: [] },
      queue: { name: queue, private: true },
      audience,
      anonymous,
      expiry: { hours: Number(expiry) || 24 },
      consent: consent.trim() ? { text: consent.trim(), version: 1 } : null,
      limits: { bytes: 100000, types: ['pdf', 'png', 'txt'] },
      edge: { cache: 'no-store', residency: 'tenant', public: false },
      bot: { required: true },
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

  return <Dialog title="Intake forms" onClose={() => { if (!busy) onClose(); }}>
    <div className="intake-form-dialog">
      <p>{catalogue?.boundary ?? 'An intake form accepts allowlisted fields into a private queue. It does not open internal records.'}</p>
      <p>{catalogue?.assignment ?? 'Configuring a form, naming a manager, or assigning a queue does not grant access to a page, record, collection, or field.'}</p>
      <p>{catalogue?.anonymousPolicy ?? 'Anonymous intake is optional only when an administrator sets an explicit policy. It is off by default.'}</p>
      <p>{catalogue?.activation ?? 'No external form is activated by this task. Sharing stays off and no live grant is created.'}</p>
      <p>{catalogue?.quarantine ?? 'Untrusted intake stays in quarantine until a permitted reviewer commits it. A matching name never overwrites a central record.'}</p>
      <p>{catalogue?.schedules ?? 'Existing schedules stay paused. Intake forms do not activate a schedule.'}</p>
      <p>{catalogue?.recoverable ?? 'A recoverable draft is kept when the version changes.'}</p>
      <p>{catalogue?.edge ?? 'Intake responses stay with the tenant and use cache no-store. Public caching is off.'}</p>
      <p>{catalogue?.receipt ?? 'Received. This receipt does not confirm a record was created.'}</p>
      {catalogue?.drafts.length ? <p>A recoverable draft is kept for this form.</p> : null}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <fieldset>
        <label><span>Name</span><input aria-label="Form name" value={name} disabled={busy} onChange={event => setName(event.target.value)} /></label>
        <label><span>Field</span><input aria-label="Form field" value={fieldKey} disabled={busy} onChange={event => setFieldKey(event.target.value)} /></label>
        <label><span>Queue</span><input aria-label="Private queue" value={queue} disabled={busy} onChange={event => setQueue(event.target.value)} /></label>
        <label><span>Audience</span><select aria-label="Form audience" value={audience} disabled={busy} onChange={event => setAudience(event.target.value)}><option value="public">Public</option><option value="guest">Guest</option></select></label>
        <label><span>Anonymous</span><input aria-label="Anonymous intake" type="checkbox" checked={anonymous} disabled={busy || catalogue?.anonymousAllowed === false} onChange={event => setAnonymous(event.target.checked)} /></label>
        <label><span>Consent</span><input aria-label="Consent text" value={consent} disabled={busy} onChange={event => setConsent(event.target.value)} /></label>
        <label><span>Expiry hours</span><input aria-label="Form expiry" inputMode="numeric" value={expiry} disabled={busy} onChange={event => setExpiry(event.target.value)} /></label>
        <label><span>Form</span><select aria-label="Saved form" value={formId} disabled={busy} onChange={event => { setFormId(event.target.value); setPreview(null); setConfirmSave(false); setConfirmDisable(false); }}><option value="">Choose a form</option>{(catalogue?.forms ?? []).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label><span>Search</span><input aria-label="Form search" value={query} disabled={busy} onChange={event => setQuery(event.target.value)} /></label>
      </fieldset>
      {selected && <section aria-label="Form scope"><p>Status {selected.status}. Sharing {selected.sharing}. Audience {selected.audience}. Queue {selected.queue} is private. Anonymous {selected.anonymous ? 'yes' : 'no'}. Configuration does not grant access.</p></section>}
      <div className="actions">
        <button type="button" style={control} disabled={busy} onClick={() => { setConfirmSave(true); setPreview(null); }}>Review form</button>
        {confirmSave && <button type="button" style={control} disabled={busy} onClick={() => void post('configure', { action: 'configure', expectedVersion: selected?.version ?? 0, formId: formId || undefined, name, definition: definition() }).then(result => { if (result) setPreview(result as Preview); })}>Confirm form</button>}
        <button type="button" style={control} disabled={busy || !selected} onClick={() => { if (!selected) return; void post('preview', { action: 'preview', formId: selected.id, expectedVersion: selected.version }).then(result => { if (result) setPreview(result as Preview); }); }}>Preview form</button>
        <button type="button" style={control} disabled={busy || !selected} onClick={() => setConfirmDisable(true)}>Disable form</button>
        {confirmDisable && selected && <button type="button" style={control} disabled={busy} onClick={() => void post('disable', { action: 'disable', formId: selected.id, expectedVersion: selected.version })}>Confirm disable</button>}
        <button type="button" style={control} disabled={busy} onClick={() => { setBusy(true); setError(''); void requestJson<{ results: IntakeForm[] }>(`${root}?view=search&q=${encodeURIComponent(query)}`).then(value => { if (alive.current) setResults(value.results); }).catch(reasonValue => { if (alive.current) failed(reasonValue); }).finally(() => { if (alive.current) setBusy(false); }); }}>Search forms</button>
        <button type="button" style={control} disabled={busy || !selected} onClick={() => { if (!selected) return; setBusy(true); void requestJson<{ events: { action: string; source: string; atIst: string }[] }>(`${root}?view=history&formId=${encodeURIComponent(selected.id)}`).then(value => { if (alive.current) setHistory(value.events.map(event => `${event.action} ${applicationDisplayName(event.source)} ${event.atIst}`).join('\n')); }).catch(reasonValue => { if (alive.current) failed(reasonValue); }).finally(() => { if (alive.current) setBusy(false); }); }}>Form history</button>
        <button type="button" style={control} disabled={busy || !selected} onClick={() => { if (!selected) return; void post('download', { action: 'download', formId: selected.id, expectedVersion: selected.version }).then(result => { if (result && typeof result.body === 'string') setDownload(result.body); }); }}>Download report</button>
        <button type="button" style={control} disabled={busy} onClick={onClose}>Cancel</button>
      </div>
      <ul aria-label="Form search results">{results.map(result => <li key={result.id}>{result.name} · {result.status} · {result.sharing}</li>)}</ul>
      {preview && <section aria-label="Form preview"><p>Audience {preview.audience ?? audience}. Sharing {preview.sharing ?? 'off'}. Activated {preview.activated ? 'yes' : 'no'}. Access granted {preview.accessGranted ? 'yes' : 'no'}. Queue {preview.queue?.name ?? queue} private {preview.queue?.private === false ? 'no' : 'yes'}.</p></section>}
      {history && <pre aria-label="Form history">{history}</pre>}
      {download && <pre aria-label="Form report">{download}</pre>}
    </div>
  </Dialog>;
}
