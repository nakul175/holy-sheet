'use client';
import { useEffect, useRef, useState } from 'react';
import { Dialog } from './editor/rich-editor';
import { ApiError, requestJson } from './editor/use-document-session';

type Mode = 'live' | 'pinned';
type Member = { pageId: string; title: string; mode: Mode; modeLabel: string; publishedVersionNo: number | null; availability: string };
type Bundle = { id: string; name: string; description: string; ownerId: string; version: number; access?: 'manage' | 'edit' | 'view'; publicationId: string | null; publicationNo: number | null; members: Member[]; recoverableDraft?: { name: string; description: string; ownerId: string; members: Member[] } | null };
type List = { manage: boolean; bundles: { id: string; name: string; description: string; ownerId: string; version: number }[]; colleagues?: { id: string; name: string }[]; currentPage?: { id: string; title: string; publishedVersions: number[] } };
type Preview = { immutable: boolean; publicationNo: number | null; items: { title: string; modeLabel: string; exportable: boolean; reason: string; unavailableAssets: number; retention: string }[] };

const control = { minHeight: 44, minWidth: 44 };

export default function DocumentBundleDialog({ workspaceId, pageId, onClose }: { workspaceId: string; pageId: string; onClose: () => void }) {
  const [list, setList] = useState<List>({ manage: false, bundles: [] });
  const [bundle, setBundle] = useState<Bundle | null>(null);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [ownerId, setOwnerId] = useState('');
  const [mode, setMode] = useState<Mode>('live');
  const [pinnedVersion, setPinnedVersion] = useState('');
  const [members, setMembers] = useState<Member[]>([]);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [history, setHistory] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirm, setConfirm] = useState<'publish' | 'archive' | 'share' | null>(null);
  const [shareId, setShareId] = useState('');
  const [shareRole, setShareRole] = useState<'viewer' | 'editor'>('viewer');
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
    const value = await requestJson<List>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/document-bundles?pageId=${encodeURIComponent(pageId)}`);
    if (!alive.current) return value;
    setList(value);
    setOwnerId(current => current || value.colleagues?.find(person => person.id)?.id || '');
    return value;
  }

  async function openBundle(id: string) {
    const value = await requestJson<Bundle>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/document-bundles/${encodeURIComponent(id)}`);
    if (!alive.current) return;
    const draft = value.recoverableDraft;
    setBundle(value);
    setName(draft?.name ?? value.name);
    setDescription(draft?.description ?? value.description);
    setOwnerId(draft?.ownerId ?? value.ownerId);
    setMembers(draft?.members ?? value.members);
    setPreview(null);
    setConfirm(null);
  }

  useEffect(() => {
    let ignore = false;
    void loadList().catch(reason => { if (!ignore && alive.current) setError(reason instanceof Error ? reason.message : 'Document bundle unavailable'); });
    return () => { ignore = true; };
  }, [workspaceId, pageId]);

  function failed(reason: unknown) {
    setError(reason instanceof Error ? reason.message : 'Document bundle unavailable');
    if (!(reason instanceof ApiError) || reason.status >= 500) return;
    ops.current = {};
  }

  function payloadMembers() {
    return members.map(member => ({ pageId: member.pageId, mode: member.mode, pinnedVersion: member.mode === 'pinned' ? member.publishedVersionNo : null }));
  }

  async function create() {
    if (busy || !list.manage) return;
    const trimmed = name.trim();
    if (trimmed.length < 1 || trimmed.length > 100) { setError('Enter a bundle name of 1–100 characters.'); return; }
    if (!ownerId) { setError('Choose an owner.'); return; }
    const include = mode === 'pinned' && !pinnedVersion ? null : list.currentPage;
    if (mode === 'pinned' && !pinnedVersion) { setError('Choose a published revision to pin.'); return; }
    const operationId = operation('create');
    setBusy(true);
    setError('');
    try {
      const created = await requestJson<Bundle>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/document-bundles`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create', operationId, name: trimmed, description: description.trim(), ownerId,
          members: include ? [{ pageId: include.id, mode, pinnedVersion: mode === 'pinned' ? Number(pinnedVersion) : null }] : [],
        }),
      });
      if (!alive.current) return;
      clearOperation('create');
      await loadList();
      setBundle(created);
      setMembers(created.members);
      setNotice('Bundle saved. It stores document references, not copies. Sharing it does not grant access to those documents.');
    } catch (reason) { if (alive.current) failed(reason); } finally { if (alive.current) setBusy(false); }
  }

  async function command(key: string, body: Record<string, unknown>, done: string) {
    if (!bundle || busy) return;
    const operationId = operation(key);
    setBusy(true);
    setError('');
    try {
      const result = await requestJson<Bundle & { body?: string; filename?: string; contentType?: string; replayed?: boolean }>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/document-bundles/${encodeURIComponent(bundle.id)}`, {
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
      if (body.action === 'archive') {
        setBundle(null);
        setMembers([]);
        await loadList();
      } else await openBundle(bundle.id);
      setConfirm(null);
      setNotice(done);
    } catch (reason) { if (alive.current) failed(reason); } finally { if (alive.current) setBusy(false); }
  }

  const editable = Boolean(bundle && bundle.access !== 'view');

  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (!editable || target < 0 || target >= members.length) return;
    const next = members.slice();
    const [item] = next.splice(index, 1);
    next.splice(target, 0, item);
    setMembers(next);
  }

  function addCurrent() {
    if (!editable || !list.currentPage || members.some(member => member.pageId === list.currentPage?.id)) return;
    if (mode === 'pinned' && !pinnedVersion) { setError('Choose a published revision to pin.'); return; }
    setMembers([...members, {
      pageId: list.currentPage.id,
      title: list.currentPage.title,
      mode,
      modeLabel: mode === 'live' ? 'Live — latest published' : `Pinned to published revision ${pinnedVersion}`,
      publishedVersionNo: mode === 'pinned' ? Number(pinnedVersion) : list.currentPage.publishedVersions.at(-1) ?? null,
      availability: 'ready',
    }]);
    setError('');
  }

  return <Dialog title="Document bundles" onClose={() => { if (!busy) onClose(); }}>
    <div className="export-dialog document-bundle-dialog">
      <p>A bundle is an ordered set of document references for this workspace. It does not copy document text. Sharing or listing a bundle does not grant access to the documents.</p>
      {list.manage && <section aria-label="Create a document bundle">
        <label>Bundle name
          <input aria-label="Bundle name" maxLength={100} value={name} disabled={busy} onChange={event => setName(event.target.value)} />
        </label>
        <label>Description
          <textarea aria-label="Bundle description" maxLength={2000} value={description} disabled={busy} onChange={event => setDescription(event.target.value)} />
        </label>
        <label>Owner
          <select aria-label="Bundle owner" value={ownerId} disabled={busy} onChange={event => setOwnerId(event.target.value)}>
            {(list.colleagues ?? []).map(person => <option key={person.id} value={person.id}>{person.name}</option>)}
          </select>
        </label>
        <fieldset>
          <legend>Reference mode for this page</legend>
          <label style={{ display: 'flex', gap: 12, alignItems: 'center', minHeight: 44 }}><input type="radio" name="new-member-mode" checked={mode === 'live'} onChange={() => setMode('live')} />Live — latest published</label>
          <label style={{ display: 'flex', gap: 12, alignItems: 'center', minHeight: 44 }}><input type="radio" name="new-member-mode" checked={mode === 'pinned'} onChange={() => setMode('pinned')} />Pinned to a published revision</label>
          {mode === 'pinned' && <label>Published revision
            <select aria-label="Pinned published revision" value={pinnedVersion} onChange={event => setPinnedVersion(event.target.value)}>
              <option value="">Choose a revision</option>
              {(list.currentPage?.publishedVersions ?? []).map(version => <option key={version} value={version}>Published revision {version}</option>)}
            </select>
          </label>}
        </fieldset>
        <button type="button" className="primary" disabled={busy} style={control} onClick={() => void create()}>{ops.current.create ? 'Retry the same bundle' : 'Create bundle'}</button>
      </section>}
      {list.bundles.length > 0 && <label>Saved bundles
        <select aria-label="Document bundles" value={bundle?.id ?? ''} disabled={busy} onChange={event => { if (event.target.value) void openBundle(event.target.value).catch(failed); }}>
          <option value="">Choose a bundle</option>
          {list.bundles.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
        </select>
      </label>}
      {bundle && <section aria-label="Bundle membership">
        <p>{bundle.publicationNo ? `Published package snapshot ${bundle.publicationNo} is immutable. The draft below can still change.` : 'This bundle is a draft. Publishing freezes a package snapshot.'}</p>
        {bundle.recoverableDraft && <p role="status">A recoverable draft is saved on the bundle. It is shown here until you save or discard it. Cancel closes this dialog without another save.</p>}
        <ol>
          {members.map((member, index) => <li key={member.pageId}>
            <span>{member.title}</span>
            <span> {member.modeLabel}</span>
            {member.availability !== 'ready' && <span> · Unavailable ({member.availability})</span>}
            {editable && <span style={{ display: 'inline-flex', flexWrap: 'wrap', gap: 8 }}>
              <button type="button" style={control} disabled={busy || index === 0} onClick={() => move(index, -1)}>Move up</button>
              <button type="button" style={control} disabled={busy || index === members.length - 1} onClick={() => move(index, 1)}>Move down</button>
              <button type="button" style={control} disabled={busy} onClick={() => setMembers(members.filter(item => item.pageId !== member.pageId))}>Remove</button>
            </span>}
          </li>)}
        </ol>
        {editable && <div className="actions" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <button type="button" style={control} disabled={busy} onClick={addCurrent}>Add this page</button>
          <button type="button" style={control} disabled={busy} onClick={() => void command('save', { action: 'save', expectedVersion: bundle.version, name, description, ownerId, members: payloadMembers() }, 'Bundle configuration saved. Document contents were not copied.')}>Save bundle</button>
          <button type="button" style={control} disabled={busy} onClick={() => void command('stash', { action: 'stash', expectedVersion: bundle.version, name, description, ownerId, members: payloadMembers() }, 'Recoverable draft saved. The published snapshot was not changed.')}>Save recoverable draft</button>
          <button type="button" style={control} disabled={busy} onClick={() => { if (confirm !== 'publish') { setConfirm('publish'); setNotice('Confirm publish. This freezes the current references into an immutable package.'); return; } void command('publish', { action: 'publish', expectedVersion: bundle.version }, 'Published package snapshot saved. Later edits do not change it.'); }}>Publish package</button>
          <button type="button" style={control} disabled={busy} onClick={() => { if (confirm !== 'archive') { setConfirm('archive'); setNotice('Confirm archive. Documents in the bundle stay where they are.'); return; } void command('archive', { action: 'archive', expectedVersion: bundle.version }, 'Bundle archived. No document was deleted.'); }}>Archive bundle</button>
        </div>}
        <div className="actions" style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
          <button type="button" style={control} disabled={busy} onClick={() => void requestJson<Preview>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/document-bundles/${encodeURIComponent(bundle.id)}?view=preview${bundle.publicationId ? `&publicationId=${encodeURIComponent(bundle.publicationId)}` : ''}`).then(value => { if (alive.current) { setPreview(value); setNotice(value.immutable ? 'Previewing the immutable published package.' : 'Previewing the current draft.'); } }).catch(failed)}>Preview package</button>
          <button type="button" style={control} disabled={busy} onClick={() => void command('download', { action: 'download', expectedVersion: bundle.publicationNo ?? bundle.version, publicationId: bundle.publicationId }, 'Package download checked export rights, assets, and retention.')}>Download package</button>
          <button type="button" style={control} disabled={busy} onClick={() => void requestJson<{ events: { action: string; actorName: string; atIst: string; source: string }[] }>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/document-bundles/${encodeURIComponent(bundle.id)}?view=history`).then(value => { if (!alive.current) return; setHistory(value.events.map(event => `${event.action} · ${event.actorName} · ${event.atIst} · ${event.source}`).join('\n')); }).catch(failed)}>Bundle history</button>
        </div>
        {editable && <fieldset>
          <legend>Share this bundle</legend>
          <p>The recipient can see the bundle name and only the documents they can already read.</p>
          <label>Workspace member
            <select aria-label="Bundle recipient" value={shareId} onChange={event => setShareId(event.target.value)}>
              <option value="">Choose a member</option>
              {(list.colleagues ?? []).map(person => <option key={person.id} value={person.id}>{person.name}</option>)}
            </select>
          </label>
          <label>Bundle role
            <select aria-label="Bundle role" value={shareRole} onChange={event => setShareRole(event.target.value === 'editor' ? 'editor' : 'viewer')}>
              <option value="viewer">Can view the bundle</option>
              <option value="editor">Can edit the bundle</option>
            </select>
          </label>
          <button type="button" style={control} disabled={busy || !shareId} onClick={() => { if (confirm !== 'share') { setConfirm('share'); setNotice('Confirm share. This does not grant access to the documents.'); return; } void command('share', { action: 'share', expectedVersion: bundle.version, subjectId: shareId, role: shareRole }, 'Bundle shared. Document access was not changed.'); }}>Share bundle</button>
        </fieldset>}
      </section>}
      {preview && <section aria-label="Package preview">
        <p>{preview.immutable ? `Immutable snapshot ${preview.publicationNo}.` : 'Draft preview.'} Hidden documents are omitted. Their titles and counts are not shown.</p>
        <ul>{preview.items.map(item => <li key={item.title}>{item.title} · {item.modeLabel} · {item.exportable ? 'Exportable' : item.reason} · assets {item.unavailableAssets} · retention {item.retention}</li>)}</ul>
      </section>}
      {history && <pre aria-label="Bundle history">{history}</pre>}
      <button type="button" style={control} disabled={busy} onClick={onClose}>Cancel</button>
      {busy && <p role="status">Saving the bundle…</p>}
      {notice && <p role="status">{notice}</p>}
      {error && <p role="alert" className="form-error">{error}</p>}
    </div>
  </Dialog>;
}
