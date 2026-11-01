"use client";
import type { Editor } from "@tiptap/core";
import { NodeViewContent, NodeViewWrapper, type NodeViewProps } from "@tiptap/react";
import { Fragment } from "@tiptap/pm/model";
import type { Node as PMNode } from "@tiptap/pm/model";
import { useEffect, useState } from "react";
import { plainText, type RichNode } from "../../lib/document";
import { SNIPPET_DETACH_LABEL, SNIPPET_EDIT_LABEL, SNIPPET_RESTRICTED_LABEL, SNIPPET_UPDATE_LABEL } from "../../lib/snippet-copy";
import { SYNCED_POLL_MS } from "../../lib/synced-block-copy";
import { SyncedBlockChrome } from "./synced-block-chrome";
import { requestJson } from "./use-document-session";

export type SnippetChrome = {
  state: "restricted" | "live";
  label: string;
  badge: string | null;
  updateLabel: string | null;
  approvedAtIst: string | null;
};

export function SnippetPlacementChrome({
  view,
  editHref,
  onDetach,
  onUpdate,
}: {
  view: SnippetChrome;
  editHref?: string | null;
  onDetach?: () => void;
  onUpdate?: () => void;
}) {
  if (view.state !== "live") return <SyncedBlockChrome view={{ state: "restricted", label: view.label || SNIPPET_RESTRICTED_LABEL }} />;
  const update = view.updateLabel === SNIPPET_UPDATE_LABEL;
  return <div className="snippet-placement" data-snippet-state="live">
    <SyncedBlockChrome view={{ state: "live", label: view.label, pages: [], canEdit: false, hint: "Read only", updatedAtIst: view.approvedAtIst }} />
    {view.badge && <p className="snippet-badge">{view.badge}</p>}
    {view.updateLabel && <p className="snippet-update">{update && onUpdate ? <>Newer approved version available — <button type="button" onMouseDown={event => event.preventDefault()} onClick={onUpdate}>Update</button></> : view.updateLabel}</p>}
    {editHref && <a href={editHref}>{SNIPPET_EDIT_LABEL}</a>}
    {onDetach && <button type="button" onMouseDown={event => event.preventDefault()} onClick={onDetach}>{SNIPPET_DETACH_LABEL}</button>}
  </div>;
}

type Listed = {
  state: string;
  label: string;
  blockId: string;
  badge?: string | null;
  updateLabel?: string | null;
  canDetach?: boolean;
  editHref?: string | null;
  approvedAtIst?: string | null;
  versionNumber?: number;
  content?: RichNode[];
};

function located(editor: Editor, blockId: string) {
  let target: { pos: number; node: PMNode } | null = null;
  editor.state.doc.descendants((node, pos) => { if (node.type.name === "syncedBlock" && node.attrs.id === blockId) target = { pos, node }; });
  return target;
}

export function applySnippetContent(editor: Editor, blockId: string, content: RichNode[], version: number) {
  const found = located(editor, blockId);
  if (!found) return false;
  const current = found as { pos: number; node: PMNode };
  const sameText = plainText({ type: "doc", content: current.node.content.toJSON() as RichNode[] }) === plainText({ type: "doc", content });
  if (current.node.attrs.syncVersion === version && sameText) return false;
  const next = current.node.type.create({ ...current.node.attrs, syncVersion: version, syncState: "live", syncLocked: true }, Fragment.fromArray(content.map(node => editor.schema.nodeFromJSON(node))));
  editor.view.dispatch(editor.state.tr.replaceWith(current.pos, current.pos + current.node.nodeSize, next).setMeta("snippet-sync", true).setMeta("addToHistory", false));
  return true;
}

export function SnippetPlacement({ node, editor, extension }: NodeViewProps) {
  const blockId = String(node.attrs.id ?? "");
  const pageId = String(extension.options.pageId ?? "");
  const [view, setView] = useState<Listed | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!pageId) return;
    let live = true;
    const load = async () => {
      try {
        const data = await requestJson<{ placements: Listed[] }>(`/api/v1/pages/${encodeURIComponent(pageId)}/snippets`);
        if (!live) return;
        const found = data.placements.find(item => item.blockId === blockId) ?? { state: "restricted", label: SNIPPET_RESTRICTED_LABEL, blockId };
        setView(found);
        if (found.state === "live" && found.content && found.versionNumber !== node.attrs.syncVersion) applySnippetContent(editor, blockId, found.content, found.versionNumber ?? 0);
      } catch {
        if (live) setView({ state: "restricted", label: SNIPPET_RESTRICTED_LABEL, blockId });
      }
    };
    void load();
    const timer = setInterval(() => void load(), SYNCED_POLL_MS);
    return () => { live = false; clearInterval(timer); };
  }, [blockId, editor, node.attrs.syncVersion, pageId]);
  const live = view ? view.state === "live" : node.attrs.syncState !== "restricted";
  async function command(action: "detach" | "update") {
    setError("");
    try {
      await requestJson(`/api/v1/pages/${encodeURIComponent(pageId)}/snippets`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action, operationId: crypto.randomUUID(), blockId }) });
      window.location.reload();
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : SNIPPET_RESTRICTED_LABEL);
    }
  }
  return <NodeViewWrapper className={`synced-block${live ? "" : " is-restricted"}`} data-snippet-state={live ? "live" : "restricted"} contentEditable={false}>
    <SnippetPlacementChrome
      view={{ state: live ? "live" : "restricted", label: view?.label ?? (live ? "Snippet" : SNIPPET_RESTRICTED_LABEL), badge: live ? view?.badge ?? null : null, updateLabel: live ? view?.updateLabel ?? null : null, approvedAtIst: view?.approvedAtIst ?? null }}
      editHref={live ? view?.editHref : null}
      onDetach={editor.isEditable && view?.canDetach ? () => void command("detach") : undefined}
      onUpdate={editor.isEditable && view?.updateLabel ? () => void command("update") : undefined}
    />
    {error && <p role="alert">{error}</p>}
    {live && <NodeViewContent />}
  </NodeViewWrapper>;
}
