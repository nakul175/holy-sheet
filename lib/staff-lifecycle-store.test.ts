import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { localActor as owner, type Actor } from "./auth";
import { createDatabase, type Database } from "./database";
import { Repository } from "./repository";
import type { CurrentSuiteTenantAuthority, RecordContext } from "./shared-records";
import { recordCapabilities } from "./shared-record-types";
import { StaffLifecycleRepository } from "./staff-lifecycle-store";

let db: Database;
let life: StaffLifecycleRepository;
let ctx: RecordContext;
let now = new Date("2026-11-01T12:00:00.000Z");
const reader: Actor = { id: "lifecycle-reader" };
const reviewer: Actor = { id: "lifecycle-reviewer" };
const configured: Actor = { id: "lifecycle-config" };
const assigned: Actor = { id: "lifecycle-assigned" };
const outsider: Actor = { id: "lifecycle-outsider" };
const secret = "hidden.lifecycle@example.org";
const authority: CurrentSuiteTenantAuthority = { verify: async (context) => ({ subject: context.actor.id, tenantId: context.tenantId, workspaceId: context.workspaceId, active: true, tenantAdministrator: false, revision: "synthetic-staff-lifecycle-v1" }) };
const as = (actor: Actor): RecordContext => ({ ...ctx, actor });

beforeAll(async () => {
  db = await createDatabase(":memory:");
  await new Repository(db).seedLocal();
  for (const actor of [reader, reviewer, configured, assigned, outsider]) await db.query("INSERT INTO hs_users(id,name) VALUES($1,$1)", [actor.id]);
  life = new StaffLifecycleRepository(new Repository(db), authority, undefined, () => now);
});
beforeEach(async () => {
  now = new Date("2026-11-01T12:00:00.000Z");
  ctx = { actor: owner, tenantId: crypto.randomUUID(), workspaceId: `lifecycle-${crypto.randomUUID()}` };
  await db.query("INSERT INTO hs_workspaces(id,name) VALUES($1,$1)", [ctx.workspaceId]);
  for (const actor of [owner, reader, reviewer, configured, assigned, outsider]) await db.query("INSERT INTO hs_members(workspace_id,user_id) VALUES($1,$2)", [ctx.workspaceId, actor.id]);
  await db.query("INSERT INTO hs_data_tenants(id,name) VALUES($1,$2)", [ctx.tenantId, "Synthetic tenant"]);
  await db.query("INSERT INTO hs_data_workspaces(workspace_id,tenant_id,review_reference) VALUES($1,$2,$3)", [ctx.workspaceId, ctx.tenantId, "Synthetic fixture only"]);
  await db.query("INSERT INTO hs_data_collections(tenant_id,id,name,core) VALUES($1,'organisations','Organisations',true),($1,'accounts','Accounts',true),($1,'employees','Employees',true)", [ctx.tenantId]);
  await db.query("INSERT INTO hs_data_collection_grants(tenant_id,user_id,collection,capabilities) VALUES($1,$2,'organisations',$3),($1,$2,'accounts',$3),($1,$2,'employees',$3)", [ctx.tenantId, owner.id, [...recordCapabilities]]);
  await db.query("INSERT INTO hs_data_collection_grants(tenant_id,user_id,collection,capabilities) VALUES($1,$2,'employees',$3)", [ctx.tenantId, reader.id, ["view"]]);
  await db.query("INSERT INTO hs_data_collection_grants(tenant_id,user_id,collection,capabilities) VALUES($1,$2,'employees',$3)", [ctx.tenantId, reviewer.id, ["view"]]);
  await db.query("INSERT INTO hs_data_collection_grants(tenant_id,user_id,collection,capabilities) VALUES($1,$2,'employees',$3)", [ctx.tenantId, configured.id, ["manage-staff-lifecycle"]]);
});
afterAll(async () => db.close());

async function confirm(preview: { previewId: string; reviewHash: string; confirm: "configure-staff-lifecycle" | "assign-staff-lifecycle" | "create-staff-lifecycle" | "transition-staff-lifecycle" | "checklist-staff-lifecycle" | "link-accounts-staff-lifecycle" | "name-recipient-staff-lifecycle" | "complete-handover-staff-lifecycle" | "identity-evidence-staff-lifecycle" }, operationId = crypto.randomUUID(), actor: RecordContext = ctx) {
  return life.confirm(actor, { operationId, previewId: preview.previewId, reviewHash: preview.reviewHash, confirm: preview.confirm });
}
async function configure(acknowledgementRequired: boolean) {
  return confirm(await life.preview(ctx, { action: "configure", acknowledgementRequired }));
}
async function assign(userId: string, rights = { canMaintain: true, canHandover: true, canRecordEvidence: true }) {
  return confirm(await life.preview(ctx, { action: "assign", userId, ...rights }));
}
async function organisation(name = "North Clinic") {
  return (await life.create(ctx, { operationId: crypto.randomUUID(), collection: "organisations", name, schemaVersion: 1, values: {} })).record;
}
async function account(orgId: string, name = "Ward account") {
  return (await life.create(ctx, { operationId: crypto.randomUUID(), collection: "accounts", name, schemaVersion: 1, values: {}, parentOrganisationId: orgId })).record;
}
async function employee(name: string, values: Record<string, unknown> = {}) {
  return (await life.create(ctx, { operationId: crypto.randomUUID(), collection: "employees", name, schemaVersion: 1, values })).record;
}
async function step(lifecycleId: string, version: number, to: "start" | "active" | "leaving" | "left", date: string | null) {
  return confirm(await life.preview(ctx, { action: "transition", lifecycleId, expectedVersion: version, to, date }));
}

it("moves an employee through lifecycle states, blocks an incomplete handover, and keeps identity evidence separate", async () => {
  expect((await configure(true)).version).toBe(1);
  await assign(owner.id);
  const org = await organisation();
  const linked = await account(org.id);
  const person = await employee("Ward Nurse");
  const personVersion = Number((await db.query<{ version: number }>("SELECT version FROM hs_data_records WHERE id=$1", [person.id])).rows[0].version);
  const preview = await life.preview(ctx, { action: "create", employeeRecordId: person.id, plannedOn: "2026-04-01", directoryUserId: reader.id, checklist: [] });
  const operationId = crypto.randomUUID();
  const created = await confirm(preview, operationId);
  expect(created).toMatchObject({ state: "planned", accessTransferred: false, credentialsTransferred: false, accessRevoked: false, replayed: false });
  expect((await confirm(preview, operationId)).replayed).toBe(true);
  await expect(life.confirm(ctx, { operationId, previewId: preview.previewId, reviewHash: "b".repeat(64), confirm: preview.confirm })).rejects.toMatchObject({ code: "operation_mismatch" });
  expect(Number((await db.query<{ n: string }>("SELECT count(*)::text AS n FROM hs_staff_lifecycles WHERE tenant_id=$1", [ctx.tenantId])).rows[0].n)).toBe(1);
  expect(Number((await db.query<{ version: number }>("SELECT version FROM hs_data_records WHERE id=$1", [person.id])).rows[0].version)).toBe(personVersion);
  const lifecycleId = String(created.lifecycleId);
  await expect(life.preview(ctx, { action: "transition", lifecycleId, expectedVersion: 1, to: "active", date: null })).rejects.toMatchObject({ code: "lifecycle_status" });
  await expect(life.preview(ctx, { action: "transition", lifecycleId, expectedVersion: 1, to: "start", date: "2026-02-31" })).rejects.toMatchObject({ code: "lifecycle_invalid" });
  const started = await step(lifecycleId, 1, "start", "2026-05-01");
  const active = await step(lifecycleId, Number(started.appliedVersion), "active", null);
  const leaving = await step(lifecycleId, Number(active.appliedVersion), "leaving", "2026-11-01");
  const checklist = await confirm(await life.preview(ctx, { action: "checklist", lifecycleId, expectedVersion: Number(leaving.appliedVersion), items: [{ id: crypto.randomUUID(), phase: "offboarding", title: "Return badge", dueOn: "2026-11-15", ownerUserId: owner.id, done: false }] }));
  const grants = JSON.stringify((await db.query("SELECT user_id, collection, capabilities FROM hs_data_collection_grants WHERE tenant_id=$1 ORDER BY user_id, collection", [ctx.tenantId])).rows);
  const linkedAccounts = await confirm(await life.preview(ctx, { action: "link-accounts", lifecycleId, expectedVersion: Number(checklist.appliedVersion), accountIds: [linked.id] }));
  expect(linkedAccounts).toMatchObject({ accessTransferred: false, credentialsTransferred: false, loginChanged: false, responsibilityMoved: false });
  expect(Number((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM hs_data_relationships WHERE tenant_id=$1 AND kind='employee-account'", [ctx.tenantId])).rows[0].n)).toBe(0);
  expect(Number((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM hs_data_record_grants WHERE tenant_id=$1", [ctx.tenantId])).rows[0].n)).toBe(0);
  await expect(life.preview(ctx, { action: "name-recipient", lifecycleId, expectedVersion: Number(linkedAccounts.appliedVersion), recipientUserId: outsider.id })).rejects.toMatchObject({ code: "handover_target_unavailable", status: 422 });
  expect(JSON.stringify((await db.query("SELECT user_id, collection, capabilities FROM hs_data_collection_grants WHERE tenant_id=$1 ORDER BY user_id, collection", [ctx.tenantId])).rows)).toBe(grants);
  const named = await confirm(await life.preview(ctx, { action: "name-recipient", lifecycleId, expectedVersion: Number(linkedAccounts.appliedVersion), recipientUserId: reviewer.id }));
  expect(named).toMatchObject({ recipientUserId: reviewer.id, credentialsTransferred: false, accessTransferred: false });
  await db.query("INSERT INTO hs_data_record_responsibility(tenant_id,record_id,user_id) VALUES($1,$2,$3)", [ctx.tenantId, org.id, reader.id]);
  const workflowId = crypto.randomUUID();
  await db.query("INSERT INTO hs_data_review_workflows(id,tenant_id,collection,name,definition,created_by) VALUES($1,$2,'organisations','Staff review',$3,$4)", [workflowId, ctx.tenantId, JSON.stringify({}), owner.id]);
  await db.query("INSERT INTO hs_data_review_workflow_versions(tenant_id,workflow_id,version,name,deprecated,definition,schema_version,actor_id) VALUES($1,$2,1,'Staff review',false,$3,1,$4)", [ctx.tenantId, workflowId, JSON.stringify({}), owner.id]);
  await db.query("INSERT INTO hs_data_reviews(id,tenant_id,workflow_id,workflow_version,record_id,record_version,schema_version,status,submitted_by) VALUES($1,$2,$3,1,$4,$5,1,'pending',$6)", [crypto.randomUUID(), ctx.tenantId, workflowId, org.id, org.version, reader.id]);
  await expect(life.preview(ctx, { action: "complete-handover", lifecycleId, expectedVersion: Number(named.appliedVersion), exceptionsAcknowledged: false, exceptionNote: null })).rejects.toMatchObject({ code: "handover_outstanding" });
  await expect(life.preview(ctx, { action: "complete-handover", lifecycleId, expectedVersion: Number(named.appliedVersion), exceptionsAcknowledged: true, exceptionNote: null })).rejects.toMatchObject({ code: "handover_outstanding" });
  const completed = await confirm(await life.preview(ctx, { action: "complete-handover", lifecycleId, expectedVersion: Number(named.appliedVersion), exceptionsAcknowledged: true, exceptionNote: "Badge and the open approval stay with the employee record." }));
  expect(completed).toMatchObject({ handoverState: "complete", cleanHandover: false, accessTransferred: false, credentialsTransferred: false, accessRevoked: false, loginChanged: false });
  expect((await db.query<{ user_id: string }>("SELECT user_id FROM hs_data_record_responsibility WHERE tenant_id=$1 AND record_id=$2", [ctx.tenantId, org.id])).rows[0].user_id).toBe(reader.id);
  expect(JSON.stringify((await db.query("SELECT user_id, collection, capabilities FROM hs_data_collection_grants WHERE tenant_id=$1 ORDER BY user_id, collection", [ctx.tenantId])).rows)).toBe(grants);
  const hidden = await life.listLifecycles(as(reader), {});
  expect(hidden.lifecycles[0]?.outstanding.hiddenCount).toBeGreaterThan(0);
  expect(JSON.stringify(hidden)).not.toContain("North Clinic");
  const left = await step(lifecycleId, Number(completed.appliedVersion), "left", "2026-12-01");
  expect((await db.query<{ access_revoked: boolean }>("SELECT access_revoked FROM hs_staff_lifecycles WHERE id=$1", [lifecycleId])).rows[0].access_revoked).toBe(false);
  await expect(life.preview(ctx, { action: "identity-evidence", lifecycleId, expectedVersion: Number(left.appliedVersion), evidenceReference: " ", sourceSystem: "directory-idp", observedAccessRevoked: true })).rejects.toMatchObject({ code: "access_revoked_without_evidence" });
  expect((await db.query<{ access_revoked: boolean }>("SELECT access_revoked FROM hs_staff_lifecycles WHERE id=$1", [lifecycleId])).rows[0].access_revoked).toBe(false);
  const evidenceOperation = crypto.randomUUID();
  const evidence = await confirm(await life.preview(ctx, { action: "identity-evidence", lifecycleId, expectedVersion: Number(left.appliedVersion), evidenceReference: "idp-evt-3154", sourceSystem: "directory-idp", observedAccessRevoked: true }), evidenceOperation);
  expect(evidence).toMatchObject({ accessRevoked: true, evidenceClass: "identity-evidence", credentialsTransferred: false });
  const history = await life.lifecycleHistory(ctx, { lifecycleId });
  const hr = history.events.filter((event) => event.evidenceClass === "hr-record");
  const identity = history.events.filter((event) => event.evidenceClass === "identity-evidence");
  expect(hr.length).toBeGreaterThan(0);
  expect(hr.every((event) => event.accessRevoked === false && event.source === "holy-sheet" && event.revocationClaim === "hr-record")).toBe(true);
  expect(identity).toEqual([expect.objectContaining({ accessRevoked: true, source: "directory-idp", evidenceReference: "idp-evt-3154", revocationClaim: "identity-evidence", actorId: owner.id })]);
  const hrAudit = (await db.query<{ after_value: { actorId: string; source: string; evidenceClass: string; operation: string; at: string; accessRevoked: boolean } }>("SELECT after_value FROM hs_audit WHERE action='staff-lifecycle.transition' AND correlation_id IS NOT NULL ORDER BY created_at DESC LIMIT 1")).rows[0].after_value;
  expect(hrAudit).toMatchObject({ actorId: owner.id, source: "holy-sheet", evidenceClass: "hr-record", operation: "staff-lifecycle.transition", accessRevoked: false });
  expect(hrAudit.at).toBe(now.toISOString());
  const identityAudit = (await db.query<{ after_value: { actorId: string; source: string; evidenceClass: string; operation: string; at: string; accessRevoked: boolean } }>("SELECT after_value FROM hs_audit WHERE action='staff-lifecycle.identity-evidence' AND correlation_id=$1", [evidenceOperation])).rows[0].after_value;
  expect(identityAudit).toMatchObject({ actorId: owner.id, source: "directory-idp", evidenceClass: "identity-evidence", operation: "staff-lifecycle.identity-evidence", accessRevoked: true, at: now.toISOString() });
  expect(JSON.stringify(identityAudit)).not.toContain("password");
  expect((await configure(false)).version).toBe(2);
  const versions = await db.query<{ version: number; acknowledgement_required: boolean }>("SELECT version, acknowledgement_required FROM hs_staff_lifecycle_policy_versions WHERE tenant_id=$1 ORDER BY version", [ctx.tenantId]);
  expect(versions.rows.map((row) => ({ version: Number(row.version), acknowledgement_required: row.acknowledgement_required === true }))).toEqual([{ version: 1, acknowledgement_required: true }, { version: 2, acknowledgement_required: false }]);
  const otherTenant = crypto.randomUUID();
  const otherWorkspace = `lifecycle-other-${crypto.randomUUID()}`;
  await db.query("INSERT INTO hs_workspaces(id,name) VALUES($1,$1)", [otherWorkspace]);
  await db.query("INSERT INTO hs_members(workspace_id,user_id) VALUES($1,$2)", [otherWorkspace, owner.id]);
  await db.query("INSERT INTO hs_data_tenants(id,name) VALUES($1,'Other tenant')", [otherTenant]);
  await db.query("INSERT INTO hs_data_workspaces(workspace_id,tenant_id,review_reference) VALUES($1,$2,'Other fixture')", [otherWorkspace, otherTenant]);
  await db.query("INSERT INTO hs_data_collections(tenant_id,id,name,core) VALUES($1,'employees','Employees',true)", [otherTenant]);
  await db.query("INSERT INTO hs_data_collection_grants(tenant_id,user_id,collection,capabilities) VALUES($1,$2,'employees',$3)", [otherTenant, owner.id, [...recordCapabilities]]);
  const foreign = (await life.create({ ...ctx, tenantId: otherTenant, workspaceId: otherWorkspace }, { operationId: crypto.randomUUID(), collection: "employees", name: "Foreign Nurse", schemaVersion: 1, values: {} })).record;
  const before = Number((await db.query<{ n: string }>("SELECT count(*)::text AS n FROM hs_staff_lifecycles WHERE tenant_id=$1", [ctx.tenantId])).rows[0].n);
  await expect(life.preview(ctx, { action: "create", employeeRecordId: foreign.id, plannedOn: "2026-04-01", directoryUserId: null, checklist: [] })).rejects.toMatchObject({ code: "lifecycle_cross_tenant", status: 404 });
  expect(Number((await db.query<{ n: string }>("SELECT count(*)::text AS n FROM hs_staff_lifecycles WHERE tenant_id=$1", [ctx.tenantId])).rows[0].n)).toBe(before);
  const draftOperation = crypto.randomUUID();
  const draft = { draftId: crypto.randomUUID(), employeeRecordId: person.id, directoryUserId: null, plannedOn: "2026-04-01", startOn: null, leavingOn: null, leftOn: null, checklist: [], accountIds: [], recipientUserId: null, exceptionsAcknowledged: false, exceptionNote: null, operationId: draftOperation, expectedVersion: 0 };
  const saved = await life.saveDraft(ctx, draft);
  expect((await life.saveDraft(ctx, draft)).replayed).toBe(true);
  await expect(life.saveDraft(ctx, { ...draft, plannedOn: "2026-06-01" })).rejects.toMatchObject({ code: "operation_mismatch" });
  expect((await life.listLifecycles(ctx, {})).drafts).toHaveLength(1);
  const discardOperation = crypto.randomUUID();
  expect((await life.discardDraft(ctx, { draftId: String(saved.draftId), operationId: discardOperation, expectedVersion: 1 })).state).toBe("discarded");
  expect((await life.discardDraft(ctx, { draftId: String(saved.draftId), operationId: discardOperation, expectedVersion: 1 })).replayed).toBe(true);
  expect((await life.listLifecycles(ctx, {})).drafts).toHaveLength(0);
  const restored = await life.restoreDraft(ctx, { draftId: String(saved.draftId), operationId: crypto.randomUUID(), expectedVersion: 2 });
  expect(restored.state).toBe("open");
  expect((await life.listLifecycles(ctx, {})).drafts[0]).toMatchObject({ employeeRecordId: person.id, state: "open" });
});

it("denies data access from configuration and assignment, and redacts employee fields on search, download, and history", async () => {
  await db.query("INSERT INTO hs_data_field_permissions(tenant_id,collection,field_key,user_id,can_view,can_write,can_history) VALUES($1,'employees','core:email',$2,true,true,true)", [ctx.tenantId, owner.id]);
  await assign(owner.id);
  await assign(assigned.id);
  const grants = JSON.stringify((await db.query("SELECT user_id, collection, capabilities FROM hs_data_collection_grants WHERE tenant_id=$1 ORDER BY user_id, collection", [ctx.tenantId])).rows);
  const person = await employee("Ward Nurse", { "core:email": secret });
  const created = await confirm(await life.preview(ctx, { action: "create", employeeRecordId: person.id, plannedOn: "2026-04-01", directoryUserId: null, checklist: [] }));
  expect(JSON.stringify((await db.query("SELECT user_id, collection, capabilities FROM hs_data_collection_grants WHERE tenant_id=$1 ORDER BY user_id, collection", [ctx.tenantId])).rows)).toBe(grants);
  expect(Number((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM hs_data_record_grants WHERE tenant_id=$1", [ctx.tenantId])).rows[0].n)).toBe(0);
  const hidden = await life.listLifecycles(as(configured), {});
  expect(JSON.stringify(hidden)).not.toContain("Ward Nurse");
  expect(JSON.stringify(hidden)).not.toContain(secret);
  expect(hidden.policy?.accessGranted).toBe(false);
  await expect(life.listLifecycles(as(configured), { lifecycleId: String(created.lifecycleId) })).rejects.toMatchObject({ status: 404 });
  await expect(life.download(as(configured), { lifecycleId: String(created.lifecycleId) })).rejects.toMatchObject({ status: 404 });
  const assignedView = await life.listLifecycles(as(assigned), { query: "ward" });
  expect(JSON.stringify(assignedView)).not.toContain("Ward Nurse");
  await expect(life.preview(as(assigned), { action: "transition", lifecycleId: String(created.lifecycleId), expectedVersion: 1, to: "start", date: "2026-05-01" })).rejects.toMatchObject({ status: 404 });
  await expect(life.preview(as(reader), { action: "transition", lifecycleId: String(created.lifecycleId), expectedVersion: 1, to: "start", date: "2026-05-01" })).rejects.toMatchObject({ status: 403 });
  const visible = await life.listLifecycles(as(reader), { query: "ward nurse" });
  expect(visible.lifecycles).toHaveLength(1);
  expect(JSON.stringify(visible)).not.toContain(secret);
  expect((await life.listLifecycles(as(reader), { query: secret })).lifecycles).toHaveLength(0);
  await expect(life.download(as(reader), { lifecycleId: String(created.lifecycleId) })).rejects.toMatchObject({ status: 403 });
  await expect(life.lifecycleHistory(as(reader), { lifecycleId: String(created.lifecycleId) })).rejects.toMatchObject({ status: 403 });
  await db.query("UPDATE hs_data_collection_grants SET capabilities=$3 WHERE tenant_id=$1 AND user_id=$2 AND collection='employees'", [ctx.tenantId, reader.id, ["view", "export", "history"]]);
  const file = await life.download(as(reader), { lifecycleId: String(created.lifecycleId) });
  expect(file.bytes.toString("utf8")).not.toContain(secret);
  expect(JSON.parse(file.bytes.toString("utf8"))).toMatchObject({ accessTransferred: false, credentialsTransferred: false, provisionsAccount: false });
  const history = await life.lifecycleHistory(as(reader), { lifecycleId: String(created.lifecycleId) });
  expect(JSON.stringify(history)).not.toContain(secret);
  expect(history.events[0]).toMatchObject({ evidenceClass: "hr-record", source: "holy-sheet", accessRevoked: false, actorId: owner.id });
  expect(history.events[0]?.at).toBeTruthy();
});
