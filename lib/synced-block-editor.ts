import type { Editor } from "@tiptap/core";
import { Fragment } from "@tiptap/pm/model";
import type { Node as PMNode } from "@tiptap/pm/model";
import { plainText, stableStringify, type RichNode } from "./document";
import { SYNCED_CONFLICT_MESSAGE, syncedConflictDetails, type SyncedConflictDetails } from "./synced-block-copy";

type Listener = (details: SyncedConflictDetails | null) => void;
const listeners = new Set<Listener>();

export function publishSyncedConflict(value: unknown) {
  const details = syncedConflictDetails(value);
  for (const listener of listeners) listener(details);
}

export function subscribeSyncedConflict(listener: Listener) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function turnIntoSyncedBlock(editor: Editor) {
  if (!editor.isEditable) throw new Error("This page is read only.");
  const { from, to } = editor.state.selection;
  if (from === to) throw new Error("Select the blocks to sync.");
  const ranges: { from: number; to: number; node: PMNode }[] = [];
  editor.state.doc.forEach((node, offset) => {
    const start = offset;
    const end = offset + node.nodeSize;
    if (start < to && end > from) ranges.push({ from: start, to: end, node });
  });
  if (ranges.length < 1) throw new Error("Select the blocks to sync.");
  if (ranges.some(range => range.node.type.name === "syncedBlock")) throw new Error("This selection is already synced.");
  const type = editor.schema.nodes.syncedBlock;
  if (!type) throw new Error("Synced blocks are not available in this editor.");
  const wrapper = type.create({ id: crypto.randomUUID(), syncState: "live" }, ranges.map(range => range.node));
  editor.view.dispatch(editor.state.tr.replaceWith(ranges[0].from, ranges[ranges.length - 1].to, wrapper).scrollIntoView());
}

export function applyRemoteSyncedContent(editor: Editor, blockId: string, content: RichNode[], version: number) {
  let target: { pos: number; node: PMNode } | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === "syncedBlock" && node.attrs.id === blockId) target = { pos, node };
  });
  if (!target) return false;
  const current = target as { pos: number; node: PMNode };
  if (current.node.attrs.syncVersion === version && stableStringify(current.node.content.toJSON()) === stableStringify(content)) return false;
  const same = stableStringify(current.node.content.toJSON()) === stableStringify(content);
  const { from, to } = editor.state.selection;
  const inside = from > current.pos && to < current.pos + current.node.nodeSize;
  if (!same && inside && editor.isFocused) {
    publishSyncedConflict({
      server: { version, content: { type: "doc", content } },
      client: { version: Number(current.node.attrs.syncVersion ?? 0), content: { type: "doc", content: current.node.content.toJSON() as RichNode[] } },
    });
    return false;
  }
  const nodes = content.map(node => editor.schema.nodeFromJSON(node));
  const next = current.node.type.create({ ...current.node.attrs, syncVersion: version, syncState: "live" }, Fragment.fromArray(nodes));
  editor.view.dispatch(editor.state.tr.replaceWith(current.pos, current.pos + current.node.nodeSize, next).setMeta("addToHistory", false));
  return true;
}

function freshNode(node: PMNode): PMNode {
  const json = node.toJSON() as RichNode;
  function walk(value: RichNode): RichNode {
    const attrs = { ...value.attrs };
    if (typeof attrs.id === "string") attrs.id = crypto.randomUUID();
    return { ...value, ...(value.attrs ? { attrs } : {}), ...(value.content ? { content: value.content.map(walk) } : {}) };
  }
  return node.type.schema.nodeFromJSON(walk(json));
}

export function unsyncLocal(editor: Editor, blockId: string) {
  if (!editor.isEditable) throw new Error("This page is read only.");
  let target: { pos: number; node: PMNode } | null = null;
  editor.state.doc.descendants((node, pos) => { if (node.type.name === "syncedBlock" && node.attrs.id === blockId) target = { pos, node }; });
  if (!target) throw new Error("Synced block is restricted or unavailable.");
  const current = target as { pos: number; node: PMNode };
  const copies: PMNode[] = [];
  current.node.content.forEach(child => copies.push(freshNode(child)));
  if (!copies.length) throw new Error("Synced block is restricted or unavailable.");
  editor.view.dispatch(editor.state.tr.replaceWith(current.pos, current.pos + current.node.nodeSize, Fragment.fromArray(copies)).scrollIntoView());
}

export function deletePlacementLocal(editor: Editor, blockId: string) {
  if (!editor.isEditable) throw new Error("This page is read only.");
  let target: { pos: number; node: PMNode } | null = null;
  editor.state.doc.descendants((node, pos) => { if (node.type.name === "syncedBlock" && node.attrs.id === blockId) target = { pos, node }; });
  if (!target) return false;
  const current = target as { pos: number; node: PMNode };
  let tr = editor.state.tr.delete(current.pos, current.pos + current.node.nodeSize);
  if (!tr.doc.content.size) tr = tr.insert(0, editor.schema.nodes.paragraph.create());
  editor.view.dispatch(tr.scrollIntoView());
  return true;
}

export function purgeSyncedContent(editor: Editor, blockId: string) {
  let target: { pos: number; node: PMNode } | null = null;
  editor.state.doc.descendants((node, pos) => {
    if (node.type.name === "syncedBlock" && node.attrs.id === blockId) target = { pos, node };
  });
  if (!target) return false;
  const current = target as { pos: number; node: PMNode };
  if (!current.node.content.size && current.node.attrs.syncState === "restricted" && !current.node.attrs.syncedId) return false;
  const next = current.node.type.create({ id: current.node.attrs.id, syncState: "restricted" });
  editor.view.dispatch(editor.state.tr.replaceWith(current.pos, current.pos + current.node.nodeSize, next).setMeta("addToHistory", false));
  return true;
}

export function syncedConflictCopy(details: SyncedConflictDetails) {
  return { message: SYNCED_CONFLICT_MESSAGE, serverText: plainText(details.server.content), clientText: plainText(details.client.content) };
}
