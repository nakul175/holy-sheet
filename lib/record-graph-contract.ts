export type RecordGraphNode = {
  id: string;
  kind: "record" | "document";
  label: string;
  state?: "active" | "archived";
  collection?: string;
  pageId?: string;
};

export type RecordGraphEdge = {
  id: string;
  kind: string;
  fromId: string;
  toId: string;
  role?: string;
  primary?: boolean;
  status?: "active" | "inactive";
  fieldKey?: string;
  fieldLabel?: string;
};

export type RecordGraph = {
  focalId: string;
  nodes: RecordGraphNode[];
  edges: RecordGraphEdge[];
  limited: boolean;
};

const kinds = new Set(["contact-account", "employee-account", "contract-legal-party", "contract-account", "parent-organisation", "record-field", "document"]);

function text(value: unknown, max: number) {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

function node(value: unknown): RecordGraphNode | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const id = text(row.id, 200);
  const label = text(row.label, 240);
  if (!id || !label || (row.kind !== "record" && row.kind !== "document")) return null;
  const collection = row.collection === undefined ? undefined : text(row.collection, 100);
  const pageId = row.pageId === undefined ? undefined : text(row.pageId, 200);
  if (row.collection !== undefined && !collection) return null;
  if (row.pageId !== undefined && !pageId) return null;
  if (row.kind === "record") {
    if ((row.state !== "active" && row.state !== "archived") || !collection) return null;
    return { id, kind: "record", label, state: row.state, collection };
  }
  if (row.state !== undefined || !pageId) return null;
  return { id, kind: "document", label, pageId };
}

function edge(value: unknown): RecordGraphEdge | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const id = text(row.id, 300);
  const fromId = text(row.fromId, 200);
  const toId = text(row.toId, 200);
  if (!id || !fromId || !toId || typeof row.kind !== "string" || !kinds.has(row.kind)) return null;
  const role = row.role === undefined ? undefined : text(row.role, 100);
  const fieldKey = row.fieldKey === undefined ? undefined : text(row.fieldKey, 100);
  const fieldLabel = row.fieldLabel === undefined ? undefined : text(row.fieldLabel, 100);
  if (row.role !== undefined && !role) return null;
  if (row.fieldKey !== undefined && !fieldKey) return null;
  if (row.fieldLabel !== undefined && !fieldLabel) return null;
  if (row.primary !== undefined && typeof row.primary !== "boolean") return null;
  if (row.status !== undefined && row.status !== "active" && row.status !== "inactive") return null;
  if (row.kind === "record-field" && (!fieldKey || !fieldLabel)) return null;
  return {
    id,
    kind: row.kind,
    fromId,
    toId,
    ...(role ? { role } : {}),
    ...(row.primary ? { primary: true } : {}),
    ...(row.status === "active" || row.status === "inactive" ? { status: row.status } : {}),
    ...(fieldKey ? { fieldKey } : {}),
    ...(fieldLabel ? { fieldLabel } : {}),
  };
}

/** Copies only the graph fields the screen is allowed to render. */
export function acceptedRecordGraph(value: unknown): RecordGraph | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const focalId = text(row.focalId, 200);
  if (!focalId || typeof row.limited !== "boolean" || !Array.isArray(row.nodes) || !Array.isArray(row.edges)) return null;
  if (row.nodes.length > 80 || row.edges.length > 400) return null;
  const nodes: RecordGraphNode[] = [];
  for (const item of row.nodes) {
    const parsed = node(item);
    if (!parsed) return null;
    nodes.push(parsed);
  }
  const edges: RecordGraphEdge[] = [];
  const ids = new Set(nodes.map((item) => item.id));
  if (!ids.has(focalId)) return null;
  for (const item of row.edges) {
    const parsed = edge(item);
    if (!parsed || !ids.has(parsed.fromId) || !ids.has(parsed.toId)) return null;
    edges.push(parsed);
  }
  return { focalId, nodes, edges, limited: row.limited };
}
