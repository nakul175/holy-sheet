'use client';
import { useEffect, useRef, useState } from 'react';
import { embedContext } from '../lib/embed-context';
import styles from './sho-document-picker.module.css';
import { SignInLink } from './session-boundary';
const defaultParentOrigin = 'https://sheethappensofficer.aplyd.org';
const approvedHosts = new Set([defaultParentOrigin,'https://sho-qa.aplyd.org']);
type Space = {
    id: string;
    name: string;
    workspaceId: string;
    workspaceName?: string;
};
type Page = {
    id: string;
    title: string;
    spaceId: string;
    workspaceId: string;
};
export default function ShoDocumentPicker() {
    const [spaces, setSpaces] = useState<Space[]>([]), [pages, setPages] = useState<Page[]>([]), [space, setSpace] = useState(''), [workspace, setWorkspace] = useState('');
    const [title, setTitle] = useState(''), [name, setName] = useState(''), [query, setQuery] = useState(''), [error, setError] = useState(''), [ready, setReady] = useState(false), [busy, setBusy] = useState(false), [retry, setRetry] = useState(0), [pending, setPending] = useState(false), [setDefault, setSetDefault] = useState(false), [mode, setMode] = useState('create');
    const parentOrigin = useRef(defaultParentOrigin), identity = useRef(''), channel = useRef(''), intent = useRef<{
        title: string;
        spaceId: string;
        operationId: string;
    } | null>(null), active = useRef(true), epoch = useRef(0);
    async function call(body?: unknown) {
        const response = await fetch('/api/v1/integrations/sho/picker', { method: body ? 'POST' : 'GET', cache: 'no-store', headers: { 'Content-Type': 'application/json', 'X-HS-Actor': identity.current }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10000) });
        const data = await response.json();
        if (!response.ok || data.subject !== identity.current) {
            if (response.status === 401 || response.status === 403) {
                setReady(false);
                setSpaces([]);
                setPages([]);
            }
            throw Error(data.error || 'Holy Sheet is unavailable. Retry when connected.');
        }
        return data;
    }
    useEffect(() => {
        active.current = true;
        const attempt = ++epoch.current;
        const ctx = embedContext(location.hash, window.parent !== window), params = new URLSearchParams(location.hash.slice(1));
        const channels = params.getAll('hs-channel'),hosts=params.getAll('hs-host');
        if (hosts.length>1||(hosts.length===1&&!approvedHosts.has(hosts[0]))||ctx.kind !== 'restricted' || channels.length !== 1 || !/^[0-9a-f-]{36}$/i.test(channels[0])) {
            setError('Open this picker from SHO.');
            return;
        }
        parentOrigin.current=hosts[0]??defaultParentOrigin;
        identity.current = ctx.userId;
        channel.current = channels[0];
        setBusy(false);
        setMode(params.get('hs-mode') === 'link' ? 'link' : 'create');
        void call().then(data => { if (!active.current || attempt !== epoch.current)
            return; setSpaces(data.spaces); setPages(data.pages); const preferred = params.get('hs-space'); const selected = data.spaces.find((s: Space) => s.id === preferred); setSpace(selected?.id ?? ''); setWorkspace(selected?.workspaceId ?? data.spaces[0]?.workspaceId ?? ''); setReady(true); setError(preferred && !selected ? 'The project’s saved location is unavailable. Choose another space.' : ''); }).catch(e => { if (active.current && attempt === epoch.current)
            setError(e.message); });
        const revoke = () => { epoch.current++; setBusy(false); setReady(false); setSpaces([]); setPages([]); setError('Your session changed. Check your account and retry.'); };
        window.addEventListener('holy-sheet:logout', revoke);
        return () => { active.current = false; epoch.current++; window.removeEventListener('holy-sheet:logout', revoke); };
    }, [retry]);
    async function choose(pageId?: string) {
        if (busy || !ready)
            return;
        const attempt = epoch.current;
        let completed = false;
        setBusy(true);
        setError('');
        if (!pageId && !intent.current) {
            intent.current = { title, spaceId: space, operationId: crypto.randomUUID() };
            setPending(true);
        }
        try {
            const data = await call(pageId ? { action: 'select', pageId } : { action: 'create', ...intent.current });
            if (!active.current || attempt !== epoch.current)
                return;
            completed = true;
            window.parent.postMessage({ type: 'hs-document-selected', channel: channel.current, subject: identity.current, pageId: data.page.id, spaceId: data.page.spaceId, created: !pageId, setDefault }, parentOrigin.current);
            setError('Page is ready. SHO is saving its link. If that fails, retry the link in SHO.');
        }
        catch (e) {
            if (active.current && attempt === epoch.current)
                setError(e instanceof Error ? e.message : 'Unable to select page.');
        }
        finally {
            if (active.current && attempt === epoch.current && !completed)
                setBusy(false);
        }
    }
    const workspaces = Array.from(new Set(spaces.map(s => s.workspaceId)));
    return <main className={`workspace-home ${styles.picker}`}><h1>Holy Sheet documents</h1><p>Pages stay in Holy Sheet and keep their existing permissions.</p>
 {error && <p role="status">{error}</p>}
 {!ready ? <><SignInLink path="/" newWindow/><button onClick={() => setRetry(n => n + 1)}>Retry access check</button></> : <>
 <label>Workspace <select value={workspace} disabled={busy || pending} onChange={e => { setWorkspace(e.target.value); setSpace(''); }}><option value="">Choose workspace</option>{workspaces.map(id => <option key={id} value={id}>{spaces.find(s => s.workspaceId === id)?.workspaceName ?? 'Workspace'}</option>)}</select></label>
 <label>Space <select value={space} disabled={busy || pending} onChange={e => setSpace(e.target.value)}><option value="">Choose space</option>{spaces.filter(s => s.workspaceId === workspace).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}</select></label>
 {mode === 'create' && <><form onSubmit={async (e) => { e.preventDefault(); if (busy)
                return; const attempt = epoch.current; setBusy(true); try {
                const data = await call({ action: 'space', name, workspaceId: workspace });
                if (active.current && attempt === epoch.current) {
                    setSpaces(s => [...s, data.space]);
                    setSpace(data.space.id);
                    setName('');
                }
            }
            catch (e) {
                setError(e instanceof Error ? e.message : 'Could not create space.');
            }
            finally {
                setBusy(false);
            } }}>
 <label>New space name <input value={name} maxLength={80} disabled={busy || pending} onChange={e => setName(e.target.value)}/></label><button disabled={!workspace || !name.trim() || busy || pending}>Create space</button></form>
 <label className={styles.defaultOption}><input type="checkbox" checked={setDefault} disabled={busy || pending} onChange={e => setSetDefault(e.target.checked)}/>Use this space as the project default</label>
 <form onSubmit={e => { e.preventDefault(); void choose(); }}><label>Page title <input value={title} maxLength={240} disabled={busy || pending} onChange={e => setTitle(e.target.value)}/></label><button disabled={!space || busy}>{pending ? 'Retry same creation' : 'Create and link page'}</button></form></>}
 {mode === 'link' && <><label>Find existing page <input value={query} disabled={busy || pending} onChange={e => setQuery(e.target.value)}/></label>
 <ul>{pages.filter(p => (!space || p.spaceId === space) && p.workspaceId === workspace && p.title.toLowerCase().includes(query.toLowerCase())).map(p => <li key={p.id}><button disabled={busy || pending} onClick={() => void choose(p.id)}>{p.title}</button></li>)}</ul></>}
 </>}</main>;
}
