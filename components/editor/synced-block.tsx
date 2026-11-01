"use client";
import { Node, mergeAttributes } from "@tiptap/core";
import { NodeViewContent, NodeViewWrapper, ReactNodeViewRenderer, type NodeViewProps } from "@tiptap/react";
import { Plugin } from "@tiptap/pm/state";
import { useEffect, useState } from "react";
import { plainText, type RichNode } from "../../lib/document";
import {
  SYNCED_CONFLICT_MESSAGE,
  SYNCED_EDIT_HINT,
  SYNCED_POLL_MS,
  SYNCED_RESTRICTED_LABEL,
  SYNCED_TRASH_LABEL,
  SYNCED_UNAVAILABLE_LABEL,
  syncedClipboardPayload,
  syncedPlacementLabel,
  type SyncedConflictDetails,
} from "../../lib/synced-block-copy";
import { applyRemoteSyncedContent, deletePlacementLocal, purgeSyncedContent, subscribeSyncedConflict, unsyncLocal } from "../../lib/synced-block-editor";
import { requestJson } from "./use-document-session";

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

type Listed = {
  state: string;
  label: string;
  blockId?: string;
  syncedId?: string;
  version?: number;
  content?: RichNode[];
  pages?: { id: string; title: string }[];
  canEdit?: boolean;
  hint?: string | null;
  updatedAtIst?: string;
  canUndo?: boolean;
  canRestore?: boolean;
};

function SyncedBlockView({ node, editor, extension }: NodeViewProps) {
  const [listed, setListed] = useState<Listed | null>(null);
  const [conflict, setConflict] = useState<SyncedConflictDetails | null>(null);
  const blockId = String(node.attrs.id ?? "");
  const syncedId = typeof node.attrs.syncedId === "string" ? node.attrs.syncedId : "";
  const pageId = String(extension.options.pageId ?? "");
  useEffect(() => subscribeSyncedConflict(setConflict), []);
  useEffect(() => {
    if (!syncedId || !pageId) return;
    let live = true;
    const load = async () => {
      try {
        const data = await requestJson<{ blocks: Listed[] }>(`/api/v1/pages/${encodeURIComponent(pageId)}/synced-blocks`);
        if (!live) return;
        const found = data.blocks.find(block => block.blockId === blockId) ?? { state: "restricted", label: SYNCED_RESTRICTED_LABEL };
        setListed(found);
        if (found.state !== "live") purgeSyncedContent(editor, blockId);
        else if (found.content && typeof found.version === "number") applyRemoteSyncedContent(editor, blockId, found.content, found.version);
      } catch {
        if (live) setListed({ state: "restricted", label: SYNCED_RESTRICTED_LABEL });
      }
    };
    void load();
    const timer = setInterval(() => void load(), SYNCED_POLL_MS);
    return () => { live = false; clearInterval(timer); };
  }, [blockId, editor, pageId, syncedId]);
  const view: SyncedChromeView = listed?.state === "live"
    ? { state: "live", label: listed.label || syncedPlacementLabel(listed.pages?.length ?? 1), pages: listed.pages ?? [], canEdit: listed.canEdit !== false && !node.attrs.syncLocked, hint: listed.hint ?? (node.attrs.syncLocked ? SYNCED_EDIT_HINT : null), updatedAtIst: listed.updatedAtIst }
    : listed?.state === "trash"
      ? { state: "trash", label: SYNCED_TRASH_LABEL }
      : listed?.state === "unavailable"
        ? { state: "unavailable", label: SYNCED_UNAVAILABLE_LABEL }
        : node.attrs.syncState === "trash"
          ? { state: "trash", label: SYNCED_TRASH_LABEL }
          : node.attrs.syncState === "unavailable"
            ? { state: "unavailable", label: SYNCED_UNAVAILABLE_LABEL }
            : syncedId || node.attrs.syncState === "restricted"
              ? { state: "restricted", label: SYNCED_RESTRICTED_LABEL }
              : { state: "live", label: "Synced", pages: [], canEdit: !node.attrs.syncLocked, hint: node.attrs.syncLocked ? SYNCED_EDIT_HINT : null };
  const hidden = view.state !== "live";
  const notice = conflict ? { serverText: plainText(conflict.server.content), clientText: plainText(conflict.client.content) } : null;
  async function copy() {
    const payload = syncedClipboardPayload(syncedId);
    if (navigator.clipboard?.writeText) await navigator.clipboard.writeText(payload);
  }
  function command(action: string, extra: Record<string, unknown> = {}) {
    const operation = action === "delete-all-preview" ? {} : { operationId: crypto.randomUUID() };
    return requestJson<{ confirm?: string; titles?: string[]; hiddenCount?: number }>(`/api/v1/pages/${encodeURIComponent(pageId)}/synced-blocks`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, blockId, ...operation, ...extra }) });
  }
  async function deleteAll() {
    const preview = await command("delete-all-preview");
    if (!window.confirm(preview.confirm ?? "")) return;
    await command("delete-all", { confirm: true, titles: preview.titles ?? [], hiddenCount: preview.hiddenCount ?? 0 });
    purgeSyncedContent(editor, blockId);
  }
  return <NodeViewWrapper className={`synced-block${hidden ? " is-restricted" : ""}`} data-synced-state={view.state} data-synced-label={view.state === "live" ? view.label : view.label}>
    <SyncedBlockChrome view={view} conflict={notice} onCopy={syncedId ? () => void copy() : undefined} onUnsync={editor.isEditable && view.state === "live" ? () => unsyncLocal(editor, blockId) : undefined} onDeletePlacement={editor.isEditable ? () => { deletePlacementLocal(editor, blockId); } : undefined} onDeleteAll={editor.isEditable && view.state === "live" && view.canEdit ? () => void deleteAll() : undefined} onUndo={view.state === "restricted" && node.attrs.syncUndo ? () => void command("undo-delete") : undefined} onRestore={view.state === "trash" ? () => void command("restore-source") : undefined}/>
    {!hidden && <NodeViewContent/>}
  </NodeViewWrapper>;
}

export const SyncedBlock = Node.create({
  name: "syncedBlock",
  group: "block",
  content: "block*",
  defining: true,
  addOptions() { return { pageId: "" }; },
  addAttributes() { return { syncedId: { default: null }, syncVersion: { default: null }, syncState: { default: null }, syncLocked: { default: false }, syncUndo: { default: false } }; },
  parseHTML() { return [{ tag: "section[data-hs-synced]" }]; },
  renderHTML({ HTMLAttributes }) { return ["section", mergeAttributes(HTMLAttributes, { "data-hs-synced": "", "data-sync-state": HTMLAttributes.syncState ?? "live" }), 0]; },
  addNodeView() { return ReactNodeViewRenderer(SyncedBlockView); },
  addProseMirrorPlugins() {
    return [new Plugin({
      filterTransaction(transaction) {
        if (!transaction.docChanged) return true;
        const locked = new Map<string, PMContent>();
        transaction.before.descendants(node => { if (node.type.name === "syncedBlock" && node.attrs.syncLocked) locked.set(String(node.attrs.id), node.content); });
        let allowed = true;
        transaction.doc.descendants(node => {
          if (node.type.name !== "syncedBlock" || !locked.has(String(node.attrs.id))) return;
          if (!locked.get(String(node.attrs.id))!.eq(node.content)) allowed = false;
        });
        return allowed;
      },
    })];
  },
});

type PMContent = import("@tiptap/pm/model").Fragment;
