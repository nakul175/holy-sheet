'use client';
import {applicationDisplayName} from '../lib/application-display-name';
import { useEffect, useRef, useState } from 'react';
import { Dialog } from './editor/rich-editor';
import { ApiError, requestJson } from './editor/use-document-session';

type Portal = { id: string; name: string; status: string; version: number; sharing: string; admitted: boolean };
type Catalogue = {
  actorId: string;
  manage: boolean;
  boundary: string;
  assignment: string;
  authority: string;
  activation: string;
  schedules: string;
  recoverable: string;
  edge: string;
  sharing: string;
  accessGranted: false;
  invitationSent: false;
  portals: Portal[];
  drafts: { portalKey: string; kind: string }[];
};
type Preview = { audience?: string; review?: string; sharing?: string; accessGranted?: boolean; cacheGeneration?: number; screens?: { name: string }[]; records?: { name: string; values: Record<string, string> }[] };

const control = { minHeight: 44, minWidth: 44 };

export default function GuestPortalDialog({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }) {
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null);
  const [name, setName] = useState('Clinic portal');
  const [recordId, setRecordId] = useState('');
  const [fieldKey, setFieldKey] = useState('core:notes');
  const [expiry, setExpiry] = useState('24');
  const [portalId, setPortalId] = useState('');
  const [suiteSubject, setSuiteSubject] = useState('');
  const [query, setQuery] = useState('');
  const [comment, setComment] = useState('');
  const [results, setResults] = useState<Portal[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [history, setHistory] = useState('');
  const [download, setDownload] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmSave, setConfirmSave] = useState(false);
  const [confirmPause, setConfirmPause] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const alive = useRef(true);
  const ops = useRef<Record<string, string>>({});
  const root = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/guest-portals`;

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
    setError(reasonValue instanceof Error ? reasonValue.message : 'Guest portals are restricted or unavailable.');
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
    void load().catch(reasonValue => { if (!ignore && alive.current) setError(reasonValue instanceof Error ? reasonValue.message : 'Guest portals are restricted or unavailable.'); });
    return () => { ignore = true };
  }, [workspaceId]);

  const selected = catalogue?.portals.find(item => item.id === portalId) ?? null;
  function definition() {
    return {
      screens: [{ id: 'clinic', name: 'Clinic', fields: [fieldKey], actions: ['view', 'form', 'comment', 'file', 'export', 'history'] }],
      scope: { collection: 'organisations', recordIds: [recordId] },
      fields: [{ key: fieldKey, mode: 'edit' }],
      actions: ['view', 'form', 'comment', 'file', 'export', 'history'],
      expiry: { hours: Number(expiry) || 24 },
      edge: { cache: 'no-store', residency: 'tenant', public: false },
      guestPreview: true,
      domain: 'partner.example',
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

  return <Dialog title="Guest portals" onClose={() => { if (!busy) onClose(); }}>
    <div className="guest-portal-dialog">
      <p>{catalogue?.boundary ?? 'A guest portal shows only the screens, records, fields, and actions an administrator configures. It does not open the workspace.'}</p>
      <p>{catalogue?.assignment ?? 'Configuring a portal, linking a suite identity, or naming a manager does not grant access to a page, record, collection, or field.'}</p>
      <p>{catalogue?.authority ?? 'Guest access needs an explicit current grant and eligible suite authentication. A URL, a domain match, or an account assignment does not grant access.'}</p>
      <p>{catalogue?.activation ?? 'Sharing stays off until a separate explicit activation path. This portal does not send invitations or store credentials.'}</p>
      <p>{catalogue?.schedules ?? 'Existing schedules stay paused. Portals do not activate a schedule.'}</p>
      <p>{catalogue?.recoverable ?? 'A recoverable draft is kept when the version changes.'}</p>
      <p>{catalogue?.edge ?? 'Guest responses stay with the tenant and use cache no-store. Public caching is off.'}</p>
      {catalogue?.drafts.length ? <p>A recoverable draft is kept for this portal.</p> : null}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <fieldset>
        <label><span>Name</span><input aria-label="Portal name" value={name} disabled={busy} onChange={event => setName(event.target.value)} /></label>
        <label><span>Record</span><input aria-label="Portal record" value={recordId} disabled={busy} onChange={event => setRecordId(event.target.value)} /></label>
        <label><span>Field</span><input aria-label="Portal field" value={fieldKey} disabled={busy} onChange={event => setFieldKey(event.target.value)} /></label>
        <label><span>Expiry hours</span><input aria-label="Portal expiry" inputMode="numeric" value={expiry} disabled={busy} onChange={event => setExpiry(event.target.value)} /></label>
        <label><span>Suite subject</span><input aria-label="Portal suite subject" value={suiteSubject} disabled={busy} onChange={event => setSuiteSubject(event.target.value)} /></label>
        <label><span>Portal</span><select aria-label="Saved portal" value={portalId} disabled={busy} onChange={event => { setPortalId(event.target.value); setPreview(null); setConfirmSave(false); setConfirmPause(false); setConfirmRevoke(false); }}><option value="">Choose a portal</option>{(catalogue?.portals ?? []).map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
        <label><span>Search</span><input aria-label="Portal search" value={query} disabled={busy} onChange={event => setQuery(event.target.value)} /></label>
        <label><span>Comment</span><input aria-label="Portal comment" value={comment} disabled={busy} onChange={event => setComment(event.target.value)} /></label>
      </fieldset>
      {selected && <section aria-label="Portal scope"><p>Status {selected.status}. Sharing {selected.sharing}. Admitted {selected.admitted ? 'yes' : 'no'}. Configuration does not grant access.</p></section>}
      <div className="actions">
        <button type="button" style={control} disabled={busy} onClick={() => { setConfirmSave(true); setPreview(null); }}>Review portal</button>
        {confirmSave && <button type="button" style={control} disabled={busy || !recordId} onClick={() => void post('configure', { action: 'configure', expectedVersion: selected?.version ?? 0, portalId: portalId || undefined, name, definition: definition() }).then(result => { if (result) setPreview(result as Preview); })}>Confirm portal</button>}
        <button type="button" style={control} disabled={busy || !selected} onClick={() => { if (!selected) return; void post('preview', { action: 'preview', portalId: selected.id, expectedVersion: selected.version }).then(result => { if (result) setPreview(result as Preview); }); }}>Guest preview</button>
        <button type="button" style={control} disabled={busy || !selected} onClick={() => setConfirmPause(true)}>Pause portal</button>
        {confirmPause && selected && <button type="button" style={control} disabled={busy} onClick={() => void post('pause', { action: 'pause', portalId: selected.id, expectedVersion: selected.version })}>Confirm pause</button>}
        <button type="button" style={control} disabled={busy || !selected} onClick={() => setConfirmRevoke(true)}>Revoke portal</button>
        {confirmRevoke && selected && <button type="button" style={control} disabled={busy} onClick={() => void post('revoke', { action: 'revoke', portalId: selected.id, expectedVersion: selected.version })}>Confirm revoke</button>}
        <button type="button" style={control} disabled={busy || !selected || !suiteSubject} onClick={() => { if (!selected) return; void post('link', { action: 'link-identity', portalId: selected.id, expectedVersion: selected.version, suiteSubject }); }}>Link suite subject</button>
        <button type="button" style={control} disabled={busy} onClick={() => { setBusy(true); setError(''); void requestJson<{ results: Portal[] }>(`${root}?view=search&q=${encodeURIComponent(query)}`).then(value => { if (alive.current) setResults(value.results); }).catch(reasonValue => { if (alive.current) failed(reasonValue); }).finally(() => { if (alive.current) setBusy(false); }); }}>Search portals</button>
        <button type="button" style={control} disabled={busy || !selected} onClick={() => { if (!selected) return; setBusy(true); void requestJson<{ events: { action: string; source: string; atIst: string }[] }>(`${root}?view=history&portalId=${encodeURIComponent(selected.id)}`).then(value => { if (alive.current) setHistory(value.events.map(event => `${event.action} ${applicationDisplayName(event.source)} ${event.atIst}`).join('\n')); }).catch(reasonValue => { if (alive.current) failed(reasonValue); }).finally(() => { if (alive.current) setBusy(false); }); }}>Portal history</button>
        <button type="button" style={control} disabled={busy || !selected} onClick={() => { if (!selected) return; void post('download', { action: 'download', portalId: selected.id, expectedVersion: selected.version }).then(result => { if (result && typeof result.body === 'string') setDownload(result.body); }); }}>Download portal</button>
        <button type="button" style={control} disabled={busy || !selected || !comment} onClick={() => { if (!selected) return; void post('comment', { action: 'comment', portalId: selected.id, recordId, expectedVersion: selected.version, body: comment }); }}>Add comment</button>
        <button type="button" style={control} disabled={busy} onClick={onClose}>Cancel</button>
      </div>
      <ul aria-label="Portal search results">{results.map(result => <li key={result.id}>{result.name} · {result.status} · {result.sharing}</li>)}</ul>
      {preview && <section aria-label="Guest preview"><p>Audience {preview.audience ?? 'guest-preview'}. Sharing {preview.sharing ?? 'off'}. Access granted {preview.accessGranted ? 'yes' : 'no'}.</p>{preview.screens?.map(screen => <p key={screen.name}>{screen.name}</p>)}{preview.records?.map(record => <p key={record.name}>{record.name}</p>)}</section>}
      {history && <pre aria-label="Portal history">{history}</pre>}
      {download && <pre aria-label="Portal download">{download}</pre>}
    </div>
  </Dialog>;
}
