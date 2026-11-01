import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { localActor as owner, type Actor } from "./auth";
import { ContractChangeRepository } from "./contract-changes-store";
import { createDatabase, type Database } from "./database";
import { Repository } from "./repository";
import type { CurrentSuiteTenantAuthority, RecordContext } from "./shared-records";
import { recordCapabilities } from "./shared-record-types";

let db: Database;
let changes: ContractChangeRepository;
let ctx: RecordContext;
let now = new Date("2026-11-01T12:00:00.000Z");
const reader: Actor = { id: "contract-reader" };
const reviewer: Actor = { id: "contract-reviewer" };
const configured: Actor = { id: "contract-config" };
const assigned: Actor = { id: "contract-assigned" };
const zone = "Asia/Calcutta";
const secret = "250099";
const authority: CurrentSuiteTenantAuthority = { verify: async (context) => ({ subject: context.actor.id, tenantId: context.tenantId, workspaceId: context.workspaceId, active: true, tenantAdministrator: false, revision: "synthetic-contract-changes-v1" }) };
const as = (actor: Actor): RecordContext => ({ ...ctx, actor });

beforeAll(async () => {
  db = await createDatabase(":memory:");
  await new Repository(db).seedLocal();
  for (const actor of [reader, reviewer, configured, assigned]) await db.query("INSERT INTO hs_users(id,name) VALUES($1,$1)", [actor.id]);
  changes = new ContractChangeRepository(new Repository(db), authority, undefined, () => now);
});
beforeEach(async () => {
  now = new Date("2026-11-01T12:00:00.000Z");
  ctx = { actor: owner, tenantId: crypto.randomUUID(), workspaceId: `contract-${crypto.randomUUID()}` };
  await db.query("INSERT INTO hs_workspaces(id,name) VALUES($1,$1)", [ctx.workspaceId]);
  for (const actor of [owner, reader, reviewer, configured, assigned]) await db.query("INSERT INTO hs_members(workspace_id,user_id) VALUES($1,$2)", [ctx.workspaceId, actor.id]);
  await db.query("INSERT INTO hs_data_tenants(id,name) VALUES($1,$2)", [ctx.tenantId, "Synthetic tenant"]);
  await db.query("INSERT INTO hs_data_workspaces(workspace_id,tenant_id,review_reference) VALUES($1,$2,$3)", [ctx.workspaceId, ctx.tenantId, "Synthetic fixture only"]);
  await db.query("INSERT INTO hs_data_collections(tenant_id,id,name,core) VALUES($1,'organisations','Organisations',true),($1,'contracts','Contracts',true)", [ctx.tenantId]);
  await db.query("INSERT INTO hs_data_collection_grants(tenant_id,user_id,collection,capabilities) VALUES($1,$2,'organisations',$3),($1,$2,'contracts',$3)", [ctx.tenantId, owner.id, [...recordCapabilities]]);
  await db.query("INSERT INTO hs_data_collection_grants(tenant_id,user_id,collection,capabilities) VALUES($1,$2,'contracts',$3)", [ctx.tenantId, reviewer.id, ["view", "review"]]);
  await db.query("INSERT INTO hs_data_collection_grants(tenant_id,user_id,collection,capabilities) VALUES($1,$2,'contracts',$3)", [ctx.tenantId, reader.id, ["view"]]);
  await db.query("INSERT INTO hs_data_collection_grants(tenant_id,user_id,collection,capabilities) VALUES($1,$2,'contracts',$3)", [ctx.tenantId, configured.id, ["manage-contract-changes"]]);
});
afterAll(async () => db.close());

async function confirm(preview: { previewId: string; reviewHash: string; confirm: "configure-contract-change" | "assign-contract-change" | "create-contract-change" | "propose-contract-change" | "approve-contract-change" | "effectuate-contract-change" | "decide-contract-change" }, operationId = crypto.randomUUID(), actor: RecordContext = ctx) {
  return changes.confirm(actor, { operationId, previewId: preview.previewId, reviewHash: preview.reviewHash, confirm: preview.confirm });
}
async function configure(reviewRequired: boolean) {
  return confirm(await changes.preview(ctx, { action: "configure", reviewRequired }));
}
async function assign(userId: string, rights = { canPropose: true, canApprove: true, canEffectuate: true, canDecide: true }) {
  return confirm(await changes.preview(ctx, { action: "assign", userId, ...rights }));
}
async function organisation(name = "North Clinic") {
  return (await changes.create(ctx, { operationId: crypto.randomUUID(), collection: "organisations", name, schemaVersion: 1, values: {} })).record;
}
async function contract(name: string, orgId: string, values: Record<string, unknown> = {}) {
  return (await changes.create(ctx, { operationId: crypto.randomUUID(), collection: "contracts", name, schemaVersion: 1, values, legalOrganisationIds: [orgId] })).record;
}
async function supporting(recordIds: string[], workspaceId = ctx.workspaceId, tenantId = ctx.tenantId) {
  const fileId = crypto.randomUUID();
  await db.query("INSERT INTO hs_linked_files(id,workspace_id,tenant_id,name,owner_id) VALUES($1,$2,$3,'contract.pdf',$4)", [fileId, workspaceId, tenantId, owner.id]);
  await db.query("INSERT INTO hs_attachment_versions(id,file_id,workspace_id,tenant_id,version_no,blob_key,checksum,size,mime,name,scan_status,uploader_id) VALUES($1,$2,$3,$4,1,$5,$6,12,'application/pdf','contract.pdf','clean',$7)", [crypto.randomUUID(), fileId, workspaceId, tenantId, crypto.randomUUID(), "ab".repeat(32), owner.id]);
  for (const recordId of recordIds) await db.query("INSERT INTO hs_document_record_links(id,workspace_id,tenant_id,doc_type,doc_id,record_id,created_by) VALUES($1,$2,$3,'file',$4,$5,$6)", [crypto.randomUUID(), workspaceId, tenantId, fileId, recordId, owner.id]);
  return fileId;
}
function relation(parentId: string, successorId: string, fileId: string, kind: "amendment" | "extension" | "renewal" = "amendment", start = "2027-01-01T00:00:00+05:30") {
  return changes.preview(ctx, { action: "create", kind, parentRecordId: parentId, successorRecordId: successorId, start, timezone: zone, documentFileId: fileId, documentVersionNo: 1, proposedEnd: "2028-01-01", decision: "undecided", responsibleUserId: null });
}
function historyOf(value: unknown) {
  const parsed = typeof value === "string" ? JSON.parse(value) as unknown : value;
  return Array.isArray(parsed) ? parsed.map(Number) : parsed;
}

it("creates a typed relation, rejects cycles and cross-tenant references, and keeps original terms and document history", async () => {
  await assign(owner.id);
  const org = await organisation();
  const first = await contract("Original Master", org.id, { "core:reference": "C-100", "core:end-date": "2026-12-31" });
  const second = await contract("First Successor", org.id, { "core:reference": "C-200", "core:end-date": "2027-06-30" });
  const third = await contract("Second Successor", org.id, { "core:reference": "C-300" });
  const fileId = await supporting([first.id, second.id, third.id]);
  await expect(relation(org.id, first.id, fileId)).rejects.toMatchObject({ code: "change_invalid" });
  await expect(relation(first.id, first.id, fileId)).rejects.toMatchObject({ code: "change_cycle" });
  const preview = await relation(first.id, second.id, fileId, "amendment");
  const operationId = crypto.randomUUID();
  const created = await confirm(preview, operationId);
  expect(created).toMatchObject({ status: "draft", kind: "amendment", documentVersionNo: 1, legalCommitment: false, replayed: false });
  expect((await confirm(preview, operationId)).replayed).toBe(true);
  await expect(changes.confirm(ctx, { operationId, previewId: preview.previewId, reviewHash: "b".repeat(64), confirm: preview.confirm })).rejects.toMatchObject({ code: "operation_mismatch" });
  expect(Number((await db.query<{ n: string }>("SELECT count(*)::text AS n FROM hs_contract_changes WHERE tenant_id=$1", [ctx.tenantId])).rows[0].n)).toBe(1);
  expect(Number((await db.query<{ version: number }>("SELECT version FROM hs_data_records WHERE id=$1", [first.id])).rows[0].version)).toBe(1);
  const stored = (await db.query<{ document_version_no: number; document_history: unknown; parent_terms: { values?: { "core:reference"?: string } } }>("SELECT document_version_no, document_history, parent_terms FROM hs_contract_changes WHERE id=$1", [created.changeId])).rows[0];
  expect(Number(stored.document_version_no)).toBe(1);
  expect(historyOf(stored.document_history)).toEqual([1]);
  expect(JSON.stringify(stored.parent_terms)).toContain("C-100");
  await db.query("INSERT INTO hs_attachment_versions(id,file_id,workspace_id,tenant_id,version_no,blob_key,checksum,size,mime,name,scan_status,uploader_id) VALUES($1,$2,$3,$4,2,$5,$6,12,'application/pdf','contract-v2.pdf','clean',$7)", [crypto.randomUUID(), fileId, ctx.workspaceId, ctx.tenantId, crypto.randomUUID(), "cd".repeat(32), owner.id]);
  const pinned = (await db.query<{ document_version_no: number; document_history: unknown }>("SELECT document_version_no, document_history FROM hs_contract_changes WHERE id=$1", [created.changeId])).rows[0];
  expect(Number(pinned.document_version_no)).toBe(1);
  expect(historyOf(pinned.document_history)).toEqual([1]);
  expect(Number((await db.query<{ n: string }>("SELECT count(*)::text AS n FROM hs_attachment_versions WHERE file_id=$1", [fileId])).rows[0].n)).toBe(2);
  const onward = await confirm(await relation(second.id, third.id, fileId, "extension"));
  expect(onward.status).toBe("draft");
  await expect(relation(third.id, first.id, fileId, "renewal")).rejects.toMatchObject({ code: "change_cycle" });
  await expect(relation(second.id, first.id, fileId)).rejects.toMatchObject({ code: "change_cycle" });
  const otherTenant = crypto.randomUUID();
  const otherWorkspace = `contract-other-${crypto.randomUUID()}`;
  await db.query("INSERT INTO hs_workspaces(id,name) VALUES($1,$1)", [otherWorkspace]);
  await db.query("INSERT INTO hs_members(workspace_id,user_id) VALUES($1,$2)", [otherWorkspace, owner.id]);
  await db.query("INSERT INTO hs_data_tenants(id,name) VALUES($1,'Other tenant')", [otherTenant]);
  await db.query("INSERT INTO hs_data_workspaces(workspace_id,tenant_id,review_reference) VALUES($1,$2,'Other fixture')", [otherWorkspace, otherTenant]);
  await db.query("INSERT INTO hs_data_collections(tenant_id,id,name,core) VALUES($1,'organisations','Organisations',true),($1,'contracts','Contracts',true)", [otherTenant]);
  await db.query("INSERT INTO hs_data_collection_grants(tenant_id,user_id,collection,capabilities) VALUES($1,$2,'organisations',$3),($1,$2,'contracts',$3)", [otherTenant, owner.id, [...recordCapabilities]]);
  const otherCtx = { ...ctx, tenantId: otherTenant, workspaceId: otherWorkspace };
  const otherOrg = (await changes.create(otherCtx, { operationId: crypto.randomUUID(), collection: "organisations", name: "Other Clinic", schemaVersion: 1, values: {} })).record;
  const otherContract = (await changes.create(otherCtx, { operationId: crypto.randomUUID(), collection: "contracts", name: "Foreign Contract", schemaVersion: 1, values: { "core:reference": "FOREIGN" }, legalOrganisationIds: [otherOrg.id] })).record;
  const before = Number((await db.query<{ n: string }>("SELECT count(*)::text AS n FROM hs_contract_changes WHERE tenant_id=$1", [ctx.tenantId])).rows[0].n);
  await expect(relation(first.id, otherContract.id, fileId)).rejects.toMatchObject({ code: "change_cross_tenant", status: 404 });
  const foreignFile = crypto.randomUUID();
  await db.query("INSERT INTO hs_linked_files(id,workspace_id,tenant_id,name,owner_id) VALUES($1,$2,$3,'foreign.pdf',$4)", [foreignFile, otherWorkspace, otherTenant, owner.id]);
  await expect(relation(first.id, second.id, foreignFile)).rejects.toMatchObject({ code: "change_cross_tenant", status: 404 });
  expect(Number((await db.query<{ n: string }>("SELECT count(*)::text AS n FROM hs_contract_changes WHERE tenant_id=$1", [ctx.tenantId])).rows[0].n)).toBe(before);
  expect(JSON.stringify((await db.query("SELECT after_value FROM hs_audit WHERE action='contract-change.create' AND correlation_id=$1", [operationId])).rows)).not.toContain("contract.pdf");
});

it("keeps statuses distinct and follows the configured review and effective date", async () => {
  expect((await configure(true)).version).toBe(1);
  await assign(owner.id);
  await assign(reviewer.id, { canPropose: false, canApprove: true, canEffectuate: false, canDecide: false });
  const org = await organisation();
  const parent = await contract("Renewed Original", org.id, { "core:reference": "R-1", "core:end-date": "2026-12-31" });
  const successor = await contract("Renewed Successor", org.id, { "core:reference": "R-2", "core:end-date": "2028-12-31" });
  const fileId = await supporting([parent.id, successor.id]);
  const parentBefore = JSON.stringify((await db.query("SELECT version, field_values FROM hs_data_records WHERE id=$1", [parent.id])).rows[0]);
  const created = await confirm(await relation(parent.id, successor.id, fileId, "renewal"));
  const changeId = String(created.changeId);
  await expect(changes.preview(ctx, { action: "approve", changeId, expectedVersion: 1 })).rejects.toMatchObject({ code: "change_status" });
  await expect(changes.preview(ctx, { action: "effectuate", changeId, expectedVersion: 1 })).rejects.toMatchObject({ code: "change_status" });
  const proposed = await confirm(await changes.preview(ctx, { action: "propose", changeId, expectedVersion: 1 }));
  expect(proposed.status).toBe("proposed");
  await expect(changes.preview(ctx, { action: "approve", changeId, expectedVersion: Number(proposed.appliedVersion) })).rejects.toMatchObject({ code: "change_review", status: 403 });
  const approved = await confirm(await changes.preview(as(reviewer), { action: "approve", changeId, expectedVersion: Number(proposed.appliedVersion) }), crypto.randomUUID(), as(reviewer));
  expect(approved).toMatchObject({ status: "approved", legalCommitment: false, reviewPolicyVersion: 1 });
  await expect(changes.preview(ctx, { action: "effectuate", changeId, expectedVersion: Number(approved.appliedVersion) })).rejects.toMatchObject({ code: "change_not_due" });
  now = new Date("2027-02-01T00:00:00.000Z");
  const waiting = await changes.listChanges(ctx, {});
  expect(waiting.changes.find((change) => change.id === changeId)?.status).toBe("approved");
  expect(waiting.endDates[0]).toMatchObject({ legalCommitment: false, commitsRenewal: false, decision: { value: "undecided", explicit: true }, responsibility: { userId: null, explicit: true, assigned: false } });
  expect(waiting.note).toContain("does not sign, execute, or commit");
  const effective = await confirm(await changes.preview(ctx, { action: "effectuate", changeId, expectedVersion: Number(approved.appliedVersion) }));
  expect(effective).toMatchObject({ status: "effective", legalCommitment: false, commitsRenewal: false });
  expect(JSON.stringify((await db.query("SELECT version, field_values FROM hs_data_records WHERE id=$1", [parent.id])).rows[0])).toBe(parentBefore);
  const decided = await confirm(await changes.preview(ctx, { action: "decide", changeId, expectedVersion: Number(effective.appliedVersion), decision: "renew", responsibleUserId: reviewer.id }));
  expect(decided).toMatchObject({ status: "effective", decision: "renew", responsibleUserId: reviewer.id, legalCommitment: false, commitsRenewal: false });
  const viewed = await changes.listChanges(ctx, { query: "renewed original" });
  expect(viewed.endDates[0]).toMatchObject({ responsibility: { userId: reviewer.id, assigned: true }, decision: { value: "renew" }, legalCommitment: false, originalEnd: "2026-12-31" });
  expect((await configure(false)).version).toBe(2);
  const versions = await db.query<{ version: number; review_required: boolean }>("SELECT version, review_required FROM hs_contract_change_policy_versions WHERE tenant_id=$1 ORDER BY version", [ctx.tenantId]);
  expect(versions.rows).toEqual([{ version: 1, review_required: true }, { version: 2, review_required: false }]);
  const again = await contract("Direct Successor", org.id);
  const second = await confirm(await relation(successor.id, again.id, await supporting([successor.id, again.id]), "amendment", "2026-06-01T00:00:00+05:30"));
  const secondProposed = await confirm(await changes.preview(ctx, { action: "propose", changeId: String(second.changeId), expectedVersion: 1 }));
  const selfApproved = await confirm(await changes.preview(ctx, { action: "approve", changeId: String(second.changeId), expectedVersion: Number(secondProposed.appliedVersion) }));
  expect(selfApproved).toMatchObject({ status: "approved", reviewPolicyVersion: 2 });
  const audit = (await db.query<{ after_value: { actorId: string; source: string; operation: string; at: string } }>("SELECT after_value FROM hs_audit WHERE action='contract-change.approve' AND correlation_id IS NOT NULL ORDER BY created_at DESC LIMIT 1")).rows[0].after_value;
  expect(audit).toMatchObject({ actorId: owner.id, source: "holy-sheet", operation: "contract-change.approve" });
  expect(audit.at).toBeTruthy();
});

it("denies data access from configuration and assignment, redacts fields, replays drafts, and audits the actor", async () => {
  await db.query("INSERT INTO hs_data_field_permissions(tenant_id,collection,field_key,user_id,can_view,can_write,can_history) VALUES($1,'contracts','core:amount',$2,true,true,true)", [ctx.tenantId, owner.id]);
  await assign(owner.id);
  await assign(assigned.id, { canPropose: true, canApprove: true, canEffectuate: true, canDecide: true });
  const grants = JSON.stringify((await db.query("SELECT user_id, collection, capabilities FROM hs_data_collection_grants WHERE tenant_id=$1 ORDER BY user_id, collection", [ctx.tenantId])).rows);
  expect(Number((await db.query<{ n: number }>("SELECT count(*)::int AS n FROM hs_data_record_grants WHERE tenant_id=$1", [ctx.tenantId])).rows[0].n)).toBe(0);
  const org = await organisation();
  const parent = await contract("Secret Terms Contract", org.id, { "core:reference": "C-100", "core:end-date": "2026-12-31", "core:amount": { currency: "GBP", minorUnits: secret, scale: 2 } });
  const successor = await contract("Visible Successor", org.id);
  const fileId = await supporting([parent.id, successor.id]);
  const operationId = crypto.randomUUID();
  const created = await confirm(await relation(parent.id, successor.id, fileId, "renewal"), operationId);
  expect(JSON.stringify((await db.query("SELECT user_id, collection, capabilities FROM hs_data_collection_grants WHERE tenant_id=$1 ORDER BY user_id, collection", [ctx.tenantId])).rows)).toBe(grants);
  expect(JSON.stringify((await db.query("SELECT parent_terms FROM hs_contract_changes WHERE id=$1", [created.changeId])).rows)).toContain(secret);
  const hidden = await changes.listChanges(as(configured), {});
  expect(JSON.stringify(hidden)).not.toContain("Secret Terms Contract");
  expect(JSON.stringify(hidden)).not.toContain(secret);
  expect(hidden.policy?.accessGranted).toBe(false);
  await expect(changes.listChanges(as(configured), { changeId: String(created.changeId) })).rejects.toMatchObject({ status: 404 });
  await expect(changes.download(as(configured), { changeId: String(created.changeId) })).rejects.toMatchObject({ status: 404 });
  const assignedView = await changes.listChanges(as(assigned), { query: "secret" });
  expect(JSON.stringify(assignedView)).not.toContain("Secret Terms Contract");
  await expect(changes.preview(as(reader), { action: "propose", changeId: String(created.changeId), expectedVersion: 1 })).rejects.toMatchObject({ status: 403 });
  const visible = await changes.listChanges(as(reader), { query: "secret terms" });
  expect(visible.changes).toHaveLength(1);
  expect(JSON.stringify(visible)).not.toContain(secret);
  expect(JSON.stringify(visible.changes[0]?.originalTerms.values)).toContain("C-100");
  expect((await changes.listChanges(as(reader), { query: secret })).changes).toHaveLength(0);
  await expect(changes.download(as(reader), { changeId: String(created.changeId) })).rejects.toMatchObject({ status: 403 });
  await expect(changes.changeHistory(as(reader), { changeId: String(created.changeId) })).rejects.toMatchObject({ status: 403 });
  await db.query("UPDATE hs_data_collection_grants SET capabilities=$3 WHERE tenant_id=$1 AND user_id=$2 AND collection='contracts'", [ctx.tenantId, reader.id, ["view", "export", "history"]]);
  const file = await changes.download(as(reader), { changeId: String(created.changeId) });
  expect(file.bytes.toString("utf8")).not.toContain(secret);
  expect(JSON.parse(file.bytes.toString("utf8"))).toMatchObject({ legalCommitment: false, commitsRenewal: false, change: { document: { versionNo: 1, pinned: true } } });
  const history = await changes.changeHistory(as(reader), { changeId: String(created.changeId) });
  expect(JSON.stringify(history)).not.toContain(secret);
  expect(history.events[0]).toMatchObject({ status: "draft", source: "holy-sheet", actorId: owner.id });
  expect(history.events[0]?.at).toBeTruthy();
  const draftOperation = crypto.randomUUID();
  const draft = { draftId: crypto.randomUUID(), kind: "amendment" as const, parentRecordId: parent.id, successorRecordId: successor.id, start: "2028-01-01T00:00:00+05:30", proposedEnd: "2028-06-01", timezone: zone, documentFileId: fileId, documentVersionNo: 1, responsibleUserId: null, decision: "undecided" as const, operationId: draftOperation, expectedVersion: 0 };
  const saved = await changes.saveDraft(ctx, draft);
  expect((await changes.saveDraft(ctx, draft)).replayed).toBe(true);
  await expect(changes.saveDraft(ctx, { ...draft, start: "2029-01-01T00:00:00+05:30" })).rejects.toMatchObject({ code: "operation_mismatch" });
  expect((await changes.listChanges(ctx, {})).drafts).toHaveLength(1);
  const discardOperation = crypto.randomUUID();
  expect((await changes.discardDraft(ctx, { draftId: String(saved.draftId), operationId: discardOperation, expectedVersion: 1 })).state).toBe("discarded");
  expect((await changes.discardDraft(ctx, { draftId: String(saved.draftId), operationId: discardOperation, expectedVersion: 1 })).replayed).toBe(true);
  expect((await changes.listChanges(ctx, {})).drafts).toHaveLength(0);
  expect((await db.query<{ state: string }>("SELECT state FROM hs_contract_change_drafts WHERE id=$1", [saved.draftId])).rows[0].state).toBe("discarded");
  const restored = await changes.restoreDraft(ctx, { draftId: String(saved.draftId), operationId: crypto.randomUUID(), expectedVersion: 2 });
  expect(restored.state).toBe("open");
  expect((await changes.listChanges(ctx, {})).drafts[0]).toMatchObject({ parentRecordId: parent.id, state: "open" });
  const audit = (await db.query<{ after_value: { actorId: string; source: string; operation: string; at: string; legalCommitment: boolean } }>("SELECT after_value FROM hs_audit WHERE action='contract-change.create' AND correlation_id=$1", [operationId])).rows[0].after_value;
  expect(audit).toMatchObject({ actorId: owner.id, source: "holy-sheet", operation: "contract-change.create", legalCommitment: false });
  expect(audit.at).toBeTruthy();
  expect(JSON.stringify(audit)).not.toContain(secret);
  expect(JSON.stringify(audit)).not.toContain("contract.pdf");
});
