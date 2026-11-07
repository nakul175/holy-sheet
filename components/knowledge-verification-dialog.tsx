'use client';
import {applicationDisplayName} from '../lib/application-display-name';
import { useEffect, useRef, useState } from 'react';
import { Dialog } from './editor/rich-editor';
import { ApiError, requestJson } from './editor/use-document-session';

type Badge = {
  id: string; targetKind: string; targetId: string; title: string; status: string; label: string; version: number;
  owner: string; basis: string; basisNote: string; expiryDays: number; attestedRevision: number; titleChanged: boolean;
  titleOnlyRule: string; statement: string; reason: string | null;
  recoverableDraft?: { baseVersion: number; payload: { basisNote?: string } } | null;
};
type Catalogue = {
  manage: boolean; steward: boolean; boundary: string; assignment: string; titleOnlyRule: string; statement: string;
  schedules: string; recoverable: string;
  policy: { version: number; bases: string[]; defaultExpiryDays: number; titleOnlyPolicy: string; recoverableDraft: { bases: string[] } | null } | null;
  badges: Badge[];
  members: { id: string; name: string }[];
};
type Preview = { previewId: string; action: string; review: string; version: number };

const control = { minHeight: 44, minWidth: 44 };

export default function KnowledgeVerificationDialog({ workspaceId, pageId, onClose }: { workspaceId: string; pageId: string; onClose: () => void }) {
  const [catalogue, setCatalogue] = useState<Catalogue | null>(null);
  const [targetKind, setTargetKind] = useState<'page' | 'record'>('page');
  const [targetId, setTargetId] = useState(pageId);
  const [ownerId, setOwnerId] = useState('');
  const [basis, setBasis] = useState('source-reviewed');
  const [basisNote, setBasisNote] = useState('Synthetic source was read for this revision.');
  const [expiryDays, setExpiryDays] = useState('90');
  const [reason, setReason] = useState('');
  const [badgeId, setBadgeId] = useState('');
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<{ id: string; title: string; label: string; status: string }[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [history, setHistory] = useState('');
  const [source, setSource] = useState('');
  const [download, setDownload] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirm, setConfirm] = useState<'verify' | 'renew' | 'revoke' | 'report' | null>(null);
  const alive = useRef(true);
  const ops = useRef<Record<string, string>>({});
  const root = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/knowledge-verification`;

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
    setError(reasonValue instanceof Error ? reasonValue.message : 'Verification is restricted or unavailable.');
    if (!(reasonValue instanceof ApiError) || reasonValue.status >= 500) return;
    ops.current = {};
  }
  async function load() {
    const value = await requestJson<Catalogue>(root);
    if (!alive.current) return value;
    setCatalogue(value);
    if (!ownerId && value.members[0]) setOwnerId(value.members[0].id);
    if (value.policy?.bases[0]) setBasis(value.policy.bases[0]);
    return value;
  }
  useEffect(() => {
    let ignore = false;
    void load().catch(reasonValue => { if (!ignore && alive.current) setError(reasonValue instanceof Error ? reasonValue.message : 'Verification is restricted or unavailable.'); });
    return () => { ignore = true };
  }, [workspaceId]);

  const selected = catalogue?.badges.find(item => item.id === badgeId) ?? null;
  async function post(key: string, body: Record<string, unknown>) {
    setBusy(true);
    setError('');
    try {
      const result = await requestJson<Record<string, unknown>>(root, { method: 'POST', body: JSON.stringify({ ...body, operationId: operation(key) }) });
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

  return <Dialog title="Knowledge verification" onClose={() => { if (!busy) onClose(); }}>
    <div className="knowledge-verification-dialog">
      <p>{catalogue?.boundary ?? 'Verification is a steward attestation of one published revision. It is not an AI truth score and it is not a legal certification.'}</p>
      <p>{catalogue?.assignment ?? 'Configuring verification or naming a steward does not grant access to a page, record, collection, or field.'}</p>
      <p>{catalogue?.titleOnlyRule ?? 'A title-only change keeps the badge current. A change to the body or to the recorded source marks the badge stale.'}</p>
      <p>{catalogue?.statement ?? 'Steward attestation of one published revision. Not an AI truth score. Not a legal certification.'}</p>
      <p>{catalogue?.schedules ?? 'Existing schedules stay paused. Verification does not activate a schedule.'}</p>
      <p>{catalogue?.recoverable ?? 'A recoverable draft is kept when the version changes.'}</p>
      {selected?.recoverableDraft && <p>A recoverable draft is kept for this badge.</p>}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      <fieldset>
        <label><span>Target</span><select aria-label="Verification target" value={targetKind} disabled={busy} onChange={event => setTargetKind(event.target.value as 'page' | 'record')}><option value="page">Page</option><option value="record">Record</option></select></label>
        <label><span>Target id</span><input aria-label="Verification target id" value={targetId} disabled={busy} onChange={event => setTargetId(event.target.value)} /></label>
        <label><span>Owner</span><select aria-label="Verification owner" value={ownerId} disabled={busy || !catalogue?.steward} onChange={event => setOwnerId(event.target.value)}>{(catalogue?.members ?? []).map(member => <option key={member.id} value={member.id}>{member.name}</option>)}</select></label>
        <label><span>Basis</span><select aria-label="Verification basis" value={basis} disabled={busy} onChange={event => setBasis(event.target.value)}>{(catalogue?.policy?.bases ?? ['source-reviewed', 'owner-confirmed', 'steward-attested']).map(item => <option key={item} value={item}>{item}</option>)}</select></label>
        <label><span>Basis note</span><input aria-label="Verification basis note" value={basisNote} disabled={busy} onChange={event => setBasisNote(event.target.value)} /></label>
        <label><span>Expiry days</span><input aria-label="Verification expiry days" inputMode="numeric" value={expiryDays} disabled={busy} onChange={event => setExpiryDays(event.target.value)} /></label>
        <label><span>Badge</span><select aria-label="Verification badge" value={badgeId} disabled={busy} onChange={event => { setBadgeId(event.target.value); setPreview(null); setConfirm(null); }}><option value="">Choose a badge</option>{(catalogue?.badges ?? []).map(item => <option key={item.id} value={item.id}>{item.label} · {item.title}</option>)}</select></label>
        <label><span>Reason</span><input aria-label="Verification reason" value={reason} disabled={busy} onChange={event => setReason(event.target.value)} /></label>
      </fieldset>
      {selected && <section aria-label="Verification scope">
        <p>{selected.statement}</p>
        <p>{selected.titleOnlyRule}</p>
        <p>Status {selected.label}. Owner {selected.owner}. Basis {selected.basis}. Revision {selected.attestedRevision}. Title changed {selected.titleChanged ? 'yes' : 'no'}.</p>
        {selected.reason && <p>Scope note: {selected.reason}</p>}
      </section>}
      <div className="actions">
        {catalogue?.steward && <button type="button" style={control} disabled={busy} onClick={() => { setConfirm('verify'); setPreview(null); }}>Review verification</button>}
        {confirm === 'verify' && <button type="button" style={control} disabled={busy} onClick={() => void post('verify-preview', { action: 'preview', kind: 'verify', expectedVersion: 0, targetKind, targetId, ownerId, basis, basisNote, expiryDays: Number(expiryDays) }).then(result => { if (result?.previewId) setPreview(result as Preview); })}>Confirm review</button>}
        {preview?.action === 'verify' && <button type="button" style={control} disabled={busy} onClick={() => void post('verify-apply', { action: 'apply', previewId: preview.previewId, expectedVersion: preview.version }).then(() => setPreview(null))}>Confirm verification</button>}
        {catalogue?.steward && selected && <button type="button" style={control} disabled={busy} onClick={() => setConfirm('renew')}>Review renewal</button>}
        {confirm === 'renew' && selected && <button type="button" style={control} disabled={busy} onClick={() => void post('renew-preview', { action: 'preview', kind: 'renew', badgeId: selected.id, expectedVersion: selected.version, expiryDays: Number(expiryDays), reason }).then(result => { if (result?.previewId) setPreview(result as Preview); })}>Confirm renewal review</button>}
        {preview?.action === 'renew' && <button type="button" style={control} disabled={busy} onClick={() => void post('renew-apply', { action: 'apply', previewId: preview.previewId, expectedVersion: preview.version }).then(() => setPreview(null))}>Confirm renewal</button>}
        {catalogue?.steward && selected && <button type="button" style={control} disabled={busy} onClick={() => setConfirm('revoke')}>Review revoke</button>}
        {confirm === 'revoke' && selected && <button type="button" style={control} disabled={busy} onClick={() => void post('revoke-preview', { action: 'preview', kind: 'revoke', badgeId: selected.id, expectedVersion: selected.version, reason }).then(result => { if (result?.previewId) setPreview(result as Preview); })}>Confirm revoke review</button>}
        {preview?.action === 'revoke' && <button type="button" style={control} disabled={busy} onClick={() => void post('revoke-apply', { action: 'apply', previewId: preview.previewId, expectedVersion: preview.version }).then(() => setPreview(null))}>Confirm revoke</button>}
        <button type="button" style={control} disabled={busy || !selected} onClick={() => setConfirm('report')}>Report concern</button>
        {confirm === 'report' && selected && <button type="button" style={control} disabled={busy} onClick={() => void post('report', { action: 'report', badgeId: selected.id, reason }).then(() => setConfirm(null))}>Confirm concern</button>}
        <button type="button" style={control} disabled={busy} onClick={() => { setBusy(true); setError(''); void requestJson<{ results: { id: string; title: string; label: string; status: string }[] }>(`${root}?view=search&q=${encodeURIComponent(query)}`).then(value => { if (alive.current) setResults(value.results); }).catch(reasonValue => { if (alive.current) failed(reasonValue); }).finally(() => { if (alive.current) setBusy(false); }); }}>Search verification</button>
        <button type="button" style={control} disabled={busy || !selected} onClick={() => { if (!selected) return; setBusy(true); void requestJson<{ events: { action: string; source: string; atIst: string; reason: string | null }[] }>(`${root}?view=history&badgeId=${encodeURIComponent(selected.id)}`).then(value => { if (alive.current) setHistory(value.events.map(event => `${event.action} ${applicationDisplayName(event.source)} ${event.atIst} ${event.reason ?? ''}`).join('\n')); }).catch(reasonValue => { if (alive.current) failed(reasonValue); }).finally(() => { if (alive.current) setBusy(false); }); }}>Verification history</button>
        <button type="button" style={control} disabled={busy || !selected} onClick={() => { if (!selected) return; setBusy(true); void requestJson<{ excerpt: string; badge: { label: string; statement: string } }>(`${root}?view=source&badgeId=${encodeURIComponent(selected.id)}`).then(value => { if (alive.current) setSource(`${value.badge.label}. ${value.badge.statement} ${value.excerpt}`); }).catch(reasonValue => { if (alive.current) failed(reasonValue); }).finally(() => { if (alive.current) setBusy(false); }); }}>Source preview</button>
        <button type="button" style={control} disabled={busy || !selected} onClick={() => { if (!selected) return; void post('download', { action: 'download', badgeId: selected.id, expectedVersion: selected.version }).then(result => { if (result && typeof result.body === 'string') setDownload(result.body); }); }}>Download verification</button>
        <button type="button" style={control} disabled={busy} onClick={onClose}>Cancel</button>
      </div>
      <label><span>Search</span><input aria-label="Verification search" value={query} disabled={busy} onChange={event => setQuery(event.target.value)} /></label>
      <ul aria-label="Verification search results">{results.map(result => <li key={result.id}>{result.label} · {result.title} · {result.status}</li>)}</ul>
      {preview && <section aria-label="Verification preview"><p>{preview.review}</p></section>}
      {history && <pre aria-label="Verification history">{history}</pre>}
      {source && <pre aria-label="Verification source preview">{source}</pre>}
      {download && <pre aria-label="Verification download">{download}</pre>}
    </div>
  </Dialog>;
}
