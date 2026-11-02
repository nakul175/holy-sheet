'use client';
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { requestJson, ApiError } from "./editor/use-document-session";
import type { RichNode } from "../lib/document";
import type { SearchResult } from "../lib/types";
import {
  SEARCH_JUMP_UNAVAILABLE,
  SEARCH_LINK_COPIED,
  SEARCH_SHORTCUT_HINT,
  canonicalSearchHref,
  createPageActionLabel,
  permittedSearchActions,
  recordIdFromHit,
  searchActionLabels,
  searchResultShortcut,
  type SearchActionId,
  type SearchCreateAction,
  type SearchHeadingHit,
  type SearchQuickAction,
  type SearchRecentHit,
} from "../lib/search-jump-model";

type Palette = { recents: SearchRecentHit[]; quickActions: SearchQuickAction[]; headings: SearchHeadingHit[]; creates: SearchCreateAction[] };
const emptyPalette: Palette = { recents: [], quickActions: [], headings: [], creates: [] };

export function SearchCommandResults({ workspaceId, pageId, editing, query, results, error, listId, selected, onSelect, onOpen, onOpenTab, onJump, onCreated, onClose, commandRef }: {
  workspaceId: string; pageId?: string; editing: boolean; query: string; results: SearchResult[]; error: string; listId: string; selected: number;
  onSelect: (index: number) => void; onOpen: (result: SearchResult) => void; onOpenTab?: (result: SearchResult) => void; onJump?: (href: string) => void; onCreated?: (href: string) => void; onClose: () => void;
  commandRef: { current: ((action: SearchActionId, result: SearchResult) => void) | null };
}) {
  const [menu, setMenu] = useState<number | null>(null);
  const [headings, setHeadings] = useState<SearchHeadingHit[]>([]);
  const [palette, setPalette] = useState<Palette>(emptyPalette);
  const [removed, setRemoved] = useState<string[]>([]);
  const [toast, setToast] = useState("");
  const [notice, setNotice] = useState("");
  const [peek, setPeek] = useState<{ title: string; href: string } | null>(null);
  const [acting, setActing] = useState(false);
  const intent = useRef<{ key: string; operationId: string } | null>(null);
  const shown = results.filter(result => !removed.includes(result.id));
  const jump = query.includes(">");
  useEffect(() => {
    if (query.trim()) return;
    let live = true;
    void requestJson<Palette>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/search-actions?workspaceId=${encodeURIComponent(workspaceId)}`).then(data => { if (live) setPalette(data); }).catch(() => { if (live) setPalette(emptyPalette); });
    return () => { live = false; };
  }, [query, workspaceId]);
  useEffect(() => {
    if (!jump) { setPalette(current => ({ ...current, headings: [] })); return; }
    let live = true;
    void requestJson<Palette>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/search-actions?workspaceId=${encodeURIComponent(workspaceId)}&q=${encodeURIComponent(query)}`).then(data => { if (live) setPalette(current => ({ ...current, headings: data.headings })); }).catch(() => { if (live) setPalette(current => ({ ...current, headings: [] })); });
    return () => { live = false; };
  }, [jump, query, workspaceId]);
  useEffect(() => {
    if (jump || error || query.trim().length < 2 || shown.length) { setPalette(current => ({ ...current, creates: [] })); return; }
    let live = true;
    void requestJson<Palette>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/search-actions?workspaceId=${encodeURIComponent(workspaceId)}&q=${encodeURIComponent(query.trim())}`).then(data => { if (live) setPalette(current => ({ ...current, creates: data.creates })); }).catch(() => { if (live) setPalette(current => ({ ...current, creates: [] })); });
    return () => { live = false; };
  }, [jump, error, query, shown.length, workspaceId]);
  function operationId(key: string) {
    if (intent.current?.key !== key) intent.current = { key, operationId: crypto.randomUUID() };
    return intent.current.operationId;
  }
  function fail(result: SearchResult | null, error: unknown) {
    if (error instanceof ApiError && error.status === 404) {
      if (result) setRemoved(ids => ids.includes(result.id) ? ids : [...ids, result.id]);
      setMenu(null);
      setNotice(SEARCH_JUMP_UNAVAILABLE);
      return;
    }
    setNotice("Search action failed. Try again.");
  }
  async function insert(result: SearchResult, display: "chip" | "card") {
    if (!pageId || acting) return;
    setActing(true);
    const recordId = recordIdFromHit(result.id);
    const targetPageId = recordId ? null : decodeURIComponent((result.href?.match(/\/pages\/([^?#]+)/)?.[1] ?? result.id));
    try {
      const data = await requestJson<{ node: RichNode }>(`/api/v1/pages/${encodeURIComponent(pageId)}/references`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ operationId: crypto.randomUUID(), ...(recordId ? { record_id: recordId, display } : { target_page_id: targetPageId, display: "chip" }), stage: true }) });
      window.dispatchEvent(new CustomEvent("hs-search-insert", { detail: { pageId, node: data.node } }));
      onClose();
    } catch (error) { fail(result, error); }
    finally { setActing(false); }
  }
  async function copy(result: SearchResult) {
    const href = new URL(canonicalSearchHref(result), location.origin).toString();
    try { await navigator.clipboard.writeText(href); setToast(SEARCH_LINK_COPIED); }
    catch { setToast("Clipboard unavailable."); }
  }
  async function openMenu(index: number, result: SearchResult) {
    setMenu(index); setHeadings([]); setNotice("");
    if ((result.kind ?? "page") !== "page") return;
    try {
      const data = await requestJson<Palette>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/search-actions?workspaceId=${encodeURIComponent(workspaceId)}&pageId=${encodeURIComponent(result.id)}`);
      setHeadings(data.headings.filter(item => item.pageId === result.id));
    } catch (error) { fail(result, error); }
  }
  async function peekRecord(result: SearchResult) {
    const recordId = recordIdFromHit(result.id);
    if (!recordId) return;
    try {
      const data = await requestJson<{ title: string; href: string }>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/search-actions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "peek", recordId }) });
      setPeek(data);
    } catch (error) { fail(result, error); }
  }
  async function create(action: SearchCreateAction | SearchQuickAction) {
    if (acting) return;
    if (action.kind === "space-home" && "href" in action && action.href) { onJump?.(action.href); onClose(); return; }
    const key = `${action.kind}:${"spaceId" in action ? action.spaceId ?? "" : ""}:${"collection" in action ? action.collection ?? "" : ""}:${"title" in action ? action.title : "Untitled"}`;
    setActing(true);
    try {
      const title = "title" in action ? action.title : "Untitled";
      const data = await requestJson<{ href: string }>(`/api/v1/workspaces/${encodeURIComponent(workspaceId)}/search-actions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(action.kind === "record" || action.kind === "new-record" ? { action: "create-record", operationId: operationId(key), collection: action.collection, title } : { action: "create-page", operationId: operationId(key), spaceId: action.spaceId, title }) });
      onCreated?.(data.href); onClose();
    } catch (error) { fail(null, error); }
    finally { setActing(false); }
  }
  function run(action: SearchActionId, result: SearchResult) {
    if (action === "open") onOpen(result);
    else if (action === "open-tab") onOpenTab ? onOpenTab(result) : window.open(canonicalSearchHref(result), "_blank", "noopener,noreferrer");
    else if (action === "copy-link") void copy(result);
    else if (action === "insert-link" || action === "insert-chip") void insert(result, "chip");
    else if (action === "insert-card") void insert(result, "card");
    else if (action === "peek-record") void peekRecord(result);
    else if (action === "jump-section") void openMenu(shown.indexOf(result), result);
  }
  commandRef.current = run;
  function actionsFor(result: SearchResult) {
    return permittedSearchActions({ kind: result.kind, hasHeadings: headings.some(item => item.pageId === result.id) }, editing && !!pageId);
  }
  function onKey(event: KeyboardEvent, index: number, result: SearchResult) {
    if (event.key === "ArrowRight" || event.key === "Tab") { event.preventDefault(); void openMenu(index, result); return; }
    if (event.key === "Escape" && menu === index) { event.preventDefault(); setMenu(null); return; }
    const action = searchResultShortcut(event, actionsFor(result));
    if (!action) return;
    event.preventDefault();
    run(action, result);
  }
  return <>
    {!query.trim() && <div className="hs-search-palette" aria-label="Recent and quick actions">
      <h2>Recent</h2>
      {palette.recents.length ? <ul>{palette.recents.map(item => <li key={item.id}><button type="button" onClick={() => onOpen({ id: item.id, title: item.title, href: item.href, spaceId: "", path: [item.spaceName], preview: "", updatedAt: "", match: "title" })}>{item.title}</button></li>)}</ul> : <p>No recent pages.</p>}
      <h2>Quick actions</h2>
      <ul>{palette.quickActions.map(item => <li key={item.id}><button type="button" onClick={() => void create(item)}>{item.label}</button></li>)}</ul>
    </div>}
    {jump && <div className="hs-search-jumps" aria-label="Jump to section"><h2>Sections</h2>{palette.headings.length ? palette.headings.map(item => <button type="button" key={`${item.pageId}:${item.blockId}`} onClick={() => { onJump?.(item.href); onClose(); }}>{item.pageTitle} · {item.text}</button>) : <p>No matching sections.</p>}</div>}
    {!error && shown.map((result, index) => <div key={result.id} id={`${listId}-${index}`} role="option" aria-selected={index === selected} tabIndex={0} className={index === selected ? "hs-search-result selected" : "hs-search-result"} onFocus={() => onSelect(index)} onKeyDown={event => onKey(event, index, result)} onClick={() => onOpen(result)}>
      <strong>{result.title}</strong><span>{result.path.filter(Boolean).join(" / ")}</span>
      <button type="button" aria-label={`Actions for ${result.title}`} onClick={event => { event.stopPropagation(); void openMenu(index, result); }}>…</button>
      {menu === index && <div role="menu" aria-label={`Actions for ${result.title}`} onClick={event => event.stopPropagation()} onKeyDown={event => event.stopPropagation()}>
        {actionsFor(result).map(action => <button type="button" role="menuitem" key={action} onClick={() => run(action, result)}>{searchActionLabels[action]}</button>)}
        {headings.filter(item => item.pageId === result.id).map(item => <button type="button" role="menuitem" key={item.blockId} onClick={() => { onJump?.(item.href); onClose(); }}>{`Jump to ${item.text}`}</button>)}
      </div>}
    </div>)}
    {!jump && !error && query.trim().length >= 2 && !shown.length && palette.creates.map(action => <button type="button" key={`${action.kind}:${action.spaceId ?? action.collection}`} disabled={acting} onClick={() => void create(action)}>{action.label}</button>)}
    {peek && <aside className="hs-search-peek" aria-label="Record preview"><h2>{peek.title}</h2><a href={peek.href}>Open record</a><button type="button" onClick={() => setPeek(null)}>Close preview</button></aside>}
    {notice && <p role="alert">{notice}</p>}
    <p className="hs-search-toast" role="status">{toast}</p>
    <p className="hs-search-shortcuts">{SEARCH_SHORTCUT_HINT}</p>
  </>;
}

export function createMissLabel(title: string, spaceName: string) {
  return createPageActionLabel(title, spaceName);
}
