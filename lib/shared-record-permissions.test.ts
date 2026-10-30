import { beforeAll, afterAll, beforeEach, expect, it, vi } from "vitest";
import { createDatabase, type Database } from "./database";
import { Repository } from "./repository";
import { localActor as owner, type Actor } from "./auth";
import { SharedRecordRepository, type CurrentSuiteTenantAuthority, type RecordContext } from "./shared-records";
import { SharedRecordPermissionRepository } from "./shared-record-permissions";
import { recordCapabilities, standardCollections } from "./shared-record-types";

let db: Database, pages: Repository, data: SharedRecordRepository, permissions: SharedRecordPermissionRepository;
const tenant = crypto.randomUUID(),
  viewer = { id: "record-viewer", name: "Viewer" },
  outsider = { id: "record-outsider", name: "Outsider" },
  stranger = { id: "record-stranger", name: "Stranger" };
const proof = (actorId: string) => (c: RecordContext) => ({ subject: c.actor.id, tenantId: c.tenantId, workspaceId: c.workspaceId, active: true, tenantAdministrator: actorId === owner.id && c.actor.id === owner.id, revision: "synthetic-current-mapping-v1" });
const authority: CurrentSuiteTenantAuthority = { verify: vi.fn(async (c) => proof(owner.id)(c)) };
const context = (actor: Actor = owner): RecordContext => ({ actor, tenantId: tenant, workspaceId: "ws-aplyd" });
const secret = "private-" + crypto.randomUUID() + "@example.org";

beforeAll(async () => {
  db = await createDatabase(":memory:");
  pages = new Repository(db);
  await pages.seedLocal();
  for (const actor of [viewer, outsider, stranger]) await db.query("INSERT INTO hs_users(id,name) VALUES($1,$2)", [actor.id, actor.name]);
  for (const actor of [viewer, outsider]) await db.query("INSERT INTO hs_members(workspace_id,user_id) VALUES('ws-aplyd',$1)", [actor.id]);
  await db.query("INSERT INTO hs_data_tenants(id,name) VALUES($1,'Synthetic suite tenant')", [tenant]);
  await db.query("INSERT INTO hs_data_workspaces(workspace_id,tenant_id,review_reference) VALUES('ws-aplyd',$1,'Isolated test mapping only')", [tenant]);
  for (const collection of standardCollections) {
    await db.query("INSERT INTO hs_data_collections(tenant_id,id,name,core) VALUES($1,$2,$2,true)", [tenant, collection]);
    await db.query("INSERT INTO hs_data_collection_grants(tenant_id,user_id,collection,capabilities) VALUES($1,$2,$3,$4)", [tenant, owner.id, collection, [...recordCapabilities]]);
    await db.query("INSERT INTO hs_data_collection_grants(tenant_id,user_id,collection,capabilities) VALUES($1,$2,$3,$4)", [tenant, viewer.id, collection, ["view", "history"]]);
  }
  data = new SharedRecordRepository(pages, authority);
  permissions = new SharedRecordPermissionRepository(pages, authority);
});
beforeEach(() => {
  vi.mocked(authority.verify).mockReset().mockImplementation(async (c) => proof(owner.id)(c));
});
afterAll(async () => db.close());

it("starts from an empty field-permission registry and does not let workspace administration imply one", async () => {
  expect((await db.query("SELECT * FROM hs_data_field_permissions WHERE tenant_id=$1", [tenant])).rows).toEqual([]);
  expect((await db.query("SELECT * FROM hs_data_permission_operations WHERE tenant_id=$1", [tenant])).rows).toEqual([]);
  await expect(permissions.describe(context(outsider), "contacts")).rejects.toMatchObject({ status: 404 });
  await expect(permissions.apply(context({ ...outsider, role: "admin" } as Actor), { operationId: crypto.randomUUID(), collection: "contacts", subjectId: viewer.id, recordGrant: { recordId: crypto.randomUUID(), expectedVersion: 0, capabilities: ["view"] } })).rejects.toMatchObject({ status: 403 });
  await expect(permissions.readMatrix(context(viewer), "contacts")).rejects.toMatchObject({ status: 403 });
});

it("keeps record visibility, sensitive values, history and search on the current permission", async () => {
  await db.query("INSERT INTO hs_data_field_permissions(tenant_id,collection,field_key,user_id,can_view,can_write,can_history) VALUES($1,'contacts','core:email',$2,true,true,true)", [tenant, owner.id]);
  const hidden = (await data.create(context(), { operationId: crypto.randomUUID(), collection: "contacts", name: "Hidden contact", schemaVersion: 1, values: {} })).record;
  const visible = (await data.create(context(), { operationId: crypto.randomUUID(), collection: "contacts", name: "Visible contact", schemaVersion: 1, values: { "core:email": secret, "core:job-title": "Analyst" } })).record;
  expect(JSON.stringify(await permissions.describe(context(viewer), "contacts"))).not.toContain(secret);
  expect((await permissions.describe(context(viewer), "contacts")).fields.map((field) => field.key)).not.toContain("core:email");
  expect((await data.get(context(viewer), visible.id)).values).toEqual({ "core:job-title": "Analyst" });
  expect((await data.list(context(viewer), { collection: "contacts", query: secret })).results).toEqual([]);
  const granted = await permissions.apply(context(), { operationId: crypto.randomUUID(), collection: "contacts", subjectId: outsider.id, recordGrant: { recordId: visible.id, expectedVersion: 0, capabilities: ["view", "edit", "history"] }, fields: [{ key: "core:email", expectedVersion: 0, canView: true, canWrite: false, canHistory: false }] });
  expect(granted).toMatchObject({ recordVersion: 1, fieldVersions: { "core:email": 1 }, replayed: false });
  const replayInput = { operationId: crypto.randomUUID(), collection: "contacts", subjectId: viewer.id, fields: [{ key: "core:email", expectedVersion: 0, canView: true, canWrite: false, canHistory: false }] };
  expect(await permissions.apply(context(), replayInput)).toMatchObject({ replayed: false });
  expect(await permissions.apply(context(), replayInput)).toMatchObject({ replayed: true, fieldVersions: { "core:email": 1 } });
  expect((await data.list(context(outsider), { collection: "contacts" })).results.map((row) => row.id)).toEqual([visible.id]);
  expect((await data.get(context(outsider), visible.id)).values["core:email"]).toBe(secret);
  await expect(data.get(context(outsider), hidden.id)).rejects.toMatchObject({ status: 404 });
  expect(JSON.stringify(await data.history(context(outsider), visible.id))).not.toContain(secret);
  const renamed = await data.update(context(outsider), visible.id, { operationId: crypto.randomUUID(), expectedVersion: visible.version, schemaVersion: 1, name: "Visible renamed" });
  expect(renamed.record.values["core:email"]).toBe(secret);
  expect((await data.get(context(), visible.id)).values["core:email"]).toBe(secret);
  await expect(data.update(context(outsider), visible.id, { operationId: crypto.randomUUID(), expectedVersion: renamed.record.version, schemaVersion: 1, values: { "core:email": "changed@example.org" } })).rejects.toMatchObject({ status: 403 });
  const historyGrant = await permissions.apply(context(), { operationId: crypto.randomUUID(), collection: "contacts", subjectId: outsider.id, fields: [{ key: "core:email", expectedVersion: 1, canView: true, canWrite: false, canHistory: true }] }) as { fieldVersions: Record<string, number> };
  expect(JSON.stringify(await data.history(context(outsider), visible.id))).toContain(secret);
  await permissions.apply(context(), { operationId: crypto.randomUUID(), collection: "contacts", subjectId: outsider.id, fields: [{ key: "core:email", expectedVersion: historyGrant.fieldVersions["core:email"], canView: false, canWrite: false, canHistory: false }] });
  expect(JSON.stringify(await data.get(context(outsider), visible.id))).not.toContain(secret);
  expect(JSON.stringify(await data.list(context(outsider), { collection: "contacts", query: "Visible" }))).not.toContain(secret);
  expect(JSON.stringify(await data.history(context(outsider), visible.id))).not.toContain(secret);
  const matrix = await permissions.readMatrix(context(), "contacts", visible.id);
  expect(JSON.stringify(matrix)).not.toContain(secret);
  expect(matrix.sensitiveFields.map((field) => field.label)).toContain("Email");
  expect(matrix.members.find((member) => member.id === outsider.id)?.record?.capabilities).toEqual(["view", "edit", "history"]);
  const audits = JSON.stringify((await db.query("SELECT after_value FROM hs_audit WHERE action='shared-record.permission' AND subject_id=$1", [outsider.id])).rows);
  expect(audits).not.toContain(secret);
  expect(audits).toContain("core:email");
});

it("rejects self grants, stale versions, ordinary fields and members outside the workspace", async () => {
  const record = (await data.create(context(), { operationId: crypto.randomUUID(), collection: "organisations", name: "Permission subject", schemaVersion: 1, values: {} })).record;
  await expect(permissions.apply(context(), { operationId: crypto.randomUUID(), collection: "organisations", subjectId: owner.id, recordGrant: { recordId: record.id, expectedVersion: 0, capabilities: ["view"] } })).rejects.toMatchObject({ code: "record_permission_subject" });
  const first = await permissions.apply(context(), { operationId: crypto.randomUUID(), collection: "organisations", subjectId: viewer.id, collectionGrant: { expectedVersion: 1, capabilities: ["view"] } });
  await expect(permissions.apply(context(), { operationId: crypto.randomUUID(), collection: "organisations", subjectId: viewer.id, collectionGrant: { expectedVersion: 1, capabilities: ["view", "history"] } })).rejects.toMatchObject({ code: "record_permission_conflict" });
  expect(first.collectionVersion).toBe(2);
  await expect(permissions.apply(context(), { operationId: crypto.randomUUID(), collection: "organisations", subjectId: viewer.id, fields: [{ key: "core:notes", expectedVersion: 0, canView: true, canWrite: false, canHistory: false }] })).rejects.toMatchObject({ code: "record_permission_field" });
  await expect(permissions.apply(context(), { operationId: crypto.randomUUID(), collection: "organisations", subjectId: stranger.id, recordGrant: { recordId: record.id, expectedVersion: 0, capabilities: ["view"] } })).rejects.toMatchObject({ status: 404 });
  await db.query("UPDATE hs_data_collection_grants SET capabilities=ARRAY['view'] WHERE tenant_id=$1 AND user_id=$2 AND collection='organisations'", [tenant, owner.id]);
  try {
    await expect(permissions.readMatrix(context(), "organisations")).rejects.toMatchObject({ status: 403 });
  } finally {
    await db.query("UPDATE hs_data_collection_grants SET capabilities=$3 WHERE tenant_id=$1 AND user_id=$2 AND collection='organisations'", [tenant, owner.id, [...recordCapabilities]]);
  }
  await db.query("UPDATE hs_data_collection_grants SET capabilities=$3 WHERE tenant_id=$1 AND user_id=$2 AND collection='contacts'", [tenant, viewer.id, ["view", "history", "manage-permissions"]]);
  try {
    await expect(permissions.apply(context(viewer), { operationId: crypto.randomUUID(), collection: "contacts", subjectId: outsider.id, fields: [{ key: "core:email", expectedVersion: 0, canView: true, canWrite: true, canHistory: true }] })).rejects.toMatchObject({ status: 403 });
  } finally {
    await db.query("UPDATE hs_data_collection_grants SET capabilities=$3 WHERE tenant_id=$1 AND user_id=$2 AND collection='contacts'", [tenant, viewer.id, ["view", "history"]]);
  }
});
