'use client';
import {applicationDisplayName} from '../lib/application-display-name';
import { useEffect, useRef, useState } from 'react';
import { unrelatedMetadataStatement } from '../lib/dependency-impact-plan';
import { Dialog } from './editor/rich-editor';
import { ApiError, requestJson } from './editor/use-document-session';

type Kind = 'link' | 'template' | 'snippet' | 'synced-source';
type Review = 'current' | 'needs_review' | 'acknowledged' | 'stale';
type Edge = {
  id: string; kind: Kind; kindLabel: string; sourceId: string; sourceTitle: string; sourceRevision: number; liveSourceRevision: number;
  sourceState: string; dependentPageId: string; dependentTitle: string; liveDependentRevision: number; reviewerId: string; reviewerName: string;
  reviewerAuthority: boolean; reviewState: Review; reviewReason: string; note: string; version: number; sourceVersion: number; access?: 'manage' | 'review' | 'view';
  recoverableDraft?: { note: string; reviewerId: string } | null;
};
type List = { manage: boolean; edges: { id: string; kindLabel: string; sourceTitle: string; dependentTitle: string; reviewState: Review }[]; colleagues?: { id: string; name: string }[]; currentPage?: { id: string; title: string; version: number } | null };
type Impact = { truncated: boolean; edges: { sourceTitle: string; dependentTitle: string; reviewState: Review; reviewReason: string; sourceState: string; cycle: boolean }[] };

const control = { minHeight: 44, minWidth: 44 };
const kinds: { value: Kind; label: string }[] = [
  { value: 'link', label: 'Explicit link' },
  { value: 'template', label: 'Template' },
  { value: 'snippet', label: 'Snippet' },
  { value: 'synced-source', label: 'Synced source' },
];

export default function DependencyImpactDialog({ workspaceId, pageId, onClose }: { workspaceId: string; pageId: string; onClose: () => void }) {
  const [list, setList] = useState<List>({ manage: false, edges: [] });
  const [edge, setEdge] = useState<Edge | null>(null);
  const [kind, setKind] = useState<Kind>('link');
  const [sourceId, setSourceId] = useState('');
  const [sourceRevision, setSourceRevision] = useState('1');
  const [reviewerId, setReviewerId] = useState('');
  const [note, setNote] = useState('');
  const [mergeTarget, setMergeTarget] = useState('');
  const [impact, setImpact] = useState<Impact | null>(null);
  const [history, setHistory] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirm, setConfirm] = useState<'retire' | 'merge' | null>(null);
  const alive = useRef(true);
  const ops = useRef<Record<string, string>>({});

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

  async function loadList() {
    const value = await requestJson<List>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/dependency-impact?pageId=${encodeURIComponent(pageId)}`);
    if (!alive.current) return value;
    setList(value);
    setReviewerId(current => current || value.colleagues?.[0]?.id || '');
    return value;
  }

  async function openEdge(id: string) {
    const value = await requestJson<Edge>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/dependency-impact/${encodeURIComponent(id)}`);
    if (!alive.current) return;
    setEdge(value);
    setNote(value.recoverableDraft?.note ?? value.note);
    setReviewerId(value.recoverableDraft?.reviewerId ?? value.reviewerId);
    setSourceId(value.sourceId);
    setKind(value.kind);
    setSourceRevision(String(value.liveSourceRevision));
    setImpact(null);
    setConfirm(null);
  }

  useEffect(() => {
    let ignore = false;
    void loadList().catch(reason => { if (!ignore && alive.current) setError(reason instanceof Error ? reason.message : 'Dependency unavailable'); });
    return () => { ignore = true; };
  }, [workspaceId, pageId]);

  function failed(reason: unknown) {
    setError(reason instanceof Error ? reason.message : 'Dependency unavailable');
    if (!(reason instanceof ApiError) || reason.status >= 500) return;
    ops.current = {};
  }

  async function record() {
    if (busy || !list.manage || !list.currentPage) return;
    if (!sourceId.trim()) { setError('Enter the source id.'); return; }
    const revision = Number(sourceRevision);
    if (!Number.isInteger(revision) || revision < 1) { setError('Enter the source revision.'); return; }
    if (!reviewerId) { setError('Choose a responsible reviewer.'); return; }
    const operationId = operation('record');
    setBusy(true);
    setError('');
    try {
      const created = await requestJson<Edge>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/dependency-impact`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'record', operationId, kind, sourceId: sourceId.trim(), sourceRevision: revision, dependentPageId: list.currentPage.id, reviewerId, note: note.trim() }),
      });
      if (!alive.current) return;
      clearOperation('record');
      await loadList();
      setEdge(created);
      setNotice('Dependency saved. Assigning a reviewer does not grant access to the source or the dependent page.');
    } catch (reason) { if (alive.current) failed(reason); } finally { if (alive.current) setBusy(false); }
  }

  async function command(key: string, path: string, body: Record<string, unknown>, done: string) {
    if (busy) return;
    const operationId = operation(key);
    setBusy(true);
    setError('');
    try {
      const result = await requestJson<Edge & { body?: string; filename?: string; contentType?: string; state?: string; rule?: string; marksReview?: boolean }>(path, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...body, operationId }),
      });
      if (!alive.current) return;
      clearOperation(key);
      if (result.body && result.filename) {
        const file = new Blob([result.body], { type: result.contentType ?? 'text/markdown' });
        const url = URL.createObjectURL(file);
        const link = document.createElement('a');
        link.href = url;
        link.download = result.filename;
        link.click();
        URL.revokeObjectURL(url);
      }
      if (edge && result.id) await openEdge(edge.id);
      else if (edge) await openEdge(edge.id);
      setConfirm(null);
      setNotice(done);
    } catch (reason) { if (alive.current) failed(reason); } finally { if (alive.current) setBusy(false); }
  }

  const editable = edge?.access === 'manage';
  const base = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/dependency-impact`;

  return <Dialog title="Dependency impact" onClose={() => { if (!busy) onClose(); }}>
    <div className="export-dialog dependency-impact-dialog">
      <p>Track an explicit link, template, snippet, or synced source. This does not guess other dependencies or rewrite the dependent page. {unrelatedMetadataStatement} Assigning a reviewer does not grant access.</p>
      {list.manage && <section aria-label="Record a dependency">
        <label>Kind
          <select aria-label="Dependency kind" value={kind} disabled={busy} onChange={event => setKind(event.target.value as Kind)}>
            {kinds.map(item => <option key={item.value} value={item.value}>{item.label}</option>)}
          </select>
        </label>
        <label>Source
          <input aria-label="Source id" value={sourceId} disabled={busy} onChange={event => setSourceId(event.target.value)} />
        </label>
        <label>Source revision
          <input aria-label="Source revision" inputMode="numeric" value={sourceRevision} disabled={busy} onChange={event => setSourceRevision(event.target.value)} />
        </label>
        <label>Responsible reviewer
          <select aria-label="Responsible reviewer" value={reviewerId} disabled={busy} onChange={event => setReviewerId(event.target.value)}>
            {(list.colleagues ?? []).map(person => <option key={person.id} value={person.id}>{person.name}</option>)}
          </select>
        </label>
        <label>Note
          <textarea aria-label="Dependency note" maxLength={2000} value={note} disabled={busy} onChange={event => setNote(event.target.value)} />
        </label>
        <button type="button" style={control} disabled={busy} onClick={() => void record()}>Record dependency</button>
      </section>}
      <label>Tracked dependencies
        <select aria-label="Dependency edges" value={edge?.id ?? ''} disabled={busy} onChange={event => { if (event.target.value) void openEdge(event.target.value).catch(failed); }}>
          <option value="">Choose a dependency</option>
          {list.edges.map(item => <option key={item.id} value={item.id}>{item.kindLabel}: {item.sourceTitle} → {item.dependentTitle}</option>)}
        </select>
      </label>
      {edge && <section aria-label="Dependency review">
        <p>{edge.kindLabel} · {edge.sourceTitle} · revision {edge.liveSourceRevision} · {edge.dependentTitle} · {edge.reviewState === 'needs_review' ? 'Needs review' : edge.reviewState === 'stale' ? 'Stale review' : edge.reviewState === 'acknowledged' ? 'Acknowledged' : 'Current'}{edge.reviewReason ? ` · ${edge.reviewReason}` : ''}</p>
        {!edge.reviewerAuthority && <p>The responsible reviewer lacks authority. Reassign the review. Assignment does not grant access.</p>}
        {edge.recoverableDraft && <p>A recoverable draft is kept for this dependency.</p>}
        <label>Note
          <textarea aria-label="Edge note" maxLength={2000} value={note} disabled={busy || !editable} onChange={event => setNote(event.target.value)} />
        </label>
        <div className="actions">
          {editable && <button type="button" style={control} disabled={busy} onClick={() => void command('save', `${base}/${encodeURIComponent(edge.id)}`, { action: 'save', expectedVersion: edge.version, note: note.trim(), reviewerId: edge.reviewerId }, 'Note saved. Unrelated metadata does not mark dependents Needs review.')}>Save note</button>}
          {editable && <button type="button" style={control} disabled={busy} onClick={() => void command('stash', `${base}/${encodeURIComponent(edge.id)}`, { action: 'stash', expectedVersion: edge.version, note: note.trim(), reviewerId }, 'Draft kept. Cancel leaves the saved dependency unchanged.')}>Keep draft</button>}
          {edge.access === 'review' && <button type="button" style={control} disabled={busy} onClick={() => void command('acknowledge', `${base}/${encodeURIComponent(edge.id)}`, { action: 'acknowledge', expectedVersion: edge.version, sourceRevision: edge.liveSourceRevision, dependentRevision: edge.liveDependentRevision }, 'Review acknowledged for these revisions.')}>Acknowledge review</button>}
          {editable && <button type="button" style={control} disabled={busy} onClick={() => void command('reassign', `${base}/${encodeURIComponent(edge.id)}`, { action: 'reassign', expectedVersion: edge.version, reviewerId }, 'Reviewer reassigned. This does not grant access.')}>Reassign reviewer</button>}
          <button type="button" style={control} disabled={busy} onClick={() => void requestJson<Impact>(`${base}?view=impact&kind=${encodeURIComponent(edge.kind)}&sourceId=${encodeURIComponent(edge.sourceId)}`).then(value => { if (alive.current) setImpact(value); }).catch(failed)}>Show impact</button>
          <button type="button" style={control} disabled={busy} onClick={() => void requestJson<Impact>(`${base}?view=preview&kind=${encodeURIComponent(edge.kind)}&sourceId=${encodeURIComponent(edge.sourceId)}`).then(value => { if (alive.current) setImpact(value); }).catch(failed)}>Preview impact</button>
          <button type="button" style={control} disabled={busy} onClick={() => void command('download', base, { action: 'download', expectedVersion: edge.sourceVersion, kind: edge.kind, sourceId: edge.sourceId }, 'Impact report downloaded.')}>Download impact</button>
          <button type="button" style={control} disabled={busy} onClick={() => void requestJson<{ events: { action: string; actorName: string; atIst: string; source: string }[] }>(`${base}/${encodeURIComponent(edge.id)}?view=history`).then(value => { if (alive.current) setHistory(value.events.map(event => `${event.action} · ${event.actorName} · ${event.atIst} · ${applicationDisplayName(event.source)}`).join('\n')); }).catch(failed)}>Dependency history</button>
          {editable && confirm !== 'retire' && <button type="button" style={control} disabled={busy} onClick={() => setConfirm('retire')}>Retire source</button>}
          {editable && confirm === 'retire' && <button type="button" style={control} disabled={busy} onClick={() => void command('retire', base, { action: 'retire', kind: edge.kind, sourceId: edge.sourceId, expectedVersion: edge.sourceVersion }, 'Source retired. Dependent pages were not rewritten.')}>Confirm retire</button>}
          {editable && <label>Merge target
            <input aria-label="Merge target" value={mergeTarget} disabled={busy} onChange={event => setMergeTarget(event.target.value)} />
          </label>}
          {editable && confirm !== 'merge' && <button type="button" style={control} disabled={busy} onClick={() => setConfirm('merge')}>Merge source</button>}
          {editable && confirm === 'merge' && <button type="button" style={control} disabled={busy} onClick={() => void command('merge', base, { action: 'merge', kind: edge.kind, sourceId: edge.sourceId, mergedIntoId: mergeTarget.trim(), expectedVersion: edge.sourceVersion }, 'Source merged. Dependent pages were not rewritten.')}>Confirm merge</button>}
          {editable && <button type="button" style={control} disabled={busy} onClick={() => void command('material', base, { action: 'note-material', kind: edge.kind, sourceId: edge.sourceId, sourceRevision: Number(sourceRevision), expectedVersion: edge.sourceVersion }, 'Source change reviewed against the explicit metadata rule.')}>Note source change</button>}
        </div>
      </section>}
      {impact && <pre aria-label="Impact preview">{impact.edges.map(item => `${item.sourceTitle} → ${item.dependentTitle} · ${item.reviewState} · ${item.reviewReason} · ${item.sourceState}${item.cycle ? ' · cycle' : ''}`).join('\n') || 'No permitted dependents.'}{impact.truncated ? '\nResults truncated.' : ''}</pre>}
      {history && <pre aria-label="Dependency history">{history}</pre>}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert">{error}</p>}
      <button type="button" style={control} disabled={busy} onClick={onClose}>Cancel</button>
    </div>
  </Dialog>;
}
