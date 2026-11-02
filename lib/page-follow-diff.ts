import { plainText, stableStringify, type RichNode } from "./document";

export type PageChangeSummary = {
  meaningful: boolean;
  added: number;
  removed: number;
  headings: string[];
  summary: string;
};

function norm(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function asNode(value: unknown): RichNode | null {
  if (!value) return null;
  if (typeof value === "string") {
    try { return JSON.parse(value) as RichNode; } catch { return null; }
  }
  return value as RichNode;
}

function walk(node: RichNode): unknown {
  if (node.type === "text") return ["text", norm(node.text ?? "")];
  return [node.type, node.attrs?.id ?? null, (node.content ?? []).map(walk)];
}

function fingerprint(doc: RichNode | null, title: string) {
  return stableStringify({ title: norm(title), doc: doc ? walk(doc) : null });
}

function topBlocks(doc: RichNode | null) {
  return (doc?.content ?? []).map((node, index) => ({ id: String(node.attrs?.id ?? `${node.type}:${index}`) }));
}

function headings(doc: RichNode | null) {
  const found: { id: string; text: string }[] = [];
  const visit = (node: RichNode) => {
    if (node.type === "heading") found.push({ id: String(node.attrs?.id ?? `h:${found.length}`), text: norm(plainText(node)) });
    for (const child of node.content ?? []) visit(child);
  };
  if (doc) visit(doc);
  return found;
}

/** Net change between two saved pages. Whitespace-only text and title edits are not meaningful. */
export function summarizePageChange(beforeDoc: unknown, beforeTitle: string, afterDoc: unknown, afterTitle: string): PageChangeSummary {
  const before = asNode(beforeDoc);
  const after = asNode(afterDoc);
  const meaningful = fingerprint(before, beforeTitle) !== fingerprint(after, afterTitle);
  const left = topBlocks(before);
  const right = topBlocks(after);
  const leftIds = new Set(left.map(block => block.id));
  const rightIds = new Set(right.map(block => block.id));
  let added = 0;
  let removed = 0;
  for (const id of rightIds) if (!leftIds.has(id)) added += 1;
  for (const id of leftIds) if (!rightIds.has(id)) removed += 1;
  const beforeHeadings = new Map(headings(before).map(item => [item.id, item.text]));
  const afterHeadings = headings(after);
  const afterIds = new Set(afterHeadings.map(item => item.id));
  const changed: string[] = [];
  for (const heading of afterHeadings) {
    if (beforeHeadings.get(heading.id) !== heading.text && heading.text) changed.push(heading.text);
  }
  for (const [id, text] of beforeHeadings) {
    if (!afterIds.has(id) && text && !changed.includes(text)) changed.push(text);
  }
  const parts: string[] = [];
  if (added || removed) parts.push(`+${added} / -${removed} blocks`);
  if (changed.length) parts.push(`Headings changed: ${changed.join(", ")}`);
  if (norm(beforeTitle) !== norm(afterTitle)) parts.push("Title changed");
  if (meaningful && !parts.length) parts.push("Text updated");
  return { meaningful, added, removed, headings: changed, summary: meaningful ? parts.join(". ") : "" };
}
