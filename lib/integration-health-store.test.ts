import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { localActor as owner, type Actor } from "./auth";
import { createDatabase, type Database } from "./database";
import { IntegrationHealthRepository } from "./integration-health-store";
import { Repository } from "./repository";
import type { CurrentSuiteTenantAuthority, RecordContext } from "./shared-records";
import { recordCapabilities } from "./shared-record-types";

let db: Database;
let health: IntegrationHealthRepository;
let ctx: RecordContext;
const reader: Actor = { id: "integration-reader" };
const granted: Actor = { id: "integration-granted" };
const secret = "hidden-field-secret";
const authority: CurrentSuiteTenantAuthority = { verify: async (context) => ({ subject: context.actor.id, tenantId: context.tenantId, workspaceId: context.workspaceId, active: true, tenantAdministrator: false, revision: "synthetic-integration-health-v1" }) };
const as = (actor: Actor) => ({ ...ctx, actor });

beforeAll(async () => {
  db = await createDatabase(":memory:");
  await new Repository(db).seedLocal();
  for (const actor of [reader, granted]) await db.query("INSERT INTO hs_users(id,name) VALUES($1,$1)", [actor.id]);
  health = new IntegrationHealthRepository(new Repository(db), authority);
});
beforeEach(async () => {
  ctx = { actor: owner, tenantId: crypto.randomUUID(), workspaceId: `health-${crypto.randomUUID()}` };
  await db.query("INSERT INTO hs_workspaces(id,name) VALUES($1,$1)", [ctx.workspaceId]);
  for (const actor of [owner, reader, granted]) await db.query("INSERT INTO hs_members(workspace_id,user_id) VALUES($1,$2)", [ctx.workspaceId, actor.id]);
  await db.query("INSERT INTO hs_data_tenants(id,name) VALUES($1,$2)", [ctx.tenantId, "Synthetic tenant"]);
  await db.query("INSERT INTO hs_data_workspaces(workspace_id,tenant_id,review_reference) VALUES($1,$2,$3)", [ctx.workspaceId, ctx.tenantId, "Synthetic fixture only"]);
  await db.query("INSERT INTO hs_data_collections(tenant_id,id,name,core) VALUES($1,'organisations','Organisations',true)", [ctx.tenantId]);
  await db.query("INSERT INTO hs_data_collection_grants(tenant_id,user_id,collection,capabilities) VALUES($1,$2,'organisations',$3)", [ctx.tenantId, owner.id, [...recordCapabilities]]);
  await db.query("INSERT INTO hs_data_collection_grants(tenant_id,user_id,collection,capabilities) VALUES($1,$2,'organisations',$3)", [ctx.tenantId, reader.id, ["view", "history"]]);
});
afterAll(async () => db.close());

async function record(name = "Secret Organisation") {
  return (await health.create(ctx, { operationId: crypto.randomUUID(), collection: "organisations", name, schemaVersion: 1, values: { "core:notes": secret } })).record;
}
async function confirm(preview: { previewId: string; reviewHash: string; confirm: string }, operationId = crypto.randomUUID()) {
  return health.confirm(ctx, { operationId, previewId: preview.previewId, reviewHash: preview.reviewHash, confirm: preview.confirm as "retry-delivery" });
}
async function register(clientId = "billing-app", label = "Billing") {
  const preview = await health.preview(ctx, { action: "register", collection: "organisations", clientId, label });
  const saved = await confirm(preview);
  return saved.consumerId as string;
}
async function eventId(recordId: string) {
  const row = (await db.query<{ id: string; sequence: string }>("SELECT id, sequence::text AS sequence FROM hs_data_change_events WHERE tenant_id=$1 AND record_id=$2 ORDER BY sequence DESC LIMIT 1", [ctx.tenantId, recordId])).rows[0];
  if (!row) throw new Error("missing change event");
  return row;
}

it("lists paused consumers with acknowledgement, queue age, and redacted failures", async () => {
  const organisation = await record();
  const consumerId = await register();
  const event = await eventId(organisation.id);
  const failure = await health.preview(ctx, { action: "record-failure", collection: "organisations", consumerId, eventId: event.id, failureCode: "delivery-failed", failureDetail: `api_key=${secret}` });
  const recorded = await confirm(failure);
  expect(recorded).toMatchObject({ state: "failed", liveActivation: false, accessGranted: false, schedule: "paused" });
  const listed = await health.listHealth(ctx, { collection: "organisations" });
  expect(listed.consumers[0]).toMatchObject({ clientId: "billing-app", deliveryMode: "paused", liveActivation: false, schedule: "paused", canRepair: true });
  expect(listed.consumers[0].lastAcknowledgement).toBeNull();
  expect(listed.consumers[0].queueAgeSeconds).toBeGreaterThanOrEqual(0);
  expect(listed.consumers[0].failures[0]).toMatchObject({ state: "failed", failureRedacted: "[redacted]" });
  expect(JSON.stringify(listed)).not.toContain(secret);
  expect(JSON.stringify(listed)).not.toContain("Secret Organisation");
  expect(JSON.stringify(listed)).not.toContain("api_key");
  const grants = JSON.stringify((await db.query("SELECT user_id, capabilities FROM hs_data_collection_grants WHERE tenant_id=$1 ORDER BY user_id", [ctx.tenantId])).rows);
  expect((await db.query("SELECT 1 FROM hs_data_collection_consumers WHERE tenant_id=$1", [ctx.tenantId])).rows).toEqual([]);
  expect((await db.query("SELECT 1 FROM hs_data_record_grants WHERE tenant_id=$1", [ctx.tenantId])).rows).toEqual([]);
  await expect(health.listHealth(as(reader), { collection: "organisations" })).resolves.toMatchObject({ consumers: [] });
  await health.grantHealth(ctx, { collection: "organisations", consumerId, userId: granted.id, operationId: crypto.randomUUID(), expectedVersion: 0, canRead: true, canReconcile: false, canRepair: false, canExport: false, canHistory: true, confirm: "grant-integration-health-access" });
  expect(JSON.stringify((await db.query("SELECT user_id, capabilities FROM hs_data_collection_grants WHERE tenant_id=$1 ORDER BY user_id", [ctx.tenantId])).rows)).toBe(grants);
  await expect(health.listHealth(as(granted), { collection: "organisations", recordId: organisation.id })).rejects.toMatchObject({ status: 404 });
  await db.query("INSERT INTO hs_data_collection_grants(tenant_id,user_id,collection,capabilities) VALUES($1,$2,'organisations',$3)", [ctx.tenantId, granted.id, ["view", "history"]]);
  const visible = await health.listHealth(as(granted), { collection: "organisations" });
  expect(visible.consumers[0]).toMatchObject({ canRepair: false, canReconcile: false, canHistory: true });
  expect(JSON.stringify(visible)).not.toContain(secret);
  await expect(health.preview(as(granted), { action: "retry", collection: "organisations", consumerId, deliveryId: listed.consumers[0].failures[0].deliveryId })).rejects.toMatchObject({ status: 403 });
});

it("reconciles ids, versions, and reference ledgers in a resumable bounded scan", async () => {
  const lagging = await record("Lagging");
  await health.update(ctx, lagging.id, { operationId: crypto.randomUUID(), expectedVersion: 1, schemaVersion: 1, name: "Lagging current" });
  const ahead = await record("Ahead");
  const consumerId = await register("ledger-app", "Ledger");
  await db.query("INSERT INTO hs_data_references(id,tenant_id,record_id,source_app,source_type,source_id,version) VALUES($1,$2,$3,'ledger-app','project','p-1',3),($4,$2,$3,'ledger-app','project','p-2',1)", [crypto.randomUUID(), ctx.tenantId, lagging.id, crypto.randomUUID()]);
  const unknownId = crypto.randomUUID();
  const observations = {
    records: [
      { recordId: lagging.id, version: 1 },
      { recordId: ahead.id, version: 9 },
      { recordId: unknownId, version: 1 },
    ],
    references: [
      { recordId: lagging.id, sourceType: "project", sourceId: "p-1", version: 1 },
      { recordId: lagging.id, sourceType: "project", sourceId: "p-extra", version: 1 },
    ],
  };
  let step = await health.reconcile(ctx, { collection: "organisations", consumerId, operationId: crypto.randomUUID(), bound: 1, observations });
  const seen = new Set((step.mismatches ?? []).map((item) => item.class));
  let guard = 0;
  while (step.resume && guard < 20) {
    step = await health.reconcile(ctx, { collection: "organisations", consumerId, operationId: crypto.randomUUID(), runId: String(step.runId), expectedVersion: Number(step.version) });
    for (const item of step.mismatches ?? []) seen.add(String(item.class));
    guard += 1;
  }
  expect(step.resume).toBe(false);
  expect([...seen].sort()).toEqual(["extra-reference", "missing-reference", "reference-version", "unacknowledged", "unknown-record", "version-ahead", "version-lag"]);
  const stored = Number((await db.query<{ n: string }>("SELECT count(*)::text AS n FROM hs_integration_mismatches WHERE tenant_id=$1", [ctx.tenantId])).rows[0].n);
  const replay = await health.reconcile(ctx, { collection: "organisations", consumerId, operationId: crypto.randomUUID(), runId: String(step.runId), expectedVersion: Number(step.version) });
  expect(replay).toMatchObject({ resume: false, replayed: false });
  expect(Number((await db.query<{ n: string }>("SELECT count(*)::text AS n FROM hs_integration_mismatches WHERE tenant_id=$1", [ctx.tenantId])).rows[0].n)).toBe(stored);
  const aheadVersion = (await db.query<{ version: number }>("SELECT version FROM hs_data_records WHERE id=$1", [ahead.id])).rows[0].version;
  const referenceVersion = (await db.query<{ version: number }>("SELECT version FROM hs_data_references WHERE tenant_id=$1 AND source_id='p-1'", [ctx.tenantId])).rows[0].version;
  const aheadMismatch = (await db.query<{ id: string }>("SELECT id FROM hs_integration_mismatches WHERE tenant_id=$1 AND class='version-ahead'", [ctx.tenantId])).rows[0];
  await expect(health.preview(ctx, { action: "repair", collection: "organisations", consumerId, mismatchId: aheadMismatch.id, decision: "overwrite-canonical" })).rejects.toMatchObject({ code: "repair_destructive" });
  const keep = await health.preview(ctx, { action: "repair", collection: "organisations", consumerId, mismatchId: aheadMismatch.id, decision: "keep-canonical" });
  const keepOperation = crypto.randomUUID();
  const kept = await confirm(keep, keepOperation);
  expect(kept).toMatchObject({ decision: "keep-canonical", canonicalVersion: Number(aheadVersion) });
  expect((await db.query<{ version: number }>("SELECT version FROM hs_data_records WHERE id=$1", [ahead.id])).rows[0].version).toBe(aheadVersion);
  expect((await db.query<{ version: number }>("SELECT version FROM hs_data_references WHERE tenant_id=$1 AND source_id='p-1'", [ctx.tenantId])).rows[0].version).toBe(referenceVersion);
  expect((await confirm(keep, keepOperation)).replayed).toBe(true);
});

it("retries a failed delivery once, isolates poison, and exports redacted evidence", async () => {
  const organisation = await record();
  const consumerId = await register("retry-app", "Retry");
  const event = await eventId(organisation.id);
  let deliveryId = "";
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const preview = await health.preview(ctx, { action: "record-failure", collection: "organisations", consumerId, eventId: event.id, failureCode: "delivery-failed", failureDetail: attempt === 0 ? `bearer ${secret}` : "downstream timeout" });
    const saved = await confirm(preview);
    deliveryId = String(saved.deliveryId);
  }
  const poisoned = (await db.query<{ state: string; failure_redacted: string }>("SELECT state, failure_redacted FROM hs_integration_deliveries WHERE id=$1", [deliveryId])).rows[0];
  expect(poisoned.state).toBe("poison");
  expect(poisoned.failure_redacted).not.toContain(secret);
  await expect(health.preview(ctx, { action: "retry", collection: "organisations", consumerId, deliveryId })).rejects.toMatchObject({ code: "integration_poison" });
  const fresh = await record("Second");
  const freshEvent = await eventId(fresh.id);
  const failed = await confirm(await health.preview(ctx, { action: "record-failure", collection: "organisations", consumerId, eventId: freshEvent.id, failureCode: "delivery-failed", failureDetail: "downstream timeout" }));
  await expect(health.preview(ctx, { action: "retry", collection: "organisations", consumerId, deliveryId: String(failed.deliveryId) })).rejects.toMatchObject({ code: "integration_backoff" });
  await db.query("UPDATE hs_integration_deliveries SET next_attempt_at=clock_timestamp() - interval '1 minute', version=version+1 WHERE id=$1", [failed.deliveryId]);
  const retry = await health.preview(ctx, { action: "retry", collection: "organisations", consumerId, deliveryId: String(failed.deliveryId) });
  const operationId = crypto.randomUUID();
  const first = await confirm(retry, operationId);
  expect(first).toMatchObject({ replayed: false, action: "retry", attemptCount: 2 });
  expect((await confirm(retry, operationId)).replayed).toBe(true);
  expect(Number((await db.query<{ attempt_count: number }>("SELECT attempt_count FROM hs_integration_deliveries WHERE id=$1", [failed.deliveryId])).rows[0].attempt_count)).toBe(2);
  await expect(health.confirm(ctx, { operationId, previewId: retry.previewId, reviewHash: "b".repeat(64), confirm: "retry-delivery" })).rejects.toMatchObject({ code: "operation_mismatch" });
  const isolated = await confirm(await health.preview(ctx, { action: "isolate", collection: "organisations", consumerId }));
  expect(isolated).toMatchObject({ outage: "isolated" });
  const audit = JSON.stringify((await db.query("SELECT actor_id, action, after_value FROM hs_audit WHERE action='integration.isolate' AND actor_id=$1", [owner.id])).rows);
  expect(audit).toContain(owner.id);
  expect(audit).toContain("holy-sheet");
  expect(audit).toContain("atIst");
  expect(audit).not.toContain(secret);
  const evidence = (await health.downloadEvidence(ctx, { collection: "organisations", consumerId })).bytes.toString("utf8");
  expect(evidence).toContain("poison");
  expect(evidence).toContain("\"liveActivation\":false");
  expect(evidence).toContain("\"accessGranted\":false");
  expect(evidence).not.toContain(secret);
  expect(evidence).not.toContain("Secret Organisation");
  expect((await db.query<{ state: string }>("SELECT state FROM hs_integration_deliveries WHERE id=$1", [deliveryId])).rows[0].state).toBe("poison");
  const released = await confirm(await health.preview(ctx, { action: "release", collection: "organisations", consumerId }));
  expect(released.outage).toBe("partial");
  expect((await db.query<{ state: string }>("SELECT state FROM hs_integration_deliveries WHERE id=$1", [deliveryId])).rows[0].state).toBe("poison");
});

it("keeps drafts recoverable and acknowledgement versions forward only", async () => {
  const organisation = await record();
  const consumerId = await register("draft-app", "Drafts");
  const event = await eventId(organisation.id);
  const before = Number((await db.query<{ n: string }>("SELECT count(*)::text AS n FROM hs_integration_deliveries WHERE tenant_id=$1", [ctx.tenantId])).rows[0].n);
  const draft = { draftId: crypto.randomUUID(), consumerId, collection: "organisations", operationId: crypto.randomUUID(), expectedVersion: 0, note: "Check the paused consumer", observations: { records: [{ recordId: organisation.id, version: 1 }] } };
  expect((await health.saveDraft(ctx, draft)).replayed).toBe(false);
  expect((await health.listHealth(ctx, { collection: "organisations" })).drafts).toHaveLength(1);
  expect(Number((await db.query<{ n: string }>("SELECT count(*)::text AS n FROM hs_integration_deliveries WHERE tenant_id=$1", [ctx.tenantId])).rows[0].n)).toBe(before);
  const discard = { consumerId, collection: "organisations", operationId: crypto.randomUUID(), expectedVersion: 1 };
  expect((await health.discardDraft(ctx, discard)).replayed).toBe(false);
  expect((await health.discardDraft(ctx, discard)).replayed).toBe(true);
  expect((await health.listHealth(ctx, { collection: "organisations" })).drafts).toEqual([]);
  const ack = await health.preview(ctx, { action: "acknowledge", collection: "organisations", consumerId, eventId: event.id });
  const saved = await confirm(ack);
  expect(saved).toMatchObject({ action: "acknowledge", sequence: Number(event.sequence) });
  await expect(health.confirm(ctx, { operationId: crypto.randomUUID(), previewId: ack.previewId, reviewHash: ack.reviewHash, confirm: ack.confirm })).rejects.toMatchObject({ status: 409 });
  const listed = await health.listHealth(ctx, { collection: "organisations" });
  expect(listed.consumers[0].lastAcknowledgement).toMatchObject({ sequence: Number(event.sequence), version: 1 });
  expect(listed.consumers[0].queueAgeSeconds).toBeNull();
  const history = await health.consumerHistory(ctx, consumerId, "organisations");
  expect(history.versions[0]).toMatchObject({ source: "holy-sheet", actorId: owner.id });
  expect(history.versions[0].atIst).toContain("IST");
  expect(JSON.stringify(history)).not.toContain(secret);
});
