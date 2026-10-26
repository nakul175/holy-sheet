"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { Block, BlockType, Page, SearchResult, Space } from "../lib/types";

const emptyBlock = (pageId: string, position: number): Block => ({ id: crypto.randomUUID(), pageId, parentBlockId: null, type: "paragraph", text: "", position });
const labels: Record<BlockType, string> = { paragraph: "Text", heading: "Heading", bullet: "Bulleted list", number: "Numbered list", checklist: "Checklist" };

export default function HolySheetApp({ initialPageId }: { initialPageId: string }) {
  const router = useRouter();
  const [page, setPage] = useState<Page | null>(null);
  const [pages, setPages] = useState<Page[]>([]);
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [status, setStatus] = useState<"loading" | "saved" | "saving" | "unsaved" | "error" | "conflict">("loading");
  const [createOpen, setCreateOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const loadNavigation = useCallback(async () => {
    const [pageList, spaceList] = await Promise.all([fetch("/api/pages").then((r) => r.json()), fetch("/api/spaces").then((r) => r.json())]);
    setPages(pageList.pages); setSpaces(spaceList.spaces);
  }, []);

  useEffect(() => {
    Promise.all([fetch(`/api/pages/${initialPageId}`).then((r) => r.json()), loadNavigation()])
      .then(([data]) => { setPage({ ...data.page, blocks: data.page.blocks.length ? data.page.blocks : [emptyBlock(data.page.id, 0)] }); setStatus("saved"); })
      .catch(() => setStatus("error"));
  }, [initialPageId, loadNavigation]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") { event.preventDefault(); setSearchOpen(true); }
    };
    window.addEventListener("keydown", handler); return () => window.removeEventListener("keydown", handler);
  }, []);

  const save = useCallback(async (next: Page) => {
    setStatus("saving");
    try {
      const response = await fetch(`/api/pages/${next.id}`, { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ expectedVersion: next.version, title: next.title, blocks: next.blocks }) });
      const data = await response.json();
      if (response.status === 409) { setStatus("conflict"); return; }
      if (!response.ok) throw new Error(data.error);
      setPage((current) => {
        if (!current || current.id !== data.page.id) return current;
        return { ...current, version: data.page.version, updatedAt: data.page.updatedAt };
      });
      setStatus("saved"); await loadNavigation();
    } catch { setStatus("error"); }
  }, [loadNavigation]);

  function change(mutator: (current: Page) => Page) {
    setPage((current) => {
      if (!current) return current;
      const next = mutator(current); setStatus("unsaved");
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => save(next), 700);
      return next;
    });
  }

  if (!page) return <main className="loading">{status === "error" ? "Page could not be loaded." : "Opening Holy Sheet…"}</main>;
  return <div className="shell">
    <aside className="sidebar">
      <div className="brand"><span>✦</span> Holy Sheet</div>
      <button className="search-button" onClick={() => setSearchOpen(true)}>⌕ Search <kbd>⌘ K</kbd></button>
      <nav aria-label="Pages">
        {spaces.map((space) => <section key={space.id}><h2>{space.name}</h2>
          {pages.filter((item) => item.spaceId === space.id && !item.parentPageId).map((item) => <PageLink key={item.id} item={item} active={item.id === page.id} pages={pages} onOpen={(id) => router.push(`/pages/${id}`)} />)}
        </section>)}
      </nav>
      <button className="new-page" onClick={() => setCreateOpen(true)}>＋ New page</button>
    </aside>
    <main className="document">
      <header className="doc-header"><div className="breadcrumbs">{page.workspaceName} / {page.spaceName}{page.parentTitle ? ` / ${page.parentTitle}` : ""}</div><SaveState status={status} onRetry={() => save(page)} /></header>
      <article>
        <textarea rows={1} className="title" aria-label="Page title" value={page.title} onChange={(e) => change((current) => ({ ...current, title: e.target.value }))} placeholder="Untitled" />
        <div className="blocks">{page.blocks.map((block, index) => <BlockEditor key={block.id} block={block} index={index} onChange={(patch) => change((current) => ({ ...current, blocks: current.blocks.map((item) => item.id === block.id ? { ...item, ...patch } : item) }))} onEnter={() => change((current) => ({ ...current, blocks: [...current.blocks.slice(0, index + 1), emptyBlock(current.id, index + 1), ...current.blocks.slice(index + 1)].map((item, position) => ({ ...item, position })) }))} />)}</div>
        <button className="add-block" onClick={() => change((current) => ({ ...current, blocks: [...current.blocks, emptyBlock(current.id, current.blocks.length)] }))}>＋ Add block</button>
      </article>
    </main>
    {createOpen && <CreatePage spaces={spaces} pages={pages} parent={page} onClose={() => setCreateOpen(false)} onCreated={async (created) => { setCreateOpen(false); await loadNavigation(); router.push(`/pages/${created.id}`); }} />}
    {searchOpen && <SearchDialog spaces={spaces} onClose={() => setSearchOpen(false)} onOpen={(id) => { setSearchOpen(false); router.push(`/pages/${id}`); }} />}
  </div>;
}

function PageLink({ item, active, pages, onOpen }: { item: Page; active: boolean; pages: Page[]; onOpen: (id: string) => void }) {
  const children = pages.filter((page) => page.parentPageId === item.id);
  return <div className="page-tree"><button className={active ? "active" : ""} onClick={() => onOpen(item.id)}>▧ {item.title}</button>{children.map((child) => <PageLink key={child.id} item={child} active={false} pages={pages} onOpen={onOpen} />)}</div>;
}

function SaveState({ status, onRetry }: { status: string; onRetry: () => void }) {
  if (status === "error") return <button className="save error" onClick={onRetry}>Save failed · Retry</button>;
  if (status === "conflict") return <span className="save conflict">Changed elsewhere · refresh to reconcile</span>;
  return <span className={`save ${status}`}>{status === "saved" ? "✓ Saved" : status === "saving" ? "Saving…" : "Unsaved changes"}</span>;
}

function BlockEditor({ block, index, onChange, onEnter }: { block: Block; index: number; onChange: (patch: Partial<Block>) => void; onEnter: () => void }) {
  return <div className={`block block-${block.type}`}>
    <select aria-label={`Block ${index + 1} type`} value={block.type} onChange={(e) => onChange({ type: e.target.value as BlockType })}>{Object.entries(labels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select>
    {block.type === "checklist" && <input type="checkbox" checked={block.checked ?? false} onChange={(e) => onChange({ checked: e.target.checked })} />}
    <textarea rows={block.type === "heading" ? 1 : 2} value={block.text} onChange={(e) => onChange({ text: e.target.value })} onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); onEnter(); } }} placeholder={block.type === "heading" ? "Heading" : "Type something…"} />
  </div>;
}

function CreatePage({ spaces, pages, parent, onClose, onCreated }: { spaces: Space[]; pages: Page[]; parent: Page; onClose: () => void; onCreated: (page: Page) => void }) {
  const [title, setTitle] = useState(""); const [spaceId, setSpaceId] = useState(parent.spaceId); const [newSpace, setNewSpace] = useState(""); const [asChild, setAsChild] = useState(false); const [busy, setBusy] = useState(false);
  async function submit(event: React.FormEvent) { event.preventDefault(); setBusy(true); let destination = spaceId;
    if (newSpace.trim()) { const created = await fetch("/api/spaces", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: newSpace }) }).then((r) => r.json()); destination = created.space.id; }
    const result = await fetch("/api/pages", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ title, spaceId: destination, parentPageId: asChild ? parent.id : null }) }).then((r) => r.json()); onCreated(result.page);
  }
  return <div className="overlay" onMouseDown={onClose}><form className="modal create-modal" onSubmit={submit} onMouseDown={(e) => e.stopPropagation()}><h2>Create a page</h2><label>Title<input autoFocus value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Untitled" /></label><label>Space<select value={spaceId} onChange={(e) => setSpaceId(e.target.value)}>{spaces.map((space) => <option key={space.id} value={space.id}>{space.name}</option>)}</select></label><div className="or">or create a new space</div><label>New space<input value={newSpace} onChange={(e) => setNewSpace(e.target.value)} placeholder="e.g. Operations" /></label><label className="check"><input type="checkbox" checked={asChild} onChange={(e) => setAsChild(e.target.checked)} /> Create under “{parent.title}”</label><div className="actions"><button type="button" onClick={onClose}>Cancel</button><button className="primary" disabled={busy}>{busy ? "Creating…" : "Create page"}</button></div><small>{pages.length} page{pages.length === 1 ? "" : "s"} in this workspace</small></form></div>;
}

function SearchDialog({ spaces, onClose, onOpen }: { spaces: Space[]; onClose: () => void; onOpen: (id: string) => void }) {
  const [query, setQuery] = useState(""); const [spaceId, setSpaceId] = useState(""); const [results, setResults] = useState<SearchResult[]>([]); const [selected, setSelected] = useState(0);
  useEffect(() => { if (query.trim().length < 2) { setResults([]); return; } const timer = setTimeout(() => fetch(`/api/search?q=${encodeURIComponent(query)}${spaceId ? `&spaceId=${spaceId}` : ""}`).then((r) => r.json()).then((data) => { setResults(data.results); setSelected(0); }), 160); return () => clearTimeout(timer); }, [query, spaceId]);
  return <div className="overlay search-overlay" onMouseDown={onClose}><div className="modal search-modal" role="dialog" aria-modal="true" aria-label="Search pages" onMouseDown={(e) => e.stopPropagation()}><div className="search-row"><span>⌕</span><input autoFocus value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === "Escape") onClose(); if (e.key === "ArrowDown") { e.preventDefault(); setSelected((value) => Math.min(results.length - 1, value + 1)); } if (e.key === "ArrowUp") { e.preventDefault(); setSelected((value) => Math.max(0, value - 1)); } if (e.key === "Enter" && results[selected]) onOpen(results[selected].id); }} placeholder="Search titles and content…" /><select aria-label="Filter by space" value={spaceId} onChange={(e) => setSpaceId(e.target.value)}><option value="">All spaces</option>{spaces.map((space) => <option key={space.id} value={space.id}>{space.name}</option>)}</select></div><div className="results">{query.length < 2 ? <p>Type at least 2 characters</p> : results.length ? results.map((result, index) => <button key={result.id} className={index === selected ? "selected" : ""} onMouseEnter={() => setSelected(index)} onClick={() => onOpen(result.id)}><strong>{result.title}</strong><span>{result.path.join(" / ")}</span><p>{result.preview || "Title match"}</p></button>) : <p>No accessible pages found</p>}</div><footer>↑↓ navigate · ↵ open · esc close</footer></div></div>;
}
