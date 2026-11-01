import { afterAll, beforeAll, beforeEach, expect, it } from "vitest";
import { localActor as owner, type Actor } from "./auth";
import { createDatabase, type Database } from "./database";
import { Repository } from "./repository";
import { SharedRecordImportProfileRepository } from "./shared-record-import-profiles";
import { SharedRecordSchemaRepository } from "./shared-record-schema";
import type { RecordContext } from "./shared-records";
import { recordCapabilities } from "./shared-record-types";

let db: Database;
let pages: Repository;
let profiles: SharedRecordImportProfileRepository;
let schemas: SharedRecordSchemaRepository;
let ctx: RecordContext;
const reader: Actor = { id: "import-profile-reader" };
const manager: Actor = { id: "import-profile-manager" };
const authority = { verify: async (context: RecordContext) => ({ subject: context.actor.id, tenantId: context.tenantId, workspaceId: context.workspaceId, active: true, tenantAdministrator: context.actor.id === owner.id, revision: "synthetic-import-profile-authority-v1" }) };
const secret = "secret-sample-value";
const as = (actor: Actor) => ({ ...ctx, actor });

beforeAll(async () => {
  db = await createDatabase(":memory:");
  pages = new Repository(db);
  await pages.seedLocal();
  for (const actor of [reader, manager]) await db.query("INSERT INTO hs_users(id,name) VALUES($1,$1)", [actor.id]);
  profiles = new SharedRecordImportProfileRepository(pages, authority);
  schemas = new SharedRecordSchemaRepository(pages, authority);
});
beforeEach(async () => {
  ctx = { actor: owner, tenantId: crypto.randomUUID(), workspaceId: `import-profile-${crypto.randomUUID()}` };
  await db.query("INSERT INTO hs_workspaces(id,name) VALUES($1,$1)", [ctx.workspaceId]);
  for (const actor of [owner, reader, manager]) await db.query("INSERT INTO hs_members(workspace_id,user_id) VALUES($1,$2)", [ctx.workspaceId, actor.id]);
  await db.query("INSERT INTO hs_data_tenants(id,name) VALUES($1,$2)", [ctx.tenantId, "Synthetic tenant"]);
  await db.query("INSERT INTO hs_data_workspaces(workspace_id,tenant_id,review_reference) VALUES($1,$2,$3)", [ctx.workspaceId, ctx.tenantId, "Synthetic fixture only"]);
  await db.query("INSERT INTO hs_data_collections(tenant_id,id,name,core) VALUES($1,'organisations','Organisations',true)", [ctx.tenantId]);
  await db.query("INSERT INTO hs_data_collection_grants(tenant_id,user_id,collection,capabilities) VALUES($1,$2,'organisations',$3)", [ctx.tenantId, owner.id, [...recordCapabilities]]);
  await db.query("INSERT INTO hs_data_collection_grants(tenant_id,user_id,collection,capabilities) VALUES($1,$2,'organisations',$3)", [ctx.tenantId, reader.id, ["view"]]);
  await db.query("INSERT INTO hs_data_collection_grants(tenant_id,user_id,collection,capabilities) VALUES($1,$2,'organisations',$3)", [ctx.tenantId, manager.id, ["view", "import", "manage-import-profiles"]]);
});
afterAll(async () => db.close());

async function version() {
  return Number((await db.query<{ schema_version: number }>("SELECT schema_version FROM hs_data_tenants WHERE id=$1", [ctx.tenantId])).rows[0].schema_version);
}
async function stage(headers: string[], cells: string[], actor = owner.id) {
  const id = crypto.randomUUID();
  await db.query("INSERT INTO hs_data_import_jobs(id,tenant_id,workspace_id,actor_id,collection,source_hash,source_name,format,headers,warnings,source_bytes,row_count) VALUES($1,$2,$3,$4,'organisations',$5,'people.csv','csv',$6,'[]'::jsonb,32,1)", [id, ctx.tenantId, ctx.workspaceId, actor, crypto.randomUUID(), JSON.stringify(headers)]);
  await db.query("INSERT INTO hs_data_import_rows(job_id,ordinal,source_row,operation_id,raw_cells,source_errors) VALUES($1,0,2,$2,$3,'[]'::jsonb)", [id, crypto.randomUUID(), JSON.stringify(cells)]);
  return id;
}
function saveInput(jobId: string, patch: Record<string, unknown> = {}) {
  return { id: crypto.randomUUID(), operationId: crypto.randomUUID(), jobId, collection: "organisations", scope: "personal" as const, name: "Repeat organisations", expectedVersion: 0, mapping: { mode: "create" as const, nameColumn: 0, fields: [{ column: 1, fieldKey: "core:notes" }] }, ...patch };
}
async function stored() {
  const tables = ["hs_data_import_profiles", "hs_data_import_profile_versions", "hs_data_import_profile_operations", "hs_data_import_profile_drafts", "hs_audit"];
  const chunks = [];
  for (const table of tables) chunks.push(JSON.stringify((await db.query(`SELECT * FROM ${table}`)).rows));
  return chunks.join("\n");
}

it("saves a named profile without storing samples, creating fields, or running the import", async () => {
  const before = Number((await db.query<{ n: string }>("SELECT count(*)::text AS n FROM hs_data_fields WHERE tenant_id=$1", [ctx.tenantId])).rows[0].n);
  const schemaVersion = await version();
  const jobId = await stage(["Name", "Notes"], ["Ada", secret]);
  const input = saveInput(jobId);
  const saved = await profiles.saveProfile(ctx, input);
  expect(saved).toMatchObject({ replayed: false, appliedVersion: 1 });
  expect((await profiles.saveProfile(ctx, input)).replayed).toBe(true);
  await expect(profiles.saveProfile(ctx, { ...input, name: "Different replay" })).rejects.toMatchObject({ code: "operation_mismatch" });
  const listed = await profiles.listProfiles(ctx, "organisations");
  expect(listed.profiles[0]).toMatchObject({ name: "Repeat organisations", scope: "personal", mode: "create", compatibility: "compatible", columns: [{ header: "Name", role: "name" }, { header: "Notes", role: "field", fieldId: "core:notes" }] });
  expect(JSON.stringify(listed)).not.toContain(secret);
  expect(await stored()).not.toContain(secret);
  expect(Number((await db.query<{ n: string }>("SELECT count(*)::text AS n FROM hs_data_fields WHERE tenant_id=$1", [ctx.tenantId])).rows[0].n)).toBe(before);
  expect(await version()).toBe(schemaVersion);
  expect((await db.query("SELECT mapping FROM hs_data_import_jobs WHERE id=$1", [jobId])).rows[0].mapping).toBeNull();
  const audit = JSON.stringify((await db.query("SELECT actor_id, action, after_value FROM hs_audit WHERE correlation_id=$1", [input.operationId])).rows);
  expect(audit).toContain(owner.id);
  expect(audit).toContain("holy-sheet");
  expect(audit).toContain("atIst");
  expect(audit).toContain("import-profile.save");
  expect(audit).not.toContain(secret);
});

it("keeps personal profiles private and requires management rights for shared profiles", async () => {
  const jobId = await stage(["Name", "Notes"], ["Ada", secret], owner.id);
  const personal = saveInput(jobId);
  await profiles.saveProfile(ctx, personal);
  await expect(profiles.listProfiles(as(reader), "organisations")).rejects.toMatchObject({ status: 403 });
  await db.query("UPDATE hs_data_collection_grants SET capabilities=ARRAY['view','import'] WHERE tenant_id=$1 AND user_id=$2", [ctx.tenantId, reader.id]);
  expect((await profiles.listProfiles(as(reader), "organisations")).profiles).toEqual([]);
  await expect(profiles.applyProfile(as(reader), { id: personal.id, operationId: crypto.randomUUID(), jobId })).rejects.toMatchObject({ status: 404 });
  await expect(profiles.saveProfile(as(manager), saveInput(await stage(["Name", "Notes"], ["Ada", "ok"], manager.id), { scope: "personal" }))).resolves.toMatchObject({ appliedVersion: 1 });
  const sharedJob = await stage(["Name", "Notes"], ["Ada", "ok"], manager.id);
  const shared = saveInput(sharedJob, { scope: "shared", name: "Shared organisations" });
  await profiles.saveProfile(as(manager), shared);
  expect((await profiles.listProfiles(as(reader), "organisations")).profiles.map((profile) => profile.id)).toEqual([shared.id]);
  expect((await profiles.listProfiles(as(reader), "organisations")).profiles[0].canManage).toBe(false);
  await expect(profiles.saveProfile(as(reader), { ...shared, operationId: crypto.randomUUID(), expectedVersion: 1, name: "Taken over" })).rejects.toMatchObject({ status: 403 });
  expect((await profiles.listProfiles(as(manager), "organisations", secret)).profiles).toEqual([]);
  await db.query("UPDATE hs_data_collection_grants SET capabilities=ARRAY['view','schema','manage-import-profiles'] WHERE tenant_id=$1 AND user_id=$2", [ctx.tenantId, manager.id]);
  await expect(profiles.saveProfile(as(manager), saveInput(sharedJob, { scope: "shared", name: "No import right" }))).rejects.toMatchObject({ status: 403 });
  await expect(schemas.previewSchema(as(manager), { prepareId: crypto.randomUUID(), collection: "organisations", expectedSchemaVersion: await version(), definition: { label: "Not allowed", kind: "text" } })).rejects.toMatchObject({ status: 403 });
});

it("requires repair for a mismatched file and marks choice or key changes incompatible", async () => {
  const field = await schemas.previewSchema(ctx, { prepareId: crypto.randomUUID(), collection: "organisations", expectedSchemaVersion: await version(), definition: { label: "Department", kind: "single-select", choices: ["one", "two"] } });
  await schemas.applySchema(ctx, { previewId: field.previewId, reviewHash: field.reviewHash, operationId: crypto.randomUUID() });
  const jobId = await stage(["Name", "Department"], ["Ada", "one"]);
  const input = saveInput(jobId, { mapping: { mode: "create", nameColumn: 0, fields: [{ column: 1, fieldKey: field.fieldKey }] }, name: "Departments" });
  await profiles.saveProfile(ctx, input);
  const other = await stage(["Department", "Department"], [secret, secret]);
  const repaired = await profiles.applyProfile(ctx, { id: input.id, operationId: crypto.randomUUID(), jobId: other });
  expect(repaired.repairRequired).toBe(true);
  expect(repaired.mapping).toBeNull();
  expect(JSON.stringify(repaired)).not.toContain(secret);
  expect((await db.query("SELECT mapping FROM hs_data_import_jobs WHERE id=$1", [other])).rows[0].mapping).toBeNull();
  const changed = await schemas.previewSchema(ctx, { prepareId: crypto.randomUUID(), collection: "organisations", fieldKey: field.fieldKey, expectedSchemaVersion: await version(), definition: { label: "Department", kind: "single-select", choices: ["one", "three"], unique: true } });
  await schemas.applySchema(ctx, { previewId: changed.previewId, reviewHash: changed.reviewHash, operationId: crypto.randomUUID() });
  const listed = await profiles.listProfiles(ctx, "organisations");
  expect(listed.profiles[0].compatibility).toBe("incompatible");
  expect(listed.profiles[0].reasons.map((reason) => reason.code)).toEqual(expect.arrayContaining(["choices_changed", "key_changed"]));
  const preview = await profiles.applyProfile(ctx, { id: input.id, operationId: crypto.randomUUID(), jobId });
  expect(preview.mapping).toBeNull();
  expect(preview.repairRequired).toBe(true);
  const rebound = await profiles.saveProfile(ctx, { ...input, operationId: crypto.randomUUID(), expectedVersion: 1, mapping: { mode: "create", nameColumn: 0, fields: [{ column: 1, fieldKey: field.fieldKey }] } });
  expect(rebound.replayed).toBe(false);
  expect((await profiles.listProfiles(ctx, "organisations")).profiles[0].compatibility).toBe("compatible");
});

it("retains a recoverable draft, rejects a stale overwrite, and audits discard without dropping the profile", async () => {
  const jobId = await stage(["Name", "Notes"], ["Ada", secret]);
  const input = saveInput(jobId);
  await profiles.saveProfile(ctx, input);
  const draft = { ...input, operationId: crypto.randomUUID(), draftId: crypto.randomUUID(), name: "Draft name", expectedVersion: 0 };
  expect((await profiles.saveDraft(ctx, draft)).replayed).toBe(false);
  expect((await profiles.listProfiles(ctx, "organisations")).profiles[0].name).toBe("Repeat organisations");
  expect((await profiles.listProfiles(ctx, "organisations")).drafts).toEqual([expect.objectContaining({ profileId: input.id, name: "Draft name" })]);
  await expect(profiles.saveProfile(ctx, { ...input, operationId: crypto.randomUUID(), expectedVersion: 0, name: "Stale" })).rejects.toMatchObject({ code: "import_profile_conflict" });
  expect((await profiles.listProfiles(ctx, "organisations")).drafts).toHaveLength(1);
  const recovered = await profiles.applyProfile(ctx, { id: input.id, operationId: crypto.randomUUID(), jobId, draft: true });
  expect(recovered.mapping).toMatchObject({ mode: "create", nameColumn: 0 });
  expect(JSON.stringify(recovered)).not.toContain(secret);
  const discardOperation = crypto.randomUUID();
  expect((await profiles.discardDraft(ctx, { id: input.id, operationId: discardOperation, expectedVersion: 1 })).replayed).toBe(false);
  expect((await profiles.discardDraft(ctx, { id: input.id, operationId: discardOperation, expectedVersion: 1 })).replayed).toBe(true);
  expect((await profiles.listProfiles(ctx, "organisations")).drafts).toEqual([]);
  expect((await profiles.listProfiles(ctx, "organisations")).profiles).toHaveLength(1);
  const history = await profiles.profileHistory(ctx, input.id);
  expect(history.versions[0]).toMatchObject({ source: "holy-sheet", actorId: owner.id });
  expect(history.versions[0].atIst).toContain("IST");
  expect(JSON.stringify(history)).not.toContain(secret);
  const download = await profiles.downloadProfile(ctx, input.id);
  expect(download.bytes.toString("utf8")).not.toContain(secret);
  expect(download.bytes.toString("utf8")).toContain("core:notes");
  expect(await stored()).not.toContain(secret);
});
