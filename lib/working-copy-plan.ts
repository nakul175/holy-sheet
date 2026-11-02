import { plainText, type RichNode } from "./document";

export type WorkingChoice = "original" | "copy";
export type BlockLink = { sourceId: string; copyId: string };
export type HiddenField = { blockId: string; keys: string[] };
export type WorkingConflict = {
  key: string;
  kind: "title" | "edit" | "delete" | "order";
  label: string;
  base: string;
  original: string;
  copy: string;
};

const RESTRICTED = "Restricted content";

export function forkDocument(document: RichNode) {
  const blockMap: BlockLink[] = [];
  function walk(node: RichNode): RichNode {
    const next: RichNode = { type: node.type };
    if (node.text !== undefined) next.text = node.text;
    if (node.marks) next.marks = structuredClone(node.marks);
    if (node.attrs) {
      const attrs = { ...node.attrs };
      if (typeof attrs.id === "string") {
        const copyId = crypto.randomUUID();
        blockMap.push({ sourceId: attrs.id, copyId });
        attrs.id = copyId;
      }
      delete attrs.syncedId;
      delete attrs.snippetId;
      delete attrs.pinVersion;
      delete attrs.syncVersion;
      delete attrs.syncState;
      delete attrs.syncLocked;
      delete attrs.syncUndo;
      next.attrs = attrs;
    }
    if (node.content) next.content = node.content.map(walk);
    return next;
  }
  return { document: walk(structuredClone(document)), blockMap };
}

export function redactTopLevel(document: RichNode, blocked: Set<string>, hidden: Map<string, string[]>) {
  const redacted = new Set<string>();
  const content = (document.content ?? []).map(node => {
    const id = blockId(node);
    if (containsBlocked(node, blocked)) {
      if (id) redacted.add(id);
      return { type: "paragraph", attrs: { id: id || crypto.randomUUID() }, content: [{ type: "text", text: RESTRICTED }] } satisfies RichNode;
    }
    return stripHidden(node, hidden);
  });
  return { document: { type: "doc", content } satisfies RichNode, redacted: [...redacted] };
}

export function mergeWorkingCopy(input: {
  baseTitle: string;
  base: RichNode;
  originalTitle: string;
  original: RichNode;
  originalRaw: RichNode;
  copyTitle: string;
  copy: RichNode;
  blockMap: BlockLink[];
  mediaMap: BlockLink[];
  redacted: string[];
  hiddenFields: HiddenField[];
  choices: Record<string, WorkingChoice>;
}) {
  const copyToSource = new Map(input.blockMap.map(link => [link.copyId, link.sourceId]));
  const copyMedia = new Map(input.mediaMap.map(link => [link.copyId, link.sourceId]));
  const redacted = new Set(input.redacted);
  const hidden = new Map(input.hiddenFields.map(field => [field.blockId, field.keys]));
  const baseTops = tops(input.base);
  const originalTops = tops(input.original);
  const rawTops = tops(input.originalRaw);
  const copyTops = tops(mapAttachments(input.copy, copyMedia)).map(item => ({
    id: copyToSource.get(item.id) ?? `added:${item.id}`,
    node: restoreIds(item.node, copyToSource),
  }));
  const base = new Map(baseTops.map(item => [item.id, item.node]));
  const original = new Map(originalTops.map(item => [item.id, item.node]));
  const raw = new Map(rawTops.map(item => [item.id, item.node]));
  const copy = new Map(copyTops.map(item => [item.id, item.node]));
  const conflicts: WorkingConflict[] = [];
  if (input.baseTitle !== input.originalTitle && input.baseTitle !== input.copyTitle && input.originalTitle !== input.copyTitle) {
    conflicts.push({ key: "title", kind: "title", label: "Title", base: clip(input.baseTitle), original: clip(input.originalTitle), copy: clip(input.copyTitle) });
  }
  for (const id of base.keys()) {
    if (redacted.has(id)) continue;
    const decision = classify(base.get(id) ?? null, original.get(id) ?? null, copy.get(id) ?? null);
    if (decision === "conflict-edit") conflicts.push(conflict(id, "edit", base.get(id) ?? null, original.get(id) ?? null, copy.get(id) ?? null));
    if (decision === "conflict-delete") conflicts.push(conflict(id, "delete", base.get(id) ?? null, original.get(id) ?? null, copy.get(id) ?? null));
  }
  const baseOrder = [...base.keys()].filter(id => !redacted.has(id));
  const originalOrder = originalTops.map(item => item.id).filter(id => base.has(id) && !redacted.has(id));
  const copyOrder = copyTops.map(item => item.id).filter(id => base.has(id) && !redacted.has(id));
  if (moved(baseOrder, originalOrder) && moved(baseOrder, copyOrder) && originalOrder.join("\0") !== copyOrder.join("\0")) {
    conflicts.push({ key: "order", kind: "order", label: "Block order", base: "Original order", original: "Order on the original", copy: "Order on the working copy" });
  }
  const unresolved = conflicts.filter(item => input.choices[item.key] !== "original" && input.choices[item.key] !== "copy").map(item => item.key);
  if (unresolved.length) return { conflicts, unresolved, preservedRestricted: redacted.size, title: null, document: null };
  const title = input.choices.title === "copy" || (input.choices.title !== "original" && input.baseTitle === input.originalTitle && input.baseTitle !== input.copyTitle)
    ? input.copyTitle
    : input.originalTitle;
  const useCopyOrder = input.choices.order === "copy" || (input.choices.order !== "original" && !moved(baseOrder, originalOrder) && moved(baseOrder, copyOrder));
  const spine = useCopyOrder ? copyTops.map(item => item.id) : originalTops.map(item => item.id);
  const seen = new Set<string>();
  const content: RichNode[] = [];
  for (const id of spine) {
    if (seen.has(id) || id.startsWith("added:")) {
      if (id.startsWith("added:") && !seen.has(id)) content.push(copy.get(id)!);
      seen.add(id);
      continue;
    }
    seen.add(id);
    const chosen = choose(id, base, original, copy, redacted, input.choices);
    if (chosen === "delete") continue;
    const node = chosen === "copy" ? preserveHidden(copy.get(id)!, raw.get(id), hidden) : raw.get(id) ?? original.get(id);
    if (node) content.push(structuredClone(node));
  }
  for (const item of copyTops) {
    if (!item.id.startsWith("added:") || seen.has(item.id)) continue;
    content.push(item.node);
  }
  for (const item of rawTops) {
    if (!redacted.has(item.id) || seen.has(item.id)) continue;
    content.push(structuredClone(item.node));
  }
  if (!content.length) content.push({ type: "paragraph", attrs: { id: crypto.randomUUID() } });
  return { conflicts, unresolved: [], preservedRestricted: redacted.size, title, document: { type: "doc", content } satisfies RichNode };
}

function choose(id: string, base: Map<string, RichNode>, original: Map<string, RichNode>, copy: Map<string, RichNode>, redacted: Set<string>, choices: Record<string, WorkingChoice>) {
  if (redacted.has(id)) return original.has(id) ? "original" : "delete";
  const picked = choices[id];
  if (picked === "copy") return copy.has(id) ? "copy" : "delete";
  if (picked === "original") return original.has(id) ? "original" : "delete";
  const kind = classify(base.get(id) ?? null, original.get(id) ?? null, copy.get(id) ?? null);
  if (kind === "copy") return copy.has(id) ? "copy" : "delete";
  if (kind === "delete-copy") return "delete";
  return original.has(id) ? "original" : "delete";
}

function classify(base: RichNode | null, original: RichNode | null, copy: RichNode | null) {
  const originalChanged = !same(base, original);
  const copyChanged = !same(base, copy);
  if (!originalChanged && !copyChanged) return "same";
  if (originalChanged && !copyChanged) return original ? "original" : "delete-original";
  if (!originalChanged && copyChanged) return copy ? "copy" : "delete-copy";
  if (same(original, copy)) return original ? "original" : "delete-original";
  if (!original || !copy) return "conflict-delete";
  return "conflict-edit";
}

function conflict(id: string, kind: "edit" | "delete", base: RichNode | null, original: RichNode | null, copy: RichNode | null): WorkingConflict {
  return { key: id, kind, label: clip(preview(base) || "Block"), base: preview(base), original: preview(original), copy: preview(copy) };
}

function tops(document: RichNode) {
  return (document.content ?? []).flatMap(node => {
    const id = blockId(node);
    return id ? [{ id, node }] : [];
  });
}

function blockId(node: RichNode) {
  return typeof node.attrs?.id === "string" ? node.attrs.id : "";
}

function containsBlocked(node: RichNode, blocked: Set<string>): boolean {
  const id = blockId(node);
  if (id && blocked.has(id)) return true;
  return (node.content ?? []).some(child => containsBlocked(child, blocked));
}

function stripHidden(node: RichNode, hidden: Map<string, string[]>): RichNode {
  const id = blockId(node);
  const keys = id ? hidden.get(id) ?? [] : [];
  let next = node;
  if (keys.length && node.attrs && (node.type === "recordRef" || node.type === "recordView")) {
    const attr = node.type === "recordRef" ? "fields" : "columns";
    const values = Array.isArray(node.attrs[attr]) ? (node.attrs[attr] as string[]).filter(key => !keys.includes(key)) : [];
    next = { ...node, attrs: { ...node.attrs, [attr]: values } };
  }
  if (!next.content) return next;
  return { ...next, content: next.content.map(child => stripHidden(child, hidden)) };
}

function preserveHidden(node: RichNode, raw: RichNode | undefined, hidden: Map<string, string[]>): RichNode {
  const id = blockId(node);
  const keys = hidden.get(id) ?? [];
  let next = node;
  if (raw && keys.length && node.attrs && raw.attrs && node.type === raw.type && (node.type === "recordRef" || node.type === "recordView")) {
    const attr = node.type === "recordRef" ? "fields" : "columns";
    const current = Array.isArray(node.attrs[attr]) ? [...(node.attrs[attr] as string[])] : [];
    const prior = Array.isArray(raw.attrs[attr]) ? (raw.attrs[attr] as string[]) : [];
    for (const key of prior) if (keys.includes(key) && !current.includes(key)) current.push(key);
    next = { ...node, attrs: { ...node.attrs, [attr]: current } };
  }
  if (!next.content) return next;
  const rawChildren = new Map((raw?.content ?? []).map(child => [blockId(child), child]));
  return { ...next, content: next.content.map(child => preserveHidden(child, rawChildren.get(blockId(child)), hidden)) };
}

function mapAttachments(node: RichNode, media: Map<string, string>): RichNode {
  const attrs = node.attrs ? { ...node.attrs } : undefined;
  if (attrs && typeof attrs.attachmentId === "string" && media.has(attrs.attachmentId)) attrs.attachmentId = media.get(attrs.attachmentId)!;
  return { ...node, ...(attrs ? { attrs } : {}), ...(node.content ? { content: node.content.map(child => mapAttachments(child, media)) } : {}) };
}

function restoreIds(node: RichNode, copyToSource: Map<string, string>): RichNode {
  const attrs = node.attrs ? { ...node.attrs } : undefined;
  if (attrs && typeof attrs.id === "string") attrs.id = copyToSource.get(attrs.id) ?? crypto.randomUUID();
  return { ...node, ...(attrs ? { attrs } : {}), ...(node.content ? { content: node.content.map(child => restoreIds(child, copyToSource)) } : {}) };
}

function comparable(node: RichNode | null): unknown {
  if (!node) return null;
  const attrs = { ...(node.attrs ?? {}) };
  delete attrs.id;
  delete attrs.syncedId;
  delete attrs.snippetId;
  delete attrs.pinVersion;
  delete attrs.syncVersion;
  delete attrs.syncState;
  delete attrs.syncLocked;
  delete attrs.syncUndo;
  return {
    type: node.type,
    text: node.text ?? null,
    attrs,
    marks: node.marks ?? null,
    content: (node.content ?? []).map(child => comparable(child)),
  };
}

function same(left: RichNode | null, right: RichNode | null) {
  return JSON.stringify(comparable(left)) === JSON.stringify(comparable(right));
}

function moved(base: string[], next: string[]) {
  return base.join("\0") !== next.join("\0");
}

function preview(node: RichNode | null) {
  if (!node) return "Deleted";
  const text = plainText(node).replace(/\s+/g, " ").trim();
  return clip(text || node.type);
}

function clip(value: string) {
  return value.length > 160 ? `${value.slice(0, 157)}...` : value;
}
