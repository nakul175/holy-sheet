import { DocumentError } from "./document";

export const classificationLimits = { label: 80, code: 32, tags: 100, depth: 6, references: 200, collections: 40, taxonomy: 500 } as const;
export const classificationBoundary = "No generative model. Classification tags are controlled metadata.";
export const classificationAssignment = "Defining or assigning a tag does not grant access to a page, record, or field.";
export const classificationReview = "These are the references you can see. Confirming remaps the tag in one save.";

export type TagStatus = "active" | "deprecated" | "merged" | "removed";
export type Handling = "metadata" | "restrict";
export type HierarchyTag = { id: string; parentId: string | null };
export type FacetTarget = { id: string; visible: boolean };

const control = /[\p{Cc}]/u;

export function classificationCode(value: string) {
  const code = value.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9-]{0,31}$/.test(code)) throw new DocumentError("Enter a stable tag code using letters, numbers, and hyphens.", "classification_code", 422);
  return code;
}

export function classificationLabel(value: string) {
  const label = value.trim().normalize("NFC");
  if (!label || Array.from(label).length > classificationLimits.label || control.test(label)) throw new DocumentError("Enter a tag label of 1–80 characters.", "classification_validation", 422);
  return label;
}

export function classificationScope(documents: boolean, collections: string[], known: ReadonlySet<string>) {
  if (!Array.isArray(collections) || collections.length > classificationLimits.collections) throw new DocumentError("Check the collections this tag may classify.", "classification_scope", 422);
  const next: string[] = [];
  for (const id of collections) {
    const collection = typeof id === "string" ? id.trim() : "";
    if (!collection || !known.has(collection) || next.includes(collection)) throw new DocumentError("Check the collections this tag may classify.", "classification_scope", 422);
    next.push(collection);
  }
  next.sort();
  return { documents: documents === true, collections: next };
}

export function assertHierarchy(tags: readonly HierarchyTag[], id: string, parentId: string | null) {
  if (!parentId) return;
  if (parentId === id) throw new DocumentError("Choose a parent that does not create a cycle.", "classification_hierarchy", 422);
  const byId = new Map(tags.map(tag => [tag.id, tag]));
  if (!byId.has(parentId)) throw new DocumentError("Choose a parent that does not create a cycle.", "classification_hierarchy", 422);
  let cursor: string | null = parentId;
  let depth = 1;
  const seen = new Set<string>([id]);
  while (cursor) {
    if (seen.has(cursor) || depth > classificationLimits.depth) throw new DocumentError("Choose a parent that does not create a cycle.", "classification_hierarchy", 422);
    seen.add(cursor);
    cursor = byId.get(cursor)?.parentId ?? null;
    depth += 1;
  }
}

export function tagSelectable(status: TagStatus, documents: boolean, collections: readonly string[], target: { kind: "page" } | { kind: "record"; collection: string }) {
  if (status !== "active") return false;
  return target.kind === "page" ? documents : collections.includes(target.collection);
}

export function nextMembership(stored: readonly string[], submitted: readonly string[], visible: ReadonlySet<string>, assignable: ReadonlySet<string>) {
  if (submitted.length > classificationLimits.tags) return { ok: false as const, reason: "limit" as const };
  const seen = new Set<string>();
  for (const id of submitted) {
    if (seen.has(id)) return { ok: false as const, reason: "duplicate" as const };
    seen.add(id);
    if (!visible.has(id)) return { ok: false as const, reason: "hidden" as const };
    if (!stored.includes(id) && !assignable.has(id)) return { ok: false as const, reason: "unassignable" as const };
  }
  const next = stored.filter(id => !visible.has(id));
  for (const id of submitted) next.push(id);
  return {
    ok: true as const,
    next,
    added: submitted.filter(id => !stored.includes(id)),
    removed: stored.filter(id => visible.has(id) && !seen.has(id)),
  };
}

export function facetCounts(rows: { tagId: string; code: string; label: string; tagVisible: boolean; targets: FacetTarget[] }[]) {
  return rows.flatMap(row => {
    if (!row.tagVisible) return [];
    const count = row.targets.filter(target => target.visible).length;
    if (!count) return [];
    return [{ tagId: row.tagId, code: row.code, label: row.label, count }];
  });
}

export function remapAssignments(rows: { tagId: string; targetKind: string; targetId: string }[], fromId: string, intoId: string | null) {
  const next: { tagId: string; targetKind: string; targetId: string }[] = [];
  const occupied = new Set<string>();
  for (const row of rows) {
    if (row.tagId === fromId) continue;
    next.push(row);
    occupied.add(`${row.targetKind}:${row.targetId}:${row.tagId}`);
  }
  const changed: { targetKind: string; targetId: string }[] = [];
  for (const row of rows) {
    if (row.tagId !== fromId) continue;
    changed.push({ targetKind: row.targetKind, targetId: row.targetId });
    if (!intoId) continue;
    const key = `${row.targetKind}:${row.targetId}:${intoId}`;
    if (occupied.has(key)) continue;
    occupied.add(key);
    next.push({ tagId: intoId, targetKind: row.targetKind, targetId: row.targetId });
  }
  return { next, changed };
}

export function classificationDocument(target: { kind: "page" | "record"; title: string }, tags: { code: string; label: string; status: TagStatus }[]) {
  const lines = ["# Classification", "", `${target.kind === "page" ? "Page" : "Record"}: ${target.title}`, ""];
  if (!tags.length) lines.push("No visible tags.");
  for (const tag of tags) lines.push(`- ${tag.code} — ${tag.label}${tag.status === "deprecated" ? " (deprecated)" : ""}`);
  lines.push("", classificationAssignment);
  return lines.join("\n");
}
