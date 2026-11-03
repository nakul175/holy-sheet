export const dependencyKinds = ["link", "template", "snippet", "synced-source"] as const;
export type DependencyKind = (typeof dependencyKinds)[number];
export type SourceState = "active" | "retired" | "merged";
export type StoredReview = "current" | "needs_review" | "acknowledged";
export type ShownReview = StoredReview | "stale";

export const dependencyPageBound = 50;
export const unrelatedMetadataRule = "unrelated-metadata-does-not-mark-review";
export const unrelatedMetadataStatement = "An edit to unrelated metadata does not mark dependents Needs review.";

const labels: Record<DependencyKind, string> = {
  link: "Explicit link",
  template: "Template",
  snippet: "Snippet",
  "synced-source": "Synced source",
};

export function kindLabel(kind: DependencyKind) {
  return labels[kind];
}

export function isDependencyKind(value: string): value is DependencyKind {
  return (dependencyKinds as readonly string[]).includes(value);
}

/** Title, note, reviewer, and other non-content edits do not mark dependents. */
export function classifySourceEdit(storedDigest: string, nextDigest: string) {
  if (storedDigest === nextDigest) return { effect: "metadata" as const, rule: unrelatedMetadataRule, marksReview: false };
  return { effect: "needs-review" as const, rule: "source-material-changed" as const, marksReview: true };
}

export function effectiveReview(input: {
  reviewState: StoredReview;
  sourceRevision: number;
  acknowledgedSourceRevision: number | null;
  acknowledgedDependentRevision: number | null;
  liveDependentRevision: number;
}): ShownReview {
  if (input.reviewState === "needs_review") return "needs_review";
  if (input.reviewState !== "acknowledged") return "current";
  if (input.acknowledgedSourceRevision !== input.sourceRevision || input.acknowledgedDependentRevision !== input.liveDependentRevision) return "stale";
  return "acknowledged";
}

export type PlanEdge = {
  id: string;
  kind: DependencyKind;
  sourceId: string;
  dependentPageId: string;
  sourceState: SourceState;
  permitted: boolean;
};

export type PlanSource = { state: SourceState; mergedIntoId: string | null };

export function traverseDependencies(input: {
  start: { type: "source" | "page"; id: string };
  edges: PlanEdge[];
  sources: Record<string, PlanSource>;
  limit: number;
}) {
  const limit = Math.min(dependencyPageBound, Math.max(1, Math.floor(input.limit)));
  const visible = input.edges.filter(edge => edge.permitted);
  const queue: { type: "source" | "page"; id: string }[] = [input.start];
  const seen = new Set<string>();
  const pages: string[] = [];
  const edges: (PlanEdge & { cycle: boolean; sourceState: SourceState })[] = [];
  let truncated = false;

  function addPage(id: string) {
    if (pages.includes(id)) return true;
    if (pages.length >= limit) {
      truncated = true;
      return false;
    }
    pages.push(id);
    return true;
  }

  while (queue.length && !truncated) {
    const node = queue.shift()!;
    const key = `${node.type}:${node.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const outgoing = visible.filter(edge => edge.sourceId === node.id);
    const recorded = input.sources[node.id];
    const sourceState = recorded?.state ?? outgoing[0]?.sourceState ?? "active";
    if (node.type === "source" && sourceState === "merged" && recorded?.mergedIntoId) {
      const successor = `source:${recorded.mergedIntoId}`;
      if (!seen.has(successor)) queue.push({ type: "source", id: recorded.mergedIntoId });
    }
    if (node.type === "source" && sourceState === "retired") {
      for (const edge of outgoing) {
        if (!addPage(edge.dependentPageId)) break;
        edges.push({ ...edge, cycle: false, sourceState: "retired" });
      }
      continue;
    }
    for (const edge of outgoing) {
      const cycle = seen.has(`page:${edge.dependentPageId}`) || seen.has(`source:${edge.dependentPageId}`);
      if (!cycle && !addPage(edge.dependentPageId)) break;
      if (cycle) addPage(edge.dependentPageId);
      edges.push({ ...edge, cycle, sourceState: input.sources[edge.sourceId]?.state ?? edge.sourceState });
      if (!cycle && (input.sources[edge.sourceId]?.state ?? edge.sourceState) !== "retired") queue.push({ type: "page", id: edge.dependentPageId });
    }
  }

  return { pages, edges, truncated };
}

export function impactReport(items: { kind: DependencyKind; sourceTitle: string; sourceRevision: number; dependentTitle: string; reviewLabel: string; reason: string; sourceState: SourceState }[]) {
  const lines = ["# Dependency impact", ""];
  if (!items.length) lines.push("No permitted dependents.");
  for (const item of items) {
    const reason = item.reason ? ` · ${item.reason}` : "";
    lines.push(`- ${kindLabel(item.kind)} · ${item.sourceTitle} · revision ${item.sourceRevision} · ${item.dependentTitle} · ${item.reviewLabel}${reason} · ${item.sourceState}`);
  }
  return lines.join("\n");
}
