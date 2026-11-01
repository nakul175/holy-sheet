import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { localActor as owner, type Actor } from "./auth";
import { createDatabase, type Database } from "./database";
import { EffectiveDateRepository } from "./effective-dates-store";
import { Repository } from "./repository";
import type { CurrentSuiteTenantAuthority, RecordContext } from "./shared-records";
import { recordCapabilities } from "./shared-record-types";

let db: Database;
let dates: EffectiveDateRepository;
let ctx: RecordContext;
let now = new Date("2026-11-01T12:00:00.000Z");
const reader: Actor = { id: "effective-reader" };
const editor: Actor = { id: "effective-editor" };
const configured: Actor = { id: "effective-config" };
const secret = "hidden-field-secret";
const zone = "Asia/Calcutta";
const authority: CurrentSuiteTenantAuthority = { verify: async (context) => ({ subject: context.actor.id, tenantId: context.tenantId, workspaceId: context.workspaceId, active: true, tenantAdministrator: false, revision: "synthetic-effective-dates-v1" }) };
const as = (actor: Actor): RecordContext => ({ ...ctx, actor });

beforeAll(async () => {
  db = await createDatabase(":memory:");
  await new Repository(db).seedLocal();
  for (const actor of [reader, editor, configured]) await db.query("INSERT INTO hs_users(id,name) VALUES($1,$1)", [actor.id]);
  dates = new EffectiveDateRepository(new Repository(db), authority, undefined, () => now);
});
beforeEach(async () => {
  now = new Date("2026-11-01T12:00:00.000Z");
  ctx = { actor: owner, tenantId: crypto.randomUUID(), workspaceId: `effective-${crypto.randomUUID()}` };
  await db.query("INSERT INTO hs_workspaces(id,name) VALUES($1,$1)", [ctx.workspaceId]);
  for (const actor of [owner, reader, editor, configured]) await db.query("INSERT INTO hs_members(workspace_id,user_id) VALUES($1,$2)", [ctx.workspaceId, actor.id]);
  await db.query("INSERT INTO hs_data_tenants(id,name) VALUES($1,$2)", [ctx.tenantId, "Synthetic tenant"]);
  await db.query("INSERT INTO hs_data_workspaces(workspace_id,tenant_id,review_reference) VALUES($1,$2,$3)", [ctx.workspaceId, ctx.tenantId, "Synthetic fixture only"]);
  await db.query("INSERT INTO hs_data_collections(tenant_id,id,name,core) VALUES($1,'organisations','Organisations',true)", [ctx.tenantId]);
  await db.query("INSERT INTO hs_data_collection_grants(tenant_id,user_id,collection,capabilities) VALUES($1,$2,'organisations',$3)", [ctx.tenantId, owner.id, [...recordCapabilities]]);
});
afterAll(async () => db.close());

async function confirm(preview: { previewId: string; reviewHash: string; confirm: "configure-effective-field" | "assign-effective-access" | "propose-effective-value" | "activate-effective-value" | "cancel-effective-value" }, operationId = crypto.randomUUID()) {
  return dates.confirm(ctx, { operationId, previewId: preview.previewId, reviewHash: preview.reviewHash, confirm: preview.confirm });
}
async function enable(fieldKey = "core:registration") {
  return confirm(await dates.preview(ctx, { action: "configure", collection: "organisations", fieldKey, enabled: true }));
}
async function assign(userId: string, flags = { canPropose: true, canCorrect: true, canActivate: true, canCancel: true }) {
  return confirm(await dates.preview(ctx, { action: "assign", collection: "organisations", userId, ...flags }));
}
async function organisation(name = "North Clinic") {
  return (await dates.create(ctx, { operationId: crypto.randomUUID(), collection: "organisations", name, schemaVersion: 1, values: {} })).record;
}
function proposal(recordId: string, input: { fieldKey?: string; value?: unknown; start: string; end?: string | null; expectedRecordVersion?: number; reason?: string }) {
  return dates.preview(ctx, { action: "propose", collection: "organisations", recordId, fieldKey: input.fieldKey ?? "core:registration", value: input.value ?? "REG-100", start: input.start, end: input.end ?? null, timezone: zone, reason: input.reason, expectedRecordVersion: input.expectedRecordVersion ?? 1 });
}

it("proposes half-open values, rejects overlaps, and separates entered time from effective time", async () => {
  await enable();
  await assign(owner.id);
  const record = await organisation();
  await expect(proposal(record.id, { start: "2026-01-01T00:00:00Z", end: "2026-06-01T00:00:00Z" })).rejects.toMatchObject({ status: 400 });
  await expect(proposal(record.id, { start: "2026-01-01T00:00:00+05:30", end: "2026-06-01T00:00:00+05:30" })).rejects.toMatchObject({ status: 400 });
  const firstPreview = await proposal(record.id, { start: "2026-01-01T00:00:00+05:30", end: "2026-06-01T00:00:00+05:30", reason: "Fill the earlier registration window" });
  const firstOperation = crypto.randomUUID();
  const first = await confirm(firstPreview, firstOperation);
  expect(first).toMatchObject({ state: "ended", replayed: false, effectiveEnd: "2026-05-31T18:30:00.000Z" });
  expect((await confirm(firstPreview, firstOperation)).replayed).toBe(true);
  await expect(dates.confirm(ctx, { operationId: firstOperation, previewId: firstPreview.previewId, reviewHash: "b".repeat(64), confirm: firstPreview.confirm })).rejects.toMatchObject({ code: "operation_mismatch" });
  expect(Number((await db.query<{ n: string }>("SELECT count(*)::text AS n FROM hs_effective_intervals WHERE record_id=$1", [record.id])).rows[0].n)).toBe(1);
  const audit = JSON.stringify((await db.query("SELECT after_value FROM hs_audit WHERE correlation_id=$1 AND action='effective.propose'", [firstOperation])).rows);
  expect(audit).toContain("enteredAt");
  expect(audit).toContain("effectiveStart");
  expect(audit).not.toContain("REG-100");
  const auditRow = (await db.query<{ after_value: { enteredAt: string; effectiveStart: string; source: string; actorId: string; operation: string } }>("SELECT after_value FROM hs_audit WHERE correlation_id=$1 AND action='effective.propose'", [firstOperation])).rows[0].after_value;
  expect(auditRow.enteredAt).not.toBe(auditRow.effectiveStart);
  expect(auditRow).toMatchObject({ source: "holy-sheet", actorId: owner.id, operation: "effective.propose" });
  const second = await confirm(await proposal(record.id, { start: "2026-06-01T00:00:00+05:30", end: "2026-12-01T00:00:00+05:30", reason: "Open the current registration" }));
  expect(second.state).toBe("active");
  const touching = await dates.preview(ctx, { action: "propose", collection: "organisations", recordId: record.id, fieldKey: "core:registration", value: "REG-200", start: "2026-12-01T00:00:00+05:30", end: "2027-01-01T00:00:00+05:30", timezone: zone, expectedRecordVersion: 2 });
  expect((await confirm(touching)).state).toBe("scheduled");
  const overlap = dates.preview(ctx, { action: "propose", collection: "organisations", recordId: record.id, fieldKey: "core:registration", value: "REG-300", start: "2026-05-01T00:00:00+05:30", end: "2026-07-01T00:00:00+05:30", timezone: zone, reason: "This conflicts", expectedRecordVersion: 2 });
  await expect(overlap).rejects.toMatchObject({ code: "effective_overlap" });
  const current = await dates.get(ctx, record.id);
  expect(current.values["core:registration"]).toBe("REG-100");
  const inside = await dates.listEffective(ctx, { collection: "organisations", recordId: record.id, fieldKey: "core:registration", asOf: "2026-11-01T17:30:00+05:30" });
  expect(inside.asOf).toMatchObject({ state: "effective", value: "REG-100", calculation: { identified: true, engine: "effective-value", asOf: "2026-11-01T12:00:00.000Z" } });
  const boundary = await dates.listEffective(ctx, { collection: "organisations", recordId: record.id, fieldKey: "core:registration", asOf: "2026-06-01T00:00:00+05:30" });
  expect(boundary.asOf).toMatchObject({ state: "effective", value: "REG-100" });
  const excluded = await dates.listEffective(ctx, { collection: "organisations", recordId: record.id, fieldKey: "core:registration", asOf: "2026-12-01T00:00:00+05:30" });
  expect(excluded.asOf).toMatchObject({ state: "scheduled-pending", value: null });
  const file = await dates.download(ctx, { collection: "organisations", recordId: record.id, fieldKey: "core:registration", asOf: "2026-11-01T17:30:00+05:30" });
  const downloaded = JSON.parse(file.bytes.toString("utf8")) as { asOf: string; value: string; calculation: { engine: string } };
  expect(downloaded).toMatchObject({ asOf: "2026-11-01T12:00:00.000Z", value: "REG-100", calculation: { engine: "effective-value" } });
  expect(file.bytes.toString("utf8")).not.toContain("payroll");
});

it("rechecks a scheduled value at activation and cancels without removing the other interval", async () => {
  const choices = crypto.randomUUID();
  const reference = crypto.randomUUID();
  const sensitive = crypto.randomUUID();
  await db.query("INSERT INTO hs_data_fields(tenant_id,collection,field_key,label,kind,choices,created_by) VALUES($1,'organisations',$2,'Status','single-select',$3::jsonb,$4),($1,'organisations',$5,'Linked organisation','record','[]'::jsonb,$4)", [ctx.tenantId, choices, JSON.stringify(["alpha", "beta"]), owner.id, reference]);
  await db.query("INSERT INTO hs_data_fields(tenant_id,collection,field_key,label,kind,sensitive,created_by) VALUES($1,'organisations',$2,'Staff code','text',true,$3)", [ctx.tenantId, sensitive, owner.id]);
  await db.query("INSERT INTO hs_data_field_permissions(tenant_id,collection,field_key,user_id,can_view,can_write,can_history) VALUES($1,'organisations',$2,$3,true,true,true)", [ctx.tenantId, sensitive, owner.id]);
  await enable("core:registration");
  await enable(choices);
  await enable(reference);
  await enable(sensitive);
  await assign(owner.id);
  const record = await organisation();
  const target = await organisation("Target Clinic");
  const scheduled = await confirm(await proposal(record.id, { start: "2027-01-01T00:00:00+05:30", end: "2027-06-01T00:00:00+05:30" }));
  expect(scheduled.state).toBe("scheduled");
  await expect(dates.preview(ctx, { action: "activate", collection: "organisations", recordId: record.id, intervalId: String(scheduled.intervalId), expectedRecordVersion: 1 })).rejects.toMatchObject({ code: "effective_not_due" });
  now = new Date("2027-02-01T00:00:00.000Z");
  const activated = await confirm(await dates.preview(ctx, { action: "activate", collection: "organisations", recordId: record.id, intervalId: String(scheduled.intervalId), expectedRecordVersion: 1 }));
  expect(activated).toMatchObject({ state: "active" });
  const activationAudit = (await db.query<{ after_value: { enteredAt: string; effectiveStart: string; activatedAt: string } }>("SELECT after_value FROM hs_audit WHERE action='effective.activate' AND correlation_id IS NOT NULL ORDER BY created_at DESC LIMIT 1")).rows[0].after_value;
  expect(activationAudit.enteredAt).not.toBe(activationAudit.effectiveStart);
  expect(activationAudit.activatedAt).not.toBe(activationAudit.enteredAt);
  expect((await dates.get(ctx, record.id)).values["core:registration"]).toBe("REG-100");
  const blockedChoice = await confirm(await proposal(record.id, { fieldKey: choices, value: "alpha", start: "2027-07-01T00:00:00+05:30", end: null, expectedRecordVersion: 2 }));
  await db.query("UPDATE hs_data_fields SET choices=$2::jsonb WHERE tenant_id=$1 AND field_key=$3", [ctx.tenantId, JSON.stringify(["beta"]), choices]);
  now = new Date("2027-08-01T00:00:00.000Z");
  const blocked = await confirm(await dates.preview(ctx, { action: "activate", collection: "organisations", recordId: record.id, intervalId: String(blockedChoice.intervalId), expectedRecordVersion: 2 }));
  expect(blocked).toMatchObject({ state: "blocked", blockedCode: "schema_invalid" });
  expect((await dates.get(ctx, record.id)).values[choices]).toBeUndefined();
  const linked = await confirm(await proposal(record.id, { fieldKey: reference, value: [target.id], start: "2027-09-01T00:00:00+05:30", end: null, expectedRecordVersion: 2 }));
  const deletedAt = "2027-09-15T00:00:00.000Z";
  await db.query("UPDATE hs_data_records SET state='trashed', deleted_at=$2, trash_deadline=$2::timestamptz + interval '30 days', deleted_by=$3, before_trash_state='active' WHERE id=$1", [target.id, deletedAt, owner.id]);
  now = new Date("2027-10-01T00:00:00.000Z");
  const missingTarget = await confirm(await dates.preview(ctx, { action: "activate", collection: "organisations", recordId: record.id, intervalId: String(linked.intervalId), expectedRecordVersion: 2 }));
  expect(missingTarget).toMatchObject({ state: "blocked", blockedCode: "target_invalid" });
  const hidden = await confirm(await proposal(record.id, { fieldKey: sensitive, value: secret, start: "2027-11-01T00:00:00+05:30", end: null, expectedRecordVersion: 2 }));
  await db.query("DELETE FROM hs_data_field_permissions WHERE tenant_id=$1 AND field_key=$2", [ctx.tenantId, sensitive]);
  now = new Date("2027-12-01T00:00:00.000Z");
  const revoked = await confirm(await dates.preview(ctx, { action: "activate", collection: "organisations", recordId: record.id, intervalId: String(hidden.intervalId), expectedRecordVersion: 2 }));
  expect(revoked).toMatchObject({ state: "blocked", blockedCode: "rights_revoked" });
  expect(JSON.stringify((await db.query("SELECT field_values FROM hs_data_records WHERE id=$1", [record.id])).rows)).not.toContain(secret);
  expect(JSON.stringify((await db.query("SELECT after_value FROM hs_audit WHERE action='effective.block'")).rows)).not.toContain(secret);
  await db.query("INSERT INTO hs_data_field_permissions(tenant_id,collection,field_key,user_id,can_view,can_write,can_history) VALUES($1,'organisations',$2,$3,true,true,true)", [ctx.tenantId, sensitive, owner.id]);
  const version = Number((await dates.get(ctx, record.id)).version);
  const cancelled = await confirm(await dates.preview(ctx, { action: "cancel", collection: "organisations", recordId: record.id, intervalId: String(scheduled.intervalId), reason: "Close the current registration", expectedRecordVersion: version }));
  expect(cancelled.state).toBe("cancelled");
  const history = await dates.intervalHistory(ctx, { collection: "organisations", recordId: record.id, fieldKey: "core:registration" });
  expect(history.intervals.some((interval) => interval.state === "cancelled" && interval.enteredAt && interval.effectiveStart && interval.enteredAt !== interval.effectiveStart)).toBe(true);
  expect((await dates.listEffective(ctx, { collection: "organisations", recordId: record.id, fieldKey: "core:registration", asOf: "2027-02-01T00:00:00Z" })).asOf).toMatchObject({ state: "none", value: null });
  expect((await db.query<{ state: string }>("SELECT state FROM hs_effective_intervals WHERE id=$1", [blockedChoice.intervalId])).rows[0].state).toBe("blocked");
});

it("denies data access from configuration, assignment, search, download, and history", async () => {
  await enable();
  await assign(owner.id);
  await assign(reader.id);
  const record = await organisation("Secret Organisation");
  const saved = await confirm(await proposal(record.id, { value: secret, start: "2026-06-01T00:00:00+05:30", end: null, reason: "Backfill the visible registration" }));
  expect((await db.query("SELECT count(*)::int AS n FROM hs_data_record_grants WHERE tenant_id=$1", [ctx.tenantId])).rows[0].n).toBe(0);
  await expect(dates.listEffective(as(reader), { collection: "organisations", recordId: record.id })).rejects.toMatchObject({ status: 404 });
  await expect(dates.download(as(reader), { collection: "organisations", recordId: record.id, fieldKey: "core:registration", asOf: "2026-11-01T17:30:00+05:30" })).rejects.toMatchObject({ status: 404 });
  await db.query("INSERT INTO hs_data_collection_grants(tenant_id,user_id,collection,capabilities) VALUES($1,$2,'organisations',$3)", [ctx.tenantId, configured.id, ["manage-effective-dates"]]);
  const grants = JSON.stringify((await db.query("SELECT user_id, capabilities FROM hs_data_collection_grants WHERE tenant_id=$1 ORDER BY user_id", [ctx.tenantId])).rows);
  const configPreview = await dates.preview(as(configured), { action: "configure", collection: "organisations", fieldKey: "core:domain", enabled: true });
  await dates.confirm(as(configured), { operationId: crypto.randomUUID(), previewId: configPreview.previewId, reviewHash: configPreview.reviewHash, confirm: configPreview.confirm });
  expect(JSON.stringify((await db.query("SELECT user_id, capabilities FROM hs_data_collection_grants WHERE tenant_id=$1 ORDER BY user_id", [ctx.tenantId])).rows)).toBe(grants);
  await expect(dates.listEffective(as(configured), { collection: "organisations", recordId: record.id, asOf: "2026-11-01T17:30:00+05:30" })).rejects.toMatchObject({ status: 404 });
  await db.query("INSERT INTO hs_data_collection_grants(tenant_id,user_id,collection,capabilities) VALUES($1,$2,'organisations',$3)", [ctx.tenantId, reader.id, ["view", "history"]]);
  await expect(dates.preview(as(reader), { action: "propose", collection: "organisations", recordId: record.id, fieldKey: "core:registration", value: "OTHER", start: "2028-01-01T00:00:00+05:30", end: null, timezone: zone, expectedRecordVersion: 2 })).rejects.toMatchObject({ status: 403 });
  await expect(dates.download(as(reader), { collection: "organisations", recordId: record.id, fieldKey: "core:registration", asOf: "2026-11-01T17:30:00+05:30" })).rejects.toMatchObject({ status: 403 });
  const visible = await dates.listEffective(as(reader), { collection: "organisations", query: "secret", recordId: record.id });
  expect(JSON.stringify(visible)).toContain(secret);
  const versions = await db.query<{ version: number }>("SELECT version FROM hs_effective_field_policy_versions WHERE tenant_id=$1 AND field_key='core:registration' ORDER BY version", [ctx.tenantId]);
  expect(versions.rows.map((row) => Number(row.version))).toEqual([1]);
  await confirm(await dates.preview(ctx, { action: "configure", collection: "organisations", fieldKey: "core:registration", enabled: false }));
  const revised = await db.query("SELECT version, enabled FROM hs_effective_field_policy_versions WHERE tenant_id=$1 AND field_key='core:registration' ORDER BY version", [ctx.tenantId]);
  expect(revised.rows).toEqual([{ version: 1, enabled: true }, { version: 2, enabled: false }]);
  await expect(proposal(record.id, { start: "2028-01-01T00:00:00+05:30", expectedRecordVersion: Number((await dates.get(ctx, record.id)).version) })).rejects.toMatchObject({ code: "effective_not_configured" });
  const draftOperation = crypto.randomUUID();
  await enable();
  const draft = await dates.saveDraft(ctx, { draftId: crypto.randomUUID(), collection: "organisations", recordId: record.id, fieldKey: "core:registration", value: secret, start: "2028-02-01T00:00:00+05:30", end: null, timezone: zone, operationId: draftOperation, expectedVersion: 0 });
  expect((await dates.saveDraft(ctx, { draftId: String(draft.draftId), collection: "organisations", recordId: record.id, fieldKey: "core:registration", value: secret, start: "2028-02-01T00:00:00+05:30", end: null, timezone: zone, operationId: draftOperation, expectedVersion: 0 })).replayed).toBe(true);
  const openDrafts = await dates.listEffective(ctx, { collection: "organisations", recordId: record.id });
  expect(openDrafts.drafts).toHaveLength(1);
  const discardOperation = crypto.randomUUID();
  const discarded = await dates.discardDraft(ctx, { draftId: String(draft.draftId), collection: "organisations", operationId: discardOperation, expectedVersion: 1 });
  expect(discarded.state).toBe("discarded");
  expect((await dates.discardDraft(ctx, { draftId: String(draft.draftId), collection: "organisations", operationId: discardOperation, expectedVersion: 1 })).replayed).toBe(true);
  expect((await db.query<{ state: string }>("SELECT state FROM hs_effective_drafts WHERE id=$1", [draft.draftId])).rows[0].state).toBe("discarded");
  expect((await dates.listEffective(ctx, { collection: "organisations", recordId: record.id })).drafts).toHaveLength(0);
  expect(JSON.stringify((await db.query("SELECT after_value FROM hs_audit WHERE action='effective.draft' AND correlation_id=$1", [draftOperation])).rows)).not.toContain(secret);
  expect((await db.query<{ state: string }>("SELECT state FROM hs_effective_intervals WHERE id=$1", [saved.intervalId])).rows[0].state).toBe("active");
  await db.query("INSERT INTO hs_data_collection_grants(tenant_id,user_id,collection,capabilities) VALUES($1,$2,'organisations',$3)", [ctx.tenantId, editor.id, ["view", "edit", "history", "export"]]);
  await assign(editor.id, { canPropose: true, canCorrect: true, canActivate: true, canCancel: true });
  await expect(dates.preview(as(editor), { action: "propose", collection: "organisations", recordId: record.id, fieldKey: "core:registration", value: "LATE", start: "2020-01-01T00:00:00+05:30", end: "2020-02-01T00:00:00+05:30", timezone: zone, reason: "Needs the separate permission", expectedRecordVersion: Number((await dates.get(ctx, record.id)).version) })).rejects.toMatchObject({ status: 403 });
});
