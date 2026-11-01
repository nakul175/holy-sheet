import type { Actor } from "./auth";
import type { Repository } from "./repository";
import { DocumentError } from "./document";
import { formatRecordFieldValue } from "./record-page-refs";
import { standardRecordFields, type RecordField } from "./shared-record-types";
import { workspaceSearch } from "./workspace-search";

const missing = () => new DocumentError("Search scope is unavailable.", "not_found", 404);

export async function searchRecordRefs(repository: Repository, actor: Actor, workspaceId: string, query: string, collection?: string) {
  const collections = await repository.db.transaction(async tx => {
    const member = await tx.query("SELECT 1 FROM hs_members WHERE workspace_id=$1 AND user_id=$2 AND active=true", [workspaceId, actor.id]);
    if (!member.rows.length) throw missing();
    return tx.query<{ id: string; name: string }>(
      `SELECT c.id, c.name FROM hs_data_collections c JOIN hs_data_workspaces w ON w.tenant_id=c.tenant_id
       WHERE w.workspace_id=$1 AND (EXISTS(SELECT 1 FROM hs_data_collection_grants g WHERE g.tenant_id=c.tenant_id AND g.user_id=$2 AND g.collection=c.id AND 'view'=ANY(g.capabilities))
         OR EXISTS(SELECT 1 FROM hs_data_record_grants g JOIN hs_data_records r ON r.tenant_id=g.tenant_id AND r.id=g.record_id WHERE g.tenant_id=c.tenant_id AND g.user_id=$2 AND r.collection=c.id AND 'view'=ANY(g.capabilities)))
       ORDER BY c.name LIMIT 50`,
      [workspaceId, actor.id],
    );
  });
  if (query.trim().length < 2) return { collections: collections.rows, results: [] as RecordPick[] };
  const search = await workspaceSearch(repository, actor, { query, workspaceId, kinds: ["record"], ...(collection ? { collection } : {}) });
  const ids = search.results.map(hit => hit.id.startsWith("record:") ? hit.id.slice(7) : "").filter(id => /^[0-9a-f-]{36}$/i.test(id)).slice(0, 8);
  if (!ids.length) return { collections: collections.rows, results: [] as RecordPick[] };
  const results = await repository.db.transaction(async tx => {
    const rows = await tx.query<{ id: string; name: string; collection: string; collection_name: string; tenant_id: string; field_values: Record<string, unknown> }>(
      `SELECT r.id, r.name, r.collection, c.name AS collection_name, r.tenant_id, r.field_values
       FROM hs_data_records r JOIN hs_data_workspaces w ON w.tenant_id=r.tenant_id AND w.workspace_id=$1
       JOIN hs_data_collections c ON c.tenant_id=r.tenant_id AND c.id=r.collection
       WHERE r.id=ANY($2::uuid[]) AND r.merged_into_id IS NULL AND r.state='active'
         AND (EXISTS(SELECT 1 FROM hs_data_collection_grants g WHERE g.tenant_id=r.tenant_id AND g.user_id=$3 AND g.collection=r.collection AND 'view'=ANY(g.capabilities))
           OR EXISTS(SELECT 1 FROM hs_data_record_grants g WHERE g.tenant_id=r.tenant_id AND g.record_id=r.id AND g.user_id=$3 AND 'view'=ANY(g.capabilities)))`,
      [workspaceId, ids, actor.id],
    );
    const picks: RecordPick[] = [];
    for (const id of ids) {
      const row = rows.rows.find(item => item.id === id);
      if (!row) continue;
      const custom = await tx.query<{ field_key: string; label: string; kind: RecordField["kind"]; sensitive: boolean; required: boolean; choices: string[]; unique_value: boolean; deprecated: boolean; version: number }>(
        "SELECT field_key,label,kind,sensitive,required,choices,unique_value,deprecated,version FROM hs_data_fields WHERE tenant_id=$1 AND collection=$2 ORDER BY field_key",
        [row.tenant_id, row.collection],
      );
      const grants = await tx.query<{ field_key: string }>("SELECT field_key FROM hs_data_field_permissions WHERE tenant_id=$1 AND collection=$2 AND user_id=$3 AND can_view=true", [row.tenant_id, row.collection, actor.id]);
      const allowed = new Set(grants.rows.map(item => item.field_key));
      const fields = [...standardRecordFields(row.collection), ...custom.rows.map(item => ({ key: item.field_key, label: item.label, kind: item.kind, required: item.required, choices: item.choices ?? [], sensitive: item.sensitive, unique: item.unique_value, deprecated: item.deprecated, core: false, version: Number(item.version) }))];
      const values = typeof row.field_values === "string" ? JSON.parse(row.field_values) as Record<string, unknown> : row.field_values ?? {};
      const preview = fields.filter(field => !field.sensitive || allowed.has(field.key)).map(field => ({ label: field.label, value: field.sensitive && !allowed.has(field.key) ? "" : formatRecordFieldValue(values[field.key]) })).filter(field => field.value).slice(0, 2);
      picks.push({ id: row.id, title: row.name, collectionId: row.collection, collectionName: row.collection_name, fields: preview, catalogue: fields.map(field => ({ key: field.key, label: field.label })) });
    }
    return picks;
  });
  return { collections: collections.rows, results };
}

export async function listRecordViews(repository: Repository, actor: Actor, workspaceId: string, collection?: string) {
  return repository.db.transaction(async tx => {
    const member = await tx.query("SELECT 1 FROM hs_members WHERE workspace_id=$1 AND user_id=$2 AND active=true", [workspaceId, actor.id]);
    if (!member.rows.length) throw missing();
    const rows = await tx.query<{ id: string; name: string; collection: string; collection_name: string }>(
      `SELECT v.id, v.name, v.collection, c.name AS collection_name FROM hs_data_views v
       JOIN hs_data_collections c ON c.tenant_id=v.tenant_id AND c.id=v.collection
       WHERE v.workspace_id=$1 AND v.deleted=false AND ($3::text IS NULL OR v.collection=$3) AND (v.scope='workspace' OR v.owner_id=$2)
         AND (EXISTS(SELECT 1 FROM hs_data_collection_grants g WHERE g.tenant_id=v.tenant_id AND g.user_id=$2 AND g.collection=v.collection AND 'view'=ANY(g.capabilities))
           OR EXISTS(SELECT 1 FROM hs_data_record_grants g JOIN hs_data_records r ON r.tenant_id=g.tenant_id AND r.id=g.record_id WHERE g.tenant_id=v.tenant_id AND g.user_id=$2 AND r.collection=v.collection AND 'view'=ANY(g.capabilities)))
       ORDER BY c.name, v.name LIMIT 50`,
      [workspaceId, actor.id, collection ?? null],
    );
    return { views: rows.rows };
  });
}

export type RecordPick = { id: string; title: string; collectionId: string; collectionName: string; fields: { label: string; value: string }[]; catalogue: { key: string; label: string }[] };
