import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { localActor as owner } from "./auth";
import { createDatabase, type Database } from "./database";
import { Repository } from "./repository";
import {
  applyRoleInterfacePreview,
  createRoleInterface,
  discardRoleInterfaceDraft,
  downloadRoleInterface,
  grantRoleInterfaceManager,
  previewRoleInterface,
  renderRoleInterface,
  roleInterfaceCatalogue,
  roleInterfaceHistory,
  searchRoleInterfaces,
  stashRoleInterface,
  type InterfaceView,
} from "./role-interface";

let db: Database;
let r: Repository;
const editor = { id: "interface-editor", name: "Ed Editor" };
const reader = { id: "interface-reader", name: "Rae Reader" };
const observer = { id: "interface-observer", name: "Olivia Observer" };
const outsider = { id: "interface-outsider", name: "Bolt User" };
const workspace = "ws-aplyd";
const visibleRecord = "00000000-0000-4000-8000-00000000f101";
const secretRecord = "00000000-0000-4000-8000-00000000f102";
const staleRecord = "00000000-0000-4000-8000-00000000f103";
const accountRecord = "00000000-0000-4000-8000-00000000f104";
const organisationRecord = "00000000-0000-4000-8000-00000000f105";
const scheduleId = "00000000-0000-4000-8000-00000000f106";
const buttonId = "00000000-0000-4000-8000-00000000f107";
const viewId = "00000000-0000-4000-8000-00000000f108";
let tenant = "";
let secretField = "";
let retiringField = "";
let formulaField = "";
let rollupField = "";
let clinic: InterfaceView;
let baseline = "";

beforeAll(async () => {
  db = await createDatabase(":memory:");
  r = new Repository(db);
  await r.seedLocal();
  await db.query("UPDATE hs_members SET role='admin' WHERE workspace_id=$1 AND user_id=$2", [workspace, owner.id]);
  for (const actor of [editor, reader, observer, outsider]) await db.query("INSERT INTO hs_users(id, name) VALUES($1,$2)", [actor.id, actor.name]);
  await db.query("INSERT INTO hs_members(workspace_id, user_id, role) VALUES($1,$2,'member'),($1,$3,'member'),($1,$4,'observer')", [workspace, editor.id, reader.id, observer.id]);
  await db.query("INSERT INTO hs_workspaces(id, name) VALUES('ws-b','Bolt Logistics')");
  await db.query("INSERT INTO hs_members(workspace_id, user_id, role) VALUES('ws-b',$1,'admin')", [outsider.id]);
  tenant = randomUUID();
  const other = randomUUID();
  await db.query("INSERT INTO hs_data_tenants(id, name) VALUES($1,'Acme'),($2,'Bolt')", [tenant, other]);
  await db.query("INSERT INTO hs_data_workspaces(workspace_id, tenant_id, review_reference) VALUES($1,$2,'synthetic'),('ws-b',$3,'synthetic')", [workspace, tenant, other]);
  await db.query("INSERT INTO hs_data_collections(tenant_id, id, name, core) VALUES($1,'organisations','Organisations',true),($1,'accounts','Accounts',true)", [tenant]);
  await db.query("INSERT INTO hs_data_collection_grants(tenant_id, user_id, collection, capabilities) VALUES($1,$2,'organisations',$3),($1,$2,'accounts',$3)", [tenant, owner.id, ["view", "edit", "export", "history"]]);
  await db.query("INSERT INTO hs_data_records(id, tenant_id, collection, name, created_by, updated_by) VALUES($1,$2,'organisations','Visible clinic',$3,$3),($4,$2,'organisations','zzsecretrecord',$3,$3),($5,$2,'organisations','Stale clinic',$3,$3),($6,$2,'organisations','Northwind',$3,$3)", [visibleRecord, tenant, owner.id, secretRecord, staleRecord, organisationRecord]);
  await db.query("INSERT INTO hs_data_records(id, tenant_id, collection, name, parent_organisation_id, created_by, updated_by) VALUES($1,$2,'accounts','Northwind account',$3,$4,$4)", [accountRecord, tenant, organisationRecord, owner.id]);
  const edit = ["view", "edit", "export", "history"];
  await db.query("INSERT INTO hs_data_record_grants(tenant_id, record_id, user_id, capabilities) VALUES($1,$2,$3,$4),($1,$5,$3,$4)", [tenant, visibleRecord, editor.id, edit, staleRecord]);
  secretField = randomUUID();
  retiringField = randomUUID();
  formulaField = randomUUID();
  rollupField = randomUUID();
  await db.query("INSERT INTO hs_data_fields(tenant_id, collection, field_key, label, kind, sensitive, created_by) VALUES($1,'organisations',$2,'Private salary','text',true,$3),($1,'organisations',$4,'Retiring note','text',false,$3),($1,'organisations',$5,'Hidden total','number',false,$3),($1,'organisations',$6,'Owned rollup','number',false,$3)", [tenant, secretField, owner.id, retiringField, formulaField, rollupField]);
  await db.query("INSERT INTO hs_data_field_permissions(tenant_id, collection, field_key, user_id, can_view, can_write, can_history) VALUES($1,'organisations',$2,$3,true,true,true)", [tenant, secretField, owner.id]);
  await db.query("INSERT INTO hs_data_formula_fields(tenant_id, collection, field_key, version, definition, sensitive, created_by) VALUES($1,'organisations',$2,1,$3,false,$4)", [tenant, formulaField, JSON.stringify({ id: formulaField, label: "Hidden total", returnKind: "number", expression: { kind: "literal", value: 1 } }), owner.id]);
  await db.query("INSERT INTO hs_data_rollup_fields(tenant_id, collection, field_key, version, definition, sensitive, created_by) VALUES($1,'organisations',$2,1,$3,false,$4)", [tenant, rollupField, JSON.stringify({ id: rollupField, label: "Owned rollup" }), owner.id]);
  await db.query("UPDATE hs_data_records SET field_values=$2::jsonb WHERE id=$1", [visibleRecord, JSON.stringify({ [secretField]: "hidden-salary-value", "core:registration": "AB-1" })]);
  await db.query("INSERT INTO hs_data_views(id, tenant_id, workspace_id, collection, owner_id, scope, name, definition) VALUES($1,$2,$3,'organisations',$4,'workspace','Clinic view','{}')", [viewId, tenant, workspace, owner.id]);
  await db.query("INSERT INTO hs_action_buttons(id, tenant_id, collection, label, status, definition, created_by) VALUES($1,$2,'organisations','Open note','draft',$3,$4)", [buttonId, tenant, JSON.stringify({ context: { collection: "organisations", placement: "record" }, inputs: [], target: { actionId: "hs.record.append-note", field: "core:notes" }, link: null }), owner.id]);
  await db.query("INSERT INTO hs_data_periodic_review_schedules(id, tenant_id, collection, name, definition, created_by) VALUES($1,$2,'organisations','Existing cadence',$3,$4)", [scheduleId, tenant, JSON.stringify({ paused: true }), owner.id]);
});
afterAll(async () => db.close());

function definition(patch: Record<string, unknown> = {}, listField = "core:registration", includeSecret = false, listView: string | null = null) {
  return {
    navigation: [{ id: "home", label: "Clinic", screenId: "clinic" }],
    screens: [{
      id: "clinic",
      name: "Clinic",
      components: [
        { id: "roster", kind: "list", collection: "organisations", viewId: listView, fields: [{ key: listField, version: 1 }] },
        { id: "focus", kind: "detail", collection: "organisations", fields: includeSecret ? [{ key: secretField, version: 1 }, { key: "core:registration", version: 1 }] : [{ key: "core:registration", version: 1 }] },
        { id: "edit", kind: "form", collection: "organisations", fields: [{ key: "core:notes", version: 1 }] },
        { id: "mix", kind: "chart", collection: "organisations", viewId: null, field: { key: "core:registration", version: 1 } },
        { id: "go", kind: "button", buttonId },
      ],
    }],
    roles: ["member"],
    ...patch,
  };
}

function withForm(key: string) {
  const value = definition();
  const form = value.screens[0].components.find(component => component.id === "edit");
  if (form && "fields" in form) form.fields = [{ key, version: 1 }];
  return value;
}

async function publish(created: InterfaceView) {
  const staged = await previewRoleInterface(r, owner, workspace, { operationId: randomUUID(), interfaceId: created.id, kind: "stage", expectedVersion: created.version });
  const previewing = await applyRoleInterfacePreview(r, owner, workspace, { operationId: randomUUID(), previewId: staged.previewId, expectedVersion: created.version }) as InterfaceView;
  const reviewed = await previewRoleInterface(r, owner, workspace, { operationId: randomUUID(), interfaceId: created.id, kind: "publish", expectedVersion: previewing.version });
  return applyRoleInterfacePreview(r, owner, workspace, { operationId: randomUUID(), previewId: reviewed.previewId, expectedVersion: previewing.version }) as Promise<InterfaceView>;
}

async function grants() {
  const [records, collections, fields, parents, schedules] = await Promise.all([
    db.query("SELECT record_id::text, user_id, capabilities FROM hs_data_record_grants ORDER BY 1,2"),
    db.query("SELECT collection, user_id, capabilities FROM hs_data_collection_grants ORDER BY 1,2"),
    db.query("SELECT field_key, user_id, can_view, can_write FROM hs_data_field_permissions ORDER BY 1,2"),
    db.query("SELECT id::text, parent_organisation_id::text FROM hs_data_records ORDER BY 1"),
    db.query("SELECT id::text, deprecated, definition FROM hs_data_periodic_review_schedules ORDER BY 1"),
  ]);
  return JSON.stringify({ records: records.rows, collections: collections.rows, fields: fields.rows, parents: parents.rows, schedules: schedules.rows });
}

async function notes(recordId: string) {
  const row = await db.query<{ field_values: Record<string, unknown>; version: number | string; parent_organisation_id: string | null }>("SELECT field_values, version, parent_organisation_id::text FROM hs_data_records WHERE id=$1", [recordId]);
  const values = typeof row.rows[0].field_values === "string" ? JSON.parse(row.rows[0].field_values) as Record<string, unknown> : row.rows[0].field_values;
  return { notes: values["core:notes"] ?? "", secret: values[secretField] ?? "", parent: row.rows[0].parent_organisation_id, version: Number(row.rows[0].version) };
}

function screenOf(rendered: { screens: { components: { id: string; status: string; reason: string | null; records?: { id: string }[]; record?: { name?: string; values?: Record<string, unknown> } | null; groups?: unknown[]; browse: false }[] }[] }) {
  return rendered.screens[0].components;
}

function statements(sql: string) {
  const parts: string[] = [];
  let current = "";
  let dollar = false;
  for (const line of sql.split("\n")) {
    current += `${line}\n`;
    if ((line.split("$$").length - 1) % 2 === 1) dollar = !dollar;
    if (!dollar && line.trim().endsWith(";")) {
      if (current.replace(/^\s*--.*$/gm, "").trim()) parts.push(current.trim());
      current = "";
    }
  }
  return parts;
}

describe("role interfaces", () => {
  describe("N62-01", () => {
    it("lets a manager design navigation and screens, then preview and publish them", async () => {
      const created = await createRoleInterface(r, owner, workspace, { operationId: randomUUID(), name: "Clinic desk", definition: definition({}, retiringField, true, viewId) });
      expect(created).toMatchObject({ status: "draft", version: 1, sharing: "private", name: "Clinic desk" });
      expect(created.definition.navigation[0]).toMatchObject({ label: "Clinic", screenId: "clinic" });
      expect(created.definition.screens[0].components.map(component => component.kind)).toEqual(["list", "detail", "form", "chart", "button"]);
      expect((await roleInterfaceCatalogue(r, reader, workspace)).interfaces).toEqual([]);
      await expect(createRoleInterface(r, editor, workspace, { operationId: randomUUID(), name: "Editor desk", definition: definition() })).rejects.toMatchObject({ code: "management_required" });
      const secret = "hidden-salary-value";
      await expect(createRoleInterface(r, owner, workspace, { operationId: randomUUID(), name: "Scripted desk", definition: { ...definition(), script: secret } })).rejects.toMatchObject({ code: "role_interface_validation" });
      await expect(createRoleInterface(r, owner, workspace, { operationId: randomUUID(), name: "Public desk", definition: { ...definition(), sharing: "public" } })).rejects.toMatchObject({ code: "role_interface_public" });
      await expect(createRoleInterface(r, owner, workspace, { operationId: randomUUID(), name: "Calculated desk", definition: withForm(formulaField) })).rejects.toMatchObject({ code: "role_interface_calculated" });
      await expect(createRoleInterface(r, owner, workspace, { operationId: randomUUID(), name: "Owned desk", definition: withForm("parent_organisation_id") })).rejects.toMatchObject({ code: "role_interface_owned" });
      await expect(createRoleInterface(r, owner, workspace, { operationId: randomUUID(), name: "Rollup desk", definition: withForm(rollupField) })).rejects.toMatchObject({ code: "role_interface_owned" });
      expect(await db.query("SELECT count(*)::int AS n FROM hs_role_interfaces WHERE name IN ('Scripted desk','Public desk','Calculated desk','Owned desk','Rollup desk')")).toMatchObject({ rows: [{ n: 0 }] });
      const unpublished = await createRoleInterface(r, owner, workspace, { operationId: randomUUID(), name: "Unpublished desk", definition: definition() });
      expect(unpublished.status).toBe("draft");
      clinic = await publish(created);
      expect(clinic).toMatchObject({ status: "published", version: 3, sharing: "private" });
      expect((await roleInterfaceCatalogue(r, reader, workspace)).interfaces.map(item => item.name)).toEqual(["Clinic desk"]);
      expect((await roleInterfaceCatalogue(r, reader, workspace)).interfaces.some(item => item.status === "draft")).toBe(false);
    });
  });

  describe("N62-02", () => {
    it("uses the viewer grants and does not let interface access browse a collection", async () => {
      baseline = await grants();
      const readerView = await renderRoleInterface(r, reader, workspace, clinic.id, { recordId: visibleRecord });
      expect(readerView.browse).toBe(false);
      expect(readerView.authority).toContain("does not grant collection browse");
      const readerComponents = screenOf(readerView);
      expect(readerComponents.find(component => component.id === "roster")).toMatchObject({ status: "ready", browse: false, records: [] });
      expect(readerComponents.find(component => component.id === "focus")).toMatchObject({ status: "ready", record: null, browse: false });
      expect(JSON.stringify(readerView)).not.toContain("hidden-salary-value");
      expect(JSON.stringify(readerView)).not.toContain(secretField);
      expect(JSON.stringify(readerView)).not.toContain("zzsecretrecord");
      expect(JSON.stringify(readerView)).not.toContain("Visible clinic");
      const editorView = await renderRoleInterface(r, editor, workspace, clinic.id, { recordId: visibleRecord, q: "visible" });
      const roster = editorView.screens[0].components.find(component => component.id === "roster");
      expect(roster?.records?.map(record => record.id)).toEqual([visibleRecord]);
      expect(JSON.stringify(editorView)).not.toContain("hidden-salary-value");
      expect(JSON.stringify(editorView)).not.toContain(secretField);
      expect(JSON.stringify(editorView)).not.toContain("zzsecretrecord");
      const ownerView = await renderRoleInterface(r, owner, workspace, clinic.id, { recordId: visibleRecord });
      expect(JSON.stringify(ownerView.screens[0].components.find(component => component.id === "focus"))).toContain("hidden-salary-value");
      expect(await grants()).toBe(baseline);
      await expect(renderRoleInterface(r, reader, workspace, clinic.id, { recordId: secretRecord, q: "zzsecret" })).resolves.toMatchObject({ browse: false });
      expect(JSON.stringify(await renderRoleInterface(r, editor, workspace, clinic.id, { q: "zzsecret" }))).not.toContain(secretRecord);
    });
  });

  describe("N62-03", () => {
    it("submits editable controls through validation and refuses calculated, owned, and unapproved writes", async () => {
      const preview = await previewRoleInterface(r, editor, workspace, { operationId: randomUUID(), interfaceId: clinic.id, kind: "submit", expectedVersion: clinic.version, componentId: "edit", recordId: visibleRecord, schemaVersion: 1, values: { "core:notes": "Saved note" } });
      expect(preview.plan?.fields).toEqual(["core:notes"]);
      expect(await notes(visibleRecord)).toMatchObject({ notes: "", version: 1, secret: "hidden-salary-value" });
      await expect(previewRoleInterface(r, editor, workspace, { operationId: randomUUID(), interfaceId: clinic.id, kind: "submit", expectedVersion: clinic.version, componentId: "edit", recordId: visibleRecord, schemaVersion: 1, values: { "core:notes": 12 } })).rejects.toMatchObject({ code: "record_validation" });
      await expect(previewRoleInterface(r, editor, workspace, { operationId: randomUUID(), interfaceId: clinic.id, kind: "submit", expectedVersion: clinic.version, componentId: "edit", recordId: visibleRecord, schemaVersion: 99, values: { "core:notes": "Nope" } })).rejects.toMatchObject({ code: "role_interface_schema" });
      await expect(previewRoleInterface(r, owner, workspace, { operationId: randomUUID(), interfaceId: clinic.id, kind: "submit", expectedVersion: clinic.version, componentId: "edit", recordId: visibleRecord, schemaVersion: 1, values: { [formulaField]: 1 } })).rejects.toMatchObject({ code: "role_interface_calculated" });
      await expect(previewRoleInterface(r, owner, workspace, { operationId: randomUUID(), interfaceId: clinic.id, kind: "submit", expectedVersion: clinic.version, componentId: "edit", recordId: visibleRecord, schemaVersion: 1, values: { parent_organisation_id: organisationRecord } })).rejects.toMatchObject({ code: "role_interface_owned" });
      await expect(previewRoleInterface(r, reader, workspace, { operationId: randomUUID(), interfaceId: clinic.id, kind: "submit", expectedVersion: clinic.version, componentId: "edit", recordId: visibleRecord, schemaVersion: 1, values: { "core:notes": "Nope" } })).rejects.toMatchObject({ status: 404 });
      expect(await notes(visibleRecord)).toMatchObject({ notes: "", version: 1 });
      const operationId = randomUUID();
      const saved = await applyRoleInterfacePreview(r, editor, workspace, { operationId, previewId: preview.previewId, expectedVersion: clinic.version });
      expect(saved).toMatchObject({ replayed: false, source: "role-interface", recordId: visibleRecord, recordVersion: 2, recoverable: true });
      const again = await applyRoleInterfacePreview(r, editor, workspace, { operationId, previewId: preview.previewId, expectedVersion: clinic.version });
      expect(again).toMatchObject({ replayed: true, recordVersion: 2 });
      expect(await notes(visibleRecord)).toMatchObject({ notes: "Saved note", version: 2, secret: "hidden-salary-value" });
      expect(await notes(accountRecord)).toMatchObject({ parent: organisationRecord });
      const stalePreview = await previewRoleInterface(r, editor, workspace, { operationId: randomUUID(), interfaceId: clinic.id, kind: "submit", expectedVersion: clinic.version, componentId: "edit", recordId: staleRecord, schemaVersion: 1, values: { "core:notes": "Waiting" } });
      await db.query("UPDATE hs_data_records SET version=version+1 WHERE id=$1", [staleRecord]);
      await expect(applyRoleInterfacePreview(r, editor, workspace, { operationId: randomUUID(), previewId: stalePreview.previewId, expectedVersion: clinic.version })).rejects.toMatchObject({ code: "role_interface_stale" });
      expect(await notes(staleRecord)).toMatchObject({ notes: "" });
      const workflowId = randomUUID();
      await db.query("INSERT INTO hs_data_review_workflows(id, tenant_id, collection, name, definition, created_by) VALUES($1,$2,'organisations','Interface approval',$3,$4)", [workflowId, tenant, JSON.stringify({ fields: ["core:notes"] }), owner.id]);
      await db.query("INSERT INTO hs_data_review_workflow_versions(tenant_id, workflow_id, version, name, deprecated, definition, schema_version, actor_id) VALUES($1,$2,1,'Interface approval',false,$3,1,$4)", [tenant, workflowId, JSON.stringify({ fields: ["core:notes"] }), owner.id]);
      await db.query("INSERT INTO hs_data_reviews(id, tenant_id, workflow_id, workflow_version, record_id, record_version, schema_version, status, submitted_by) VALUES($1,$2,$3,1,$4,2,1,'pending',$5)", [randomUUID(), tenant, workflowId, visibleRecord, owner.id]);
      await expect(previewRoleInterface(r, editor, workspace, { operationId: randomUUID(), interfaceId: clinic.id, kind: "submit", expectedVersion: clinic.version, componentId: "edit", recordId: visibleRecord, schemaVersion: 1, values: { "core:notes": "Bypass" } })).rejects.toMatchObject({ code: "role_interface_approval" });
      expect(await notes(visibleRecord)).toMatchObject({ notes: "Saved note", version: 2 });
    });
  });

  describe("N62-04", () => {
    it("reports a broken component and keeps the other components usable", async () => {
      await db.query("UPDATE hs_data_fields SET deprecated=true WHERE tenant_id=$1 AND field_key=$2", [tenant, retiringField]);
      const rendered = await renderRoleInterface(r, editor, workspace, clinic.id, { recordId: visibleRecord });
      const components = screenOf(rendered);
      expect(components.find(component => component.id === "roster")).toMatchObject({ status: "broken", reason: "deprecated-field" });
      expect(components.find(component => component.id === "focus")).toMatchObject({ status: "ready" });
      expect(components.find(component => component.id === "focus")?.record?.name).toBe("Visible clinic");
      expect(components.find(component => component.id === "edit")).toMatchObject({ status: "ready" });
      expect(components.find(component => component.id === "mix")).toMatchObject({ status: "ready" });
      expect(components.find(component => component.id === "go")).toMatchObject({ status: "ready" });
      expect(components.filter(component => component.status === "ready").length).toBeGreaterThan(0);
      expect(await db.query("SELECT kind, label FROM hs_data_schema_dependencies WHERE tenant_id=$1 AND interface_id=$2 AND field_key=$3", [tenant, clinic.id, retiringField])).toMatchObject({ rows: [{ kind: "interface", label: "Role interface" }] });
      await db.query("UPDATE hs_data_views SET deleted=true WHERE id=$1", [viewId]);
      const missing = await renderRoleInterface(r, editor, workspace, clinic.id, { recordId: visibleRecord });
      expect(missing.screens[0].components.find(component => component.id === "roster")?.reason).toBe("missing-view");
      expect(missing.screens[0].components.find(component => component.id === "focus")?.status).toBe("ready");
      expect(clinic.sharing).toBe("private");
      expect(JSON.stringify(rendered)).not.toContain("hiddenCount");
      await expect(db.query("INSERT INTO hs_role_interfaces(id, tenant_id, name, status, sharing, definition, created_by) VALUES($1,$2,'Public insert','draft','public',$3,$4)", [randomUUID(), tenant, JSON.stringify(definition()), owner.id])).rejects.toThrow(/private|public/i);
    });
  });

  describe("N62-05", () => {
    it("enforces tenant, record, field, and action checks on search, preview, download, and history", async () => {
      expect(await grants()).toBe(baseline);
      await expect(createRoleInterface(r, observer, workspace, { operationId: randomUUID(), name: "Observer desk", definition: definition() })).rejects.toMatchObject({ code: "read_only" });
      await expect(renderRoleInterface(r, outsider, "ws-b", clinic.id)).rejects.toMatchObject({ status: 404 });
      await expect(roleInterfaceCatalogue(r, outsider, "ws-b")).resolves.toMatchObject({ interfaces: [] });
      const grantOperation = randomUUID();
      expect(await grantRoleInterfaceManager(r, owner, workspace, { operationId: grantOperation, userId: editor.id })).toMatchObject({ granted: true, replayed: false });
      expect(await grantRoleInterfaceManager(r, owner, workspace, { operationId: grantOperation, userId: editor.id })).toMatchObject({ replayed: true });
      expect(await grants()).toBe(baseline);
      const managed = await createRoleInterface(r, editor, workspace, { operationId: randomUUID(), name: "Editor managed", definition: definition() });
      expect(managed.status).toBe("draft");
      expect((await searchRoleInterfaces(r, reader, workspace, "clinic")).results.map(item => item.id)).toEqual([clinic.id]);
      expect(JSON.stringify(await searchRoleInterfaces(r, reader, workspace, "clinic"))).not.toContain("hidden-salary-value");
      expect(await searchRoleInterfaces(r, reader, workspace, "unpublished")).toMatchObject({ results: [] });
      const file = await downloadRoleInterface(r, reader, workspace, { operationId: randomUUID(), interfaceId: clinic.id, expectedVersion: clinic.version });
      expect(file.body).toContain("does not grant access");
      expect(file.body).toContain("private");
      expect(file.body).not.toContain("hidden-salary-value");
      expect(file.body).not.toContain(secretField);
      await expect(downloadRoleInterface(r, outsider, "ws-b", { operationId: randomUUID(), interfaceId: clinic.id, expectedVersion: clinic.version })).rejects.toMatchObject({ status: 404 });
      const hidden = await previewRoleInterface(r, owner, workspace, { operationId: randomUUID(), interfaceId: clinic.id, kind: "submit", expectedVersion: clinic.version, componentId: "edit", recordId: secretRecord, schemaVersion: 1, values: { "core:notes": "Hidden run" } });
      await applyRoleInterfacePreview(r, owner, workspace, { operationId: randomUUID(), previewId: hidden.previewId, expectedVersion: clinic.version });
      const readerHistory = await roleInterfaceHistory(r, reader, workspace, clinic.id);
      expect(JSON.stringify(readerHistory)).not.toContain(secretRecord);
      expect(JSON.stringify(readerHistory)).not.toContain("zzsecretrecord");
      expect(JSON.stringify(readerHistory)).not.toContain("Hidden run");
      expect(readerHistory.events.some(event => event.source === "role-interface" && /IST$/.test(event.atIst))).toBe(true);
      const ownerHistory = await roleInterfaceHistory(r, owner, workspace, clinic.id);
      expect(ownerHistory.submissions.map(item => item.recordId)).toContain(secretRecord);
      expect(await notes(accountRecord)).toMatchObject({ parent: organisationRecord });
      expect(await db.query("SELECT definition, deprecated FROM hs_data_periodic_review_schedules WHERE id=$1", [scheduleId])).toMatchObject({ rows: [{ definition: { paused: true }, deprecated: false }] });
      await expect(db.query("INSERT INTO hs_role_interfaces(id, tenant_id, name, status, sharing, definition, created_by) VALUES($1,$2,'Illegal published','published','private',$3,$4)", [randomUUID(), tenant, JSON.stringify(definition()), owner.id])).rejects.toThrow(/draft/i);
      expect(await grants()).toBe(baseline);
    });
  });

  describe("N62-06", () => {
    it("versions configuration, keeps recoverable drafts, and audits the actor, source, time, and operation", async () => {
      const operationId = randomUUID();
      const body = definition();
      const created = await createRoleInterface(r, owner, workspace, { operationId, name: "Versioned desk", definition: body });
      const replay = await createRoleInterface(r, owner, workspace, { operationId, name: "Versioned desk", definition: body });
      expect(replay).toMatchObject({ replayed: true, id: created.id, status: "draft" });
      await expect(createRoleInterface(r, owner, workspace, { operationId, name: "Other desk", definition: definition() })).rejects.toMatchObject({ code: "operation_mismatch" });
      await expect(previewRoleInterface(r, editor, workspace, { operationId: randomUUID(), interfaceId: created.id, kind: "submit", expectedVersion: created.version, componentId: "edit", recordId: visibleRecord, schemaVersion: 1, values: { "core:notes": "Early" } })).rejects.toMatchObject({ code: "role_interface_paused" });
      expect(await db.query("SELECT count(*)::int AS n FROM hs_role_interface_submissions WHERE interface_id=$1", [created.id])).toMatchObject({ rows: [{ n: 0 }] });
      const stash = await stashRoleInterface(r, owner, workspace, { operationId: randomUUID(), interfaceId: created.id, expectedVersion: created.version, definition: definition({ navigation: [{ id: "home", label: "Draft", screenId: "clinic" }] }) });
      expect(stash).toMatchObject({ conflict: false, version: 1 });
      expect(await db.query("SELECT version, status FROM hs_role_interfaces WHERE id=$1", [created.id])).toMatchObject({ rows: [{ version: 1, status: "draft" }] });
      const stale = await stashRoleInterface(r, owner, workspace, { operationId: randomUUID(), interfaceId: created.id, expectedVersion: 99, definition: definition({ navigation: [{ id: "home", label: "Kept", screenId: "clinic" }] }) });
      expect(stale.conflict).toBe(true);
      expect(stale.recoverableDraft.definition.navigation[0]).toMatchObject({ label: "Kept" });
      const reviewed = await previewRoleInterface(r, owner, workspace, { operationId: randomUUID(), interfaceId: created.id, kind: "version-change", expectedVersion: created.version, definition: definition({ navigation: [{ id: "home", label: "Saved", screenId: "clinic" }] }) });
      await expect(applyRoleInterfacePreview(r, owner, workspace, { operationId: randomUUID(), previewId: reviewed.previewId, expectedVersion: 99 })).rejects.toMatchObject({ code: "role_interface_conflict" });
      expect(await db.query("SELECT count(*)::int AS n FROM hs_role_interface_drafts WHERE interface_id=$1 AND actor_id=$2", [created.id, owner.id])).toMatchObject({ rows: [{ n: 1 }] });
      const saved = await applyRoleInterfacePreview(r, owner, workspace, { operationId: randomUUID(), previewId: reviewed.previewId, expectedVersion: created.version }) as InterfaceView;
      expect(saved).toMatchObject({ status: "draft", version: 2 });
      expect(saved.definition.navigation[0]).toMatchObject({ label: "Saved" });
      await discardRoleInterfaceDraft(r, owner, workspace, { operationId: randomUUID(), interfaceId: created.id });
      const rolled = await previewRoleInterface(r, owner, workspace, { operationId: randomUUID(), interfaceId: created.id, kind: "rollback", expectedVersion: saved.version, targetVersion: 1 });
      const restored = await applyRoleInterfacePreview(r, owner, workspace, { operationId: randomUUID(), previewId: rolled.previewId, expectedVersion: saved.version }) as InterfaceView;
      expect(restored).toMatchObject({ status: "draft" });
      expect(restored.definition.navigation[0]).toMatchObject({ label: "Clinic" });
      const history = await roleInterfaceHistory(r, owner, workspace, created.id);
      expect(history.events.some(event => event.action === "version-change" && event.source === "role-interface" && /IST$/.test(event.atIst))).toBe(true);
      const audit = await db.query<{ actor_id: string; after_value: { source?: string; operationId?: string; atIst?: string } }>("SELECT actor_id, after_value FROM hs_audit WHERE action='role-interface.version-change' AND subject_id=$1 ORDER BY created_at DESC LIMIT 1", [created.id]);
      const after = typeof audit.rows[0].after_value === "string" ? JSON.parse(audit.rows[0].after_value) : audit.rows[0].after_value;
      expect(audit.rows[0].actor_id).toBe(owner.id);
      expect(after).toMatchObject({ source: "role-interface" });
      expect(after.atIst).toMatch(/IST$/);
      expect(after.operationId).toBeTruthy();
      await expect(db.query("UPDATE hs_role_interface_revisions SET name='rewritten' WHERE interface_id=$1", [created.id])).rejects.toThrow(/immutable/i);
      const sql = await readFile("db/129_role_interfaces.sql", "utf8");
      for (const statement of statements(sql)) await db.query(statement);
      expect(await db.query<{ definition: { paused?: boolean } }>("SELECT definition FROM hs_data_periodic_review_schedules WHERE id=$1", [scheduleId])).toMatchObject({ rows: [{ definition: { paused: true } }] });
      expect(await notes(accountRecord)).toMatchObject({ parent: organisationRecord });
    });
  });
});
