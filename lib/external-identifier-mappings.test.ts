import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { localActor as owner, type Actor } from "./auth";
import { createDatabase, type Database } from "./database";
import { ExternalIdentifierRepository } from "./external-identifier-mappings";
import { Repository } from "./repository";
import { SharedRecordMergeRepository, type MergeAliasAuthority } from "./shared-record-merges";
import type { CurrentSuiteTenantAuthority, RecordContext } from "./shared-records";
import { recordCapabilities } from "./shared-record-types";

let db: Database;
let pages: Repository;
let identifiers: ExternalIdentifierRepository;
let merges: SharedRecordMergeRepository;
let ctx: RecordContext;
const reader: Actor = { id: "external-id-reader" };
const granted: Actor = { id: "external-id-granted" };
const secret = "hidden-field-secret";
const authority: CurrentSuiteTenantAuthority = { verify: async (context) => ({ subject: context.actor.id, tenantId: context.tenantId, workspaceId: context.workspaceId, active: true, tenantAdministrator: false, revision: "synthetic-external-id-authority-v1" }) };
const consumers: MergeAliasAuthority = { verify: vi.fn(async (context, sourceId, survivorId) => ({ qualified: true, revision: "synthetic-alias-consumer-v1", tenantId: context.tenantId, sourceId, survivorId })) };
const as = (actor: Actor) => ({ ...ctx, actor });

beforeAll(async () => {
  db = await createDatabase(":memory:");
  pages = new Repository(db);
  await pages.seedLocal();
  for (const actor of [reader, granted]) await db.query("INSERT INTO hs_users(id,name) VALUES($1,$1)", [actor.id]);
  identifiers = new ExternalIdentifierRepository(pages, authority);
  merges = new SharedRecordMergeRepository(pages, authority, undefined, consumers);
});
beforeEach(async () => {
  ctx = { actor: owner, tenantId: crypto.randomUUID(), workspaceId: `external-${crypto.randomUUID()}` };
  await db.query("INSERT INTO hs_workspaces(id,name) VALUES($1,$1)", [ctx.workspaceId]);
  for (const actor of [owner, reader, granted]) await db.query("INSERT INTO hs_members(workspace_id,user_id) VALUES($1,$2)", [ctx.workspaceId, actor.id]);
  await db.query("INSERT INTO hs_data_tenants(id,name) VALUES($1,$2)", [ctx.tenantId, "Synthetic tenant"]);
  await db.query("INSERT INTO hs_data_workspaces(workspace_id,tenant_id,review_reference) VALUES($1,$2,$3)", [ctx.workspaceId, ctx.tenantId, "Synthetic fixture only"]);
  await db.query("INSERT INTO hs_data_collections(tenant_id,id,name,core) VALUES($1,'organisations','Organisations',true)", [ctx.tenantId]);
  await db.query("INSERT INTO hs_data_collection_grants(tenant_id,user_id,collection,capabilities) VALUES($1,$2,'organisations',$3)", [ctx.tenantId, owner.id, [...recordCapabilities]]);
  await db.query("INSERT INTO hs_data_collection_grants(tenant_id,user_id,collection,capabilities) VALUES($1,$2,'organisations',$3)", [ctx.tenantId, reader.id, ["view", "edit", "manage-external-ids", "history"]]);
});
afterAll(async () => db.close());

async function record(name: string, actor = owner) {
  return (await identifiers.create(as(actor), { operationId: crypto.randomUUID(), collection: "organisations", name, schemaVersion: 1, values: { "core:notes": secret } })).record;
}
async function connect(recordId: string, externalId = "cust-1", namespace = "billing.app", provenanceLabel = "billing import") {
  const preview = await identifiers.previewMapping(ctx, { recordId, namespace, externalId, provenanceLabel });
  return identifiers.registerMapping(ctx, { operationId: crypto.randomUUID(), previewId: preview.previewId, reviewHash: preview.reviewHash });
}

it("registers identity metadata once, audits the actor, and stores no field value or credential", async () => {
  const organisation = await record("Acme");
  const preview = await identifiers.previewMapping(ctx, { recordId: organisation.id, namespace: "billing.app", externalId: "cust-1", provenanceLabel: "billing import" });
  const input = { operationId: crypto.randomUUID(), previewId: preview.previewId, reviewHash: preview.reviewHash };
  const saved = await identifiers.registerMapping(ctx, input);
  expect(saved).toMatchObject({ replayed: false, action: "create", appliedVersion: 1, credentialsStored: false, accessGranted: false });
  expect((await identifiers.registerMapping(ctx, input)).replayed).toBe(true);
  await expect(identifiers.registerMapping(ctx, { ...input, reviewHash: "a".repeat(64) })).rejects.toMatchObject({ code: "operation_mismatch" });
  const listed = await identifiers.listMappings(ctx, { collection: "organisations", recordId: organisation.id });
  expect(listed.mappings).toHaveLength(1);
  expect(listed.mappings[0]).toMatchObject({ namespace: "billing.app", externalId: "cust-1", originalRecordId: organisation.id, state: "active" });
  expect(JSON.stringify(listed)).not.toContain(secret);
  const audit = JSON.stringify((await db.query("SELECT actor_id, action, after_value FROM hs_audit WHERE correlation_id=$1", [input.operationId])).rows);
  expect(audit).toContain(owner.id);
  expect(audit).toContain("external-identifier.register");
  expect(audit).toContain("holy-sheet");
  expect(audit).toContain("atIst");
  expect(audit).not.toContain(secret);
  const history = await identifiers.mappingHistory(ctx, saved.mapping.id);
  expect(history.versions[0]).toMatchObject({ source: "holy-sheet", actorId: owner.id, state: "active", originalRecordId: organisation.id });
  expect(history.versions[0].atIst).toContain("IST");
  const download = await identifiers.downloadMappings(ctx, { recordId: organisation.id });
  expect(download.bytes.toString("utf8")).toContain("cust-1");
  expect(download.bytes.toString("utf8")).not.toContain(secret);
  expect(download.bytes.toString("utf8")).toContain("\"accessGranted\":false");
});

it("requires explicit review for a unique conflict and does not silently reassign", async () => {
  const first = await record("First");
  const second = await record("Second");
  await connect(first.id);
  const preview = await identifiers.previewMapping(ctx, { recordId: second.id, namespace: "billing.app", externalId: "cust-1", provenanceLabel: "billing import" });
  expect(preview.conflict).toMatchObject({ reviewable: true, recordId: first.id, state: "active" });
  await expect(identifiers.registerMapping(ctx, { operationId: crypto.randomUUID(), previewId: preview.previewId, reviewHash: preview.reviewHash })).rejects.toMatchObject({ code: "identifier_conflict" });
  expect((await db.query<{ record_id: string }>("SELECT record_id FROM hs_external_identifier_mappings WHERE tenant_id=$1", [ctx.tenantId])).rows[0].record_id).toBe(first.id);
  const kept = await identifiers.registerMapping(ctx, { operationId: crypto.randomUUID(), previewId: preview.previewId, reviewHash: preview.reviewHash, review: { decision: "keep", mappingId: preview.conflict && "mappingId" in preview.conflict ? preview.conflict.mappingId : "", version: preview.conflict && "version" in preview.conflict ? preview.conflict.version : 0, confirm: "keep-external-identifier" } });
  expect(kept.action).toBe("unchanged");
  expect((await db.query<{ record_id: string; original_record_id: string }>("SELECT record_id, original_record_id FROM hs_external_identifier_mappings WHERE tenant_id=$1", [ctx.tenantId])).rows[0]).toMatchObject({ record_id: first.id, original_record_id: first.id });
  const moved = await identifiers.registerMapping(ctx, { operationId: crypto.randomUUID(), previewId: preview.previewId, reviewHash: preview.reviewHash, review: { decision: "reassign", mappingId: preview.conflict && "mappingId" in preview.conflict ? preview.conflict.mappingId : "", version: 1, confirm: "reassign-external-identifier" } });
  expect(moved.mapping).toMatchObject({ recordId: second.id, originalRecordId: first.id, redirectReason: "explicit-review", state: "active" });
  await expect(db.query("UPDATE hs_external_identifier_mappings SET record_id=$2, version=version+1 WHERE tenant_id=$1", [ctx.tenantId, first.id])).rejects.toThrow(/explicit review|reassignment/i);
});

it("redirects mappings on merge without dropping source ids or explicit states", async () => {
  const source = await record("Source");
  const survivor = await record("Survivor");
  const active = await connect(source.id, "cust-active");
  const archived = await connect(source.id, "cust-archived");
  await identifiers.setMappingState(ctx, { mappingId: archived.mapping.id, operationId: crypto.randomUUID(), expectedVersion: archived.mapping.version, state: "archived", confirm: "set-external-identifier-state" });
  await connect(survivor.id, "cust-survivor");
  const preview = await merges.previewMerge(ctx, { sourceId: source.id, survivorId: survivor.id, sourceVersion: 1, survivorVersion: 1, nameFrom: "survivor" });
  await merges.applyMerge(ctx, { operationId: crypto.randomUUID(), previewId: preview.previewId, reviewHash: preview.reviewHash, confirm: "merge-and-retain-source-history" });
  const rows = (await db.query<{ external_id: string; record_id: string; original_record_id: string; state: string; redirect_reason: string | null }>("SELECT external_id, record_id, original_record_id, state, redirect_reason FROM hs_external_identifier_mappings WHERE tenant_id=$1 ORDER BY external_id", [ctx.tenantId])).rows;
  expect(rows).toEqual([
    { external_id: "cust-active", record_id: survivor.id, original_record_id: source.id, state: "active", redirect_reason: "merge" },
    { external_id: "cust-archived", record_id: survivor.id, original_record_id: source.id, state: "archived", redirect_reason: "merge" },
    { external_id: "cust-survivor", record_id: survivor.id, original_record_id: survivor.id, state: "active", redirect_reason: null },
  ]);
  const audit = JSON.stringify((await db.query("SELECT action, after_value FROM hs_audit WHERE action='external-identifier.merge-redirect' AND actor_id=$1", [owner.id])).rows);
  expect(audit).toContain("holy-sheet");
  expect(audit).toContain(active.mapping.id);
  expect(audit).not.toContain(secret);
  expect((await db.query("SELECT external_id FROM hs_external_identifier_mappings WHERE tenant_id=$1", [ctx.tenantId])).rows).toHaveLength(3);
});

it("keeps deleted identifiers unique and requires an explicit state", async () => {
  const organisation = await record("Acme");
  const other = await record("Other");
  const saved = await connect(organisation.id, "cust-deleted");
  const deleted = await identifiers.setMappingState(ctx, { mappingId: saved.mapping.id, operationId: crypto.randomUUID(), expectedVersion: 1, state: "deleted", confirm: "set-external-identifier-state" });
  expect(deleted.mapping.state).toBe("deleted");
  const again = await identifiers.previewMapping(ctx, { recordId: other.id, namespace: "billing.app", externalId: "cust-deleted" });
  expect(again.conflict).toMatchObject({ reviewable: true, state: "deleted" });
  expect((await db.query("SELECT id FROM hs_external_identifier_mappings WHERE tenant_id=$1 AND external_id='cust-deleted'", [ctx.tenantId])).rows).toHaveLength(1);
  await expect(identifiers.previewMapping(ctx, { recordId: organisation.id, namespace: "Bad Namespace", externalId: "cust-1" })).rejects.toMatchObject({ status: 400 });
  await expect(identifiers.previewMapping(ctx, { recordId: organisation.id, namespace: "billing.app", externalId: "api_key=live" })).rejects.toMatchObject({ status: 400 });
});

it("separates integration grants from record access and keeps drafts recoverable", async () => {
  const organisation = await record("Acme");
  await connect(organisation.id);
  await expect(identifiers.previewMapping(as(reader), { recordId: organisation.id, namespace: "billing.app", externalId: "cust-2" })).rejects.toMatchObject({ status: 403 });
  await expect(identifiers.listMappings(as(reader), { collection: "organisations", recordId: organisation.id })).resolves.toMatchObject({ mappings: [] });
  const grantsBefore = JSON.stringify((await db.query("SELECT user_id, capabilities FROM hs_data_collection_grants WHERE tenant_id=$1 ORDER BY user_id", [ctx.tenantId])).rows);
  await identifiers.grantIntegration(ctx, { collection: "organisations", namespace: "billing.app", userId: granted.id, operationId: crypto.randomUUID(), expectedVersion: 0, canRead: true, canWrite: false, canExport: false, canHistory: true, confirm: "grant-integration-metadata-access" });
  expect(JSON.stringify((await db.query("SELECT user_id, capabilities FROM hs_data_collection_grants WHERE tenant_id=$1 ORDER BY user_id", [ctx.tenantId])).rows)).toBe(grantsBefore);
  expect((await db.query("SELECT * FROM hs_data_record_grants WHERE tenant_id=$1 AND user_id=$2", [ctx.tenantId, granted.id])).rows).toEqual([]);
  await expect(identifiers.listMappings(as(granted), { collection: "organisations", recordId: organisation.id })).rejects.toMatchObject({ status: 404 });
  await db.query("INSERT INTO hs_data_collection_grants(tenant_id,user_id,collection,capabilities) VALUES($1,$2,'organisations',$3)", [ctx.tenantId, granted.id, ["view", "history"]]);
  const visible = await identifiers.listMappings(as(granted), { collection: "organisations", recordId: organisation.id });
  expect(visible.mappings[0]).toMatchObject({ canWrite: false, canExport: false, canHistory: true });
  await expect(identifiers.previewMapping(as(granted), { recordId: organisation.id, namespace: "billing.app", externalId: "cust-9" })).rejects.toMatchObject({ status: 403 });
  const draft = { draftId: crypto.randomUUID(), mappingId: crypto.randomUUID(), recordId: organisation.id, operationId: crypto.randomUUID(), expectedVersion: 0, namespace: "billing.app", externalId: "cust-draft", provenanceLabel: "draft note" };
  expect((await identifiers.saveDraft(ctx, draft)).replayed).toBe(false);
  expect((await identifiers.listMappings(ctx, { collection: "organisations", recordId: organisation.id })).drafts).toHaveLength(1);
  expect((await db.query("SELECT count(*)::int AS n FROM hs_external_identifier_mappings WHERE tenant_id=$1 AND external_id='cust-draft'", [ctx.tenantId])).rows[0].n).toBe(0);
  await expect(identifiers.saveDraft(ctx, { ...draft, operationId: crypto.randomUUID(), provenanceLabel: "other" })).rejects.toMatchObject({ code: "identifier_conflict" });
  const discard = { mappingId: draft.mappingId, operationId: crypto.randomUUID(), expectedVersion: 1 };
  expect((await identifiers.discardDraft(ctx, discard)).replayed).toBe(false);
  expect((await identifiers.discardDraft(ctx, discard)).replayed).toBe(true);
  expect((await identifiers.listMappings(ctx, { collection: "organisations", recordId: organisation.id })).mappings).toHaveLength(1);
  expect((await identifiers.listMappings(ctx, { collection: "organisations", recordId: organisation.id })).drafts).toEqual([]);
});
