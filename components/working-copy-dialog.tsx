'use client';
import { useEffect, useRef, useState } from 'react';
import { Dialog } from './editor/rich-editor';
import { ApiError, requestJson } from './editor/use-document-session';

type Choice = 'original' | 'copy';
type Conflict = { key: string; kind: string; label: string; base: string; original: string; copy: string };
type Copy = { id: string; copyPageId: string; sourcePageId: string; baseVersion: number; state: string; version: number; title: string; sourceTitle: string | null; sourceReadable: boolean; sourceEditable: boolean };
type List = { copies: Copy[] };
type Reconcile = { sourceVersion: number; conflicts: Conflict[]; preservedRestricted: number; ready: boolean; state: string };

export default function WorkingCopyDialog({ pageId, onClose, onOpen }: { pageId: string; onClose: () => void; onOpen: (id: string) => void }) {
  const [copies, setCopies] = useState<Copy[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [review, setReview] = useState<Reconcile | null>(null);
  const [choices, setChoices] = useState<Record<string, Choice>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmClose, setConfirmClose] = useState<'abandon' | 'archive' | null>(null);
  const alive = useRef(true);
  const createOp = useRef<string | null>(null);
  const reviewOp = useRef<string | null>(null);
  const applyOp = useRef<string | null>(null);

  useEffect(() => {
    alive.current = true;
    const logout = () => { alive.current = false; onClose(); };
    window.addEventListener('holy-sheet:logout', logout);
    return () => { alive.current = false; window.removeEventListener('holy-sheet:logout', logout); };
  }, [onClose]);

  async function load() {
    const list = await requestJson<List>(`/api/v1/pages/${encodeURIComponent(pageId)}/working-copies`);
    if (!alive.current) return list;
    setCopies(list.copies);
    setSelected(current => current || list.copies.find(item => item.state === 'open')?.id || list.copies[0]?.id || '');
    return list;
  }

  useEffect(() => {
    let ignore = false;
    void load().catch(reason => { if (!ignore && alive.current) setError(reason instanceof Error ? reason.message : 'Working copy unavailable'); });
    return () => { ignore = true; };
  }, [pageId]);

  function failed(reason: unknown) {
    setError(reason instanceof Error ? reason.message : 'Working copy unavailable');
    if (reason instanceof ApiError && reason.status < 500) {
      createOp.current = null;
      applyOp.current = null;
    }
  }

  const current = copies.find(item => item.id === selected) ?? null;

  async function create() {
    if (busy) return;
    const operationId = createOp.current ?? crypto.randomUUID();
    createOp.current = operationId;
    setBusy(true);
    setError('');
    try {
      const created = await requestJson<Copy & { id: string }>(`/api/v1/pages/${encodeURIComponent(pageId)}/working-copies`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ operationId }) });
      if (!alive.current) return;
      createOp.current = null;
      await load();
      setSelected(created.id);
      setNotice('Private working copy saved. It does not share the original permissions.');
    } catch (reason) {
      if (alive.current) failed(reason);
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  async function reconcile() {
    if (!current || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await requestJson<Reconcile>(`/api/v1/working-copies/${current.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'reconcile' }) });
      if (!alive.current) return;
      setReview(result);
      setChoices({});
      setNotice(result.conflicts.length ? 'Choose each conflict before applying.' : 'No conflicts. Applying merges the saved copy onto the original.');
    } catch (reason) {
      if (alive.current) failed(reason);
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  async function apply() {
    if (!current || !review || busy) return;
    if (review.conflicts.some(conflict => !choices[conflict.key])) {
      setError('Choose each conflict before applying the working copy.');
      return;
    }
    const operationId = applyOp.current ?? crypto.randomUUID();
    applyOp.current = operationId;
    setBusy(true);
    setError('');
    try {
      const result = await requestJson<{ sourceVersion: number; replayed?: boolean }>(`/api/v1/working-copies/${current.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'apply', operationId, expectedVersion: current.version, expectedSourceVersion: review.sourceVersion, choices }) });
      if (!alive.current) return;
      applyOp.current = null;
      await load();
      setReview(null);
      setNotice(result.replayed ? 'The same apply was already saved.' : `Applied to the original as version ${result.sourceVersion}. Publishing review was not skipped.`);
    } catch (reason) {
      if (alive.current) failed(reason);
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  async function closeCopy(action: 'abandon' | 'archive') {
    if (!current || busy) return;
    if (confirmClose !== action) {
      setConfirmClose(action);
      setNotice(action === 'abandon' ? 'Confirm abandon. The original page stays as it is.' : 'Confirm archive. The original page stays as it is.');
      return;
    }
    const operationId = reviewOp.current ?? crypto.randomUUID();
    reviewOp.current = operationId;
    setBusy(true);
    setError('');
    try {
      await requestJson(`/api/v1/working-copies/${current.id}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, operationId, expectedVersion: current.version }) });
      if (!alive.current) return;
      reviewOp.current = null;
      setConfirmClose(null);
      setReview(null);
      await load();
      setNotice(action === 'abandon' ? 'Working copy abandoned. The original was not changed.' : 'Working copy archived. The original was not changed.');
    } catch (reason) {
      if (alive.current) failed(reason);
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  return <Dialog title="Working copy" onClose={() => { if (!busy) onClose(); }}>
    <div className="export-dialog working-copy-dialog">
      <p>A working copy is private to you. It keeps its own page and block ids, and records the original page and base revision. Applying it saves the original draft and does not publish it.</p>
      <button type="button" className="primary" disabled={busy} style={{ minHeight: 44 }} onClick={() => void create()}>{createOp.current ? 'Retry the same working copy' : 'Create working copy'}</button>
      {copies.length > 0 && <label>Your copies
        <select value={selected} disabled={busy} onChange={event => { setSelected(event.target.value); setReview(null); setConfirmClose(null); }}>
          {copies.map(item => <option key={item.id} value={item.id}>{item.title} · {item.state} · base revision {item.baseVersion}</option>)}
        </select>
      </label>}
      {current && <section aria-label="Working copy actions">
        <p>Based on revision {current.baseVersion}{current.sourceTitle ? ` of ${current.sourceTitle}` : ''}. {current.sourceEditable ? 'You can apply this to the original.' : 'You can keep editing the copy. Applying needs current edit access on the original.'}</p>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <button type="button" disabled={busy || current.state !== 'open'} style={{ minHeight: 44 }} onClick={() => void reconcile()}>Compare with original</button>
          <button type="button" disabled={busy || !current.copyPageId} style={{ minHeight: 44 }} onClick={() => onOpen(current.copyPageId)}>Open copy</button>
          <button type="button" disabled={busy || current.state !== 'open'} style={{ minHeight: 44 }} onClick={() => void closeCopy('abandon')}>{confirmClose === 'abandon' ? 'Confirm abandon' : 'Abandon'}</button>
          <button type="button" disabled={busy || (current.state !== 'open' && current.state !== 'applied')} style={{ minHeight: 44 }} onClick={() => void closeCopy('archive')}>{confirmClose === 'archive' ? 'Confirm archive' : 'Archive'}</button>
        </div>
      </section>}
      {review && <section aria-label="Reconciliation">
        {review.preservedRestricted > 0 && <p>Restricted blocks stay on the original.</p>}
        {review.conflicts.length === 0 && <p>No conflicting edits.</p>}
        {review.conflicts.map(conflict => <fieldset key={conflict.key} style={{ minWidth: 0 }}>
          <legend>{conflict.label}</legend>
          <p>Base: {conflict.base}</p>
          <p>Original: {conflict.original}</p>
          <p>Copy: {conflict.copy}</p>
          <label style={{ display: 'flex', gap: 12, alignItems: 'center', minHeight: 44 }}><input type="radio" name={conflict.key} checked={choices[conflict.key] === 'original'} onChange={() => setChoices(currentChoices => ({ ...currentChoices, [conflict.key]: 'original' }))} />Keep original</label>
          <label style={{ display: 'flex', gap: 12, alignItems: 'center', minHeight: 44 }}><input type="radio" name={conflict.key} checked={choices[conflict.key] === 'copy'} onChange={() => setChoices(currentChoices => ({ ...currentChoices, [conflict.key]: 'copy' }))} />Take working copy</label>
        </fieldset>)}
        <button type="button" className="primary" disabled={busy || current?.state !== 'open' || !current?.sourceEditable} style={{ minHeight: 44 }} onClick={() => void apply()}>{applyOp.current ? 'Retry the same apply' : 'Apply to original'}</button>
      </section>}
      {busy && <p role="status">Working on the copy…</p>}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert" className="form-error">{error}</p>}
    </div>
  </Dialog>;
}
