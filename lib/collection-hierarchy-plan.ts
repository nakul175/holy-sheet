import { DocumentError } from "./document";

export const hierarchyLimits = { depth: 20, siblings: 50, preview: 50 } as const;
export const hierarchyBoundary = "No generative model. Hierarchy is an optional structure inside one custom collection.";
export const hierarchyAssignment = "Enabling hierarchy or choosing a parent does not grant access, and it does not replace the Account to Organisation relationship.";
export const hierarchyReview = "Descendants stay in place with their own permissions. This does not archive or delete them.";

export type HierarchyNode = { id: string; parentId: string | null };

const parentMessage = "Choose a parent in this collection that does not create a cycle, cross a tenant, or pass the depth limit.";

export function hierarchyDepthLimit(value: number) {
  if (!Number.isInteger(value) || value < 1 || value > hierarchyLimits.depth) {
    throw new DocumentError("Set a hierarchy depth from 1 to 20.", "hierarchy_validation", 422);
  }
  return value;
}

export function assertPlacement(nodes: readonly HierarchyNode[], recordId: string, parentId: string | null, depthLimit: number, allowRoots: boolean) {
  const limit = hierarchyDepthLimit(depthLimit);
  if (!parentId && !allowRoots) throw new DocumentError("This collection does not allow a record without a parent.", "hierarchy_parent", 422);
  if (parentId === recordId) throw new DocumentError(parentMessage, "hierarchy_parent", 422);
  const next = new Map(nodes.map(node => [node.id, node.parentId]));
  if (parentId && !next.has(parentId) && parentId !== recordId) throw new DocumentError(parentMessage, "hierarchy_parent", 422);
  next.set(recordId, parentId);

  const depthOf = (id: string) => {
    let depth = 1;
    let cursor = next.get(id) ?? null;
    const seen = new Set<string>([id]);
    while (cursor) {
      if (seen.has(cursor) || depth >= limit) throw new DocumentError(parentMessage, "hierarchy_parent", 422);
      seen.add(cursor);
      depth += 1;
      cursor = next.get(cursor) ?? null;
    }
    return depth;
  };

  const seen = new Set<string>();
  const stack = [{ id: recordId, rel: 0 }];
  let span = 0;
  while (stack.length) {
    const current = stack.pop()!;
    if (seen.has(current.id)) throw new DocumentError(parentMessage, "hierarchy_parent", 422);
    seen.add(current.id);
    span = Math.max(span, current.rel);
    if (depthOf(recordId) + current.rel > limit) throw new DocumentError(parentMessage, "hierarchy_parent", 422);
    for (const [child, parent] of next) {
      if (parent === current.id) stack.push({ id: child, rel: current.rel + 1 });
    }
  }
  if (depthOf(recordId) + span > limit) throw new DocumentError(parentMessage, "hierarchy_parent", 422);
}

export function visibleAncestry(nodes: readonly HierarchyNode[], id: string, visible: ReadonlySet<string>) {
  const byId = new Map(nodes.map(node => [node.id, node.parentId]));
  const chain: string[] = [];
  let cursor = byId.get(id) ?? null;
  const seen = new Set<string>([id]);
  while (cursor) {
    if (seen.has(cursor) || !visible.has(cursor)) break;
    seen.add(cursor);
    chain.push(cursor);
    cursor = byId.get(cursor) ?? null;
  }
  return chain.reverse();
}

export function subtreeIds(nodes: readonly HierarchyNode[], rootId: string) {
  const children = new Map<string, string[]>();
  for (const node of nodes) {
    if (!node.parentId) continue;
    const list = children.get(node.parentId) ?? [];
    list.push(node.id);
    children.set(node.parentId, list);
  }
  const ids: string[] = [];
  const stack = [rootId];
  const seen = new Set<string>();
  while (stack.length) {
    const current = stack.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    ids.push(current);
    for (const child of children.get(current) ?? []) stack.push(child);
  }
  return ids;
}

export function siblingPage<T>(rows: readonly T[], limit = hierarchyLimits.siblings) {
  return { entries: rows.slice(0, limit), more: rows.length > limit };
}

export function hierarchyDocument(collectionName: string, rows: { name: string; parentName: string | null }[]) {
  const lines = ["# Collection hierarchy", "", `Collection: ${collectionName}`, ""];
  if (!rows.length) lines.push("No visible records.");
  for (const row of rows) lines.push(row.parentName ? `- ${row.name} (parent: ${row.parentName})` : `- ${row.name}`);
  lines.push("", hierarchyAssignment, hierarchyReview);
  return lines.join("\n");
}
