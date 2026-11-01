import { randomUUID } from "node:crypto";
import type { Actor } from "./auth";
import type { Sql } from "./database";
import { DocumentError, documentBlocks, type RichNode } from "./document";
import { compileRecordView, type RecordViewDefinition } from "./shared-record-view-query";
import { recordHash, standardRecordFields, type RecordField } from "./shared-record-types";
import {
  archivedRecordPlaceholder,
  filterChip,
  formatRecordFieldValue,
  readerSort,
  recordIcon,
  recordPageHref,
  recordRefErrorPlaceholder,
  restrictedRecordPlaceholder,
  type RecordExportSlice,
} from "./record-page-refs";

const denied = () => new DocumentError("Record is restricted or unavailable.", "record_not_found", 404);
const generic = () => new DocumentError("Choose an accessible record in this workspace.", "reference_unavailable", 422);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export type ResolveRecordInput = { recordId: string; collectionId: string; fields: string[] };
export type ResolveViewInput = { viewId: string; collectionId: string; layout: "table" | "list"; columns: string[]; limit: number };
type FieldCell = { key: string; label: string; access: "visible"; value: string } | { key: string; label: string; access: "hidden" };
type VisibleRecord = { status: "visible"; title: string; collectionName: string; icon: string; href: string; updatedAt: string; fields: FieldCell[] };
type VisibleView = {
  status: "visible";
  collectionName: string;
  href: string;
  viewAllLabel: string;
  layout: "table" | "list";
  columns: { key: string; label: string; access: "visible" | "hidden" }[];
  rows: { id: string; href: string; name: string; cells: ({ access: "visible"; value: string } | { access: "hidden" })[] }[];
  countLabel: string;
  emptyLabel: string | null;
  chips: string[];
  updatedAt: string;
};

async function member(tx: Sql, workspaceId: string, actorId: string) {
  const row = await tx.query("SELECT w.id FROM hs_workspaces w JOIN hs_members m ON m.workspace_id=w.id AND m.user_id=$2 AND m.active=true WHERE w.id=$1", [workspaceId, actorId]);
  if (!row.rows.length) throw denied();
}

async function tenantId(tx: Sql, workspaceId: string) {
  const row = await tx.query<{ tenant_id: string }>("SELECT tenant_id FROM hs_data_workspaces WHERE workspace_id=$1", [workspaceId]);
  return row.rows[0]?.tenant_id ?? null;
}

async function fieldsFor(tx: Sql, tenant: string, collection: string) {
  const rows = await tx.query<{ field_key: string; label: string; kind: RecordField["kind"]; required: boolean; choices: string[]; sensitive: boolean; unique_value: boolean; deprecated: boolean; version: number }>(
    "SELECT field_key,label,kind,required,choices,sensitive,unique_value,deprecated,version FROM hs_data_fields WHERE tenant_id=$1 AND collection=$2",
    [tenant, collection],
  );
  const custom = rows.rows.map(row => ({ key: row.field_key, label: row.label, kind: row.kind, required: row.required, choices: row.choices ?? [], sensitive: row.sensitive, unique: row.unique_value, deprecated: row.deprecated, core: false, version: Number(row.version) }));
  return [...standardRecordFields(collection), ...custom];
}

async function viewGrants(tx: Sql, tenant: string, actorId: string, collection: string) {
  const rows = await tx.query<{ field_key: string }>("SELECT field_key FROM hs_data_field_permissions WHERE tenant_id=$1 AND collection=$2 AND user_id=$3 AND can_view=true", [tenant, collection, actorId]);
  return new Set(rows.rows.map(row => row.field_key));
}

function visibleKeys(fields: RecordField[], grants: Set<string>) {
  return new Set(fields.filter(field => !field.sensitive || grants.has(field.key)).map(field => field.key));
}

function targets(document: RichNode) {
  const map = new Map<string, { kind: "record" | "view"; id: string; collection: string }>();
  for (const block of documentBlocks(document)) {
    if (block.type === "recordRef") map.set(block.id, { kind: "record", id: String(block.node.attrs?.recordId ?? ""), collection: String(block.node.attrs?.collectionId ?? "") });
    if (block.type === "recordView") map.set(block.id, { kind: "view", id: String(block.node.attrs?.viewId ?? ""), collection: String(block.node.attrs?.collectionId ?? "") });
  }
  return map;
}

export async function validateRecordPageReferences(tx: Sql, actor: Actor, workspaceId: string, next: RichNode, previous: RichNode) {
  const before = targets(previous);
  const tenant = await tenantId(tx, workspaceId);
  for (const [block, target] of targets(next)) {
    const prior = before.get(block);
    if (prior && prior.kind === target.kind && prior.id === target.id && prior.collection === target.collection) continue;
    const { kind, id, collection } = target;
    if (!tenant || !uuid.test(id)) throw generic();
    if (kind === "record") {
      const row = await tx.query(
        `SELECT 1 FROM hs_data_records r WHERE r.id=$1 AND r.tenant_id=$2 AND r.collection=$3 AND r.merged_into_id IS NULL AND r.state<>'trashed'
         AND (EXISTS(SELECT 1 FROM hs_data_collection_grants g WHERE g.tenant_id=r.tenant_id AND g.user_id=$4 AND g.collection=r.collection AND 'view'=ANY(g.capabilities))
           OR EXISTS(SELECT 1 FROM hs_data_record_grants g WHERE g.tenant_id=r.tenant_id AND g.record_id=r.id AND g.user_id=$4 AND 'view'=ANY(g.capabilities)))`,
        [id, tenant, collection, actor.id],
      );
      if (!row.rows.length) throw generic();
    } else {
      const row = await tx.query(
        `SELECT 1 FROM hs_data_views v WHERE v.id=$1 AND v.tenant_id=$2 AND v.workspace_id=$3 AND v.collection=$4 AND v.deleted=false AND (v.scope='workspace' OR v.owner_id=$5)
         AND (EXISTS(SELECT 1 FROM hs_data_collection_grants g WHERE g.tenant_id=v.tenant_id AND g.user_id=$5 AND g.collection=v.collection AND 'view'=ANY(g.capabilities))
           OR EXISTS(SELECT 1 FROM hs_data_record_grants g JOIN hs_data_records r ON r.tenant_id=g.tenant_id AND r.id=g.record_id WHERE g.tenant_id=v.tenant_id AND g.user_id=$5 AND r.collection=v.collection AND 'view'=ANY(g.capabilities)))`,
        [id, tenant, workspaceId, collection, actor.id],
      );
      if (!row.rows.length) throw generic();
    }
  }
}

type Loaded = { id: string; name: string; collection: string; state: string; field_values: Record<string, unknown>; updated_at: string; collection_name: string; can_restore: boolean };

export async function resolveRecordPageRefs(tx: Sql, actor: Actor, workspaceId: string, input: { records: ResolveRecordInput[]; views: ResolveViewInput[] }) {
  await member(tx, workspaceId, actor.id);
  const tenant = await tenantId(tx, workspaceId);
  const records = [];
  const wanted = input.records.filter(item => uuid.test(item.recordId));
  const loaded = new Map<string, Loaded>();
  if (tenant && wanted.length) {
    const rows = await tx.query<Loaded>(
      `SELECT r.id, CASE WHEN r.state='active' THEN r.name ELSE '' END AS name, r.collection, r.state,
        CASE WHEN r.state='active' THEN r.field_values ELSE '{}'::jsonb END AS field_values, r.updated_at,
        CASE WHEN r.state='active' THEN c.name ELSE '' END AS collection_name,
        (EXISTS(SELECT 1 FROM hs_data_collection_grants g WHERE g.tenant_id=r.tenant_id AND g.user_id=$3 AND g.collection=r.collection AND 'restore'=ANY(g.capabilities))
          OR EXISTS(SELECT 1 FROM hs_data_record_grants g WHERE g.tenant_id=r.tenant_id AND g.record_id=r.id AND g.user_id=$3 AND 'restore'=ANY(g.capabilities))) AS can_restore
       FROM hs_data_records r JOIN hs_data_collections c ON c.tenant_id=r.tenant_id AND c.id=r.collection
       WHERE r.tenant_id=$1 AND r.id=ANY($2::uuid[]) AND r.merged_into_id IS NULL AND r.state<>'trashed'
         AND (EXISTS(SELECT 1 FROM hs_data_collection_grants g WHERE g.tenant_id=r.tenant_id AND g.user_id=$3 AND g.collection=r.collection AND 'view'=ANY(g.capabilities))
           OR EXISTS(SELECT 1 FROM hs_data_record_grants g WHERE g.tenant_id=r.tenant_id AND g.record_id=r.id AND g.user_id=$3 AND 'view'=ANY(g.capabilities)))`,
      [tenant, wanted.map(item => item.recordId), actor.id],
    );
    for (const row of rows.rows) loaded.set(row.id, { ...row, field_values: typeof row.field_values === "string" ? JSON.parse(row.field_values) as Record<string, unknown> : row.field_values ?? {} });
  }
  const fieldCache = new Map<string, { fields: RecordField[]; grants: Set<string> }>();
  async function catalogue(collection: string) {
    const cached = fieldCache.get(collection);
    if (cached || !tenant) return cached;
    const pack = { fields: await fieldsFor(tx, tenant, collection), grants: await viewGrants(tx, tenant, actor.id, collection) };
    fieldCache.set(collection, pack);
    return pack;
  }
  for (const item of input.records) {
    const row = uuid.test(item.recordId) ? loaded.get(item.recordId) : undefined;
    if (!row || row.collection !== item.collectionId || !tenant) {
      records.push(restrictedRecordPlaceholder);
      continue;
    }
    if (row.state === "archived") {
      records.push(row.can_restore ? archivedRecordPlaceholder : restrictedRecordPlaceholder);
      continue;
    }
    const pack = await catalogue(row.collection);
    const fields = pack?.fields ?? [];
    const grants = pack?.grants ?? new Set<string>();
    const shown: FieldCell[] = [];
    for (const key of item.fields) {
      const field = fields.find(candidate => candidate.key === key);
      if (!field) continue;
      if (field.sensitive && !grants.has(field.key)) shown.push({ key: field.key, label: field.label, access: "hidden" });
      else shown.push({ key: field.key, label: field.label, access: "visible", value: formatRecordFieldValue(row.field_values?.[field.key]) });
    }
    const visible: VisibleRecord = {
      status: "visible",
      title: row.name,
      collectionName: row.collection_name,
      icon: recordIcon(row.collection),
      href: recordPageHref(workspaceId, tenant, row.collection, row.id),
      updatedAt: new Date(row.updated_at).toISOString(),
      fields: shown,
    };
    records.push(visible);
  }
  const views = [];
  for (const item of input.views) views.push(await resolveView(tx, actor, workspaceId, tenant, item, catalogue));
  return { records, views };
}

async function resolveView(tx: Sql, actor: Actor, workspaceId: string, tenant: string | null, item: ResolveViewInput, catalogue: (collection: string) => Promise<{ fields: RecordField[]; grants: Set<string> } | undefined>) {
  if (!tenant || !uuid.test(item.viewId)) return restrictedRecordPlaceholder;
  const view = await tx.query<{ collection: string; definition: RecordViewDefinition | string; name: string }>(
    `SELECT v.collection, v.definition, c.name FROM hs_data_views v JOIN hs_data_collections c ON c.tenant_id=v.tenant_id AND c.id=v.collection
     WHERE v.id=$1 AND v.tenant_id=$2 AND v.workspace_id=$3 AND v.deleted=false AND (v.scope='workspace' OR v.owner_id=$4)
       AND (EXISTS(SELECT 1 FROM hs_data_collection_grants g WHERE g.tenant_id=v.tenant_id AND g.user_id=$4 AND g.collection=v.collection AND 'view'=ANY(g.capabilities))
         OR EXISTS(SELECT 1 FROM hs_data_record_grants g JOIN hs_data_records r ON r.tenant_id=g.tenant_id AND r.id=g.record_id WHERE g.tenant_id=v.tenant_id AND g.user_id=$4 AND r.collection=v.collection AND 'view'=ANY(g.capabilities)))`,
    [item.viewId, tenant, workspaceId, actor.id],
  );
  const stored = view.rows[0];
  if (!stored || stored.collection !== item.collectionId) return restrictedRecordPlaceholder;
  try {
    const pack = await catalogue(stored.collection);
    const fields = pack?.fields ?? [];
    const grants = pack?.grants ?? new Set<string>();
    const visible = visibleKeys(fields, grants);
    const definition = typeof stored.definition === "string" ? JSON.parse(stored.definition) as RecordViewDefinition : stored.definition;
    const columns = item.columns.filter(key => key === "name" || fields.some(field => field.key === key));
    const sort = readerSort(definition.sort ?? [], visible);
    const compiled = compileRecordView({ ...definition, includeArchived: false, columns: columns.length ? columns : ["name"], sort, filters: definition.filters ?? [] }, fields, [tenant, stored.collection, ["active"], false, actor.id]);
    const collectionView = await tx.query("SELECT 1 FROM hs_data_collection_grants WHERE tenant_id=$1 AND user_id=$2 AND collection=$3 AND 'view'=ANY(capabilities)", [tenant, actor.id, stored.collection]);
    compiled.values[3] = collectionView.rows.length > 0;
    const where = `r.tenant_id=$1 AND r.collection=$2 AND r.merged_into_id IS NULL AND r.state=ANY($3::text[]) AND ($4::boolean OR r.id IN(SELECT g.record_id FROM hs_data_record_grants g WHERE g.tenant_id=$1 AND g.user_id=$5 AND 'view'=ANY(g.capabilities))) AND ${compiled.predicates.join(" AND ") || "true"}`;
    const order = compiled.sort.map(entry => `${entry.sql} ${entry.direction.toUpperCase()} NULLS LAST`).join(", ");
    const limit = Math.min(25, Math.max(1, item.limit));
    const values = [...compiled.values, limit];
    const listed = await tx.query<{ id: string; name: string; field_values: Record<string, unknown>; updated_at: string }>(
      `SELECT r.id, r.name, r.field_values, r.updated_at FROM hs_data_records r WHERE ${where} ORDER BY ${order} LIMIT $${values.length}`,
      values,
    );
    const counted = await tx.query<{ n: string }>(`SELECT count(*)::text AS n FROM (SELECT r.id FROM hs_data_records r WHERE ${where} ORDER BY ${order}) counted`, compiled.values);
    const total = Number(counted.rows[0]?.n ?? 0);
    const columnModels = (columns.length ? columns : ["name"]).map(key => {
      if (key === "name") return { key, label: "Name", access: "visible" as const };
      const field = fields.find(candidate => candidate.key === key)!;
      return { key, label: field.label, access: !field.sensitive || grants.has(field.key) ? "visible" as const : "hidden" as const };
    });
    const rows = listed.rows.map(row => {
      const values = typeof row.field_values === "string" ? JSON.parse(row.field_values) as Record<string, unknown> : { ...row.field_values };
      for (const field of fields) if (field.sensitive && !grants.has(field.key)) delete values[field.key];
      return {
        id: row.id,
        href: recordPageHref(workspaceId, tenant, stored.collection, row.id),
        name: row.name,
        cells: columnModels.map(column => {
          if (column.access === "hidden") return { access: "hidden" as const };
          const value = column.key === "name" ? row.name : formatRecordFieldValue(values[column.key]);
          return { access: "visible" as const, value };
        }),
      };
    });
    const chips = [
      ...(definition.filters ?? []).flatMap(filter => {
        if (filter.field !== "name" && !visible.has(filter.field)) return [];
        const label = filter.field === "name" ? "Name" : fields.find(field => field.key === filter.field)?.label;
        return label ? [filterChip(label, filter.operator, filter.value)] : [];
      }),
      ...sort.map(entry => `${entry.field === "name" ? "Name" : fields.find(field => field.key === entry.field)?.label ?? "Name"} ${entry.direction === "desc" ? "descending" : "ascending"}`),
    ];
    const latest = listed.rows.reduce((max, row) => Math.max(max, new Date(row.updated_at).getTime()), 0);
    const payload: VisibleView = {
      status: "visible",
      collectionName: stored.name,
      href: recordPageHref(workspaceId, tenant, stored.collection),
      viewAllLabel: `View all in ${stored.name}`,
      layout: item.layout,
      columns: columnModels,
      rows,
      countLabel: `${rows.length} of ${Number.isSafeInteger(total) ? total : rows.length} you can see`,
      emptyLabel: rows.length ? null : "No records you can access match this view",
      chips,
      updatedAt: new Date(latest || Date.now()).toISOString(),
    };
    return payload;
  } catch {
    return recordRefErrorPlaceholder;
  }
}

export async function pollRecordPageRefs(tx: Sql, actor: Actor, workspaceId: string, input: { recordIds: string[]; viewIds: string[]; cursor: string }) {
  await member(tx, workspaceId, actor.id);
  const tenant = await tenantId(tx, workspaceId);
  const cursor = /^\d+$/.test(input.cursor) ? input.cursor : "0";
  const grants = tenant ? await tx.query("SELECT collection, capabilities FROM hs_data_collection_grants WHERE tenant_id=$1 AND user_id=$2 ORDER BY collection", [tenant, actor.id]) : { rows: [] };
  const records = tenant ? await tx.query("SELECT record_id, capabilities FROM hs_data_record_grants WHERE tenant_id=$1 AND user_id=$2 ORDER BY record_id", [tenant, actor.id]) : { rows: [] };
  const fields = tenant ? await tx.query("SELECT collection, field_key, can_view FROM hs_data_field_permissions WHERE tenant_id=$1 AND user_id=$2 ORDER BY collection, field_key", [tenant, actor.id]) : { rows: [] };
  const accessRevision = recordHash({ grants: grants.rows, records: records.rows, fields: fields.rows });
  const head = tenant ? await tx.query<{ n: string }>("SELECT COALESCE(MAX(sequence),0)::text AS n FROM hs_data_change_events WHERE tenant_id=$1", [tenant]) : { rows: [{ n: "0" }] };
  const next = head.rows[0]?.n ?? "0";
  const ids = input.recordIds.filter(id => uuid.test(id));
  const views = input.viewIds.filter(id => uuid.test(id));
  let changed = false;
  if (tenant && (ids.length || views.length) && BigInt(next) > BigInt(cursor)) {
    const hit = await tx.query(
      `SELECT 1 FROM hs_data_change_events e WHERE e.tenant_id=$1 AND e.sequence>$2::bigint AND (
         (e.record_id=ANY($3::uuid[]) AND (
           EXISTS(SELECT 1 FROM hs_data_collection_grants g WHERE g.tenant_id=e.tenant_id AND g.user_id=$4 AND g.collection=e.collection AND 'view'=ANY(g.capabilities))
           OR EXISTS(SELECT 1 FROM hs_data_record_grants g WHERE g.tenant_id=e.tenant_id AND g.record_id=e.record_id AND g.user_id=$4 AND 'view'=ANY(g.capabilities))))
         OR EXISTS(SELECT 1 FROM hs_data_views v WHERE v.id=ANY($5::uuid[]) AND v.tenant_id=e.tenant_id AND v.workspace_id=$6 AND v.deleted=false AND v.collection=e.collection AND (v.scope='workspace' OR v.owner_id=$4)
           AND (EXISTS(SELECT 1 FROM hs_data_collection_grants g WHERE g.tenant_id=e.tenant_id AND g.user_id=$4 AND g.collection=e.collection AND 'view'=ANY(g.capabilities))
             OR EXISTS(SELECT 1 FROM hs_data_record_grants g WHERE g.tenant_id=e.tenant_id AND g.record_id=e.record_id AND g.user_id=$4 AND 'view'=ANY(g.capabilities)))))
       LIMIT 1`,
      [tenant, cursor, ids, actor.id, views, workspaceId],
    );
    changed = hit.rows.length > 0;
  }
  return { cursor: next, changed, accessRevision };
}

async function auditOnce(tx: Sql, actor: Actor, action: string, operationId: string, after: Record<string, unknown>) {
  const prior = await tx.query<{ after_value: { recordId?: string } }>("SELECT after_value FROM hs_audit WHERE actor_id=$1 AND action=$2 AND correlation_id=$3", [actor.id, action, operationId]);
  if (prior.rows.length) {
    if (prior.rows[0].after_value?.recordId !== after.recordId) throw new DocumentError("Operation identity was reused.", "operation_mismatch", 409);
    return true;
  }
  await tx.query("INSERT INTO hs_audit(id,actor_id,action,after_value,correlation_id) VALUES($1,$2,$3,$4,$5)", [randomUUID(), actor.id, action, JSON.stringify(after), operationId]);
  return false;
}

export async function requestRecordPageAccess(tx: Sql, actor: Actor, workspaceId: string, input: { operationId: string; recordId: string }) {
  await member(tx, workspaceId, actor.id);
  if (!uuid.test(input.recordId) || !uuid.test(input.operationId)) throw denied();
  const replayed = await auditOnce(tx, actor, "record-ref.request-access", input.operationId, { workspaceId, recordId: input.recordId });
  return { requested: true as const, requestedAt: new Date().toISOString(), replayed };
}

export async function restoreRecordPageRef(tx: Sql, actor: Actor, workspaceId: string, input: { operationId: string; recordId: string }) {
  await member(tx, workspaceId, actor.id);
  const tenant = await tenantId(tx, workspaceId);
  if (!tenant || !uuid.test(input.recordId) || !uuid.test(input.operationId)) throw denied();
  const replayed = await auditOnce(tx, actor, "record-ref.restore", input.operationId, { workspaceId, recordId: input.recordId });
  if (replayed) return { restored: true as const, replayed: true as const };
  const row = await tx.query<{ id: string; collection: string; state: string; version: number }>(
    `SELECT r.id, r.collection, r.state, r.version FROM hs_data_records r
     WHERE r.id=$1 AND r.tenant_id=$2 AND r.merged_into_id IS NULL AND r.state='archived'
       AND (EXISTS(SELECT 1 FROM hs_data_collection_grants g WHERE g.tenant_id=r.tenant_id AND g.user_id=$3 AND g.collection=r.collection AND 'view'=ANY(g.capabilities) AND 'restore'=ANY(g.capabilities))
         OR EXISTS(SELECT 1 FROM hs_data_record_grants g WHERE g.tenant_id=r.tenant_id AND g.record_id=r.id AND g.user_id=$3 AND 'view'=ANY(g.capabilities) AND 'restore'=ANY(g.capabilities)))`,
    [input.recordId, tenant, actor.id],
  );
  const record = row.rows[0];
  if (!record) throw denied();
  const version = record.version + 1;
  await tx.query("UPDATE hs_data_records SET state='active', version=$3, updated_by=$4, updated_at=clock_timestamp() WHERE tenant_id=$1 AND id=$2", [tenant, record.id, version, actor.id]);
  await tx.query(
    "INSERT INTO hs_data_events(id,tenant_id,record_id,record_version,actor_id,source_app,operation_id,kind,before_value,after_value,field_policy) VALUES($1,$2,$3,$4,$5,'holy-sheet',$6,'unarchive',$7,$8,'{}')",
    [randomUUID(), tenant, record.id, version, actor.id, input.operationId, JSON.stringify({ state: "archived" }), JSON.stringify({ state: "active" })],
  );
  await tx.query(
    "INSERT INTO hs_data_change_events(id,tenant_id,record_id,record_version,collection,operation_id,actor_id,source_app,kind) VALUES($1,$2,$3,$4,$5,$6,$7,'holy-sheet','unarchive')",
    [randomUUID(), tenant, record.id, version, record.collection, input.operationId, actor.id],
  );
  return { restored: true as const, replayed: false as const };
}

export async function exportRecordPageRefs(tx: Sql, actor: Actor, workspaceId: string, document: RichNode, origin: string): Promise<Record<string, RecordExportSlice> | null> {
  const records: ResolveRecordInput[] = [];
  const views: ResolveViewInput[] = [];
  const visit = (node: RichNode) => {
    if (node.type === "recordRef") records.push({ recordId: String(node.attrs?.recordId ?? ""), collectionId: String(node.attrs?.collectionId ?? ""), fields: Array.isArray(node.attrs?.fields) ? node.attrs.fields.map(String) : [] });
    if (node.type === "recordView") views.push({ viewId: String(node.attrs?.viewId ?? ""), collectionId: String(node.attrs?.collectionId ?? ""), layout: node.attrs?.layout === "list" ? "list" : "table", columns: Array.isArray(node.attrs?.columns) ? node.attrs.columns.map(String) : ["name"], limit: Number(node.attrs?.limit ?? 10) });
    node.content?.forEach(visit);
  };
  visit(document);
  if (!records.length && !views.length) return null;
  let resolved: Awaited<ReturnType<typeof resolveRecordPageRefs>>;
  try { resolved = await resolveRecordPageRefs(tx, actor, workspaceId, { records, views }); } catch { return Object.fromEntries([...records.map(item => [item.recordId, { kind: "record", available: false } satisfies RecordExportSlice]), ...views.map(item => [`view:${item.viewId}`, { kind: "view", available: false } satisfies RecordExportSlice])]); }
  const slices: Record<string, RecordExportSlice> = {};
  resolved.records.forEach((item, index) => {
    const id = records[index]?.recordId ?? String(index);
    if (item.status !== "visible") slices[id] = { kind: "record", available: false };
    else slices[id] = { kind: "record", available: true, title: item.title, url: origin.replace(/\/$/, "") + item.href, fields: item.fields.map(field => field.access === "hidden" ? { label: field.label, value: null } : { label: field.label, value: field.value }) };
  });
  resolved.views.forEach((item, index) => {
    const id = `view:${views[index]?.viewId ?? index}`;
    if (item.status !== "visible") slices[id] = { kind: "view", available: false };
    else slices[id] = { kind: "view", available: true, collectionName: item.collectionName, url: origin.replace(/\/$/, "") + item.href, columns: item.columns.map(column => ({ label: column.label, hidden: column.access === "hidden" })), rows: item.rows.map(row => ({ name: row.name, cells: row.cells.map(cell => cell.access === "hidden" ? null : cell.value) })), countLabel: item.countLabel };
  });
  return slices;
}
