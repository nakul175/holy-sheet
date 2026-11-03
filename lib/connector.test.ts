import { readFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, expect, it } from "vitest";
import { localActor as owner } from "./auth";
import { createDatabase, type Database } from "./database";
import {
  activateConnector,
  connectorCatalogue,
  connectorHistory,
  delegateConnector,
  disconnectConnector,
  downloadConnectorReport,
  enableConnector,
  grantConnectorManager,
  mergeConnector,
  pauseConnector,
  previewConnector,
  saveConnector,
  searchConnectors,
  setConnectorActions,
  syncConnector,
} from "./connector";
import { Repository } from "./repository";

let db: Database;
let r: Repository;
const editor = { id: "connector-editor", name: "Eve Editor" };
const outsider = { id: "connector-outsider", name: "Bolt User" };
const workspace = "ws-aplyd";
const visibleRecord = "00000000-0000-4000-8000-00000000f301";
const secretRecord = "00000000-0000-4000-8000-00000000f302";
const organisationRecord = "00000000-0000-4000-8000-00000000f305";
const accountRecord = "00000000-0000-4000-8000-00000000f304";
const scheduleId = "00000000-0000-4000-8000-00000000f306";
const secretRef = "suite-secret:clinic-sync";
let tenant = "";
let secretField = "";
let clinic = "";
let enabledVersion = 0;
type Shown = {
  id: string;
  version: number;
  status: string;
  sharing: string;
  direction: string;
  type: string;
  dryRun: boolean;
  accessGranted: boolean;
  credentialsStored: boolean;
  liveActivation: boolean;
  connectionAuthorised: boolean;
  secretVisible: boolean;
  canonicalMutated: boolean;
  canonicalPreserved: boolean;
  checkpoint: string;
  effects: { state: string; deduped: boolean; attempts: number; overwritten: boolean }[];
  replayed: boolean;
  rights: { view: boolean; write: boolean; history: boolean; fieldOwned: boolean; accessGranted: boolean };
  body: string;
  inventory: { residency: string; health: string; writesStopped: boolean; schedulesPaused: boolean; liveActivation: boolean; secretVisible: boolean };
};
function shown(value: object) { return value as Shown; }

beforeAll(async () => {
  db = await createDatabase(":memory:");
  r = new Repository(db);
  await r.seedLocal();
  await db.query("UPDATE hs_members SET role='admin' WHERE workspace_id=$1 AND user_id=$2", [workspace, owner.id]);
  for (const actor of [editor, outsider]) await db.query("INSERT INTO hs_users(id, name) VALUES($1,$2)", [actor.id, actor.name]);
  await db.query("INSERT INTO hs_members(workspace_id, user_id, role) VALUES($1,$2,'member')", [workspace, editor.id]);
  await db.query("INSERT INTO hs_workspaces(id, name) VALUES('ws-b','Bolt Logistics')");
  await db.query("INSERT INTO hs_members(workspace_id, user_id, role) VALUES('ws-b',$1,'admin')", [outsider.id]);
  tenant = randomUUID();
  const other = randomUUID();
  await db.query("INSERT INTO hs_data_tenants(id, name) VALUES($1,'Synthetic Clinic'),($2,'Bolt')", [tenant, other]);
  await db.query("INSERT INTO hs_data_workspaces(workspace_id, tenant_id, review_reference) VALUES($1,$2,'synthetic'),('ws-b',$3,'synthetic')", [workspace, tenant, other]);
  await db.query("INSERT INTO hs_data_collections(tenant_id, id, name, core) VALUES($1,'organisations','Organisations',true),($1,'accounts','Accounts',true)", [tenant]);
  await db.query("INSERT INTO hs_data_collection_grants(tenant_id, user_id, collection, capabilities) VALUES($1,$2,'organisations',$3),($1,$2,'accounts',$3)", [tenant, owner.id, ["view", "edit", "export", "history"]]);
  await db.query("INSERT INTO hs_data_records(id, tenant_id, collection, name, field_values, created_by, updated_by) VALUES($1,$2,'organisations','Visible clinic',$3,$4,$4),($5,$2,'organisations','zzsecretrecord','{}',$4,$4),($6,$2,'organisations','Northwind','{}',$4,$4)", [visibleRecord, tenant, JSON.stringify({ "core:notes": "Visible note" }), owner.id, secretRecord, organisationRecord]);
  await db.query("INSERT INTO hs_data_records(id, tenant_id, collection, name, parent_organisation_id, created_by, updated_by) VALUES($1,$2,'accounts','Northwind account',$3,$4,$4)", [accountRecord, tenant, organisationRecord, owner.id]);
  secretField = randomUUID();
  await db.query("INSERT INTO hs_data_fields(tenant_id, collection, field_key, label, kind, sensitive, created_by) VALUES($1,'organisations',$2,'Private salary','text',true,$3)", [tenant, secretField, owner.id]);
  await db.query("INSERT INTO hs_data_field_permissions(tenant_id, collection, field_key, user_id, can_view, can_write, can_history) VALUES($1,'organisations',$2,$3,true,true,true)", [tenant, secretField, owner.id]);
  await db.query("UPDATE hs_data_records SET field_values=$2::jsonb WHERE id=$1", [visibleRecord, JSON.stringify({ "core:notes": "Visible note", [secretField]: "hidden-salary-value" })]);
  await db.query("INSERT INTO hs_data_periodic_review_schedules(id, tenant_id, collection, name, definition, created_by) VALUES($1,$2,'organisations','Existing cadence',$3,$4)", [scheduleId, tenant, JSON.stringify({ paused: true }), owner.id]);
});
afterAll(async () => db.close());

function connectorDefinition() {
  return {
    type: "records",
    scope: { source: "clinic-source", collection: "organisations", recordIds: [visibleRecord, organisationRecord] },
    direction: "read-write",
    stableIds: [{ externalId: "ext-clinic", recordId: visibleRecord }, { externalId: "ext-north", recordId: organisationRecord }],
    mappings: [{ externalField: "notes", field: "core:notes" }, { externalField: "salary", field: secretField }],
    secretRef,
    edge: { cache: "no-store", residency: "tenant", public: false },
    retry: { bound: 3 },
  };
}
function batch(value = "Visible note", externalVersion = 1, tombstone = false) {
  return [{ externalId: "ext-clinic", externalField: "notes", value, externalVersion, tombstone, canonicalVersion: 1 }];
}
async function footprint() {
  const [records, collections, pages, parents, schedules, invitations, users] = await Promise.all([
    db.query("SELECT record_id::text, user_id, capabilities FROM hs_data_record_grants ORDER BY 1,2"),
    db.query("SELECT collection, user_id, capabilities FROM hs_data_collection_grants ORDER BY 1,2"),
    db.query("SELECT page_id, subject, role FROM hs_grants ORDER BY 1,2"),
    db.query("SELECT id::text, parent_organisation_id::text FROM hs_data_records WHERE parent_organisation_id IS NOT NULL"),
    db.query("SELECT id::text, definition FROM hs_data_periodic_review_schedules ORDER BY 1"),
    db.query("SELECT count(*)::int AS n FROM hs_access_invitations"),
    db.query("SELECT count(*)::int AS n FROM hs_users"),
  ]);
  return JSON.stringify({ records: records.rows, collections: collections.rows, pages: pages.rows, parents: parents.rows, schedules: schedules.rows, invitations: invitations.rows[0].n, users: users.rows[0].n });
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
async function canonicalNote() {
  const row = await db.query<{ field_values: Record<string, string> | string }>("SELECT field_values FROM hs_data_records WHERE id=$1", [visibleRecord]);
  const values = typeof row.rows[0].field_values === "string" ? JSON.parse(row.rows[0].field_values) : row.rows[0].field_values;
  return values["core:notes"];
}
function exposed(value: unknown) {
  return JSON.stringify(value);
}

it("lets an administrator register a connector and dry-run it without storing or showing a secret", async () => {
  const before = await footprint();
  const saved = shown(await saveConnector(r, owner, workspace, { operationId: randomUUID(), expectedVersion: 0, name: "Clinic connector", definition: connectorDefinition() }));
  clinic = saved.id;
  expect(saved).toMatchObject({ sharing: "off", accessGranted: false, credentialsStored: false, liveActivation: false, connectionAuthorised: false, secretVisible: false, status: "draft", type: "records", direction: "read-write", dryRun: true, canonicalMutated: false });
  expect(exposed(saved)).not.toContain(secretRef);
  expect(exposed(saved)).not.toContain("hs-secret");
  const preview = shown(await previewConnector(r, owner, workspace, { operationId: randomUUID(), connectorId: clinic, expectedVersion: saved.version }));
  expect(preview).toMatchObject({ dryRun: true, canonicalMutated: false, liveActivation: false, secretVisible: false, direction: "read-write" });
  expect(exposed(preview)).not.toContain(secretRef);
  await expect(saveConnector(r, editor, workspace, { operationId: randomUUID(), expectedVersion: 0, name: "Other connector", definition: connectorDefinition() })).rejects.toMatchObject({ code: "not_found" });
  await expect(saveConnector(r, owner, workspace, { operationId: randomUUID(), expectedVersion: 0, name: "Public connector", definition: { ...connectorDefinition(), edge: { cache: "public", residency: "tenant", public: true } } })).rejects.toMatchObject({ code: "connector_edge" });
  await expect(saveConnector(r, owner, workspace, { operationId: randomUUID(), expectedVersion: 0, name: "Secret connector", definition: { ...connectorDefinition(), password: "hs-secret:super-secret-value" } })).rejects.toMatchObject({ code: "connector_secret" });
  await expect(syncConnector(r, owner, workspace, { operationId: randomUUID(), connectorId: clinic, expectedVersion: saved.version, mode: "initial", checkpoint: null, items: batch() })).rejects.toMatchObject({ code: "connector_writes_stopped" });
  expect(await canonicalNote()).toBe("Visible note");
  expect(await footprint()).toBe(before);
  const stored = await db.query<{ secret_ref: string; live_activation: boolean; credentials_stored: boolean }>("SELECT secret_ref, live_activation, credentials_stored FROM hs_connectors WHERE id=$1", [clinic]);
  expect(stored.rows[0]).toEqual({ secret_ref: secretRef, live_activation: false, credentials_stored: false });
  const fixture = JSON.parse(await readFile("fixtures/connectors/staging.json", "utf8"));
  expect(fixture).toMatchObject({ sharing: "off", accessGranted: false, credentialsStored: false, liveActivation: false, secretVisible: false });
});

it("delegates user and app rights without granting access or revealing secrets", async () => {
  const before = await footprint();
  const users = num((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM hs_users")).rows[0].n);
  const ownerRights = shown(await delegateConnector(r, owner, workspace, { operationId: randomUUID(), connectorId: clinic, expectedVersion: 1, subjectKind: "user", subjectId: owner.id, field: "core:notes" }));
  expect(ownerRights.rights).toMatchObject({ view: true, write: true, fieldOwned: true, accessGranted: false });
  expect(exposed(ownerRights)).not.toContain(secretRef);
  const editorRights = shown(await delegateConnector(r, owner, workspace, { operationId: randomUUID(), connectorId: clinic, expectedVersion: ownerRights.version, subjectKind: "user", subjectId: editor.id, field: secretField }));
  expect(editorRights.rights).toEqual({ view: false, write: false, history: false, fieldOwned: true, accessGranted: false });
  const appRights = shown(await delegateConnector(r, owner, workspace, { operationId: randomUUID(), connectorId: clinic, expectedVersion: editorRights.version, subjectKind: "app", subjectId: "app:clinic-sync", field: "core:notes" }));
  expect(appRights.rights).toEqual({ view: false, write: false, history: false, fieldOwned: true, accessGranted: false });
  expect(num((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM hs_users")).rows[0].n)).toBe(users);
  const delegation = await db.query<{ access_granted: boolean }>("SELECT access_granted FROM hs_connector_delegations WHERE connector_id=$1 AND subject_kind='app'", [clinic]);
  expect(delegation.rows[0].access_granted).toBe(false);
  expect(await footprint()).toBe(before);
  enabledVersion = appRights.version;
});

it("syncs with checkpoints, dedupe, conflict review, tombstones, merges, and bounded retry", async () => {
  const enabled = shown(await enableConnector(r, owner, workspace, { operationId: randomUUID(), connectorId: clinic, expectedVersion: enabledVersion }));
  expect(enabled).toMatchObject({ status: "enabled", liveActivation: false, connectionAuthorised: false, secretVisible: false });
  enabledVersion = enabled.version;
  await expect(syncConnector(r, owner, workspace, { operationId: randomUUID(), connectorId: clinic, expectedVersion: enabledVersion, mode: "initial", checkpoint: null, items: [{ externalId: "ext-clinic", externalField: "salary", value: "hidden-salary-value", externalVersion: 1, canonicalVersion: 1 }] })).rejects.toMatchObject({ code: "connector_delegation" });
  expect(num((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM hs_connector_sync_items WHERE connector_id=$1", [clinic])).rows[0].n)).toBe(0);
  const operationId = randomUUID();
  const initial = shown(await syncConnector(r, owner, workspace, { operationId, connectorId: clinic, expectedVersion: enabledVersion, mode: "initial", checkpoint: null, items: [...batch(), ...batch()] }));
  expect(initial.checkpoint).toBe("cp-1");
  expect(initial.effects).toHaveLength(1);
  expect(initial.effects[0]).toMatchObject({ state: "proposed", deduped: true, overwritten: false });
  expect(initial.canonicalMutated).toBe(false);
  const replayed = shown(await syncConnector(r, owner, workspace, { operationId, connectorId: clinic, expectedVersion: enabledVersion, mode: "initial", checkpoint: null, items: [...batch(), ...batch()] }));
  expect(replayed.replayed).toBe(true);
  expect(num((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM hs_connector_sync_items WHERE connector_id=$1", [clinic])).rows[0].n)).toBe(1);
  await expect(syncConnector(r, owner, workspace, { operationId, connectorId: clinic, expectedVersion: enabledVersion, mode: "incremental", checkpoint: "cp-1", items: batch("Changed note", 2) })).rejects.toMatchObject({ code: "operation_mismatch" });
  await expect(syncConnector(r, owner, workspace, { operationId: randomUUID(), connectorId: clinic, expectedVersion: enabledVersion, mode: "incremental", checkpoint: "cp-missing", items: batch("Changed note", 2) })).rejects.toMatchObject({ code: "connector_checkpoint" });
  const conflict = shown(await syncConnector(r, owner, workspace, { operationId: randomUUID(), connectorId: clinic, expectedVersion: enabledVersion, mode: "incremental", checkpoint: "cp-1", items: batch("Changed note", 2) }));
  expect(conflict.effects[0]).toMatchObject({ state: "conflict", overwritten: false });
  expect(conflict.checkpoint).toBe("cp-2");
  const ledger = await db.query<{ value: string; proposed_value: string; state: string; canonical_mutated: boolean }>("SELECT value, proposed_value, state, canonical_mutated FROM hs_connector_sync_items WHERE connector_id=$1 AND external_id='ext-clinic'", [clinic]);
  expect(ledger.rows[0]).toMatchObject({ value: "Visible note", proposed_value: "Changed note", state: "conflict", canonical_mutated: false });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const retry = shown(await syncConnector(r, owner, workspace, { operationId: randomUUID(), connectorId: clinic, expectedVersion: enabledVersion, mode: "incremental", checkpoint: "cp-2", items: batch(), failed: true }));
    expect(retry.effects[0]).toMatchObject({ state: "failed", attempts: attempt + 1, overwritten: false });
    expect(retry.checkpoint).toBe("cp-2");
  }
  await expect(syncConnector(r, owner, workspace, { operationId: randomUUID(), connectorId: clinic, expectedVersion: enabledVersion, mode: "incremental", checkpoint: "cp-2", items: batch(), failed: true })).rejects.toMatchObject({ code: "connector_retry_bound" });
  const tombstone = shown(await syncConnector(r, owner, workspace, { operationId: randomUUID(), connectorId: clinic, expectedVersion: enabledVersion, mode: "incremental", checkpoint: "cp-2", items: batch("Visible note", 3, true) }));
  expect(tombstone.effects[0].state).toBe("tombstone");
  const merged = shown(await mergeConnector(r, owner, workspace, { operationId: randomUUID(), connectorId: clinic, expectedVersion: enabledVersion, externalId: "ext-clinic", externalField: "notes", survivorExternalId: "ext-north" }));
  expect(merged).toMatchObject({ state: "merged", canonicalMutated: false, overwritten: false });
  const after = await db.query<{ state: string; value: string; merged_into: string; canonical_mutated: boolean }>("SELECT state, value, merged_into, canonical_mutated FROM hs_connector_sync_items WHERE connector_id=$1 AND external_id='ext-clinic'", [clinic]);
  expect(after.rows[0]).toMatchObject({ state: "merged", value: "Visible note", merged_into: "ext-north", canonical_mutated: false });
  expect(await canonicalNote()).toBe("Visible note");
  expect(num((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM hs_data_records WHERE id=$1", [visibleRecord])).rows[0].n)).toBe(1);
  await expect(db.query("UPDATE hs_connector_sync_items SET value='silent-overwrite' WHERE connector_id=$1", [clinic])).rejects.toThrow(/silently overwrite/i);
});

it("enables, pauses, and disconnects by review while preserving canonical data and showing residency", async () => {
  const before = await footprint();
  const paused = shown(await pauseConnector(r, owner, workspace, { operationId: randomUUID(), connectorId: clinic, expectedVersion: enabledVersion }));
  expect(paused.inventory).toMatchObject({ residency: "tenant", health: "paused", writesStopped: true, schedulesPaused: true, liveActivation: false, secretVisible: false });
  expect(paused.liveActivation).toBe(false);
  await expect(syncConnector(r, owner, workspace, { operationId: randomUUID(), connectorId: clinic, expectedVersion: paused.version, mode: "incremental", checkpoint: "cp-3", items: batch("Later", 4) })).rejects.toMatchObject({ code: "connector_writes_stopped" });
  const disconnected = shown(await disconnectConnector(r, owner, workspace, { operationId: randomUUID(), connectorId: clinic, expectedVersion: paused.version }));
  expect(disconnected).toMatchObject({ status: "disconnected", liveActivation: false, canonicalPreserved: true });
  await expect(syncConnector(r, owner, workspace, { operationId: randomUUID(), connectorId: clinic, expectedVersion: disconnected.version, mode: "incremental", checkpoint: "cp-3", items: batch("Later", 4) })).rejects.toMatchObject({ code: "connector_writes_stopped" });
  await expect(enableConnector(r, owner, workspace, { operationId: randomUUID(), connectorId: clinic, expectedVersion: disconnected.version })).rejects.toMatchObject({ code: "connector_disconnected" });
  await expect(activateConnector(r, owner, workspace, { operationId: randomUUID(), connectorId: clinic, expectedVersion: disconnected.version })).rejects.toMatchObject({ code: "connector_activation" });
  expect(await canonicalNote()).toBe("Visible note");
  const catalogue = await connectorCatalogue(r, owner, workspace);
  expect(catalogue.connectors.find(item => item.id === clinic)).toMatchObject({ residency: "tenant", health: "disconnected", schedulesPaused: true, liveActivation: false, secretVisible: false });
  expect(exposed(catalogue)).not.toContain(secretRef);
  expect(await footprint()).toBe(before);
  enabledVersion = disconnected.version;
});

it("enforces tenant, record, field, and action checks without turning configuration into access", async () => {
  const before = await footprint();
  await grantConnectorManager(r, owner, workspace, { operationId: randomUUID(), userId: editor.id });
  await setConnectorActions(r, owner, workspace, { operationId: randomUUID(), userId: editor.id, expectedVersion: 0, actions: ["search"] });
  expect(await footprint()).toBe(before);
  await db.query("INSERT INTO hs_data_record_grants(tenant_id, record_id, user_id, capabilities) VALUES($1,$2,$3,$4)", [tenant, visibleRecord, editor.id, ["view"]]);
  const found = await searchConnectors(r, editor, workspace, "visible note");
  expect(found.results.map(result => result.name)).toContain("Clinic connector");
  expect(exposed(found)).not.toContain("hidden-salary");
  expect(exposed(await searchConnectors(r, editor, workspace, "hidden-salary"))).not.toContain("hidden-salary");
  expect(exposed(await searchConnectors(r, editor, workspace, "zzsecret"))).not.toContain("zzsecretrecord");
  await expect(downloadConnectorReport(r, editor, workspace, { operationId: randomUUID(), connectorId: clinic, expectedVersion: enabledVersion })).rejects.toMatchObject({ code: "action_forbidden" });
  await expect(connectorHistory(r, editor, workspace, clinic)).rejects.toMatchObject({ code: "action_forbidden" });
  await expect(searchConnectors(r, outsider, workspace, "clinic")).rejects.toMatchObject({ code: "not_found" });
  expect((await searchConnectors(r, outsider, "ws-b", "clinic")).results).toEqual([]);
  const report = shown(await downloadConnectorReport(r, owner, workspace, { operationId: randomUUID(), connectorId: clinic, expectedVersion: enabledVersion }));
  expect(report.body).toContain("Value hidden");
  expect(report.body).not.toContain(secretRef);
  expect(report.body).not.toContain("hs-secret");
  const history = await connectorHistory(r, owner, workspace, clinic);
  expect(exposed(history)).not.toContain(secretRef);
  expect(exposed(history)).not.toContain("hidden-salary-value");
});

it("versions configuration, keeps recoverable drafts, and audits actor, source, time, and operation", async () => {
  const before = await footprint();
  const operationId = randomUUID();
  const saved = shown(await saveConnector(r, owner, workspace, { operationId, expectedVersion: 0, name: "Audited connector", definition: connectorDefinition() }));
  const replayed = shown(await saveConnector(r, owner, workspace, { operationId, expectedVersion: 0, name: "Audited connector", definition: connectorDefinition() }));
  expect(replayed).toMatchObject({ replayed: true, id: saved.id, version: saved.version });
  expect(num((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM hs_connectors WHERE id=$1", [saved.id])).rows[0].n)).toBe(1);
  await expect(saveConnector(r, owner, workspace, { operationId, expectedVersion: 1, name: "Audited connector", definition: connectorDefinition() })).rejects.toMatchObject({ code: "operation_mismatch" });
  await expect(saveConnector(r, owner, workspace, { operationId: randomUUID(), connectorId: saved.id, expectedVersion: 0, name: "Audited connector renamed", definition: connectorDefinition() })).rejects.toMatchObject({ code: "connector_conflict" });
  const catalogue = await connectorCatalogue(r, owner, workspace);
  expect(catalogue.drafts.some(draft => draft.connectorKey === saved.id && draft.kind === "configure")).toBe(true);
  expect(exposed(catalogue.drafts)).not.toContain(secretRef);
  const history = await connectorHistory(r, owner, workspace, saved.id);
  expect(history.events.some(event => event.action === "configure" && event.source === "governed-connector" && event.actorId === owner.id && /IST$/.test(event.atIst))).toBe(true);
  const audit = await db.query<{ actor_id: string; after_value: { source?: string; operationId?: string; atIst?: string; secretVisible?: boolean } }>("SELECT actor_id, after_value FROM hs_audit WHERE action='governed-connector.configure' AND subject_id=$1", [saved.id]);
  const after = typeof audit.rows[0].after_value === "string" ? JSON.parse(audit.rows[0].after_value) : audit.rows[0].after_value;
  expect(audit.rows[0].actor_id).toBe(owner.id);
  expect(after).toMatchObject({ source: "governed-connector", accessGranted: false, sharing: "off", secretVisible: false });
  expect(after.atIst).toMatch(/IST$/);
  expect(after.operationId).toBe(operationId);
  expect(exposed(after)).not.toContain(secretRef);
  await expect(db.query("UPDATE hs_connector_revisions SET name='rewritten' WHERE connector_id=$1", [saved.id])).rejects.toThrow(/immutable/i);
  const sql = await readFile("db/134_governed_connectors.sql", "utf8");
  const executable = sql.replace(/--.*$/gm, "");
  expect(executable).not.toMatch(/hs_data_periodic_review_schedules/);
  expect(executable).not.toMatch(/parent_organisation_id/);
  expect(executable).not.toMatch(/release\.py/);
  for (const statement of statements(sql)) await db.query(statement);
  expect((await db.query<{ definition: { paused?: boolean } }>("SELECT definition FROM hs_data_periodic_review_schedules WHERE id=$1", [scheduleId])).rows[0].definition).toMatchObject({ paused: true });
  expect((await db.query<{ parent_organisation_id: string }>("SELECT parent_organisation_id::text FROM hs_data_records WHERE id=$1", [accountRecord])).rows[0].parent_organisation_id).toBe(organisationRecord);
  expect(JSON.parse(await footprint()).schedules).toEqual(JSON.parse(before).schedules);
  expect(await canonicalNote()).toBe("Visible note");
});

function num(value: number | string) { return Number(value); }
