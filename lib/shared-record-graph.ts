import type { Sql } from "./database";
import { DocumentError } from "./document";
import type { RecordGraph, RecordGraphEdge, RecordGraphNode } from "./record-graph-contract";
import { SharedRecordRepository, type RecordContext, type Stored } from "./shared-records";
import type { RecordField } from "./shared-record-types";

const nodeLimit = 80;
const scanLimit = 400;
const relationshipKinds = new Set(["contact-account", "employee-account", "contract-legal-party", "contract-account"]);

type RelationshipRow = {
  id: string;
  kind: string;
  role: string;
  is_primary: boolean;
  status: string;
  source_id: string;
  target_id: string;
};

function visibleSql(alias: string, actor: string) {
  return `(EXISTS (SELECT 1 FROM hs_data_collection_grants g WHERE g.tenant_id=${alias}.tenant_id AND g.user_id=${actor} AND g.collection=${alias}.collection AND 'view'=ANY(g.capabilities)) OR EXISTS (SELECT 1 FROM hs_data_record_grants g WHERE g.tenant_id=${alias}.tenant_id AND g.record_id=${alias}.id AND g.user_id=${actor} AND 'view'=ANY(g.capabilities)))`;
}

function recordNode(record: Stored): RecordGraphNode {
  return { id: record.id, kind: "record", label: record.name, state: record.state === "archived" ? "archived" : "active", collection: record.collection };
}

function idsOf(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

/**
 * One-hop graph of the records, record fields, organisation parents and documents
 * already stored for a record. Hidden endpoints are omitted entirely.
 */
export class SharedRecordGraphRepository extends SharedRecordRepository {
  async graph(ctx: RecordContext, recordId: string): Promise<RecordGraph> {
    return this.transaction(ctx, async (tx) => {
      const focal = await this.raw(tx, ctx, recordId, "view");
      const nodes = new Map<string, RecordGraphNode>();
      const edges = new Map<string, RecordGraphEdge>();
      let limited = false;
      const addNode = (node: RecordGraphNode) => {
        if (nodes.has(node.id)) return true;
        if (nodes.size >= nodeLimit) {
          limited = true;
          return false;
        }
        nodes.set(node.id, node);
        return true;
      };
      addNode(recordNode(focal));
      await this.relationships(tx, ctx, focal, addNode, edges);
      await this.parents(tx, ctx, focal, addNode, edges);
      await this.linkedFields(tx, ctx, focal, addNode, edges);
      await this.documents(tx, ctx, focal, addNode, edges);
      const ordered = [...nodes.values()].filter((node) => node.id !== focal.id).sort((a, b) => a.label.localeCompare(b.label) || a.id.localeCompare(b.id));
      return { focalId: focal.id, nodes: [recordNode(focal), ...ordered], edges: [...edges.values()].sort((a, b) => a.id.localeCompare(b.id)), limited };
    });
  }

  private async visible(tx: Sql, ctx: RecordContext, recordId: string) {
    try {
      return await this.raw(tx, ctx, recordId, "view");
    } catch (error) {
      if (error instanceof DocumentError && (error.status === 403 || error.status === 404)) return null;
      throw error;
    }
  }

  private async recordFields(tx: Sql, ctx: RecordContext, collection: string) {
    const rows = await tx.query<{ field_key: string; label: string; sensitive: boolean }>(
      "SELECT field_key,label,sensitive FROM hs_data_fields WHERE tenant_id=$1 AND collection=$2 AND kind='record' AND deprecated=false ORDER BY field_key",
      [ctx.tenantId, collection],
    );
    return rows.rows.map((row): RecordField => ({
      key: row.field_key,
      label: row.label,
      kind: "record",
      sensitive: row.sensitive,
      required: false,
      choices: [],
      unique: false,
      deprecated: false,
      core: false,
      version: 1,
    }));
  }

  private async relationships(tx: Sql, ctx: RecordContext, focal: Stored, addNode: (node: RecordGraphNode) => boolean, edges: Map<string, RecordGraphEdge>) {
    const view = visibleSql("other", "$3");
    const rows = await tx.query<RelationshipRow>(
      `SELECT e.id,e.kind,e.role,e.is_primary,e.status,e.source_id,e.target_id FROM hs_data_relationships e JOIN hs_data_records other ON other.tenant_id=e.tenant_id AND other.id=e.target_id WHERE e.tenant_id=$1 AND e.source_id=$2 AND other.state<>'trashed' AND ${view}
       UNION ALL
       SELECT e.id,e.kind,e.role,e.is_primary,e.status,e.source_id,e.target_id FROM hs_data_relationships e JOIN hs_data_records other ON other.tenant_id=e.tenant_id AND other.id=e.source_id WHERE e.tenant_id=$1 AND e.target_id=$2 AND other.state<>'trashed' AND ${view}
       ORDER BY id LIMIT $4`,
      [ctx.tenantId, focal.id, ctx.actor.id, scanLimit],
    );
    for (const edge of rows.rows) {
      if (!relationshipKinds.has(edge.kind) || (edge.status !== "active" && edge.status !== "inactive")) continue;
      const source = edge.source_id === focal.id ? focal : await this.visible(tx, ctx, edge.source_id);
      const target = edge.target_id === focal.id ? focal : await this.visible(tx, ctx, edge.target_id);
      if (!source || !target || source.id === target.id) continue;
      if (!addNode(recordNode(source)) || !addNode(recordNode(target))) continue;
      const role = edge.role.trim();
      edges.set(edge.id, {
        id: edge.id,
        kind: edge.kind,
        fromId: source.id,
        toId: target.id,
        ...(role ? { role } : {}),
        ...(edge.is_primary ? { primary: true } : {}),
        status: edge.status,
      });
    }
  }

  private async parents(tx: Sql, ctx: RecordContext, focal: Stored, addNode: (node: RecordGraphNode) => boolean, edges: Map<string, RecordGraphEdge>) {
    if (focal.parent_organisation_id) {
      const parent = await this.visible(tx, ctx, focal.parent_organisation_id);
      if (parent && parent.id !== focal.id && addNode(recordNode(parent))) {
        edges.set(`parent-organisation:${focal.id}`, { id: `parent-organisation:${focal.id}`, kind: "parent-organisation", fromId: focal.id, toId: parent.id });
      }
    }
    const children = await tx.query<{ id: string }>(
      `SELECT id FROM hs_data_records child WHERE tenant_id=$1 AND parent_organisation_id=$2 AND state<>'trashed' AND ${visibleSql("child", "$3")} ORDER BY id LIMIT $4`,
      [ctx.tenantId, focal.id, ctx.actor.id, scanLimit],
    );
    for (const row of children.rows) {
      const child = await this.visible(tx, ctx, row.id);
      if (!child || child.id === focal.id || !addNode(recordNode(child))) continue;
      edges.set(`parent-organisation:${child.id}`, { id: `parent-organisation:${child.id}`, kind: "parent-organisation", fromId: child.id, toId: focal.id });
    }
  }

  private async linkedFields(tx: Sql, ctx: RecordContext, focal: Stored, addNode: (node: RecordGraphNode) => boolean, edges: Map<string, RecordGraphEdge>) {
    for (const field of await this.recordFields(tx, ctx, focal.collection)) {
      if (!(await this.fieldAllowed(tx, ctx, focal.collection, field, "view"))) continue;
      for (const targetId of idsOf(focal.field_values[field.key])) {
        const target = await this.visible(tx, ctx, targetId);
        if (!target || target.id === focal.id || !addNode(recordNode(target))) continue;
        const id = `record-field:${focal.id}:${field.key}:${target.id}`;
        edges.set(id, { id, kind: "record-field", fromId: focal.id, toId: target.id, fieldKey: field.key, fieldLabel: field.label });
      }
    }
    const incoming = await tx.query<{ id: string }>(
      `SELECT DISTINCT r.id FROM hs_data_records r JOIN hs_data_fields f ON f.tenant_id=r.tenant_id AND f.collection=r.collection AND f.kind='record' AND f.deprecated=false
       WHERE r.tenant_id=$1 AND r.id<>$2 AND r.state<>'trashed' AND ${visibleSql("r", "$3")} AND (r.field_values->f.field_key) @> to_jsonb(ARRAY[$2::text])
       ORDER BY r.id LIMIT $4`,
      [ctx.tenantId, focal.id, ctx.actor.id, scanLimit],
    );
    for (const row of incoming.rows) {
      const source = await this.visible(tx, ctx, row.id);
      if (!source || source.id === focal.id) continue;
      const pending: RecordGraphEdge[] = [];
      for (const field of await this.recordFields(tx, ctx, source.collection)) {
        if (!(await this.fieldAllowed(tx, ctx, source.collection, field, "view"))) continue;
        if (!idsOf(source.field_values[field.key]).includes(focal.id)) continue;
        const id = `record-field:${source.id}:${field.key}:${focal.id}`;
        pending.push({ id, kind: "record-field", fromId: source.id, toId: focal.id, fieldKey: field.key, fieldLabel: field.label });
      }
      if (!pending.length || !addNode(recordNode(source))) continue;
      for (const edge of pending) edges.set(edge.id, edge);
    }
  }

  private async documents(tx: Sql, ctx: RecordContext, focal: Stored, addNode: (node: RecordGraphNode) => boolean, edges: Map<string, RecordGraphEdge>) {
    const links = await tx.query<{ id: string; page_id: string | null }>("SELECT id,page_id FROM hs_data_documents WHERE tenant_id=$1 AND record_id=$2 ORDER BY id LIMIT $3", [ctx.tenantId, focal.id, scanLimit]);
    for (const link of links.rows) {
      if (!link.page_id) continue;
      try {
        const page = await this.pages.get(link.page_id, ctx.actor, tx);
        const bound = await tx.query("SELECT workspace_id FROM hs_data_workspaces WHERE workspace_id=$1 AND tenant_id=$2", [page.workspaceId, ctx.tenantId]);
        if (!bound.rows.length || !page.title.trim()) continue;
        const node: RecordGraphNode = { id: link.id, kind: "document", label: page.title, pageId: page.id };
        if (!addNode(node)) continue;
        edges.set(`document:${link.id}`, { id: `document:${link.id}`, kind: "document", fromId: focal.id, toId: link.id });
      } catch (error) {
        if (!(error instanceof DocumentError && (error.status === 403 || error.status === 404))) throw error;
      }
    }
  }
}
