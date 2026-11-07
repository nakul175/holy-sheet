'use client';
import { useEffect, useRef, useState } from 'react';
import type { ComplianceFormat, ComplianceJobView, ComplianceScope } from '../lib/compliance-pack';
import { Dialog } from './editor/rich-editor';
import { ApiError, requestJson } from './editor/use-document-session';

type Policy = { spaceId: string; attachments: boolean; version: number; manage: boolean; replayed?: boolean };
type Start = { operationId: string; scope: ComplianceScope; format: ComplianceFormat; targetId: string; includeDraft: boolean; includeTrash: boolean; allAttachmentVersions: boolean };
type History = { jobs: ComplianceJobView[] };

export default function ComplianceExportDialog({ workspaceId, spaceId, pageId, onClose }: { workspaceId: string; spaceId: string; pageId: string; onClose: () => void }) {
  const [scope, setScope] = useState<ComplianceScope>('space');
  const [format, setFormat] = useState<ComplianceFormat>('compliance-pack');
  const [includeDraft, setIncludeDraft] = useState(false);
  const [includeTrash, setIncludeTrash] = useState(false);
  const [allVersions, setAllVersions] = useState(false);
  const [policy, setPolicy] = useState<Policy | null>(null);
  const [attachments, setAttachments] = useState(true);
  const [history, setHistory] = useState<ComplianceJobView[]>([]);
  const [job, setJob] = useState<ComplianceJobView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const alive = useRef(true);
  const pending = useRef<Start | null>(null);
  const policyPending = useRef<{ operationId: string; spaceId: string; attachments: boolean; expectedVersion: number } | null>(null);

  useEffect(() => {
    alive.current = true;
    const logout = () => { alive.current = false; onClose(); };
    window.addEventListener('holy-sheet:logout', logout);
    return () => { alive.current = false; window.removeEventListener('holy-sheet:logout', logout); };
  }, [onClose]);

  useEffect(() => {
    let ignore = false;
    void (async () => {
      try {
        const [current, past] = await Promise.all([
          requestJson<Policy>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/compliance-exports/policy?spaceId=${encodeURIComponent(spaceId)}`),
          requestJson<History>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/compliance-exports`),
        ]);
        if (ignore || !alive.current) return;
        setPolicy(current);
        setAttachments(current.attachments);
        setHistory(past.jobs);
      } catch (reason) {
        if (!ignore && alive.current) setError(reason instanceof Error ? reason.message : 'Export unavailable');
      }
    })();
    return () => { ignore = true; };
  }, [workspaceId, spaceId]);

  function failed(reason: unknown) {
    setError(reason instanceof Error ? reason.message : 'Export unavailable');
    if (reason instanceof ApiError && reason.status < 500) pending.current = null;
  }

  async function start() {
    if (busy) return;
    const body = pending.current ?? { operationId: crypto.randomUUID(), scope, format, targetId: scope === 'space' ? spaceId : pageId, includeDraft, includeTrash, allAttachmentVersions: allVersions };
    pending.current = body;
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const result = await requestJson<ComplianceJobView>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/compliance-exports`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!alive.current) return;
      setJob(result);
      pending.current = null;
      setNotice(result.state === 'ready' ? 'Pack ready. The completion email does not include pack contents.' : 'Export queued.');
    } catch (reason) {
      if (alive.current) failed(reason);
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  async function savePolicy() {
    if (!policy?.manage || busy) return;
    const body = policyPending.current ?? { operationId: crypto.randomUUID(), spaceId, attachments, expectedVersion: policy.version };
    policyPending.current = body;
    setBusy(true);
    setError('');
    try {
      const next = await requestJson<Policy>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/compliance-exports/policy`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      if (!alive.current) return;
      setPolicy(next);
      setAttachments(next.attachments);
      policyPending.current = null;
      setNotice(next.attachments ? 'Attachments can be included for this space.' : 'Attachments are excluded for this space. The manifest records that exclusion.');
    } catch (reason) {
      if (alive.current) failed(reason);
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  async function download() {
    if (!job?.downloadToken || busy) return;
    setBusy(true);
    setError('');
    try {
      const reply = await fetch(`/api/v1/compliance-exports/${job.id}/download`, { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: job.downloadToken }) });
      if (!reply.ok) {
        const data = await reply.json();
        throw new ApiError(data.error ?? 'Export unavailable', reply.status, data.code ?? 'not_found');
      }
      const blob = await reply.blob();
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'pages-by-aplyd-compliance-pack.zip';
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      if (alive.current) setNotice('Download started. The link stays bound to this sign-in for 24 hours.');
    } catch (reason) {
      if (alive.current) failed(reason);
    } finally {
      if (alive.current) setBusy(false);
    }
  }

  const locked = busy || !!job;
  return <Dialog title="Export and compliance pack" onClose={() => { if (!busy) onClose(); }}>
    <div className="export-dialog">
      <p>Export a page, a page tree, or this space. A compliance pack is a signed ZIP. Unavailable items are left out. The completion email does not include pack contents.</p>
      <label>Scope<select value={scope} disabled={locked} onChange={event => setScope(event.target.value as ComplianceScope)}><option value="page">This page</option><option value="tree">This page and its subpages</option><option value="space">This space</option></select></label>
      <label>Format<select value={format} disabled={locked} onChange={event => setFormat(event.target.value as ComplianceFormat)}><option value="compliance-pack">Compliance pack</option><option value="pdf">PDF</option><option value="html">HTML</option><option value="markdown">Markdown</option></select></label>
      <label className="check"><input type="checkbox" checked={includeDraft} disabled={locked} onChange={event => setIncludeDraft(event.target.checked)} />Include the current draft where you can edit</label>
      <label className="check"><input type="checkbox" checked={allVersions} disabled={locked} onChange={event => setAllVersions(event.target.checked)} />Include every attachment version</label>
      <label className="check"><input type="checkbox" checked={includeTrash} disabled={locked} onChange={event => setIncludeTrash(event.target.checked)} />Include trash</label>
      <p>Trashed pages stay out unless Include trash is selected by someone who can restore them.</p>
      {policy && <section aria-label="Attachment export policy"><p>Attachment policy for this space: <strong>{policy.attachments ? 'Attachments may be included' : 'Attachments are excluded'}</strong>.</p>{policy.manage ? <><label className="check"><input type="checkbox" checked={attachments} disabled={busy} onChange={event => setAttachments(event.target.checked)} />Allow attachments in compliance packs for this space</label><button disabled={busy || attachments === policy.attachments} onClick={() => void savePolicy()}>Save attachment policy</button></> : <p>Only a workspace administrator can change export policy.</p>}</section>}
      {!job && <button className="primary" disabled={busy} onClick={() => void start()}>{pending.current ? 'Retry the same export' : 'Start export'}</button>}
      {job && <section aria-label="Export progress"><p role="status">Progress {job.progress}% · about {job.etaSeconds} seconds remaining · {job.state}</p>{job.expiresAt && <p>Download available until {job.atIst}.</p>}{job.notes.map(note => <p key={note}>{note}</p>)}{job.downloadToken && <button className="primary" disabled={busy} onClick={() => void download()}>Download pack</button>}</section>}
      {history.length > 0 && <section aria-label="Export history"><h3>Recent exports</h3><ul>{history.map(item => <li key={item.id}>{item.scope} · {item.format} · {item.state} · {item.progress}%</li>)}</ul></section>}
      {busy && <p role="status">Working on the export…</p>}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert" className="form-error">{error}</p>}
    </div>
  </Dialog>;
}
