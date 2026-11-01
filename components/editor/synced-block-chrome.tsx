"use client";
import { useEffect, useState } from "react";
import { SYNCED_CONFLICT_MESSAGE, SYNCED_RESTRICTED_LABEL } from "../../lib/synced-block-copy";

export type SyncedChromeView =
  | { state: "restricted"; label: string }
  | { state: "unavailable"; label: string }
  | { state: "trash"; label: string; canRestore?: boolean }
  | { state: "live"; label: string; pages: { id: string; title: string }[]; canEdit: boolean; hint: string | null; updatedAtIst?: string | null; canUndo?: boolean };

export function SyncedBlockFrame({ view, content }: { view: { state: string; label: string }; content?: string }) {
  const [shown, setShown] = useState(view.state === "live" ? content ?? "" : "");
  useEffect(() => { setShown(view.state === "live" ? content ?? "" : ""); }, [view.state, content]);
  if (view.state !== "live") return <div className={`synced-block is-${view.state}`} data-synced-state={view.state}><p>{view.label}</p></div>;
  return <div className="synced-block" data-synced-state="live"><p className="synced-label">{view.label}</p><div>{shown}</div></div>;
}

export function SyncedBlockChrome({
  view,
  conflict,
  onCopy,
  onUnsync,
  onDeletePlacement,
  onDeleteAll,
  onUndo,
  onRestore,
}: {
  view: SyncedChromeView;
  conflict?: { serverText: string; clientText: string } | null;
  onCopy?: () => void;
  onUnsync?: () => void;
  onDeletePlacement?: () => void;
  onDeleteAll?: () => void;
  onUndo?: () => void;
  onRestore?: () => void;
}) {
  if (view.state === "restricted") {
    return <div className="synced-block is-restricted" data-synced-state="restricted" contentEditable={false}><p>{view.label}</p>{view.label === SYNCED_RESTRICTED_LABEL && onUndo ? <button type="button" onMouseDown={event => event.preventDefault()} onClick={onUndo}>Undo delete</button> : null}</div>;
  }
  if (view.state === "unavailable") return <div className="synced-block is-unavailable" data-synced-state="unavailable" contentEditable={false}><p>{view.label}</p></div>;
  if (view.state === "trash") {
    return <div className="synced-block is-unavailable" data-synced-state="trash" contentEditable={false}><p>{view.label}</p>{onRestore ? <button type="button" onMouseDown={event => event.preventDefault()} onClick={onRestore}>Restore</button> : null}</div>;
  }
  return <div className="synced-chrome" contentEditable={false}>
    <span className="synced-label">{view.label}</span>
    {view.pages.length > 0 && <ul aria-label="Pages in sync">{view.pages.map(page => <li key={page.id}>{page.title}</li>)}</ul>}
    {view.hint && <p className="synced-hint">{view.hint}</p>}
    {view.updatedAtIst && <p><time>{view.updatedAtIst}</time></p>}
    {onCopy && <button type="button" onMouseDown={event => event.preventDefault()} onClick={onCopy}>Copy synced block</button>}
    {onUnsync && <button type="button" onMouseDown={event => event.preventDefault()} onClick={onUnsync}>Unsync</button>}
    {onDeletePlacement && <button type="button" onMouseDown={event => event.preventDefault()} onClick={onDeletePlacement}>Delete from this page</button>}
    {view.canEdit && onDeleteAll && <button type="button" onMouseDown={event => event.preventDefault()} onClick={onDeleteAll}>Delete all copies</button>}
    {conflict && <div role="alert" className="synced-conflict"><p>{SYNCED_CONFLICT_MESSAGE}</p><section><h4>Saved version</h4><pre>{conflict.serverText}</pre></section><section><h4>Your version</h4><pre>{conflict.clientText}</pre></section></div>}
  </div>;
}
