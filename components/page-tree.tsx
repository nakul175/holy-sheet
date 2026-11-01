"use client";
import { useCallback, useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { Dialog } from "./editor/dialog";
import { ApiError, requestJson } from "./editor/use-document-session";
import {
  dropPlacement,
  PAGE_TREE_CREATE_DENIED,
  PAGE_TREE_REFRESH_MS,
  PAGE_TREE_ROW_PX,
  PAGE_TREE_UNAVAILABLE,
  PAGE_TREE_UNDO_MS,
  pageTreeWindow,
  siblingDestination,
  type PageTreeDrop,
  type PageTreeMovePreview,
  type PageTreeMoveResult,
  type PageTreeNode,
  type PageTreeSlice,
} from "../lib/page-tree-model";
import { canEdit } from "../lib/types";
import UiIcon from "./ui-icon";

type Place = { spaceId: string; parentId: string | null; index: number };
type Intent = Place & { pageId: string };
type Pending = { preview: PageTreeMovePreview; intent: Intent; inverse: Place | null; operationId: string };
type Toast = { pageId: string; atIst: string; inverse: Place };
type Draft = { id: string; kind: "create" | "rename"; value: string; operationId?: string };
type Flat = { kind: "node"; node: PageTreeNode; depth: number } | { kind: "skeleton"; key: string; depth: number };

const post = (body: unknown) => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
let treeQueue: Promise<void> = Promise.resolve();
let treeQueued = 0;
function enqueueTreeRequest<T>(run: () => Promise<T>): Promise<T> {
  treeQueued += 1;
  const result = treeQueue.then(run, run);
  treeQueue = result.finally(() => { treeQueued -= 1; }).then(() => undefined, () => undefined);
  return result;
}
const requestTree = <T,>(url: string, init?: RequestInit) => enqueueTreeRequest(() => requestJson<T>(url, init));

export default function PageTree({ workspaceId, spaceId, spaceName, activeId, onOpen }: { workspaceId: string; spaceId: string; spaceName: string; activeId?: string; onOpen: (id: string) => void }) {
  const hintId = useId();
  const endpoint = `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/page-tree`;
  const scroller = useRef<HTMLDivElement>(null);
  const mounted = useRef(true);
  const dragging = useRef<string | null>(null);
  const expandedRef = useRef<Set<string>>(new Set());
  const [roots, setRoots] = useState<PageTreeNode[]>([]);
  const [children, setChildren] = useState<Record<string, PageTreeNode[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState<Record<string, boolean>>({});
  const [ready, setReady] = useState(false);
  const [canCreate, setCanCreate] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [drop, setDrop] = useState<{ id: string; place: PageTreeDrop } | null>(null);
  const [notice, setNotice] = useState("");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [toast, setToast] = useState<Toast | null>(null);
  const [pending, setPending] = useState<Pending | null>(null);
  const [moveFor, setMoveFor] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewport, setViewport] = useState(360);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  expandedRef.current = expanded;

  const load = useCallback(async (parentId: string | null) => {
    const params = new URLSearchParams({ spaceId });
    if (parentId) params.set("parentId", parentId);
    const slice = await requestTree<PageTreeSlice>(`${endpoint}?${params}`);
    if (!slice || !Array.isArray(slice.nodes)) throw new ApiError(PAGE_TREE_UNAVAILABLE, 404, "not_found");
    if (!mounted.current) return slice;
    if (parentId) setChildren(current => ({ ...current, [parentId]: slice.nodes }));
    else {
      setRoots(slice.nodes);
      setCanCreate(slice.canCreateInSpace);
    }
    return slice;
  }, [endpoint, spaceId]);

  const reloadAll = useCallback(async () => {
    await load(null);
    for (const id of expandedRef.current) await load(id);
  }, [load]);

  useEffect(() => {
    mounted.current = true;
    let live = true;
    setReady(false);
    void load(null).then(() => { if (live) setReady(true); }).catch(error => { if (live) { setReady(true); setNotice(error instanceof Error ? error.message : PAGE_TREE_UNAVAILABLE); } });
    const interval = setInterval(() => { if (document.visibilityState === "hidden" || treeQueued > 0) return; void reloadAll().catch(() => undefined); }, PAGE_TREE_REFRESH_MS);
    return () => { live = false; mounted.current = false; clearInterval(interval); };
  }, [load, reloadAll]);

  useEffect(() => {
    const height = scroller.current?.clientHeight ?? 0;
    if (height > 0) setViewport(height);
  }, [roots.length, ready]);

  useEffect(() => { if (!toast) return; const timer = setTimeout(() => setToast(null), PAGE_TREE_UNDO_MS); return () => clearTimeout(timer); }, [toast]);

  const find = useCallback((id: string) => roots.find(node => node.id === id) ?? Object.values(children).flat().find(node => node.id === id), [roots, children]);

  function siblingsOf(node: PageTreeNode) {
    return node.parentId ? children[node.parentId] ?? [] : roots;
  }

  function showError(error: unknown) {
    setNotice(error instanceof Error ? error.message : PAGE_TREE_UNAVAILABLE);
    if (error instanceof ApiError && error.status === 404) void reloadAll().catch(() => undefined);
  }

  async function expand(node: PageTreeNode) {
    setExpanded(current => new Set(current).add(node.id));
    if (children[node.id]) return;
    setLoading(current => ({ ...current, [node.id]: true }));
    try { await load(node.id); }
    catch (error) { showError(error); }
    finally { setLoading(current => ({ ...current, [node.id]: false })); }
  }

  function collapse(id: string) {
    setExpanded(current => { const next = new Set(current); next.delete(id); return next; });
  }

  async function createChild(parentId: string | null) {
    const operationId = crypto.randomUUID();
    setBusy(true);
    try {
      const created = await requestTree<{ pageId: string }>(endpoint, post({ kind: "create", spaceId, parentId, operationId }));
      if (parentId) {
        setExpanded(current => new Set(current).add(parentId));
        await load(parentId);
      } else await load(null);
      setDraft({ id: created.pageId, kind: "create", value: "", operationId });
      setFocusId(created.pageId);
      setNotice("");
    } catch (error) { showError(error); }
    finally { setBusy(false); }
  }

  async function cancelDraft(current: Draft) {
    setDraft(null);
    if (current.kind === "create" && current.operationId) {
      try { await requestTree(endpoint, post({ kind: "cancel", operationId: current.operationId })); }
      catch (error) { if (!(error instanceof ApiError) || error.status === 404) showError(error); else if (error.code !== "page_not_empty") showError(error); }
    }
    await reloadAll().catch(() => undefined);
  }

  async function commitRename(node: PageTreeNode, title: string) {
    setBusy(true);
    try {
      await requestTree(endpoint, post({ kind: "rename", pageId: node.id, title, baseVersion: node.version, operationId: crypto.randomUUID() }));
      setDraft(null);
      setNotice("");
      if (node.parentId) await load(node.parentId); else await load(null);
    } catch (error) { showError(error); }
    finally { setBusy(false); }
  }

  async function applyPending(next: Pending, confirmExpanded: boolean) {
    const result = await requestTree<PageTreeMoveResult>(endpoint, post({ kind: "apply", ...next.intent, operationId: next.operationId, expectedTreeVersion: next.preview.treeVersion, previewDigest: next.preview.digest, confirmExpanded }));
    setPending(null);
    setMoveFor(null);
    setChecked(false);
    setNotice("");
    if (next.inverse) setToast({ pageId: next.intent.pageId, atIst: result.atIst, inverse: next.inverse });
    await reloadAll();
  }

  async function commitMove(intent: Intent, inverse: Place | null) {
    if (busy) return;
    setBusy(true);
    try {
      const preview = await requestTree<PageTreeMovePreview>(endpoint, post({ kind: "preview", pageId: intent.pageId, spaceId: intent.spaceId, parentId: intent.parentId, index: intent.index }));
      const next = { preview, intent, inverse, operationId: crypto.randomUUID() };
      if (preview.expandsAccess) { setPending(next); setChecked(false); setMoveFor(null); return; }
      await applyPending(next, false);
    } catch (error) { showError(error); }
    finally { setBusy(false); }
  }

  async function dropOn(target: PageTreeNode, place: PageTreeDrop) {
    const draggedId = dragging.current;
    dragging.current = null;
    setDrop(null);
    const dragged = draggedId ? find(draggedId) : undefined;
    if (!dragged || dragged.id === target.id) return;
    const inverse = { spaceId: dragged.spaceId, parentId: dragged.parentId, index: siblingsOf(dragged).findIndex(node => node.id === dragged.id) };
    if (place === "inside") {
      let kids = children[target.id];
      if (target.hasVisibleChildren && !kids) {
        try { kids = (await load(target.id)).nodes; } catch (error) { showError(error); return; }
      }
      const index = siblingDestination((kids ?? []).map(node => node.id), dragged.id, "", "after");
      await commitMove({ pageId: dragged.id, spaceId: target.spaceId, parentId: target.id, index: Math.max(0, index) }, inverse.index < 0 ? null : inverse);
      return;
    }
    const index = siblingDestination(siblingsOf(target).map(node => node.id), dragged.id, target.id, place);
    await commitMove({ pageId: dragged.id, spaceId: target.spaceId, parentId: target.parentId, index }, inverse.index < 0 ? null : inverse);
  }

  const rows: Flat[] = [];
  const walk = (nodes: PageTreeNode[], depth: number) => {
    for (const node of nodes) {
      rows.push({ kind: "node", node, depth });
      if (!expanded.has(node.id)) continue;
      if (loading[node.id] && !children[node.id]) rows.push({ kind: "skeleton", key: node.id, depth: depth + 1 });
      else walk(children[node.id] ?? [], depth + 1);
    }
  };
  walk(roots, 0);
  const range = pageTreeWindow(scrollTop, viewport, rows.length);
  const visibleRows = rows.slice(range.start, range.end);
  const nodeRows = rows.flatMap(row => row.kind === "node" ? [row] : []);

  useEffect(() => {
    if (!focusId || draft?.id === focusId) return;
    document.getElementById(`page-tree-item-${focusId}`)?.focus();
  }, [focusId, draft, scrollTop, roots, children, expanded]);

  function onKey(event: KeyboardEvent<HTMLDivElement>) {
    if (event.nativeEvent.isComposing || event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) return;
    const current = nodeRows.find(row => row.node.id === focusId) ?? nodeRows[0];
    if (!current && event.key.toLowerCase() !== "n") return;
    const index = current ? nodeRows.findIndex(row => row.node.id === current.node.id) : -1;
    if ((event.altKey && event.shiftKey && (event.key === "ArrowUp" || event.key === "ArrowDown"))) {
      event.preventDefault();
      if (!current) return;
      const siblings = siblingsOf(current.node);
      const at = siblings.findIndex(node => node.id === current.node.id);
      const direction = event.key === "ArrowUp" ? -1 : 1;
      const target = siblings[at + direction];
      if (!target || !canEdit(current.node.role)) return;
      const place = direction < 0 ? "before" : "after";
      void commitMove({ pageId: current.node.id, spaceId: current.node.spaceId, parentId: current.node.parentId, index: siblingDestination(siblings.map(node => node.id), current.node.id, target.id, place) }, { spaceId: current.node.spaceId, parentId: current.node.parentId, index: at });
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const next = nodeRows[index + (event.key === "ArrowDown" ? 1 : -1)];
      if (next) setFocusId(next.node.id);
      return;
    }
    if (!current) return;
    if (event.key === "ArrowRight") {
      event.preventDefault();
      if (current.node.hasVisibleChildren && !expanded.has(current.node.id)) void expand(current.node);
      else if (children[current.node.id]?.[0]) setFocusId(children[current.node.id][0].id);
      return;
    }
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      if (expanded.has(current.node.id)) collapse(current.node.id);
      else if (current.node.parentId) setFocusId(current.node.parentId);
      return;
    }
    if (event.key === "Enter") { event.preventDefault(); onOpen(current.node.id); return; }
    if (event.key === "F2" && canEdit(current.node.role)) { event.preventDefault(); setDraft({ id: current.node.id, kind: "rename", value: current.node.title }); return; }
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && event.key.toLowerCase() === "m") { event.preventDefault(); setMoveFor(current.node.id); setPending(null); return; }
    if (event.key.toLowerCase() === "n" && !event.metaKey && !event.ctrlKey && !event.altKey && canEdit(current.node.role)) { event.preventDefault(); void createChild(current.node.id); }
  }

  const moving = moveFor ? find(moveFor) : undefined;
  return <div className="page-tree-host">
    {notice && <p className="page-tree-notice" role="alert">{notice}</p>}
    <div className={`page-tree-space${drop?.id === "space" ? " drop-inside" : ""}`} onDragOver={event => { if (!dragging.current) return; event.preventDefault(); setDrop({ id: "space", place: "inside" }); }} onDrop={event => { event.preventDefault(); const dragged = dragging.current ? find(dragging.current) : undefined; dragging.current = null; setDrop(null); if (!dragged) return; const index = siblingDestination(roots.map(node => node.id), dragged.id, "", "after"); void commitMove({ pageId: dragged.id, spaceId, parentId: null, index }, { spaceId: dragged.spaceId, parentId: dragged.parentId, index: siblingsOf(dragged).findIndex(node => node.id === dragged.id) }); }}>
      {canCreate && <button type="button" className="page-tree-add" aria-label={`New page in ${spaceName}`} disabled={busy} onClick={() => void createChild(null)}><UiIcon name="plus"/>New page</button>}
    </div>
    {!ready && <div className="page-tree-skeleton" role="status" aria-busy="true">Loading pages</div>}
    {ready && !rows.length && <p className="space-empty">No pages yet</p>}
    {rows.length > 0 && <div ref={scroller} className="page-tree page-tree-virtual" role="tree" aria-label={`Pages in ${spaceName}`} aria-describedby={hintId} onKeyDown={onKey} onScroll={event => setScrollTop(event.currentTarget.scrollTop)} onDragLeave={() => setDrop(null)}>
      <div style={{ position: "relative", height: rows.length * PAGE_TREE_ROW_PX }}>
        {visibleRows.map((row, offset) => {
          const top = (range.start + offset) * PAGE_TREE_ROW_PX;
          if (row.kind === "skeleton") return <div key={`loading-${row.key}`} className="page-tree-skeleton" role="treeitem" aria-busy="true" aria-level={row.depth + 1} style={{ position: "absolute", top, height: PAGE_TREE_ROW_PX, left: 0, right: 0 }}>Loading pages</div>;
          const node = row.node;
          const open = expanded.has(node.id);
          return <div key={node.id} id={`page-tree-item-${node.id}`} role="treeitem" aria-level={row.depth + 1} aria-selected={focusId === node.id} aria-current={node.id === activeId ? "page" : undefined} aria-expanded={node.hasVisibleChildren ? open : undefined} tabIndex={focusId === node.id || (!focusId && offset === 0 && range.start === 0) ? 0 : -1} className={`page-tree-row${drop?.id === node.id ? ` drop-${drop.place}` : ""}`} style={{ position: "absolute", top, height: PAGE_TREE_ROW_PX, left: 0, right: 0, paddingLeft: 8 + row.depth * 14 }} draggable={canEdit(node.role) && draft?.id !== node.id} onDragStart={event => { if (!canEdit(node.role)) { event.preventDefault(); return; } dragging.current = node.id; event.dataTransfer?.setData("application/x-holy-page", node.id); if (event.dataTransfer) event.dataTransfer.effectAllowed = "move"; }} onDragOver={event => { if (!dragging.current || dragging.current === node.id) return; event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); setDrop({ id: node.id, place: dropPlacement(event.clientY - rect.top, rect.height || PAGE_TREE_ROW_PX) }); }} onDrop={event => { event.preventDefault(); const rect = event.currentTarget.getBoundingClientRect(); void dropOn(node, dropPlacement(event.clientY - rect.top, rect.height || PAGE_TREE_ROW_PX)); }} onDragEnd={() => { dragging.current = null; setDrop(null); }}>
            {node.hasVisibleChildren ? <button type="button" className="page-tree-expand" aria-label={`${open ? "Collapse" : "Expand"} ${node.title}`} tabIndex={-1} onClick={() => { setFocusId(node.id); if (open) collapse(node.id); else void expand(node); }}>{open ? "▾" : "▸"}</button> : <span className="page-tree-expand" aria-hidden="true"/>}
            {draft?.id === node.id ? <input id={`page-tree-title-${node.id}`} className="page-tree-rename" aria-label={draft.kind === "create" ? "New page title" : `Rename ${node.title}`} value={draft.value} autoFocus placeholder="Untitled" onChange={event => setDraft({ ...draft, value: event.target.value })} onKeyDown={event => { if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); void cancelDraft(draft); } if (event.key === "Enter") { event.preventDefault(); event.stopPropagation(); const title = draft.value.trim(); if (!title) void cancelDraft(draft); else void commitRename(node, title); } }}/> : <button type="button" className={`page-tree-open${node.id === activeId ? " active" : ""}`} tabIndex={-1} onClick={() => { setFocusId(node.id); onOpen(node.id); }}><UiIcon name="document"/><span className="page-tree-title">{node.title}</span></button>}
            {canEdit(node.role) && <button type="button" className="page-tree-add" aria-label={`New subpage of ${node.title}`} tabIndex={-1} disabled={busy} onClick={() => void createChild(node.id)}>+</button>}
          </div>;
        })}
      </div>
    </div>}
    <p id={hintId} className="page-tree-live">Arrow keys move in the tree. Enter opens. F2 renames. N or plus creates a subpage. Alt plus Shift plus arrows reorder. Command or Control plus Shift plus M opens Move page. Escape cancels an empty new page.</p>
    <div className="page-tree-live" aria-live="polite">{drop ? `Drop ${drop.place === "inside" && drop.id === "space" ? `inside ${spaceName}` : `${drop.place} ${find(drop.id)?.title ?? ""}`}` : ""}</div>
    {toast && <div className="page-tree-toast" role="status"><span>Page moved. {toast.atIst}. Undo is available for 10 seconds.</span><button type="button" onClick={() => { const current = find(toast.pageId); const redo = current ? { spaceId: current.spaceId, parentId: current.parentId, index: siblingsOf(current).findIndex(node => node.id === current.id) } : null; const inverse = toast.inverse; setToast(null); void commitMove({ pageId: toast.pageId, ...inverse }, redo && redo.index >= 0 ? redo : null); }}>Undo</button></div>}
    {pending && <Dialog title="Move page" onClose={() => { if (!busy) { setPending(null); setChecked(false); } }}><div className="page-tree-move">
      <p>Move this page and its descendants. Inherited access is checked before anything changes.</p>
      <p>{pending.preview.sourcePath.join(" / ")} → {pending.preview.targetPath.join(" / ")}</p>
      <p>{pending.preview.position.afterTitle ? `After ${pending.preview.position.afterTitle}` : "First among the pages you can see"}</p>
      <h3>Effective access changes</h3>
      {pending.preview.changes.length ? <ul>{pending.preview.changes.map(change => <li key={`${change.pageId}:${change.recipientId}`}><strong>{change.recipientName}</strong> on {change.pageTitle}: {change.before ?? "No access"} → {change.after ?? "No access"}</li>)}</ul> : <p>No effective access changes.</p>}
      {pending.preview.expandsAccess && <label className="check"><input type="checkbox" checked={checked} onChange={event => setChecked(event.target.checked)}/>I reviewed and approve the additional inherited access.</label>}
      <div className="actions"><button type="button" disabled={busy} onClick={() => setPending(null)}>Cancel</button><button type="button" className="primary" disabled={busy || (pending.preview.expandsAccess && !checked)} onClick={() => { setBusy(true); void applyPending(pending, checked).catch(showError).finally(() => setBusy(false)); }}>Confirm move</button></div>
    </div></Dialog>}
    {moving && !pending && <MoveDialog node={moving} spaceName={spaceName} roots={roots} children={children} busy={busy} onClose={() => setMoveFor(null)} onReview={(parentId, index) => void commitMove({ pageId: moving.id, spaceId: moving.spaceId, parentId, index }, { spaceId: moving.spaceId, parentId: moving.parentId, index: siblingsOf(moving).findIndex(item => item.id === moving.id) })}/>}
  </div>;
}

function MoveDialog({ node, spaceName, roots, children, busy, onClose, onReview }: { node: PageTreeNode; spaceName: string; roots: PageTreeNode[]; children: Record<string, PageTreeNode[]>; busy: boolean; onClose: () => void; onReview: (parentId: string | null, index: number) => void }) {
  const blocked = new Set<string>([node.id]);
  const walk = (id: string) => { for (const child of children[id] ?? []) { blocked.add(child.id); walk(child.id); } };
  walk(node.id);
  const destinations = [...roots, ...Object.values(children).flat()].filter(item => !blocked.has(item.id));
  const [parentId, setParentId] = useState(node.parentId ?? "");
  const siblings = (parentId ? children[parentId] ?? [] : roots).filter(item => item.id !== node.id);
  const [index, setIndex] = useState(0);
  const chosen = Math.min(index, siblings.length);
  return <Dialog title="Move page" onClose={onClose}><form className="page-tree-move" onSubmit={event => { event.preventDefault(); onReview(parentId || null, chosen); }}>
    <p>Choose a destination you can organise. A space where you cannot create pages is refused with an explanation. {PAGE_TREE_CREATE_DENIED}</p>
    <label>Parent page<select value={parentId} disabled={busy} onChange={event => { setParentId(event.target.value); setIndex(0); }}><option value="">Top level in {spaceName}</option>{destinations.map(item => <option key={item.id} value={item.id}>{item.title}</option>)}</select></label>
    <label>Position<select value={chosen} disabled={busy} onChange={event => setIndex(Number(event.target.value))}><option value={0}>First</option>{siblings.map((item, itemIndex) => <option key={item.id} value={itemIndex + 1}>After {item.title}</option>)}</select></label>
    <div className="actions"><button type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="primary" disabled={busy}>Review move and access</button></div>
  </form></Dialog>;
}
